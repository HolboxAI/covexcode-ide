/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Detects the frontend framework of an opened project by reading its
 * `package.json` dependencies -- the "remaining work" the landing-page
 * example-prompt work deliberately left open (see `docs/BACKLOG.md`,
 * "Framework-aware scaffolding": the chips branch on empty-vs-open
 * workspace, not on detected framework).
 *
 * Pure mapping (deps -> framework) is deliberately separated from the async
 * file read (`detectWorkspaceFramework`) so the decision logic is unit-
 * testable without touching disk, and both live here so the file has no
 * `vscode` dependency.
 */

export type Framework = 'next' | 'nuxt' | 'astro' | 'svelte' | 'vue' | 'react' | 'angular';

/**
 * Priority-ordered: meta-frameworks first (Next/Nuxt/Astro), then component
 * frameworks, then Angular. Order matters because deps are cumulative -- a
 * Next app also has `react`, a Nuxt app has `vue`, a SvelteKit app has
 * `svelte` -- so the most specific signal has to win. Co-present build tools
 * (`vite`, `webpack`) are deliberately not matched: they don't tell you what
 * framework a project uses.
 *
 * Keep the welcome-page detector in
 * `patches/100-ui-framework-detect-example-prompts.patch` on this same order
 * -- it cannot import this module (core vs extension), so a Vite+React
 * project must not show Vite chips while this module reports React.
 */
const FRAMEWORK_DEPS: ReadonlyArray<readonly [Framework, ReadonlyArray<string>]> = [
	['next', ['next']],
	['nuxt', ['nuxt', '@nuxt/kit']],
	['astro', ['astro']],
	['svelte', ['svelte', '@sveltejs/kit']],
	['vue', ['vue']],
	['react', ['react', 'react-dom']],
	['angular', ['@angular/core']],
];

export const FRAMEWORK_LABELS: Record<Framework, string> = {
	next: 'Next.js',
	nuxt: 'Nuxt',
	astro: 'Astro',
	svelte: 'Svelte',
	vue: 'Vue',
	react: 'React',
	angular: 'Angular',
};

function dependencyKeys(deps: ReadonlyMap<string, unknown> | Record<string, unknown> | undefined): Set<string> {
	if (!deps) {
		return new Set();
	}
	if (deps instanceof Map) {
		return new Set(deps.keys());
	}
	return new Set(Object.keys(deps));
}

/** Maps a merged dependency map to the most specific detected framework, or
 * `undefined` for no known framework. */
export function detectFramework(deps: ReadonlyMap<string, unknown> | Record<string, unknown> | undefined): Framework | undefined {
	const keys = dependencyKeys(deps);
	for (const [framework, need] of FRAMEWORK_DEPS) {
		if (need.some(dep => keys.has(dep))) {
			return framework;
		}
	}
	return undefined;
}

interface PackageJson {
	dependencies?: Record<string, unknown>;
	devDependencies?: Record<string, unknown>;
	peerDependencies?: Record<string, unknown>;
}

/** Reads and merges a project's dependency maps (dependencies +
 * devDependencies + peerDependencies, since a framework can live in any of
 * the three), then runs `detectFramework` over them. Returns `undefined` for
 * a missing folder, a missing/unparsable `package.json`, or no known
 * framework -- never throws. */
export async function detectWorkspaceFramework(workspacePath: string): Promise<Framework | undefined> {
	try {
		const raw = await fs.readFile(path.join(workspacePath, 'package.json'), 'utf8');
		const pkg = JSON.parse(raw) as PackageJson;
		const merged = {
			...(pkg.dependencies ?? {}),
			...(pkg.devDependencies ?? {}),
			...(pkg.peerDependencies ?? {}),
		};
		return detectFramework(merged);
	} catch {
		return undefined;
	}
}
