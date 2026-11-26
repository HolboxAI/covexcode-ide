/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventErrorMarkdown, eventStatusMarkdown, eventUrl } from './eventAllowance';

test('eventUrl appends the action under the event mount', () => {
	assert.equal(
		eventUrl('https://llm.covexcode.com/event/v1', 'status'),
		'https://llm.covexcode.com/event/v1/event/status',
	);
	assert.equal(
		eventUrl('https://llm.covexcode.com/v1/', 'request-more'),
		'https://llm.covexcode.com/v1/event/request-more',
	);
});

test('eventStatusMarkdown renders the allowance readout', () => {
	const markdown = eventStatusMarkdown({
		used: 9_500_000,
		cap: 10_000_000,
		remaining: 500_000,
		tier: 2,
		extra_tokens: 2_000_000,
		phase: 'open',
		tiers: [4_000_000, 8_000_000, 10_000_000],
		grant_tokens: 2_000_000,
	});
	assert.match(markdown, /Window:\*\* open/);
	assert.match(markdown, /9,500,000 \/ 10,000,000/);
	assert.match(markdown, /Remaining:\*\* 500,000/);
	assert.match(markdown, /Tier:\*\* 3 of 3/);
	assert.match(markdown, /Granted extra:\*\* 2,000,000/);
	assert.match(markdown, /Next request:\*\* \+2,000,000/);
});

test('eventStatusMarkdown tolerates a sparse status', () => {
	const markdown = eventStatusMarkdown({ phase: 'not_started' });
	assert.match(markdown, /Window:\*\* not started/);
	assert.match(markdown, /Used:\*\* 0 \/ 0/);
});

test('eventErrorMarkdown keeps the server message', () => {
	assert.equal(
		eventErrorMarkdown(429, 'event has ended'),
		'**Event request failed** (429)\n\nevent has ended',
	);
});
