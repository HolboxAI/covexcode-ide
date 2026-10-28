/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Where the agent keeps its state.
 *
 * The bundled runtime is a child process and the terminal CLI is a separate
 * product, so by default the IDE gives the agent its own directory under VS
 * Code's global storage. That keeps a malformed `~/.covexcode/config.toml`
 * from breaking the editor, and keeps IDE sessions out of the CLI's history.
 * Users who want one shared state directory can point the setting (or
 * `COVEXCODE_CONFIG_DIR`) at `~/.covexcode`.
 */
export type AgentStateSource = 'isolated' | 'shared-cli' | 'custom' | 'environment';

export interface AgentStateLocation {
	readonly dir: string;
	readonly source: AgentStateSource;
	readonly legacyDir: string;
	readonly migrated: boolean;
}

export interface AgentStateInput {
	readonly setting: string | undefined;
	readonly env: NodeJS.ProcessEnv;
	readonly globalStorage: string;
	readonly home?: string;
}

export const AGENT_STATE_DIR_NAME = 'agent';

const LEGACY_DIR_NAME = '.covexcode';
const INITIALIZED_MARKER = '.ide-state-v1';

/**
 * Files worth carrying over when an existing CLI install is present. Sessions
 * and the small state files preserve history; `python/` (a generated tool
 * environment) and the CLI's own update marker are deliberately excluded.
 */
const LEGACY_FILES = [
	'config.toml',
	'account.token',
	'account.email',
	'device_id',
	'db.json',
	'projects.json',
	'prompt_history.jsonl',
	'quota.json',
	'usage.jsonl',
	'deploy.json',
	'artifacts.json',
] as const;

const LEGACY_DIRECTORIES = ['sessions'] as const;

const PRIVATE_FILES = new Set(['config.toml', 'account.token', 'account.email', 'device_id']);

let currentState: AgentStateLocation | undefined;

/** Record the location chosen during activation. */
export function setCurrentAgentState(location: AgentStateLocation): void {
	currentState = location;
}

/** The location in use, or undefined before activation has configured one. */
export function currentAgentState(): AgentStateLocation | undefined {
	return currentState;
}

/**
 * The directory the rest of the extension (account login, inline completion,
 * doctor) should read. Before activation this is the historical CLI location,
 * which keeps the pure helpers and tests backwards-compatible.
 */
export function currentAgentStateDir(): string {
	return currentState?.dir ?? path.join(os.homedir(), LEGACY_DIR_NAME);
}

export function currentAgentStateSource(): AgentStateSource | 'legacy' {
	return currentState?.source ?? 'legacy';
}

/** Resolve, without touching disk, the directory the agent should use. */
export function resolveAgentStateDir(input: AgentStateInput): AgentStateLocation {
	const home = input.home ?? os.homedir();
	const legacyDir = path.join(home, LEGACY_DIR_NAME);
	const configured = expandHome(input.setting ?? '', home);
	if (configured) {
		const dir = path.resolve(configured);
		return {
			dir,
			source: samePath(dir, legacyDir) ? 'shared-cli' : 'custom',
			legacyDir,
			migrated: false,
		};
	}

	const fromEnvironment = expandHome(input.env.COVEXCODE_CONFIG_DIR ?? '', home);
	if (fromEnvironment) {
		return {
			dir: path.resolve(fromEnvironment),
			source: 'environment',
			legacyDir,
			migrated: false,
		};
	}

	return {
		dir: path.join(input.globalStorage, AGENT_STATE_DIR_NAME),
		source: 'isolated',
		legacyDir,
		migrated: false,
	};
}

/**
 * Create the directory (0700 on POSIX) and, when this is the IDE-managed
 * location, make a one-time copy of the legacy CLI state.
 *
 * Copying rather than moving is deliberate: the terminal CLI keeps working,
 * and a user who switches back to `~/.covexcode` has lost nothing. Sensitive
 * copied files are tightened to 0600 after the copy.
 */
