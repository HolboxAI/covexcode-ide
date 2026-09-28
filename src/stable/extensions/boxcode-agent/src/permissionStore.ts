/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Incremental permission store.
 *
 * Today `PermissionGate` (`chatPermission.ts`) is per-session and entirely
 * in-memory: approve the same command twice in one sitting and the user is
 * asked twice, and quitting the window forgets every choice. This module is
 * the persistent half -- the accumulated "different permissions asked for so
 * far" that a session builds up and the next session inherits.
 *
 * Deliberately free of any `vscode` import so the decision logic is testable
 * with `node --test` (see `permissionStore.test.ts`), which is the same split
 * `workspaceTrust.ts` and `chatPermission.ts` already use. Reading and writing
 * the file stays in `extension.ts`; this module only ever sees strings.
 *
 * Security model (deny-by-default, and deny always wins):
 *
 *  - The store can only ever answer a request the agent already raised. It
 *    cannot grant a tool the CLI never asked about, so it widens the set of
 *    auto-approved calls, never the set of available ones.
 *  - A `deny` rule shadows an `allow` rule for the same action regardless of
 *    the order rules appear in the file. Order is not load-bearing, so a
 *    hand-edited file cannot silently re-enable something by moving a line.
 *  - Matching defaults to `exact`. `prefix` has to be asked for explicitly,
 *    because a prefix rule like `rm` is a footgun that silently covers
 *    `rm -rf ~`. Substring matching is intentionally not offered at all.
 *  - Every rule records when it was created and where it came from, so
 *    auto-granted access is auditable after the fact.
 */

/** Bumped only on a breaking change to the on-disk shape. */
export const PERMISSION_STORE_VERSION = 1;

/** Workspace-relative, so the file is inspectable and diffable next to the code it governs. */
export const PERMISSION_STORE_RELATIVE_PATH = '.boxcode/permissions.json';

export type PermissionDecision = 'allow' | 'deny';

/**
 * `exact` compares the whole action string; `prefix` compares the start of it.
 * There is no `contains`: a substring rule is too easy to satisfy by accident.
 */
export type PermissionMatch = 'exact' | 'prefix';

export interface PermissionRule {
	/** Tool-call kind this rule governs (e.g. `execute`). An empty kind matches any. */
	kind: string;
	match: PermissionMatch;
	pattern: string;
	decision: PermissionDecision;
	/** ISO-8601, set when the user granted it. */
	createdAt: string;
	/** `user` means a human clicked "Always allow". Reserved for future automated sources. */
	source: 'user';
}

export interface PermissionStoreFile {
	version: number;
	rules: readonly PermissionRule[];
}

/** What the agent is asking about -- the lookup key for `decide`. */
export interface PermissionQuery {
	kind: string;
	action: string;
}

export function emptyPermissionStore(): PermissionStoreFile {
	return { version: PERMISSION_STORE_VERSION, rules: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDecision(value: unknown): PermissionDecision | undefined {
	return value === 'allow' || value === 'deny' ? value : undefined;
}

function parseMatch(value: unknown): PermissionMatch {
	// Absent or unrecognised means the safe reading: exact.
	return value === 'prefix' ? 'prefix' : 'exact';
}

/**
 * Coerce one parsed rule, or `undefined` if it is not usable. Malformed rules
 * are dropped rather than repaired -- a rule we cannot fully understand is a
 * rule we must not honour, and silently guessing at a half-written permission
 * is exactly how a hand-edited file grants something nobody meant to grant.
 */
function parseRule(value: unknown): PermissionRule | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const decision = parseDecision(value.decision);
	const pattern = value.pattern;
	if (decision === undefined || typeof pattern !== 'string' || pattern.length === 0) {
		return undefined;
	}
	const kind = typeof value.kind === 'string' ? value.kind : '';
	const createdAt = typeof value.createdAt === 'string' ? value.createdAt : '';
	// `source` is not user-checked: an unrecognised source is treated as `user`.
	// It is descriptive metadata for auditing, not an access-control input, so
	// being lenient here cannot widen what the store will approve.
	return { kind, match: parseMatch(value.match), pattern, decision, createdAt, source: 'user' };
}

/**
 * Parse store contents. Never throws: unreadable JSON yields an empty store,
 * because a corrupt permission file must fail closed (no rules, so the user is
 * prompted as normal) rather than crash the chat request that is mid-flight.
 */
export function parsePermissionStore(raw: string): PermissionStoreFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return emptyPermissionStore();
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.rules)) {
		return emptyPermissionStore();
	}
	const rules: PermissionRule[] = [];
	for (const entry of parsed.rules) {
		const rule = parseRule(entry);
		if (rule) {
			rules.push(rule);
		}
	}
	const version = typeof parsed.version === 'number' ? parsed.version : PERMISSION_STORE_VERSION;
	return { version, rules };
}

