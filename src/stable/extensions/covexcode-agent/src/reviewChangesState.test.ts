import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	clearForPaths,
	computePending,
	createEmptyReviewState,
	deserializeReviewState,
	hashBufferOrStat,
	hashFileOnDisk,
	markAccepted,
	markDismissedBlocked,
	normalizePath,
	planReject,
	serializeReviewState,
	shellWarningKey,
	type SidecarChangeEntry,
} from './reviewChangesState';

test('1. empty state hides review bar (no undoable or blocked entries)', () => {
	const state = createEmptyReviewState('sess-1');
	const res = computePending({ changes: [], shellWarning: null }, {}, state);
	assert.deepEqual(res.undoable, []);
	assert.deepEqual(res.blocked, []);
});

test('2. accept a.ts then turn 2 edits b.ts: only b.ts is pending and Reject All plans [b.ts]', () => {
	let state = createEmptyReviewState('sess-2');
	const turn1Changes: SidecarChangeEntry[] = [
		{ path: 'a.ts', turn: 1, touches: 1, action: 'restore' },
	];
	const pending1 = computePending(turn1Changes, { 'a.ts': 'sha256:aaa1' }, state);
	assert.equal(pending1.undoable.length, 1);
	assert.equal(pending1.undoable[0].kind, 'modified');

	state = markAccepted(
		state,
		pending1.undoable,
		{ 'a.ts': 'sha256:aaa1' },
		{ 'a.ts': { contentBase64: Buffer.from('a1').toString('base64') } },
	);

	const turn2Changes: SidecarChangeEntry[] = [
		{ path: 'a.ts', turn: 1, touches: 1, action: 'restore' },
		{ path: 'b.ts', turn: 2, touches: 1, action: 'delete' },
	];
	const pending2 = computePending(
		turn2Changes,
		{ 'a.ts': 'sha256:aaa1', 'b.ts': 'sha256:bbb1' },
		state,
	);
	assert.deepEqual(pending2.undoable.map(e => e.path), ['b.ts']);
	assert.equal(pending2.undoable[0].kind, 'added');

	const plan = planReject(pending2.undoable, state, 'snapshots');
	assert.deepEqual(plan, {
		sidecarRollback: ['b.ts'],
		restoreFromSnapshot: [],
	});
});

test('3. accepted file re-edited reappears and plans restoreFromSnapshot in snapshots mode', () => {
	let state = createEmptyReviewState('sess-3');
	state = markAccepted(
		state,
		[{ path: 'a.ts', touches: 1 }],
		{ 'a.ts': 'sha256:accepted' },
		{ 'a.ts': { contentBase64: Buffer.from('accepted').toString('base64') } },
	);

	const changes: SidecarChangeEntry[] = [
		{ path: 'a.ts', turn: 1, touches: 2, action: 'restore' },
	];
	const pending = computePending(changes, { 'a.ts': 'sha256:re-edited' }, state);
	assert.deepEqual(pending.undoable.map(e => e.path), ['a.ts']);

	const plan = planReject(pending.undoable, state, 'snapshots');
	assert.deepEqual(plan, {
		sidecarRollback: [],
		restoreFromSnapshot: ['a.ts'],
	});
});

test('4. revert then re-edit where touches repeats (1 -> 1) stays pending', () => {
	let state = createEmptyReviewState('sess-4');
	state = markAccepted(state, [{ path: 'a.ts', touches: 1 }], { 'a.ts': 'sha256:v1' });

	// Case A: rollback clears accepted state and re-edit starts touches at 1 again (Phase 0 Scenario 2)
	state = clearForPaths(state, ['a.ts']);
	const changesAfterReedit: SidecarChangeEntry[] = [
		{ path: 'a.ts', turn: 4, touches: 1, action: 'restore' },
	];
	const pendingAfterClear = computePending(changesAfterReedit, { 'a.ts': 'sha256:v4' }, state);
	assert.deepEqual(pendingAfterClear.undoable.map(e => e.path), ['a.ts']);

	// Case B: even if accepted record still exists with touches === 1, differing hash is still pending
	state = markAccepted(state, [{ path: 'a.ts', touches: 1 }], { 'a.ts': 'sha256:v1' });
	const pendingSameTouchesDiffHash = computePending(
		[{ path: 'a.ts', turn: 2, touches: 1, action: 'restore' }],
		{ 'a.ts': 'sha256:v2' },
		state,
	);
	assert.deepEqual(pendingSameTouchesDiffHash.undoable.map(e => e.path), ['a.ts']);
});

