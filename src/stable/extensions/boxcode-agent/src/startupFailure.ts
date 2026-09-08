/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * No `vscode` import on purpose (see `cdpClient.ts`'s own doc comment for
 * the same reasoning) -- this stays plain Node so `startupFailure.test.ts`
 * can exercise it directly instead of needing a real extension host.
 */
export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A fresh boxcode-ide install has no `boxcode` CLI bundled with it -- it's a
 * separate install (see README.md's own "Install" section, which names the
 * same two commands as `installCommand` below) that `ensureReady()` (in
 * `extension.ts`) probes for before ever showing the credential wizard --
 * see `probeBinaryExists()`. On a machine that's never run that install step
 * at all, `cp.spawn`
 * in `acpClient.ts` fails with a plain Node `ENOENT`, which used to surface
 * as generic prose ("Make sure `boxcode` is installed and on your PATH")
 * with no actual next step. This gives the one thing that actually gets a
 * first-time tester unblocked: the real, copy-pasteable install command
 * from boxcode.sh, picked by platform.
 */
/**
 * Thrown when a `boxcode` binary exists and answers `--version`, but
 * `--acp` is an unknown flag (exit 2 in `main.rs`). That is the first-run
 * failure a user with an older CLI hits -- the binary is on PATH, chat
 * still cannot start.
 */
export class AcpUnsupportedError extends Error {
	constructor() {
		super('boxcode --acp is not supported by this CLI');
		this.name = 'AcpUnsupportedError';
	}
}

export function describeStartupFailure(error: unknown, platform: NodeJS.Platform): string {
	const isMissingBinary = error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
	if (isAcpUnsupported(error)) {
		return (
			"Your `boxcode` CLI is installed, but it's too old for this IDE -- chat needs `boxcode --acp`, " +
			"which this build doesn't have. Upgrade, then send your message again:\n\n```\nboxcode --upgrade\n```"
		);
	}
	if (!isMissingBinary) {
		return `Couldn't start \`boxcode --acp\` (${describeError(error)}). Make sure \`boxcode\` is installed and on your PATH.`;
	}
	const installCommand =
		platform === 'win32'
			? 'irm https://boxcode.sh/install.ps1 | iex'
			: 'curl -fsSL https://boxcode.sh/install.sh | bash';
	return (
		"The `boxcode` CLI isn't installed yet -- boxcode IDE and the `boxcode` command are separate installs. " +
		`Run this in a terminal, then send your message again:\n\n\`\`\`\n${installCommand}\n\`\`\``
	);
}

function isAcpUnsupported(error: unknown): boolean {
	if (error instanceof AcpUnsupportedError) {
		return true;
	}
	const message = describeError(error);
	return /unknown argument:\s*--acp/i.test(message) || /exited \(code 2\b/.test(message);
}
