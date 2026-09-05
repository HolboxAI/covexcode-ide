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
 * separate install (see README.md's own "Install" section) that
 * `ensureReady()` (in `extension.ts`) just shells out to by bare command
 * name. On a machine that's never run that install step at all, `cp.spawn`
 * in `acpClient.ts` fails with a plain Node `ENOENT`, which used to surface
 * as generic prose ("Make sure `boxcode` is installed and on your PATH")
 * with no actual next step. This gives the one thing that actually gets a
 * first-time tester unblocked: the real, copy-pasteable install command
 * from boxcode.sh, picked by platform.
 */
export function describeStartupFailure(error: unknown, platform: NodeJS.Platform): string {
	const isMissingBinary = error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
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
