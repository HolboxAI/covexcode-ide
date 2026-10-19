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
