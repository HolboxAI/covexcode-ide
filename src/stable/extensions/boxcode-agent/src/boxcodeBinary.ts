/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

/**
 * Commands/paths to try for the `boxcode` CLI, in order.
 *
 * A Finder-launched macOS app inherits a stripped PATH (`/usr/bin:/bin/...`)
 * that does not include the locations `install.sh` actually writes to
 * (`/usr/local/bin`, `~/.local/bin`). Windows `install.ps1` writes
 * `boxcode.exe` under `%USERPROFILE%\.boxcode\bin` and often Cargo's bin
 * dir — those have to be named with the `.exe` suffix, not the Unix
 * spellings. `boxcode.path` is the explicit override and wins alone when
 * set -- a mistyped override must not silently fall through to a different
 * binary.
 */
export function boxcodeBinaryCandidates(
	configured: string,
	home: string,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const trimmed = configured.trim();
	if (trimmed) {
		return [trimmed];
	}
	if (platform === 'win32') {
		const exe = 'boxcode.exe';
		return [
			'boxcode',
			path.join(home, '.boxcode', 'bin', exe),
			path.join(home, '.cargo', 'bin', exe),
			path.join(home, '.local', 'bin', exe),
		];
	}
	return [
		'boxcode',
		path.join(home, '.local', 'bin', 'boxcode'),
		'/usr/local/bin/boxcode',
		path.join(home, '.cargo', 'bin', 'boxcode'),
		path.join(home, '.boxcode', 'bin', 'boxcode'),
	];
}
