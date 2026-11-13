/**
 * Pure state machine, path normalization, hashing, and rollback planning for
 * the post-turn Review Bar.
 *
 * Intentionally has ZERO `vscode` imports so it compiles cleanly under
 * `tsconfig.test.json` and runs directly under `node --test`.
 */

import * as crypto from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type Kind = 'added' | 'modified' | 'deleted' | 'shell';

export type Phase0RollbackMode = 'snapshots' | 'target-turn';

/**
 * Chosen from Phase 0 sidecar spike (`docs/review-bar-notes.md`):
 * `session/rollback({ files })` restores pre-session originals and
 * `restoreBeforeTurn` is not file-scoped, so the extension captures accept-time
 * snapshots and restores previously-accepted files directly.
 */
export const PHASE0_ROLLBACK_MODE: Phase0RollbackMode = 'snapshots';

export const DEFAULT_HASH_SIZE_CAP_BYTES = 5 * 1024 * 1024; // 5 MB

export interface SidecarChangeEntry {
	path: string;
	turn: number;
	touches: number;
	action: 'restore' | 'delete' | 'blocked';
	reason?: string | null;
}

export interface SidecarChangesInput {
	changes: readonly SidecarChangeEntry[];
	shellWarning?: string | null;
}

export interface ReviewEntry {
	/** Canonical key (multi-root safe, case-folded on win32/darwin, '/' separators). */
	path: string;
	/** Path relative to its workspace root using '/' separators for display. */
	relativePath: string;
	/** Resolved filesystem path inside a validated workspace root (empty for synthetic shell entries). */
	fsPath: string;
	/** Index of the matched workspace root in `roots` (-1 for synthetic shell entries). */
	rootIndex: number;
	kind: Kind;
	touches: number;
	undoable: boolean;
	reason?: string;
	insertions?: number;
	deletions?: number;
}

export interface AcceptedSnapshot {
	/** Base64-encoded UTF-8/binary content at accept time, or undefined if absent or omitted. */
	contentBase64?: string;
	/** Set to true when file exceeded the size cap and snapshot bytes were not buffered. */
	oversized?: boolean;
}

export interface AcceptedRecord {
	hash: string | 'absent';
	touches: number;
	snapshot?: AcceptedSnapshot;
}

export interface SessionReviewState {
	sessionId: string;
	accepted: Record<string, AcceptedRecord>;
	/** Content hash recorded right after the agent turn finished for Section 6 checks. */
	agentWrote: Record<string, string>;
	dismissedBlocked: string[];
}

export interface NormalizedPathResult {
	/** Canonical dictionary key: `relativePath` (single root) or `<idx>:<relativePath>` (multi-root), case-folded on win32/darwin. */
	key: string;
	/** Path relative to the matched root with `/` separators, preserving case. */
	relativePath: string;
	/** Full resolved path inside the matched root. */
	fsPath: string;
	rootIndex: number;
	rootPath: string;
}

export interface PendingReviewResult {
	undoable: ReviewEntry[];
	blocked: ReviewEntry[];
}

export interface RejectPlan {
	sidecarRollback: string[];
	restoreFromSnapshot: string[];
}

export function createEmptyReviewState(sessionId: string): SessionReviewState {
	return {
		sessionId,
		accepted: {},
		agentWrote: {},
		dismissedBlocked: [],
	};
}

function getPathModule(platform: NodeJS.Platform): path.PlatformPath {
	return platform === 'win32' ? path.win32 : path.posix;
}

function shouldFoldCase(platform: NodeJS.Platform): boolean {
	return platform === 'win32' || platform === 'darwin';
}

function normalizeSlashes(p: string): string {
	return p.replace(/\\/g, '/');
}

/**
 * Normalizes a raw sidecar path against workspace roots, resolving `..`,
 * folding case on Windows and macOS for lookup keys, supporting multi-root
 * workspaces, and returning `null` if the path falls outside every root or
 * resolves to a root directory itself.
 */
