/**
 * Tests for the four-way permission prompt options.
 *
 * Run with `npm test` from `src/stable/extensions/covexcode-agent`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	PERMISSION_ALWAYS_COMMAND,
	PERMISSION_OPTIONS,
	alwaysCommandUri,
	parseAlwaysCommandArgs,
	permissionOptionFor,
	ruleForChoice,
} from './permissionOptions';

const query = { kind: 'execute' as const, action: 'npm test' };

test('offers the six permission choices, in order', () => {
	assert.deepEqual(
		PERMISSION_OPTIONS.map(o => o.choice),
		['allow', 'allow-turn', 'allow-session', 'allow-always', 'reject', 'reject-always'],
	);
	assert.deepEqual(
		PERMISSION_OPTIONS.map(o => o.label),
		['Allow once', 'Allow for this turn', 'Allow for this session', 'Allow always', 'Deny once', 'Deny always'],
	);
});

test('only the scoped (non-"once") choices are marked as remembering', () => {
	assert.deepEqual(
		PERMISSION_OPTIONS.filter(o => o.remember).map(o => o.choice),
		['allow-turn', 'allow-session', 'allow-always', 'reject-always'],
	);
});

test('permissionOptionFor finds each choice and nothing else', () => {
	for (const option of PERMISSION_OPTIONS) {
		assert.equal(permissionOptionFor(option.choice), option);
	}
	assert.equal(permissionOptionFor('nonsense' as never), undefined);
});

test('"once" choices leave no rule behind', () => {
	assert.equal(ruleForChoice('allow', query, 'now'), undefined);
	assert.equal(ruleForChoice('reject', query, 'now'), undefined);
});

test('"always allow" records an allow rule, "always deny" a deny rule', () => {
	const allowed = ruleForChoice('allow-always', query, '2026-09-18T00:00:00.000Z');
	assert.ok(allowed);
	assert.equal(allowed.decision, 'allow');
	assert.equal(allowed.kind, 'execute');
	assert.equal(allowed.pattern, 'npm test');
	assert.equal(allowed.createdAt, '2026-09-18T00:00:00.000Z');
	assert.equal(allowed.source, 'user');

	const denied = ruleForChoice('reject-always', query, '2026-09-18T00:00:00.000Z');
	assert.ok(denied);
	assert.equal(denied.decision, 'deny');
});

test('recorded rules always match exactly, never by prefix', () => {
	// A prefix rule inferred from one approval would widen to every command
	// that merely starts with the same text.
	for (const choice of ['allow-always', 'reject-always'] as const) {
		assert.equal(ruleForChoice(choice, query, 'now')?.match, 'exact');
	}
});

test('always-command URI carries the id and scoped choice', () => {
	const uri = alwaysCommandUri('42', 'allow-always');
	assert.ok(uri.startsWith(`command:${PERMISSION_ALWAYS_COMMAND}?`));
	const payload = JSON.parse(decodeURIComponent(uri.slice(uri.indexOf('?') + 1)));
	assert.deepEqual(payload, ['42', 'allow-always']);
});

test('scoped allow choices record their scope', () => {
	const turn = ruleForChoice('allow-turn', query, 'now', 'turn-7');
	assert.ok(turn);
	assert.equal(turn.scope, 'turn');
	assert.equal(turn.turnId, 'turn-7');
	assert.equal(turn.decision, 'allow');

	const session = ruleForChoice('allow-session', query, 'now');
	assert.ok(session);
	assert.equal(session.scope, 'session');
	assert.equal(session.turnId, undefined);

	const always = ruleForChoice('allow-always', query, 'now');
	assert.ok(always);
	assert.equal(always.scope, 'always');
});

test('parseAlwaysCommandArgs accepts scoped choices and rejects once/legacy values', () => {
	assert.deepEqual(parseAlwaysCommandArgs(['7', 'allow-turn']), { id: '7', choice: 'allow-turn' });
	assert.deepEqual(parseAlwaysCommandArgs(['7', 'allow-session']), { id: '7', choice: 'allow-session' });
	assert.deepEqual(parseAlwaysCommandArgs(['7', 'allow-always']), { id: '7', choice: 'allow-always' });
	assert.equal(parseAlwaysCommandArgs(['7', 'allow']), undefined);
	assert.equal(parseAlwaysCommandArgs(['7', 'deny']), undefined);
	assert.equal(parseAlwaysCommandArgs([7, 'allow-always']), undefined);
});
