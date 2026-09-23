/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { describeReferenceValue } from './referenceDescription';

/**
 * Renders one non-binary `vscode.ChatPromptReference` as structured prompt
 * text, so `@`-mentions of files/symbols/docs actually carry their content
 * into `boxcode --acp` instead of just their path.
 *
 * No `vscode` import on purpose -- same posture as `referenceDescription.ts`,
 * so `referenceContent.test.ts` can exercise this without an extension host.
 * File reading is injected as `readFile(fsPath): Promise<string>`; the real
 * caller in `extension.ts` resolves it through `vscode.workspace.fs`, while
 * tests pass a fixture map.
 *
 * The two value shapes that resolve to disk content are a `Uri` (a `#file`
 * or `@`-mentioned file/document -- "docs" ride this same path, they're just
 * files) and a `Location` (a `#sym`-attached symbol). Both are duck-typed
 * (not `instanceof vscode.Uri`) exactly like `referenceDescription.ts`, so
 * they stay testable; `reference.value` is `string | Uri | Location | unknown`
 * in vscode.d.ts, and only those two non-string shapes are worth special
 * treatment. A string value (console logs, CSS selectors from the browser
 * element-picker) passes through unchanged, and an unrecognized shape is
 * skipped outright rather than stringified to "[object Object]".
 */

export interface ChatReferenceLike {
	id: string;
	modelDescription?: string;
	value: unknown;
}

export interface ReadTextFile {
	(fsPath: string): Promise<string>;
}

export interface ReferenceContentOptions {
	/** Cap on attached source, in characters. Defaults to 16000. */
	maxChars?: number;
	/** Cap on attached source, in lines. Defaults to 200. */
	maxLines?: number;
	/** Extra lines of context kept above/below a symbol's own range. Defaults to 1. */
	symbolContextLines?: number;
}

const DEFAULT_MAX_CHARS = 16_000;
const DEFAULT_MAX_LINES = 200;
const DEFAULT_SYMBOL_CONTEXT_LINES = 1;

interface ResolvedOptions {
	maxChars: number;
	maxLines: number;
	symbolContextLines: number;
}

function resolveOptions(options?: ReferenceContentOptions): ResolvedOptions {
	return {
		maxChars: options?.maxChars ?? DEFAULT_MAX_CHARS,
		maxLines: options?.maxLines ?? DEFAULT_MAX_LINES,
		symbolContextLines: options?.symbolContextLines ?? DEFAULT_SYMBOL_CONTEXT_LINES,
	};
}

// --- duck-typed guards (mirror referenceDescription.ts, keeping the fields we read) ---

interface UriLike {
	readonly scheme?: unknown;
	readonly fsPath?: unknown;
	readonly path?: unknown;
	toString(): string;
}

interface LocationLike {
	readonly uri: UriLike;
	readonly range: {
		start: { line: number };
		end?: { line: number };
	};
}

function isUriLike(value: unknown): value is UriLike {
	return typeof value === 'object' && value !== null
		&& typeof (value as UriLike).toString === 'function'
		&& (value as UriLike).toString !== Object.prototype.toString;
}

function isLocationLike(value: unknown): value is LocationLike {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<LocationLike>;
	return isUriLike(candidate.uri) && typeof candidate.range?.start?.line === 'number';
}

interface UriParts {
	scheme: string | undefined;
	fsPath: string | undefined;
}

function uriParts(value: UriLike): UriParts {
	return {
		scheme: typeof value.scheme === 'string' ? value.scheme : undefined,
		fsPath: typeof value.fsPath === 'string'
			? value.fsPath
			: typeof value.path === 'string' ? value.path : undefined,
	};
}

/** Markdown info-string for a file extension, so attached source fences with the right language. */
const MARKDOWN_LANGUAGE_BY_EXTENSION: Record<string, string> = {
	'.c': 'c',
	'.cc': 'cpp',
	'.cpp': 'cpp',
	'.css': 'css',
	'.go': 'go',
	'.h': 'cpp',
	'.hpp': 'cpp',
	'.html': 'html',
	'.java': 'java',
	'.js': 'javascript',
	'.jsx': 'jsx',
	'.json': 'json',
	'.less': 'less',
	'.md': 'markdown',
	'.mdx': 'mdx',
	'.mjs': 'javascript',
	'.php': 'php',
	'.py': 'python',
	'.rb': 'ruby',
	'.rs': 'rust',
	'.scss': 'scss',
	'.sh': 'shell',
	'.sql': 'sql',
	'.svelte': 'svelte',
	'.toml': 'toml',
	'.ts': 'typescript',
	'.tsx': 'tsx',
	'.vue': 'vue',
	'.yaml': 'yaml',
	'.yml': 'yaml',
};

