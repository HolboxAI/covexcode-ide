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

/**
 * True when both sides of a change are present and byte-for-byte identical.
 *
 * This is the strictest form of the change-driven gate: a file whose original
 * and final text are equal has not changed, no matter how much activity the
 * agent performed against it (reads, inspections, a write that landed on the
 * same bytes). It must be checked before any line-level diff, because a line
 * diff reports "no added/removed lines" for a trailing-newline-only change too,
 * while raw equality catches every no-op including a binary file written back
 * unchanged.
 */
export function isByteIdentical(oldText: string | undefined, newText: string): boolean {
	return oldText !== undefined && oldText === newText;
}

/**
 * How one journaled touch should be rendered, given the best before-image
 * available for it.
 *
 * `skip` means the file did not actually change and must not get a row at all --
 * the distinction the summary lives or dies on. `allAdded` is the honest
 * rendering of a file that did not exist before this touch, `diff` carries a
 * real pre-image, and `listOnly` is the fallback for a change that is known to
 * have happened but whose before-state cannot be reconstructed.
 */
export type JournalDiffDecision =
	| { kind: 'skip' }
	| { kind: 'diff'; oldText: string }
	| { kind: 'allAdded' }
	| { kind: 'listOnly' };

/**
 * Decides how a journal-only entry (a file covexcode changed without sending
 * before/after text) should be rendered.
 *
 * The case this exists for, verified end to end: a file created earlier in the
 * session is journaled with `action: 'delete'` -- "did not exist before the
 * session" -- for the rest of the session's life, and that action used to be
 * read as "every line is new". Any later turn that merely wrote such a file
 * again therefore reported it as `+<all lines> -0` even when the content came
 * back byte-for-byte identical, so an untouched file reappeared in the
 * changed-files dropdown on every turn that touched it. `candidate` is what
 * distinguishes the two situations: absent means this touch really did create
 * the file, present means the file already had content that its new text must
 * be compared against before anything is reported.
 *
 * `createdInSession` is `action === 'delete'`. An empty file is skipped only
 * there: "created, then left empty" has nothing to show, while "existing file
 * emptied" is a real change and keeps its all-removed diff.
 *
 * No similarity threshold is applied to `candidate` any more, and that is
 * deliberate. `isPlausibleBeforeImage` exists to reject a *partial read* used as
 * a before-image, but neither source that feeds this function is a partial read:
 * `TurnFileObserver` reads the file from disk at inspection time and
 * `lastKnown` is this module's own read of the whole file. Applying the ratio to
 * whole files rejects the ordinary case instead -- one changed line in a
 * three-line file is 67% similar, so every small edit degraded to a no-counts
 * row -- while admitting nothing a fragment could not get past anyway.
 */
export function decideJournalDiff(
	candidate: string | undefined,
	newText: string,
	createdInSession: boolean,
): JournalDiffDecision {
	if (candidate !== undefined && candidate === newText) {
		return { kind: 'skip' };
	}
	if (createdInSession && newText === '') {
		return { kind: 'skip' };
	}
	if (candidate !== undefined) {
		return { kind: 'diff', oldText: candidate };
	}
	// A file that did not exist before the session with no before-image at all:
	// every line really is new. Anything else has a change the client cannot
	// reconstruct, so it is listed by name rather than given invented counts.
	return createdInSession ? { kind: 'allAdded' } : { kind: 'listOnly' };
}

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
 * The content each file held *before the current task first modified it*.
 *
 * The inline indicator's `+N/-N` is always `baseline -> latest content`, so a
 * file edited three times in one task keeps reporting the task's whole effect on
 * it instead of only the last edit. That is why this is session-scoped and
 * first-capture-wins: the earliest before-image seen for a path is the only one
 * that answers "what has this task done to this file?".
 *
 * A file the agent created during the session has an empty baseline (`''`), so
 * every line of it counts as added -- the honest answer for a file that did not
 * exist when the task started. `undefined` means no baseline could be
 * reconstructed at all (the caller falls back to a filename-only row rather than
 * inventing counts).
 */
export class ChangeBaselines {
	private readonly texts = new Map<string, string>();

	/** Records `text` as `path`'s task-start content. The first call wins. */
	capture(path: string, text: string): void {
		if (!this.texts.has(path)) {
			this.texts.set(path, text);
		}
	}

	/**
	 * The task-start text for `path`. `''` is a real answer (the file did not
	 * exist); `undefined` means nothing was ever captured for it.
	 */
	textFor(path: string): string | undefined {
		return this.texts.get(path);
	}

	clear(): void {
		this.texts.clear();
	}
}

/** One file the agent genuinely changed, as the inline indicator tracks it. */
export interface TrackedChange {
	/** The path as the agent reported it (display path). */
	path: string;
	/** Task-start text: `''` for a file this task created, `undefined` when unknown. */
	oldText?: string;
	/** Latest content. */
	newText: string;
	/** covexcode's own hunk split, when it covers this same before/after pair. */
	hunks?: DiffHunk[];
	/** A confirmed change whose before-image could not be reconstructed. */
	listOnly?: boolean;
	/** Monotonic stamp -- the highest value is the most recent modification. */
	order: number;
}