export function normalizePath(
	raw: string,
	roots: readonly string[],
	platform: NodeJS.Platform = process.platform,
): NormalizedPathResult | null {
	if (!raw || raw.includes('\0') || roots.length === 0) {
		return null;
	}

	const pathImpl = getPathModule(platform);
	const fold = shouldFoldCase(platform);
	const foldStr = (value: string): string => (fold ? value.toLowerCase() : value);

	const trimmed = raw.trim();
	if (!trimmed) {
		return null;
	}

	// Clean mixed slashes when normalizing a POSIX-style relative path on win32 or vice versa.
	const platformRaw = platform === 'win32'
		? trimmed.replace(/\//g, '\\')
		: trimmed.replace(/\\/g, '/');

	const isAbs = pathImpl.isAbsolute(platformRaw);
	const multiRoot = roots.length > 1;

	let bestMatch: { rootIndex: number; rootPath: string; resolved: string; rel: string } | null = null;

	if (isAbs) {
		const resolvedTarget = pathImpl.resolve(platformRaw);
		const foldedTarget = foldStr(resolvedTarget);

		for (let i = 0; i < roots.length; i++) {
			const root = roots[i];
			if (!root) {
				continue;
			}
			const resolvedRoot = pathImpl.resolve(root);
			const foldedRoot = foldStr(resolvedRoot);
			const foldedRel = pathImpl.relative(foldedRoot, foldedTarget);

			if (
				foldedRel === ''
				|| foldedRel === '..'
				|| foldedRel.startsWith(`..${pathImpl.sep}`)
				|| pathImpl.isAbsolute(foldedRel)
			) {
				continue;
			}

			// Prefer the most specific (longest) matching root when roots nest.
			if (!bestMatch || resolvedRoot.length > bestMatch.rootPath.length) {
				const rel = pathImpl.relative(resolvedRoot, resolvedTarget);
				bestMatch = { rootIndex: i, rootPath: resolvedRoot, resolved: resolvedTarget, rel };
			}
		}
	} else {
		// Relative paths resolve against primary root (roots[0]).
		const primaryRoot = roots[0];
		if (!primaryRoot) {
			return null;
		}
		const resolvedRoot = pathImpl.resolve(primaryRoot);
		const resolvedTarget = pathImpl.resolve(resolvedRoot, platformRaw);
		const foldedRel = pathImpl.relative(foldStr(resolvedRoot), foldStr(resolvedTarget));

		if (
			foldedRel !== ''
			&& foldedRel !== '..'
			&& !foldedRel.startsWith(`..${pathImpl.sep}`)
			&& !pathImpl.isAbsolute(foldedRel)
		) {
			const rel = pathImpl.relative(resolvedRoot, resolvedTarget);
			bestMatch = { rootIndex: 0, rootPath: resolvedRoot, resolved: resolvedTarget, rel };
		}
	}

	if (!bestMatch) {
		return null;
	}

	const relativePath = normalizeSlashes(bestMatch.rel);
	const rawKey = multiRoot ? `${bestMatch.rootIndex}:${relativePath}` : relativePath;
	const key = fold ? rawKey.toLowerCase() : rawKey;

	return {
		key,
		relativePath,
		fsPath: bestMatch.resolved,
		rootIndex: bestMatch.rootIndex,
		rootPath: bestMatch.rootPath,
	};
}

export function isBinaryBuffer(buf: Uint8Array): boolean {
	const checkLen = Math.min(buf.length, 8192);
	for (let i = 0; i < checkLen; i++) {
		if (buf[i] === 0) {
			return true;
		}
	}
	return false;
}

export function hashBufferOrStat(
	content: Buffer | null,
	stat: { size: number; mtimeMs: number } | null,
	sizeCapBytes: number = DEFAULT_HASH_SIZE_CAP_BYTES,
): string | 'absent' {
	if (!stat) {
		return 'absent';
	}
	if (stat.size > sizeCapBytes || !content || isBinaryBuffer(content)) {
		return `stat:${Math.trunc(stat.mtimeMs)}:${stat.size}`;
	}
	const hex = crypto.createHash('sha256').update(content).digest('hex');
	return `sha256:${hex}`;
}

export async function hashFileOnDisk(
	fsPath: string,
	sizeCapBytes: number = DEFAULT_HASH_SIZE_CAP_BYTES,
): Promise<string | 'absent'> {
	let stat: { size: number; mtimeMs: number; isFile: () => boolean };
	try {
		stat = await fs.stat(fsPath);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') {
			return 'absent';
		}
		throw err;
	}

	if (!stat.isFile()) {
		return `stat:${Math.trunc(stat.mtimeMs)}:${stat.size}`;
	}
	if (stat.size > sizeCapBytes) {
		return `stat:${Math.trunc(stat.mtimeMs)}:${stat.size}`;
	}
	const content = await fs.readFile(fsPath);
	return hashBufferOrStat(content, { size: stat.size, mtimeMs: stat.mtimeMs }, sizeCapBytes);
}

