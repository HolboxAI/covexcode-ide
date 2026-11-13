import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

import type { GetChangeDiffResult, ListChangesResponse } from './acpClient';
import {
	ReviewController,
	safeRollbackFiles,
	type GitBaselineResult,
	type PublishedReviewState,
	type ReviewAcpClient,
	type ReviewHost,
} from './reviewController';

function shaHash(content: string): string {
	return `sha256:${crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')}`;
}

function createHarness(options?: {
	root?: string;
	dirtyFiles?: Set<string>;
	confirmOverwriteAnswer?: boolean;
	confirmBulkAnswer?: boolean;
	gitBaselineFn?: (root: string, fsPath: string) => GitBaselineResult;
	getChangeDiffFn?: (sessionId: string, filePath: string) => Promise<GetChangeDiffResult | undefined>;
	storage?: Map<string, unknown>;
}) {
	const root = options?.root ?? '/workspace';
	const files = new Map<string, string>();
	const originals = new Map<string, string | null>();
	const storage = options?.storage ?? new Map<string, unknown>();
	const dirtyFiles = options?.dirtyFiles ?? new Set<string>();
	const warnings: string[] = [];
	const infos: string[] = [];
	const published: PublishedReviewState[] = [];
	const overwritePrompts: Array<{ filePath: string; reason: 'dirty' | 'external' }> = [];
	const bulkConfirms: string[][] = [];
	const openedDiffs: Array<{ beforeContent: string; afterContent?: string; afterFsPath?: string; title: string; readOnlySingle?: boolean }> = [];
	const openedPlain: string[] = [];
	const deletedTabsClosed: string[] = [];
	let listChangesResp: ListChangesResponse = { changes: [] };

	const client: ReviewAcpClient = {
		async listChanges(): Promise<ListChangesResponse> {
			return listChangesResp;
		},
		async rollback(_sid, opts): Promise<string> {
			for (const rel of opts?.files ?? []) {
				const full = path.posix.resolve(root, rel);
				const orig = originals.get(full);
				if (orig === null || orig === undefined) {
					files.delete(full);
				} else {
					files.set(full, orig);
				}
				listChangesResp = {
					...listChangesResp,
					changes: listChangesResp.changes.filter(c => path.posix.resolve(root, c.path) !== full),
				};
			}
			return 'ok';
		},
		async getChangeDiff(sid, filePath): Promise<GetChangeDiffResult | undefined> {
			if (options?.getChangeDiffFn) {
				return options.getChangeDiffFn(sid, filePath);
			}
			return undefined;
		},
	};

	let attachClient = true;
	const activeSessionId = 'acp-session-1';
	const sessionResource = 'vscode-chat-session://local/1';

	const host: ReviewHost = {
		getWorkspaceRoots: () => [root],
		getPlatform: () => 'linux',
		getClientForSession: () => (attachClient ? { client, sessionId: activeSessionId, sessionResource } : { sessionId: activeSessionId, sessionResource }),
		getWorkspaceState: <T>(key: string) => storage.get(key) as T | undefined,
		async updateWorkspaceState(key: string, value: unknown) {
			storage.set(key, value);
		},
		async hashFile(fsPath: string) {
			const content = files.get(fsPath);
			return content === undefined ? 'absent' : shaHash(content);
		},
		async readFileSnapshot(fsPath: string) {
			const content = files.get(fsPath);
			if (content === undefined) {
				return undefined;
			}
			return { contentBase64: Buffer.from(content, 'utf8').toString('base64') };
		},
		async readTextFile(fsPath: string) {
			return files.get(fsPath);
		},
		async writeFileSnapshot(fsPath: string, contentBase64: string) {
			files.set(fsPath, Buffer.from(contentBase64, 'base64').toString('utf8'));
		},
		async deleteFileAndCloseTabs(fsPath: string) {
			deletedTabsClosed.push(fsPath);
			files.delete(fsPath);
		},
		isFileDirty: (fsPath: string) => dirtyFiles.has(fsPath),
		async confirmOverwrite(filePath: string, reason: 'dirty' | 'external') {
			overwritePrompts.push({ filePath, reason });
			return options?.confirmOverwriteAnswer ?? false;
		},
		async confirmBulkReject(displayPaths: readonly string[]) {
			bulkConfirms.push([...displayPaths]);
			return options?.confirmBulkAnswer ?? true;
		},
		notifyInfo(msg: string) {
			infos.push(msg);
		},
		notifyWarning(msg: string) {
			warnings.push(msg);
		},
		async gitBaseline(r: string, fsPath: string) {
			return options?.gitBaselineFn ? options.gitBaselineFn(r, fsPath) : { available: false };
		},
		async openDiffEditor(opts) {
			openedDiffs.push(opts);
		},
		async openPlainFile(fsPath: string) {
			openedPlain.push(fsPath);
		},
		publishState(state) {
			published.push(state);
		},
	};

	const controller = new ReviewController(host, { debounceMs: 5 });

	return {
		controller,
		host,
		files,
		originals,
		storage,
		dirtyFiles,
		warnings,
		infos,
		published,
		overwritePrompts,
		bulkConfirms,
		openedDiffs,
		openedPlain,
		deletedTabsClosed,
		sessionId: activeSessionId,
		sessionResource,
		setAttachClient(val: boolean) {
			attachClient = val;
		},
		setListChanges(resp: ListChangesResponse) {
			listChangesResp = resp;
		},
	};
}

