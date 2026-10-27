/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

type Artifact = { asset: string; sha256: string; size: number };
type AgentLock = {
	schemaVersion: number;
	agentVersion: string;
	protocolVersion: number;
	releaseTag: string;
	repository: string;
	artifacts: Record<string, Artifact>;
};

const lockPath = path.join(__dirname, '../../../../../agent.lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as AgentLock;

test('agent.lock.json pins a concrete agent build and ACP protocol', () => {
	assert.equal(lock.schemaVersion, 1);
	assert.match(lock.agentVersion, /^\d+\.\d+\.\d+$/);
	assert.equal(lock.protocolVersion, 1);
	assert.match(lock.releaseTag, /^v\d+\.\d+\.\d+$/);
	assert.match(lock.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
});

test('agent.lock.json covers every currently shipped desktop target', () => {
	for (const target of ['darwin-arm64', 'win32-x64', 'linux-x64', 'linux-arm64']) {
		const artifact = lock.artifacts[target];
		assert.ok(artifact, `missing artifact for ${target}`);
		assert.match(artifact.asset, /^covexcode-/);
		assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
		assert.ok(artifact.size > 1_000_000, `${target} artifact is suspiciously small`);
	}
});
