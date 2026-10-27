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
 * The IDE ships a pinned agent runtime inside the app. A missing binary in
 * that path is an installation problem, not a request to install the terminal
 * CLI. The external-CLI fallback is still supported for development and for
 * users who explicitly disabled the bundled runtime, so its install/upgrade
 * guidance stays available behind the `bundled: false` branch.
 */
/**
 * Thrown when a `covexcode` binary exists and answers `--version`, but
 * `--acp` is an unknown flag (exit 2 in `main.rs`). That is the first-run
 * failure a user with an older CLI hits -- the binary is on PATH, chat
 * still cannot start.
 */
export class AcpUnsupportedError extends Error {
	constructor() {
		super('covexcode --acp is not supported by this CLI');
		this.name = 'AcpUnsupportedError';
	}
}

export type StartupFailureOptions = {
	/** True when the launch we attempted was the runtime bundled with the IDE. */
	bundled?: boolean;
};

export function describeStartupFailure(
	error: unknown,
	platform: NodeJS.Platform,
	options: StartupFailureOptions = {},
): string {
	const bundled = options.bundled === true;
	const isMissingBinary = error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
	if (isAgentCompatibilityError(error)) {
		if (bundled) {
			return (
				"The agent runtime bundled with this Covexcode IDE build is incompatible with the IDE " +
				`(${describeError(error)}). Reinstall or update Covexcode IDE, then send your message again.`
			);
		}
		return (
			`The configured \`covexcode\` CLI is incompatible with this IDE (${describeError(error)}). ` +
			'Update the CLI, or clear `covexcode.path` to use the bundled runtime.'
		);
	}
	if (isAcpUnsupported(error)) {
		if (bundled) {
			return (
				'The agent runtime bundled with this Covexcode IDE build does not support the ACP interface this IDE ' +
				'needs. Reinstall or update Covexcode IDE, then send your message again.'
			);
		}
		return (
			"Your `covexcode` CLI is installed, but it's too old for this IDE -- chat needs `covexcode --acp`, " +
			"which this build doesn't have. Upgrade, then send your message again:\n\n```\ncovexcode --upgrade\n```"
		);
	}
	if (!isMissingBinary) {
		if (bundled) {
			return (
				`Couldn't start the bundled covexcode agent (${describeError(error)}). ` +
				'Reinstall or update Covexcode IDE if this persists.'
			);
		}
		return `Couldn't start \`covexcode --acp\` (${describeError(error)}). Make sure \`covexcode\` is installed and on your PATH.`;
	}
	if (bundled) {
		return (
			"Covexcode IDE couldn't find its bundled agent runtime. " +
			'Reinstall or update Covexcode IDE, then send your message again.'
		);
	}
	const installCommand =
		platform === 'win32'
			? 'irm https://covexcode.com/install.ps1 | iex'
			: 'curl -fsSL https://covexcode.com/install.sh | bash';
	return (
		"The `covexcode` CLI isn't installed yet -- covexcode IDE and the `covexcode` command are separate installs. " +
		`Run this in a terminal, then send your message again:\n\n\`\`\`\n${installCommand}\n\`\`\``
	);
}

function isAgentCompatibilityError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AgentCompatibilityError';
}

function isAcpUnsupported(error: unknown): boolean {
	if (error instanceof AcpUnsupportedError) {
		return true;
	}
	const message = describeError(error);
	// Anchor the exit-2 fallback to the `covexcode --acp` spawn specifically:
	// exit code 2 only means "unknown argument" when it was `covexcode --acp`
	// that exited 2 -- the same "exited (code 2)" phrasing from any other
	// subprocess must not read as "your covexcode CLI is too old".
	return /unknown argument:\s*--acp/i.test(message) || /covexcode --acp exited \(code 2\b/.test(message);
}