test('1. dirty editor: file skipped on decline and reported in one notification', async () => {
	const h = createHarness({ confirmOverwriteAnswer: false });
	h.originals.set('/workspace/a.ts', 'v0');
	h.files.set('/workspace/a.ts', 'v1');
	h.setListChanges({ changes: [{ path: 'a.ts', turn: 1, touches: 1, action: 'restore' }] });

	await h.controller.onTurnEnded(h.sessionId, h.sessionResource);
	h.dirtyFiles.add('/workspace/a.ts');

	await h.controller.rejectAll(h.sessionResource);
	assert.equal(h.overwritePrompts.length, 1);
	assert.deepEqual(h.overwritePrompts[0], { filePath: 'a.ts', reason: 'dirty' });
	assert.equal(h.files.get('/workspace/a.ts'), 'v1');
	assert.equal(h.warnings.length, 1);
	assert.match(h.warnings[0], /a\.ts/);
});

test('2. externally changed file after agent turn prompts overwrite', async () => {
	const h = createHarness({ confirmOverwriteAnswer: false });
	h.originals.set('/workspace/a.ts', 'v0');
	h.files.set('/workspace/a.ts', 'agent-v1');
	h.setListChanges({ changes: [{ path: 'a.ts', turn: 1, touches: 1, action: 'restore' }] });

	await h.controller.onTurnEnded(h.sessionId, h.sessionResource);

	// User edits file externally after turn completes
	h.files.set('/workspace/a.ts', 'user-edit');
	await h.controller.reject(['a.ts'], h.sessionResource);

	assert.equal(h.overwritePrompts.length, 1);
	assert.deepEqual(h.overwritePrompts[0], { filePath: 'a.ts', reason: 'external' });
	assert.equal(h.files.get('/workspace/a.ts'), 'user-edit');
	assert.equal(h.warnings.length, 1);
});

test('3. cancelled or errored turn still surfaces Review Bar entries', async () => {
	const h = createHarness();
	h.originals.set('/workspace/partial.ts', 'before');
	h.files.set('/workspace/partial.ts', 'partial-after-cancel');
	h.setListChanges({ changes: [{ path: 'partial.ts', turn: 1, touches: 1, action: 'restore' }] });

	const state = await h.controller.onTurnEnded(h.sessionId, h.sessionResource);
	assert.deepEqual(state.undoable.map(e => e.path), ['partial.ts']);
});

test('4. rehydration after reload preserves accepted baseline and pending changes without live client', async () => {
	const sharedStorage = new Map<string, unknown>();
	const h1 = createHarness({ storage: sharedStorage });
	h1.originals.set('/workspace/a.ts', 'v0');
	h1.files.set('/workspace/a.ts', 'v1-accepted');
	h1.originals.set('/workspace/b.ts', 'b0');
	h1.files.set('/workspace/b.ts', 'b1-pending');
	h1.setListChanges({
		changes: [
			{ path: 'a.ts', turn: 1, touches: 1, action: 'restore' },
			{ path: 'b.ts', turn: 1, touches: 1, action: 'restore' },
		],
	});

	await h1.controller.onTurnEnded(h1.sessionId, h1.sessionResource);
	await h1.controller.accept(['a.ts'], h1.sessionResource);

	// Simulate window reload: new ReviewController with no attached ACP daemon yet, only persisted workspaceState
	const h2 = createHarness({ storage: sharedStorage });
	h2.files.set('/workspace/a.ts', 'v1-accepted');
	h2.files.set('/workspace/b.ts', 'b1-pending');
	h2.setAttachClient(false);

	const rehydrated = await h2.controller.rehydrate();
	assert.deepEqual(rehydrated.undoable.map(e => e.path), ['b.ts']);
	assert.equal(rehydrated.sessionResource, h2.sessionResource);
});

