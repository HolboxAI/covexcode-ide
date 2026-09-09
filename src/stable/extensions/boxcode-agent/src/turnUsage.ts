/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { SessionUpdate } from './acpClient';

/**
 * Accumulates one turn's `usage_update` ACP session updates into the single
 * token-count footnote the chat shows when the turn ends.
 *
 * Wire source: boxcode's `SessionUpdate::UsageUpdate { used, size }`
 * (`protocol.rs`), one per LLM response -- a multi-response turn (an agent
 * loop with tool calls) therefore emits several per turn. `used` is
 * per-response token spend (per that variant's own doc comment, the closest
 * proxy ACP's `usage_update` has to billing), so this *sums* across the
 * turn; if boxcode ever starts emitting cumulative totals instead, this is
 * the one line to revisit. `size` is context-window occupancy, which boxcode
 * currently always sends as `0` (it doesn't track the model's context limit
 * anywhere yet) -- the footnote omits the "of N" half until a real value
 * arrives.
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

export function createTurnUsage(): TurnUsage {
	let used = 0;
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
			// boxcode whose version may not match this client.
			if (typeof update.used !== 'number' || !Number.isFinite(update.used) || update.used < 0) {
				return;
			}
			used += update.used;
			if (typeof update.size === 'number' && Number.isFinite(update.size) && update.size > size) {
				size = update.size;
			}
			seen = true;
		},
		footnote() {
			if (!seen) {
				return undefined;
			}
			return size > 0
				? `${groupDigits(used)} of ${groupDigits(size)} tokens this turn`
				: `${groupDigits(used)} tokens this turn`;
		},
	};
}

/**
 * Locale-independent thousands grouping ("12345" -> "12,345") -- the
 * footnote goes through `stream.markdown()` as chat text, so the number
 * must render identically on every machine, not per the user's locale.
 */
function groupDigits(value: number): string {
	return Math.trunc(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
