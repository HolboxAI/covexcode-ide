/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { DiffHunk } from './acpClient';

/**
 * Pure file-change accounting for the chat-panel "Changed N files" summary.
 * Deliberately free of any `vscode` import, so it runs under `node --test`
 * without the extension host -- the same split `diffReview.ts` already uses.
 *
 * covexcode sends the per-hunk line split (`DiffHunk[]`) for every hunkable
 * text change; `hunks` is absent only when the change is not hunkable (CRLF
 * line endings, an oversized diff, or a pre-per-hunk-review runtime). The
 * counts here therefore prefer the hunks when present, and fall back to a
 * bounded line-level diff of `oldText`/`newText` otherwise -- never to an
 * estimate.
 */

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface FileDiffSummary {
	/** The path as reported by the agent (display path). */
	path: string;
	status: FileChangeStatus;
	/** Number of added lines (actual diff lines, 0 for binary). */
	added: number;
	/** Number of removed lines (actual diff lines, 0 for binary). */
	removed: number;
	/** Whether the content looks binary rather than text. */
	isBinary: boolean;
	/** Whether a textual diff actually changed anything (added+removed > 0). */
	hasTextualDiff: boolean;
}

export interface DiffPreviewOptions {
	/** The pre-change text; absent for a brand-new file. */
	oldText?: string;
	/** The post-change text; empty for a wholly deleted file. */
	newText: string;
	/** covexcode's pre-computed hunk split, when it is available. */
	hunks?: DiffHunk[];
	/** Optional previous path -- used to detect a rename. */
	oldPath?: string;
	/** Optional new path -- used to detect a rename. */
	newPath?: string;
}

const BINARY_SAMPLE_LENGTH = 8192;
const MAX_LCS_CELLS = 4_000_000;

/** The fields of a `session/list_changes` entry the turn filter needs. */
export interface JournalChangeLike {
	path: string;
	turn: number;
	touches: number;
	action: string;
}

/**
 * Picks the journal entries that changed during the turn that just finished.
 *
 * Filtering on `entry.turn === finishedTurn` looks right and is wrong: the
 * journal records the turn a file was FIRST touched in, not the latest one.
 * Verified against the bundled agent -- editing `design-tokens.css` in turn 1
 * and again in turn 2 leaves the entry at `{ turn: 1, touches: 2 }`, so a
 * turn-equality filter drops the file from turn 2's summary and the "Changed N
 * files" dropdown silently never appears again for that file. That is exactly
 * the "it showed once, then stopped" symptom.
 *
 * `touches` is the counter that actually advances per turn (1 -> 2 above), so a
 * file belongs to this turn when its count grew past the last snapshot. When
 * there is no snapshot for a path -- the first turn, or a session resumed with
 * journal entries this extension never saw -- the entry's own `turn` is the
 * only signal left, and it is reliable in exactly that case.
 *
 * `blocked` entries are never file changes (covexcode only ran a shell command
 * against them and kept no before-state), so they are always excluded.
 */
export function selectTurnChanges<T extends JournalChangeLike>(
	changes: readonly T[],
	previousTouches: ReadonlyMap<string, number>,
	turn: number,
): T[] {
	return changes.filter(change => {
		if (change.action === 'blocked') {
			return false;
		}
		const previous = previousTouches.get(change.path);
		if (previous === undefined) {
			return change.turn === turn;
		}
		return change.touches > previous;
	});
}

/**
 * Records the current per-path `touches` counts into `into`, for the next turn
 * to compare against. Written as a fill rather than a returned Map so callers
 * never have to iterate a Map themselves -- this extension still compiles
 * against an ES5 target, where Map iteration is not allowed.
 */
export function snapshotTouches(
	changes: readonly JournalChangeLike[],
	into: Map<string, number>,
): void {
	for (const change of changes) {
		into.set(change.path, change.touches);
	}
}

/**
 * Whether `beforeText` can be trusted as the whole-file pre-image of
 * `afterText`.
 *
 * The before-image on this path comes from the turn's own `read` result, and
 * models routinely read only part of a file. A partial read is indistinguishable
 * from a complete one by size alone, and feeding it in as if it were the whole
 * file produces wildly wrong counts -- observed in a real end-to-end run, where
 * a one-line change to a 239-line file (60 lines of which had been read) was
 * reported as "+239 -60" instead of "+1 -1".
 *
 * A genuine pre-image of an ordinary edit is ~the same file, so the two texts
 * must be nearly identical (BEFORE_IMAGE_MIN_COMMON_RATIO of the longer one)
 * before their difference is worth showing. Anything less is reported as
 * filename-only by the caller rather than with invented numbers; the counts
 * stay exact for the case this path exists to serve (a small edit made without
 * an approval prompt) and refuse to guess for a rewrite.
 *
 * A deleted file is accepted unconditionally: it is gone, so no read can be
 * re-verified against it, and refusing would hide the change entirely.
 */
