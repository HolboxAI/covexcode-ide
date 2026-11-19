#!/usr/bin/env -S node --experimental-strip-types
/**
 * Phase 0 gate spike for the Review Bar implementation.
 *
 * Exercises all 6 rollback / list_changes / cancellation scenarios against the
 * real `covexcode --acp` binary in an isolated temporary workspace.
 *
 * Usage:
 *   node --experimental-strip-types scripts/spike-rollback.ts [--scenario 1..6|all]
 */

import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';

interface ChangeEntry {
	path: string;
	turn: number;
	touches: number;
	action: 'restore' | 'delete' | 'blocked';
	reason?: string;
}

interface ListChangesResponse {
	changes: ChangeEntry[];
	shellWarning?: string;
}

interface PermissionOption {
	optionId: string;
	name: string;
	kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

interface RequestPermissionParams {
	sessionId: string;
	toolCall?: { title?: string; kind?: string; toolCallId?: string };
	options: PermissionOption[];
}

class SpikeAcpClient {
	private readonly child: cp.ChildProcessWithoutNullStreams;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private nextId = 1;
	private permissionMode: 'allow' | 'cancel_next' = 'allow';
	public onUpdateEvent?: (update: Record<string, unknown>) => void;
	public readonly permissionLog: string[] = [];

	constructor(bin: string, cwd: string, envOverrides: Record<string, string> = {}) {
		this.child = cp.spawn(bin, ['--acp'], {
			cwd,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: {
				...process.env,
				COVEXCODE_WORKSPACE: cwd,
				...envOverrides,
			},
		});

		const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
		rl.on('line', (line) => this.handleLine(line));

		this.child.stderr.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf8').trim();
			if (text) {
				console.error(`[sidecar stderr] ${text}`);
			}
		});

		this.child.on('exit', (code, signal) => {
			for (const [, p] of this.pending) {
				p.reject(new Error(`sidecar exited (code=${code}, signal=${signal})`));
			}
			this.pending.clear();
		});
	}

	setPermissionMode(mode: 'allow' | 'cancel_next'): void {
		this.permissionMode = mode;
	}

	private handleLine(line: string): void {
		if (!line.trim()) {
			return;
		}
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}

		if (msg.method === 'session/update') {
			const params = msg.params as { update?: Record<string, unknown> } | undefined;
			if (params?.update) {
				this.onUpdateEvent?.(params.update);
			}
			return;
		}

		if (msg.method === 'session/request_permission') {
			const params = msg.params as RequestPermissionParams;
			const title = params.toolCall?.title ?? params.toolCall?.kind ?? 'tool';
			this.permissionLog.push(`${this.permissionMode}: ${title}`);
			if (this.permissionMode === 'cancel_next') {
				this.permissionMode = 'allow';
				this.send({ jsonrpc: '2.0', id: msg.id, result: { outcome: 'cancelled' } });
				return;
			}
			const allow = params.options.find((o) => o.kind === 'allow_once')
				?? params.options.find((o) => o.kind === 'allow_always')
				?? params.options[0];
			const result = allow
				? { outcome: 'selected', optionId: allow.optionId }
				: { outcome: 'cancelled' };
			this.send({ jsonrpc: '2.0', id: msg.id, result });
			return;
		}

		if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
			const id = Number(msg.id);
			const entry = this.pending.get(id);
			if (!entry) {
				return;
			}
			this.pending.delete(id);
			if (msg.error) {
				const err = msg.error as { message?: string; code?: number };
				entry.reject(new Error(`JSON-RPC error ${err.code ?? ''}: ${err.message ?? JSON.stringify(msg.error)}`));
			} else {
				entry.resolve(msg.result);
			}
		}
	}

	private send(payload: unknown): void {
		this.child.stdin.write(`${JSON.stringify(payload)}\n`);
	}

	request<T = unknown>(method: string, params: unknown): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				resolve: (v) => resolve(v as T),
				reject,
			});
			this.send({ jsonrpc: '2.0', id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		this.send({ jsonrpc: '2.0', method, params });
	}

	async initialize(): Promise<unknown> {
		return this.request('initialize', { protocolVersion: 1 });
	}

	async newSession(cwd: string): Promise<string> {
		const res = await this.request<{ sessionId: string }>('session/new', { cwd, mcpServers: [] });
		return res.sessionId;
	}

	async prompt(sessionId: string, text: string): Promise<{ stopReason: string; turn: number }> {
		return this.request('session/prompt', {
			sessionId,
			prompt: [{ type: 'text', text }],
			mode: 'normal',
		});
	}

	async rollback(
		sessionId: string,
		options?: { files?: string[]; turn?: number; restoreBeforeTurn?: number },
	): Promise<{ summary: string }> {
		return this.request('session/rollback', { sessionId, ...options });
	}

	async listChanges(sessionId: string): Promise<ListChangesResponse> {
		return this.request('session/list_changes', { sessionId });
	}

	dispose(): void {
		this.child.kill();
	}
}

