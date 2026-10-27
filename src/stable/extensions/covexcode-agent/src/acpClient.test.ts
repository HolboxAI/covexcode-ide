/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	AcpClient,
	AgentCompatibilityError,
	agentSupportsImages,
	assertAgentCompatible,
	fetchProviders,
	probeAcpSupported,
	probeBinaryExists,
} from './acpClient';

/**
 * `probeBinaryExists`/`fetchProviders` spawn a real child process -- these
 * tests exercise them against real subprocesses too, not a mock of
 * `child_process`, the same way `cdpClient.test.ts` uses a fake session
 * that implements the real interface rather than stubbing `CdpClient`
 * itself. `process.execPath` (the real `node` binary already running this
 * test) stands in for `covexcode`, since it's guaranteed to exist and lets a
 * one-line `-e` script produce whatever exit code/stdout a case needs.
 */

test('probeBinaryExists() resolves true for a command that exits 0', async () => {
	const ok = await probeBinaryExists(process.execPath, ['-e', 'process.exit(0)']);
	assert.equal(ok, true);
});

test('probeBinaryExists() resolves false for a command that exits nonzero', async () => {
	const ok = await probeBinaryExists(process.execPath, ['-e', 'process.exit(1)']);
	assert.equal(ok, false);
});

test('probeBinaryExists() resolves false, not rejects, for a genuinely missing binary', async () => {
	const ok = await probeBinaryExists('this-binary-does-not-exist-anywhere-12345');
	assert.equal(ok, false);
});

test('probeAcpSupported() is false when the CLI rejects --acp as an unknown argument', async () => {
	const ok = await probeAcpSupported(
		process.execPath,
		['-e', 'console.error("Unknown argument: --acp"); process.exit(2)'],
		// Generous enough that a loaded CI runner cannot hit the probe's
		// timeout before this child gets to exit(2); the assertion is about
		// the exit code, not startup latency.
		2_000,
	);
	assert.equal(ok, false);
});

test('probeAcpSupported() is true when the process stays running (ACP server waiting on stdin)', async () => {
	const ok = await probeAcpSupported(
		process.execPath,
		['-e', 'setInterval(() => {}, 1000)'],
		80,
	);
	assert.equal(ok, true);
});

test('fetchProviders() parses real stdout JSON from the child process', async () => {
	const fakeRegistry = JSON.stringify([
		{ id: 'deepseek', label: 'DeepSeek', endpoint: 'https://api.deepseek.com', models: ['deepseek-v4-pro'] },
	]);
	const providers = await fetchProviders(process.execPath, ['-e', `console.log(${JSON.stringify(fakeRegistry)})`]);
	assert.equal(providers.length, 1);
	assert.equal(providers[0].id, 'deepseek');
	assert.equal(providers[0].label, 'DeepSeek');
	assert.deepEqual(providers[0].models, ['deepseek-v4-pro']);
});

test('fetchProviders() rejects on a nonzero exit rather than returning an empty list', async () => {
	await assert.rejects(
		() => fetchProviders(process.execPath, ['-e', 'console.error("boom"); process.exit(1)']),
		/exited 1/,
	);
});

test('fetchProviders() rejects with a clear message on invalid JSON, not a raw parse-error stack', async () => {
	await assert.rejects(
		() => fetchProviders(process.execPath, ['-e', 'console.log("not json")']),
		/did not print valid JSON/,
	);
});

test('fetchProviders() rejects for a genuinely missing binary', async () => {
	await assert.rejects(() => fetchProviders('this-binary-does-not-exist-anywhere-12345'));
});

test('fetchProviders() rejects on timeout instead of hanging forever', async () => {
	await assert.rejects(
		() => fetchProviders(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], 50),
		/timed out/,
	);
});

test('agentSupportsImages() follows the advertised prompt capability', () => {
	assert.equal(agentSupportsImages({ agentCapabilities: { promptCapabilities: { image: true } } }), true);
	assert.equal(agentSupportsImages({ agentCapabilities: { promptCapabilities: { image: false } } }), false);
	assert.equal(agentSupportsImages({ agentCapabilities: {} }), false);
	assert.equal(agentSupportsImages(undefined), false);
});

test('assertAgentCompatible() accepts the pinned protocol/version and rejects mismatches', () => {
	assert.doesNotThrow(() =>
		assertAgentCompatible(
			{ protocolVersion: 1, agentInfo: { version: '1.11.92' } },
			{ protocolVersion: 1, agentVersion: '1.11.92' },
		),
	);
	assert.throws(
		() => assertAgentCompatible({ protocolVersion: 2 }, { protocolVersion: 1 }),
		/protocol 2, expected 1/,
	);
	assert.throws(
		() => assertAgentCompatible({ protocolVersion: 1, agentInfo: { version: '1.11.91' } }, { protocolVersion: 1, agentVersion: '1.11.92' }),
		/does not match the pinned 1\.11\.92/,
	);
});

const acpServerScript = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
	const message = JSON.parse(line);
	if (message.method === 'initialize') {
		process.stdout.write(JSON.stringify({
			jsonrpc: '2.0',
			id: message.id,
			result: { protocolVersion: 1, agentInfo: { name: 'covexcode', version: '1.11.92' } },
		}) + '\\n');
	}
});
`;

test('AcpClient accepts injected args and passes the ACP compatibility check', async () => {
	const client = new AcpClient(process.execPath, process.cwd(), {}, ['-e', acpServerScript], {
		protocolVersion: 1,
		agentVersion: '1.11.92',
	});
	try {
		const result = await client.initialize();
		assert.equal(result.protocolVersion, 1);
		assert.equal(result.agentInfo?.version, '1.11.92');
	} finally {
		client.dispose();
	}
});

test('AcpClient rejects an agent whose ACP version does not match the pin', async () => {
	const client = new AcpClient(process.execPath, process.cwd(), {}, ['-e', acpServerScript], {
		protocolVersion: 1,
		agentVersion: '9.9.9',
	});
	try {
		await assert.rejects(() => client.initialize(), AgentCompatibilityError);
	} finally {
		client.dispose();
	}
});
