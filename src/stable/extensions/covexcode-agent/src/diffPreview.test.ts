/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	computeFileDiffSummary,
	countHunkChanges,
	countLineDiff,
	isBinaryText,
	splitDiffLines,
} from './diffPreview';
import type { DiffHunk, DiffHunkLine, DiffLineChange } from './acpClient';

function mkHunk(beforeOld: number, beforeNew: number, lines: Array<[DiffLineChange, string]>): DiffHunk {
	let oldNo = beforeOld;
	let newNo = beforeNew;
	return {
		lines: lines.map(([change, text]) => {
			const line: DiffHunkLine = { change, text };
			if (change === 'context') {
				line.oldNo = ++oldNo;
				line.newNo = ++newNo;
			} else if (change === 'added') {
				line.newNo = ++newNo;
			} else {
				line.oldNo = ++oldNo;
			}
			return line;
		}),
	};
}

test('splitDiffLines() mirrors covexcode str::lines()', () => {
	assert.deepEqual(splitDiffLines(''), []);
	assert.deepEqual(splitDiffLines('a\nb\n'), ['a', 'b']);
	assert.deepEqual(splitDiffLines('a\nb'), ['a', 'b']);
});

test('isBinaryText() flags NUL bytes and high control-char density', () => {
	assert.equal(isBinaryText('hello'), false);
	assert.equal(isBinaryText('a\0b'), true);
	const dense = Array.from({ length: 100 }, (_, i) => String.fromCharCode(i % 128)).join('');
	assert.equal(isBinaryText(dense), true);
	assert.equal(isBinaryText('line one\nline two\n'), false);
});

test('countHunkChanges() tallies additions and deletions across hunks', () => {
	const hunks = [
		mkHunk(0, 0, [['context', 'a'], ['removed', 'b'], ['added', 'c'], ['added', 'd']]),
		mkHunk(3, 3, [['removed', 'e']]),
	];
	assert.deepEqual(countHunkChanges(hunks), { added: 2, removed: 2 });
});

test('computeFileDiffSummary() detects added / modified / deleted / renamed', () => {
	assert.equal(computeFileDiffSummary({ oldText: undefined, newText: 'x\n' }).status, 'added');
	assert.equal(computeFileDiffSummary({ oldText: 'x\n', newText: '' }).status, 'deleted');
	assert.equal(computeFileDiffSummary({ oldText: 'x\n', newText: 'y\n' }).status, 'modified');
	assert.equal(computeFileDiffSummary({ oldText: 'x\n', newText: 'x\n', oldPath: 'a.js', newPath: 'b.js' }).status, 'renamed');
});

test('computeFileDiffSummary() counts from hunks when present', () => {
	const summary = computeFileDiffSummary({
		oldText: 'a\nb\n',
		newText: 'a\nc\nd\n',
		hunks: [mkHunk(0, 0, [['context', 'a'], ['removed', 'b'], ['added', 'c'], ['added', 'd']])],
	});
	assert.equal(summary.status, 'modified');
	assert.equal(summary.added, 2);
	assert.equal(summary.removed, 1);
	assert.equal(summary.hasTextualDiff, true);
	assert.equal(summary.isBinary, false);
});

test('computeFileDiffSummary() falls back to a line diff when hunks are absent', () => {
	const summary = computeFileDiffSummary({ oldText: 'a\nb\nc\n', newText: 'a\nc\nd\n' });
	assert.equal(summary.added, 1);
	assert.equal(summary.removed, 1);
});

test('computeFileDiffSummary() handles a brand-new file without hunks', () => {
	const summary = computeFileDiffSummary({ oldText: undefined, newText: 'a\nb\n' });
	assert.equal(summary.status, 'added');
	assert.equal(summary.added, 2);
	assert.equal(summary.removed, 0);
});

test('computeFileDiffSummary() handles a wholly deleted file without hunks', () => {
	const summary = computeFileDiffSummary({ oldText: 'a\nb\n', newText: '' });
	assert.equal(summary.status, 'deleted');
	assert.equal(summary.added, 0);
	assert.equal(summary.removed, 2);
});

test('computeFileDiffSummary() flags binary content and does not count lines', () => {
	const summary = computeFileDiffSummary({ oldText: 'x\n', newText: 'PNG\0DATA\n' });
	assert.equal(summary.isBinary, true);
	assert.equal(summary.added, 0);
	assert.equal(summary.removed, 0);
	assert.equal(summary.hasTextualDiff, false);
});

test('computeFileDiffSummary() marks a no-op change as having no textual diff', () => {
	const summary = computeFileDiffSummary({ oldText: 'same\n', newText: 'same\n' });
	assert.equal(summary.hasTextualDiff, false);
	assert.equal(summary.added, 0);
	assert.equal(summary.removed, 0);
});

test('countLineDiff() reports whole-file counts when bounded', () => {
	const oldText = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n') + '\n';
	const newText = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n') + '\n';
	// Inserting two lines into 10 -> 2 additions, 0 removals.
	assert.deepEqual(countLineDiff(oldText, newText), { added: 2, removed: 0 });
});

test('computeFileDiffSummary() handles empty files', () => {
	assert.equal(computeFileDiffSummary({ oldText: '', newText: '' }).hasTextualDiff, false);
	assert.equal(computeFileDiffSummary({ oldText: undefined, newText: '' }).status, 'added');
});
