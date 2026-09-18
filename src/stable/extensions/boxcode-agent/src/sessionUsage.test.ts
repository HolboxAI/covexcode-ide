/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionUsage, sessionUsageFootnote } from './sessionUsage';
import type { SessionUpdate } from './acpClient';

function usageUpdate(used: unknown, size?: unknown): SessionUpdate {
	return { sessionUpdate: 'usage_update', used, size } as SessionUpdate;
}

test('total() accumulates across a multi-turn session and reset() zeroes it', () => {
	const session = createSessionUsage();
	session.record(usageUpdate(1000));
	session.record(usageUpdate(250));
	assert.equal(session.total(), 1250);
	session.reset();
	assert.equal(session.total(), 0);
});

test('non-usage updates and malformed usage_updates are ignored, not coerced', () => {
	const session = createSessionUsage();
	session.record({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
	session.record(usageUpdate('1200'));
	session.record(usageUpdate(-5));
	session.record(usageUpdate(Number.NaN));
	assert.equal(session.total(), 0);
	session.record(usageUpdate(500));
	assert.equal(session.total(), 500);
});

test('sessionUsageFootnote is undefined for an empty session', () => {
	assert.equal(sessionUsageFootnote(0), undefined);
	assert.equal(sessionUsageFootnote(0, 0.35), undefined);
});

test('sessionUsageFootnote renders tokens only when no cost rate is given', () => {
	assert.equal(sessionUsageFootnote(5678), '5,678 tokens this session');
});

test('sessionUsageFootnote appends an estimated cost when a rate is given', () => {
	assert.equal(sessionUsageFootnote(1_000_000, 0.35), '1,000,000 tokens this session · ~$0.35');
	assert.equal(sessionUsageFootnote(100_000, 0.35), '100,000 tokens this session · ~$0.035');
});

test('sub-cent estimates stay non-zero instead of rounding to $0.00', () => {
	assert.equal(sessionUsageFootnote(1000, 0.35), '1,000 tokens this session · ~$0.00035');
});

test('whole-dollar estimates keep two decimals', () => {
	assert.equal(sessionUsageFootnote(10_000_000, 0.35), '10,000,000 tokens this session · ~$3.50');
});
