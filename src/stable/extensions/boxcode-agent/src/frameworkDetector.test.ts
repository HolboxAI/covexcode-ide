/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectFramework, detectWorkspaceFramework, FRAMEWORK_LABELS } from './frameworkDetector';

test('detectFramework() returns undefined for no dependencies', () => {
	assert.equal(detectFramework(undefined), undefined);
	assert.equal(detectFramework({}), undefined);
});

test('detectFramework() maps a bare next dependency to Next.js', () => {
	assert.equal(detectFramework({ next: '14.0.0' }), 'next');
});

test('a co-present meta + component framework prefers the meta-framework', () => {
	assert.equal(detectFramework({ next: '14.0.0', react: '18.0.0' }), 'next');
	assert.equal(detectFramework({ nuxt: '3.0.0', vue: '3.4.0' }), 'nuxt');
	assert.equal(detectFramework({ '@sveltejs/kit': '2.0.0', svelte: '5.0.0' }), 'svelte');
});

test('detectFramework() recognizes each supported framework in isolation', () => {
	assert.equal(detectFramework({ vue: '3.4.0' }), 'vue');
	assert.equal(detectFramework({ 'react-dom': '18.0.0' }), 'react');
	assert.equal(detectFramework({ astro: '4.0.0' }), 'astro');
	assert.equal(detectFramework({ '@angular/core': '17.0.0' }), 'angular');
});

test('a build tool alone (vite) is not a framework', () => {
	assert.equal(detectFramework({ vite: '5.0.0' }), undefined);
});

test('a Map input works the same as a plain object', () => {
	assert.equal(detectFramework(new Map([['react', '18.0.0']])), 'react');
	assert.equal(detectFramework(new Map([['vite', '5.0.0']])), undefined);
});

test('detectWorkspaceFramework() reads dependencies across all three maps', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'boxcode-fw-'));
	try {
		await writeFile(
			path.join(dir, 'package.json'),
			JSON.stringify({ devDependencies: { react: '18.0.0', vite: '5.0.0' } }),
		);
		assert.equal(await detectWorkspaceFramework(dir), 'react');
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('detectWorkspaceFramework() returns undefined for a missing package.json', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'boxcode-fw-'));
	try {
		assert.equal(await detectWorkspaceFramework(dir), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('detectWorkspaceFramework() neither throws nor crashes on malformed JSON', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'boxcode-fw-'));
	try {
		await writeFile(path.join(dir, 'package.json'), '{not json');
		assert.equal(await detectWorkspaceFramework(dir), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('every framework has a display label', () => {
	assert.equal(FRAMEWORK_LABELS.next, 'Next.js');
	assert.equal(FRAMEWORK_LABELS.react, 'React');
	assert.equal(FRAMEWORK_LABELS.svelte, 'Svelte');
});
