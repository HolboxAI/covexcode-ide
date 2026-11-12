/**
 * Session-scoped post-turn Review Bar controller.
 *
 * Designed with an injected `ReviewHost` interface and zero direct `vscode`
 * imports so all controller flows (safety checks, reload rehydration,
 * get_change_diff fallback, rollback planning) are tested directly under
 * `node --test`. `extension.ts` provides the live VS Code adapter.
 */

import * as path from 'node:path';
import type { GetChangeDiffResult, ListChangesResponse } from './acpClient';
import {
	clearForPaths,
	computePending,
	createEmptyReviewState,
	DEFAULT_HASH_SIZE_CAP_BYTES,
	deserializeReviewState,
	markAccepted,
	markDismissedBlocked,
	normalizePath,
	PHASE0_ROLLBACK_MODE,
	planReject,
	recordAgentWrote,
	serializeReviewState,
	type AcceptedSnapshot,
	type Kind,
	type NormalizedPathResult,
	type PendingReviewResult,
	type ReviewEntry,
	type SessionReviewState,
	type SidecarChangeEntry,
} from './reviewChangesState';

export interface ReviewAcpClient {
	listChanges(sessionId: string): Promise<ListChangesResponse>;
	/**
	 * Roll back explicit `files` only. NEVER pass `restoreBeforeTurn` from the
	 * Review Bar — Phase 0 Scenario 3B proved `restoreBeforeTurn` ignores
	 * `files` (reverting unrelated edits) and wipes earlier journal entries.
	 */
	rollback(sessionId: string, options?: { files?: string[]; turn?: never; restoreBeforeTurn?: never }): Promise<string>;
	getChangeDiff(sessionId: string, filePath: string, options?: { sinceTurn?: number }): Promise<GetChangeDiffResult | undefined>;
}

/**
 * Narrow rollback wrapper enforcing the Phase 0 Scenario 3B invariant:
 * only explicit `files` may be passed; `restoreBeforeTurn` is forbidden because
 * sidecar `restoreBeforeTurn` ignores `files` and wipes earlier turns' journal entries.
 */
export async function safeRollbackFiles(
	client: ReviewAcpClient,
	sessionId: string,
	files: readonly string[],
	forbiddenCheck?: Record<string, unknown>,
): Promise<string> {
	if (
		forbiddenCheck &&
		Object.prototype.hasOwnProperty.call(forbiddenCheck, 'restoreBeforeTurn') &&
		forbiddenCheck.restoreBeforeTurn !== undefined
	) {
		throw new Error(
			'Review Bar guard: rollback({ restoreBeforeTurn }) is forbidden because it ignores files and wipes earlier journal entries.',
		);
	}
	return client.rollback(sessionId, { files: [...files] });
}

export interface PublishedReviewEntry {
	/** Canonical key used by review actions (`accept`, `reject`, `openDiff`, `dismissBlocked`). */
	path: string;
	/** Workspace-relative path (prefixed with root folder name in multi-root windows). */
	displayPath: string;
	/** Full normalized path on disk inside workspace roots (empty for synthetic shell entries). */
	fsPath: string;
	kind: Kind;
	touches: number;
	undoable: boolean;
	reason?: string;
}

export interface PublishedReviewState {
	sessionResource: string | undefined;
	sessionId: string | undefined;
	undoable: PublishedReviewEntry[];
	blocked: PublishedReviewEntry[];
}

export interface GitBaselineResult {
	/** True when the file is tracked & clean relative to the git baseline (or clean before agent edit). */
	available: boolean;
	beforeContent?: string;
	existedBefore?: boolean;
}

