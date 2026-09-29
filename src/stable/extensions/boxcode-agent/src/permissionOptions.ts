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
export type PromptChoice = 'allow' | 'allow-always' | 'reject' | 'reject-always';

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
): PermissionRule | undefined {
	const option = permissionOptionFor(choice);
	if (option === undefined || !option.remember || option.decision === undefined) {
		return undefined;
	}
	return {
		kind: query.kind,
		match: 'exact',
		pattern: query.action,
		decision: option.decision,
		createdAt,
		source: 'user',
	};
}

/**
 * Command that records an "always" choice.
 *
 * This is a second command rather than a new argument to
 * `boxcode.permission.respond` on purpose: the existing two-valued command and
 * its parser stay untouched, so the four-way prompt is additive and the
 * regression surface stays small.
 */
export const PERMISSION_ALWAYS_COMMAND = 'boxcode.permission.respondAlways';

/** Command link for an "always" choice, mirroring `permissionCommandUri`'s format. */
export function alwaysCommandUri(id: string, decision: PermissionDecision): string {
	const encoded = encodeURIComponent(JSON.stringify([id, decision]));
	return `command:${PERMISSION_ALWAYS_COMMAND}?${encoded}`;
}
