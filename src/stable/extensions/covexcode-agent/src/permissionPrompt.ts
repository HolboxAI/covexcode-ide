/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { permissionCommandUri } from './chatPermission';
import { alwaysCommandUri, type PromptChoice } from './permissionOptions';

/**
 * The ordered link set the permission prompt renders, plus the destructive
 * gate that decides whether "Always Allow" appears at all.
 *
 * Deliberately vscode-free so both are unit-testable under
 * `tsconfig.test.json`; the `MarkdownString` rendering that consumes this list
 * lives in `extension.ts` (which that config excludes).
 */

export interface PermissionPromptLink {
	label: string;
	choice: PromptChoice;
	uri: string;
	icon?: string;
	description?: string;
}

/** Command fragments that must never be granted "always" without a look. */
const DESTRUCTIVE_COMMAND_MARKERS = [
	'rm',
	'del',
	'rmdir',
	'format',
	'drop',
	'truncate',
	':(){:|:&};:',
];

/** File-operation kinds whose `action` is a path, never a command to scan. */
const FILE_KINDS = new Set(['file_write', 'file_edit', 'file_read', 'write', 'edit', 'read']);

/**
 * Whether "Always Allow" must be hidden. A file delete is always destructive;
 * any other operation is scanned for shell markers only when its kind is a
 * command (or unknown), never when it is a file path -- a file named
 * `format.ts` must not lose its Always Allow link to a substring match.
 */
export function isDestructiveAlwaysAllow(kind: string, action: string): boolean {
	if (kind === 'file_delete') {
		return true;
	}
	if (FILE_KINDS.has(kind)) {
		return false;
	}
	const lower = action.toLowerCase();
	return DESTRUCTIVE_COMMAND_MARKERS.some(marker => lower.includes(marker));
}

export function permissionPromptLinks(options: {
	id: string;
	allowLabel: string;
	rejectLabel: string;
	kind: string;
	action: string;
}): PermissionPromptLink[] {
	const { id, kind, action } = options;
	const links: PermissionPromptLink[] = [
		{
			label: 'Yes, allow this time',
			choice: 'allow',
			uri: permissionCommandUri(id, 'allow'),
			icon: '$(check)',
			description: 'Run this tool call only',
		},
		{
			label: 'Yes, allow for this turn',
			choice: 'allow-turn',
			uri: alwaysCommandUri(id, 'allow-turn'),
			icon: '$(sync)',
			description: 'Allow for the rest of this conversation turn',
		},
		{
			label: 'Yes, allow for this session',
			choice: 'allow-session',
			uri: alwaysCommandUri(id, 'allow-session'),
			icon: '$(history)',
			description: 'Allow until the session restarts',
		},
	];
	if (!isDestructiveAlwaysAllow(kind, action)) {
		links.push({
			label: 'Yes, always allow this',
			choice: 'allow-always',
			uri: alwaysCommandUri(id, 'allow-always'),
			icon: '$(shield)',
			description: 'Remember permanently in workspace rules',
		});
	}
	links.push({
		label: 'No',
		choice: 'reject',
		uri: permissionCommandUri(id, 'reject'),
		icon: '$(x)',
		description: 'Deny and tell the agent what to do instead',
	});
	return links;
}

export function formatActionTitle(kind: string, action: string): string {
	const trimmed = action.trim();
	switch (kind) {
		case 'execute':
		case 'run_command':
			return `Allow execute ${trimmed}?`;
		case 'file_write':
		case 'write':
			return `Allow write ${trimmed}?`;
		case 'file_edit':
		case 'edit':
			return `Allow edit ${trimmed}?`;
		case 'file_delete':
		case 'delete':
			return `Allow delete ${trimmed}?`;
		case 'file_read':
		case 'read':
			return `Allow read ${trimmed}?`;
		default:
			return `Allow ${trimmed}?`;
	}
}

export function formatActionSubtitle(kind: string): string {
	switch (kind) {
		case 'execute':
			return 'covexcode wants to execute:';
		case 'file_write':
		case 'write':
			return 'covexcode wants to write:';
		case 'file_edit':
		case 'edit':
			return 'covexcode wants to edit:';
		case 'file_delete':
		case 'delete':
			return 'covexcode wants to delete:';
		case 'file_read':
		case 'read':
			return 'covexcode wants to read:';
		default:
			return 'covexcode wants to run:';
	}
}

export function detectCodeLanguage(kind: string, action: string): string {
	if (kind === 'execute') {
		return 'bash';
	}
	const lower = action.toLowerCase();
	if (lower.endsWith('.ts') || lower.endsWith('.tsx')) {
		return 'typescript';
	}
	if (lower.endsWith('.js') || lower.endsWith('.jsx')) {
		return 'javascript';
	}
	if (lower.endsWith('.json')) {
		return 'json';
	}
	if (lower.endsWith('.py')) {
		return 'python';
	}
	if (lower.endsWith('.sh') || lower.endsWith('.bash')) {
		return 'bash';
	}
	if (lower.endsWith('.css') || lower.endsWith('.scss')) {
		return 'css';
	}
	if (lower.endsWith('.html')) {
		return 'html';
	}
	return '';
}

export function renderPermissionCard(options: {
	id: string;
	allowLabel: string;
	rejectLabel: string;
	kind: string;
	action: string;
}): string {
	const { id, kind, action, allowLabel, rejectLabel } = options;
	const title = formatActionTitle(kind, action);
	const lang = detectCodeLanguage(kind, action);
	const links = permissionPromptLinks({ id, allowLabel, rejectLabel, kind, action });

	let md = `### $(shield) ${title}\n\n`;
	md += `\`\`\`${lang}\n${action}\n\`\`\`\n\n`;
	md += `---\n\n`;

	links.forEach((link, index) => {
		const num = index + 1;
		const icon = link.icon ? `${link.icon} ` : '';
		const desc = link.description ? ` &nbsp;—&nbsp; *${link.description}*` : '';
		md += `**${num}.** [${icon}**${link.label}**](${link.uri})${desc}\n\n`;
		if (link.choice === 'reject') {
			md += `> [$(close) Skip](${link.uri}) &nbsp; [$(send) Submit Feedback](${link.uri})\n\n`;
		}
	});

	return md;
}
