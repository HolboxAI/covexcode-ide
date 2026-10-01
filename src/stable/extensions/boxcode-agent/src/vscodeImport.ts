/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Import-from-VS-Code onboarding: locate an existing VS Code-family install on
 * this machine and pull its settings, keybindings, snippets, and extension
 * list into boxcode-ide.
 *
 * This module is deliberately `vscode`-free (see `frameworkDetector.ts` for
 * the same split): everything that touches the disk is a pure function of
 * `home`/`platform`/`env`, so the *decision* logic -- which installs exist,
 * what they contain, how two files merge -- is unit-testable with fixture
 * directories. The only thing this module never does is write to the *target*
 * boxcode-ide profile; that lives in `extension.ts`, which knows the real
 * user-data directory (`context.globalStorageUri`) and the `vscode` API.
 *
 * Layout, mirroring VS Code core's own path resolution
 * (`src/vs/platform/environment/{node/userDataPath.ts,common/environmentService.ts}`):
 *   - user data (settings/keybindings/snippets): <appData>/<nameShort>/User
 *       macOS   ~/Library/Application Support/<nameShort>
 *       Windows %APPDATA%/<nameShort>
 *       Linux   $XDG_CONFIG_HOME|<~/.config>/<nameShort>
 *   - installed extensions:                ~/<dataFolderName>/extensions
 */

export interface SourceInstallKind {
	/** Stable key, used as a label anchor rather than persisted anywhere. */
	id: string;
	label: string;
	/** The `nameShort` from the source product's `product.json`. */
	nameShort: string;
	/** The `dataFolderName` from the source product's `product.json`. */
	dataFolderName: string;
}

/** A concrete install on this machine, with its resolved directories. */
export interface SourceInstall extends SourceInstallKind {
	userDataDir: string;
	extensionsDir: string;
}

export interface SnippetFile {
	/** File name relative to `User/snippets/`, e.g. `ts.json`. */
	name: string;
	content: Record<string, unknown>;
}

export interface ImportSnapshot {
	install: SourceInstall;
	settings: Record<string, unknown> | undefined;
	keybindings: unknown[] | undefined;
	snippets: SnippetFile[];
	extensionIds: string[];
}

/**
 * The VS Code-family products we know how to import from, ordered by how
 * likely a boxcode-ide user is to be migrating from one. `nameShort` and
 * `dataFolderName` are stable per product (they are the product.json fields
 * the source app itself uses to place its files).
 */
export const KNOWN_SOURCE_INSTALLS: readonly SourceInstallKind[] = [
	{ id: 'vscode', label: 'Visual Studio Code', nameShort: 'Code', dataFolderName: '.vscode' },
	{ id: 'cursor', label: 'Cursor', nameShort: 'Cursor', dataFolderName: '.cursor' },
	{ id: 'vscodium', label: 'VSCodium', nameShort: 'VSCodium', dataFolderName: '.vscode-oss' },
	{ id: 'vscode-insiders', label: 'Visual Studio Code Insiders', nameShort: 'Code - Insiders', dataFolderName: '.vscode-insiders' },
	{ id: 'windsurf', label: 'Windsurf', nameShort: 'Windsurf', dataFolderName: '.windsurf' },
];

/** Resolves the user-data directory for a product's `nameShort`, matching
 * VS Code core's `getDefaultUserDataPath` (plus the `APPDATA`/`XDG_CONFIG_HOME`
 * overrides it honours). */
export function userDataDirFor(
	home: string,
	platform: NodeJS.Platform,
	nameShort: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (platform === 'darwin') {
		return path.join(home, 'Library', 'Application Support', nameShort);
	}
	if (platform === 'win32') {
		const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
		return path.join(appData, nameShort);
	}
	const configHome = env.XDG_CONFIG_HOME ?? path.join(home, '.config');
	return path.join(configHome, nameShort);
}

/** Resolves the installed-extensions directory for a product's `dataFolderName`
 * (`~/.<dataFolderName>/extensions` on every platform). */
export function extensionsDirFor(home: string, dataFolderName: string): string {
	return path.join(home, dataFolderName, 'extensions');
}

/** The installs that actually exist on this machine, i.e. whose user-data
 * `User/` directory or `extensions/` directory is present. Never throws. */
