/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Reads the plain-text result of the agent's `lsp` diagnostics action so the
 * chat can show it as a linked list instead of only naming the tool call.
 *
 * The agent renders one diagnostic per line (`execute_lsp` in
 * `src/tools.rs`):
 *
 *     src/main.rs:12:5 error: cannot find value `x` [rust-analyzer]
 *
 * The path is greedy because a Windows path carries its own colons; the
 * line/column pair and the severity keyword pin down where the path ends.
 * Anything that does not match -- the "clean", "timed out" and error messages
 * -- is simply not a diagnostic and is left to the existing tool row.
 */

export type LspDiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface LspDiagnostic {
	/** Workspace-relative when the server pointed inside the workspace. */
	readonly path: string;
	/** 1-based, as the agent reports it. */
	readonly line: number;
	readonly column: number;
	readonly severity: LspDiagnosticSeverity;
	readonly message: string;
	readonly source?: string;
}

const DIAGNOSTIC_LINE = /^(.*):(\d+):(\d+) (error|warning|info|hint): (.*)$/;
const SOURCE_SUFFIX = /^(.*) \[([^\]]+)\]$/;

export function parseLspDiagnostics(text: string): LspDiagnostic[] {
	const diagnostics: LspDiagnostic[] = [];
	for (const raw of text.split('\n')) {
		const line = raw.trimEnd();
		const match = DIAGNOSTIC_LINE.exec(line);
		if (!match) {
			continue;
		}
		const [, path, lineNumber, column, severity, rest] = match;
		let message = rest;
		let source: string | undefined;
		const withSource = SOURCE_SUFFIX.exec(rest);
		if (withSource) {
			message = withSource[1];
			source = withSource[2];
		}
		diagnostics.push({
			path,
			line: Number(lineNumber),
			column: Number(column),
			severity: severity as LspDiagnosticSeverity,
			message,
			source,
		});
	}
	return diagnostics;
}

/**
 * A count per severity, in the order a reader cares about. Zero severities are
 * omitted; an empty list is "no diagnostics".
 */
export function diagnosticsSummary(diagnostics: readonly LspDiagnostic[]): string {
	const counts: Record<LspDiagnosticSeverity, number> = {
		error: 0,
		warning: 0,
		info: 0,
		hint: 0,
	};
	for (const diagnostic of diagnostics) {
		counts[diagnostic.severity] += 1;
	}
	const parts: string[] = [];
	for (const severity of ['error', 'warning', 'info', 'hint'] as const) {
		const count = counts[severity];
		if (count > 0) {
			parts.push(`${count} ${severity}${count === 1 ? '' : 's'}`);
		}
	}
	return parts.length > 0 ? parts.join(', ') : 'no diagnostics';
}
