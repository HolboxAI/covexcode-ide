/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyHunkSelection, renderCollapsibleDiffMarkdown, renderHunksMarkdown, summarizeHunk } from './diffReview';
import type { DiffHunk, DiffHunkLine, DiffLineChange } from './acpClient';

/**
 * Builds one hunk with correct 1-based `oldNo`/`newNo`, starting from the
 * number of lines preceding the hunk on each side. Mirrors how covexcode's
 * `diff.rs` numbers lines; the tests hand-space hunks far enough apart that
 * covexcode would keep them separate, so the fixtures are what a real
 * `session/request_permission` payload would carry.
 */
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

const NEW_TEXT = 'one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nTEN\neleven\ntwelve\n';
const OLD_TEXT = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n';

const HUNK_ONE = mkHunk(0, 0, [
	['context', 'one'],
	['context', 'two'],
	['removed', 'three'],
	['added', 'THREE'],
	['context', 'four'],
	['context', 'five'],
]);
const HUNK_TWO = mkHunk(8, 8, [
	['context', 'nine'],
	['removed', 'ten'],
	['added', 'TEN'],
	['context', 'eleven'],
	['context', 'twelve'],
]);

test('applyHunkSelection() accepts every hunk back to the original newText', () => {
	assert.equal(applyHunkSelection(NEW_TEXT, [HUNK_ONE, HUNK_TWO], [true, true]), NEW_TEXT);
});

test('applyHunkSelection() rejects every hunk back to the old text', () => {
	assert.equal(applyHunkSelection(NEW_TEXT, [HUNK_ONE, HUNK_TWO], [false, false]), OLD_TEXT);
});

test('applyHunkSelection() keeps only the accepted hunks and leaves the gap unchanged', () => {
	const keepSecondOnly = applyHunkSelection(NEW_TEXT, [HUNK_ONE, HUNK_TWO], [false, true]);
	assert.equal(keepSecondOnly, 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\neleven\ntwelve\n');

	const keepFirstOnly = applyHunkSelection(NEW_TEXT, [HUNK_ONE, HUNK_TWO], [true, false]);
	assert.equal(keepFirstOnly, 'one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\ntwelve\n');
});

test('applyHunkSelection() preserves a missing trailing newline', () => {
	const noTrailingNewline = 'a\nb\nC';
	const hunk = mkHunk(0, 0, [['context', 'a'], ['context', 'b'], ['removed', 'c'], ['added', 'C']]);
	assert.equal(applyHunkSelection(noTrailingNewline, [hunk], [true]), 'a\nb\nC');
	assert.equal(applyHunkSelection(noTrailingNewline, [hunk], [false]), 'a\nb\nc');
});

test('applyHunkSelection() handles a brand-new file: accept keeps it, reject empties it', () => {
	const hunk = mkHunk(0, 0, [['added', 'x'], ['added', 'y'], ['added', 'z']]);
	assert.equal(applyHunkSelection('x\ny\nz\n', [hunk], [true]), 'x\ny\nz\n');
	assert.equal(applyHunkSelection('x\ny\nz\n', [hunk], [false]), '');
});

test('applyHunkSelection() restores a wholly deleted file when the hunk is rejected', () => {
	const hunk = mkHunk(0, 0, [['removed', 'x'], ['removed', 'y']]);
	assert.equal(applyHunkSelection('', [hunk], [true]), '');
	assert.equal(applyHunkSelection('', [hunk], [false]), 'x\ny');
});

test('summarizeHunk() tallies the change and previews the first changed line', () => {
	assert.equal(summarizeHunk(HUNK_ONE), '1 addition, 1 removal — three');
	assert.equal(summarizeHunk(mkHunk(0, 0, [['added', 'a'], ['added', 'b']])), '2 additions — a');
	assert.equal(summarizeHunk(mkHunk(0, 0, [['removed', 'a']])), '1 removal — a');
	assert.equal(summarizeHunk(mkHunk(0, 0, [['context', 'a']])), 'no changes — ');
});

test('renderHunksMarkdown() renders a unified-diff fenced block', () => {
	const single = mkHunk(0, 0, [['context', 'a'], ['removed', 'b'], ['added', 'c']]);
	assert.equal(renderHunksMarkdown([single]), '```diff\n a\n-b\n+c\n```');
});

test('renderCollapsibleDiffMarkdown() renders short diff without details toggle', () => {
	const single = mkHunk(0, 0, [['context', 'a'], ['removed', 'b'], ['added', 'c']]);
	const res = renderCollapsibleDiffMarkdown([single], 'app.js', 4);
	assert.ok(res.includes('$(file) **app.js** &nbsp; `+1` `-1`'));
	assert.ok(res.includes('```diff\n a\n-b\n+c\n```'));
	assert.ok(!res.includes('<details>'));
});

test('renderCollapsibleDiffMarkdown() renders long diff with details toggle after previewLimit', () => {
	const lines: [DiffLineChange, string][] = [
		['removed', 'old1'],
		['added', 'new1'],
		['added', 'new2'],
		['added', 'new3'],
		['added', 'new4'],
		['added', 'new5'],
	];
	const hunk = mkHunk(0, 0, lines);
	const res = renderCollapsibleDiffMarkdown([hunk], 'src/main.ts', 4);
	assert.ok(res.includes('$(file) **main.ts** &nbsp; `+5` `-1`'));
	assert.ok(res.includes('```diff\n-old1\n+new1\n+new2\n+new3\n```'));
	assert.ok(res.includes('<details>\n<summary>▾ Show more (2 lines)</summary>'));
	assert.ok(res.includes('+new4\n+new5'));
});

test('renderCollapsibleDiffMarkdown() handles diffs with only additions (new file)', () => {
	const hunk = mkHunk(0, 0, [['added', 'line 1'], ['added', 'line 2']]);
	const res = renderCollapsibleDiffMarkdown([hunk], 'newfile.js', 4);
	assert.ok(res.includes('$(file) **newfile.js** &nbsp; `+2` `-0`'));
	assert.ok(res.includes('```diff\n+line 1\n+line 2\n```'));
	assert.ok(!res.includes('<details>'));
});

test('renderCollapsibleDiffMarkdown() handles diffs with only removals (file deletion)', () => {
	const hunk = mkHunk(0, 0, [['removed', 'line 1'], ['removed', 'line 2']]);
	const res = renderCollapsibleDiffMarkdown([hunk], 'deleted.js', 4);
	assert.ok(res.includes('$(file) **deleted.js** &nbsp; `+0` `-2`'));
	assert.ok(res.includes('```diff\n-line 1\n-line 2\n```'));
});
