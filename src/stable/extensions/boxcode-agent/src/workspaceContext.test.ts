/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
	isPathInsideFolder,
	prependWorkspacePrefix,
	resolvePathAgainstCwd,
	resolveWorkspaceCwd,
	workspacePromptPrefix,
} from './workspaceContext';

const home = '/Users/dev';

test('resolveWorkspaceCwd() uses the first folder when one is open', () => {
	const context = resolveWorkspaceCwd([{ fsPath: '/Users/dev/app' }], undefined, home);
	assert.equal(context.cwd, '/Users/dev/app');
	assert.equal(context.hasFolder, true);
	assert.deepEqual(context.folderPaths, ['/Users/dev/app']);
});

test('resolveWorkspaceCwd() prefers the folder that contains the active file in a multi-root window', () => {
	const context = resolveWorkspaceCwd(
		[{ fsPath: '/Users/dev/alpha' }, { fsPath: '/Users/dev/beta' }],
		'/Users/dev/beta/src/index.ts',
		home,
	);
	assert.equal(context.cwd, '/Users/dev/beta');
	assert.equal(context.activeFolderPath, '/Users/dev/beta');
	assert.equal(context.hasFolder, true);
});

test('resolveWorkspaceCwd() falls back to the first folder when the active file is outside every root', () => {
	const context = resolveWorkspaceCwd(
		[{ fsPath: '/Users/dev/app' }],
		'/tmp/scratch.ts',
		home,
	);
	assert.equal(context.cwd, '/Users/dev/app');
	assert.equal(context.activeFolderPath, undefined);
});

test('resolveWorkspaceCwd() uses homedir only when no folder is open, and says so', () => {
	const context = resolveWorkspaceCwd(undefined, undefined, home);
	assert.equal(context.cwd, home);
	assert.equal(context.hasFolder, false);
	assert.deepEqual(context.folderPaths, []);
});

test('resolveWorkspaceCwd() does not treat a single open file as a workspace folder', () => {
	const context = resolveWorkspaceCwd([], '/Users/dev/notes.txt', home);
	assert.equal(context.hasFolder, false);
	assert.equal(context.cwd, home);
});

test('isPathInsideFolder() is true for the folder itself and nested files', () => {
	assert.equal(isPathInsideFolder('/Users/dev/app', '/Users/dev/app'), true);
	assert.equal(isPathInsideFolder('/Users/dev/app/src/a.ts', '/Users/dev/app'), true);
	assert.equal(isPathInsideFolder('/Users/dev/other/a.ts', '/Users/dev/app'), false);
});

test('workspacePromptPrefix() names the working directory when a folder is open', () => {
	const prefix = workspacePromptPrefix({
		cwd: '/Users/dev/app',
		hasFolder: true,
		folderPaths: ['/Users/dev/app'],
		activeFolderPath: '/Users/dev/app',
	});
	assert.match(prefix, /Working directory.*\/Users\/dev\/app/);
	assert.doesNotMatch(prefix, /No workspace folder/);
});

test('workspacePromptPrefix() lists every folder in a multi-root window', () => {
	const prefix = workspacePromptPrefix({
		cwd: '/Users/dev/beta',
		hasFolder: true,
		folderPaths: ['/Users/dev/alpha', '/Users/dev/beta'],
		activeFolderPath: '/Users/dev/beta',
	});
	assert.match(prefix, /Open folders:/);
	assert.match(prefix, /\/Users\/dev\/alpha/);
	assert.match(prefix, /\/Users\/dev\/beta/);
});

test('workspacePromptPrefix() tells the model not to invent a project when nothing is open', () => {
	const prefix = workspacePromptPrefix({
		cwd: home,
		hasFolder: false,
		folderPaths: [],
		activeFolderPath: undefined,
	});
	assert.match(prefix, /No workspace folder is open/);
	assert.match(prefix, /do not use the home directory/i);
});

test('prependWorkspacePrefix() puts the workspace block ahead of the user text', () => {
	assert.equal(prependWorkspacePrefix('fix the bug', 'Working directory: /app'), 'Working directory: /app\n\nfix the bug');
	assert.equal(prependWorkspacePrefix('fix the bug', ''), 'fix the bug');
});

test('resolvePathAgainstCwd() joins relative diffs and leaves absolute paths alone', () => {
	assert.equal(resolvePathAgainstCwd('/Users/dev/app', 'src/a.ts'), path.join('/Users/dev/app', 'src/a.ts'));
	assert.equal(resolvePathAgainstCwd('/Users/dev/app', '/tmp/a.ts'), '/tmp/a.ts');
});
