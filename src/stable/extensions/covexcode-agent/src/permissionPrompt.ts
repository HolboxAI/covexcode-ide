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
		{ label: 'Allow Once', choice: 'allow', uri: permissionCommandUri(id, 'allow') },
		{ label: 'Allow for This Turn', choice: 'allow-turn', uri: alwaysCommandUri(id, 'allow-turn') },
		{ label: 'Allow for This Session', choice: 'allow-session', uri: alwaysCommandUri(id, 'allow-session') },
	];
	if (!isDestructiveAlwaysAllow(kind, action)) {
		links.push({ label: 'Always Allow', choice: 'allow-always', uri: alwaysCommandUri(id, 'allow-always') });
	}
	links.push({ label: 'Reject', choice: 'reject', uri: permissionCommandUri(id, 'reject') });
	return links;
}
