/**
 * The choices offered when the agent needs permission to act.
 *
 * Mirrors the four-way prompt Cursor and Claude Code put in front of you --
 * "Allow once" / "Allow always" / "Deny once" / "Deny always" -- rather than a
 * plain yes/no. The "always" choices are what make the permission store grow
 * incrementally over a session: `permissionStore.ts` holds the rules they leave
 * behind, and `extension.ts` consults those rules before prompting again.
 *
 * Two names here are deliberately prefixed `Prompt` rather than using the
 * obvious `PermissionChoice` / `PermissionOption`: both of those are already
 * taken by `chatPermission.ts` and `acpClient.ts` for different concepts (the
 * gate's two-valued resolution, and the ACP wire type the CLI sends). Reusing
 * them would collide on import.
 *
 * Kept free of `vscode` imports so it can be unit tested directly, following the
 * convention in `chatPermission.ts` and `workspaceTrust.ts`.
 */

import type { PermissionDecision, PermissionQuery, PermissionRule } from './permissionStore';

/** Every choice a user can make at a permission prompt. */
export type PromptChoice = 'allow' | 'allow-turn' | 'allow-session' | 'allow-always' | 'reject' | 'reject-always';

export interface PromptOption {
	choice: PromptChoice;
	label: string;
	/** Codicon name, rendered in the chat decision link. */
	icon: string;
	/** Whether this choice records a durable rule. */
	remember: boolean;
	/** The decision stored when `remember` is set. */
	decision?: PermissionDecision;
}

export const PERMISSION_OPTIONS: readonly PromptOption[] = [
	{ choice: 'allow', label: 'Allow once', icon: 'check', remember: false },
	{ choice: 'allow-turn', label: 'Allow for this turn', icon: 'history', remember: true, decision: 'allow' },
	{ choice: 'allow-session', label: 'Allow for this session', icon: 'sync', remember: true, decision: 'allow' },
	{ choice: 'allow-always', label: 'Allow always', icon: 'check-all', remember: true, decision: 'allow' },
	{ choice: 'reject', label: 'Deny once', icon: 'x', remember: false },
	{ choice: 'reject-always', label: 'Deny always', icon: 'circle-slash', remember: true, decision: 'deny' },
];

export function permissionOptionFor(choice: PromptChoice): PromptOption | undefined {
	return PERMISSION_OPTIONS.find(option => option.choice === choice);
}

/**
 * Build the durable rule a choice should record, or `undefined` for the "once"
 * choices, which by definition must not outlive the prompt.
 *
 * Matching is always `exact`. A permission file is a security boundary, and a
 * prefix rule inferred from a single approval would silently widen to every
 * command that merely starts with the same text.
 */
export function ruleForChoice(
	choice: PromptChoice,
	query: PermissionQuery,
	createdAt: string,
	turnId?: string,
): PermissionRule | undefined {
	const base = {
		kind: query.kind,
		match: 'exact' as const,
		pattern: query.action,
		createdAt,
		source: 'user' as const,
	};
	switch (choice) {
		case 'allow':
		case 'reject':
			// "Once" choices must not outlive the prompt.
			return undefined;
		case 'allow-turn':
			return { ...base, decision: 'allow', scope: 'turn', turnId };
		case 'allow-session':
			return { ...base, decision: 'allow', scope: 'session' };
		case 'allow-always':
			return { ...base, decision: 'allow', scope: 'always' };
		case 'reject-always':
			return { ...base, decision: 'deny', scope: 'always' };
	}
}

/**
 * Command that records an "always" choice.
 *
 * This is a second command rather than a new argument to
 * `covexcode.permission.respond` on purpose: the existing two-valued command and
 * its parser stay untouched, so the four-way prompt is additive and the
 * regression surface stays small.
 */
export const PERMISSION_ALWAYS_COMMAND = 'covexcode.permission.respondAlways';

/** Command link for an "always" choice, mirroring `permissionCommandUri`'s format. */
export function alwaysCommandUri(id: string, choice: PromptChoice): string {
	const encoded = encodeURIComponent(JSON.stringify([id, choice]));
	return `command:${PERMISSION_ALWAYS_COMMAND}?${encoded}`;
}

/**
 * Parses `covexcode.permission.respondAlways` arguments -- the gate id and a
 * scoped choice (turn / session / always). "Once" and reject stay on the
 * two-valued `covexcode.permission.respond` command.
 */
export function parseAlwaysCommandArgs(args: unknown[]): { id: string; choice: PromptChoice } | undefined {
	const id = args[0];
	const choice = args[1];
	if (typeof id !== 'string') {
		return undefined;
	}
	if (
		choice !== 'allow-turn' &&
		choice !== 'allow-session' &&
		choice !== 'allow-always' &&
		choice !== 'reject-always'
	) {
		return undefined;
	}
	return { id, choice };
}
