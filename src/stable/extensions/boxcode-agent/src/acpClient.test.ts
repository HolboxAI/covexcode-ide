/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchProviders, probeAcpSupported, probeBinaryExists } from './acpClient';

/**
 * `probeBinaryExists`/`fetchProviders` spawn a real child process -- these
 * tests exercise them against real subprocesses too, not a mock of
 * `child_process`, the same way `cdpClient.test.ts` uses a fake session
 * that implements the real interface rather than stubbing `CdpClient`
 * itself. `process.execPath` (the real `node` binary already running this
 * test) stands in for `boxcode`, since it's guaranteed to exist and lets a
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
		200,
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
