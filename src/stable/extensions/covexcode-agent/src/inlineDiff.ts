/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

export interface InlineDiffHunk {
	id: number;
	startLine: number;
	deletedCount: number;
	addedCount: number;
	deletedLines: string[];
	addedLines: string[];
	originalText: string;
	modifiedText: string;
}

export interface InlineDiffResult {
	combinedText: string;
	hunks: InlineDiffHunk[];
}

function splitLines(text: string): string[] {
	if (text === '') {
		return [];
	}
	const normalized = text.replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');
	if (lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/**
 * Computes a line-by-line diff between originalText and modifiedText,
 * and produces combinedText containing both deleted and added lines,
 * along with the exact hunk positions for decorations and CodeLenses.
 */
export function computeCombinedDiff(originalText: string, modifiedText: string): InlineDiffResult {
	const origLines = splitLines(originalText);
	const modLines = splitLines(modifiedText);
	const N = origLines.length;
	const M = modLines.length;

	if (N === M && origLines.every((line, idx) => line === modLines[idx])) {
		return { combinedText: modifiedText, hunks: [] };
	}

	let prefixLen = 0;
	while (prefixLen < N && prefixLen < M && origLines[prefixLen] === modLines[prefixLen]) {
		prefixLen++;
	}

	let origSuffix = N - 1;
	let modSuffix = M - 1;
	while (origSuffix >= prefixLen && modSuffix >= prefixLen && origLines[origSuffix] === modLines[modSuffix]) {
		origSuffix--;
		modSuffix--;
	}

	const trimmedOrig = origLines.slice(prefixLen, origSuffix + 1);
	const trimmedMod = modLines.slice(prefixLen, modSuffix + 1);
	const n = trimmedOrig.length;
	const m = trimmedMod.length;

	if (n === 0 && m === 0) {
		return { combinedText: modifiedText, hunks: [] };
	}

	const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < m; j++) {
			if (trimmedOrig[i] === trimmedMod[j]) {
				dp[i + 1][j + 1] = dp[i][j] + 1;
			} else {
				dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
	}

	let i = n;
	let j = m;
	const edits: { type: 'same' | 'del' | 'add'; line: string }[] = [];
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && trimmedOrig[i - 1] === trimmedMod[j - 1]) {
			edits.unshift({ type: 'same', line: trimmedOrig[i - 1] });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			edits.unshift({ type: 'add', line: trimmedMod[j - 1] });
			j--;
		} else {
			edits.unshift({ type: 'del', line: trimmedOrig[i - 1] });
			i--;
		}
	}

	const combinedLines: string[] = [];
	for (let k = 0; k < prefixLen; k++) {
		combinedLines.push(origLines[k]);
	}

	const hunks: InlineDiffHunk[] = [];
	let currentHunk: { deletedLines: string[]; addedLines: string[] } | null = null;
	let hunkIdCounter = 0;

	const flushHunk = () => {
		if (!currentHunk) {
			return;
		}
		const startLine = combinedLines.length;
		for (const line of currentHunk.deletedLines) {
			combinedLines.push(line);
		}
		for (const line of currentHunk.addedLines) {
			combinedLines.push(line);
		}
		hunks.push({
			id: hunkIdCounter++,
			startLine,
			deletedCount: currentHunk.deletedLines.length,
			addedCount: currentHunk.addedLines.length,
			deletedLines: currentHunk.deletedLines,
			addedLines: currentHunk.addedLines,
			originalText: currentHunk.deletedLines.join('\n'),
			modifiedText: currentHunk.addedLines.join('\n'),
		});
		currentHunk = null;
	};

	for (const edit of edits) {
		if (edit.type === 'same') {
			flushHunk();
			combinedLines.push(edit.line);
		} else {
			if (!currentHunk) {
				currentHunk = { deletedLines: [], addedLines: [] };
			}
			if (edit.type === 'del') {
				currentHunk.deletedLines.push(edit.line);
			} else {
				currentHunk.addedLines.push(edit.line);
			}
		}
	}
	flushHunk();

	for (let k = origSuffix + 1; k < N; k++) {
		combinedLines.push(origLines[k]);
	}

	const hasTrailingNewline = modifiedText.endsWith('\n') || originalText.endsWith('\n');
	const combinedText = combinedLines.join('\n') + (hasTrailingNewline && combinedLines.length > 0 ? '\n' : '');
	return { combinedText, hunks };
}
