/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { SessionUpdate } from './acpClient';

/**
 * One background teammate as far as the IDE has observed it. The agent
 * reports teammates on the session-lifetime `session/update` channel, keyed
 * by `teammate-<n>` rather than by the parent `agent` call: the parent call
 * completed when the child started, so a trail keyed on it would close
 * immediately.
 */
export interface TrackedAgent {
	readonly id: string;
	title: string;
	state: 'running' | 'completed' | 'failed';
	/** The child's latest `label (round n)` line, when one has arrived. */
	lastStep?: string;
	/** The terminal summary (`done`, `failed`, `stopped`) once finished. */
	outcome?: string;
}

export type AgentActivityEvent =
	| { kind: 'started'; agent: TrackedAgent }
	| { kind: 'progress'; agent: TrackedAgent }
	| { kind: 'finished'; agent: TrackedAgent };

const TEAMMATE_PREFIX = 'teammate-';

/** Whether a `toolCallId` belongs to a background teammate, not an ordinary
 * tool call or a foreground subagent (those use the parent call's id). */
export function isBackgroundAgentId(toolCallId: string | undefined): boolean {
	return typeof toolCallId === 'string' && toolCallId.startsWith(TEAMMATE_PREFIX);
}

/**
 * Folds the ACP updates for background teammates into one small table the
 * extension can render, log, and notify from. Deliberately vscode-free so it
 * can be tested without the extension host.
 */
export class AgentActivityTracker {
	private readonly agents = new Map<string, TrackedAgent>();

	/** Apply one update; returns the event worth surfacing, if any. Updates
	 * for ordinary tools, foreground subagents and other sessions' calls are
	 * ignored. */
	apply(update: SessionUpdate): AgentActivityEvent | undefined {
		const id = update.toolCallId;
		if (!isBackgroundAgentId(id)) {
			return undefined;
		}
		const callId = id as string;
		const existing = this.agents.get(callId);

		if (update.sessionUpdate === 'tool_call') {
			const agent: TrackedAgent = {
				id: callId,
				title: update.title?.trim() || existing?.title || callId,
				state: 'running',
				...(existing?.lastStep ? { lastStep: existing.lastStep } : {}),
			};
			this.agents.set(callId, agent);
			return { kind: 'started', agent: { ...agent } };
		}

		if (update.sessionUpdate !== 'tool_call_update') {
			return undefined;
		}

		const agent: TrackedAgent = existing ?? {
			id: callId,
			title: update.title?.trim() || callId,
			state: 'running',
		};
		if (update.title?.trim() && !existing) {
			agent.title = update.title.trim();
		}
		const text = update.content?.type === 'content' ? update.content.text : undefined;

		if (update.status === 'completed' || update.status === 'failed') {
			agent.state = update.status;
			if (text) {
				agent.outcome = text;
			}
			this.agents.set(callId, agent);
			return { kind: 'finished', agent: { ...agent } };
		}

		if (update.status === 'in_progress' && text && text !== agent.lastStep) {
			agent.lastStep = text;
			this.agents.set(callId, agent);
			return { kind: 'progress', agent: { ...agent } };
		}

		return undefined;
	}

	/** Running first, then most-recently-seen insertion order within a state. */
	list(): TrackedAgent[] {
		const all = [...this.agents.values()];
		return [
			...all.filter(agent => agent.state === 'running'),
			...all.filter(agent => agent.state !== 'running'),
		];
	}

	runningCount(): number {
		let running = 0;
		for (const agent of this.agents.values()) {
			if (agent.state === 'running') {
				running += 1;
			}
		}
		return running;
	}

	/** The `/agents` readout. Empty when this extension host has not seen a
	 * background teammate; the persisted job registry is queried over ACP in
	 * the follow-up protocol slice. */
	markdown(): string {
		const agents = this.list();
		if (agents.length === 0) {
			return [
				'**covexcode agents**',
				'',
				'No background agents have run in this window yet. Ask for a background',
				'subagent and it will appear here while it works.',
			].join('\n');
		}
		const lines = ['**covexcode agents**', ''];
		for (const agent of agents) {
			const status = agent.state === 'running'
				? `running${agent.lastStep ? ` — ${agent.lastStep}` : ''}`
				: `${agent.state}${agent.outcome ? ` — ${agent.outcome}` : ''}`;
			lines.push(`- ${agent.title} — ${status}`);
		}
		return lines.join('\n');
	}

	/** A new ACP session means the old process (and every teammate task it
	 * owned) is gone; its records remain on disk, but this live table must not
	 * claim they are still running. */
	clear(): void {
		this.agents.clear();
	}
}
