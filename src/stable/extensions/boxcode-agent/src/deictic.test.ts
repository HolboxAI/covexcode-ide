/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDeicticReferent } from './deictic.js';

test('detects a demonstrative pointing at the UI', () => {
	assert.deepEqual(detectDeicticReferent('move this option to the left pane'), { kind: 'ui' });
});

test('detects a locative-only phrase pointing at the UI', () => {
	assert.deepEqual(detectDeicticReferent('put it at the very bottom'), { kind: 'ui' });
});

test('detects a demonstrative pointing at code', () => {
	assert.deepEqual(detectDeicticReferent('this function is slow'), { kind: 'code' });
});

test('detects a general demonstrative with no clear noun', () => {
	assert.deepEqual(detectDeicticReferent('can you explain this?'), { kind: 'general' });
});

test('returns null for a non-deictic instruction', () => {
	assert.equal(detectDeicticReferent('run the test suite'), null);
});
