/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeCombinedDiff } from './inlineDiff';

test('computeCombinedDiff - returns empty hunks when text is identical', () => {
	const text = 'line 1\nline 2\nline 3\n';
	const res = computeCombinedDiff(text, text);
	assert.equal(res.hunks.length, 0);
	assert.equal(res.combinedText, text);
});

test('computeCombinedDiff - brand new file', () => {
	const before = '';
	const after = 'first line\nsecond line\n';
	const res = computeCombinedDiff(before, after);
	assert.equal(res.hunks.length, 1);
	assert.equal(res.hunks[0].deletedCount, 0);
	assert.equal(res.hunks[0].addedCount, 2);
	assert.deepEqual(res.hunks[0].addedLines, ['first line', 'second line']);
	assert.equal(res.combinedText, 'first line\nsecond line\n');
});

test('computeCombinedDiff - completely deleted file', () => {
	const before = 'old 1\nold 2\n';
	const after = '';
	const res = computeCombinedDiff(before, after);
	assert.equal(res.hunks.length, 1);
	assert.equal(res.hunks[0].deletedCount, 2);
	assert.equal(res.hunks[0].addedCount, 0);
	assert.deepEqual(res.hunks[0].deletedLines, ['old 1', 'old 2']);
	assert.equal(res.combinedText, 'old 1\nold 2\n');
});

test('computeCombinedDiff - single modification in middle', () => {
	const before = 'head\noriginal middle\ntail\n';
	const after = 'head\nupdated middle\ntail\n';
	const res = computeCombinedDiff(before, after);
	assert.equal(res.hunks.length, 1);
	assert.equal(res.hunks[0].startLine, 1);
	assert.equal(res.hunks[0].deletedCount, 1);
	assert.equal(res.hunks[0].addedCount, 1);
	assert.deepEqual(res.hunks[0].deletedLines, ['original middle']);
	assert.deepEqual(res.hunks[0].addedLines, ['updated middle']);
	assert.equal(res.combinedText, 'head\noriginal middle\nupdated middle\ntail\n');
});

test('computeCombinedDiff - multiple hunks separated by unchanged lines', () => {
	const before = [
		'func top() {}',
		'line A',
		'common 1',
		'common 2',
		'line B',
		'func bottom() {}'
	].join('\n');
	const after = [
		'func top() {}',
		'line A changed',
		'common 1',
		'common 2',
		'line B changed',
		'func bottom() {}'
	].join('\n');

	const res = computeCombinedDiff(before, after);
	assert.equal(res.hunks.length, 2);

	// Hunk 0
	assert.equal(res.hunks[0].startLine, 1);
	assert.equal(res.hunks[0].deletedCount, 1);
	assert.equal(res.hunks[0].addedCount, 1);
	assert.deepEqual(res.hunks[0].deletedLines, ['line A']);
	assert.deepEqual(res.hunks[0].addedLines, ['line A changed']);

	// Hunk 1
	assert.equal(res.hunks[1].startLine, 5);
	assert.equal(res.hunks[1].deletedCount, 1);
	assert.equal(res.hunks[1].addedCount, 1);
	assert.deepEqual(res.hunks[1].deletedLines, ['line B']);
	assert.deepEqual(res.hunks[1].addedLines, ['line B changed']);
});

test('computeCombinedDiff - handles CRLF line endings cleanly', () => {
	const before = 'line 1\r\nline 2\r\n';
	const after = 'line 1\r\nline 2 changed\r\n';
	const res = computeCombinedDiff(before, after);
	assert.equal(res.hunks.length, 1);
	assert.equal(res.hunks[0].startLine, 1);
	assert.deepEqual(res.hunks[0].deletedLines, ['line 2']);
	assert.deepEqual(res.hunks[0].addedLines, ['line 2 changed']);
});
