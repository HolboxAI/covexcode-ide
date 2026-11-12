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
	isPlausibleBeforeImage,
	selectTurnChanges,
	snapshotTouches,
	splitDiffLines,
	toolTitlePath,
	TurnFileObserver,
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

test('toolTitlePath() splits a file tool title into action and path', () => {
	assert.deepEqual(toolTitlePath('read src/styles.css'), { action: 'read', path: 'src/styles.css' });
	assert.deepEqual(toolTitlePath('edit src/App.jsx'), { action: 'edit', path: 'src/App.jsx' });
	assert.deepEqual(toolTitlePath('  write  a/b c.js '), { action: 'write', path: 'a/b c.js' });
});

test('toolTitlePath() refuses titles that do not name a file', () => {
	// A command or a search must never be mistaken for a file operation -- the
	// observer would otherwise freeze a real path on a shell command.
	assert.equal(toolTitlePath('$ npm test'), undefined);
	assert.equal(toolTitlePath('search for useState'), undefined);
	assert.equal(toolTitlePath('read'), undefined);
});

test('TurnFileObserver keeps the read taken before the first mutation', () => {
	const observed = new TurnFileObserver();
	// The real turn shape this mirrors: read (before), edit, read (after).
	observed.noteRead('src/styles.css', 'background: #ffffff;');
	observed.noteMutation('src/styles.css');
	observed.noteRead('src/styles.css', 'background: #f3efe6;');
	assert.equal(observed.beforeFor('src/styles.css'), 'background: #ffffff;');
});

test('TurnFileObserver reports no before-image for a file never read first', () => {
	const observed = new TurnFileObserver();
	observed.noteMutation('src/App.jsx');
	assert.equal(observed.beforeFor('src/App.jsx'), undefined);
});

test('selectTurnChanges() includes a file first touched in this turn', () => {
	const changes = [{ path: 'src/a.css', turn: 1, touches: 1, action: 'restore' }];
	assert.deepEqual(selectTurnChanges(changes, new Map(), 1).map(c => c.path), ['src/a.css']);
});

test('selectTurnChanges() includes a file RE-edited in a later turn', () => {
	// The real capture this mirrors: turn 1 and turn 2 both edit the same file,
	// and the journal keeps reporting turn 1 with touches incremented to 2.
	const changes = [{ path: 'design-tokens.css', turn: 1, touches: 2, action: 'restore' }];
	const afterTurnOne = new Map([['design-tokens.css', 1]]);
	assert.deepEqual(
		selectTurnChanges(changes, afterTurnOne, 2).map(c => c.path),
		['design-tokens.css'],
	);
});

test('selectTurnChanges() excludes a file not touched by this turn', () => {
	const changes = [{ path: 'src/a.css', turn: 1, touches: 1, action: 'restore' }];
	const afterTurnOne = new Map([['src/a.css', 1]]);
	assert.deepEqual(selectTurnChanges(changes, afterTurnOne, 2), []);
});

test('selectTurnChanges() never reports a blocked (shell-only) entry', () => {
	const changes = [{ path: 'src/a.css', turn: 1, touches: 1, action: 'blocked' }];
	assert.deepEqual(selectTurnChanges(changes, new Map(), 1), []);
});

test('snapshotTouches() records every entry so the next turn can compare', () => {
	const snapshot = new Map<string, number>();
	snapshotTouches([
		{ path: 'a.css', turn: 1, touches: 3, action: 'restore' },
		{ path: 'b.css', turn: 2, touches: 1, action: 'restore' },
	], snapshot);
	assert.equal(snapshot.get('a.css'), 3);
	assert.equal(snapshot.get('b.css'), 1);
});

test('the observed before-image yields exact counts for a one-line CSS edit', () => {
	const observed = new TurnFileObserver();
	const before = 'body {\n  margin: 0;\n  font-family: system-ui, sans-serif;\n  background: #ffffff;\n  color: #1c1c22;\n}\n\n.app {\n  max-width: 720px;\n  margin: 0 auto;\n  padding: 24px;\n}\n';
	const after = before.replace('#ffffff', '#f3efe6');
	observed.noteRead('src/styles.css', before);
	observed.noteMutation('src/styles.css');
	observed.noteRead('src/styles.css', after);

	const beforeImage = observed.beforeFor('src/styles.css');
	// The whole point of the observer: a before-image must exist for the diff to
	// be real rather than a filename-only row.
	assert.notEqual(beforeImage, undefined);
	const summary = computeFileDiffSummary({ oldText: beforeImage, newText: after });
	assert.equal(summary.status, 'modified');
	assert.equal(summary.added, 1);
	assert.equal(summary.removed, 1);
	assert.equal(summary.hasTextualDiff, true);
});

test('isPlausibleBeforeImage() accepts a whole-file pre-image of a one-line edit', () => {
	const before = Array.from({ length: 239 }, (_, i) => `line ${i}`).join('\n') + '\n';
	const after = before.replace('line 10\n', 'line 10 changed\n');
	assert.equal(isPlausibleBeforeImage(before, after), true);
});

test('isPlausibleBeforeImage() rejects a partial read used as a pre-image', () => {
	// The real failure this guards: a 60-line read of a 239-line file reported
	// the one-line change as "+239 -60". A fragment must never be diffed against
	// the whole file.
	const after = Array.from({ length: 239 }, (_, i) => `line ${i}`).join('\n') + '\n';
	const partial = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') + '\n';
	assert.equal(isPlausibleBeforeImage(partial, after), false);
});

test('isPlausibleBeforeImage() rejects a large prefix read', () => {
	const after = Array.from({ length: 239 }, (_, i) => `line ${i}`).join('\n') + '\n';
	const prefix = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n';
	assert.equal(isPlausibleBeforeImage(prefix, after), false);
});

test('isPlausibleBeforeImage() accepts a deleted file, which cannot be re-verified', () => {
	assert.equal(isPlausibleBeforeImage('anything\n', ''), true);
});

test('isPlausibleBeforeImage() rejects an empty before-image for an existing file', () => {
	assert.equal(isPlausibleBeforeImage('', 'a\nb\n'), false);
});

test('toolTitlePath() recognises the grep shape the agent actually uses', () => {
	// Verbatim titles from a real turn: the agent grep'd the file, never read it
	// whole, which is why the summary showed a filename with no counts.
	assert.deepEqual(toolTitlePath('grep min\\(1120px in styles.css'), {
		action: 'grep',
		path: 'styles.css',
	});
	assert.deepEqual(toolTitlePath('grep 1120px|1200px in styles.css'), {
		action: 'grep',
		path: 'styles.css',
	});
});

test('toolTitlePath() splits grep on the LAST " in " so a pattern may contain one', () => {
	assert.deepEqual(toolTitlePath('grep todo in . in src/app.ts'), {
		action: 'grep',
		path: 'src/app.ts',
	});
});

test('toolTitlePath() ignores a grep with no file target', () => {
	assert.equal(toolTitlePath('grep Footer'), undefined);
});