/**
 * The state behind the inline, single-file change indicator.
 *
 * The indicator shows exactly ONE file: the most recent genuine modification.
 * This holds that state and nothing like a list of it -- a second file's
 * modification REPLACES the first, and returning to an earlier file replaces the
 * current one again. Re-recording a path updates its single entry in place and
 * re-stamps it as latest, so no duplicate row can ever exist for one file.
 *
 * `order` is what makes "most recent" decidable without trusting the order the
 * caller happens to enumerate in: every record gets a strictly increasing stamp
 * at the moment the modification is detected, and `byRecency` walks them
 * newest-first. Reads, inspections, mentions and plans never get here at all --
 * only a completed diff, an accepted permission-reviewed edit, or a journaled
 * touch does.
 */
export class TurnChanges {
	private readonly records = new Map<string, TrackedChange>();
	private sequence = 0;

	constructor(private readonly baselines: ChangeBaselines) {}

	/**
	 * Records that `path` now holds `change.newText`, stamped as the latest
	 * modification.
	 *
	 * `oldText` is the before-image observed for *this* modification; it doubles
	 * as the task-start baseline only the first time a path is recorded (see
	 * ChangeBaselines.capture). `created` says the file did not exist before this
	 * write, which is the one case where an absent `oldText` still yields a real
	 * baseline.
	 */
	record(change: {
		path: string;
		oldText?: string;
		newText: string;
		hunks?: DiffHunk[];
		listOnly?: boolean;
		created?: boolean;
	}): void {
		if (change.created) {
			this.baselines.capture(change.path, '');
		}
		if (change.oldText !== undefined) {
			this.baselines.capture(change.path, change.oldText);
		}
		this.records.set(change.path, {
			path: change.path,
			oldText: change.oldText,
			newText: change.newText,
			hunks: change.hunks,
			listOnly: change.listOnly,
			order: ++this.sequence,
		});
	}

	/** Drops `path` entirely -- the turn's touch put back the bytes it found. */
	remove(path: string): void {
		this.records.delete(path);
	}

	/** Whether `path` already has a record for this turn. */
	has(path: string): boolean {
		return this.records.has(path);
	}

	/** How many files this turn genuinely recorded (never shown as a list). */
	get size(): number {
		return this.records.size;
	}

	/** The task-start text captured for `path`, if any. */
	baselineFor(path: string): string | undefined {
		return this.baselines.textFor(path);
	}

	/** Records `text` as `path`'s task-start content (first capture wins). */
	captureBaseline(path: string, text: string): void {
		this.baselines.capture(path, text);
	}

	/**
	 * Every recorded change, most recently modified first, with each record's
	 * before-image resolved to the task-start baseline so the counts describe the
	 * whole task rather than one edit.
	 *
	 * Hunk splits stay attached only while they describe that same pair. A hunk
	 * split covers one edit; once the baseline is older than that edit's own
	 * before-image, the counts are recomputed from the text instead of counting
	 * one edit while the row claims to describe the task.
	 */
	byRecency(): TrackedChange[] {
		const recorded: TrackedChange[] = [];
		this.records.forEach(record => recorded.push(record));
		recorded.sort((a, b) => b.order - a.order);

		const resolved: TrackedChange[] = [];
		for (const record of recorded) {
			const baseline = this.baselines.textFor(record.path);
			if (baseline === undefined) {
				resolved.push(record);
				continue;
			}
			const hunks = (record.oldText ?? '') === baseline ? record.hunks : undefined;
			resolved.push({
				path: record.path,
				oldText: baseline,
				newText: record.newText,
				hunks,
				listOnly: record.listOnly,
				order: record.order,
			});
		}
		return resolved;
	}
}

/**
 * What the inline indicator should show right now.
 *
 * One of these per turn at most -- there is deliberately no variant that
 * carries several files, because the whole point of the indicator is that a new
 * modification replaces the previous one.
 */
export type IndicatorChange =
	| { kind: 'none' }
	| { kind: 'listOnly'; path: string }
	| { kind: 'binary'; path: string }
	| { kind: 'diff'; path: string; oldText: string; newText: string; summary: FileDiffSummary };

/**
 * Picks the single modification the indicator should render, or `none`.
 *
 * Walks the turn's records newest-first and returns the first one that is a
 * genuine change; everything older is dropped, never accumulated. A record that
 * is a no-op against its task-start content (the same bytes, a reverted edit, a
 * write that changed nothing) is passed over rather than rendered as `+0 -0`,
 * so an agent that rewrites the bytes it found does not blank out the real edit
 * it made just before.
 *
 * The three fallbacks keep the counts honest:
 * - `listOnly` -- a confirmed change whose before-image is unrecoverable. Name
 *   the file; never invent a diff for it.
 * - `binary` -- a real change that no line-level diff can describe.
 * - `none` -- nothing was modified. The indicator must not appear at all.
 */
export function selectIndicatorChange(changes: TurnChanges): IndicatorChange {
	for (const change of changes.byRecency()) {
		if (change.listOnly) {
			return { kind: 'listOnly', path: change.path };
		}
		// Task-start text and current text identical means the file was not
		// modified, no matter how much inspecting or same-bytes writing happened.
		if (isByteIdentical(change.oldText, change.newText)) {
			continue;
		}
		const summary = computeFileDiffSummary({
			oldText: change.oldText,
			newText: change.newText,
			hunks: change.hunks,
		});
		if (summary.isBinary) {
			return { kind: 'binary', path: change.path };
		}
		// A textual change with no added/removed lines (an empty new file, an
		// empty deletion, a trailing-newline-only difference) would render as
		// noise, so it is not a change the indicator should announce.
		if (!summary.hasTextualDiff) {
			continue;
		}
		return {
			kind: 'diff',
			path: change.path,
			oldText: change.oldText ?? '',
			newText: change.newText,
			summary,
		};
	}
	return { kind: 'none' };
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
