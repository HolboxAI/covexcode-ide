/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	ChangeBaselines,
	computeFileDiffSummary,
	countHunkChanges,
	countLineDiff,
	decideJournalDiff,
	isBinaryText,
	isByteIdentical,
	isPlausibleBeforeImage,
	selectIndicatorChange,
	selectTurnChanges,
	snapshotTouches,
	splitDiffLines,
	toolTitlePath,
	TurnChanges,
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

test('isByteIdentical() is true only when both sides are present and equal', () => {
	assert.equal(isByteIdentical('a\n', 'a\n'), true);
	assert.equal(isByteIdentical('a\n', 'a'), false);
	assert.equal(isByteIdentical(undefined, ''), false);
	assert.equal(isByteIdentical(undefined, 'x\n'), false);
});

test('an empty new file has no textual diff and must be excluded', () => {
	const summary = computeFileDiffSummary({ oldText: undefined, newText: '' });
	assert.equal(summary.status, 'added');
	assert.equal(summary.hasTextualDiff, false);
	assert.equal(summary.isBinary, false);
});

test('an empty deleted file has no textual diff and must be excluded', () => {
	const summary = computeFileDiffSummary({ oldText: '', newText: '' });
	assert.equal(summary.hasTextualDiff, false);
	assert.equal(summary.isBinary, false);
});

