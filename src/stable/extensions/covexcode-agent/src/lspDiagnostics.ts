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
const LOCATION_LINE = /^(.*):(\d+):(\d+)$/;
const SOURCE_SUFFIX = /^(.*) \[([^\]]+)\]$/;

/** One `path:line:column` row from a definition or references result. */
export interface LspLocation {
	readonly path: string;
	readonly line: number;
	readonly column: number;
}

/**
 * Reads the agent's definition/references output, which is one bare
 * `path:line:column` per line (`execute_lsp_query` in `src/tools.rs`). The
 * same greedy-path rule applies: a Windows drive colon is part of the path.
 */
export function parseLspLocations(text: string): LspLocation[] {
	const locations: LspLocation[] = [];
	for (const raw of text.split('\n')) {
		const match = LOCATION_LINE.exec(raw.trimEnd());
		if (!match) {
			continue;
		}
		locations.push({
			path: match[1],
			line: Number(match[2]),
			column: Number(match[3]),
		});
	}
	return locations;
}

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

/**
 * Hover replies are commonly one fenced block (`\`\`\`rust\nfn f()\n\`\`\``),
 * because that is how a language server renders markdown. We display the
 * text in our own fence, so unwrap that outer block first; anything else is
 * returned trimmed and untouched.
 */
export function unwrapHoverMarkdown(text: string): string {
	const trimmed = text.trim();
	const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
	return match ? match[1] : trimmed;
}

/**
 * A fence guaranteed not to close early: one backtick longer than the longest
 * run already in the text. The body is never parsed as Markdown, so
 * server-supplied text cannot become a link or command.
 */
export function markdownCodeFence(text: string): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
	const fence = '`'.repeat(Math.max(3, longest + 1));
	return `${fence}text\n${text}\n${fence}`;
}

/**
 * Reads the agent's `symbols` output:
 *
 *     Symbols in src/lib.rs:
 *     main
 *     parse_config
 *
 * The header is dropped, blank lines ignored, duplicates collapsed, and the
 * list capped at 50 — the same cap the agent applies.
 */
export function parseLspSymbols(text: string): string[] {
	const lines = text.split('\n');
	const header = lines.findIndex(line => line.trim().startsWith('Symbols in '));
	if (header < 0) {
		// "No symbols reported for ..." and error results are prose, not a
		// one-name outline; leave them to the tool row.
		return [];
	}
	const names: string[] = [];
	for (const raw of lines.slice(header + 1)) {
		const name = raw.trim();
		if (!name) {
			continue;
		}
		if (!names.includes(name)) {
			names.push(name);
		}
		if (names.length >= 50) {
			break;
		}
	}
	return names;
}
