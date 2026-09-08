/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chat-first starts as a trusted empty window. File > Open Folder then
 * turns that window into an untrusted folder workspace without a clear
 * prompt, which used to disable this extension (`untrustedWorkspaces:
 * false`) and leave the chat pane empty. These helpers decide when to
 * ask for trust and what to say -- no `vscode` import, so the tests can
 * cover the rule without an extension host.
 */

export const TRUST_COMMAND = 'boxcode.trustWorkspace';

export const TRUST_TOAST_ACTION = 'Trust folder';

export const TRUST_TOAST_MESSAGE =
	'Trust this folder so boxcode can read, write, and run commands here. Restricted Mode blocks the agent until you do.';

export function shouldPromptForWorkspaceTrust(isTrusted: boolean, folderCount: number): boolean {
	return !isTrusted && folderCount > 0;
}

export function describeRestrictedMode(): string {
	return (
		'This folder is in Restricted Mode, so boxcode cannot read, write, or run anything here yet. ' +
		'Trust the folder to continue, then send your message again.'
	);
}

export function folderTrustKey(folderUris: string[]): string {
	return [...folderUris].sort().join('\0');
}
