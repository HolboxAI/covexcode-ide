/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import type { AgentDefinitionView, MailboxMessage, TaskView, TeammateView } from './acpClient';

/** Markdown for `/teammates`, shared by the chat command and tests. */
export function teammatesMarkdown(jobs: readonly TeammateView[]): string {
	if (jobs.length === 0) {
		return ['**covexcode teammates**', '', 'No teammate jobs recorded for this workspace yet.'].join('\n');
	}
	const lines = ['**covexcode teammates**', ''];
	for (const job of jobs) {
		const state = job.interrupted
			? 'interrupted'
			: job.running
				? 'running'
				: job.has_report
					? 'finished'
					: 'stopped';
		const report = job.has_report ? ' · report ready' : '';
		const remote = job.remote ? ' · other process' : '';
		lines.push(`- \`${job.id}\` ${job.name} — ${state} · ${job.elapsed_secs}s${report}${remote}`);
		lines.push(`  ${job.task}`);
	}
	return lines.join('\n');
}

/** Markdown for `/tasks`: the shared DAG, in creation order. */
export function tasksMarkdown(tasks: readonly TaskView[]): string {
	if (tasks.length === 0) {
		return ['**covexcode tasks**', '', 'No tasks recorded for this workspace yet.'].join('\n');
	}
	const marker = { pending: '[ ]', in_progress: '[~]', done: '[x]' } as const;
	const lines = ['**covexcode tasks**', ''];
	for (const task of tasks) {
		const owner = task.owner ? ` · ${task.owner}` : '';
		const depends = task.depends_on.length > 0 ? ` · after ${task.depends_on.join(', ')}` : '';
		lines.push(`- ${marker[task.status]} \`${task.id}\` ${task.title}${owner}${depends}`);
		if (task.note) {
			lines.push(`  ${task.note}`);
		}
	}
	return lines.join('\n');
}

/** Markdown for `/agents`: the picker plus what is running right now. */
export function agentsMarkdown(
	definitions: readonly AgentDefinitionView[],
	running: readonly { title: string; lastStep?: string }[],
): string {
	const lines = ['**covexcode agents**', ''];
	if (running.length > 0) {
		lines.push('Running now:');
		for (const agent of running) {
			lines.push(`- ${agent.title}${agent.lastStep ? ` — ${agent.lastStep}` : ''}`);
		}
		lines.push('');
	}
	if (definitions.length === 0) {
		lines.push('No agent definitions are available for this workspace.');
		return lines.join('\n');
	}
	lines.push('Available types:');
	for (const definition of definitions) {
		const mode = definition.writes ? 'writes in a worktree' : 'read-only';
		const verify = definition.verify ? ` · verify: \`${definition.verify}\`` : '';
		lines.push(`- \`${definition.name}\` — ${definition.description || mode} (${mode})${verify}`);
	}
	return lines.join('\n');
}

/** Markdown for `/inbox`: unread messages for one owner. */
export function inboxMarkdown(owner: string, messages: readonly MailboxMessage[]): string {
	if (messages.length === 0) {
		return [`**covexcode inbox — ${owner}**`, '', 'No unread messages.'].join('\n');
	}
	const lines = [`**covexcode inbox — ${owner}**`, ''];
	for (const message of messages) {
		lines.push(`- \`#${message.id}\` from ${message.from} at ${message.at}`);
		lines.push(`  ${message.body.replace(/\n/g, '\n  ')}`);
	}
	return lines.join('\n');
}
