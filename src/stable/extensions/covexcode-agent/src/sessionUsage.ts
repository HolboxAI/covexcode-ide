/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { SessionUpdate } from './acpClient';
import { groupDigits } from './turnUsage';

/**
 * Visual circle indicator state for session context tokens.
 * Matches Antigravity / modern AI IDEs:
 * - When very empty (< 5%): hidden (undefined)
 * - Normal / active (5% - 79%): blue filled circle with remaining tokens
 * - Almost full (>= 80%): red filled circle warning limit is approaching
 * - Full (100%): limit reached
 */
export interface SessionCircleMeter {
	readonly icon: string;
	readonly text: string;
	readonly tooltip: string;
	readonly colorTheme: 'blue' | 'red';
	readonly percent: number;
	readonly tokensLeft: number;
}

/**
 * Session-scoped sibling of `turnUsage`: the same `usage_update` events that
 * power the per-turn footnote are summed here into one running total for the
 * whole ACP session, and tracked against context window size for the circular
 * tokens-remaining indicator.
 */
export interface SessionUsage {
	/** Feed every session update; non-`usage_update`s are ignored. */
	record(update: SessionUpdate): void;
	/** Running token total across the current session. */
	total(): number;
	/** Current occupancy of the session context window in tokens. */
	contextUsed(): number;
	/** Context limit in tokens. */
	contextLimit(): number;
	/**
	 * Circular status indicator for session tokens remaining:
	 * returns undefined when empty, blue when active, red when >= 80% full.
	 */
	circleMeter(fallbackLimit?: number): SessionCircleMeter | undefined;
	/** Zero the total -- called when the session is discarded. */
	reset(): void;
}

export function createSessionUsage(): SessionUsage {
	let used = 0;
	let currentContext = 0;
	let limit = 0;

	return {
		record(update) {
			if (update.sessionUpdate !== 'usage_update') {
				return;
			}
			if (typeof update.used === 'number' && Number.isFinite(update.used) && update.used >= 0) {
				used += update.used;
			}
			if (typeof update.size === 'number' && Number.isFinite(update.size) && update.size > 0) {
				limit = update.size;
			}
			const prompt = typeof update.prompt_tokens === 'number' && Number.isFinite(update.prompt_tokens) && update.prompt_tokens > 0
				? update.prompt_tokens
				: (typeof update.used === 'number' && Number.isFinite(update.used) ? update.used : 0);
			if (prompt > currentContext) {
				currentContext = prompt;
			}
		},
		total() {
			return used;
		},
		contextUsed() {
			return currentContext;
		},
		contextLimit() {
			return limit;
		},
		circleMeter(fallbackLimit = 128_000): SessionCircleMeter | undefined {
			const effectiveLimit = limit > 0 ? limit : fallbackLimit;
			if (currentContext <= 0 || effectiveLimit <= 0) {
				return undefined;
			}
			const ratio = currentContext / effectiveLimit;
			// When very empty (< 5%), do not show
			if (ratio < 0.05) {
				return undefined;
			}
			const percent = Math.min(100, Math.round(ratio * 100));
			const tokensLeft = Math.max(0, effectiveLimit - currentContext);
			const isAlmostFull = ratio >= 0.8;
			const isFull = ratio >= 1.0;
			const colorTheme: 'blue' | 'red' = isAlmostFull ? 'red' : 'blue';

			const text = isFull
				? '$(circle-filled) Limit reached'
				: `$(circle-filled) ${formatCompact(tokensLeft)} left`;

			const tooltipLines = [
				`Session tokens: ${groupDigits(currentContext)} / ${groupDigits(effectiveLimit)} used (${groupDigits(tokensLeft)} tokens left · ${percent}% full)`,
			];
			if (isAlmostFull) {
				tooltipLines.push('⚠️ Session context is almost full. When circle reaches 100%, limit is reached.');
			}
			return {
				icon: '$(circle-filled)',
				text,
				tooltip: tooltipLines.join('\n'),
				colorTheme,
				percent,
				tokensLeft,
			};
		},
		reset() {
			used = 0;
			currentContext = 0;
			limit = 0;
		},
	};
}

/**
 * Format token count compactly (e.g. 120k, 95k, 1.2M).
 */
export function formatCompact(tokens: number): string {
	if (tokens >= 1_000_000) {
		const m = (tokens / 1_000_000).toFixed(1).replace(/\.0$/, '');
		return `${m}M`;
	}
	if (tokens >= 1_000) {
		return `${Math.round(tokens / 1_000)}k`;
	}
	return `${tokens}`;
}

/**
 * The session footer text, or `undefined` when the session has recorded no
 * usage yet (no "0 tokens spent this session" line before the first real spend).
 */
export function sessionUsageFootnote(totalTokens: number, costPerMillionTokens?: number): string | undefined {
	if (totalTokens <= 0) {
		return undefined;
	}
	const tokens = `${groupDigits(totalTokens)} tokens spent this session`;
	if (costPerMillionTokens === undefined) {
		return tokens;
	}
	const cost = (totalTokens * costPerMillionTokens) / 1_000_000;
	return `${tokens} · ~${formatDollars(cost)}`;
}

/**
 * The compact status-bar label for the session total, or `undefined` when the
 * session has recorded no usage yet.
 */
export function sessionUsageMeter(totalTokens: number, costPerMillionTokens?: number): string | undefined {
	if (totalTokens <= 0) {
		return undefined;
	}
	const tokens = `${groupDigits(totalTokens)} tokens spent`;
	if (costPerMillionTokens === undefined) {
		return tokens;
	}
	const cost = (totalTokens * costPerMillionTokens) / 1_000_000;
	return `${tokens} · ~${formatDollars(cost)}`;
}

/**
 * A USD estimate rendered at a precision honest to its magnitude.
 */
function formatDollars(usd: number): string {
	const decimals = usd >= 1 ? 2 : usd >= 0.01 ? 4 : 6;
	const value = usd.toFixed(decimals);
	const trimmed = decimals === 2 ? value : value.replace(/0+$/, '').replace(/\.$/, '');
	return `$${trimmed}`;
}
