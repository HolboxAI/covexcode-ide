/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isFreshChat } from './freshChat';

test('isFreshChat() is true for an empty history (new chat or first message)', () => {
	assert.equal(isFreshChat(0), true);
});

test('isFreshChat() is false once the thread has prior turns', () => {
	assert.equal(isFreshChat(1), false);
	assert.equal(isFreshChat(4), false);
});
