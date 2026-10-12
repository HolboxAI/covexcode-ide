/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	describeMcpServer,
	expandPlaceholders,
	parseMcpConfig,
	parseMcpToolName,
	resolveMcpServers,
	toAcpMcpServers,
	mcpToolName,
} from './mcpConfig';

const NO_ENV = { env: {} };

function errorsOf(raw: unknown): readonly string[] {
	return parseMcpConfig(raw, NO_ENV).diagnostics
		.filter(diagnostic => diagnostic.severity === 'error')
		.map(diagnostic => diagnostic.path);
}

test('parseMcpConfig() reads the mcpServers map convention', () => {
	const result = parseMcpConfig(
		{ mcpServers: { fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] } } },
		NO_ENV,
	);
	assert.equal(result.diagnostics.length, 0);
	assert.deepEqual(result.servers, [
		{ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
	]);
});

test('parseMcpConfig() also accepts a bare server map', () => {
	const result = parseMcpConfig({ git: { command: 'mcp-git' } }, NO_ENV);
	assert.equal(result.servers.length, 1);
	assert.equal(result.servers[0]?.name, 'git');
});

test('parseMcpConfig() infers the transport from command or url', () => {
	const stdio = parseMcpConfig({ a: { command: 'server' } }, NO_ENV).servers[0];
	const http = parseMcpConfig({ b: { url: 'https://example.test/mcp' } }, NO_ENV).servers[0];
	assert.equal(stdio?.transport, 'stdio');
	assert.equal(http?.transport, 'streamable-http');
});

test('parseMcpConfig() lets an explicit transport override inference', () => {
	const result = parseMcpConfig({ a: { type: 'streamable-http', url: 'https://example.test/mcp' } }, NO_ENV);
	assert.equal(result.servers[0]?.transport, 'streamable-http');
});

test('parseMcpConfig() reports an entry with neither command nor url', () => {
	assert.deepEqual(errorsOf({ bad: { args: ['x'] } }), ['mcpServers.bad']);
});

test('parseMcpConfig() requires a non-empty command for stdio', () => {
	assert.deepEqual(errorsOf({ bad: { type: 'stdio', command: '   ' } }), ['mcpServers.bad.command']);
});

test('parseMcpConfig() rejects a non-http url', () => {
	assert.deepEqual(errorsOf({ bad: { url: 'ftp://example.test/x' } }), ['mcpServers.bad.url']);
});

test('parseMcpConfig() rejects an unknown transport', () => {
	assert.deepEqual(errorsOf({ bad: { type: 'carrier-pigeon', command: 'x' } }), ['mcpServers.bad.type']);
});

test('parseMcpConfig() flags sse as deprecated rather than silently accepting it', () => {
	const result = parseMcpConfig({ a: { type: 'sse', url: 'https://example.test/sse' } }, NO_ENV);
	assert.equal(result.servers[0]?.transport, 'streamable-http');
	assert.match(result.diagnostics[0]?.message ?? '', /deprecated/);
});

test('parseMcpConfig() rejects an invalid server name', () => {
	assert.deepEqual(errorsOf({ 'bad name!': { command: 'x' } }), ['mcpServers.bad name!']);
});

test('parseMcpConfig() warns about unknown keys but keeps the server', () => {
	const result = parseMcpConfig({ a: { command: 'x', timeout: 5 } }, NO_ENV);
	assert.equal(result.servers.length, 1);
	assert.match(result.diagnostics[0]?.message ?? '', /Unknown key "timeout"/);
});

test('parseMcpConfig() never throws on arbitrary JSON', () => {
	for (const raw of [null, undefined, 42, 'text', [], true]) {
		assert.doesNotThrow(() => parseMcpConfig(raw, NO_ENV));
	}
});

test('parseMcpConfig() reports a non-object mcpServers value', () => {
	assert.deepEqual(errorsOf({ mcpServers: 'nope' }), ['mcpServers']);
});

test('expandPlaceholders() resolves env and workspaceFolder', () => {
	const diagnostics = { error: () => undefined, warn: () => undefined };
	const context = { env: { TOKEN: 'secret' }, workspaceFolder: '/work' };
	assert.equal(expandPlaceholders('${env:TOKEN}', context, 'p', diagnostics as never), 'secret');
	assert.equal(expandPlaceholders('${workspaceFolder}/db', context, 'p', diagnostics as never), '/work/db');
});

test('resolveMcpServers() lets a workspace server override a user server of the same name', () => {
	const result = resolveMcpServers(
		{
			user: { mcpServers: { shared: { command: 'user-cmd' }, mine: { command: 'user-only' } } },
			workspace: { mcpServers: { shared: { command: 'workspace-cmd' }, theirs: { command: 'workspace-only' } } },
		},
		NO_ENV,
	);
	assert.deepEqual(
		result.servers.map(entry => [entry.server.name, entry.server.transport === 'stdio' ? entry.server.command : '', entry.scope]),
		[['shared', 'workspace-cmd', 'workspace'], ['mine', 'user-only', 'user'], ['theirs', 'workspace-only', 'workspace']],
	);
});

