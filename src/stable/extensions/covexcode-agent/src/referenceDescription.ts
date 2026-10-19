/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Renders a `vscode.ChatPromptReference.value` (typed `string | Uri | Location
 * | unknown` in vscode.d.ts) as prompt text. Duck-typed rather than
 * `instanceof vscode.Uri`/`instanceof vscode.Location` so this stays
 * testable outside the extension host, where the real `vscode` module
 * doesn't exist.
 *
 * `String(value)` on a plain object with no custom `toString` silently
 * produces "[object Object]", and that garbage would get injected into the
 * model's prompt as if it were real context. Only a value that actually
 * looks like a Uri or a Location gets a dedicated render; anything else is
 * skipped rather than blindly stringified.
 */

interface UriLike {
	toString(): string;
}

interface LocationLike {
	uri: UriLike;
	range: {
		start: { line: number };
		end: { line: number };
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
	return isUriLike(candidate.uri) && typeof candidate.range === 'object' && candidate.range !== null
		&& typeof candidate.range.start?.line === 'number';
}

export function describeReferenceValue(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (isLocationLike(value)) {
		return `${value.uri.toString()} (line ${value.range.start.line + 1})`;
	}
	if (isUriLike(value)) {
		return value.toString();
	}
	return '[unrecognized reference type, skipped]';
}
