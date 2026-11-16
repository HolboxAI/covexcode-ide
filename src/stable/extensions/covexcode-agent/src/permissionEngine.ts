/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { PermissionRule } from './permissionStore';

/**
 * The rule matcher and policy evaluator for the approval gate.
 *
 * Deliberately `vscode`-free and string-only so it is unit-testable on every
 * host OS: it never uses `path.join`/`path.sep`/`path.isAbsolute`, and both
 * path separators (`/` and `\`) are handled explicitly in the prefix boundary
 * logic below.
 */

export type PolicyDecision = 'allow' | 'ask' | 'deny';

export interface ResourceToCheck {
	/** The tool call kind from the CLI, e.g. `file_write`, `run_command`, `mcp`. */
	kind: string;
	/** The specific target, e.g. `npm install` or `src/App.tsx`. */
	target: string;
}

export interface EvaluationContext {
	turnId: string;
	sessionId: string;
}

export const FILE_TARGET_KINDS = new Set([
	'file_write',
	'file_edit',
	'file_read',
	'file_delete',
	'write',
	'edit',
	'read',
]);

/** Tool call kinds that only perform safe, read-only inspection. */
export const READ_ONLY_KINDS = new Set([
	'file_read',
	'read',
	'read_file',
	'list_directory',
	'list_dir',
	'dir_list',
	'search',
	'glob',
	'grep',
]);

/** Safe inspection commands that produce no side-effects and can be auto-approved. */
export const SAFE_INSPECTION_COMMANDS = [
	'git status',
	'git diff',
	'git log',
	'git branch',
	'git show',
	'git tag',
	'git rev-parse',
	'git describe',
	'git remote',
	'pwd',
	'which',
	'whoami',
	'node -v',
	'node --version',
	'npm -v',
	'npm --version',
	'python -V',
	'python --version',
	'python3 -V',
	'python3 --version',
];

/** Shell control, chaining, redirection, or substitution tokens that disqualify command auto-approval. */
const DANGEROUS_SHELL_TOKENS = /[;&|><$`\n\r]/;

/** Command prefixes that would chain a second command, so a prefix rule must
 * not match across them. */
const SHELL_CHAIN_START = /^(?:&&|\|\||;|\||&)/;

export function isFileTarget(kind: string): boolean {
	return FILE_TARGET_KINDS.has(kind);
}

/** Check whether a command string is a safe, read-only inspection command with no shell chaining. */
export function isReadOnlyCommand(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed.length === 0) {
		return false;
	}
	if (DANGEROUS_SHELL_TOKENS.test(trimmed)) {
		return false;
	}
	for (const safeCmd of SAFE_INSPECTION_COMMANDS) {
		if (trimmed === safeCmd) {
			return true;
		}
		if (trimmed.startsWith(safeCmd)) {
			const nextChar = trimmed[safeCmd.length];
			if (nextChar === ' ' || nextChar === '\t') {
				return true;
			}
		}
	}
	return false;
}

/** Check whether an operation represents a safe read-only resource. */
export function isReadOnlyResource(resource: ResourceToCheck): boolean {
	const kind = resource.kind.toLowerCase();
	if (READ_ONLY_KINDS.has(kind)) {
		return true;
	}
	if (kind === 'file_write' || kind === 'file_edit' || kind === 'file_delete' || kind === 'write' || kind === 'edit' || kind === 'delete') {
		return false;
	}
	return isReadOnlyCommand(resource.target);
}

function normalize(value: string, file: boolean): string {
	return file ? value.toLowerCase() : value;
}

/**
 * A prefix only matches at a word/path boundary: the character after the
 * prefix must be a space, slash, backslash, or end-of-string -- or the prefix
 * itself must already end in a separator (e.g. `src\`), which is the common
 * "everything under this directory" shape.
 */
function boundaryAfterPrefix(prefix: string, target: string, file: boolean): boolean {
	const p = normalize(prefix, file);
	const t = normalize(target, file);
	if (!t.startsWith(p)) {
		return false;
	}
	if (p.length === t.length) {
		return true; // the prefix is the whole target
	}
	const next = t[p.length];
	if (next === ' ' || next === '/' || next === '\\') {
		// For a command, a space boundary must not hide a chained command:
		// `npm test` must not match `npm test && rm -rf /`.
		if (!file && next === ' ') {
			const remainder = t.slice(p.length + 1);
			if (SHELL_CHAIN_START.test(remainder)) {
				return false;
			}
		}
		return true;
	}
	// The next character is not a separator, but a trailing separator on the
	// prefix itself is already a boundary: `src\` -> `src\components\...`.
	return p.endsWith('/') || p.endsWith('\\');
}

function ruleMatchesResource(rule: PermissionRule, resource: ResourceToCheck): boolean {
	if (rule.kind.length > 0 && rule.kind !== resource.kind) {
		return false;
	}
	const file = isFileTarget(resource.kind);

	if (rule.pattern === '*') {
		return true;
	}

	if (rule.match === 'prefix') {
		return boundaryAfterPrefix(rule.pattern, resource.target, file);
	}

	// `exact` is the default and the safe reading of an absent `match`.
	return normalize(rule.pattern, file) === normalize(resource.target, file);
}

function ruleValidForContext(rule: PermissionRule, context: EvaluationContext): boolean {
	switch (rule.scope ?? 'always') {
		case 'always':
			return true;
		case 'session':
			return rule.sessionId === context.sessionId;
		case 'turn':
			return rule.turnId === context.turnId;
		case 'once':
			// Consumed elsewhere; still a valid grant at evaluation time.
			return true;
		default:
			return true;
	}
}

/**
 * Evaluate the stored rules against an incoming resource and return the
 * decision the approval gate should take: `allow`/`deny` immediately, or
 * `ask` when nothing (or only an `ask`-shaped rule) matches.
 *
 * Precedence is DENY > ASK > ALLOW across every matching rule, so a specific
 * allow never overrides a less-specific deny. A deny match returns immediately
 * because nothing outranks it.
 */
export function evaluatePermission(
	resource: ResourceToCheck,
	rules: readonly PermissionRule[],
	context: EvaluationContext,
): PolicyDecision {
	let decision: PolicyDecision = 'ask';
	for (const rule of rules) {
		if (!ruleValidForContext(rule, context)) {
			continue;
		}
		if (!ruleMatchesResource(rule, resource)) {
			continue;
		}
		if (rule.decision === 'deny') {
			return 'deny';
		}
		if (rule.decision === 'allow') {
			decision = 'allow';
		}
	}
	if (decision === 'ask' && isReadOnlyResource(resource)) {
		return 'allow';
	}
	return decision;
}
