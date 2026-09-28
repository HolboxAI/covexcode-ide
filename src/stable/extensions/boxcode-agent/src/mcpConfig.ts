/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Model Context Protocol (MCP) server configuration for the Boxcode Agent.
 *
 * Configuration is layered: servers declared in user settings are the baseline,
 * and servers declared by a workspace in `.boxcode/mcp.json` override them by
 * name. A workspace declaration is *untrusted input* -- a `stdio` server is an
 * arbitrary command the editor would spawn on the user's machine, with the same
 * privileges as the editor. So every resolved server carries the scope it came
 * from, and workspace-scoped servers are marked `requiresApproval` before first
 * use. Nothing in this module spawns anything; it only parses, merges and
 * describes.
 *
 * Deliberately free of `vscode` imports so it stays unit-testable. The test
 * script is `tsc -p tsconfig.test.json && node --test out-test/*.test.js`.
 */

export type McpTransport = 'stdio' | 'streamable-http';

/** Where a server declaration came from. Workspace declarations are untrusted. */
export type McpServerScope = 'user' | 'workspace';

export interface McpStdioServer {
	readonly name: string;
	readonly transport: 'stdio';
	/** Executable to spawn. Resolved by the operating system, not by us. */
	readonly command: string;
	readonly args?: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
}

export interface McpHttpServer {
	readonly name: string;
	readonly transport: 'streamable-http';
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
}

export type McpServer = McpStdioServer | McpHttpServer;

export interface McpDiagnostic {
	readonly severity: 'error' | 'warning';
	/** Dotted path into the source document, e.g. `mcpServers.github.command`. */
	readonly path: string;
	readonly message: string;
}

export interface McpParseResult {
	readonly servers: readonly McpServer[];
	readonly diagnostics: readonly McpDiagnostic[];
}

export interface ResolvedMcpServer {
	readonly server: McpServer;
	readonly scope: McpServerScope;
	/**
	 * True for workspace-scoped servers, which must be approved before the first
	 * spawn. Approval is tracked separately (see the permission store); this flag
	 * is only the question, not the answer.
	 */
	readonly requiresApproval: boolean;
}

export interface McpResolveResult {
	readonly servers: readonly ResolvedMcpServer[];
	readonly diagnostics: readonly McpDiagnostic[];
}

export interface McpPlaceholderContext {
	/** Typically `process.env`. */
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly workspaceFolder?: string;
}

const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PLACEHOLDER_PATTERN = /\$\{([^}]*)\}/g;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Collects diagnostics so a malformed config reports every problem at once. */
class Diagnostics {
	private readonly items: McpDiagnostic[] = [];

	error(path: string, message: string): void {
		this.items.push({ severity: 'error', path, message });
	}

	warn(path: string, message: string): void {
		this.items.push({ severity: 'warning', path, message });
	}

	toArray(): readonly McpDiagnostic[] {
		return this.items;
	}
}

/**
 * Expands `${env:NAME}` and `${workspaceFolder}`.
 *
 * An unresolvable placeholder is reported and left verbatim rather than being
 * replaced with an empty string: silently blanking `${env:AWS_PROFILE}` would
 * turn a configuration mistake into a server that starts, looks healthy, and
 * behaves differently than the user wrote.
 */
export function expandPlaceholders(
	value: string,
	context: McpPlaceholderContext,
	path: string,
	diagnostics: Diagnostics,
): string {
	return value.replace(PLACEHOLDER_PATTERN, (match, body: string) => {
		if (body === 'workspaceFolder') {
			if (context.workspaceFolder === undefined) {
				diagnostics.warn(path, '${workspaceFolder} used but no folder is open; left as-is.');
				return match;
			}
			return context.workspaceFolder;
		}
		if (body.startsWith('env:')) {
			const name = body.slice('env:'.length);
			const resolved = context.env[name];
			if (resolved === undefined) {
				diagnostics.warn(path, `Environment variable "${name}" is not set; left as-is.`);
				return match;
			}
			return resolved;
		}
		diagnostics.warn(path, `Unrecognised placeholder "${match}"; left as-is.`);
		return match;
	});
}

