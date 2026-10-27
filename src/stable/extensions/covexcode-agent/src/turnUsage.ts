/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { SessionUpdate } from './acpClient';

/**
 * Accumulates one turn's `usage_update` ACP session updates into the single
 * token-count footnote the chat shows when the turn ends.
 *
 * Wire source: covexcode's `SessionUpdate::UsageUpdate { used, size,
 * prompt_tokens }` (`protocol.rs`), one per LLM response -- a multi-response
 * turn (an agent loop with tool calls) therefore emits several per turn.
 * `used` is the prompt + completion spend of *one* response, so summing it
 * across a turn gives the turn's spend, which can legitimately exceed the
 * context window: the window limits one request, not every request in the
 * turn combined. Comparing that sum to `size` is the bug this meter used to
 * have -- a twenty-request turn showed "2,500,000 of 131,072", which reads as
 * if the limit had been blown.
 *
 * `prompt_tokens` is the figure that actually occupies the window; `used`
 * includes the reply, so a single request used to read as 32k tokens fuller
 * than the context really was. The footnote compares the largest prompt to
 * `size`. Older covexcode builds send no `prompt_tokens`; those fall back to
 * the largest single request's `used`, which is at least per-request rather
 * than the turn sum.
 *
 * Consumed rather than rendered inline by `renderUpdate`: printing a count
 * per update would spam several numbers mid-stream, and the per-turn total
 * is the number that matters for the cost-visibility item this serves (see
 * `docs/BACKLOG.md`, "A truthful, always-visible cost/usage meter" -- this
 * is its first slice).
 */
export interface TurnUsage {
	/** Feed every session update of the turn; non-`usage_update`s are ignored. */
	record(update: SessionUpdate): void;
	/** The footnote text, or `undefined` if the turn reported no usage. */
	footnote(): string | undefined;
}

/** Report the context warning once the largest single request reaches this
 * share of the window. Deliberately below 100: the model can still be cut off
 * by its reply budget or tool results before a nominal 100% reading. */
const CONTEXT_WARNING_PERCENT = 90;

export function createTurnUsage(): TurnUsage {
	let spent = 0;
	let largestRequest = 0;
	let promptTokens = 0;
	let size = 0;
	let seen = false;
	return {
		record(update) {
			if (update.sessionUpdate !== 'usage_update') {
				return;
			}
			// Defensive reads, not trusted casts -- same posture as every
			// other field `renderUpdate` reads (see `SessionUpdate`'s own
			// doc comment): these arrive as unvalidated JSON from a spawned
			// covexcode whose version may not match this client.
			if (typeof update.used !== 'number' || !Number.isFinite(update.used) || update.used < 0) {
				return;
			}
			spent += update.used;
			if (update.used > largestRequest) {
				largestRequest = update.used;
			}
			if (
				typeof update.prompt_tokens === 'number' &&
				Number.isFinite(update.prompt_tokens) &&
				update.prompt_tokens > promptTokens
			) {
				promptTokens = update.prompt_tokens;
			}
			if (typeof update.size === 'number' && Number.isFinite(update.size) && update.size > size) {
				size = update.size;
			}
			seen = true;
		},
		footnote() {
			if (!seen) {
				return undefined;
			}
			const total = `${groupDigits(spent)} tokens spent this turn`;
			if (size <= 0) {
				return total;
			}
			// The prompt is what occupies the window. `used` includes the
			// reply, so comparing it to `size` overstates occupancy by the
			// reply's length -- the mistake behind "146,958 of 131,072".
			const context = promptTokens > 0 ? promptTokens : largestRequest;
			if (context <= 0) {
				return total;
			}
			const label =
				promptTokens > 0
					? `context ${groupDigits(context)} of ${groupDigits(size)}`
					: `largest request ${groupDigits(context)} of ${groupDigits(size)}`;
			const percent = (context / size) * 100;
			return percent >= CONTEXT_WARNING_PERCENT
				? `${total} · ${label} — context nearly full, start a new chat`
				: `${total} · ${label}`;
		},
	};
}

/**
 * Locale-independent thousands grouping ("12345" -> "12,345") -- the
 * footnote goes through `stream.markdown()` as chat text, so the number
 * must render identically on every machine, not per the user's locale.
 */
export function groupDigits(value: number): string {
	return Math.trunc(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
