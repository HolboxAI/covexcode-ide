/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reads MCP server configuration from disk and resolves it into the list that
 * `session/new` carries over ACP.
 *
 * Layout mirrors the permission store (`permissionStore.ts`): a workspace file
 * at `<cwd>/.boxcode/mcp.json` and a user file at `<home>/.boxcode/mcp.json`.
 * Workspace entries win on a name collision -- that rule lives in
 * `resolveMcpServers`, not here.
 *
 * Two deliberate properties:
 *
 *  - **vscode-free by construction** (see `mcpConfig.ts`). Every input --
 *    including the file read -- is injected, so this module is unit-testable
 *    under `tsconfig.test.json` with no VS Code host and no mocking library.
 *  - **fail closed on the capability handshake.** `agentSupportsMcp` returns
 *    true only for an explicit `mcp: true`. A CLI that accepts `mcpServers` and
 *    connects nothing still returns a session id, so treating silence as
 *    consent would mean shipping a silent no-op. See `docs/MCP-verification.md`.
 */

import {
	resolveMcpServers,
	toAcpMcpServers,
	type AcpMcpServer,
	type McpServer,
} from './mcpConfig';

/** Workspace-scoped config, relative to the session working directory. */
export const MCP_CONFIG_RELATIVE_PATH = '.boxcode/mcp.json';

/** User-scoped config, relative to the home directory. */
export const USER_MCP_CONFIG_RELATIVE_PATH = '.boxcode/mcp.json';

type McpResolveResult = ReturnType<typeof resolveMcpServers>;

/** A resolution diagnostic, named structurally so no type name is assumed. */
export type McpDiagnostic = McpResolveResult['diagnostics'][number];

/**
 * Reads a file and returns its text, or `undefined` when it is absent or
 * unreadable. Injected so tests can supply an in-memory map.
 */
export type ReadMcpConfigFile = (file: string) => string | undefined;

/** Where a server came from. Workspace config can spawn arbitrary commands. */
export type McpScope = 'user' | 'workspace';

export interface LayerReadResult {
	/** The parsed document, or `undefined` when the file was absent. */
	readonly raw: unknown;
	/** Layer-level problems: unreadable file, malformed JSON. */
	readonly errors: readonly string[];
}

/**
 * Parses one config file.
 *
 * A missing file is not an error -- it just declares nothing. A file that
 * exists but is not valid JSON *is* reported: silently ignoring it would look
 * exactly like "no servers configured" while the user believes otherwise.
 */
export function readMcpLayer(readFile: ReadMcpConfigFile, file: string): LayerReadResult {
	const text = readFile(file);
	if (text === undefined) {
		return { raw: undefined, errors: [] };
	}
	if (text.trim().length === 0) {
		return { raw: undefined, errors: [`${file} is empty; expected a JSON object`] };
	}
	try {
		return { raw: JSON.parse(text) as unknown, errors: [] };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { raw: undefined, errors: [`${file} is not valid JSON: ${detail}`] };
	}
}

export interface LoadedMcpConfig {
	/** Servers cleared to run, in resolution order. */
	readonly servers: readonly McpServer[];
	/** `servers` in the ACP wire shape, ready for `session/new`. */
	readonly acpServers: readonly AcpMcpServer[];
	/** Workspace server names held back pending approval. */
	readonly pending: readonly string[];
	/** Layer-level problems. */
	readonly errors: readonly string[];
	/** Per-entry problems from resolution and validation. */
	readonly diagnostics: readonly McpDiagnostic[];
}

export interface LoadMcpConfigOptions {
	readonly readFile: ReadMcpConfigFile;
	/** The session working directory; its `.boxcode/mcp.json` is the workspace layer. */
	readonly workspaceFolder?: string;
	readonly home: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	/**
	 * Decides whether a server may run. Defaults to allowing user-scope servers
	 * and holding every workspace-scope server back, because that file can name
	 * an arbitrary command and lives in the repository.
	 */
	readonly approve?: (server: McpServer, scope: McpScope) => boolean;
}

/**
 * Reads both layers and resolves them.
 *
 * Approval is decided per server *after* resolution, so a workspace entry that
 * merely shadows a user entry the user already trusts is judged on where it
 * came from, not on the name it happens to share.
 */
export function loadMcpConfig(options: LoadMcpConfigOptions): LoadedMcpConfig {
	const { readFile, workspaceFolder, home, env } = options;
	const approve = options.approve ?? defaultApprove;

	const userFile = joinHome(home, USER_MCP_CONFIG_RELATIVE_PATH);
	const userLayer = readMcpLayer(readFile, userFile);

	let workspaceLayer: LayerReadResult = { raw: undefined, errors: [] };
	if (workspaceFolder !== undefined && workspaceFolder.trim().length > 0) {
		const workspaceFile = joinWorkspace(workspaceFolder, MCP_CONFIG_RELATIVE_PATH);
		workspaceLayer = readMcpLayer(readFile, workspaceFile);
	}

	const resolved = resolveMcpServers(
		{ user: userLayer.raw, workspace: workspaceLayer.raw },
		workspaceFolder === undefined ? { env } : { env, workspaceFolder },
	);

	const servers: McpServer[] = [];
	const pending: string[] = [];
	for (const entry of resolved.servers) {
		if (approve(entry.server, entry.scope)) {
			servers.push(entry.server);
		} else {
			pending.push(entry.server.name);
		}
	}

	return {
		servers,
		acpServers: toAcpMcpServers(servers),
		pending,
		errors: [...userLayer.errors, ...workspaceLayer.errors],
		diagnostics: resolved.diagnostics,
	};
}

function defaultApprove(_server: McpServer, scope: McpScope): boolean {
	return scope === 'user';
}

function joinHome(home: string, relative: string): string {
	return `${trimTrailingSeparators(home)}/${relative}`;
}

function joinWorkspace(cwd: string, relative: string): string {
	return `${trimTrailingSeparators(cwd)}/${relative}`;
}

function trimTrailingSeparators(value: string): string {
	return value.replace(/[/\\]+$/, '');
}

/**
 * Whether the agent advertised MCP support during `initialize`.
 *
 * Strictly `=== true`: an absent, null or non-boolean `mcp` is a "no". ACP v1
 * makes `mcpServers` a *required* field on `session/new`, so a CLI with no MCP
 * client accepts it and returns a session id while connecting nothing -- the
 * only honest signal is the advertised capability.
 */
export function agentSupportsMcp(initializeResult: unknown): boolean {
	if (!isRecord(initializeResult)) {
		return false;
	}
	const capabilities = initializeResult['agentCapabilities'];
	if (!isRecord(capabilities)) {
		return false;
	}
	return capabilities['mcp'] === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The servers to put on `session/new`.
 *
 * Returns empty when the agent did not advertise MCP, so the extension never
 * sends a config the CLI would accept and ignore.
 */
export function mcpServersForSession(
	loaded: LoadedMcpConfig,
	agentSupportsMcp: boolean,
): readonly AcpMcpServer[] {
	return agentSupportsMcp ? loaded.acpServers : [];
}
