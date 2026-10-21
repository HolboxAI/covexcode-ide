/**
 * Describes the surface the user is most likely pointing at when they say
 * "this", "here", or "the leftmost pane" without naming a file or symbol.
 *
 * This module is deliberately pure: it takes plain values and returns a plain
 * string, so it can be unit-tested without importing `vscode`. The extension
 * collects the live values from the `vscode.window` API and calls
 * `formatFocusedSurface`.
 */

export type FocusedSurface =
	| { kind: 'browser'; url: string; title: string }
	| { kind: 'editor'; label: string; languageId: string }
	| { kind: 'terminal'; name: string }
	| { kind: 'none' };

export interface FocusedSurfaceInput {
	/** Active integrated-browser tab, if any. */
	browserUrl?: string;
	browserTitle?: string;
	/** Active text editor tab label + language id, if any. */
	editorLabel?: string;
	editorLanguageId?: string;
	/** Active terminal name, if any. */
	terminalName?: string;
	/** True when the VS Code window itself has focus (vs. an OS-level dialog). */
	windowFocused?: boolean;
}

export function resolveFocusedSurface(input: FocusedSurfaceInput): FocusedSurface {
	if (input.browserUrl) {
		return { kind: 'browser', url: input.browserUrl, title: input.browserTitle ?? '' };
	}
	if (input.editorLabel) {
		return { kind: 'editor', label: input.editorLabel, languageId: input.editorLanguageId ?? '' };
	}
	if (input.terminalName) {
		return { kind: 'terminal', name: input.terminalName };
	}
	return { kind: 'none' };
}

export function formatFocusedSurface(input: FocusedSurfaceInput): string {
	const surface = resolveFocusedSurface(input);
	switch (surface.kind) {
		case 'browser':
			return `Currently focused: the integrated browser at ${surface.url} ("${surface.title}").`;
		case 'editor':
			return `Currently focused: the editor tab "${surface.label}" (${surface.languageId}).`;
		case 'terminal':
			return `Currently focused: the terminal "${surface.name}".`;
		case 'none':
			return '';
	}
}

/**
 * Whether the focused surface is the integrated browser. When true, a "this
 * option / leftmost pane" reference should be resolved against the page's text
 * accessibility tree (which works even without image support).
 */
export function isBrowserFocused(input: FocusedSurfaceInput): boolean {
	return resolveFocusedSurface(input).kind === 'browser';
}