export function markdownLanguageForPath(fsPath: string): string | undefined {
	return MARKDOWN_LANGUAGE_BY_EXTENSION[path.extname(fsPath).toLowerCase()];
}

export function truncateContent(content: string, maxChars: number, maxLines: number): { text: string; truncated: boolean } {
	const lines = content.split('\n');
	let truncated = lines.length > maxLines;
	if (truncated) {
		lines.length = maxLines;
	}
	let text = lines.join('\n');
	if (text.length > maxChars) {
		text = text.slice(0, maxChars);
		truncated = true;
	}
	return { text, truncated };
}

function extractLineRange(content: string, startLine: number, endLine: number, contextLines: number): string {
	const lines = content.split('\n');
	const from = Math.max(0, startLine - contextLines);
	const to = Math.min(lines.length - 1, Math.max(endLine, startLine) + contextLines);
	return lines.slice(from, to + 1).join('\n');
}

function fenceWithLanguage(text: string, language: string | undefined): string {
	return '```' + (language ?? '') + '\n' + text + '\n```';
}

function stringSection(heading: string, value: string): string {
	return `### Attached: ${heading}\n\n${value}`;
}

function fallbackSection(heading: string, value: unknown): string {
	return `### Attached: ${heading}\n\n${describeReferenceValue(value)}`;
}

function fileSection(fsPath: string, content: string, options: ResolvedOptions): string {
	const { text, truncated } = truncateContent(content, options.maxChars, options.maxLines);
	const body = fenceWithLanguage(text, markdownLanguageForPath(fsPath));
	return `### File: ${fsPath}\n\n${body}${truncated ? '\n\n_(truncated)_' : ''}`;
}

function symbolSection(
	fsPath: string,
	name: string | undefined,
	startLine: number,
	endLine: number,
	content: string,
	options: ResolvedOptions,
): string {
	const location = `${fsPath}:${startLine + 1}`;
	const heading = name && name.length > 0 ? `### Symbol: ${name} — ${location}` : `### Symbol: ${location}`;
	const extracted = extractLineRange(content, startLine, endLine, options.symbolContextLines);
	return `${heading}\n\n${fenceWithLanguage(extracted, markdownLanguageForPath(fsPath))}`;
}

async function readText(readFile: ReadTextFile, fsPath: string): Promise<string | undefined> {
	try {
		return await readFile(fsPath);
	} catch {
		// Unreadable path (a directory reference, or a file deleted since it
		// was mentioned) -- the caller falls back to a path-only section.
		return undefined;
	}
}

/**
 * The structured prompt section for one reference, or `undefined` when the
 * reference can't be turned into useful context (unrecognized value shape).
 */
export async function referenceContextSection(
	reference: ChatReferenceLike,
	readFile: ReadTextFile,
	options?: ReferenceContentOptions,
): Promise<string | undefined> {
	const opts = resolveOptions(options);
	const { id, modelDescription, value } = reference;

	if (typeof value === 'string') {
		return stringSection(modelDescription ?? id, value);
	}

	if (isLocationLike(value)) {
		const parts = uriParts(value.uri);
		const range = { start: value.range.start.line, end: value.range.end?.line ?? value.range.start.line };
		if (parts.fsPath && (parts.scheme ?? 'file') === 'file') {
			const content = await readText(readFile, parts.fsPath);
			if (content !== undefined) {
				return symbolSection(parts.fsPath, modelDescription, range.start, range.end, content, opts);
			}
		}
		return fallbackSection(modelDescription ?? id, value);
	}

	if (isUriLike(value)) {
		const parts = uriParts(value);
		if (parts.fsPath && (parts.scheme ?? 'file') === 'file') {
			const content = await readText(readFile, parts.fsPath);
			if (content !== undefined) {
				return fileSection(parts.fsPath, content, opts);
			}
		}
		return fallbackSection(modelDescription ?? id, value);
	}

	return undefined;
}
