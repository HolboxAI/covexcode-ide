/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentActivityTracker, isBackgroundAgentId } from './agentActivity';

function update(overrides: Record<string, unknown>) {
	return { sessionUpdate: 'tool_call_update', ...overrides } as never;
}

test('only teammate ids are treated as background agents', () => {
	assert.equal(isBackgroundAgentId('teammate-3'), true);
	assert.equal(isBackgroundAgentId('call_1'), false);
	assert.equal(isBackgroundAgentId(undefined), false);
});

test('a background teammate is tracked from start through progress to finish', () => {
	const tracker = new AgentActivityTracker();

	const started = tracker.apply({ sessionUpdate: 'tool_call', toolCallId: 'teammate-1', title: 'explore-1 — find config', status: 'in_progress' } as never);
	assert.equal(started?.kind, 'started');
	assert.equal(started?.agent.title, 'explore-1 — find config');
	assert.equal(tracker.runningCount(), 1);

	const progress = tracker.apply(update({
		toolCallId: 'teammate-1',
		status: 'in_progress',
		content: { type: 'content', text: 'grep_search config (round 2)' },
	}));
	assert.equal(progress?.kind, 'progress');
	assert.equal(progress?.agent.lastStep, 'grep_search config (round 2)');

	const finished = tracker.apply(update({
		toolCallId: 'teammate-1',
		status: 'completed',
		content: { type: 'content', text: 'done' },
	}));
	assert.equal(finished?.kind, 'finished');
	assert.equal(finished?.agent.state, 'completed');
	assert.equal(finished?.agent.outcome, 'done');
	assert.equal(finished?.agent.lastStep, 'grep_search config (round 2)');
	assert.equal(tracker.runningCount(), 0);
});

test('ordinary tool calls and foreground subagents are ignored', () => {
	const tracker = new AgentActivityTracker();
	assert.equal(tracker.apply({ sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'read_file' } as never), undefined);
	assert.equal(tracker.apply(update({ toolCallId: 'call_1', status: 'completed' })), undefined);
	assert.equal(tracker.list().length, 0);
});

test('the /agents readout lists running agents before finished ones', () => {
	const tracker = new AgentActivityTracker();
	tracker.apply({ sessionUpdate: 'tool_call', toolCallId: 'teammate-1', title: 'first' } as never);
	tracker.apply(update({ toolCallId: 'teammate-1', status: 'completed', content: { type: 'content', text: 'done' } }));
	tracker.apply({ sessionUpdate: 'tool_call', toolCallId: 'teammate-2', title: 'second' } as never);

	const markdown = tracker.markdown();
	assert.match(markdown, /second — running/);
	assert.match(markdown, /first — completed — done/);
	assert.ok(markdown.indexOf('second') < markdown.indexOf('first'));
});

test('a new session clears the live table', () => {
	const tracker = new AgentActivityTracker();
	tracker.apply({ sessionUpdate: 'tool_call', toolCallId: 'teammate-1', title: 'one' } as never);
	tracker.clear();
	assert.equal(tracker.runningCount(), 0);
	assert.match(tracker.markdown(), /No background agents/);
});