test('5. openDiff uses get_change_diff when present, and falls back to git baseline or plain file when absent', async () => {
	// 5a: RPC present (modified & deleted)
	const hRpc = createHarness({
		getChangeDiffFn: async (_sid, p) => {
			if (p === 'mod.ts') {
				return { before: 'old', after: 'new', existedBefore: true };
			}
			if (p === 'del.ts') {
				return { before: 'deleted-before', after: '', existedBefore: true };
			}
			return undefined;
		},
	});
	hRpc.files.set('/workspace/mod.ts', 'new');
	hRpc.setListChanges({
		changes: [
			{ path: 'mod.ts', turn: 1, touches: 1, action: 'restore' },
			{ path: 'del.ts', turn: 1, touches: 1, action: 'restore' },
		],
	});
	await hRpc.controller.onTurnEnded(hRpc.sessionId, hRpc.sessionResource);
	await hRpc.controller.openDiff('mod.ts', hRpc.sessionResource);
	await hRpc.controller.openDiff('del.ts', hRpc.sessionResource);

	assert.equal(hRpc.openedDiffs.length, 2);
	assert.equal(hRpc.openedDiffs[0].beforeContent, 'old');
	assert.equal(hRpc.openedDiffs[0].afterContent, 'new');
	assert.equal(hRpc.openedDiffs[0].title, 'mod.ts (Agent Changes)');
	assert.equal(hRpc.openedDiffs[1].readOnlySingle, true);
	assert.equal(hRpc.openedDiffs[1].beforeContent, 'deleted-before');

	// 5b: RPC absent -> clean git baseline used for tracked.ts, plain file opened for untracked.ts
	const hFallback = createHarness({
		gitBaselineFn: (_root, fsPath) => {
			if (fsPath === '/workspace/tracked.ts') {
				return { available: true, beforeContent: 'git-head', existedBefore: true };
			}
			return { available: false };
		},
	});
	hFallback.files.set('/workspace/tracked.ts', 'after-git');
	hFallback.files.set('/workspace/untracked.ts', 'plain-content');
	hFallback.setListChanges({
		changes: [
			{ path: 'tracked.ts', turn: 1, touches: 1, action: 'restore' },
			{ path: 'untracked.ts', turn: 1, touches: 1, action: 'delete' },
		],
	});
	await hFallback.controller.onTurnEnded(hFallback.sessionId, hFallback.sessionResource);
	await hFallback.controller.openDiff('tracked.ts', hFallback.sessionResource);
	await hFallback.controller.openDiff('untracked.ts', hFallback.sessionResource);

	assert.equal(hFallback.openedDiffs.length, 1);
	assert.equal(hFallback.openedDiffs[0].beforeContent, 'git-head');
	assert.deepEqual(hFallback.openedPlain, ['/workspace/untracked.ts']);
});

test('6. bulk reject shows modal listing files and restores snapshot vs sidecar cleanly', async () => {
	const h = createHarness({ confirmBulkAnswer: true });
	h.originals.set('/workspace/a.ts', 'orig-a');
	h.files.set('/workspace/a.ts', 'accepted-a');
	h.originals.set('/workspace/new.ts', null);
	h.files.set('/workspace/new.ts', 'created-new');
	h.setListChanges({
		changes: [
			{ path: 'a.ts', turn: 1, touches: 1, action: 'restore' },
			{ path: 'new.ts', turn: 1, touches: 1, action: 'delete' },
		],
	});

	await h.controller.onTurnEnded(h.sessionId, h.sessionResource);
	await h.controller.accept(['a.ts'], h.sessionResource);

	// Turn 2 re-edits a.ts; new.ts is still never accepted
	h.files.set('/workspace/a.ts', 'turn2-a');
	h.setListChanges({
		changes: [
			{ path: 'a.ts', turn: 1, touches: 2, action: 'restore' },
			{ path: 'new.ts', turn: 1, touches: 1, action: 'delete' },
		],
	});
	await h.controller.onTurnEnded(h.sessionId, h.sessionResource);

	const afterReject = await h.controller.rejectAll(h.sessionResource);
	assert.equal(h.bulkConfirms.length, 1);
	assert.deepEqual(h.bulkConfirms[0], ['a.ts', 'new.ts']);
	// a.ts restored to accept-time snapshot (not orig-a!), new.ts deleted & tab closed
	assert.equal(h.files.get('/workspace/a.ts'), 'accepted-a');
	assert.equal(h.files.has('/workspace/new.ts'), false);
	assert.deepEqual(h.deletedTabsClosed, ['/workspace/new.ts']);
	assert.deepEqual(afterReject.undoable, []);
});

