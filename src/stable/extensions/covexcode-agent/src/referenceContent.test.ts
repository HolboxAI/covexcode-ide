/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	markdownLanguageForPath,
	referenceContextSection,
	truncateContent,
	type ReadTextFile,
} from './referenceContent';

function fileUri(fsPath: string) {
	return { scheme: 'file', fsPath, toString: () => `file://${fsPath}` };
}

function symbolLocation(fsPath: string, startLine: number, endLine: number) {
	return { uri: fileUri(fsPath), range: { start: { line: startLine }, end: { line: endLine } } };
}

function fixtureReader(files: Record<string, string>): ReadTextFile {
	return async (fsPath: string) => {
		const content = files[fsPath];
		if (content === undefined) {
			throw new Error(`ENOENT: ${fsPath}`);
		}
		return content;
	};
}

test('a string reference passes through as a raw text attachment', async () => {
	const readFile = fixtureReader({});
	const section = await referenceContextSection({ id: 'vscode.console', value: 'console.log("hi")' }, readFile);
	assert.equal(section, '### Attached: vscode.console\n\nconsole.log("hi")');
});

test('a file reference reads and fences the file content', async () => {
	const readFile = fixtureReader({ '/p/src/index.ts': 'const a = 1;\nconst b = 2;' });
	const section = await referenceContextSection({ id: 'vscode.file', value: fileUri('/p/src/index.ts') }, readFile);
	assert.equal(section, '### File: /p/src/index.ts\n\n```typescript\nconst a = 1;\nconst b = 2;\n```');
});

test('a file reference is truncated to the configured line cap and marked', async () => {
	const readFile = fixtureReader({ '/p/notes.txt': 'a\nb\nc\nd\ne' });
	const section = await referenceContextSection(
		{ id: 'vscode.file', value: fileUri('/p/notes.txt') },
		readFile,
		{ maxLines: 3 },
	);
	assert.equal(section, '### File: /p/notes.txt\n\n```\na\nb\nc\n```\n\n_(truncated)_');
});

test('a symbol reference fences the symbol line range with surrounding context', async () => {
	const readFile = fixtureReader({ '/p/src/index.ts': 'line0\nline1\nline2\nline3\nline4' });
	const section = await referenceContextSection(
		{ id: 'vscode.workspaceSymbol', modelDescription: 'doThing', value: symbolLocation('/p/src/index.ts', 2, 2) },
		readFile,
	);
	assert.equal(section, '### Symbol: doThing — /p/src/index.ts:3\n\n```typescript\nline1\nline2\nline3\n```');
});

test('a symbol reference without a name labels itself by location', async () => {
	const readFile = fixtureReader({ '/p/src/index.ts': 'line0\nline1\nline2' });
	const section = await referenceContextSection(
		{ id: 'vscode.workspaceSymbol', value: symbolLocation('/p/src/index.ts', 0, 0) },
		readFile,
	);
	assert.equal(section, '### Symbol: /p/src/index.ts:1\n\n```typescript\nline0\nline1\n```');
});

test('a non-file Uri falls back to a path-only attachment instead of reading', async () => {
	const readFile = fixtureReader({});
	const untitled = { scheme: 'untitled', toString: () => 'untitled:Untitled-1' };
	const section = await referenceContextSection({ id: 'vscode.uri', value: untitled }, readFile);
	assert.equal(section, '### Attached: vscode.uri\n\nuntitled:Untitled-1');
});

test('an unreadable file (directory) falls back to a path-only attachment', async () => {
	const throwing: ReadTextFile = async () => { throw new Error('EISDIR'); };
	const section = await referenceContextSection({ id: 'vscode.file', value: fileUri('/p/somedir') }, throwing);
	assert.equal(section, '### Attached: vscode.file\n\nfile:///p/somedir');
});

test('an unrecognized value shape is skipped, not stringified', async () => {
	const readFile = fixtureReader({});
	const section = await referenceContextSection({ id: 'x', value: { foo: 'bar' } }, readFile);
	assert.equal(section, undefined);
});

test('markdownLanguageForPath() maps known extensions and defaults to none', () => {
	assert.equal(markdownLanguageForPath('/p/index.tsx'), 'tsx');
	assert.equal(markdownLanguageForPath('/p/README.md'), 'markdown');
	assert.equal(markdownLanguageForPath('/p/App.vue'), 'vue');
	assert.equal(markdownLanguageForPath('/p/unknown.xyz'), undefined);
	assert.equal(markdownLanguageForPath('/p/noext'), undefined);
});

test('truncateContent() caps by lines and characters', () => {
	assert.deepEqual(truncateContent('a\nb\nc', 100, 2), { text: 'a\nb', truncated: true });
	assert.deepEqual(truncateContent('abc', 2, 10), { text: 'ab', truncated: true });
	assert.deepEqual(truncateContent('a\nb', 100, 10), { text: 'a\nb', truncated: false });
});
