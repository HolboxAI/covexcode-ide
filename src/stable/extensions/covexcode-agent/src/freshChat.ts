/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * VS Code's "New Chat" action creates a request whose `ChatContext.history`
 * is empty. The first message of a conversation is also empty-history, which
 * is the same shape -- and the right time to open a fresh ACP session,
 * because there is no prior turn to continue.
 *
 * An in-progress thread has previous turns, so history is non-empty and the
 * existing `HeadlessSession` should be reused.
 */
export function isFreshChat(historyLength: number): boolean {
	return historyLength === 0;
}

/**
 * Whether this request should throw away the existing ACP session.
 *
 * `isFreshChat` alone is not enough: "Restore Checkpoint" removes the later
 * chat requests from the model, which can leave `history` empty even though
 * the user is continuing the same conversation. Discarding the ACP session
 * there is exactly the bug that made a resumed task answer "I don't have the
 * earlier session in front of me" -- the restore already truncated the
 * model's history on the covexcode side (`session/rollback` with
 * `restoreBeforeTurn`), so the session must survive the next prompt.
 */
export function shouldStartFreshSession(
	historyLength: number,
	isInline: boolean,
	restoredCheckpoint: boolean,
): boolean {
	return !isInline && isFreshChat(historyLength) && !restoredCheckpoint;
}
