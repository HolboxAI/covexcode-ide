/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	ANGULAR_ID,
	ASTRO_ID,
	ESLINT_ID,
	FRAMEWORK_EXTENSIONS,
	missingRecommendedExtensions,
	PRETTIER_ID,
	REACT_SNIPPETS_ID,
	recommendationPrompt,
	recommendationSkipKey,
	SVELTE_ID,
	TAILWIND_ID,
	VOLAR_ID,
} from './frameworkRecommendations';

test('a Vue project recommends Volar, not React snippets', () => {
	assert.ok(FRAMEWORK_EXTENSIONS.vue.includes(VOLAR_ID));
	assert.ok(!FRAMEWORK_EXTENSIONS.vue.includes(REACT_SNIPPETS_ID));
	assert.ok(FRAMEWORK_EXTENSIONS.react.includes(REACT_SNIPPETS_ID));
	assert.ok(!FRAMEWORK_EXTENSIONS.react.includes(VOLAR_ID));
});

test('Astro, Svelte and Angular each recommend their own language server', () => {
	assert.ok(FRAMEWORK_EXTENSIONS.astro.includes(ASTRO_ID));
	assert.ok(FRAMEWORK_EXTENSIONS.svelte.includes(SVELTE_ID));
	assert.ok(FRAMEWORK_EXTENSIONS.angular.includes(ANGULAR_ID));
	// and none of them cross-recommends a sibling framework's server
	assert.ok(!FRAMEWORK_EXTENSIONS.astro.includes(VOLAR_ID));
	assert.ok(!FRAMEWORK_EXTENSIONS.svelte.includes(REACT_SNIPPETS_ID));
	assert.ok(!FRAMEWORK_EXTENSIONS.angular.includes(SVELTE_ID));
});

test('missingRecommendedExtensions() returns only ids that are not installed', () => {
	const missing = missingRecommendedExtensions([ESLINT_ID, PRETTIER_ID], 'next');
	assert.deepEqual(missing, [TAILWIND_ID, REACT_SNIPPETS_ID]);
});

test('missingRecommendedExtensions() is empty when the set is already installed', () => {
	assert.deepEqual(
		missingRecommendedExtensions(FRAMEWORK_EXTENSIONS.angular, 'angular'),
		[],
	);
});

test('recommendationPrompt() names the framework and the missing extensions', () => {
	const prompt = recommendationPrompt('vue', [VOLAR_ID, ESLINT_ID]);
	assert.match(prompt, /Vue project/);
	assert.match(prompt, /Vue - Official/);
	assert.match(prompt, /ESLint/);
});

test('recommendationSkipKey() is per cwd and framework, so a stack change re-prompts', () => {
	assert.equal(recommendationSkipKey('/app', 'react'), '/app::react');
	assert.notEqual(recommendationSkipKey('/app', 'react'), recommendationSkipKey('/app', 'vue'));
	assert.notEqual(recommendationSkipKey('/app', 'react'), recommendationSkipKey('/other', 'react'));
});
