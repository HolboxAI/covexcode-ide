/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
	bundledManifestMatchesPlatform,
	parseBundledAgentManifest,
	readBundledAgentManifest,
} from './manifest';

const valid = {
	schemaVersion: 1,
	agentVersion: '1.11.92',
	protocolVersion: 1,
	target: 'darwin-arm64',
	asset: 'covexcode-macos-aarch64',
	sha256: '0b90092e8f2287e973283d458e43d48c32841fe2c079f90dba5004c3150816e9',
	size: 6815184,
};

test('parseBundledAgentManifest() accepts the generated manifest', () => {
	assert.deepEqual(parseBundledAgentManifest(JSON.stringify(valid)), valid);
});

test('parseBundledAgentManifest() rejects an unsupported protocol or malformed hash', () => {
	assert.throws(() => parseBundledAgentManifest(JSON.stringify({ ...valid, protocolVersion: 2 })), /ACP protocol 2/);
	assert.throws(() => parseBundledAgentManifest(JSON.stringify({ ...valid, sha256: 'nope' })), /sha256/);
	assert.throws(() => parseBundledAgentManifest(JSON.stringify({ ...valid, agentVersion: 'latest' })), /agentVersion/);
});

test('bundledManifestMatchesPlatform() accepts the target and musl suffixes', () => {
	assert.equal(bundledManifestMatchesPlatform({ ...valid, target: 'darwin-arm64' } as any, 'darwin', 'arm64'), true);
	assert.equal(bundledManifestMatchesPlatform({ ...valid, target: 'linux-x64-musl' } as any, 'linux', 'x64'), true);
	assert.equal(bundledManifestMatchesPlatform({ ...valid, target: 'linux-arm64' } as any, 'linux', 'x64'), false);
});

test('readBundledAgentManifest() reads a staged version.json and rejects a missing one', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'covex-manifest-'));
	try {
		mkdirSync(path.join(root, 'resources', 'bin'), { recursive: true });
		writeFileSync(path.join(root, 'resources', 'bin', 'version.json'), JSON.stringify(valid));
		assert.deepEqual(readBundledAgentManifest(root, 'darwin', 'arm64'), valid);
		assert.equal(readBundledAgentManifest(root, 'linux', 'x64'), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
