/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * The exact slice of `vscode.BrowserCDPSession` (see this tree's own
 * `vscode.proposed.browser.d.ts`) `CdpClient` actually needs -- defined
 * locally rather than imported from `vscode`, so this module has no
 * dependency on the real extension host at all and can be unit-tested in
 * plain Node against a fake session (see `cdpClient.test.ts`). A real
 * `BrowserCDPSession` satisfies this structurally; no adapter needed at
 * the one real call site (`extension.ts`'s `checkInBrowser`).
 */
export interface CdpSession {
	onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void };
	sendMessage(message: unknown): PromiseLike<void>;
}

/** `send()`'s default timeout when a caller doesn't specify one -- see its own doc comment for why every command needs one at all. */
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

/**
 * The request/response half `vscode.proposed.browser`'s `BrowserCDPSession`
 * doesn't provide on its own: `sendMessage` returns `Thenable<void>`, not
 * the command's result, and every reply (and every unrelated event, like
 * `Page.loadEventFired`) arrives on the same `onDidReceiveMessage` stream.
 * This correlates outgoing commands to their replies by CDP's own `id`
 * field, and separately lets a caller wait for one named event.
 */
interface EventWaiter {
	dispose(): void;
	reject(error: Error): void;
	timeout: ReturnType<typeof setTimeout>;
}

export class CdpClient {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
	private readonly eventWaiters = new Set<EventWaiter>();
	private readonly listener: { dispose(): void };
	private readonly unrefTimers: boolean;

	constructor(private readonly session: CdpSession, options: { unrefTimers?: boolean } = {}) {
		this.unrefTimers = options.unrefTimers !== false;
		this.listener = session.onDidReceiveMessage(message => this.handleMessage(message));
	}

	private armTimeout(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
		const timeout = setTimeout(fn, ms);
		if (this.unrefTimers) {
			timeout.unref?.();
		}
		return timeout;
	}

	private handleMessage(message: unknown): void {
		if (typeof message !== 'object' || message === null) {
			return;
		}
		const { id, result, error } = message as { id?: number; result?: unknown; error?: { message?: string } };
		if (typeof id !== 'number') {
			return; // an event notification, not a reply -- see waitForEvent
		}
		const pending = this.pending.get(id);
		if (!pending) {
			return;
		}
		this.pending.delete(id);
		clearTimeout(pending.timeout);
		if (error) {
			pending.reject(new Error(error.message ?? 'CDP command failed'));
		} else {
			pending.resolve(result);
		}
	}

	/**
	 * `sessionId` matters once a target has been attached via
	 * `Target.attachToTarget` (see `extension.ts`'s `checkInBrowser`): the
	 * proxy backing this session (`platform/browserView/common/cdp/proxy.ts`'s
	 * `CDPBrowserProxy`) routes any command with no `sessionId` to its own
	 * small `Browser.*`/`Target.*` handler map, never to the actual page --
	 * `Page.enable` (or any other page-level method) sent without one comes
	 * back `Method not found`, which looks identical to the method genuinely
	 * not existing. Omitted (not sent as `undefined`) when absent, so a
	 * plain `Target.*`/`Browser.*` call's shape stays exactly what the proxy
	 * already expects for that path.
	 *
	 * `timeoutMs` is not optional in spirit even though it has a default:
	 * without one, a command whose reply never arrives (a backgrounded tab
	 * that never produces a compositor frame for `Page.captureScreenshot`
	 * is the real case that motivated this) leaves its promise unsettled
	 * forever -- not rejected, just never resolved -- which hangs whatever
	 * awaited it with no error to show for it. `waitForEvent` below already
	 * had this; `send` did not, which is the actual bug a real hang traced
	 * back to.
	 */
	send<T = unknown>(method: string, params?: unknown, sessionId?: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<T> {
		const id = this.nextId++;
		const reply = new Promise<T>((resolve, reject) => {
			const timeout = this.armTimeout(timeoutMs, () => {
				this.pending.delete(id);
				reject(new Error(`timed out waiting for a reply to ${method}`));
			});
			this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject, timeout });
		});
		void this.session.sendMessage(sessionId ? { id, method, params, sessionId } : { id, method, params }).then(undefined, (error: unknown) => {
			const pending = this.pending.get(id);
			if (pending) {
				this.pending.delete(id);
				clearTimeout(pending.timeout);
				pending.reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
		return reply;
	}

	waitForEvent(method: string, timeoutMs: number): Promise<unknown> {
		return new Promise((resolve, reject) => {
			let settled = false;
			let waiter: EventWaiter;
			const timeout = this.armTimeout(timeoutMs, () => {
				settle(() => reject(new Error(`timed out waiting for ${method}`)));
			});
			const sub = this.session.onDidReceiveMessage(message => {
				const { method: eventMethod, params } = (message ?? {}) as { method?: string; params?: unknown };
				if (eventMethod === method) {
					settle(() => resolve(params));
				}
			});
			const settle = (fn: () => void) => {
				if (settled) {
					return;
				}
				settled = true;
				this.eventWaiters.delete(waiter);
				clearTimeout(timeout);
				sub.dispose();
				fn();
			};
			waiter = {
				timeout,
				reject,
				dispose: () => settle(() => reject(new Error('CdpClient disposed before the event arrived'))),
			};
			this.eventWaiters.add(waiter);
		});
	}

	dispose(): void {
		// Without this, a command in flight when the session closes just
		// sits until its own timeout fires -- harmless once send() had one
		// at all, but there's no reason to make a caller wait out the rest
		// of it when we already know no reply is coming.
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timeout);
			pending.reject(new Error('CdpClient disposed before a reply arrived'));
			this.pending.delete(id);
		}
		// waitForEvent() registers a *second* listener on the session, not
		// the one stored in `this.listener`. checkInBrowser() always
		// dispose()s in a finally -- including when Page.navigate throws
		// before the load event -- so leaving those waiters alive used to
		// reject later as an unhandled rejection after the 10s timeout.
		for (const waiter of [...this.eventWaiters]) {
			waiter.dispose();
		}
		this.listener.dispose();
	}
}