test('5. clearForPaths removes accepted and agentWrote for target paths only', () => {
	let state = createEmptyReviewState('sess-5');
	state = markAccepted(
		state,
		[{ path: 'a.ts', touches: 1 }, { path: 'b.ts', touches: 1 }],
		{ 'a.ts': 'sha256:a', 'b.ts': 'sha256:b' },
	);
	state = clearForPaths(state, ['a.ts']);
	assert.equal(state.accepted['a.ts'], undefined);
	assert.equal(state.agentWrote['a.ts'], undefined);
	assert.equal(state.accepted['b.ts']?.hash, 'sha256:b');
	assert.equal(state.agentWrote['b.ts'], 'sha256:b');
});

test('6. blocked and shellWarning entries do not gate auto-hide, do not break Reject All, and are dismissible', () => {
	let state = createEmptyReviewState('sess-6');
	const input = {
		changes: [
			{ path: 'a.ts', turn: 1, touches: 1, action: 'restore' as const },
			{ path: 'huge.bin', turn: 1, touches: 1, action: 'blocked' as const, reason: 'Too large' },
		],
		shellWarning: '1 shell command(s) ran: echo hi >> s.txt',
	};

	const pending = computePending(input, { 'a.ts': 'sha256:a' }, state);
	assert.deepEqual(pending.undoable.map(e => e.path), ['a.ts']);
	assert.equal(pending.blocked.length, 2);
	assert.ok(pending.blocked.every(e => e.kind === 'shell' && e.undoable === false));

	// Reject All ignores blocked entries
	const plan = planReject([...pending.undoable, ...pending.blocked], state, 'snapshots');
	assert.deepEqual(plan, { sidecarRollback: ['a.ts'], restoreFromSnapshot: [] });

	// Accept undoable entry: undoable becomes empty (bar auto-hides undoable section), blocked remains dismissible
	state = markAccepted(state, pending.undoable, { 'a.ts': 'sha256:a' });
	const pending2 = computePending(input, { 'a.ts': 'sha256:a' }, state);
	assert.deepEqual(pending2.undoable, []);
	assert.equal(pending2.blocked.length, 2);

	const warnKey = shellWarningKey(input.shellWarning);
	state = markDismissedBlocked(state, ['huge.bin', warnKey]);
	const pending3 = computePending(input, { 'a.ts': 'sha256:a' }, state);
	assert.deepEqual(pending3.blocked, []);
});

test('6b. agent created then deleted file (action=delete, hash=absent) is omitted from pending', () => {
	const state = createEmptyReviewState('sess-6b');
	const pending = computePending(
		{ changes: [{ path: 'temp.ts', turn: 1, touches: 1, action: 'delete' }], shellWarning: null },
		{ 'temp.ts': 'absent' },
		state,
	);
	assert.deepEqual(pending.undoable, []);
});

test('6c. restore entry where file is missing on disk maps to deleted kind', () => {
	const state = createEmptyReviewState('sess-6c');
	const pending = computePending(
		{ changes: [{ path: 'gone.ts', turn: 1, touches: 1, action: 'restore' }], shellWarning: null },
		{ 'gone.ts': 'absent' },
		state,
	);
	assert.equal(pending.undoable.length, 1);
	assert.equal(pending.undoable[0].kind, 'deleted');
});

