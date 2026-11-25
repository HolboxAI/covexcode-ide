/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure helpers for the IDE's `/event` chat command. The proxy owns the
 * allowance; this only builds the URL and renders the answer, so the command
 * cannot drift from the CLI's `/event` readout.
 */

export type EventStatus = {
	used?: number;
	cap?: number;
	remaining?: number;
	tier?: number;
	extra_tokens?: number;
	phase?: string;
	tiers?: number[];
	grant_tokens?: number;
	window?: { start?: string; end?: string };
};

/** Same mount rule as the CLI: append `/event/<suffix>` to the endpoint. */
export function eventUrl(endpoint: string, suffix: 'status' | 'request-more'): string {
	return `${endpoint.trim().replace(/\/+$/, '')}/event/${suffix}`;
}

function count(value: number | undefined): string {
	return Number(value || 0).toLocaleString('en-US');
}

function phaseLabel(phase: string | undefined): string {
	switch (phase) {
		case 'open':
			return 'open';
		case 'not_started':
			return 'not started';
		case 'ended':
			return 'ended';
		default:
			return phase || 'unknown';
	}
}

export function eventStatusMarkdown(status: EventStatus): string {
	const tiers = status.tiers || [];
	const tier = Math.min(Number(status.tier || 0) + 1, tiers.length || 1);
	const lines = [
		'**Event allowance**',
		'',
		`- **Window:** ${phaseLabel(status.phase)}`,
		`- **Used:** ${count(status.used)} / ${count(status.cap)} tokens`,
		`- **Remaining:** ${count(status.remaining)}`,
		`- **Tier:** ${tier}${tiers.length ? ` of ${tiers.length} (${tiers.map(count).join(' → ')})` : ''}`,
		`- **Granted extra:** ${count(status.extra_tokens)}`,
	];
	if (status.grant_tokens) {
		lines.push(`- **Next request:** +${count(status.grant_tokens)} tokens`);
	}
	if (status.window?.start && status.window?.end) {
		lines.push(`- **Server window:** ${status.window.start} → ${status.window.end}`);
	}
	return lines.join('\n');
}

export function eventErrorMarkdown(httpStatus: number, message: string): string {
	return `**Event request failed** (${httpStatus})\n\n${message}`;
}
