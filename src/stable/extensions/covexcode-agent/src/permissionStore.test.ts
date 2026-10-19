import assert from 'node:assert/strict';
import test from 'node:test';

import {
	PermissionStore,
	describeRule,
	parsePermissionStore,
	type PermissionRule,
} from './permissionStore';

const query = { kind: 'execute', action: 'npm test' };

function rule(overrides: Partial<PermissionRule> = {}): PermissionRule {
	return {
		kind: 'execute',
		match: 'exact',
		pattern: 'npm test',
		decision: 'allow',
		createdAt: '2026-09-18T00:00:00.000Z',
		source: 'user',
		...overrides,
	};
}

test('an empty store decides nothing, so the user is still asked', () => {
	assert.equal(new PermissionStore().decide(query), undefined);
});

test('an allow rule short-circuits the same action, and only that action', () => {
	const store = new PermissionStore([rule()]);
	assert.equal(store.decide(query), 'allow');
	assert.equal(store.decide({ kind: 'execute', action: 'npm publish' }), undefined);
});

test('a deny rule reports deny', () => {
	const store = new PermissionStore([rule({ decision: 'deny' })]);
	assert.equal(store.decide(query), 'deny');
});

test('deny wins over allow regardless of rule order', () => {
	// The allow is added first on purpose: precedence must not depend on order.
	const allowFirst = new PermissionStore([rule(), rule({ decision: 'deny' })]);
	assert.equal(allowFirst.decide(query), 'deny');

	const denyFirst = new PermissionStore([rule({ decision: 'deny' }), rule()]);
	assert.equal(denyFirst.decide(query), 'deny');
});

test('matching is scoped by kind, so a rule cannot leak across tools', () => {
	const store = new PermissionStore([rule({ kind: 'execute' })]);
	assert.equal(store.decide({ kind: 'write', action: 'npm test' }), undefined);
});

test('exact matching does not substring-match, so rm is not widened', () => {
	const store = new PermissionStore([rule({ pattern: 'rm', decision: 'allow' })]);
	assert.equal(store.decide({ kind: 'execute', action: 'rm' }), 'allow');
	assert.equal(store.decide({ kind: 'execute', action: 'rm -rf /' }), undefined);
});

test('re-granting the same key replaces rather than duplicates', () => {
	const store = new PermissionStore();
	assert.equal(store.addRule(rule()), true);
	assert.equal(store.addRule(rule()), false, 'identical rule is a no-op');
	assert.equal(store.size, 1);

	// A changed decision on the same key is an update, not a second rule.
	assert.equal(store.addRule(rule({ decision: 'deny' })), true);
	assert.equal(store.size, 1);
	assert.equal(store.decide(query), 'deny');
});

test('a long session cannot grow the store without bound', () => {
	const store = new PermissionStore();
	for (let i = 0; i < 50; i += 1) {
		store.addRule(rule({ decision: i % 2 === 0 ? 'allow' : 'deny' }));
	}
	assert.equal(store.size, 1);
});

test('removeAt revokes a rule and rejects nonsense indices', () => {
	const store = new PermissionStore([rule()]);
	assert.equal(store.removeAt(0)?.pattern, 'npm test');
	assert.equal(store.size, 0);
	assert.equal(store.removeAt(0), undefined);
	assert.equal(store.removeAt(-1), undefined);
	assert.equal(store.removeAt(1.5), undefined);
});

test('toFile round-trips through parsePermissionStore', () => {
	const store = new PermissionStore([rule()]);
	const text = JSON.stringify(store.toFile());
	const restored = PermissionStore.fromFile(text);
	assert.equal(restored.decide(query), 'allow');
	assert.deepEqual(restored.list(), store.list());
});

test('a malformed permission file degrades to empty instead of throwing', () => {
	// Losing a remembered rule is recoverable -- the user is asked again. Throwing
	// here would take out the whole chat session, so an unreadable file must not.
	for (const bad of ['', 'not json', '{}', '[]', '{"version":1}', '{"rules":"nope"}']) {
		assert.equal(PermissionStore.fromFile(bad).size, 0, `parsed ${JSON.stringify(bad)}`);
	}
});

test('rules from a file with junk entries are dropped, keeping the valid ones', () => {
	const raw = JSON.stringify({
		version: 1,
		rules: [rule(), { nope: true }, null, { kind: 'execute', match: 'exact', pattern: 'p', decision: 'wat' }],
	});
	const parsed = parsePermissionStore(raw);
	assert.equal(parsed.rules.length, 1);
	assert.equal(parsed.rules[0].pattern, 'npm test');
});

test('describeRule reads as a sentence for the revoke picker', () => {
	assert.equal(describeRule(rule()), 'Allow execute where action is "npm test"');
	assert.equal(describeRule(rule({ decision: 'deny' })), 'Deny execute where action is "npm test"');
	assert.equal(
		describeRule(rule({ match: 'prefix' })),
		'Allow execute where action starts with "npm test"',
	);
});
