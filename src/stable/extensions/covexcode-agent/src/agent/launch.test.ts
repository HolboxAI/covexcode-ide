/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { agentLaunchCandidates, bundledAgentPath } from './launch';

const home = '/Users/dev';

test('bundledAgentPath() uses the platform executable name', () => {
	assert.equal(bundledAgentPath('/app/extensions/covexcode-agent', 'darwin'), path.join('/app/extensions/covexcode-agent', 'resources', 'bin', 'covexcode'));
	assert.equal(bundledAgentPath('/app/extensions/covexcode-agent', 'win32'), path.join('/app/extensions/covexcode-agent', 'resources', 'bin', 'covexcode.exe'));
});

test('agentLaunchCandidates() keeps an explicit path alone', () => {
	const candidates = agentLaunchCandidates({
		configuredPath: ' /opt/covexcode ',
		bundledPath: '/app/resources/bin/covexcode',
		useBundled: true,
		home,
		platform: 'darwin',
	});
	assert.deepEqual(candidates, [{ command: '/opt/covexcode', source: 'configured' }]);
});

test('agentLaunchCandidates() prefers the bundled runtime when enabled', () => {
	const bundled = '/app/resources/bin/covexcode';
	const candidates = agentLaunchCandidates({
		configuredPath: '',
		bundledPath: bundled,
		useBundled: true,
		home,
		platform: 'darwin',
	});
	assert.equal(candidates[0].command, bundled);
	assert.equal(candidates[0].source, 'bundled');
	assert.equal(candidates[1].command, 'covexcode');
	assert.equal(candidates[1].source, 'external');
});

test('agentLaunchCandidates() keeps the legacy order when the bundle is disabled', () => {
	const candidates = agentLaunchCandidates({
		configuredPath: '',
		bundledPath: '/app/resources/bin/covexcode',
		useBundled: false,
		home,
		platform: 'darwin',
	});
	assert.deepEqual(candidates[0], { command: 'covexcode', source: 'external' });
	assert.ok(!candidates.some(candidate => candidate.source === 'bundled'));
});

test('agentLaunchCandidates() falls back to PATH when no bundled path is staged', () => {
	const candidates = agentLaunchCandidates({
		configuredPath: '',
		bundledPath: undefined,
		useBundled: true,
		home,
		platform: 'linux',
	});
	assert.deepEqual(candidates[0], { command: 'covexcode', source: 'external' });
});
