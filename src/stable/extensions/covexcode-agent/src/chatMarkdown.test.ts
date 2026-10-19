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

test('stripOversizedDataUris() stops at trailing prose instead of swallowing it', () => {
	// A bare data URI (no `)` to delimit it) followed by prose: the base64
	// class must not eat the words after it as if they were payload.
	const payload = 'A'.repeat(3000);
	const text = `data:image/png;base64,${payload}\n\nHere is some prose after the image.`;
	const stripped = stripOversizedDataUris(text);
	assert.doesNotMatch(stripped, /AAAA/);
	assert.match(stripped, /Here is some prose after the image\./);
});

test('describeBrowserPreview() does not include image bytes', () => {
	assert.match(describeBrowserPreview(), /Integrated Browser/);
	assert.doesNotMatch(describeBrowserPreview(), /base64/);
	assert.doesNotMatch(describeBrowserPreview(), /data:/);
});
