/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';
import { agentsMarkdown, inboxMarkdown, tasksMarkdown, teammatesMarkdown } from './agentPanels';

test('teammates readout distinguishes running, interrupted and ready reports', () => {
	const markdown = teammatesMarkdown([
		{ id: 'teammate-1', name: 'explore-1', task: 'find the parser', running: true, has_report: false, elapsed_secs: 12, pid: 1, remote: false, interrupted: false },
		{ id: 'teammate-2', name: 'worker-2', task: 'fix the parser', running: false, has_report: true, elapsed_secs: 33, pid: 2, remote: false, interrupted: false },
		{ id: 'teammate-3', name: 'tester-3', task: 'test the parser', running: false, has_report: false, elapsed_secs: 4, pid: 3, remote: true, interrupted: true },
	]);
	assert.match(markdown, /explore-1 — running/);
	assert.match(markdown, /worker-2 — finished · 33s · report ready/);
	assert.match(markdown, /tester-3 — interrupted · 4s · other process/);
});

test('an empty teammates registry says so instead of rendering an empty list', () => {
	assert.match(teammatesMarkdown([]), /No teammate jobs recorded/);
});

test('tasks readout shows status markers, owners and dependencies', () => {
	const markdown = tasksMarkdown([
		{ id: 't1', title: 'schema', description: '', depends_on: [], paths: [], status: 'done', owner: 'lead' },
		{ id: 't2', title: 'panel', description: '', depends_on: ['t1'], paths: [], status: 'in_progress', owner: 'worker' },
	]);
	assert.match(markdown, /\[x\] `t1` schema · lead/);
	assert.match(markdown, /\[~\] `t2` panel · worker · after t1/);
});

test('agents readout lists running work and available definitions', () => {
	const markdown = agentsMarkdown(
		[
			{ name: 'explore', description: 'researches', prompt: '', writes: false },
			{ name: 'worker', description: 'implements', prompt: 'do it', writes: true, verify: 'cargo test' },
		],
		[{ title: 'explore-1 — find config', lastStep: 'grep_search (round 2)' }],
	);
	assert.match(markdown, /Running now:/);
	assert.match(markdown, /explore-1 — find config — grep_search \(round 2\)/);
	assert.match(markdown, /`explore` — researches \(read-only\)/);
	assert.match(markdown, /`worker` — implements \(writes in a worktree\) · verify: `cargo test`/);
});

test('inbox readout preserves multi-line bodies and the owner', () => {
	const markdown = inboxMarkdown('lead', [
		{ id: 4, from: 'worker', to: 'lead', body: 'first line\nsecond line', at: '2026-11-17T00:00:00Z', read_by: [] },
	]);
	assert.match(markdown, /inbox — lead/);
	assert.match(markdown, /from worker at 2026-11-17T00:00:00Z/);
	assert.match(markdown, /\n  first line\n  second line/);
});