export function shellWarningKey(warning: string): string {
	const digest = crypto.createHash('sha256').update(warning).digest('hex').slice(0, 12);
	return `__shell__:${digest}`;
}

/**
 * Computes which changes still need user review vs non-undoable blocked notices.
 *
 * Notice:
 * - `currentHashes` is keyed by normalized key (`entry.path`) OR callers can pass
 *   pre-normalized `NormalizedChangeInput` / raw paths via `computePendingForWorkspace`.
 * - This pure helper expects each `change.path` to already match the canonical
 *   keys used in `currentHashes` and `state`.
 */
export function computePending(
	input: SidecarChangesInput | readonly SidecarChangeEntry[],
	currentHashes: Readonly<Record<string, string | 'absent'>>,
	state: SessionReviewState,
	metaByKey: Readonly<Record<string, { relativePath?: string; fsPath?: string; rootIndex?: number }>> = {},
): PendingReviewResult {
	const rawChanges = Array.isArray(input) ? input : (input as SidecarChangesInput).changes;
	const shellWarning = Array.isArray(input) ? undefined : (input as SidecarChangesInput).shellWarning;

	const undoable: ReviewEntry[] = [];
	const blocked: ReviewEntry[] = [];
	const dismissedSet = new Set(state.dismissedBlocked);

	for (const change of rawChanges) {
		const key = change.path;
		const meta = metaByKey[key];
		const relativePath = meta?.relativePath ?? key;
		const fsPath = meta?.fsPath ?? '';
		const rootIndex = meta?.rootIndex ?? 0;

		if (change.action === 'blocked') {
			if (!dismissedSet.has(key)) {
				blocked.push({
					path: key,
					relativePath,
					fsPath,
					rootIndex,
					kind: 'shell',
					touches: change.touches,
					undoable: false,
					reason: change.reason ?? undefined,
				});
			}
			continue;
		}

		const currentHash = Object.prototype.hasOwnProperty.call(currentHashes, key)
			? currentHashes[key]
			: 'absent';

		// Scenario 6: Agent created a file and deleted it in the same session, and nothing exists on disk now.
		if (change.action === 'delete' && currentHash === 'absent') {
			continue;
		}

		const accepted = state.accepted[key];
		if (accepted && accepted.hash === currentHash) {
			continue;
		}

		const kind: Kind = change.action === 'delete'
			? 'added'
			: currentHash === 'absent'
				? 'deleted'
				: 'modified';

		undoable.push({
			path: key,
			relativePath,
			fsPath,
			rootIndex,
			kind,
			touches: change.touches,
			undoable: true,
			reason: change.reason ?? undefined,
		});
	}

	if (shellWarning && shellWarning.trim()) {
		const warningKey = shellWarningKey(shellWarning);
		if (!dismissedSet.has(warningKey)) {
			blocked.push({
				path: warningKey,
				relativePath: shellWarning,
				fsPath: '',
				rootIndex: -1,
				kind: 'shell',
				touches: 1,
				undoable: false,
				reason: shellWarning,
			});
		}
	}

	return { undoable, blocked };
}

