/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'node:child_process';
import * as readline from 'node:readline';
import { EventEmitter } from 'node:events';

// Wire types mirror boxcode's own `src/protocol.rs` exactly -- see that
// module's own doc comments for the ACP v1 schema this implements. Kept to
// only the request/response/notification shapes this client actually sends
// or reads; boxcode's schema has more variants than are used here (see
// `SessionUpdate`'s own doc comment on `protocol.rs` for which of ACP v1's
// 11 variants it emits).

export interface ContentBlockText {
	type: 'text';
	text: string;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ToolCallUpdate {
	toolCallId: string;
	title?: string;
	kind?: string;
	status?: ToolCallStatus;
	content?: string;
}

export interface AcpToolCall {
	toolCallId: string;
	title: string;
	kind: string;
	status: ToolCallStatus;
}

/**
 * Deliberately flat rather than a discriminated union keyed on
 * `sessionUpdate`: boxcode's own ACP schema has more variants (11 in v1,
 * see `protocol.rs`'s own doc comment) than the three this client actually
 * renders, and a union with a catch-all `string`-tagged member for "every
 * other legal variant" defeats TypeScript's own discriminated-union
 * narrowing (the tag stops being a set of literals once one member's tag is
 * plain `string`). Every field here is read defensively in `renderUpdate`
 * (typeof/optional-chaining checks, not a trusted cast), which is the
 * actually-safe way to consume a schema wider than what this reads.
 */
export interface SessionUpdate {
	sessionUpdate: string;
	content?: ContentBlockText;
	title?: string;
	toolCallId?: string;
	kind?: string;
	status?: ToolCallStatus;
	[key: string]: unknown;
}

export interface SessionNotification {
	sessionId: string;
	update: SessionUpdate;
}

export interface PermissionOption {
	optionId: string;
	name: string;
	kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface RequestPermissionRequest {
	sessionId: string;
	toolCall: ToolCallUpdate;
	options: PermissionOption[];
}

export type RequestPermissionOutcome =
	| { outcome: 'cancelled' }
	| { outcome: 'selected'; optionId: string };

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
}

type RespondToPermission = (outcome: RequestPermissionOutcome) => void;

/**
 * A minimal ACP v1 client for a `boxcode --acp` subprocess -- JSON-RPC 2.0
 * over newline-delimited JSON on stdin/stdout, matching boxcode's own
 * `src/transport.rs` exactly (that module is the real server side of this
 * same protocol; see its own doc comments for the full picture, including
 * why `session/prompt` can take a while to resolve: it blocks until the
 * whole turn -- including any `session/request_permission` round trip back
 * through this same client -- is actually done).
 *
 * Deliberately not a general-purpose JSON-RPC library: boxcode only ever
 * speaks this one small, fixed vocabulary (`initialize` / `session/new` /
 * `session/prompt` sent out; `session/update` / `session/request_permission`
 * read in), so a hand-rolled dispatcher is clearer here than a generic
 * layer neither side needs.
 *
 * Emits: `update` (`SessionNotification`), `permissionRequest`
 * (`RequestPermissionRequest`, a callback to answer it), `stderr`
 * (`string`), `exit` (`code`, `signal`), `spawnError` (`Error`).
 */
export class AcpClient extends EventEmitter {
	private readonly child: cp.ChildProcessWithoutNullStreams;
	private readonly pending = new Map<number, PendingRequest>();
	private nextId = 1;
	private closed = false;