export interface ReviewHost {
	getWorkspaceRoots(): readonly string[];
	getPlatform?(): NodeJS.Platform;
	getClientForSession(sessionId?: string): { client?: ReviewAcpClient; sessionId?: string; sessionResource?: string };
	getWorkspaceState<T = unknown>(key: string): T | undefined;
	updateWorkspaceState(key: string, value: unknown): Promise<void>;
	hashFile(fsPath: string, capBytes?: number): Promise<string | 'absent'>;
	readFileSnapshot(fsPath: string, capBytes?: number): Promise<AcceptedSnapshot | undefined>;
	readTextFile(fsPath: string): Promise<string | undefined>;
	writeFileSnapshot(fsPath: string, contentBase64: string): Promise<void>;
	deleteFileAndCloseTabs(fsPath: string): Promise<void>;
	isFileDirty(fsPath: string): boolean;
	confirmOverwrite(filePath: string, reason: 'dirty' | 'external'): Promise<boolean>;
	confirmBulkReject(displayPaths: readonly string[]): Promise<boolean>;
	notifyInfo(message: string): void;
	notifyWarning(message: string): void;
	gitBaseline(rootPath: string, fsPath: string): Promise<GitBaselineResult>;
	openDiffEditor(options: {
		beforeContent: string;
		afterContent?: string;
		afterFsPath?: string;
		title: string;
		readOnlySingle?: boolean;
	}): Promise<void>;
	openPlainFile(fsPath: string): Promise<void>;
	publishState(state: PublishedReviewState): void;
}

const STATE_KEY_PREFIX = 'covexcode.review.state.v1:';
const CHANGES_KEY_PREFIX = 'covexcode.review.changes.v1:';
const RESOURCE_MAP_KEY = 'covexcode.review.resourceMap.v1';
const ACTIVE_RESOURCE_KEY = 'covexcode.review.activeResource.v1';
const ACTIVE_SESSION_KEY = 'covexcode.review.activeSessionId.v1';

interface NormalizedChangeBundle {
	changes: SidecarChangeEntry[];
	shellWarning: string | null;
	hashes: Record<string, string | 'absent'>;
	metaByKey: Record<string, { relativePath: string; fsPath: string; rootIndex: number; rawPath: string; rootPath: string }>;
	rejectedOutsideRoot: string[];
}

export class ReviewController {
	private readonly states = new Map<string, SessionReviewState>();
	private readonly cachedChanges = new Map<string, ListChangesResponse>();
	private resourceToSession: Record<string, string> = {};
	private activeSessionId: string | undefined;
	private activeSessionResource: string | undefined;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private readonly debounceMs: number;
	private readonly hashCapBytes: number;

	constructor(
		private readonly host: ReviewHost,
		options?: { debounceMs?: number; hashCapBytes?: number },
	) {
		this.debounceMs = options?.debounceMs ?? 150;
		this.hashCapBytes = options?.hashCapBytes ?? DEFAULT_HASH_SIZE_CAP_BYTES;
	}

	private platform(): NodeJS.Platform {
		return this.host.getPlatform?.() ?? process.platform;
	}

	private getOrLoadState(sessionId: string): SessionReviewState {
		const existing = this.states.get(sessionId);
		if (existing) {
			return existing;
		}
		const persisted = this.host.getWorkspaceState<string>(`${STATE_KEY_PREFIX}${sessionId}`);
		const loaded = deserializeReviewState(persisted, sessionId);
		this.states.set(sessionId, loaded);
		return loaded;
	}

	private async saveState(sessionId: string, state: SessionReviewState): Promise<void> {
		this.states.set(sessionId, state);
		await this.host.updateWorkspaceState(`${STATE_KEY_PREFIX}${sessionId}`, serializeReviewState(state));
	}

	private async saveCachedChanges(sessionId: string, response: ListChangesResponse): Promise<void> {
		this.cachedChanges.set(sessionId, response);
		await this.host.updateWorkspaceState(`${CHANGES_KEY_PREFIX}${sessionId}`, response);
	}

	private loadCachedChanges(sessionId: string): ListChangesResponse | undefined {
		const mem = this.cachedChanges.get(sessionId);
		if (mem) {
			return mem;
		}
		const persisted = this.host.getWorkspaceState<ListChangesResponse>(`${CHANGES_KEY_PREFIX}${sessionId}`);
		if (persisted && Array.isArray(persisted.changes)) {
			this.cachedChanges.set(sessionId, persisted);
			return persisted;
		}
		return undefined;
	}

