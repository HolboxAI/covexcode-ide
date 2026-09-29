/*
 * MIT License
 *
 * Copyright (c) 2026 HolboxAI
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as path from 'node:path';

import {
	agentSupportsMcp,
	loadMcpConfig,
	mcpServersForSession,
	readMcpLayer,
	type LoadedMcpConfig,
	type ReadMcpConfigFile,
} from './mcpLoader';

const WORKSPACE = path.join(path.sep, 'work', 'project');
const HOME = path.join(path.sep, 'home', 'tester');

/** A `readFile` stub serving canned documents per layer, keyed off the path. */
function stubReader(workspaceJson?: string, homeJson?: string): ReadMcpConfigFile {
	return (file: string): string | undefined => {
		if (file.startsWith(WORKSPACE)) {
			return workspaceJson;
		}
		if (file.startsWith(HOME)) {
			return homeJson;
		}
		return undefined;
	};
}

function stdioDoc(...names: string[]): string {
	const servers: Record<string, unknown> = {};
	for (const name of names) {
		servers[name] = { transport: 'stdio', command: 'npx', args: ['-y', name] };
	}
	return JSON.stringify({ mcpServers: servers });
}

function load(workspaceJson?: string, homeJson?: string, approve?: (server: { name: string }, scope: string) => boolean): LoadedMcpConfig {
	return loadMcpConfig({
		readFile: stubReader(workspaceJson, homeJson),
		workspaceFolder: WORKSPACE,
		home: HOME,
		env: {},
		...(approve ? { approve } : {}),
	});
}

// --- the capability gate: the whole point of the module ---------------------

test('a build that advertises the mcp capability is recognised', () => {
	assert.equal(agentSupportsMcp({ agentCapabilities: { mcp: true } }), true);
});

test('a build that does not advertise mcp is not recognised', () => {
	// The shape observed from a real CLI: session exists, mcp does not.
	assert.equal(agentSupportsMcp({ agentCapabilities: { session: {}, promptCapabilities: { image: true } } }), false);
	assert.equal(agentSupportsMcp({ agentCapabilities: {} }), false);
	assert.equal(agentSupportsMcp({}), false);
});

test('an absent or malformed initialize result is not treated as supporting mcp', () => {
	assert.equal(agentSupportsMcp(undefined), false);
	assert.equal(agentSupportsMcp(null), false);
	assert.equal(agentSupportsMcp({ agentCapabilities: { mcp: 'yes' } }), false);
	assert.equal(agentSupportsMcp('nonsense'), false);
});

test('servers are withheld when the agent does not advertise mcp', () => {
	// Without this, session/new accepts mcpServers and silently connects
	// nothing -- a no-op that looks like success.
	const loaded = load(undefined, stdioDoc('github'));
	assert.ok(loaded.acpServers.length > 0, 'precondition: the server resolved');

	assert.deepEqual(mcpServersForSession(loaded, false), []);
	assert.deepEqual(mcpServersForSession(loaded, true), loaded.acpServers);
});

// --- layering ---------------------------------------------------------------

test('a workspace server shadows a user server of the same name', () => {
	const loaded = load(stdioDoc('github'), stdioDoc('github'), () => true);
	const names = loaded.acpServers.map((server) => (server as { name: string }).name);
	assert.deepEqual(names, ['github']);
});

test('user and workspace servers are merged when the names differ', () => {
	const loaded = load(stdioDoc('workspace-only'), stdioDoc('user-only'), () => true);
	const names = loaded.acpServers.map((server) => (server as { name: string }).name).sort();
	assert.deepEqual(names, ['user-only', 'workspace-only']);
});

// --- trust gating -----------------------------------------------------------

test('a user-layer server is cleared without approval', () => {
	const loaded = load(undefined, stdioDoc('mine'));
	assert.deepEqual(loaded.pending, []);
	assert.deepEqual(
		loaded.acpServers.map((server) => (server as { name: string }).name),
		['mine'],
	);
});

test('a workspace-layer server is held back pending approval by default', () => {
	const loaded = load(stdioDoc('from-repo'));
	assert.deepEqual(loaded.pending, ['from-repo']);
	assert.deepEqual(loaded.acpServers, []);
});

test('an approval callback releases a withheld workspace server', () => {
	const loaded = load(stdioDoc('from-repo'), undefined, () => true);
	assert.deepEqual(loaded.pending, []);
	assert.deepEqual(
		loaded.acpServers.map((server) => (server as { name: string }).name),
		['from-repo'],
	);
});

test('an approval callback that declines keeps the server withheld', () => {
	const loaded = load(stdioDoc('from-repo'), undefined, () => false);
	assert.deepEqual(loaded.pending, ['from-repo']);
	assert.deepEqual(loaded.acpServers, []);
});

// --- malformed input never throws -------------------------------------------

test('malformed JSON is reported as an error, not thrown', () => {
	const layer = readMcpLayer(stubReader('{ not json'), path.join(WORKSPACE, '.boxcode', 'mcp.json'));
	assert.equal(layer.raw, undefined);
	assert.equal(layer.errors.length, 1);

	const loaded = load('{ not json');
	assert.ok(loaded.errors.length > 0);
	assert.deepEqual(loaded.acpServers, []);
});

test('absent files are not an error', () => {
	const loaded = load(undefined, undefined);
	assert.deepEqual(loaded.errors, []);
	assert.deepEqual(loaded.acpServers, []);
	assert.deepEqual(loaded.pending, []);
});

test('an entry with no command or url produces a diagnostic, not a throw', () => {
	const loaded = load(JSON.stringify({ mcpServers: { broken: { transport: 'stdio' } } }));
	assert.deepEqual(loaded.acpServers, []);
	assert.ok(loaded.diagnostics.length > 0, 'expected a diagnostic for the invalid entry');
});