export function detectSourceInstalls(
	home: string,
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv = process.env,
): SourceInstall[] {
	const found: SourceInstall[] = [];
	for (const kind of KNOWN_SOURCE_INSTALLS) {
		const userDataDir = userDataDirFor(home, platform, kind.nameShort, env);
		const extensionsDir = extensionsDirFor(home, kind.dataFolderName);
		if (fs.existsSync(path.join(userDataDir, 'User')) || fs.existsSync(extensionsDir)) {
			found.push({ ...kind, userDataDir, extensionsDir });
		}
	}
	return found;
}

function readJson<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
	} catch {
		return undefined;
	}
}

/** Reads `User/settings.json` as an object, or `undefined` if missing or not a
 * plain object. Never throws. */
export function readSettings(userDataDir: string): Record<string, unknown> | undefined {
	const parsed = readJson<unknown>(path.join(userDataDir, 'User', 'settings.json'));
	if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
		return parsed as Record<string, unknown>;
	}
	return undefined;
}

/** Reads `User/keybindings.json` as an array, or `undefined` if missing or not
 * an array. Never throws. */
export function readKeybindings(userDataDir: string): unknown[] | undefined {
	const parsed = readJson<unknown>(path.join(userDataDir, 'User', 'keybindings.json'));
	if (Array.isArray(parsed)) {
		return parsed;
	}
	return undefined;
}

/** Reads every `*.json` file under `User/snippets/`, keyed by file name.
 * Invalid or non-object files are skipped. Never throws. */
export function readSnippets(userDataDir: string): SnippetFile[] {
	const dir = path.join(userDataDir, 'User', 'snippets');
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out: SnippetFile[] = [];
	for (const name of names) {
		if (!name.endsWith('.json')) {
			continue;
		}
		const content = readJson<unknown>(path.join(dir, name));
		if (content && typeof content === 'object' && !Array.isArray(content)) {
			out.push({ name, content: content as Record<string, unknown> });
		}
	}
	return out;
}

/**
 * Lists the extension ids installed under `extensionsDir` by reading each
 * extension's own `package.json` (`publisher` + `name`) rather than parsing
 * the folder name, which is both more robust (publisher/name may contain
 * hyphens and dots) and indifferent to how the source app named its folders.
 * Sorted, de-duplicated, never throws.
 */
export function readExtensionIds(extensionsDir: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const ids = new Set<string>();
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const manifest = readJson<{ name?: unknown; publisher?: unknown }>(
			path.join(extensionsDir, entry.name, 'package.json'),
		);
		if (manifest && typeof manifest.name === 'string' && typeof manifest.publisher === 'string') {
			ids.add(`${manifest.publisher}.${manifest.name}`);
		}
	}
	return [...ids].sort();
}

/** Reads everything an install has to offer in one pass. */
export function collectSourceSnapshot(install: SourceInstall): ImportSnapshot {
	return {
		install,
		settings: readSettings(install.userDataDir),
		keybindings: readKeybindings(install.userDataDir),
		snippets: readSnippets(install.userDataDir),
		extensionIds: readExtensionIds(install.extensionsDir),
	};
}

/** Whether a snapshot has anything worth importing. */
export function hasImportableContent(snapshot: ImportSnapshot): boolean {
	return Boolean(
		snapshot.settings
		|| (snapshot.keybindings && snapshot.keybindings.length > 0)
		|| snapshot.snippets.length > 0
		|| snapshot.extensionIds.length > 0,
	);
}

/**
 * Merge two settings objects. The imported (source) value wins on a key it
 * actually sets -- importing means "bring VS Code's settings in" -- while any
 * destination-only key (e.g. `boxcode.*`) survives untouched.
 */
export function mergeSettings(
	dest: Record<string, unknown>,
	src: Record<string, unknown>,
): Record<string, unknown> {
	return { ...dest, ...src };
}

/** Stable identity for a keybinding entry, so a re-import doesn't duplicate
 * the same `key` + `command`. Non-object entries fall back to their raw form. */
function keybindingIdentity(entry: unknown): string {
	if (entry && typeof entry === 'object') {
		const obj = entry as Record<string, unknown>;
		return `${String(obj.key ?? '')}::${String(obj.command ?? '')}`;
	}
	return String(entry);
}

/** Appends source keybindings not already present (by `key`+`command`) to the
 * destination list, preserving destination order and content. */
export function mergeKeybindings(dest: unknown[], src: unknown[]): unknown[] {
	const seen = new Set<string>();
	for (const entry of dest) {
		seen.add(keybindingIdentity(entry));
	}
	const merged = [...dest];
	for (const entry of src) {
		const id = keybindingIdentity(entry);
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		merged.push(entry);
	}
	return merged;
}