	/**
	 * Associates a VS Code chat `sessionResource` with an ACP `sessionId` and
	 * remembers the currently active session.
	 */
	async bindSession(sessionId: string, sessionResource?: string): Promise<void> {
		this.activeSessionId = sessionId;
		await this.host.updateWorkspaceState(ACTIVE_SESSION_KEY, sessionId);
		if (sessionResource) {
			this.activeSessionResource = sessionResource;
			this.resourceToSession[sessionResource] = sessionId;
			await this.host.updateWorkspaceState(RESOURCE_MAP_KEY, this.resourceToSession);
			await this.host.updateWorkspaceState(ACTIVE_RESOURCE_KEY, sessionResource);
		}
	}

	/** Rehydrates state from workspace storage on extension activation / window reload. */
	async rehydrate(): Promise<PublishedReviewState> {
		const storedMap = this.host.getWorkspaceState<Record<string, string>>(RESOURCE_MAP_KEY);
		if (storedMap && typeof storedMap === 'object') {
			this.resourceToSession = { ...storedMap };
		}
		const storedSession = this.host.getWorkspaceState<string>(ACTIVE_SESSION_KEY);
		const storedResource = this.host.getWorkspaceState<string>(ACTIVE_RESOURCE_KEY);
		if (storedSession) {
			this.activeSessionId = storedSession;
		}
		if (storedResource) {
			this.activeSessionResource = storedResource;
		}

		// Re-publish all known sessions for mounted widgets, then return the active one.
		const sessionResources = Object.keys(this.resourceToSession);
		let activePublished = this.emptyPublished(this.activeSessionResource, this.activeSessionId);

		if (sessionResources.length > 0) {
			for (const res of sessionResources) {
				const sid = this.resourceToSession[res];
				const pub = await this.refreshSession(sid, res, false);
				if (!this.activeSessionResource || res === this.activeSessionResource) {
					activePublished = pub;
				}
			}
		} else if (this.activeSessionId) {
			activePublished = await this.refreshSession(this.activeSessionId, this.activeSessionResource, false);
		} else {
			this.host.publishState(activePublished);
		}
		return activePublished;
	}