function expandRecord(
	input: Record<string, unknown>,
	context: McpPlaceholderContext,
	path: string,
	diagnostics: Diagnostics,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, item] of Object.entries(input)) {
		const text = asNonEmptyString(item);
		if (text === undefined) {
			diagnostics.warn(`${path}.${key}`, 'Expected a non-empty string; entry ignored.');
			continue;
		}
		out[key] = expandPlaceholders(text, context, `${path}.${key}`, diagnostics);
	}
	return out;
}

function parseStringArray(
	input: readonly unknown[],
	path: string,
	diagnostics: Diagnostics,
): readonly string[] {
	const out: string[] = [];
	for (const item of input) {
		if (typeof item !== 'string') {
			diagnostics.warn(path, 'Expected an array of strings; non-string entry ignored.');
			continue;
		}
		out.push(item);
	}
	return out;
}

function isHttpUrl(value: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

const KNOWN_KEYS = new Set(['type', 'transport', 'command', 'args', 'env', 'url', 'headers']);

/**
 * Parses one server entry. Returns `undefined` when the entry is unusable; the
 * reason is always recorded as an error diagnostic.
 */
function parseServer(
	name: string,
	raw: unknown,
	context: McpPlaceholderContext,
	basePath: string,
	diagnostics: Diagnostics,
): McpServer | undefined {
	const path = `${basePath}.${name}`;
	if (!isRecord(raw)) {
		diagnostics.error(path, 'Expected an object describing an MCP server.');
		return undefined;
	}

	for (const key of Object.keys(raw)) {
		if (!KNOWN_KEYS.has(key)) {
			diagnostics.warn(`${path}.${key}`, `Unknown key "${key}" is ignored.`);
		}
	}

	const declared = asNonEmptyString(raw['type']) ?? asNonEmptyString(raw['transport']);
	const command = asNonEmptyString(raw['command']);
	const url = asNonEmptyString(raw['url']);

	if (declared === 'sse') {
		diagnostics.warn(path, 'The SSE transport is deprecated; prefer "streamable-http". Treating as streamable-http.');
	}

	// An explicit transport wins; otherwise the presence of `command`/`url` decides.
	const transport: McpTransport | undefined =
		declared === 'stdio' ? 'stdio'
			: declared === 'streamable-http' || declared === 'sse' || declared === 'http' ? 'streamable-http'
				: declared !== undefined ? undefined
					: command !== undefined ? 'stdio'
						: url !== undefined ? 'streamable-http'
							: undefined;

	if (declared !== undefined && transport === undefined) {
		diagnostics.error(`${path}.type`, `Unknown transport "${declared}". Use "stdio" or "streamable-http".`);
		return undefined;
	}
	if (transport === undefined) {
		diagnostics.error(path, 'Needs either a "command" (stdio) or a "url" (streamable-http).');
		return undefined;
	}

	if (transport === 'stdio') {
		if (command === undefined) {
			diagnostics.error(`${path}.command`, 'A stdio server needs a non-empty "command".');
			return undefined;
		}
		if (url !== undefined) {
			diagnostics.warn(`${path}.url`, 'Ignored: this server is stdio.');
		}
		const out: {
			name: string;
			transport: 'stdio';
			command: string;
			args?: readonly string[];
			env?: Readonly<Record<string, string>>;
		} = {
			name,
			transport: 'stdio',
			command: expandPlaceholders(command, context, `${path}.command`, diagnostics),
		};
		if (Array.isArray(raw['args'])) {
			out.args = parseStringArray(raw['args'], `${path}.args`, diagnostics);
		}
		if (isRecord(raw['env'])) {
			out.env = expandRecord(raw['env'], context, `${path}.env`, diagnostics);
		}
		return out;
	}

	if (url === undefined) {
		diagnostics.error(`${path}.url`, 'A streamable-http server needs a non-empty "url".');
		return undefined;
	}
	const expandedUrl = expandPlaceholders(url, context, `${path}.url`, diagnostics);
	if (!isHttpUrl(expandedUrl)) {
		diagnostics.error(`${path}.url`, `"${expandedUrl}" is not an http(s) URL.`);
		return undefined;
	}
	if (command !== undefined) {
		diagnostics.warn(`${path}.command`, 'Ignored: this server is streamable-http.');
	}
	const out: {
		name: string;
		transport: 'streamable-http';
		url: string;
		headers?: Readonly<Record<string, string>>;
	} = { name, transport: 'streamable-http', url: expandedUrl };
	if (isRecord(raw['headers'])) {
		out.headers = expandRecord(raw['headers'], context, `${path}.headers`, diagnostics);
	}
	return out;
}

/**
 * Parses an MCP config document. Accepts either `{ "mcpServers": { ... } }`
 * (the convention used by Claude Code, Cursor and VS Code) or a bare
 * `{ "name": { ... } }` map. Never throws: arbitrary user JSON is an input here,
 * so every failure is a diagnostic instead.
 */
export function parseMcpConfig(
	raw: unknown,
	context: McpPlaceholderContext,
	basePath: string = 'mcpServers',
): McpParseResult {
	const diagnostics = new Diagnostics();

	if (raw === undefined || raw === null) {
		return { servers: [], diagnostics: diagnostics.toArray() };
	}
	if (!isRecord(raw)) {
		diagnostics.error(basePath, 'Expected an object.');
		return { servers: [], diagnostics: diagnostics.toArray() };
	}

	let map: Record<string, unknown> = raw;
	if (raw['mcpServers'] !== undefined) {
		if (!isRecord(raw['mcpServers'])) {
			diagnostics.error('mcpServers', 'Expected an object mapping server names to definitions.');
			return { servers: [], diagnostics: diagnostics.toArray() };
		}
		map = raw['mcpServers'];
	}

	const servers: McpServer[] = [];
	for (const [name, entry] of Object.entries(map)) {
		if (!SERVER_NAME_PATTERN.test(name)) {
			diagnostics.error(
				`${basePath}.${name}`,
				'Invalid server name. Use letters, digits, "_", "." or "-", starting with a letter or digit.',
			);
			continue;
		}
		const server = parseServer(name, entry, context, basePath, diagnostics);
		if (server !== undefined) {
			servers.push(server);
		}
	}
	return { servers, diagnostics: diagnostics.toArray() };
}

/**
 * Merges the user and workspace layers. Workspace wins on a name collision,
 * because a project that ships an MCP config means it for that project.
 * Declaration order is preserved: user servers first, then workspace-only ones.
 */
export function resolveMcpServers(
	layers: { readonly user?: unknown; readonly workspace?: unknown },
	context: McpPlaceholderContext,
): McpResolveResult {
	const diagnostics = new Diagnostics();

	const user = parseMcpConfig(layers.user, context, 'user.mcpServers');
	const workspace = parseMcpConfig(layers.workspace, context, 'workspace.mcpServers');
	for (const diagnostic of user.diagnostics) {
		diagnostics.warn(diagnostic.path, `[user settings] ${diagnostic.message}`);
	}
	for (const diagnostic of workspace.diagnostics) {
		diagnostics.warn(diagnostic.path, `[workspace] ${diagnostic.message}`);
	}

	const workspaceByName = new Map(workspace.servers.map(server => [server.name, server]));
	const servers: ResolvedMcpServer[] = [];
	const seen = new Set<string>();

	for (const server of user.servers) {
		const override = workspaceByName.get(server.name);
		if (override !== undefined) {
			servers.push({ server: override, scope: 'workspace', requiresApproval: true });
		} else {
			servers.push({ server, scope: 'user', requiresApproval: false });
		}
		seen.add(server.name);
	}
	for (const server of workspace.servers) {
		if (!seen.has(server.name)) {
			servers.push({ server, scope: 'workspace', requiresApproval: true });
		}
	}
	return { servers, diagnostics: diagnostics.toArray() };
}

export interface AcpEnvVariable {
	readonly name: string;
	readonly value: string;
}

/**
 * The shape ACP's `session/new` expects. Stdio entries carry `env` as an array
 * of `{ name, value }` pairs -- not a JSON object -- and have no `cwd`; the agent
 * inherits the session working directory.
 *
 * The boxcode CLI currently parses this field as an untyped `Vec<serde_json::Value>`
 * and ignores it, so the extension defines the shape in practice. The
 * `streamable-http` variant below is the one part not yet pinned to a published
 * schema and must be agreed with the CLI before either side relies on it.
 */
export interface AcpStdioMcpServer {
	readonly name: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly env: readonly AcpEnvVariable[];
}

export interface AcpHttpMcpServer {
	readonly name: string;
	readonly type: 'streamable-http';
	readonly url: string;
	readonly headers: readonly AcpEnvVariable[];
}

export type AcpMcpServer = AcpStdioMcpServer | AcpHttpMcpServer;

function toEnvArray(record: Readonly<Record<string, string>> | undefined): readonly AcpEnvVariable[] {
	if (record === undefined) {
		return [];
	}
	return Object.entries(record).map(([name, value]) => ({ name, value }));
}

export function toAcpMcpServers(servers: readonly McpServer[]): readonly AcpMcpServer[] {
	return servers.map((server): AcpMcpServer => {
		if (server.transport === 'stdio') {
			return {
				name: server.name,
				command: server.command,
				args: server.args ?? [],
				env: toEnvArray(server.env),
			};
		}
		return {
			name: server.name,
			type: 'streamable-http',
			url: server.url,
			headers: toEnvArray(server.headers),
		};
	});
}

const TOOL_NAME_SEPARATOR = '__';

function sanitizeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Namespaces a server's tool so two servers can both expose `search` without
 * colliding, following the widely used `mcp__<server>__<tool>` convention.
 *
 * Caveat worth carrying forward: the result is derived from the server's name,
 * so a renamed server silently changes every tool name derived from it. Anything
 * persisted against these names -- permission rules in particular -- goes stale
 * on rename and will not match. Persist the server identity, not the derived
 * tool name, or re-derive on load.
 */
export function mcpToolName(serverName: string, toolName: string): string {
	return `mcp${TOOL_NAME_SEPARATOR}${sanitizeSegment(serverName)}${TOOL_NAME_SEPARATOR}${sanitizeSegment(toolName)}`;
}

/** Inverse of {@link mcpToolName}. Segments are sanitized, so they may differ from the originals. */
export function parseMcpToolName(name: string): { serverName: string; toolName: string } | undefined {
	const prefix = `mcp${TOOL_NAME_SEPARATOR}`;
	if (!name.startsWith(prefix)) {
		return undefined;
	}
	const rest = name.slice(prefix.length);
	const split = rest.indexOf(TOOL_NAME_SEPARATOR);
	if (split <= 0 || split >= rest.length - TOOL_NAME_SEPARATOR.length) {
		return undefined;
	}
	return {
		serverName: rest.slice(0, split),
		toolName: rest.slice(split + TOOL_NAME_SEPARATOR.length),
	};
}

/** One-line human description, for a status bar tooltip or an approval prompt. */
export function describeMcpServer(server: McpServer): string {
	if (server.transport === 'stdio') {
		return `${server.name} (stdio: ${server.command} ${(server.args ?? []).join(' ')})`.trim();
	}
	return `${server.name} (streamable-http: ${server.url})`;
}
