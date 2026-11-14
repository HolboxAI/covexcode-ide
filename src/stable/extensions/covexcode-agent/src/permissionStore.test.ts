import assert from 'node:assert/strict';
import test from 'node:test';

import {
	PermissionStore,
	EMPTY_STATE_MESSAGE,
	describeRule,
	escapeHtml,
	filterAlwaysRules,
	parsePermissionStore,
	renderRulesHtml,
	serializeRules,
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

test('scoped rules round-trip through the file, preserving scope and turnId', () => {
	const store = new PermissionStore([rule({ scope: 'turn', turnId: 'C:\\turn\\7' })]);
	const restored = PermissionStore.fromFile(JSON.stringify(store.toFile()));
	const list = restored.list();
	assert.equal(list.length, 1);
	assert.equal(list[0].scope, 'turn');
	assert.equal(list[0].turnId, 'C:\\turn\\7');
});

test('clearTurnGrants removes only the matching turn grant', () => {
	const store = new PermissionStore([
		rule({ scope: 'turn', turnId: 'C:\\turn\\7' }),
		rule({ scope: 'turn', turnId: 'turn-8', pattern: 'other' }),
		rule({ scope: 'always' }),
	]);
	assert.equal(store.clearTurnGrants('C:\\turn\\7'), 1);
	assert.equal(store.list().length, 2);
	assert.ok(store.list().every(r => r.turnId !== 'C:\\turn\\7'));
});

test('clearSessionGrants removes session grants and leaves always/turn grants', () => {
	const store = new PermissionStore([
		rule({ scope: 'session' }),
		rule({ scope: 'always' }),
		rule({ scope: 'turn', turnId: 't1' }),
	]);
	assert.equal(store.clearSessionGrants(), 1);
	assert.equal(store.list().length, 2);
	assert.ok(store.list().every(r => r.scope !== 'session'));
});

test('clearOnceGrants removes single-use grants', () => {
	const store = new PermissionStore([
		rule({ scope: 'once' }),
		rule({ scope: 'always' }),
	]);
	assert.equal(store.clearOnceGrants(), 1);
	assert.equal(store.list().length, 1);
	assert.equal(store.list()[0].scope, 'always');
});

test('revoking a rule removes it from the store and the next getRules() call does not return it', () => {
	const r1 = rule({ id: 'rule-test-1', scope: 'always', pattern: 'npm test' });
	const r2 = rule({ id: 'rule-test-2', scope: 'always', pattern: 'npm run build' });
	const store = new PermissionStore([r1, r2]);

	assert.equal(store.getRules().length, 2);
	const removed = store.removeRule('rule-test-1');
	assert.ok(removed !== undefined);
	assert.equal(removed?.id, 'rule-test-1');

	const rulesAfter = store.getRules();
	assert.equal(rulesAfter.length, 1);
	assert.equal(rulesAfter[0].id, 'rule-test-2');
	assert.equal(rulesAfter[0].pattern, 'npm run build');

	// Attempting to remove non-existent rule returns undefined
	assert.equal(store.removeRule('non-existent-id'), undefined);
});

test('only "always" scope rules appear in the list (not "once", "turn", "session" rules)', () => {
	const store = new PermissionStore([
		rule({ id: 'r-once', scope: 'once', pattern: 'echo once' }),
		rule({ id: 'r-turn', scope: 'turn', pattern: 'echo turn', turnId: 't-1' }),
		rule({ id: 'r-session', scope: 'session', pattern: 'echo session' }),
		rule({ id: 'r-always-1', scope: 'always', pattern: 'npm test' }),
		rule({ id: 'r-default-always', pattern: 'git status' }), // undefined scope defaults to 'always'
	]);

	const allRules = store.getRules();
	assert.equal(allRules.length, 5);

	const alwaysRules = filterAlwaysRules(allRules);
	assert.equal(alwaysRules.length, 2);
	assert.equal(alwaysRules[0].id, 'r-always-1');
	assert.equal(alwaysRules[1].id, 'r-default-always');

	const serialized = serializeRules(allRules);
	assert.equal(serialized.length, 2);
	assert.ok(serialized.every(r => r.kind === 'execute'));
});

test('empty store renders the empty state message', () => {
	const html = renderRulesHtml([]);
	assert.ok(html.includes(EMPTY_STATE_MESSAGE));
	assert.ok(html.includes('No saved permissions. When you choose Always Allow on a tool request, it will appear here.'));
	assert.ok(!html.includes('<table>'));
});

test('Windows-style rule targets with backslashes and drive letters are preserved in serialization and rendering', () => {
	const winPath = 'C:\\Users\\test\\workspace\\build\\dist\\**';
	const store = new PermissionStore([
		rule({ id: 'win-rule', kind: 'file_write', pattern: winPath, scope: 'always' }),
	]);

	const serialized = serializeRules(store.getRules());
	assert.equal(serialized.length, 1);
	assert.equal(serialized[0].pattern, winPath);

	const html = renderRulesHtml(serialized);
	// Check that escaped html preserves the path characters and backslashes
	assert.ok(html.includes('C:\\Users\\test\\workspace\\build\\dist\\**'));
	assert.ok(html.includes('data-id="win-rule"'));
	assert.ok(html.includes('button class="revoke-btn"'));
});

test('showPermissionManager seam: onRevoke callback removes rule and triggers update', () => {
	const r1 = rule({ id: 'r1', scope: 'always', pattern: 'npm start' });
	const store = new PermissionStore([r1]);
	let saved = false;
	const context = {
		getRules: () => store.list(),
		onRevoke: (ruleId: string) => {
			const revoked = store.removeRule(ruleId);
			if (revoked) {
				saved = true;
			}
			return revoked;
		},
	};

	assert.equal(context.getRules().length, 1);
	const revoked = context.onRevoke('r1');
	assert.ok(revoked !== undefined);
	assert.equal(revoked?.pattern, 'npm start');
	assert.equal(saved, true);
	assert.equal(context.getRules().length, 0);
});

test('escapeHtml properly sanitizes untrusted inputs', () => {
	assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
	assert.equal(escapeHtml("a & b 'c'"), 'a &amp; b &#39;c&#39;');
});

