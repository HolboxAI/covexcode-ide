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