async function resolveBinary(): Promise<string> {
	if (process.env.COVEXCODE_BIN) {
		return process.env.COVEXCODE_BIN;
	}
	const localBin = path.join(os.homedir(), '.local', 'bin', 'covexcode');
	try {
		await fs.access(localBin);
		return localBin;
	} catch {
		return 'covexcode';
	}
}

async function readOrAbsent(filePath: string): Promise<string> {
	try {
		return await fs.readFile(filePath, 'utf8');
	} catch {
		return '<ABSENT>';
	}
}

async function withSession(
	bin: string,
	initialFiles: Record<string, string>,
	envOverrides: Record<string, string>,
	fn: (ctx: { client: SpikeAcpClient; sessionId: string; dir: string }) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'covex-spike-'));
	for (const [rel, content] of Object.entries(initialFiles)) {
		const full = path.join(dir, rel);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, content, 'utf8');
	}
	const client = new SpikeAcpClient(bin, dir, envOverrides);
	try {
		const init = await client.initialize();
		console.log('initialize:', JSON.stringify(init));
		const sessionId = await client.newSession(dir);
		await fn({ client, sessionId, dir });
	} finally {
		client.dispose();
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function scenario1And2(bin: string): Promise<void> {
	console.log('\n=== Scenario 1 & 2: Multi-turn edits, partial file rollback, then re-edit ===');
	await withSession(
		bin,
		{ 'a.ts': 'export const a = 0;\n', 'b.ts': 'export const b = 0;\n' },
		{ COVEXCODE_TOOLS_APPROVAL: '0' },
		async ({ client, sessionId, dir }) => {
			const t1 = await client.prompt(sessionId, 'Overwrite a.ts with exact content: "export const a = 1;\\n" and do nothing else.');
			console.log('Turn 1 done:', t1, 'a.ts =', JSON.stringify(await readOrAbsent(path.join(dir, 'a.ts'))));

			const t2 = await client.prompt(sessionId, 'Overwrite b.ts with exact content: "export const b = 2;\\n" and do nothing else.');
			console.log('Turn 2 done:', t2, 'b.ts =', JSON.stringify(await readOrAbsent(path.join(dir, 'b.ts'))));

			const t3 = await client.prompt(sessionId, 'Overwrite a.ts with exact content: "export const a = 3;\\n" and do nothing else.');
			console.log('Turn 3 done:', t3, 'a.ts =', JSON.stringify(await readOrAbsent(path.join(dir, 'a.ts'))));

			console.log('listChanges BEFORE rollback:', JSON.stringify(await client.listChanges(sessionId), null, 2));

			const rb1 = await client.rollback(sessionId, { files: ['a.ts'] });
			console.log('Scenario 1 rollback({files:["a.ts"]}):', JSON.stringify(rb1));
			console.log('Scenario 1 disk after rollback -> a.ts:', JSON.stringify(await readOrAbsent(path.join(dir, 'a.ts'))),
				'b.ts:', JSON.stringify(await readOrAbsent(path.join(dir, 'b.ts'))));
			console.log('Scenario 1 listChanges AFTER rollback:', JSON.stringify(await client.listChanges(sessionId), null, 2));

			// Scenario 2: edit a.ts again after rollback
			const t4 = await client.prompt(sessionId, 'Overwrite a.ts with exact content: "export const a = 4;\\n" and do nothing else.');
			console.log('Scenario 2 Turn 4 done:', t4, 'a.ts =', JSON.stringify(await readOrAbsent(path.join(dir, 'a.ts'))));
			console.log('Scenario 2 listChanges AFTER re-edit:', JSON.stringify(await client.listChanges(sessionId), null, 2));
		},
	);
}

async function scenario3(bin: string): Promise<void> {
	console.log('\n=== Scenario 3: rollback({ files, turn }) vs rollback({ files, restoreBeforeTurn }) ===');
	// Sub-test 3A: turn
	await withSession(
		bin,
		{ 'x.ts': 'v0\n', 'y.ts': 'y0\n' },
		{ COVEXCODE_TOOLS_APPROVAL: '0' },
		async ({ client, sessionId, dir }) => {
			await client.prompt(sessionId, 'Overwrite x.ts with exact content: "v1\\n" and do nothing else.');
			await client.prompt(sessionId, 'Overwrite x.ts with exact content: "v2\\n" and overwrite y.ts with exact content: "y2\\n".');
			console.log('3A before rollback listChanges:', JSON.stringify(await client.listChanges(sessionId), null, 2));
			try {
				const rb = await client.rollback(sessionId, { files: ['x.ts'], turn: 2 });
				console.log('3A rollback({files:["x.ts"], turn:2}) result:', JSON.stringify(rb));
			} catch (err) {
				console.log('3A rollback({files:["x.ts"], turn:2}) ERROR:', (err as Error).message);
			}
			console.log('3A disk -> x.ts:', JSON.stringify(await readOrAbsent(path.join(dir, 'x.ts'))),
				'y.ts:', JSON.stringify(await readOrAbsent(path.join(dir, 'y.ts'))));
			console.log('3A after rollback listChanges:', JSON.stringify(await client.listChanges(sessionId), null, 2));
		},
	);

	// Sub-test 3B: restoreBeforeTurn on single file
	await withSession(
		bin,
		{ 'x.ts': 'v0\n', 'y.ts': 'y0\n' },
		{ COVEXCODE_TOOLS_APPROVAL: '0' },
		async ({ client, sessionId, dir }) => {
			await client.prompt(sessionId, 'Overwrite x.ts with exact content: "v1\\n" and do nothing else.');
			await client.prompt(sessionId, 'Overwrite x.ts with exact content: "v2\\n" and overwrite y.ts with exact content: "y2\\n".');
			console.log('3B before rollback listChanges:', JSON.stringify(await client.listChanges(sessionId), null, 2));
			try {
				const rb = await client.rollback(sessionId, { files: ['x.ts'], restoreBeforeTurn: 2 });
				console.log('3B rollback({files:["x.ts"], restoreBeforeTurn:2}) result:', JSON.stringify(rb));
			} catch (err) {
				console.log('3B rollback({files:["x.ts"], restoreBeforeTurn:2}) ERROR:', (err as Error).message);
			}
			console.log('3B disk -> x.ts:', JSON.stringify(await readOrAbsent(path.join(dir, 'x.ts'))),
				'y.ts:', JSON.stringify(await readOrAbsent(path.join(dir, 'y.ts'))));
			console.log('3B after rollback listChanges:', JSON.stringify(await client.listChanges(sessionId), null, 2));
		},
	);
}

async function scenario4(bin: string): Promise<void> {
	console.log('\n=== Scenario 4: Shell command modifies a file ===');
	await withSession(
		bin,
		{ 's.txt': 'before\n' },
		{ COVEXCODE_TOOLS_APPROVAL: '0' },
		async ({ client, sessionId, dir }) => {
			const res = await client.prompt(
				sessionId,
				'Use the shell / bash / command execution tool (NOT write/edit file tools) to run: echo "from-shell" >> s.txt',
			);
			console.log('Scenario 4 turn done:', res, 's.txt =', JSON.stringify(await readOrAbsent(path.join(dir, 's.txt'))));
			console.log('Scenario 4 listChanges:', JSON.stringify(await client.listChanges(sessionId), null, 2));
		},
	);
}

async function scenario5(bin: string): Promise<void> {
	console.log('\n=== Scenario 5: Cancel / error a turn mid-edit ===');
	// Test without auto-approval so we can intercept the second tool call or send session/cancel after first edit
	await withSession(
		bin,
		{ 'c1.ts': 'orig1\n', 'c2.ts': 'orig2\n' },
		{},
		async ({ client, sessionId, dir }) => {
			let toolCallsSeen = 0;
			client.onUpdateEvent = (u) => {
				if (u.sessionUpdate === 'tool_call_update' && u.status === 'completed') {
					toolCallsSeen++;
					if (toolCallsSeen === 1) {
						console.log('First tool call completed, sending session/cancel notification + rejecting next permission');
						client.setPermissionMode('cancel_next');
						client.notify('session/cancel', { sessionId });
					}
				}
			};
			try {
				const res = await client.prompt(
					sessionId,
					'First overwrite c1.ts with "edited1\\n", then in a second separate tool call overwrite c2.ts with "edited2\\n".',
				);
				console.log('Scenario 5 prompt resolved:', res);
			} catch (err) {
				console.log('Scenario 5 prompt rejected:', (err as Error).message);
			}
			console.log('Scenario 5 permissionLog:', client.permissionLog);
			console.log('Scenario 5 disk -> c1.ts:', JSON.stringify(await readOrAbsent(path.join(dir, 'c1.ts'))),
				'c2.ts:', JSON.stringify(await readOrAbsent(path.join(dir, 'c2.ts'))));
			console.log('Scenario 5 listChanges:', JSON.stringify(await client.listChanges(sessionId), null, 2));
		},
	);
}

async function scenario6(bin: string): Promise<void> {
	console.log('\n=== Scenario 6: Agent creates a file, then deletes it ===');
	await withSession(
		bin,
		{},
		{ COVEXCODE_TOOLS_APPROVAL: '0' },
		async ({ client, sessionId, dir }) => {
			const res = await client.prompt(
				sessionId,
				'Create a new file named temp.ts containing "export const tmp = 1;\\n", and then delete temp.ts (either in the same turn or via tool calls).',
			);
			console.log('Scenario 6 turn done:', res, 'temp.ts =', JSON.stringify(await readOrAbsent(path.join(dir, 'temp.ts'))));
			console.log('Scenario 6 listChanges:', JSON.stringify(await client.listChanges(sessionId), null, 2));
		},
	);
}

async function main(): Promise<void> {
	const argIdx = process.argv.indexOf('--scenario');
	const which = argIdx >= 0 ? (process.argv[argIdx + 1] ?? 'all') : 'all';
	const bin = await resolveBinary();
	console.log('Using covexcode binary:', bin);

	const run = async (id: string, fn: () => Promise<void>) => {
		if (which === 'all' || which.split(',').includes(id)) {
			await fn();
		}
	};

	await run('1', () => scenario1And2(bin));
	if (which === '2') {
		await scenario1And2(bin);
	}
	await run('3', () => scenario3(bin));
	await run('4', () => scenario4(bin));
	await run('5', () => scenario5(bin));
	await run('6', () => scenario6(bin));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

