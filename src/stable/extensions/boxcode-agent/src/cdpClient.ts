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
	sendMessage(message: unknown): Thenable<void>;
}

/**
 * The request/response half `vscode.proposed.browser`'s `BrowserCDPSession`
 * doesn't provide on its own: `sendMessage` returns `Thenable<void>`, not
 * the command's result, and every reply (and every unrelated event, like
 * `Page.loadEventFired`) arrives on the same `onDidReceiveMessage` stream.
 * This correlates outgoing commands to their replies by CDP's own `id`
 * field, and separately lets a caller wait for one named event.
 */
export class CdpClient {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
	private readonly listener: { dispose(): void };

	constructor(private readonly session: CdpSession) {
		this.listener = session.onDidReceiveMessage(message => this.handleMessage(message));
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
	 */
	async send<T = unknown>(method: string, params?: unknown, sessionId?: string): Promise<T> {
		const id = this.nextId++;
		const reply = new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (result: unknown) => void, reject });
		});
		await this.session.sendMessage(sessionId ? { id, method, params, sessionId } : { id, method, params });
		return reply;
	}

	waitForEvent(method: string, timeoutMs: number): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				sub.dispose();
				reject(new Error(`timed out waiting for ${method}`));
			}, timeoutMs);
			const sub = this.session.onDidReceiveMessage(message => {
				const { method: eventMethod, params } = (message ?? {}) as { method?: string; params?: unknown };
				if (eventMethod === method) {
					clearTimeout(timeout);
					sub.dispose();
					resolve(params);
				}
			});
		});
	}

	dispose(): void {
		this.listener.dispose();
	}
}