	/**
	 * `envOverrides` is deliberately layered on top of `process.env` (this
	 * extension host's own environment, which VS Code has already resolved
	 * to match the user's login shell -- see `localProcessExtensionHost.ts`)
	 * rather than replacing it, and only for the keys actually given: an
	 * empty override here must never blank out a real `BOXCODE_API_KEY` (or
	 * an existing `~/.boxcode/config.toml`) the user already has working
	 * from using the CLI directly.
	 */
	constructor(boxcodeCommand: string, cwd: string, envOverrides: NodeJS.ProcessEnv = {}) {
		super();
		this.child = cp.spawn(boxcodeCommand, ['--acp'], {
			cwd,
			env: { ...process.env, ...envOverrides },
		});

		const rl = readline.createInterface({ input: this.child.stdout });
		rl.on('line', line => this.handleLine(line));

		this.child.stderr.on('data', (chunk: Buffer) => this.emit('stderr', chunk.toString()));

		const failEverythingPending = (error: Error) => {
			this.closed = true;
			for (const { reject } of this.pending.values()) {
				reject(error);
			}
			this.pending.clear();
		};
		// A bad command (ENOENT) or a crash mid-turn both have to reach
		// whatever's currently `await`ing a `request()` call -- otherwise
		// that call just hangs forever instead of surfacing the real
		// failure, which is exactly the kind of bug this session already
		// found and fixed once on boxcode's own server side (see
		// transport.rs's docs on why `session/prompt` can't block inline).
		this.child.on('error', error => {
			failEverythingPending(error);
			this.emit('spawnError', error);
		});
		this.child.on('exit', (code, signal) => {
			failEverythingPending(new Error(`boxcode --acp exited (code ${code}, signal ${signal})`));
			this.emit('exit', code, signal);
		});
	}

	private handleLine(line: string): void {
		if (!line.trim()) {
			return;
		}
		let value: any;
		try {
			value = JSON.parse(line);
		} catch {
			return; // malformed line -- not this client's job to crash over, mirrors transport.rs's own read loop
		}

		if (value.method === 'session/update') {
			this.emit('update', value.params as SessionNotification);
			return;
		}
		if (value.method === 'session/request_permission') {
			const respond: RespondToPermission = outcome => {
				this.send({ jsonrpc: '2.0', id: value.id, result: outcome });
			};
			this.emit('permissionRequest', value.params as RequestPermissionRequest, respond);
			return;
		}
		if (typeof value.id !== 'undefined' && (value.result !== undefined || value.error !== undefined)) {
			const pending = this.pending.get(value.id);
			if (!pending) {
				return;
			}
			this.pending.delete(value.id);
			if (value.error) {
				pending.reject(new Error(value.error.message ?? 'boxcode --acp returned an error'));
			} else {
				pending.resolve(value.result);
			}
			return;
		}
		// An unrecognized request/notification from a newer boxcode version
		// -- ignored, same posture as `transport.rs`'s own handling of a
		// method it doesn't know: not this client's job to crash over.
	}

	private send(message: unknown): void {
		if (this.closed) {
			return;
		}
		try {
			this.child.stdin.write(`${JSON.stringify(message)}\n`);
		} catch {
			// The `error`/`exit` handlers above already fail every pending
			// request when the child actually goes away; a write racing
			// that teardown is not a separate failure to report twice.
		}
	}

	/**
	 * Returns `unknown` rather than a generic `T`: a generic executor's
	 * `resolve` would need casting down from `(value: T | PromiseLike<T>) =>
	 * void` to the `(result: unknown) => void` shape `pending` stores
	 * uniformly for every in-flight request regardless of method, which is
	 * exactly backwards for a function parameter (unsound under variance,
	 * not just noisy). Casting the other direction -- `unknown` to a known
	 * shape, at each call site below -- is the safe half of that cast.
	 */
	private request(method: string, params: unknown): Promise<unknown> {
		if (this.closed) {
			return Promise.reject(new Error('boxcode --acp is not running'));
		}
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ jsonrpc: '2.0', id, method, params });
		});
	}

	async initialize(): Promise<void> {
		await this.request('initialize', { protocolVersion: 1 });
	}

	async newSession(cwd: string): Promise<string> {
		const result = (await this.request('session/new', { cwd, mcpServers: [] })) as { sessionId: string };
		return result.sessionId;
	}

	/**
	 * Blocks until the whole turn -- including any permission round trip --
	 * is done, matching ACP v1's own `session/prompt` semantics exactly (it
	 * is not this client's place to second-guess that and time out early).
	 */
	async prompt(sessionId: string, text: string): Promise<StopReason> {
		const result = (await this.request('session/prompt', {
			sessionId,
			prompt: [{ type: 'text', text }],
		})) as { stopReason: StopReason };
		return result.stopReason;
	}

	dispose(): void {
		if (!this.closed) {
			this.child.kill();
		}
	}
}
