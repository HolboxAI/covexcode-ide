/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePermission, type EvaluationContext, type ResourceToCheck } from './permissionEngine';
import type { PermissionRule } from './permissionStore';

const ctx: EvaluationContext = { turnId: 'turn-1', sessionId: 'session-1' };

function rule(overrides: Partial<PermissionRule> = {}): PermissionRule {
	return {
		kind: 'run_command',
		match: 'exact',
		pattern: 'npm test',
		decision: 'allow',
		createdAt: '2026-11-13T00:00:00.000Z',
		source: 'user',
		...overrides,
	};
}

function res(kind: string, target: string): ResourceToCheck {
	return { kind, target };
}

// --- Exact match ---

test('exact: allow rule matches the same action', () => {
	assert.equal(evaluatePermission(res('run_command', 'npm test'), [rule()], ctx), 'allow');
});

test('exact: deny rule matches the same action', () => {
	assert.equal(evaluatePermission(res('run_command', 'npm test'), [rule({ decision: 'deny' })], ctx), 'deny');
});

test('exact: deny wins over allow', () => {
	const rules = [rule(), rule({ decision: 'deny' })];
	assert.equal(evaluatePermission(res('run_command', 'npm test'), rules, ctx), 'deny');
});

// --- Prefix match ---

test('prefix: git matches git status', () => {
	const r = rule({ pattern: 'git', match: 'prefix' });
	assert.equal(evaluatePermission(res('run_command', 'git status'), [r], ctx), 'allow');
});

test('prefix: a specific deny beats a broader allow', () => {
	const rules = [
		rule({ pattern: 'git', match: 'prefix' }),
		rule({ pattern: 'git push', decision: 'deny' }),
	];
	assert.equal(evaluatePermission(res('run_command', 'git push'), rules, ctx), 'deny');
});

test('prefix: shell chaining is not a boundary match', () => {
	const r = rule({ pattern: 'npm test', match: 'prefix' });
	assert.equal(evaluatePermission(res('run_command', 'npm test && rm -rf /'), [r], ctx), 'ask');
});

test('prefix: no word boundary means no match', () => {
	const r = rule({ pattern: 'npm', match: 'prefix' });
	assert.equal(evaluatePermission(res('run_command', 'npmtest'), [r], ctx), 'ask');
});

// --- Wildcard ---

test('wildcard: allow * matches any command', () => {
	assert.equal(evaluatePermission(res('run_command', 'anything'), [rule({ pattern: '*' })], ctx), 'allow');
});

test('wildcard: a specific deny beats a wildcard allow', () => {
	const rules = [rule({ pattern: '*' }), rule({ pattern: 'git push', decision: 'deny' })];
	assert.equal(evaluatePermission(res('run_command', 'git push'), rules, ctx), 'deny');
	assert.equal(evaluatePermission(res('run_command', 'npm test'), rules, ctx), 'allow');
});

// --- No rules ---

test('no rules ask', () => {
	assert.equal(evaluatePermission(res('run_command', 'npm test'), [], ctx), 'ask');
});

// --- Scope filtering ---

test('scope: turn rule with the wrong turnId does not match', () => {
	const r = rule({ scope: 'turn', turnId: 'other-turn' });
	assert.equal(evaluatePermission(res('run_command', 'npm test'), [r], ctx), 'ask');
});

test('scope: turn rule with the matching turnId matches', () => {
	const r = rule({ scope: 'turn', turnId: 'turn-1' });
	assert.equal(evaluatePermission(res('run_command', 'npm test'), [r], ctx), 'allow');
});

test('scope: session rule with the wrong sessionId does not match', () => {
	const r = rule({ scope: 'session', sessionId: 'other-session' });
	assert.equal(evaluatePermission(res('run_command', 'npm test'), [r], ctx), 'ask');
});

test('scope: session rule with the matching sessionId matches', () => {
	const r = rule({ scope: 'session', sessionId: 'session-1' });
	assert.equal(evaluatePermission(res('run_command', 'npm test'), [r], ctx), 'allow');
});

test('scope: always rule always matches', () => {
	const r = rule({ scope: 'always' });
	assert.equal(evaluatePermission(res('run_command', 'npm test'), [r], ctx), 'allow');
});

// --- Windows paths ---

test('windows: backslash directory prefix matches', () => {
	const r = rule({ kind: 'file_write', pattern: 'C:\\Users\\u\\src\\', match: 'prefix' });
	assert.equal(evaluatePermission(res('file_write', 'C:\\Users\\u\\src\\App.tsx'), [r], ctx), 'allow');
});

test('windows: a deny directory prefix wins', () => {
	const r = rule({ kind: 'file_write', pattern: 'C:\\Users\\u\\', match: 'prefix', decision: 'deny' });
	assert.equal(evaluatePermission(res('file_write', 'C:\\Users\\u\\src\\App.tsx'), [r], ctx), 'deny');
});

test('windows: relative backslash prefix matches', () => {
	const r = rule({ kind: 'file_write', pattern: 'src\\', match: 'prefix' });
	assert.equal(evaluatePermission(res('file_write', 'src\\components\\Login.tsx'), [r], ctx), 'allow');
});

test('windows: file targets are case-insensitive', () => {
	const r = rule({ kind: 'file_write', pattern: 'src\\App.tsx' });
	assert.equal(evaluatePermission(res('file_write', 'SRC\\App.tsx'), [r], ctx), 'allow');
});
