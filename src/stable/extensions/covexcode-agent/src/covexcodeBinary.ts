/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

/**
 * Commands/paths to try for the `covexcode` CLI, in order.
 *
 * A Finder-launched macOS app inherits a stripped PATH (`/usr/bin:/bin/...`)
 * that does not include the locations `install.sh` actually writes to
 * (`/usr/local/bin`, `~/.local/bin`). Windows `install.ps1` writes
 * `covexcode.exe` under `%USERPROFILE%\.covexcode\bin` and often Cargo's bin
 * dir — those have to be named with the `.exe` suffix, not the Unix
 * spellings. `covexcode.path` is the explicit override and wins alone when
 * set -- a mistyped override must not silently fall through to a different
 * binary.
 */
export function covexcodeBinaryCandidates(
	configured: string,
	home: string,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const trimmed = configured.trim();
	if (trimmed) {
		return [trimmed];
	}
	if (platform === 'win32') {
		const exe = 'covexcode.exe';
		return [
			'covexcode',
			path.join(home, '.covexcode', 'bin', exe),
			path.join(home, '.cargo', 'bin', exe),
			path.join(home, '.local', 'bin', exe),
		];
	}
	return [
		'covexcode',
		path.join(home, '.local', 'bin', 'covexcode'),
		'/usr/local/bin/covexcode',
		path.join(home, '.cargo', 'bin', 'covexcode'),
		path.join(home, '.covexcode', 'bin', 'covexcode'),
	];
}