export function isPlausibleBeforeImage(beforeText: string, afterText: string): boolean {
	const afterLines = splitDiffLines(afterText).length;
	if (afterLines === 0) {
		return true;
	}
	const beforeLines = splitDiffLines(beforeText).length;
	if (beforeLines === 0) {
		return false;
	}
	// countLineDiff is LCS-based, so `common` is the real number of unchanged
	// lines -- and it reports whole-file counts when the input is too large to
	// refine, which yields common === 0 and is rejected here as intended.
	const { added, removed } = countLineDiff(beforeText, afterText);
	const common = afterLines - added;
	const unchanged = beforeLines - removed;
	if (common !== unchanged) {
		return false;
	}
	const longer = Math.max(beforeLines, afterLines);
	return common / longer >= BEFORE_IMAGE_MIN_COMMON_RATIO;
}

const BEFORE_IMAGE_MIN_COMMON_RATIO = 0.9;

/** Tool actions that write to the file, so their arrival means it is too late to read the before-image. */
export const MUTATING_TOOL_ACTIONS: ReadonlySet<string> = new Set([
	'edit', 'write', 'create', 'delete', 'apply_patch', 'str_replace',
]);

/** Tool actions that only inspect a file, so it is still untouched when they run. */
export const READING_TOOL_ACTIONS: ReadonlySet<string> = new Set(['read', 'view', 'cat']);

/**
 * A tool-call title split into the action and the path it acted on, e.g.
 * `read src/styles.css` -> `{ action: 'read', path: 'src/styles.css' }`.
 *
 * covexcode's tool titles are this agent build's only client-visible record of
 * *which* file a call touched -- `tool_call_update` carries no path field of
 * its own -- so the turn's read/mutation history is reconstructed from them.
 * Returns `undefined` for any title that doesn't name a file (a shell command,
 * a search), so a caller can never mistake one for a file operation.
 *
 * `grep`/`search` take a different shape (`grep <pattern> in <path>`) and are
 * recognised because the agent very often inspects a file that way instead of
 * reading it whole. Missing that case is what made the changed-files summary
 * show a filename with no line counts at all: the agent grepped, never read,
 * and the only before-image source was a `read` result.
 */
export function toolTitlePath(title: string): { action: string; path: string } | undefined {
	const match = /^([a-z_]+)\s+(\S.*)$/i.exec(title.trim());
	if (!match) {
		return undefined;
	}
	const action = match[1].toLowerCase();
	const rest = match[2].trim();
	if (MUTATING_TOOL_ACTIONS.has(action) || READING_TOOL_ACTIONS.has(action)) {
		return { action, path: rest };
	}
	if (action === 'grep' || action === 'search') {
		// `lastIndexOf` because the pattern itself can contain " in ".
		const marker = rest.lastIndexOf(' in ');
		if (marker < 0) {
			return undefined;
		}
		const path = rest.slice(marker + 4).trim();
		return path ? { action, path } : undefined;
	}
	return undefined;
}

/**
 * Tracks what each file looked like *before* this turn first mutated it, using
 * the turn's own streamed tool results.
 *
 * This exists because covexcode puts a file's before/after text on the wire
 * only inside `session/request_permission`; when an edit is applied without
 * stopping for approval (the default `auto` permission mode) no such text is
 * ever sent, and the journal behind `session/list_changes` keeps the
 * before-image to itself. A `read` tool result *does* carry the file's text,
 * and covexcode's `edit` requires an exact match, so the model reads before it
 * writes -- which makes the last read taken before the first mutation a real
 * before-image, not a guess.
 *
 * Freezing on the first mutation is what makes it correct: a read that happens
 * *after* the edit (models often re-read to verify) must not overwrite the
 * pre-edit text.
 */
export class TurnFileObserver {
	private readonly reads = new Map<string, string>();
	private readonly frozen = new Set<string>();

	/** Records the text a `read` tool result returned for `path`. */
	noteRead(path: string, text: string): void {
		// Keep the FIRST pre-mutation snapshot: an earlier one is closer to the
		// file's real state at turn start, and a later read is only useful if
		// nothing was recorded before it.
		if (!this.frozen.has(path) && !this.reads.has(path)) {
			this.reads.set(path, text);
		}
	}

	/** Whether a pre-mutation snapshot already exists for `path`. */
	hasBefore(path: string): boolean {
		return this.reads.has(path);
	}

	/** Whether `path` has already been mutated this turn. */
	isFrozen(path: string): boolean {
		return this.frozen.has(path);
	}

	/** Marks `path` as mutated this turn, freezing its before-image. */
	noteMutation(path: string): void {
		this.frozen.add(path);
	}

	/** The pre-mutation text seen for `path`, or `undefined` if never read first. */
	beforeFor(path: string): string | undefined {
		return this.reads.get(path);
	}
}

