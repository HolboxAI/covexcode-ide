/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CdpClient, CdpSession } from './cdpClient';

/**
 * A fake `CdpSession` that records every outgoing `sendMessage` call and
 * lets a test push an incoming message onto `onDidReceiveMessage`'s
 * listeners whenever it chooses -- standing in for the real
 * `vscode.BrowserCDPSession`, which only exists inside a running editor.
 * `CdpClient` depends on nothing but this shape (see `cdpClient.ts`'s own
 * doc comment), so this is a real test of its logic, not a mock of
 * something it doesn't actually use.
 */
class FakeCdpSession implements CdpSession {
	readonly sent: unknown[] = [];
	private readonly listeners: Array<(message: unknown) => void> = [];

	onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void } {
		this.listeners.push(listener);
		return { dispose: () => {
			const index = this.listeners.indexOf(listener);
			if (index !== -1) {
				this.listeners.splice(index, 1);
			}
		} };
	}

	async sendMessage(message: unknown): Promise<void> {
		this.sent.push(message);
	}

	/** Delivers `message` to every current listener, as the real session would when a CDP reply or event arrives. */
	deliver(message: unknown): void {
		for (const listener of [...this.listeners]) {
			listener(message);
		}
	}
}

test('send() resolves with the result whose id matches the outgoing command', async () => {
	const session = new FakeCdpSession();
	const cdp = new CdpClient(session);

	const reply = cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
	assert.equal(session.sent.length, 1);
	const outgoing = session.sent[0] as { id: number; method: string; params: unknown };
	assert.equal(outgoing.method, 'Page.captureScreenshot');
	assert.deepEqual(outgoing.params, { format: 'png' });

	session.deliver({ id: outgoing.id, result: { data: 'aGVsbG8=' } });
	assert.deepEqual(await reply, { data: 'aGVsbG8=' });
});

test('send() includes sessionId on the outgoing message when given one, and omits it otherwise', async () => {
	// Real regression coverage: `extension.ts`'s checkInBrowser sent every
	// Page.* command with no sessionId at all for a while, which the CDP
	// proxy on the other end silently routes to its own browser-level
	// handlers instead of the actual page -- coming back "Method not
	// found" for a method (Page.enable) that does exist, just not there.
	const session = new FakeCdpSession();
	const cdp = new CdpClient(session);

	void cdp.send('Page.enable', undefined, 'page-session-1');
	void cdp.send('Target.getTargets');

	const withSession = session.sent[0] as { sessionId?: string };
	const withoutSession = session.sent[1] as { sessionId?: string };
	assert.equal(withSession.sessionId, 'page-session-1');
	assert.equal('sessionId' in withoutSession, false);
});

test('send() rejects when the reply carries a matching-id error', async () => {
	const session = new FakeCdpSession();
	const cdp = new CdpClient(session);

	const reply = cdp.send('Page.navigate', { url: 'http://localhost:3000' });
	const outgoing = session.sent[0] as { id: number };
	session.deliver({ id: outgoing.id, error: { message: 'no such target' } });

	await assert.rejects(reply, /no such target/);
});

test('send() rejects on its own if no reply ever arrives, instead of hanging forever', async () => {
	// The real bug this covers: a backgrounded browser tab can fail to
	// produce a compositor frame for Page.captureScreenshot, so its reply
	// never comes. Before this timeout existed, that left the returned
	// promise permanently unsettled -- not rejected, just never resolved --
	// which is what actually hung a real chat turn end to end.
	const session = new FakeCdpSession();
	const cdp = new CdpClient(session);

	const reply = cdp.send('Page.captureScreenshot', { format: 'png' }, undefined, 10);
	// Deliberately never call session.deliver() -- this is the whole point.

	await assert.rejects(reply, /timed out waiting for a reply to Page\.captureScreenshot/);
});

test('two outstanding commands are correlated independently, not first-in-first-out', async () => {
	// The real reason this needs an id at all rather than a plain queue:
	// CDP replies are not guaranteed to arrive in the order the commands
	// were sent.
	const session = new FakeCdpSession();
	const cdp = new CdpClient(session);

	const first = cdp.send<{ tag: string }>('A');
	const second = cdp.send<{ tag: string }>('B');
	const [firstId, secondId] = session.sent.map(m => (m as { id: number }).id);

	// Deliver out of order: the second command's reply arrives first.
	session.deliver({ id: secondId, result: { tag: 'second' } });
	session.deliver({ id: firstId, result: { tag: 'first' } });

	assert.deepEqual(await first, { tag: 'first' });
	assert.deepEqual(await second, { tag: 'second' });
});

test('a message with no id is treated as an event, not a reply, and ignored by send()', async () => {
	const session = new FakeCdpSession();
	const cdp = new CdpClient(session);

	const reply = cdp.send<{ ok: boolean }>('Page.enable');
	const outgoing = session.sent[0] as { id: number };

	// An unrelated event notification, then the real reply -- the event
	// must not be mistaken for it.
	session.deliver({ method: 'Page.loadEventFired', params: {} });
	session.deliver({ id: outgoing.id, result: { ok: true } });

	assert.deepEqual(await reply, { ok: true });
});

test('waitForEvent() resolves with the params of the first matching event, ignoring others', async () => {
	const session = new FakeCdpSession();
	const cdp = new CdpClient(session);

	const waiting = cdp.waitForEvent('Page.loadEventFired', 1_000);
	session.deliver({ method: 'Page.frameStartedLoading', params: { frameId: 'x' } });
	session.deliver({ method: 'Page.loadEventFired', params: { timestamp: 42 } });

	assert.deepEqual(await waiting, { timestamp: 42 });
});

test('waitForEvent() rejects if the event never arrives within the timeout', async () => {
	const session = new FakeCdpSession();
	const cdp = new CdpClient(session);

	await assert.rejects(cdp.waitForEvent('Page.loadEventFired', 10), /timed out/);
});

test('dispose() rejects a command still in flight, rather than leaving it to hang', async () => {
	const session = new FakeCdpSession();
	const cdp = new CdpClient(session);

	const reply = cdp.send<{ ok: boolean }>('Page.enable');
	const outgoing = session.sent[0] as { id: number };
	cdp.dispose();

	await assert.rejects(reply, /disposed/);

	// A message delivered after dispose() must not retroactively resolve
	// it -- dispose() already rejected and removed it from `pending`, so
	// this has nothing left to match against.
	assert.doesNotThrow(() => session.deliver({ id: outgoing.id, result: { ok: true } }));
});
