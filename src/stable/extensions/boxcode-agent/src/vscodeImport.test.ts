/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	collectSourceSnapshot,
	detectSourceInstalls,
	extensionsDirFor,
	hasImportableContent,
	KNOWN_SOURCE_INSTALLS,
	mergeKeybindings,
	mergeSettings,
	readExtensionIds,
	readKeybindings,
	readSettings,
	readSnippets,
	userDataDirFor,
} from './vscodeImport';

test('userDataDirFor() follows the platform-specific app-data convention', () => {
	assert.equal(
		userDataDirFor('/home/u', 'linux', 'Code', {}),
		'/home/u/.config/Code',
	);
	assert.equal(
		userDataDirFor('/home/u', 'linux', 'Code', { XDG_CONFIG_HOME: '/xdg' }),
		'/xdg/Code',
	);
	assert.equal(
		userDataDirFor('/Users/u', 'darwin', 'Code', {}),
		'/Users/u/Library/Application Support/Code',
	);
	assert.equal(
		userDataDirFor('C:\\Users\\u', 'win32', 'Code', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }),
		path.join('C:\\Users\\u\\AppData\\Roaming', 'Code'),
	);
});

test('extensionsDirFor() is home-relative for every product', () => {
	assert.equal(extensionsDirFor('/home/u', '.vscode'), '/home/u/.vscode/extensions');
	assert.equal(extensionsDirFor('/Users/u', '.cursor'), '/Users/u/.cursor/extensions');
});