/**
 * Records accept-time baseline hashes (and optional snapshots) without mutating
 * the sidecar rollback journal, preserving per-turn Revert.
 */
export function markAccepted(
	state: SessionReviewState,
	entries: readonly Pick<ReviewEntry, 'path' | 'touches'>[],
	hashes: Readonly<Record<string, string | 'absent'>>,
	snapshots?: Readonly<Record<string, AcceptedSnapshot | undefined>>,
): SessionReviewState {
	const nextAccepted: Record<string, AcceptedRecord> = { ...state.accepted };
	const nextAgentWrote: Record<string, string> = { ...state.agentWrote };

	for (const entry of entries) {
		const currentHash = hashes[entry.path] ?? 'absent';
		const snapshot = snapshots?.[entry.path];
		nextAccepted[entry.path] = {
			hash: currentHash,
			touches: entry.touches,
			...(snapshot ? { snapshot } : {}),
		};
		nextAgentWrote[entry.path] = currentHash;
	}

	return {
		...state,
		accepted: nextAccepted,
		agentWrote: nextAgentWrote,
	};
}

/**
 * Clears review baselines/snapshots for the given normalized paths after rollback
 * or restore.
 */
export function clearForPaths(
	state: SessionReviewState,
	paths: readonly string[],
): SessionReviewState {
	if (paths.length === 0) {
		return state;
	}
	const targetSet = new Set(paths);
	const nextAccepted: Record<string, AcceptedRecord> = {};
	for (const [k, v] of Object.entries(state.accepted)) {
		if (!targetSet.has(k)) {
			nextAccepted[k] = v;
		}
	}
	const nextAgentWrote: Record<string, string> = {};
	for (const [k, v] of Object.entries(state.agentWrote)) {
		if (!targetSet.has(k)) {
			nextAgentWrote[k] = v;
		}
	}
	return {
		...state,
		accepted: nextAccepted,
		agentWrote: nextAgentWrote,
	};
}

export function markDismissedBlocked(
	state: SessionReviewState,
	paths: readonly string[],
): SessionReviewState {
	const set = new Set(state.dismissedBlocked);
	for (const p of paths) {
		set.add(p);
	}
	return {
		...state,
		dismissedBlocked: [...set],
	};
}

export function recordAgentWrote(
	state: SessionReviewState,
	hashes: Readonly<Record<string, string | 'absent'>>,
): SessionReviewState {
	return {
		...state,
		agentWrote: {
			...state.agentWrote,
			...hashes,
		},
	};
}

/**
 * Splits pending undoable entries into:
 * - `sidecarRollback`: files without a prior accept baseline, safe to pass to `session/rollback({ files })`.
 * - `restoreFromSnapshot`: files previously accepted, which must be restored from the extension's accept-time
 *   snapshot in `'snapshots'` mode because sidecar rollback resets to pre-session state.
 */
export function planReject(
	pending: readonly Pick<ReviewEntry, 'path' | 'undoable'>[],
	state: SessionReviewState,
	phase0Mode: Phase0RollbackMode = PHASE0_ROLLBACK_MODE,
): RejectPlan {
	const sidecarRollback: string[] = [];
	const restoreFromSnapshot: string[] = [];

	for (const entry of pending) {
		if (!entry.undoable) {
			continue;
		}
		if (phase0Mode === 'snapshots' && Object.prototype.hasOwnProperty.call(state.accepted, entry.path)) {
			restoreFromSnapshot.push(entry.path);
		} else {
			sidecarRollback.push(entry.path);
		}
	}

	return { sidecarRollback, restoreFromSnapshot };
}

export function serializeReviewState(state: SessionReviewState): string {
	return JSON.stringify(state);
}

