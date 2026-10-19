/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { PermissionOption, RequestPermissionOutcome } from './acpClient';

/**
 * Maps the Allow/Reject modal's return value onto ACP's
 * `session/request_permission` result.
 *
 * Clicking Reject used to fall through to `{ outcome: 'cancelled' }`, the
 * same payload as dismissing the modal. `cancelled` means "the user did not
 * answer"; `selected` with the reject option is what tells the agent the
 * write was refused, so it can stop rather than retry as if the prompt
 * never happened.
 */
export function permissionOutcomeFromChoice(
	choice: string | undefined,
	allow: PermissionOption | undefined,
	reject: PermissionOption | undefined,
): RequestPermissionOutcome {
	if (allow && choice === allow.name) {
		return { outcome: 'selected', optionId: allow.optionId };
	}
	if (reject && choice === reject.name) {
		return { outcome: 'selected', optionId: reject.optionId };
	}
	return { outcome: 'cancelled' };
}
