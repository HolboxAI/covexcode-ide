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
	const newText = opts.newText;

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
