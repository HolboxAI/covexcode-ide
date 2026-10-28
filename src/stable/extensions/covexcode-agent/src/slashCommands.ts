/**
 * The slash commands the covexcode chat participant understands in the IDE.
 * This is the IDE surface of covexcode's own `/`-command set (the CLI's
 * `App::COMMANDS` in `app.rs`); the TUI-only commands (`/usage`, `/quota`,
 * `/compact`, …) are omitted because they have no IDE equivalent yet.
 * `/help` reads this list so the readout can never drift from what's real.
 */

export interface SlashCommand {
	readonly name: string;
	readonly description: string;
}

export const IDE_SLASH_COMMANDS: readonly SlashCommand[] = [
	{ name: '/plan', description: 'research first, change nothing until you approve' },
	{ name: '/provider', description: 'switch provider, model, or API key' },
	{ name: '/model', description: 'switch model' },
	{ name: '/mode', description: 'toggle auto / manual permission mode' },
	{ name: '/rollback', description: 'undo every file the session wrote' },
	{ name: '/doctor', description: "check this install's health" },
	{ name: '/help', description: 'list every slash command' },
];

/** The `/help` readout, generated from the list so it can't drift. */
export function helpMarkdown(): string {
	const lines = ['**covexcode — slash commands**', ''];
	for (const command of IDE_SLASH_COMMANDS) {
		lines.push(`- \`${command.name}\` — ${command.description}`);
	}
	lines.push('', 'You can also send any message without a slash command, or edit inline with Ctrl+I.');
	return lines.join('\n');
}

/** Facts `/doctor` gathers before rendering; see `doctorMarkdown`. */
export interface DoctorFacts {
	readonly version: string;
	readonly agentSource: 'configured' | 'bundled' | 'external' | 'missing';
	readonly agentPath?: string;
	readonly platform: string;
	readonly arch: string;
	readonly configPath: string;
	readonly configFound: boolean;
	readonly configSource: 'isolated' | 'shared-cli' | 'custom' | 'environment' | 'legacy';
	readonly provider: string;
	readonly model: string;
	readonly endpoint: string;
	readonly apiKeySet: boolean;
	readonly workspace: string;
	readonly workspaceIsGit: boolean;
	readonly stateDirFound: boolean;
}

function configSourceLabel(source: DoctorFacts['configSource']): string {
	switch (source) {
		case 'isolated':
			return 'isolated (IDE-managed)';
		case 'shared-cli':
			return 'shared with CLI';
		case 'environment':
			return 'from COVEXCODE_CONFIG_DIR';
		case 'custom':
			return 'custom';
		case 'legacy':
			return 'legacy CLI location';
	}
}

/** The `/doctor` health report. The API key is present/absent, never its value. */
export function doctorMarkdown(facts: DoctorFacts): string {
	const row = (label: string, value: string) => `- **${label}:** ${value}`;
	const workspace = facts.workspace
		? `${facts.workspace} (${facts.workspaceIsGit ? 'git repo' : 'not a git repo'})`
		: 'not set';
	return [
		'**covexcode doctor**',
		'',
		row('Version', facts.version),
		row('Agent', facts.agentSource === 'missing' ? 'not found' : `${facts.agentSource}${facts.agentPath ? ` (${facts.agentPath})` : ''}`),
		row('Platform', `${facts.platform} / ${facts.arch}`),
		row('Config', `${facts.configPath} (${facts.configFound ? 'found' : 'missing'})`),
		row('Provider', facts.provider || 'custom endpoint'),
		row('Model', facts.model || 'not set'),
		row('Endpoint', facts.endpoint || 'not set'),
		row('API key', facts.apiKeySet ? 'set (not shown)' : 'not set'),
		row('Workspace', workspace),
		row('State', `${configSourceLabel(facts.configSource)}${facts.stateDirFound ? '' : ' (missing)'}`),
	].join('\n');
}
