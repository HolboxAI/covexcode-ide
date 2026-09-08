/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

/**
 * No `vscode` import on purpose -- same posture as `localhostUrl.ts` /
 * `startupFailure.ts`, so `workspaceContext.test.ts` can exercise this
 * without an extension host. Callers pass `workspaceFolders[].uri.fsPath`
 * and the active editor's file path, not VS Code types.
 *
 * `boxcode --acp` takes one `cwd` at `session/new` and never learns about
 * a later File > Open Folder on its own. The chat participant used to
 * spawn against `$HOME` whenever `workspaceFolders` was empty (chat-first
 * landing, empty window), then keep that session even after a folder was
 * opened -- so tools ran in the wrong directory and the model was never
 * told which folder was open. This module is the one place that decision
 * is made, so `ensureReady` and the prompt prefix cannot drift.
 */

export interface WorkspaceFolderLike {
	fsPath: string;
}

export interface WorkspaceContext {
	/** Directory handed to `session/new` and used as the spawn cwd. */
	cwd: string;
	/** True when the window actually has a workspace folder, not a homedir fallback. */
	hasFolder: boolean;
	folderPaths: string[];
	/** Longest open folder that contains the active file, if any. */
	activeFolderPath: string | undefined;
}

export function isPathInsideFolder(filePath: string, folder: string): boolean {
	const relative = path.relative(folder, filePath);
	return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function resolveWorkspaceCwd(
	folders: WorkspaceFolderLike[] | undefined,
	activeFilePath: string | undefined,
	homedir: string,
): WorkspaceContext {
	const folderPaths = (folders ?? []).map(folder => folder.fsPath).filter(Boolean);
	const hasFolder = folderPaths.length > 0;
	let activeFolderPath: string | undefined;
	if (activeFilePath && hasFolder) {
		const containing = folderPaths.filter(folder => isPathInsideFolder(activeFilePath, folder));
		containing.sort((a, b) => b.length - a.length);
		activeFolderPath = containing[0];
	}
	return {
		cwd: hasFolder ? (activeFolderPath ?? folderPaths[0]) : homedir,
		hasFolder,
		folderPaths,
		activeFolderPath,
	};
}

/**
 * Hidden context prepended to every `session/prompt`. The ACP session's
 * cwd is not otherwise visible to the model -- it only sees the user's
 * text -- which is why "open folder X" still produced answers that
 * wandered into `$HOME`.
 */
export function workspacePromptPrefix(context: WorkspaceContext): string {
	if (!context.hasFolder) {
		return (
			'No workspace folder is open in this IDE window. ' +
			'Do not assume a project directory and do not use the home directory as a stand-in. ' +
			'Ask the user to open a folder if they want you to read or change project files.'
		);
	}
	const lines = [
		'The user is working in this IDE workspace.',
		`Working directory (use this for relative paths and shell commands): ${context.cwd}`,
	];
	if (context.folderPaths.length > 1) {
		lines.push('Open folders:');
		for (const folder of context.folderPaths) {
			lines.push(`- ${folder}`);
		}
	}
	lines.push('Stay inside this workspace unless the user names a different path.');
	return lines.join('\n');
}

export function resolvePathAgainstCwd(cwd: string, relativeOrAbsolute: string): string {
	return path.isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : path.join(cwd, relativeOrAbsolute);
}

export function prependWorkspacePrefix(text: string, prefix: string): string {
	if (!prefix) {
		return text;
	}
	return `${prefix}\n\n${text}`;
}
