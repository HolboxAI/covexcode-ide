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
	assert.equal(turn.footnote(), '1,234 tokens spent this turn');
});

test('multiple usage_updates in one turn sum, not overwrite (one per LLM response)', () => {
	const turn = createTurnUsage();
	turn.record(usageUpdate(1000));
	turn.record(usageUpdate(250));
	turn.record(usageUpdate(75));
	assert.equal(turn.footnote(), '1,325 tokens spent this turn');
});

test('a context-window size compares against the largest request, not the turn sum', () => {
	const turn = createTurnUsage();
	turn.record(usageUpdate(1234, 200000));
	assert.equal(turn.footnote(), '1,234 tokens spent this turn · largest request 1,234 of 200,000');
});

test('spend above the window is not reported as context overflow', () => {
	// The exact shape from the field report: many requests in one turn add up
	// past the window while every individual request stayed inside it.
	const turn = createTurnUsage();
	turn.record(usageUpdate(100_000, 131_072));
	turn.record(usageUpdate(100_000, 131_072));
	assert.equal(
		turn.footnote(),
		'200,000 tokens spent this turn · largest request 100,000 of 131,072',
	);
});

test('the largest request, not the last one, is what the window comparison uses', () => {
	const turn = createTurnUsage();
	turn.record(usageUpdate(50_000, 131_072));
	turn.record(usageUpdate(70_000, 131_072));
	turn.record(usageUpdate(10_000, 131_072));
	assert.match(turn.footnote() ?? '', /largest request 70,000 of 131,072/);
});

test('warns when a single request reaches 90% of the context window', () => {
	const turn = createTurnUsage();
	turn.record(usageUpdate(118_000, 131_072));
	assert.match(turn.footnote() ?? '', /context nearly full, start a new chat/);
});

test('does not warn below 90% of the context window', () => {
	const turn = createTurnUsage();
	turn.record(usageUpdate(117_000, 131_072));
	assert.doesNotMatch(turn.footnote() ?? '', /context nearly full/);
});

test('size 0 (covexcode does not track the context limit) omits the window comparison', () => {
	const turn = createTurnUsage();
	turn.record(usageUpdate(1234, 0));
	assert.equal(turn.footnote(), '1,234 tokens spent this turn');
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
	assert.equal(turn.footnote(), '500 tokens spent this turn · largest request 500 of 200,000');
});

test('large counts group by thousands', () => {
	const turn = createTurnUsage();
	turn.record(usageUpdate(1234567));
	assert.equal(turn.footnote(), '1,234,567 tokens spent this turn');
});