test('7. normalizePath handles case folding, dotdot, outside-root rejection, and multi-root', () => {
	// macOS / Windows case folding & .. resolution
	const macRes = normalizePath('src/../Sub/File.ts', ['/Users/Dev/Project'], 'darwin');
	assert.ok(macRes);
	assert.equal(macRes.key, 'sub/file.ts');
	assert.equal(macRes.fsPath, '/Users/Dev/Project/Sub/File.ts');

	const winRes = normalizePath('C:\\Workspace\\Src\\..\\App.ts', ['c:\\workspace'], 'win32');
	assert.ok(winRes);
	assert.equal(winRes.key, 'app.ts');
	assert.equal(winRes.rootIndex, 0);

	// Linux stays case-sensitive
	const linuxA = normalizePath('Src/File.ts', ['/home/dev/repo'], 'linux');
	const linuxB = normalizePath('src/file.ts', ['/home/dev/repo'], 'linux');
	assert.ok(linuxA && linuxB);
	assert.notEqual(linuxA.key, linuxB.key);

	// Outside-root escapes rejected
	assert.equal(normalizePath('../outside.ts', ['/Users/Dev/Project'], 'darwin'), null);
	assert.equal(normalizePath('/etc/passwd', ['/Users/Dev/Project'], 'darwin'), null);
	assert.equal(normalizePath('/Users/Dev/Project-other/a.ts', ['/Users/Dev/Project'], 'darwin'), null);
	assert.equal(normalizePath('C:\\Other\\x.ts', ['C:\\Workspace'], 'win32'), null);
	assert.equal(normalizePath('/Users/Dev/Project', ['/Users/Dev/Project'], 'darwin'), null);

	// Multi-root keys do not collide
	const r0 = normalizePath('/repo-a/index.ts', ['/repo-a', '/repo-b'], 'linux');
	const r1 = normalizePath('/repo-b/index.ts', ['/repo-a', '/repo-b'], 'linux');
	assert.ok(r0 && r1);
	assert.equal(r0.rootIndex, 0);
	assert.equal(r1.rootIndex, 1);
	assert.notEqual(r0.key, r1.key);
});

test('8. serialize and deserialize round-trip and corrupt payload recovery', () => {
	let state = createEmptyReviewState('sess-8');
	state = markAccepted(
		state,
		[{ path: 'a.ts', touches: 2 }],
		{ 'a.ts': 'sha256:123' },
		{ 'a.ts': { contentBase64: Buffer.from('hello').toString('base64') } },
	);
	state = markDismissedBlocked(state, ['blocked.bin']);

	const encoded = serializeReviewState(state);
	const decoded = deserializeReviewState(encoded, 'fallback');
	assert.deepEqual(decoded, state);

	const recovered = deserializeReviewState('{not-valid-json', 'fallback-id');
	assert.deepEqual(recovered, createEmptyReviewState('fallback-id'));
});

test('9. hash fallback uses {mtime,size} above size cap or for binary files', async () => {
	const smallText = Buffer.from('hello world', 'utf8');
	const h1 = hashBufferOrStat(smallText, { size: smallText.length, mtimeMs: 1000 }, 1024);
	assert.ok(h1.startsWith('sha256:'));

	// Above cap -> stat:<mtime>:<size>
	const hBig = hashBufferOrStat(smallText, { size: 2048, mtimeMs: 1234.5 }, 1024);
	assert.equal(hBig, 'stat:1234:2048');

	// Binary NUL byte -> stat:<mtime>:<size>
	const binBuf = Buffer.from([0x61, 0x00, 0x62]);
	const hBin = hashBufferOrStat(binBuf, { size: binBuf.length, mtimeMs: 5000 }, 1024);
	assert.equal(hBin, 'stat:5000:3');

	// On-disk test including ENOENT -> 'absent'
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'covex-hash-'));
	try {
		const missingHash = await hashFileOnDisk(path.join(tmp, 'nope.txt'));
		assert.equal(missingHash, 'absent');

		const bigFile = path.join(tmp, 'big.txt');
		await fs.writeFile(bigFile, '0123456789abcdef', 'utf8');
		const hOver = await hashFileOnDisk(bigFile, 8);
		assert.match(hOver, /^stat:\d+:16$/);
	} finally {
		await fs.rm(tmp, { recursive: true, force: true });
	}
});

