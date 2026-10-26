/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFreshChat, shouldStartFreshSession } from './freshChat';

test('isFreshChat() is true for an empty history (new chat or first message)', () => {
	assert.equal(isFreshChat(0), true);
});

test('isFreshChat() is false once the thread has prior turns', () => {
	assert.equal(isFreshChat(1), false);
	assert.equal(isFreshChat(4), false);
});

test('a genuinely new chat starts a fresh ACP session', () => {
	assert.equal(shouldStartFreshSession(0, false, false), true);
});

test('an in-progress thread reuses the ACP session', () => {
	assert.equal(shouldStartFreshSession(4, false, false), false);
});

test('inline chat never discards the shared panel session', () => {
	assert.equal(shouldStartFreshSession(0, true, false), false);
});

test('a checkpoint restore keeps the session even when history is empty', () => {
	// Restoring removes the later chat requests from VS Code's model, so the
	// next prompt can arrive with empty history. That is not a new chat -- the
	// ACP session was already truncated to the restored turn.
	assert.equal(shouldStartFreshSession(0, false, true), false);
});

test('the checkpoint exception does not keep a non-empty thread from reusing its session either', () => {
	assert.equal(shouldStartFreshSession(3, false, true), false);
});
