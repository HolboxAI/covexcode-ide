/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { PermissionOption, RequestPermissionOutcome } from './acpClient';
import { permissionOutcomeFromChoice } from './permissionOutcome';

/**
 * Allow/Reject used to be `showWarningMessage({ modal: true })` -- a
 * system-level center-screen dialog outside the chat panel. ACP's
 * `session/request_permission` arrives *while* `session/prompt` is still
 * awaiting, so the chat participant's requestHandler cannot return and
 * wait for a follow-up ChatRequest: VS Code keeps Send disabled until that
 * handler settles, and a `stream.confirmation()` click that sends a new
 * request would deadlock.
 *
 * The way through is a command the in-chat markdown links invoke on the
 * same turn. This gate is the waiter those command clicks resolve. A
 * `partial` answer is the per-hunk review path: the review command resolves
 * the same gate, but carries the merged file text back instead of a bare
 * allow/reject, so boxcode writes the partially-accepted result (see
 * `diffReview.ts`).
 */

export const PERMISSION_COMMAND = 'boxcode.permission.respond';
export const REVIEW_COMMAND = 'boxcode.permission.review';

export type PermissionChoice = 'allow' | 'reject' | 'cancelled' | 'partial';

export interface PermissionAnswer {
	choice: PermissionChoice;
	/** Present only for a `partial` answer -- the merged file text. */
	newText?: string;
}

export class PermissionGate {
	private nextId = 1;
	private readonly pending = new Map<string, (answer: PermissionAnswer) => void>();

	create(): { id: string; wait: Promise<PermissionAnswer> } {
		const id = String(this.nextId++);
		let resolve!: (answer: PermissionAnswer) => void;
		const wait = new Promise<PermissionAnswer>(r => {
			resolve = r;
		});
		this.pending.set(id, resolve);
		return { id, wait };
	}

	respond(id: unknown, choice: unknown, newText?: unknown): boolean {
		if (typeof id !== 'string') {
			return false;
		}
		if (choice !== 'allow' && choice !== 'reject' && choice !== 'cancelled' && choice !== 'partial') {
			return false;
		}
		const resolve = this.pending.get(id);
		if (!resolve) {
			return false;
		}
		this.pending.delete(id);
		const answer: PermissionAnswer = { choice };
		if (typeof newText === 'string') {
			answer.newText = newText;
		}
		resolve(answer);
		return true;
	}

	cancelAll(): void {
		for (const [id, resolve] of this.pending) {
			this.pending.delete(id);
			resolve({ choice: 'cancelled' });
		}
	}

	get size(): number {
		return this.pending.size;
	}
}

export function parsePermissionCommandArgs(args: unknown[]): { id: string; choice: 'allow' | 'reject' } | undefined {
	const id = args[0];
	const choice = args[1];
	if (typeof id !== 'string') {
		return undefined;
	}
	if (choice !== 'allow' && choice !== 'reject') {
		return undefined;
	}
	return { id, choice };
}

/**
 * Parses the review command's arguments -- just the gate id; the merged text
 * comes from the QuickPick the command opens, not from the link itself.
 */
export function parseReviewCommandArgs(args: unknown[]): string | undefined {
	const id = args[0];
	return typeof id === 'string' ? id : undefined;
}

export function permissionOutcomeFromGate(
	answer: PermissionAnswer,
	allow: PermissionOption | undefined,
	reject: PermissionOption | undefined,
): RequestPermissionOutcome {
	if (answer.choice === 'allow') {
		return permissionOutcomeFromChoice(allow?.name ?? 'Allow', allow, reject);
	}
	if (answer.choice === 'reject') {
		return permissionOutcomeFromChoice(reject?.name ?? 'Reject', allow, reject);
	}
	if (answer.choice === 'partial' && answer.newText !== undefined) {
		return { outcome: 'partial', newText: answer.newText };
	}
	return { outcome: 'cancelled' };
}

export function permissionCommandUri(id: string, choice: 'allow' | 'reject'): string {
	const encoded = encodeURIComponent(JSON.stringify([id, choice]));
	return `command:${PERMISSION_COMMAND}?${encoded}`;
}

export function reviewCommandUri(id: string): string {
	const encoded = encodeURIComponent(JSON.stringify([id]));
	return `command:${REVIEW_COMMAND}?${encoded}`;
}
