/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	evaluatePermission,
	isReadOnlyCommand,
	isReadOnlyResource,
	type EvaluationContext,
	type ResourceToCheck,
} from './permissionEngine';
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

// --- Zero-friction read-only inspection (Antigravity-aligned) ---

test('read-only: helper recognizes read kinds and safe inspection commands', () => {
	assert.equal(isReadOnlyResource(res('file_read', 'src/App.tsx')), true);
	assert.equal(isReadOnlyResource(res('read_file', 'README.md')), true);
	assert.equal(isReadOnlyResource(res('list_directory', 'src/')), true);
	assert.equal(isReadOnlyResource(res('search', 'TODO')), true);
	assert.equal(isReadOnlyResource(res('file_write', 'src/App.tsx')), false);
	assert.equal(isReadOnlyResource(res('file_delete', 'src/App.tsx')), false);

	assert.equal(isReadOnlyCommand('git status'), true);
	assert.equal(isReadOnlyCommand('git status -s'), true);
	assert.equal(isReadOnlyCommand('git diff HEAD~1'), true);
	assert.equal(isReadOnlyCommand('git log -n 5'), true);
	assert.equal(isReadOnlyCommand('pwd'), true);
	assert.equal(isReadOnlyCommand('which node'), true);
	assert.equal(isReadOnlyCommand('node -v'), true);

	// Disqualify chained commands, pipes, and redirects
	assert.equal(isReadOnlyCommand('git status && rm -rf /'), false);
	assert.equal(isReadOnlyCommand('git diff > patch.diff'), false);
	assert.equal(isReadOnlyCommand('pwd; whoami'), false);
	assert.equal(isReadOnlyCommand('echo hi | cat'), false);
	assert.equal(isReadOnlyCommand('npm install'), false);
	assert.equal(isReadOnlyCommand('rm -rf /'), false);
});

test('read-only: auto-allows read-only file access without prompting', () => {
	assert.equal(evaluatePermission(res('file_read', 'src/App.tsx'), [], ctx), 'allow');
	assert.equal(evaluatePermission(res('read_file', 'package.json'), [], ctx), 'allow');
	assert.equal(evaluatePermission(res('list_directory', 'src/'), [], ctx), 'allow');
});

test('read-only: auto-allows safe inspection commands without prompting', () => {
	assert.equal(evaluatePermission(res('run_command', 'git status'), [], ctx), 'allow');
	assert.equal(evaluatePermission(res('run_command', 'git diff HEAD~1'), [], ctx), 'allow');
	assert.equal(evaluatePermission(res('run_command', 'pwd'), [], ctx), 'allow');
	assert.equal(evaluatePermission(res('run_command', 'which node'), [], ctx), 'allow');
});

test('read-only: chained or modifying commands still require confirmation (ask)', () => {
	assert.equal(evaluatePermission(res('run_command', 'git status && rm -rf /'), [], ctx), 'ask');
	assert.equal(evaluatePermission(res('run_command', 'git diff > patch.diff'), [], ctx), 'ask');
	assert.equal(evaluatePermission(res('run_command', 'npm install'), [], ctx), 'ask');
	assert.equal(evaluatePermission(res('file_write', 'src/App.tsx'), [], ctx), 'ask');
	assert.equal(evaluatePermission(res('file_delete', 'src/App.tsx'), [], ctx), 'ask');
});

test('read-only: explicit deny rule overrides read-only auto-allow', () => {
	const fileDenyRule = rule({ kind: 'file_read', pattern: 'secret.env', decision: 'deny' });
	assert.equal(evaluatePermission(res('file_read', 'secret.env'), [fileDenyRule], ctx), 'deny');

	const cmdDenyRule = rule({ pattern: 'git status', decision: 'deny' });
	assert.equal(evaluatePermission(res('run_command', 'git status'), [cmdDenyRule], ctx), 'deny');
});
