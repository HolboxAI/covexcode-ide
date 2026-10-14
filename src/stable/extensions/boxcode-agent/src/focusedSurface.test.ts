import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFocusedSurface, formatFocusedSurface, isBrowserFocused } from './focusedSurface';

test('browser takes priority over editor and terminal', () => {
	const input = {
		browserUrl: 'http://localhost:3000',
		browserTitle: 'My App',
		editorLabel: 'app.ts',
		editorLanguageId: 'typescript',
		terminalName: 'zsh',
	};
	assert.deepEqual(resolveFocusedSurface(input), {
		kind: 'browser',
		url: 'http://localhost:3000',
		title: 'My App',
	});
	assert.equal(isBrowserFocused(input), true);
});

test('editor is reported when no browser is focused', () => {
	const input = { editorLabel: 'app.ts', editorLanguageId: 'typescript' };
	assert.deepEqual(resolveFocusedSurface(input), {
		kind: 'editor',
		label: 'app.ts',
		languageId: 'typescript',
	});
	assert.equal(isBrowserFocused(input), false);
});

test('terminal is reported when no browser or editor is focused', () => {
	const input = { terminalName: 'zsh' };
	assert.deepEqual(resolveFocusedSurface(input), { kind: 'terminal', name: 'zsh' });
});

test('empty input resolves to none and formats to empty string', () => {
	assert.deepEqual(resolveFocusedSurface({}), { kind: 'none' });
	assert.equal(formatFocusedSurface({}), '');
});

test('browser focus formats a usable hint', () => {
	const out = formatFocusedSurface({
		browserUrl: 'http://localhost:3000',
		browserTitle: 'My App',
	});
	assert.match(out, /http:\/\/localhost:3000/);
	assert.match(out, /My App/);
});
