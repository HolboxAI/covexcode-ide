/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { SessionUpdate } from './acpClient';
import { groupDigits } from './turnUsage';

/**
 * Session-scoped sibling of `turnUsage`: the same `usage_update` events that
 * power the per-turn footnote are summed here into one running total for the
 * whole ACP session, so the end-of-turn footer can show a cumulative
 * "N tokens this session" (and an estimated `~$` cost) rather than only the
 * per-turn count.
 *
 * Lifetime differs from `TurnUsage` on purpose: a `TurnUsage` is created
 * fresh per chat request; a `SessionUsage` is created once per extension host
 * and `reset()` whenever the ACP session is torn down (new chat, cwd change,
 * provider change, crash) -- see `discardSession()` in extension.ts.
 *
 * Cost is the "estimated" half of the backlog's cost/usage meter item. ACP's
 * `usage_update` reports one combined `used` token count -- no input/output
 * split, no price -- so this is a *blended* estimate from a caller-supplied
 * USD-per-1M-tokens rate, never a claim of invoice accuracy. The truthful
 * per-model figure has to come from boxcode itself (see `docs/BACKLOG.md`,
 * "A truthful, always-visible cost/usage meter").
 */
export interface SessionUsage {
	/** Feed every session update; non-`usage_update`s are ignored, and the
	 * same defensive `used` parse as `turnUsage` applies. */
	record(update: SessionUpdate): void;
	/** Running token total across the current session. */
	total(): number;
	/** Zero the total -- called when the session is discarded. */
	reset(): void;
}

export function createSessionUsage(): SessionUsage {
	let used = 0;
	return {
		record(update) {
			if (update.sessionUpdate !== 'usage_update') {
				return;
			}
			if (typeof update.used !== 'number' || !Number.isFinite(update.used) || update.used < 0) {
				return;
			}
			used += update.used;
		},
		total() {
			return used;
		},
		reset() {
			used = 0;
		},
	};
}

/**
 * The session footer text, or `undefined` when the session has recorded no
 * usage yet (no "0 tokens this session" line before the first real spend).
 *
 * `costPerMillionTokens` is a blended USD price per 1M tokens; when absent
 * (unknown provider, or cost display disabled) the footer is tokens-only
 * rather than fabricating a dollar figure.
 */
export function sessionUsageFootnote(totalTokens: number, costPerMillionTokens?: number): string | undefined {
	if (totalTokens <= 0) {
		return undefined;
	}
	const tokens = `${groupDigits(totalTokens)} tokens this session`;
	if (costPerMillionTokens === undefined) {
		return tokens;
	}
	const cost = (totalTokens * costPerMillionTokens) / 1_000_000;
	return `${tokens} · ~${formatDollars(cost)}`;
}

/**
 * A USD estimate rendered at a precision honest to its magnitude -- whole
 * dollars to cents, cents to four decimals, sub-cent to six -- `$1.25`,
 * `$0.035`, `$0.00035`, never a misleading `$0.00`.
 */
function formatDollars(usd: number): string {
	const decimals = usd >= 1 ? 2 : usd >= 0.01 ? 4 : 6;
	const value = usd.toFixed(decimals);
	const trimmed = decimals === 2 ? value : value.replace(/0+$/, '').replace(/\.$/, '');
	return `$${trimmed}`;
}
