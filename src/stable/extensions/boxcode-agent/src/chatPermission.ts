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
 * same turn. This gate is the waiter those command clicks resolve.
 */

export const PERMISSION_COMMAND = 'boxcode.permission.respond';

export type PermissionChoice = 'allow' | 'reject' | 'cancelled';

export class PermissionGate {
	private nextId = 1;
	private readonly pending = new Map<string, (choice: PermissionChoice) => void>();

	create(): { id: string; wait: Promise<PermissionChoice> } {
		const id = String(this.nextId++);
		let resolve!: (choice: PermissionChoice) => void;
		const wait = new Promise<PermissionChoice>(r => {
			resolve = r;
		});
		this.pending.set(id, resolve);
		return { id, wait };
	}

	respond(id: unknown, choice: unknown): boolean {
		if (typeof id !== 'string') {
			return false;
		}
		if (choice !== 'allow' && choice !== 'reject' && choice !== 'cancelled') {
			return false;
		}
		const resolve = this.pending.get(id);
		if (!resolve) {
			return false;
		}
		this.pending.delete(id);
		resolve(choice);
		return true;
	}

	cancelAll(): void {
		for (const [id, resolve] of this.pending) {
			this.pending.delete(id);
			resolve('cancelled');
		}
	}

	get size(): number {
		return this.pending.size;
	}
}

export function parsePermissionCommandArgs(args: unknown[]): { id: string; choice: PermissionChoice } | undefined {
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

export function permissionOutcomeFromGate(
	choice: PermissionChoice,
	allow: PermissionOption | undefined,
	reject: PermissionOption | undefined,
): RequestPermissionOutcome {
	if (choice === 'allow') {
		return permissionOutcomeFromChoice(allow?.name ?? 'Allow', allow, reject);
	}
	if (choice === 'reject') {
		return permissionOutcomeFromChoice(reject?.name ?? 'Reject', allow, reject);
	}
	return { outcome: 'cancelled' };
}

export function permissionCommandUri(id: string, choice: 'allow' | 'reject'): string {
	const encoded = encodeURIComponent(JSON.stringify([id, choice]));
	return `command:${PERMISSION_COMMAND}?${encoded}`;
}
