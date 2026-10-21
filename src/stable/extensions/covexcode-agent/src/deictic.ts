/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Detects *deictic referents* — prompts where the user points at something
 * ("move **this** to **the left pane**", "what does **that button** do",
 * "**here**", "**the very bottom**") rather than naming it.
 *
 * This is the failure mode behind "I ran out of tool rounds": the user says
 * "this option" and the model, with no on-screen context attached, has to
 * guess what "this" is — so it hallucinates a file path and burns its whole
 * tool budget chasing a target that doesn't exist.
 *
 * The detection is deliberately vision-agnostic. Resolving the referent never
 * depends on the model being able to *see* a screenshot; the harness attaches
 * the *text* accessibility tree (`axTree.ts`) for UI referents, and file /
 * selection context for code referents. This module only answers one question:
 * what kind of thing is the user pointing at?
 */

export type DeicticKind = 'ui' | 'code' | 'general';

export interface DeicticSignal {
	/** `ui` = on-screen interface, `code` = source, `general` = "this/here" with no clear noun. */
	kind: DeicticKind;
}

const DEMONSTRATIVES = new Set(['this', 'that', 'these', 'those', 'here', 'there', 'it']);

/**
 * Spatial phrases that indicate the user is pointing at a region of the screen,
 * even when no demonstrative pronoun is present ("the left pane", "the very bottom").
 */
const LOCATIVE_PHRASES = [
	'leftmost',
	'left-most',
	'left pane',
	'left panel',
	'left side',
	'left bar',
	'right pane',
	'right panel',
	'right side',
	'right bar',
	'the bottom',
	'at the bottom',
	'very bottom',
	'the top',
	'at the top',
	'on screen',
	'the screen',
	'sidebar',
	'toolbar',
	'status bar',
	'title bar',
	'activity bar',
	'menu bar',
	'nav bar',
	'navigation bar',
	'the left',
	'the right',
];

const UI_WORDS = new Set([
	'pane', 'panel', 'button', 'menu', 'toolbar', 'sidebar', 'nav', 'navbar',
	'navigation', 'footer', 'header', 'modal', 'dialog', 'widget', 'dropdown',
	'tab', 'icon', 'badge', 'popup', 'toast', 'spinner', 'checkbox', 'slider',
	'toggle', 'field', 'column', 'row', 'screen', 'viewport', 'preview', 'option',
	'item', 'entry', 'control', 'section', 'element', 'action', 'bar', 'layout',
	'grid', 'list', 'card', 'drawer', 'tooltip',
]);

const CODE_WORDS = new Set([
	'function', 'method', 'class', 'variable', 'constant', 'parameter', 'param',
	'argument', 'return', 'import', 'export', 'type', 'interface', 'test',
	'tests', 'spec', 'file', 'module', 'line', 'statement', 'expression',
	'block', 'handler', 'callback', 'component', 'hook', 'code', 'api',
	'endpoint', 'route', 'query', 'state', 'prop', 'props', 'reducer',
	'selector', 'middleware',
]);

function tokenize(prompt: string): Set<string> {
	const words = prompt.toLowerCase().split(/[^a-z]+/);
	return new Set(words.filter((word) => word.length > 0));
}

/**
 * Returns a signal describing what the user is pointing at, or `null` when the
 * prompt has no deictic referent ("run the tests", "add error handling").
 */
export function detectDeicticReferent(prompt: string): DeicticSignal | null {
	const text = prompt.toLowerCase();
	const words = tokenize(prompt);

	const hasDemonstrative = [...words].some((word) => DEMONSTRATIVES.has(word));
	const hasLocative = LOCATIVE_PHRASES.some((phrase) => text.includes(phrase));

	if (!hasDemonstrative && !hasLocative) {
		return null;
	}

	// Code words win over locative phrases: "at the top of the file" is a code
	// referent, not a screen region. Only after ruling out code do we treat a
	// matched locative phrase ("the bottom", "the left pane") as a UI referent.
	if ([...words].some((word) => CODE_WORDS.has(word))) {
		return { kind: 'code' };
	}
	if ([...words].some((word) => UI_WORDS.has(word)) || hasLocative) {
		return { kind: 'ui' };
	}
	return { kind: 'general' };
}