test('resolveMcpServers() requires approval for workspace servers only', () => {
	const result = resolveMcpServers(
		{ user: { mcpServers: { u: { command: 'a' } } }, workspace: { mcpServers: { w: { command: 'b' } } } },
		NO_ENV,
	);
	const byScope = new Map(result.servers.map(entry => [entry.server.name, entry.requiresApproval]));
	assert.equal(byScope.get('u'), false);
	assert.equal(byScope.get('w'), true);
});

test('resolveMcpServers() attributes diagnostics to the layer they came from', () => {
	const result = resolveMcpServers({ workspace: { mcpServers: { bad: {} } } }, NO_ENV);
	assert.match(result.diagnostics[0]?.message ?? '', /\[workspace\]/);
});

test('toAcpMcpServers() emits env as an array of name/value pairs', () => {
	const [server] = toAcpMcpServers([{ name: 'a', transport: 'stdio', command: 'run', env: { TOKEN: 't' } }]);
	assert.deepEqual(server, { name: 'a', command: 'run', args: [], env: [{ name: 'TOKEN', value: 't' }] });
});

test('toAcpMcpServers() always emits an args array', () => {
	const [server] = toAcpMcpServers([{ name: 'a', transport: 'stdio', command: 'run' }]);
	assert.deepEqual(server && 'args' in server ? server.args : undefined, []);
});

test('toAcpMcpServers() does not emit cwd, which ACP stdio entries do not carry', () => {
	const [server] = toAcpMcpServers([{ name: 'a', transport: 'stdio', command: 'run' }]);
	assert.equal(Object.hasOwn(server as object, 'cwd'), false);
});

test('toAcpMcpServers() marks the http variant with its type', () => {
	const [server] = toAcpMcpServers([{ name: 'a', transport: 'streamable-http', url: 'https://example.test/mcp' }]);
	assert.equal(server && 'type' in server ? server.type : undefined, 'streamable-http');
});

test('mcpToolName() namespaces by server and round-trips', () => {
	const name = mcpToolName('github', 'create_issue');
	assert.equal(name, 'mcp__github__create_issue');
	assert.deepEqual(parseMcpToolName(name), { serverName: 'github', toolName: 'create_issue' });
});

test('mcpToolName() keeps two servers with the same tool name distinct', () => {
	assert.notEqual(mcpToolName('a', 'search'), mcpToolName('b', 'search'));
});

test('parseMcpToolName() returns undefined for a non-MCP tool name', () => {
	assert.equal(parseMcpToolName('read_file'), undefined);
	assert.equal(parseMcpToolName('mcp__'), undefined);
});

// --- Characterization tests: derived tool ids are NOT a safe key ---
//
// sanitizeSegment() folds everything outside [A-Za-z0-9_] to `_`, so the mapping
// from server name to tool id is not injective. Anything persisted against the
// derived id (a permission rule in particular) is therefore ambiguous. These
// tests pin the current behaviour so it cannot change silently.

test('mcpToolName() is not injective: distinct server names collapse to one id', () => {
	// All three satisfy SERVER_NAME_PATTERN (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/), so these
	// are names the config parser accepts -- not malformed input.
	const ids = ['my-server', 'my_server', 'my.server'].map((name) => mcpToolName(name, 'ping'));
	assert.equal(new Set(ids).size, 1, `expected one id, got ${JSON.stringify(ids)}`);
	assert.equal(ids[0], 'mcp__my_server__ping');
});

test('mcpToolName() derives a different id than the CLI for the same server name', () => {
	// The CLI's slug() keeps `-` and folds `_` to `-` (boxcode: src/mcp.rs, slug()
	// and server_id_fragment()), so it derives `mcp__my-server__ping` for the same
	// input. The two repos sanitize in opposite directions; only the raw server
	// name is shared, not the id derived from it.
	assert.equal(mcpToolName('my-server', 'ping'), 'mcp__my_server__ping');
	assert.equal(mcpToolName('my_server', 'ping'), 'mcp__my_server__ping');
});

test('parseMcpConfig() accepts colliding server names and reports no error', () => {
	// The reachability half of the claim above: three distinct, individually valid
	// server names are all kept by the parser, yet they collapse to a single tool
	// id. Nothing in the IDE rejects the collision.
	const result = parseMcpConfig(
		{
			'my-server': { command: 'a' },
			my_server: { command: 'b' },
			'my.server': { command: 'c' },
		},
		NO_ENV,
	);
	assert.equal(result.servers.length, 3);
	const ids = result.servers.map((server) => mcpToolName(server.name, 'ping'));
	assert.equal(new Set(ids).size, 1, `expected one id, got ${JSON.stringify(ids)}`);
});

test('parseMcpToolName() is NOT the inverse of mcpToolName() when a segment contains __', () => {
	// sanitizeSegment() preserves `_`, but the separator is `__`, so a server name
	// containing a double underscore does not split back apart. This documents
	// current, defective behaviour rather than desired behaviour.
	const name = mcpToolName('my__server', 'ping');
	assert.equal(name, 'mcp__my__server__ping');
	assert.deepEqual(parseMcpToolName(name), { serverName: 'my', toolName: 'server__ping' });
});

test('describeMcpServer() summarises both transports', () => {
	assert.equal(
		describeMcpServer({ name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] }),
		'fs (stdio: npx -y pkg)',
	);
	assert.equal(
		describeMcpServer({ name: 'gh', transport: 'streamable-http', url: 'https://example.test/mcp' }),
		'gh (streamable-http: https://example.test/mcp)',
	);
});