test('7. outside-root paths from sidecar are never forwarded to fs or rollback', async () => {
	const h = createHarness();
	h.setListChanges({
		changes: [{ path: '../secret.txt', turn: 1, touches: 1, action: 'restore' }],
	});
	const pub = await h.controller.onTurnEnded(h.sessionId, h.sessionResource);
	assert.deepEqual(pub.undoable, []);

	await h.controller.reject(['../secret.txt'], h.sessionResource);
	assert.equal(h.warnings.length, 1);
	assert.match(h.warnings[0], /secret\.txt/);
});

test('8. acceptAll clears undoable changes without clearing shell-warning or blocked entries', async () => {
	const h = createHarness();
	h.originals.set('/workspace/a.ts', 'v0');
	h.files.set('/workspace/a.ts', 'v1');
	h.setListChanges({
		changes: [
			{ path: 'a.ts', turn: 1, touches: 1, action: 'restore' },
			{ path: 'bin.dat', turn: 1, touches: 1, action: 'blocked', reason: 'Binary file not tracked' },
		],
		shellWarning: '1 shell command(s) also ran this session and are not undone by this: rm -rf tmp',
	});

	const before = await h.controller.onTurnEnded(h.sessionId, h.sessionResource);
	assert.deepEqual(before.undoable.map(e => e.path), ['a.ts']);
	assert.equal(before.blocked.length, 2);

	const afterAcceptAll = await h.controller.acceptAll(h.sessionResource);
	assert.deepEqual(afterAcceptAll.undoable, []);
	// Shell warning AND non-undoable blocked entry remain until explicitly dismissed
	assert.equal(afterAcceptAll.blocked.length, 2);
	assert.equal(afterAcceptAll.blocked.some(b => b.kind === 'shell'), true);
	assert.equal(afterAcceptAll.blocked.some(b => b.path === 'bin.dat'), true);
});

test('9. dismissBlocked persists across simulated window reload (both offline rehydrate and live reconnect)', async () => {
	const sharedStorage = new Map<string, unknown>();
	const h1 = createHarness({ storage: sharedStorage });
	const shellWarning = '1 shell command(s) also ran this session and are not undone by this: npm run gen';
	h1.files.set('/workspace/kept.ts', 'v1');
	h1.setListChanges({
		changes: [{ path: 'kept.ts', turn: 1, touches: 1, action: 'restore' }],
		shellWarning,
	});

	const initial = await h1.controller.onTurnEnded(h1.sessionId, h1.sessionResource);
	assert.equal(initial.blocked.length, 1);
	const shellKey = initial.blocked[0].path;

	// Accept file change and dismiss shell warning
	await h1.controller.acceptAll(h1.sessionResource);
	const afterDismiss = await h1.controller.dismissBlocked([shellKey], h1.sessionResource);
	assert.deepEqual(afterDismiss.undoable, []);
	assert.deepEqual(afterDismiss.blocked, []);

	// Simulate reload without live ACP client
	const hOffline = createHarness({ storage: sharedStorage });
	hOffline.files.set('/workspace/kept.ts', 'v1');
	hOffline.setAttachClient(false);
	const rehydratedOffline = await hOffline.controller.rehydrate();
	assert.deepEqual(rehydratedOffline.undoable, []);
	assert.deepEqual(rehydratedOffline.blocked, []);

	// Simulate ACP reconnect still returning the same accepted change & dismissed shellWarning
	hOffline.setAttachClient(true);
	hOffline.setListChanges({
		changes: [{ path: 'kept.ts', turn: 1, touches: 1, action: 'restore' }],
		shellWarning,
	});
	const rehydratedOnline = await hOffline.controller.rehydrate();
	assert.deepEqual(rehydratedOnline.undoable, []);
	assert.deepEqual(rehydratedOnline.blocked, []);
});

test('10. safeRollbackFiles rejects forbidden restoreBeforeTurn option', async () => {
	let called = false;
	const stubClient: ReviewAcpClient = {
		async listChanges() {
			return { changes: [] };
		},
		async rollback() {
			called = true;
			return 'ok';
		},
		async getChangeDiff() {
			return undefined;
		},
	};
	await assert.rejects(
		() => safeRollbackFiles(stubClient, 'sid', ['a.ts'], { restoreBeforeTurn: 1 }),
		/restoreBeforeTurn.*forbidden/,
	);
	assert.equal(called, false);
});
