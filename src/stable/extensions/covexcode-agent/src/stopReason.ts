/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { StopReason } from './acpClient';

/**
 * The one-sentence explanation the chat should add when a turn ended without
 * the model's normal final answer.
 *
 * `refusal` and `cancelled` deliberately return `undefined`: a refusal already
 * streamed its own error/refusal text, and a cancellation is the user's own
 * action. The two limits below are the cases that otherwise look like the
 * agent simply stopped after its last tool step.
 */
export function stopReasonNote(reason: StopReason): string | undefined {
	switch (reason) {
		case 'max_turn_requests':
			return 'covexcode stopped at the per-turn tool-step limit. Send "continue" to keep going.';
		case 'max_tokens':
			return 'The reply hit the output cap and was cut off. Send "continue" or raise max_tokens.';
		default:
			return undefined;
	}
}
