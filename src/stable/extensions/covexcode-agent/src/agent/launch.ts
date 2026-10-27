/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { covexcodeBinaryCandidates } from '../covexcodeBinary';

export type AgentSource = 'configured' | 'bundled' | 'external';

export type AgentCandidate = {
	command: string;
	source: AgentSource;
};

export type AgentLaunchInput = {
	configuredPath: string;
	bundledPath: string | undefined;
	useBundled: boolean;
	home: string;
	platform?: NodeJS.Platform;
};

/** Path of the runtime staged by prepare_sidecar.sh into the built-in extension. */
export function bundledAgentPath(extensionPath: string, platform: NodeJS.Platform = process.platform): string {
	return path.join(extensionPath, 'resources', 'bin', platform === 'win32' ? 'covexcode.exe' : 'covexcode');
}

/**
 * Candidates in launch order.
 *
 * `covexcode.path` still wins alone: a user who typed an explicit path should
 * get that binary or a clear failure, never a silent fall-through. When the
 * bundled runtime is enabled it comes next, then the legacy PATH/home
 * candidates. The source travels with each candidate so the caller can report
 * that a fallback actually happened instead of claiming the bundle was used.
 */
export function agentLaunchCandidates(input: AgentLaunchInput): AgentCandidate[] {
	const configured = input.configuredPath.trim();
	if (configured) {
		return [{ command: configured, source: 'configured' }];
	}

	const candidates: AgentCandidate[] = [];
	if (input.useBundled && input.bundledPath) {
		candidates.push({ command: input.bundledPath, source: 'bundled' });
	}
	for (const command of covexcodeBinaryCandidates('', input.home, input.platform)) {
		candidates.push({ command, source: 'external' });
	}
	return candidates;
}