test('isPlausibleBeforeImage() accepts a before-image byte-identical to the after', () => {
	assert.equal(isPlausibleBeforeImage('same\n', 'same\n'), true);
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

// ---------------------------------------------------------------------------
// decideJournalDiff: the gate that keeps an unchanged file out of the summary.
// The regression it exists for was observed in a real two-turn session against
// the bundled agent: turn 1 created index.html + styles.css, turn 2 changed one
// line of styles.css, and styles.css was reported as "+3 -0" because the
// journal's `delete` action ("did not exist before the SESSION") was read as
// "did not exist before this touch".
// ---------------------------------------------------------------------------

test('decideJournalDiff() skips a file written back with identical bytes', () => {
	const css = 'h1 {\n  color: #333333;\n}\n';
	assert.deepEqual(decideJournalDiff(css, css, true), { kind: 'skip' });
});

test('decideJournalDiff() diffs a file created in an EARLIER turn against its real pre-image', () => {
	const before = 'h1 {\n  color: #333333;\n}\n';
	const after = 'h1 {\n  color: #cc0000;\n}\n';
	assert.deepEqual(decideJournalDiff(before, after, true), { kind: 'diff', oldText: before });
});

test('decideJournalDiff() reports a brand-new file as all-added when there is no pre-image', () => {
	assert.deepEqual(decideJournalDiff(undefined, '<h1>Hello</h1>\n', true), { kind: 'allAdded' });
});

test('decideJournalDiff() drops a file that was created and left empty', () => {
	assert.deepEqual(decideJournalDiff(undefined, '', true), { kind: 'skip' });
});

test('decideJournalDiff() keeps an all-removed diff for an existing file emptied in place', () => {
	// Not `delete` action: the file existed before the session, so emptying it is
	// a real change and must not be swallowed by the created-and-empty rule.
	assert.deepEqual(decideJournalDiff('a\nb\n', '', false), { kind: 'diff', oldText: 'a\nb\n' });
});

test('decideJournalDiff() falls back to a filename row only when there is no before-image', () => {
	assert.deepEqual(decideJournalDiff(undefined, 'a\nb\n', false), { kind: 'listOnly' });
});

test('decideJournalDiff() still gives real counts for a whole-file rewrite', () => {
	// A rewrite is a diff like any other: refusing it would report a file the
	// user definitely changed as a bare filename with no line counts.
	assert.deepEqual(decideJournalDiff('a\n', 'x\ny\nz\n', true), { kind: 'diff', oldText: 'a\n' });
});

test('decideJournalDiff() counts a one-line change in a short file', () => {
	// The regression the similarity threshold caused: 2 of 3 lines in common is
	// 67%, so a 90%-identical rule degraded every small edit to a bare filename.
	const before = 'h1 {\n  color: #333333;\n}\n';
	const after = 'h1 {\n  color: #cc0000;\n}\n';
	const decision = decideJournalDiff(before, after, true);
	assert.equal(decision.kind, 'diff');
	const summary = computeFileDiffSummary({ oldText: before, newText: after });
	assert.equal(summary.added, 1);
	assert.equal(summary.removed, 1);
});

// ---------------------------------------------------------- inline indicator
//
// The indicator shows exactly ONE file: the most recently modified one. These
// tests drive the whole QA sequence from the feature request -- HTML appears,
// CSS replaces it, JavaScript replaces that, HTML comes back with updated
// counts, an unmodified file never appears -- against the pure state model.

function newChanges(): TurnChanges {
	return new TurnChanges(new ChangeBaselines());
}

test('selectIndicatorChange() shows nothing before any modification', () => {
	assert.deepEqual(selectIndicatorChange(newChanges()), { kind: 'none' });
});

test('selectIndicatorChange() replaces the row when a different file is modified', () => {
	const changes = newChanges();
	changes.record({ path: 'index.html', newText: 'a\nb\n', created: true });
	const first = selectIndicatorChange(changes);
	assert.equal(first.kind, 'diff');
	assert.equal(first.kind === 'diff' && first.path, 'index.html');

	changes.record({ path: 'style.css', newText: 'body { color: red; }\n', created: true });
	const second = selectIndicatorChange(changes);
	assert.equal(second.kind, 'diff');
	assert.equal(second.kind === 'diff' && second.path, 'style.css');

	changes.record({ path: 'script.js', newText: 'console.log(1);\n', created: true });
	const third = selectIndicatorChange(changes);
	assert.equal(third.kind === 'diff' && third.path, 'script.js');
});

test('selectIndicatorChange() brings an earlier file back to the front when it is modified again', () => {
	const changes = newChanges();
	changes.record({ path: 'index.html', newText: 'a\n', created: true });
	changes.record({ path: 'style.css', newText: 'b\n', created: true });
	changes.record({ path: 'index.html', newText: 'a\nb\n', created: true });
	const change = selectIndicatorChange(changes);
	assert.equal(change.kind === 'diff' && change.path, 'index.html');
	// And it repeats the counts for the whole task, not only the last write.
	assert.equal(change.kind === 'diff' && change.summary.added, 2);
});

test('TurnChanges keeps one entry per path, however many times it is modified', () => {
	const changes = newChanges();
	changes.record({ path: 'index.html', newText: 'one\n', created: true });
	changes.record({ path: 'index.html', newText: 'one\ntwo\n' });
	changes.record({ path: 'index.html', newText: 'one\ntwo\nthree\n' });
	assert.equal(changes.size, 1);
	assert.equal(changes.byRecency().length, 1);
	const only = selectIndicatorChange(changes);
	assert.equal(only.kind === 'diff' && only.path, 'index.html');
});

test('selectIndicatorChange() measures counts from the task-start content', () => {
	const changes = newChanges();
	const original = 'a\nb\nc\n';
	// First edit: b -> B.
	changes.record({ path: 'index.html', oldText: original, newText: 'a\nB\nc\n' });
	let change = selectIndicatorChange(changes);
	assert.equal(change.kind === 'diff' && change.summary.added, 1);
	assert.equal(change.kind === 'diff' && change.summary.removed, 1);

	// Second edit to the same file: append d. Still one row, and the counts now
	// describe the whole task (b->B plus the new line), not just the last edit.
	changes.record({ path: 'index.html', oldText: 'a\nB\nc\n', newText: 'a\nB\nc\nd\n' });
	assert.equal(changes.size, 1);
	change = selectIndicatorChange(changes);
	assert.equal(change.kind === 'diff' && change.oldText, original);
	assert.equal(change.kind === 'diff' && change.summary.added, 2);
	assert.equal(change.kind === 'diff' && change.summary.removed, 1);
});

test('selectIndicatorChange() ignores a file that was only inspected', () => {
	const changes = newChanges();
	changes.captureBaseline('notes.md', 'unchanged\n');
	// Nothing is recorded for it -- an inspection is not a modification.
	assert.deepEqual(selectIndicatorChange(changes), { kind: 'none' });
});

test('selectIndicatorChange() falls back to an earlier real change when the latest write was a no-op', () => {
	const changes = newChanges();
	changes.record({ path: 'index.html', oldText: 'a\n', newText: 'a\nb\n' });
	// The agent re-writes the bytes it found: a touch, not a modification.
	changes.record({ path: 'index.html', oldText: 'a\nb\n', newText: 'a\nb\n' });
	const change = selectIndicatorChange(changes);
	assert.equal(change.kind === 'diff' && change.path, 'index.html');
	assert.equal(change.kind === 'diff' && change.summary.added, 1);

	// A same-bytes write to a file the task created is equally silent.
	const created = newChanges();
	created.record({ path: 'index.html', newText: 'a\n', created: true });
	created.record({ path: 'index.html', newText: 'a\n' });
	assert.equal(selectIndicatorChange(created).kind === 'diff', true);
});

test('selectIndicatorChange() shows nothing when the only change reverted itself', () => {
	const changes = newChanges();
	changes.record({ path: 'index.html', oldText: 'a\nb\n', newText: 'a\nB\n' });
	changes.record({ path: 'index.html', oldText: 'a\nB\n', newText: 'a\nb\n' });
	assert.deepEqual(selectIndicatorChange(changes), { kind: 'none' });
});

test('selectIndicatorChange() keeps the filename-only fallback when no before-image exists', () => {
	const changes = newChanges();
	changes.record({ path: 'mystery.bin.js', newText: 'x\n', listOnly: true });
	assert.deepEqual(selectIndicatorChange(changes), { kind: 'listOnly', path: 'mystery.bin.js' });
});

test('selectIndicatorChange() reports a binary change by name instead of counting lines', () => {
	const changes = newChanges();
	changes.record({ path: 'logo.png', oldText: 'PNG\0old\n', newText: 'PNG\0new\n' });
	assert.deepEqual(selectIndicatorChange(changes), { kind: 'binary', path: 'logo.png' });
});

test('selectIndicatorChange() drops a record the journal proves did not change', () => {
	const changes = newChanges();
	changes.record({ path: 'index.html', newText: 'a\n', created: true });
	changes.record({ path: 'style.css', newText: 'b\n', created: true });
	changes.remove('style.css');
	const change = selectIndicatorChange(changes);
	assert.equal(change.kind === 'diff' && change.path, 'index.html');
});

test('a branch-new file counts every line as added, from an empty baseline', () => {
	const changes = newChanges();
	changes.record({ path: 'index.html', newText: 'a\nb\nc\n', created: true });
	const change = selectIndicatorChange(changes);
	assert.equal(change.kind === 'diff' && change.oldText, '');
	assert.equal(change.kind === 'diff' && change.summary.added, 3);
	assert.equal(change.kind === 'diff' && change.summary.removed, 0);
});

test('a deletion counts every task-added line as removed', () => {
	const changes = newChanges();
	changes.record({ path: 'index.html', oldText: 'a\nb\n', newText: '', hunks: undefined });
	const change = selectIndicatorChange(changes);
	assert.equal(change.kind === 'diff' && change.summary.removed, 2);
	assert.equal(change.kind === 'diff' && change.summary.added, 0);
});

test('ChangeBaselines keeps the first capture, and a created file starts empty', () => {
	const baselines = new ChangeBaselines();
	assert.equal(baselines.textFor('a.js'), undefined);
	baselines.capture('a.js', 'first\n');
	baselines.capture('a.js', 'second\n');
	assert.equal(baselines.textFor('a.js'), 'first\n');
	baselines.capture('b.js', '');
	assert.equal(baselines.textFor('b.js'), '');
	baselines.clear();
	assert.equal(baselines.textFor('a.js'), undefined);
});

test('TurnChanges re-stamps a file as latest without duplicating it', () => {
	const changes = newChanges();
	changes.record({ path: 'a.js', newText: '1\n', created: true });
	changes.record({ path: 'b.js', newText: '1\n', created: true });
	assert.equal(changes.byRecency()[0].path, 'b.js');
	changes.record({ path: 'a.js', newText: '1\n2\n' });
	const recency = changes.byRecency();
	assert.equal(recency.length, 2);
	assert.equal(recency[0].path, 'a.js');
	assert.equal(recency[1].path, 'b.js');
});

test('TurnChanges reports hunk counts only while they match the baseline pair', () => {
	const changes = newChanges();
	changes.record({
		path: 'a.ts',
		oldText: 'a\nb\n',
		newText: 'a\nB\n',
		hunks: [mkHunk(1, 1, [['context', 'a'], ['removed', 'b'], ['added', 'B']])],
	});
	const first = selectIndicatorChange(changes);
	assert.equal(first.kind === 'diff' && first.summary.added, 1);

	// A later edit means the wire hunks describe only that edit, so they must not
	// be reused for a row that now covers the whole task.
	changes.record({ path: 'a.ts', oldText: 'a\nB\n', newText: 'a\nB\nc\n' });
	const latest = changes.byRecency()[0];
	assert.equal(latest.hunks, undefined);
	assert.equal(latest.oldText, 'a\nb\n');
});