export function deserializeReviewState(raw: string | undefined | null, fallbackSessionId: string): SessionReviewState {
	if (!raw || typeof raw !== 'string') {
		return createEmptyReviewState(fallbackSessionId);
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== 'object') {
			return createEmptyReviewState(fallbackSessionId);
		}
		const obj = parsed as Record<string, unknown>;
		const sessionId = typeof obj.sessionId === 'string' && obj.sessionId
			? obj.sessionId
			: fallbackSessionId;

		const accepted: Record<string, AcceptedRecord> = {};
		if (obj.accepted && typeof obj.accepted === 'object') {
			for (const [key, val] of Object.entries(obj.accepted as Record<string, unknown>)) {
				if (val && typeof val === 'object') {
					const rec = val as Record<string, unknown>;
					if (typeof rec.hash === 'string' && typeof rec.touches === 'number') {
						let snapshot: AcceptedSnapshot | undefined;
						if (rec.snapshot && typeof rec.snapshot === 'object') {
							const s = rec.snapshot as Record<string, unknown>;
							snapshot = {
								...(typeof s.contentBase64 === 'string' ? { contentBase64: s.contentBase64 } : {}),
								...(typeof s.oversized === 'boolean' ? { oversized: s.oversized } : {}),
							};
						}
						accepted[key] = {
							hash: rec.hash,
							touches: rec.touches,
							...(snapshot ? { snapshot } : {}),
						};
					}
				}
			}
		}

		const agentWrote: Record<string, string> = {};
		if (obj.agentWrote && typeof obj.agentWrote === 'object') {
			for (const [key, val] of Object.entries(obj.agentWrote as Record<string, unknown>)) {
				if (typeof val === 'string') {
					agentWrote[key] = val;
				}
			}
		}

		const dismissedBlocked: string[] = Array.isArray(obj.dismissedBlocked)
			? obj.dismissedBlocked.filter((v): v is string => typeof v === 'string')
			: [];

		return {
			sessionId,
			accepted,
			agentWrote,
			dismissedBlocked,
		};
	} catch {
		return createEmptyReviewState(fallbackSessionId);
	}
}

export interface TabInputLike {
	uri?: { scheme: string; fsPath: string };
	modified?: { scheme: string; fsPath: string };
	original?: { scheme: string; fsPath: string };
	textDiffs?: ReadonlyArray<{ modified?: { scheme: string; fsPath: string }; original?: { scheme: string; fsPath: string } }>;
}

export function normalizeTabComparePath(p: string, platform: NodeJS.Platform = process.platform): string {
	const resolved = path.resolve(p);
	try {
		const dir = nodeFs.realpathSync(path.dirname(resolved));
		const real = path.join(dir, path.basename(resolved));
		return platform === 'win32' || platform === 'darwin' ? real.toLowerCase() : real;
	} catch {
		return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
	}
}

export function shouldCloseTab(
	input: TabInputLike | undefined,
	rawPaths: readonly string[],
	wsPath: string | undefined,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (!input) {
		return false;
	}
	const normalizedTargets: string[] = [];
	for (const p of rawPaths) {
		const trimmed = p.trim();
		const absPath = path.isAbsolute(trimmed) ? trimmed : (wsPath ? path.join(wsPath, trimmed) : undefined);
		if (absPath) {
			normalizedTargets.push(normalizeTabComparePath(absPath, platform));
		}
	}

	const matchesTarget = (uri: { scheme: string; fsPath: string } | undefined): boolean => {
		if (!uri || uri.scheme !== 'file') {
			return false;
		}
		const normUri = normalizeTabComparePath(uri.fsPath, platform);
		if (normalizedTargets.some(target => target === normUri)) {
			return true;
		}
		return rawPaths.some(p => {
			const suffix = p.trim();
			return platform === 'win32' || platform === 'darwin'
				? normUri.endsWith(suffix.toLowerCase())
				: normUri.endsWith(suffix);
		});
	};

	if (matchesTarget(input.uri) || matchesTarget(input.modified)) {
		return true;
	}

	if (Array.isArray(input.textDiffs) && input.textDiffs.length > 0) {
		return input.textDiffs.every(td => matchesTarget(td.modified));
	}

	return false;
}