/**
 * Splits text the way covexcode's own `str::lines()` does (split on `\n`,
 * drop the trailing empty string a final newline leaves behind, empty input
 * is zero lines). Shared shape with `diffReview.ts`'s private `splitLines`;
 * kept local so this module stays self-contained.
 */
export function splitDiffLines(text: string): string[] {
	if (text === '') {
		return [];
	}
	const lines = text.split('\n');
	if (lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/**
 * Cheap, conservative binary sniff: a NUL byte is conclusive; otherwise a
 * sample with more than 1% control characters (excluding whitespace controls)
 * is treated as binary. The full file is never scanned, so a large text file
 * cannot turn this into a hot path.
 */
export function isBinaryText(text: string): boolean {
	if (text.indexOf('\0') >= 0) {
		return true;
	}
	const sample = text.slice(0, BINARY_SAMPLE_LENGTH);
	if (sample === '') {
		return false;
	}
	let control = 0;
	for (let i = 0; i < sample.length; i++) {
		const code = sample.charCodeAt(i);
		if (
			(code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) ||
			code === 127 ||
			(code >= 0xfffe && code <= 0xffff)
		) {
			control++;
		}
	}
	return control / sample.length > 0.01;
}

/**
 * The actual added/removed line tally from covexcode's hunks -- the same
 * accounting `diffReview.ts`'s `summarizeHunk` uses per hunk, aggregated
 * across every hunk of the file.
 */
export function countHunkChanges(hunks: readonly DiffHunk[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			if (line.change === 'added') {
				added++;
			} else if (line.change === 'removed') {
				removed++;
			}
		}
	}
	return { added, removed };
}

/**
 * Length of the longest common subsequence over two line arrays, computed
 * with a rolling row to keep memory to O(min(m,n)). This is only the *count*
 * fallback for hunk-less diffs; the diff editor re-diffs the actual text, so
 * the sequence itself is never needed here.
 */
function lcsLength(a: string[], b: string[]): number {
	const columns = b.length + 1;
	let previous = new Array<number>(columns).fill(0);
	for (let i = 1; i <= a.length; i++) {
		const current = new Array<number>(columns).fill(0);
		const ai = a[i - 1];
		for (let j = 1; j <= b.length; j++) {
			current[j] = ai === b[j - 1]
				? previous[j - 1] + 1
				: Math.max(previous[j], current[j - 1]);
		}
		previous = current;
	}
	return previous[b.length];
}

/**
 * Added/removed line counts computed from the two full texts, for the case
 * where covexcode did not send hunks. Bounded: past `MAX_LCS_CELLS` cells it
 * reports the whole-file change instead of running an O(n*m) algorithm on a
 * pathological input (the hunks-absent path is already rare and usually an
 * oversized diff). This is a real diff, not an estimate -- the whole-file
 * bound is simply the honest answer when the input is too large to refine.
 */
export function countLineDiff(oldText: string, newText: string): { added: number; removed: number } {
	const oldLines = splitDiffLines(oldText);
	const newLines = splitDiffLines(newText);
	if (oldLines.length === 0) {
		return { added: newLines.length, removed: 0 };
	}
	if (newLines.length === 0) {
		return { added: 0, removed: oldLines.length };
	}
	if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
		return { added: newLines.length, removed: oldLines.length };
	}
	const common = lcsLength(oldLines, newLines);
	return { added: newLines.length - common, removed: oldLines.length - common };
}

/**
 * Detects the file status and computes actual added/removed line counts for
 * one agent-reported file change. Prefers `hunks`; falls back to a bounded
 * line diff of `oldText`/`newText`. Binary content is flagged so the caller
 * can show a message instead of a text diff.
 */
export function computeFileDiffSummary(opts: DiffPreviewOptions): FileDiffSummary {
	const path = opts.newPath ?? opts.oldPath ?? '';
	const oldText = opts.oldText;
	// Diffs arrive as protocol data, so a missing field is possible even
	// though the type says otherwise. Treat it as "no content" instead of
	// throwing and taking the whole chat response down with it.
	const newText = opts.newText ?? '';

	let status: FileChangeStatus;
	if (opts.oldPath !== undefined && opts.newPath !== undefined && opts.oldPath !== opts.newPath) {
		status = 'renamed';
	} else if (oldText === undefined) {
		status = 'added';
	} else if (newText === '') {
		status = 'deleted';
	} else {
		status = 'modified';
	}

	const binary = (oldText !== undefined && isBinaryText(oldText)) || isBinaryText(newText);
	if (binary) {
		return { path, status, added: 0, removed: 0, isBinary: true, hasTextualDiff: false };
	}

	if (opts.hunks && opts.hunks.length > 0) {
		const { added, removed } = countHunkChanges(opts.hunks);
		return { path, status, added, removed, isBinary: false, hasTextualDiff: added + removed > 0 };
	}

	const { added, removed } = countLineDiff(oldText ?? '', newText);
	return { path, status, added, removed, isBinary: false, hasTextualDiff: added + removed > 0 };
}