test('detectSourceInstalls() finds an install by its User directory', async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), 'boxcode-import-'));
	try {
		// VS Code (stable) on Linux: ~/.config/Code/User exists.
		const codeUser = path.join(home, '.config', 'Code', 'User');
		await mkdir(codeUser, { recursive: true });

		const installs = detectSourceInstalls(home, 'linux', {});
		const ids = installs.map(i => i.id);
		assert.ok(ids.includes('vscode'));
		assert.ok(!ids.includes('cursor'));

		const code = installs.find(i => i.id === 'vscode')!;
		assert.equal(code.userDataDir, path.join(home, '.config', 'Code'));
		assert.equal(code.extensionsDir, path.join(home, '.vscode', 'extensions'));
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('detectSourceInstalls() finds an install by its extensions directory', async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), 'boxcode-import-'));
	try {
		await mkdir(path.join(home, '.cursor', 'extensions'), { recursive: true });
		const ids = detectSourceInstalls(home, 'darwin', {}).map(i => i.id);
		assert.deepEqual(ids, ['cursor']);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('detectSourceInstalls() returns [] when nothing is installed', async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), 'boxcode-import-'));
	try {
		assert.deepEqual(detectSourceInstalls(home, 'linux', {}), []);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('readSettings() parses an object and rejects non-objects', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'boxcode-import-'));
	try {
		await mkdir(path.join(dir, 'User'), { recursive: true });
		await writeFile(path.join(dir, 'User', 'settings.json'), JSON.stringify({ 'editor.tabSize': 2 }));
		assert.deepEqual(readSettings(dir), { 'editor.tabSize': 2 });

		await writeFile(path.join(dir, 'User', 'settings.json'), '[1,2,3]');
		assert.equal(readSettings(dir), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('readKeybindings() parses an array and rejects non-arrays', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'boxcode-import-'));
	try {
		await mkdir(path.join(dir, 'User'), { recursive: true });
		await writeFile(path.join(dir, 'User', 'keybindings.json'), JSON.stringify([{ key: 'ctrl+k ctrl+c', command: 'editor.action.addCommentLine' }]));
		assert.equal(readKeybindings(dir)!.length, 1);

		await writeFile(path.join(dir, 'User', 'keybindings.json'), '{"key":"x"}');
		assert.equal(readKeybindings(dir), undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('readSnippets() returns only valid JSON snippet files', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'boxcode-import-'));
	try {
		await mkdir(path.join(dir, 'User', 'snippets'), { recursive: true });
		await writeFile(path.join(dir, 'User', 'snippets', 'ts.json'), JSON.stringify({ 'Log to console': { prefix: 'log', body: ['console.log($1);'] } }));
		await writeFile(path.join(dir, 'User', 'snippets', 'broken.json'), '{not json');
		await writeFile(path.join(dir, 'User', 'snippets', 'README.txt'), 'not a snippet');

		const snippets = readSnippets(dir);
		assert.equal(snippets.length, 1);
		assert.equal(snippets[0].name, 'ts.json');
		assert.ok(snippets[0].content['Log to console']);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('readExtensionIds() reads publisher.name from each package.json', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'boxcode-import-'));
	try {
		await mkdir(path.join(dir, 'dbaeumer.vscode-eslint-3.0.34'), { recursive: true });
		await writeFile(
			path.join(dir, 'dbaeumer.vscode-eslint-3.0.34', 'package.json'),
			JSON.stringify({ name: 'vscode-eslint', publisher: 'dbaeumer', version: '3.0.34' }),
		);
		await mkdir(path.join(dir, 'esbenp.prettier-vscode-12.4.0'), { recursive: true });
		await writeFile(
			path.join(dir, 'esbenp.prettier-vscode-12.4.0', 'package.json'),
			JSON.stringify({ name: 'prettier-vscode', publisher: 'esbenp', version: '12.4.0' }),
		);
		// A folder with no manifest is not an extension.
		await mkdir(path.join(dir, 'junk-folder'), { recursive: true });

		assert.deepEqual(readExtensionIds(dir), ['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode']);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test('collectSourceSnapshot() + hasImportableContent() cover each category', async () => {
	const home = await mkdtemp(path.join(os.tmpdir(), 'boxcode-import-'));
	try {
		const userDir = path.join(home, '.config', 'Code', 'User');
		await mkdir(userDir, { recursive: true });
		await writeFile(path.join(userDir, 'settings.json'), JSON.stringify({ 'editor.fontSize': 14 }));
		await mkdir(path.join(home, '.vscode', 'extensions'), { recursive: true });

		const [install] = detectSourceInstalls(home, 'linux', {});
		const snapshot = collectSourceSnapshot(install);
		assert.deepEqual(snapshot.settings, { 'editor.fontSize': 14 });
		assert.equal(snapshot.keybindings, undefined);
		assert.deepEqual(snapshot.snippets, []);
		assert.deepEqual(snapshot.extensionIds, []);
		assert.equal(hasImportableContent(snapshot), true);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test('hasImportableContent() is false for an empty install', () => {
	assert.equal(
		hasImportableContent({
			install: { id: 'x', label: 'x', nameShort: 'X', dataFolderName: '.x', userDataDir: '/u', extensionsDir: '/e' },
			settings: undefined,
			keybindings: undefined,
			snippets: [],
			extensionIds: [],
		}),
		false,
	);
});

test('mergeSettings() lets the source win while preserving dest-only keys', () => {
	const dest = { 'editor.fontSize': 16, 'boxcode.path': '/opt/boxcode' };
	const src = { 'editor.fontSize': 13, 'workbench.colorTheme': 'Dark+' };
	assert.deepEqual(mergeSettings(dest, src), {
		'editor.fontSize': 13,
		'workbench.colorTheme': 'Dark+',
		'boxcode.path': '/opt/boxcode',
	});
});

test('mergeKeybindings() dedupes by key+command and keeps destination first', () => {
	const dest = [{ key: 'ctrl+s', command: 'workbench.action.files.save' }];
	const src = [
		{ key: 'ctrl+s', command: 'workbench.action.files.save' }, // duplicate
		{ key: 'ctrl+k ctrl+c', command: 'editor.action.addCommentLine' },
	];
	assert.deepEqual(mergeKeybindings(dest, src), [
		{ key: 'ctrl+s', command: 'workbench.action.files.save' },
		{ key: 'ctrl+k ctrl+c', command: 'editor.action.addCommentLine' },
	]);
});

test('the known-install catalog covers VS Code and Cursor', () => {
	const ids = KNOWN_SOURCE_INSTALLS.map(i => i.id);
	assert.ok(ids.includes('vscode'));
	assert.ok(ids.includes('cursor'));
});
