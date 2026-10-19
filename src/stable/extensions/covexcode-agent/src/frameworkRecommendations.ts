/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { type Framework, FRAMEWORK_LABELS } from './frameworkDetector';

/**
 * Open VSX ids recommended per stack, so Install does not 404 on a gallery
 * we don't ship. The original five (ESLint, Prettier, Tailwind, React
 * snippets, Volar) were verified to install *and activate* in a built
 * instance (`docs/BACKLOG.md` Tier 1 marketplace check); the three language
 * servers added for Astro/Svelte/Angular are verified to resolve on Open VSX
 * (HTTP 200) but have not yet been run through that same runtime check.
 */
export const ESLINT_ID = 'dbaeumer.vscode-eslint';
export const PRETTIER_ID = 'esbenp.prettier-vscode';
export const TAILWIND_ID = 'bradlc.vscode-tailwindcss';
export const REACT_SNIPPETS_ID = 'dsznajder.es7-react-js-snippets';
export const VOLAR_ID = 'Vue.volar';
export const ASTRO_ID = 'astro-build.astro-vscode';
export const SVELTE_ID = 'svelte.svelte-vscode';
export const ANGULAR_ID = 'angular.ng-template';

export const EXTENSION_DISPLAY_NAMES: Record<string, string> = {
	[ESLINT_ID]: 'ESLint',
	[PRETTIER_ID]: 'Prettier',
	[TAILWIND_ID]: 'Tailwind CSS IntelliSense',
	[REACT_SNIPPETS_ID]: 'ES7+ React snippets',
	[VOLAR_ID]: 'Vue - Official',
	[ASTRO_ID]: 'Astro',
	[SVELTE_ID]: 'Svelte',
	[ANGULAR_ID]: 'Angular Language Service',
};

const JS_TOOLING = [ESLINT_ID, PRETTIER_ID] as const;

export const FRAMEWORK_EXTENSIONS: Record<Framework, readonly string[]> = {
	next: [...JS_TOOLING, TAILWIND_ID, REACT_SNIPPETS_ID],
	nuxt: [...JS_TOOLING, VOLAR_ID, TAILWIND_ID],
	astro: [...JS_TOOLING, ASTRO_ID],
	svelte: [...JS_TOOLING, SVELTE_ID],
	vue: [...JS_TOOLING, VOLAR_ID, TAILWIND_ID],
	react: [...JS_TOOLING, TAILWIND_ID, REACT_SNIPPETS_ID],
	angular: [...JS_TOOLING, ANGULAR_ID],
};

export function missingRecommendedExtensions(
	installed: Iterable<string>,
	framework: Framework,
): string[] {
	const have = new Set(installed);
	return FRAMEWORK_EXTENSIONS[framework].filter(id => !have.has(id));
}

export function recommendationPrompt(framework: Framework, missing: readonly string[]): string {
	const label = FRAMEWORK_LABELS[framework];
	const names = missing.map(id => EXTENSION_DISPLAY_NAMES[id] ?? id).join(', ');
	return `This looks like a ${label} project. Install recommended extensions (${names})?`;
}

export function recommendationSkipKey(cwd: string, framework: Framework): string {
	return `${cwd}::${framework}`;
}