	/** Debounced 150ms refresh trigger for UI events, turn lifecycle, and session switches. */
	scheduleRefresh(options?: { sessionId?: string; sessionResource?: string; captureAgentWrote?: boolean }): void {
		if (this.disposed) {
			return;
		}
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		const sid = options?.sessionId ?? this.resolveSessionId(options?.sessionResource);
		const res = options?.sessionResource ?? this.resolveResourceForSession(sid);
		const capture = options?.captureAgentWrote ?? false;

		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			if (!this.disposed && sid) {
				void this.refreshSession(sid, res, capture);
			}
		}, this.debounceMs);
	}

	async onTurnEnded(sessionId: string, sessionResource?: string): Promise<PublishedReviewState> {
		await this.bindSession(sessionId, sessionResource);
		return this.refreshSession(sessionId, sessionResource ?? this.activeSessionResource, true);
	}

	async onExternalRollback(sessionId: string, clearedPaths?: readonly string[], sessionResource?: string): Promise<PublishedReviewState> {
		let state = this.getOrLoadState(sessionId);
		if (clearedPaths && clearedPaths.length > 0) {
			const roots = this.host.getWorkspaceRoots();
			const normKeys: string[] = [];
			for (const p of clearedPaths) {
				const norm = normalizePath(p, roots, this.platform());
				if (norm) {
					normKeys.push(norm.key);
				}
			}
			state = clearForPaths(state, normKeys);
		} else {
			// Full rollback: wipe accepted/agentWrote records while preserving session ID.
			state = createEmptyReviewState(sessionId);
		}
		await this.saveState(sessionId, state);
		return this.refreshSession(sessionId, sessionResource ?? this.resolveResourceForSession(sessionId), false);
	}

	async onSessionSwitched(sessionResource?: string): Promise<PublishedReviewState> {
		this.activeSessionResource = sessionResource;
		if (sessionResource) {
			await this.host.updateWorkspaceState(ACTIVE_RESOURCE_KEY, sessionResource);
		}
		const sid = this.resolveSessionId(sessionResource);
		if (!sid) {
			const empty = this.emptyPublished(sessionResource, undefined);
			this.host.publishState(empty);
			return empty;
		}
		this.activeSessionId = sid;
		return this.refreshSession(sid, sessionResource, false);
	}

	async getState(sessionResource?: string): Promise<PublishedReviewState> {
		const res = sessionResource ?? this.activeSessionResource;
		const sid = this.resolveSessionId(res);
		if (!sid) {
			return this.emptyPublished(res, undefined);
		}
		return this.computeAndBuildPublished(sid, res);
	}

	async accept(targetPaths?: readonly string[], sessionResource?: string): Promise<PublishedReviewState> {
		const { sessionId, resolvedResource } = this.requireTargetContext(sessionResource);
		if (!sessionId) {
			return this.emptyPublished(resolvedResource, undefined);
		}
		const { pending, bundle } = await this.evaluateSession(sessionId, false);
		const targets = this.selectUndoableTargets(pending.undoable, targetPaths);
		if (targets.length === 0) {
			return this.publishFor(sessionId, resolvedResource, pending, bundle);
		}

		let state = this.getOrLoadState(sessionId);
		const hashes: Record<string, string | 'absent'> = {};
		const snapshots: Record<string, AcceptedSnapshot | undefined> = {};

		for (const entry of targets) {
			const norm = this.validateEntryPath(entry);
			if (!norm) {
				continue;
			}
			const hash = await this.host.hashFile(norm.fsPath, this.hashCapBytes);
			hashes[entry.path] = hash;
			if (PHASE0_ROLLBACK_MODE === 'snapshots') {
				snapshots[entry.path] = hash === 'absent'
					? undefined
					: await this.host.readFileSnapshot(norm.fsPath, this.hashCapBytes);
			}
		}

		state = markAccepted(state, targets, hashes, snapshots);
		await this.saveState(sessionId, state);
		return this.refreshSession(sessionId, resolvedResource, false);
	}

	async acceptAll(sessionResource?: string): Promise<PublishedReviewState> {
		return this.accept(undefined, sessionResource);
	}

	async reject(targetPaths?: readonly string[], sessionResource?: string): Promise<PublishedReviewState> {
		const { sessionId, resolvedResource } = this.requireTargetContext(sessionResource);
		if (!sessionId) {
			return this.emptyPublished(resolvedResource, undefined);
		}

		const { client } = this.host.getClientForSession(sessionId);
		const { pending, bundle } = await this.evaluateSession(sessionId, false);
		let state = this.getOrLoadState(sessionId);
		const roots = this.host.getWorkspaceRoots();

		const selected = this.selectUndoableTargets(pending.undoable, targetPaths);
		const skipped: string[] = [];

		// If caller explicitly passed unknown / outside-root raw paths, reject them safely here.
		if (targetPaths && targetPaths.length > 0) {
			for (const raw of targetPaths) {
				const inPending = selected.some(s => s.path === raw);
				if (!inPending) {
					const norm = normalizePath(raw, roots, this.platform());
					if (!norm) {
						skipped.push(raw);
					}
				}
			}
		}

		const safeTargets: ReviewEntry[] = [];
		for (const entry of selected) {
			const norm = this.validateEntryPath(entry);
			if (!norm) {
				skipped.push(entry.relativePath || entry.path);
				continue;
			}

			// Section 6.2: open editor with unsaved changes
			if (this.host.isFileDirty(norm.fsPath)) {
				const ok = await this.host.confirmOverwrite(entry.relativePath, 'dirty');
				if (!ok) {
					skipped.push(entry.relativePath);
					continue;
				}
			}

			// Section 6.1: current disk hash differs from agentWrote[path]
			const expectedHash = state.agentWrote[entry.path];
			if (expectedHash !== undefined) {
				const currentHash = await this.host.hashFile(norm.fsPath, this.hashCapBytes);
				if (currentHash !== expectedHash) {
					const ok = await this.host.confirmOverwrite(entry.relativePath, 'external');
					if (!ok) {
						skipped.push(entry.relativePath);
						continue;
					}
				}
			}

			safeTargets.push(entry);
		}

		if (safeTargets.length > 1) {
			const displayList = safeTargets.map(t => this.formatDisplayPath(t, bundle));
			const confirmed = await this.host.confirmBulkReject(displayList);
			if (!confirmed) {
				if (skipped.length > 0) {
					this.reportSkipped(skipped);
				}
				return this.publishFor(sessionId, resolvedResource, pending, bundle);
			}
		}

		if (safeTargets.length > 0) {
			const plan = planReject(safeTargets, state, PHASE0_ROLLBACK_MODE);
			const entryByKey = new Map(safeTargets.map(e => [e.path, e]));

			// 1. Never-accepted files -> sidecar rollback({ files })
			if (plan.sidecarRollback.length > 0) {
				if (!client) {
					for (const key of plan.sidecarRollback) {
						const e = entryByKey.get(key);
						skipped.push(e?.relativePath ?? key);
					}
				} else {
					const rollbackFiles: string[] = [];
					for (const key of plan.sidecarRollback) {
						const meta = bundle.metaByKey[key];
						const entry = entryByKey.get(key);
						if (!meta || !entry) {
							continue;
						}
						// Prefer canonical workspace-relative path derived from normalized path, never '..'.
						rollbackFiles.push(roots.length > 1 ? meta.fsPath : meta.relativePath);
					}
					if (rollbackFiles.length > 0) {
						// Use safeRollbackFiles only — never pass restoreBeforeTurn (Scenario 3B).
						await safeRollbackFiles(client, sessionId, rollbackFiles);
					}
					// Safety cleanup for added files (reusing restoreCheckpoint delete + tab-close logic)
					for (const key of plan.sidecarRollback) {
						const entry = entryByKey.get(key);
						if (entry?.kind === 'added' && entry.fsPath) {
							await this.host.deleteFileAndCloseTabs(entry.fsPath);
						}
					}
					state = clearForPaths(state, plan.sidecarRollback);
				}
			}

			// 2. Previously-accepted files -> restore directly from accept-time snapshot
			for (const key of plan.restoreFromSnapshot) {
				const entry = entryByKey.get(key);
				const norm = entry ? this.validateEntryPath(entry) : null;
				const accepted = state.accepted[key];
				if (!norm || !accepted) {
					skipped.push(entry?.relativePath ?? key);
					continue;
				}
				if (accepted.hash === 'absent') {
					await this.host.deleteFileAndCloseTabs(norm.fsPath);
					state = recordAgentWrote(state, { [key]: 'absent' });
				} else if (accepted.snapshot?.contentBase64 !== undefined) {
					await this.host.writeFileSnapshot(norm.fsPath, accepted.snapshot.contentBase64);
					const restoredHash = await this.host.hashFile(norm.fsPath, this.hashCapBytes);
					state = recordAgentWrote(state, { [key]: restoredHash });
				} else {
					skipped.push(entry?.relativePath ?? key);
				}
			}

			await this.saveState(sessionId, state);
		}

		if (skipped.length > 0) {
			this.reportSkipped(skipped);
		}

		return this.refreshSession(sessionId, resolvedResource, false);
	}

	async rejectAll(sessionResource?: string): Promise<PublishedReviewState> {
		return this.reject(undefined, sessionResource);
	}

	async dismissBlocked(targetPaths?: readonly string[], sessionResource?: string): Promise<PublishedReviewState> {
		const { sessionId, resolvedResource } = this.requireTargetContext(sessionResource);
		if (!sessionId) {
			return this.emptyPublished(resolvedResource, undefined);
		}
		const { pending } = await this.evaluateSession(sessionId, false);
		const keysToDismiss = targetPaths && targetPaths.length > 0
			? pending.blocked.filter(b => targetPaths.includes(b.path)).map(b => b.path)
			: pending.blocked.map(b => b.path);
		if (keysToDismiss.length === 0) {
			return this.getState(resolvedResource);
		}
		let state = this.getOrLoadState(sessionId);
		state = markDismissedBlocked(state, keysToDismiss);
		await this.saveState(sessionId, state);
		return this.refreshSession(sessionId, resolvedResource, false);
	}

	async openDiff(targetPath: string, sessionResource?: string): Promise<void> {
		const { sessionId } = this.requireTargetContext(sessionResource);
		if (!sessionId) {
			return;
		}
		const { pending, bundle } = await this.evaluateSession(sessionId, false);
		const entry = [...pending.undoable, ...pending.blocked].find(e => e.path === targetPath);
		if (!entry) {
			this.host.notifyInfo(`covexcode: no pending review entry found for ${targetPath}.`);
			return;
		}
		if (!entry.undoable) {
			this.host.notifyInfo(entry.reason ?? `Cannot undo shell/blocked change: ${entry.relativePath}`);
			return;
		}

		const norm = this.validateEntryPath(entry);
		if (!norm) {
			this.host.notifyWarning(`covexcode: refusing to open diff outside workspace roots (${entry.relativePath}).`);
			return;
		}

		const { client } = this.host.getClientForSession(sessionId);
		const fileName = path.basename(norm.fsPath);
		const diffTitle = `${fileName} (Agent Changes)`;
		const state = this.getOrLoadState(sessionId);

		// 1. Try Phase 1 RPC (feature-detected)
		if (client) {
			const meta = bundle.metaByKey[entry.path];
			const rpcPath = this.host.getWorkspaceRoots().length > 1 ? norm.fsPath : (meta?.relativePath ?? entry.relativePath);
			try {
				const rpcDiff = await client.getChangeDiff(sessionId, rpcPath);
				if (rpcDiff) {
					if (!rpcDiff.existedBefore || entry.kind === 'added') {
						await this.host.openDiffEditor({
							beforeContent: '',
							afterContent: rpcDiff.after,
							afterFsPath: norm.fsPath,
							title: diffTitle,
						});
						return;
					}
					if (entry.kind === 'deleted') {
						await this.host.openDiffEditor({
							beforeContent: rpcDiff.before,
							title: `${fileName} (Deleted by Agent)`,
							readOnlySingle: true,
						});
						return;
					}
					await this.host.openDiffEditor({
						beforeContent: rpcDiff.before,
						afterContent: rpcDiff.after,
						afterFsPath: norm.fsPath,
						title: diffTitle,
					});
					return;
				}
			} catch {
				// Fall through cleanly to local fallback if RPC errors
			}
		}

		// 2. If accepted baseline snapshot exists in local state (e.g. accepted after turn 1, edited in turn 2), prefer it
		const acceptedRecord = state.accepted[entry.path];
		if (acceptedRecord && acceptedRecord.snapshot?.contentBase64 !== undefined) {
			const snapshotText = Buffer.from(acceptedRecord.snapshot.contentBase64, 'base64').toString('utf8');
			if (entry.kind === 'deleted') {
				await this.host.openDiffEditor({
					beforeContent: snapshotText,
					title: `${fileName} (Deleted by Agent)`,
					readOnlySingle: true,
				});
				return;
			}
			const afterText = await this.host.readTextFile(norm.fsPath);
			await this.host.openDiffEditor({
				beforeContent: snapshotText,
				afterContent: afterText,
				afterFsPath: norm.fsPath,
				title: diffTitle,
			});
			return;
		}

		// 3. Fallback when get_change_diff is absent: git baseline if clean in git, else open file plainly
		const baseline = await this.host.gitBaseline(norm.rootPath, norm.fsPath);
		if (baseline.available) {
			if (entry.kind === 'deleted') {
				await this.host.openDiffEditor({
					beforeContent: baseline.beforeContent ?? '',
					title: `${fileName} (Deleted by Agent)`,
					readOnlySingle: true,
				});
				return;
			}
			const afterText = await this.host.readTextFile(norm.fsPath);
			await this.host.openDiffEditor({
				beforeContent: entry.kind === 'added' ? '' : (baseline.beforeContent ?? ''),
				afterContent: afterText,
				afterFsPath: norm.fsPath,
				title: diffTitle,
			});
			return;
		}

		// No git baseline: open file plainly (never open a deleted/missing file!)
		if (entry.kind === 'deleted') {
			this.host.notifyInfo(`covexcode: ${entry.relativePath} was deleted by the agent and no prior baseline snapshot is available.`);
			return;
		}
		await this.host.openPlainFile(norm.fsPath);
	}

	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	private resolveSessionId(sessionResource?: string): string | undefined {
		if (sessionResource && this.resourceToSession[sessionResource]) {
			return this.resourceToSession[sessionResource];
		}
		// Only fall back to activeSessionId if caller asked generically (no specific resource),
		// OR if no resource mapping exists yet for the sole active session matching activeSessionResource.
		if (!sessionResource) {
			return this.activeSessionId;
		}
		if (!this.activeSessionResource && this.activeSessionId) {
			return this.activeSessionId;
		}
		return this.activeSessionResource === sessionResource ? this.activeSessionId : undefined;
	}

	private resolveResourceForSession(sessionId?: string): string | undefined {
		if (!sessionId) {
			return this.activeSessionResource;
		}
		for (const [res, sid] of Object.entries(this.resourceToSession)) {
			if (sid === sessionId) {
				return res;
			}
		}
		return this.activeSessionResource;
	}

	private requireTargetContext(sessionResource?: string): { sessionId: string | undefined; resolvedResource: string | undefined } {
		const resolvedResource = sessionResource ?? this.activeSessionResource;
		const sessionId = this.resolveSessionId(resolvedResource);
		return { sessionId, resolvedResource };
	}

	private emptyPublished(sessionResource: string | undefined, sessionId: string | undefined): PublishedReviewState {
		return {
			sessionResource,
			sessionId,
			undoable: [],
			blocked: [],
		};
	}

	private validateEntryPath(entry: Pick<ReviewEntry, 'path' | 'fsPath' | 'relativePath'>): NormalizedPathResult | null {
		const roots = this.host.getWorkspaceRoots();
		const candidate = entry.fsPath || entry.relativePath || entry.path;
		return normalizePath(candidate, roots, this.platform());
	}

	private selectUndoableTargets(undoable: readonly ReviewEntry[], targetPaths?: readonly string[]): ReviewEntry[] {
		if (!targetPaths || targetPaths.length === 0) {
			return [...undoable];
		}
		const wanted = new Set(targetPaths);
		return undoable.filter(entry => wanted.has(entry.path));
	}

	private reportSkipped(skipped: readonly string[]): void {
		const unique = [...new Set(skipped)];
		this.host.notifyWarning(`covexcode skipped ${unique.length} file(s): ${unique.join(', ')}`);
	}

	private formatDisplayPath(entry: ReviewEntry, bundle: NormalizedChangeBundle): string {
		if (!entry.undoable) {
			return entry.reason ?? entry.relativePath;
		}
		const roots = this.host.getWorkspaceRoots();
		const meta = bundle.metaByKey[entry.path];
		if (roots.length > 1 && meta) {
			return `${path.basename(meta.rootPath) || `root${meta.rootIndex}`}/${meta.relativePath}`;
		}
		return entry.relativePath;
	}

	private async refreshSession(
		sessionId: string,
		sessionResource: string | undefined,
		captureAgentWrote: boolean,
	): Promise<PublishedReviewState> {
		const { pending, bundle } = await this.evaluateSession(sessionId, captureAgentWrote);
		return this.publishFor(sessionId, sessionResource, pending, bundle);
	}

	private async computeAndBuildPublished(sessionId: string, sessionResource: string | undefined): Promise<PublishedReviewState> {
		const { pending, bundle } = await this.evaluateSession(sessionId, false);
		return this.toPublishedState(sessionId, sessionResource, pending, bundle);
	}

	private publishFor(
		sessionId: string,
		sessionResource: string | undefined,
		pending: PendingReviewResult,
		bundle: NormalizedChangeBundle,
	): PublishedReviewState {
		const published = this.toPublishedState(sessionId, sessionResource, pending, bundle);
		this.host.publishState(published);
		return published;
	}

	private toPublishedState(
		sessionId: string,
		sessionResource: string | undefined,
		pending: PendingReviewResult,
		bundle: NormalizedChangeBundle,
	): PublishedReviewState {
		const mapEntry = (entry: ReviewEntry): PublishedReviewEntry => ({
			path: entry.path,
			displayPath: this.formatDisplayPath(entry, bundle),
			fsPath: entry.fsPath,
			kind: entry.kind,
			touches: entry.touches,
			undoable: entry.undoable,
			...(entry.reason !== undefined ? { reason: entry.reason } : {}),
		});
		return {
			sessionResource,
			sessionId,
			undoable: pending.undoable.map(mapEntry),
			blocked: pending.blocked.map(mapEntry),
		};
	}

	private async evaluateSession(
		sessionId: string,
		captureAgentWrote: boolean,
	): Promise<{ pending: PendingReviewResult; bundle: NormalizedChangeBundle }> {
		const { client } = this.host.getClientForSession(sessionId);
		let response: ListChangesResponse | undefined;
		if (client) {
			try {
				response = await client.listChanges(sessionId);
				await this.saveCachedChanges(sessionId, response);
			} catch {
				response = this.loadCachedChanges(sessionId);
			}
		} else {
			response = this.loadCachedChanges(sessionId);
		}

		const rawList = response ?? { changes: [], shellWarning: undefined };
		const bundle = await this.normalizeAndHashChanges(rawList);
		let state = this.getOrLoadState(sessionId);

		if (captureAgentWrote && Object.keys(bundle.hashes).length > 0) {
			state = recordAgentWrote(state, bundle.hashes);
			await this.saveState(sessionId, state);
		}

		const pending = computePending(
			{ changes: bundle.changes, shellWarning: bundle.shellWarning },
			bundle.hashes,
			state,
			bundle.metaByKey,
		);
		return { pending, bundle };
	}

	private async normalizeAndHashChanges(response: ListChangesResponse): Promise<NormalizedChangeBundle> {
		const roots = this.host.getWorkspaceRoots();
		const plat = this.platform();
		const changes: SidecarChangeEntry[] = [];
		const hashes: Record<string, string | 'absent'> = {};
		const metaByKey: NormalizedChangeBundle['metaByKey'] = {};
		const rejectedOutsideRoot: string[] = [];

		for (const raw of response.changes) {
			const norm = normalizePath(raw.path, roots, plat);
			if (!norm) {
				rejectedOutsideRoot.push(raw.path);
				continue;
			}
			changes.push({
				path: norm.key,
				turn: raw.turn,
				touches: raw.touches,
				action: raw.action,
				reason: raw.reason ?? null,
			});
			metaByKey[norm.key] = {
				relativePath: norm.relativePath,
				fsPath: norm.fsPath,
				rootIndex: norm.rootIndex,
				rawPath: raw.path,
				rootPath: norm.rootPath,
			};
			if (raw.action !== 'blocked') {
				hashes[norm.key] = await this.host.hashFile(norm.fsPath, this.hashCapBytes);
			}
		}

		return {
			changes,
			shellWarning: response.shellWarning ?? null,
			hashes,
			metaByKey,
			rejectedOutsideRoot,
		};
	}
}

