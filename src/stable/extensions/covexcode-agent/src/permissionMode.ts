/**
 * The session's approval posture — the IDE counterpart to the CLI's Shift+Tab
 * toggle. The CLI reads `COVEXCODE_TOOLS_APPROVAL` from the environment when
 * an ACP client (this extension) spawns it (see covexcode's `config.rs`);
 * this module owns only the pure mapping between the `covexcode.permissionMode`
 * setting and that env value, so the toggle stays unit-testable without a
 * `vscode` import.
 */

export type PermissionMode = 'auto' | 'manual';

/** Normalise a raw `covexcode.permissionMode` value onto a valid mode. */
export function permissionModeFromSetting(value: string | undefined): PermissionMode {
	return value === 'manual' ? 'manual' : 'auto';
}

/** The value `COVEXCODE_TOOLS_APPROVAL` must carry for a given mode. */
export function approvalEnvValue(mode: PermissionMode): string {
	return mode === 'manual' ? 'always' : 'destructive';
}

/** The next mode in the auto -> manual -> auto loop (Shift+Tab's cycle). */
export function cyclePermissionMode(mode: PermissionMode): PermissionMode {
	return mode === 'manual' ? 'auto' : 'manual';
}

/** One-line human description of what a mode stops for. */
export function permissionModeDescription(mode: PermissionMode): string {
	return mode === 'manual'
		? 'every write and command stops for approval'
		: 'only destructive actions stop for approval';
}

/** The chat readout shown after `/mode` toggles the posture. */
export function permissionModeMarkdown(mode: PermissionMode): string {
	return `**Permission mode: ${mode.toUpperCase()}** — ${permissionModeDescription(mode)}. Run \`/mode\` again to switch back.`;
}
