/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeBrowserPreview, stripOversizedDataUris } from './chatMarkdown';

test('stripOversizedDataUris() leaves ordinary markdown alone', () => {
	assert.equal(stripOversizedDataUris('hello **world**'), 'hello **world**');
});

test('stripOversizedDataUris() leaves a small data URI intact', () => {
	const small = '![x](data:image/png;base64,aaa)';
	assert.equal(stripOversizedDataUris(small), small);
});

test('stripOversizedDataUris() replaces a screenshot-sized data URI with a short notice', () => {
	const payload = 'A'.repeat(3000);
	const text = `see ![screenshot](data:image/png;base64,${payload}) done`;
	const stripped = stripOversizedDataUris(text);
	assert.doesNotMatch(stripped, /AAAA/);
	assert.match(stripped, /image\/png/);
	assert.match(stripped, /Integrated Browser/);
	assert.ok(stripped.length < 200);
});

test('describeBrowserPreview() does not include image bytes', () => {
	assert.match(describeBrowserPreview(), /Integrated Browser/);
	assert.doesNotMatch(describeBrowserPreview(), /base64/);
	assert.doesNotMatch(describeBrowserPreview(), /data:/);
});
