/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { DiffHunk } from './acpClient';

/**
 * Per-hunk accept/reject: turning a pre-computed hunk split plus a list of
 * "keep this hunk" decisions back into the single file text boxcode should
 * write. Deliberately free of any `vscode` import -- the merge and the label
 * helpers are pure string transforms, so they test under `node --test`
 * without the extension host. The only piece that needs VS Code itself is
 * the QuickPick in `pickHunks` (extension.ts), which calls straight into
 * `applyHunkSelection`.
 */

/**
 * Splits a file's text the way boxcode's own `str::lines()` does, so the
 * reconstruction's line indices line up with the `oldNo`/`newNo` boxcode
 * stamped on every hunk line: split on `\n`, drop the trailing empty string
 * a final newline leaves behind, and treat empty input as zero lines.
 */
function splitLines(text: string): string[] {
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
 * The new-file text with `accepted[i]` applied for every hunk `hunks[i]`.
 *
 * Reconstructs from the full `newText` (the "accept everything" outcome) by
 * walking the hunks in order and swapping each rejected hunk's new-side
 * lines (context + additions, the lines carrying a `newNo`) for its old-side
 * lines (context + removals, the lines carrying an `oldNo`). The hunks
 * already carry both sides, so the original `oldText` is not needed: the
 * removed lines a rejected hunk reverts to are right there on the hunk.
 *
 * Hunks are non-overlapping and sorted, so each one covers a contiguous run
 * of new-file line numbers; the unchanged text between two hunks is read
 * straight out of `newText` (identical to `oldText` there). A hunk with no
 * new-side lines -- only possible when the whole file is being deleted, so
 * there is no context left to anchor it -- sits at whatever line the walk
 * has reached, which for an empty `newText` is position zero.
 */
export function applyHunkSelection(newText: string, hunks: DiffHunk[], accepted: boolean[]): string {
	const newLines = splitLines(newText);
	const result: string[] = [];
	let cursor = 0; // index into `newLines` of the first line not yet emitted

	for (let i = 0; i < hunks.length; i++) {
		const hunk = hunks[i];
		const newSide = hunk.lines.filter(line => line.newNo !== undefined);
		const oldSide = hunk.lines.filter(line => line.oldNo !== undefined).map(line => line.text);

		// First new-side line's number, 0-based. A zero-width hunk (pure
		// removal with no context) starts wherever the walk currently is.
		let start = cursor;
		if (newSide.length > 0) {
			start = newSide[0].newNo! - 1;
			if (start < cursor) {
				start = cursor;
			}
		}

		for (let j = cursor; j < start; j++) {
			result.push(newLines[j]);
		}

		if (accepted[i]) {
			for (const line of newSide) {
				result.push(line.text);
			}
		} else {
			result.push(...oldSide);
		}

		cursor = newSide.length > 0 ? newSide[newSide.length - 1].newNo! : start;
	}

	for (let j = cursor; j < newLines.length; j++) {
		result.push(newLines[j]);
	}
	// Nothing reconstructed means the merge resolved to "no file content":
	// either a whole-file deletion was accepted, or a brand-new file's hunks
	// were all rejected. Either way the answer is empty text, not a stray
	// newline. Otherwise `splitLines` dropped the single trailing empty line
	// a final newline leaves behind, so put it back -- writing a merged file
	// without its final newline would silently mangle almost every file
	// reviewed. Assumes the change does not itself add or remove the file's
	// final newline; such an edit is rare and, when it happens, a rejected
	// hunk keeps the new-side newline rather than the old-side one.
	if (result.length === 0) {
		return '';
	}
	return result.join('\n') + (newText.endsWith('\n') ? '\n' : '');
}

/**
 * One hunk summarized for a QuickPick row -- "2 additions, 1 removal" plus
 * the first changed line's text as a preview, the same tally shape boxcode's
 * own `FileDiff::tally` uses. The caller prefixes the "Hunk N" label; this
 * stays a bare summary so it reads naturally as a picker description.
 */
export function summarizeHunk(hunk: DiffHunk): string {
	let added = 0;
	let removed = 0;
	let preview = '';
	for (const line of hunk.lines) {
		if (line.change === 'added') {
			added++;
			if (!preview) {
				preview = line.text;
			}
		} else if (line.change === 'removed') {
			removed++;
			if (!preview) {
				preview = line.text;
			}
		}
	}
	const parts: string[] = [];
	if (added) {
		parts.push(`${added} addition${added === 1 ? '' : 's'}`);
	}
	if (removed) {
		parts.push(`${removed} removal${removed === 1 ? '' : 's'}`);
	}
	const tally = parts.length ? parts.join(', ') : 'no changes';
	return `${tally} — ${preview}`;
}

/**
 * The hunks as a single fenced `diff` block for the in-chat preview, marked
 * `+`/`-`/space exactly like a unified diff (and like boxcode's own diff
 * test helper renders them). Returns plain markdown text; the caller wraps
 * it in a `vscode.MarkdownString`.
 */
export function renderHunksMarkdown(hunks: DiffHunk[]): string {
	const lines: string[] = ['```diff'];
	for (let i = 0; i < hunks.length; i++) {
		for (const line of hunks[i].lines) {
			const mark = line.change === 'added' ? '+' : line.change === 'removed' ? '-' : ' ';
			lines.push(`${mark}${line.text}`);
		}
		if (i < hunks.length - 1) {
			lines.push('');
		}
	}
	lines.push('```');
	return lines.join('\n');
}
