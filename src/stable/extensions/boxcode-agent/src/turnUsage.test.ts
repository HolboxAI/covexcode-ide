/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTurnUsage } from './turnUsage';
import type { SessionUpdate } from './acpClient';

function usageUpdate(used: unknown, size?: unknown): SessionUpdate {
	return { sessionUpdate: 'usage_update', used, size } as SessionUpdate;
}

test('footnote() is undefined when the turn reported no usage at all', () => {
	const turn = createTurnUsage();
	turn.record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
	turn.record({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' });
	assert.equal(turn.footnote(), undefined);
});

test('a single usage_update becomes a per-turn token count', () => {
	const turn = createTurnUsage();
	turn.record(usageUpdate(1234));
	assert.equal(turn.footnote(), '1,234 tokens this turn');
});

test('multiple usage_updates in one turn sum, not overwrite (one per LLM response)', () => {
	const turn = createTurnUsage();
	turn.record(usageUpdate(1000));
	turn.record(usageUpdate(250));
	turn.record(usageUpdate(75));
	assert.equal(turn.footnote(), '1,325 tokens this turn');
});

test('a real context-window size adds the "of N" half', () => {
	const turn = createTurnUsage();
	turn.record(usageUpdate(1234, 200000));
	assert.equal(turn.footnote(), '1,234 of 200,000 tokens this turn');
});

test('size 0 (boxcode does not track the context limit yet) omits the "of N" half', () => {
	const turn = createTurnUsage();
	turn.record(usageUpdate(1234, 0));
	assert.equal(turn.footnote(), '1,234 tokens this turn');
});

test('non-numeric or negative used values are ignored, not coerced', () => {
	const turn = createTurnUsage();
	turn.record(usageUpdate('1200'));
	turn.record(usageUpdate(undefined));
	turn.record(usageUpdate(-5));
	turn.record(usageUpdate(Number.NaN));
	assert.equal(turn.footnote(), undefined);
});

test('a malformed usage_update does not poison later valid ones', () => {
	const turn = createTurnUsage();
	turn.record(usageUpdate('garbage', 200000));
	turn.record(usageUpdate(500, 200000));
	assert.equal(turn.footnote(), '500 of 200,000 tokens this turn');
});

test('large counts group by thousands', () => {
	const turn = createTurnUsage();
	turn.record(usageUpdate(1234567));
	assert.equal(turn.footnote(), '1,234,567 tokens this turn');
});