export function ensureAgentStateDir(location: AgentStateLocation): AgentStateLocation {
	fs.mkdirSync(location.dir, { recursive: true, mode: 0o700 });
	hardenDir(location.dir);

	if (location.source !== 'isolated') {
		return location;
	}

	const marker = path.join(location.dir, INITIALIZED_MARKER);
	if (fs.existsSync(marker)) {
		return location;
	}

	let migrated = false;
	try {
		if (fs.existsSync(location.legacyDir) && !samePath(location.dir, location.legacyDir)) {
			migrated = copyLegacyState(location.legacyDir, location.dir);
		}
		writeMarker(marker, location.legacyDir, migrated);
	} catch (error) {
		// A read-only legacy directory or a transient copy failure must not
		// prevent the agent from starting. The next activation retries.
		console.warn('covexcode: could not initialize the IDE agent state directory', error);
	}

	return { ...location, migrated };
}

function expandHome(value: string, home: string): string {
	const trimmed = value.trim();
	if (trimmed === '~') {
		return home;
	}
	if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
		return path.join(home, trimmed.slice(2));
	}
	return trimmed;
}

function samePath(a: string, b: string): boolean {
	const left = path.resolve(a);
	const right = path.resolve(b);
	return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function copyLegacyState(sourceDir: string, destinationDir: string): boolean {
	let copied = false;
	for (const name of LEGACY_FILES) {
		copied = copyFileIfMissing(path.join(sourceDir, name), path.join(destinationDir, name)) || copied;
	}
	for (const name of LEGACY_DIRECTORIES) {
		copied = mergeDirectory(path.join(sourceDir, name), path.join(destinationDir, name)) || copied;
	}
	hardenPrivateFiles(destinationDir);
	return copied;
}

function copyFileIfMissing(source: string, destination: string): boolean {
	try {
		const stat = fs.lstatSync(source);
		if (!stat.isFile()) {
			return false;
		}
		if (fs.existsSync(destination)) {
			return false;
		}
		fs.copyFileSync(source, destination);
		if (PRIVATE_FILES.has(path.basename(destination))) {
			hardenFile(destination);
		}
		return true;
	} catch {
		return false;
	}
}

function mergeDirectory(source: string, destination: string): boolean {
	try {
		const stat = fs.lstatSync(source);
		if (!stat.isDirectory()) {
			return false;
		}
	} catch {
		return false;
	}

	let copied = false;
	fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
	hardenDir(destination);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(source, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of entries) {
		const from = path.join(source, entry.name);
		const to = path.join(destination, entry.name);
		if (entry.isDirectory()) {
			copied = mergeDirectory(from, to) || copied;
		} else if (entry.isFile()) {
			copied = copyFileIfMissing(from, to) || copied;
		}
		// Symlinks are intentionally skipped: the IDE state directory must
		// not inherit a link that points outside the user's home.
	}
	return copied;
}

function writeMarker(marker: string, legacyDir: string, migrated: boolean): void {
	const payload = JSON.stringify(
		{
			schemaVersion: 1,
			migrated,
			migratedFrom: legacyDir,
			migratedAt: new Date().toISOString(),
		},
		null,
		2,
	);
	fs.writeFileSync(marker, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
}

function hardenDir(dir: string): void {
	if (process.platform === 'win32') {
		return;
	}
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		// Best-effort: a mounted or read-only path may not support chmod.
	}
}

function hardenFile(file: string): void {
	if (process.platform === 'win32') {
		return;
	}
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// Best-effort, as above.
	}
}

function hardenPrivateFiles(dir: string): void {
	for (const name of PRIVATE_FILES) {
		const file = path.join(dir, name);
		try {
			if (fs.existsSync(file)) {
				hardenFile(file);
			}
		} catch {
			// Ignore and continue with the remaining files.
		}
	}
}