export function serializePermissionStore(file: PermissionStoreFile): string {
	return `${JSON.stringify({ version: PERMISSION_STORE_VERSION, rules: file.rules }, undefined, 2)}\n`;
}

function ruleMatches(rule: PermissionRule, query: PermissionQuery): boolean {
	// An empty kind is a wildcard so a hand-written rule can cover every tool.
	if (rule.kind.length > 0 && rule.kind !== query.kind) {
		return false;
	}
	return rule.match === 'prefix' ? query.action.startsWith(rule.pattern) : query.action === rule.pattern;
}

/**
 * The persisted decisions for a workspace, plus the lookup that turns them
 * into an answer.
 */
export class PermissionStore {
	private rules: PermissionRule[];

	constructor(rules: readonly PermissionRule[] = []) {
		this.rules = [...rules];
	}

	static fromFile(raw: string): PermissionStore {
		return new PermissionStore(parsePermissionStore(raw).rules);
	}

	/**
	 * `deny` if any deny rule matches, else `allow` if any allow rule matches,
	 * else `undefined` for "nobody has decided -- ask the user".
	 *
	 * Deny is resolved first across the whole rule set rather than by scanning
	 * in file order, so a deny can never be shadowed by an allow that happens
	 * to appear earlier.
	 */
	decide(query: PermissionQuery): PermissionDecision | undefined {
		if (this.rules.some(rule => rule.decision === 'deny' && ruleMatches(rule, query))) {
			return 'deny';
		}
		if (this.rules.some(rule => rule.decision === 'allow' && ruleMatches(rule, query))) {
			return 'allow';
		}
		return undefined;
	}

	/**
	 * Record a decision. Re-granting the same decision on the same key replaces
	 * the existing rule instead of appending a duplicate, so a long session
	 * cannot grow the file without bound. Returns whether anything changed.
	 */
	addRule(rule: PermissionRule): boolean {
		const existing = this.rules.findIndex(
			other => other.kind === rule.kind && other.match === rule.match && other.pattern === rule.pattern,
		);
		if (existing >= 0) {
			if (this.rules[existing].decision === rule.decision) {
				return false;
			}
			this.rules[existing] = rule;
			return true;
		}
		this.rules.push(rule);
		return true;
	}

	/** Remove by index, as listed by `list()`. Returns the removed rule. */
	removeAt(index: number): PermissionRule | undefined {
		if (!Number.isInteger(index) || index < 0 || index >= this.rules.length) {
			return undefined;
		}
		return this.rules.splice(index, 1)[0];
	}

	clear(): void {
		this.rules = [];
	}

	list(): readonly PermissionRule[] {
		return [...this.rules];
	}

	get size(): number {
		return this.rules.length;
	}

	toFile(): PermissionStoreFile {
		return { version: PERMISSION_STORE_VERSION, rules: this.list() };
	}
}

/** Short label for a rule, for the revoke quick pick. */
export function describeRule(rule: PermissionRule): string {
	const verb = rule.decision === 'allow' ? 'Allow' : 'Deny';
	const scope = rule.kind.length > 0 ? rule.kind : 'any tool';
	const how = rule.match === 'prefix' ? 'starts with' : 'is';
	return `${verb} ${scope} where action ${how} "${rule.pattern}"`;
}
