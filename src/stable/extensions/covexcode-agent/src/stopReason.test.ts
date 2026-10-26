/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopReasonNote } from './stopReason';

test('a normal end of turn adds no note', () => {
	assert.equal(stopReasonNote('end_turn'), undefined);
});

test('a turn stopped by the tool-step limit tells the user how to continue', () => {
	const note = stopReasonNote('max_turn_requests');
	assert.ok(note);
	assert.match(note, /tool-step limit/);
	assert.match(note, /continue/);
});

test('a reply cut off by the output cap says so', () => {
	const note = stopReasonNote('max_tokens');
	assert.ok(note);
	assert.match(note, /output cap/);
	assert.match(note, /max_tokens/);
});

test('refusal and cancellation are not re-labelled by this note', () => {
	assert.equal(stopReasonNote('refusal'), undefined);
	assert.equal(stopReasonNote('cancelled'), undefined);
});
