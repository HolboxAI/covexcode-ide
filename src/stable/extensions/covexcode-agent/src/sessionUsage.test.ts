/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionUsage, formatCompact, sessionUsageFootnote, sessionUsageMeter } from './sessionUsage';
import type { SessionUpdate } from './acpClient';

function usageUpdate(used: unknown, size?: unknown, prompt_tokens?: unknown): SessionUpdate {
	return { sessionUpdate: 'usage_update', used, size, prompt_tokens } as SessionUpdate;
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
	assert.equal(sessionUsageFootnote(5678), '5,678 tokens spent this session');
});

test('sessionUsageFootnote appends an estimated cost when a rate is given', () => {
	assert.equal(sessionUsageFootnote(1_000_000, 0.35), '1,000,000 tokens spent this session · ~$0.35');
	assert.equal(sessionUsageFootnote(100_000, 0.35), '100,000 tokens spent this session · ~$0.035');
});

test('sub-cent estimates stay non-zero instead of rounding to $0.00', () => {
	assert.equal(sessionUsageFootnote(1000, 0.35), '1,000 tokens spent this session · ~$0.00035');
});

test('whole-dollar estimates keep two decimals', () => {
	assert.equal(sessionUsageFootnote(10_000_000, 0.35), '10,000,000 tokens spent this session · ~$3.50');
});

test('sessionUsageMeter is undefined for an empty session', () => {
	assert.equal(sessionUsageMeter(0), undefined);
	assert.equal(sessionUsageMeter(0, 0.35), undefined);
});

test('sessionUsageMeter renders tokens only when no cost rate is given', () => {
	assert.equal(sessionUsageMeter(5678), '5,678 tokens spent');
});

test('sessionUsageMeter appends an estimated cost when a rate is given', () => {
	assert.equal(sessionUsageMeter(1_000_000, 0.35), '1,000,000 tokens spent · ~$0.35');
	assert.equal(sessionUsageMeter(100_000, 0.35), '100,000 tokens spent · ~$0.035');
});

test('sessionUsageMeter keeps sub-cent estimates non-zero', () => {
	assert.equal(sessionUsageMeter(1000, 0.35), '1,000 tokens spent · ~$0.00035');
});

test('circleMeter is undefined when session is empty or very low (< 5%)', () => {
	const session = createSessionUsage();
	assert.equal(session.circleMeter(128_000), undefined);

	// 1,000 of 128,000 is < 1%
	session.record(usageUpdate(1000, 128_000, 1000));
	assert.equal(session.circleMeter(128_000), undefined);
});

test('circleMeter shows blue circle with tokens left when active and under 80%', () => {
	const session = createSessionUsage();
	// 40,000 of 128,000 = ~31%
	session.record(usageUpdate(40_000, 128_000, 40_000));
	const meter = session.circleMeter(128_000);
	assert.ok(meter);
	assert.equal(meter.colorTheme, 'blue');
	assert.equal(meter.tokensLeft, 88_000);
	assert.equal(meter.percent, 31);
	assert.equal(meter.text, '$(circle-filled) 88k left');
	assert.ok(meter.tooltip.includes('88,000 tokens left'));
});

test('circleMeter shows red circle warning when almost full (>= 80%)', () => {
	const session = createSessionUsage();
	// 110,000 of 128,000 = ~86%
	session.record(usageUpdate(110_000, 128_000, 110_000));
	const meter = session.circleMeter(128_000);
	assert.ok(meter);
	assert.equal(meter.colorTheme, 'red');
	assert.equal(meter.percent, 86);
	assert.equal(meter.text, '$(circle-filled) 18k left');
	assert.ok(meter.tooltip.includes('almost full'));
});

test('circleMeter shows limit reached when 100% full', () => {
	const session = createSessionUsage();
	session.record(usageUpdate(128_000, 128_000, 128_000));
	const meter = session.circleMeter(128_000);
	assert.ok(meter);
	assert.equal(meter.colorTheme, 'red');
	assert.equal(meter.percent, 100);
	assert.equal(meter.tokensLeft, 0);
	assert.equal(meter.text, '$(circle-filled) Limit reached');
});

test('formatCompact formats numbers cleanly', () => {
	assert.equal(formatCompact(88_000), '88k');
	assert.equal(formatCompact(120_500), '121k');
	assert.equal(formatCompact(1_500_000), '1.5M');
	assert.equal(formatCompact(900), '900');
});
