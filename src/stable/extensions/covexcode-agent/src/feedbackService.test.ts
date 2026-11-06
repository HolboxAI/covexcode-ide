/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	buildFeedbackPayload,
	DEFAULT_FEEDBACK_ENDPOINT,
	FEEDBACK_MAX_LENGTH,
	FEEDBACK_QUEUE_MAX_ITEMS,
	feedbackForSubmission,
	feedbackOs,
	feedbackPrefill,
	FeedbackPayload,
	FeedbackService,
	FeedbackStorage,
	FeedbackTransport,
	GeneralFeedbackPayload,
	isEmptyFeedback,
	normalizeFeedback,
	postFeedbackJson,
	RejectFeedbackPayload,
	shouldSendFeedback,
	shouldSubmitFeedbackShortcut,
} from './feedbackService';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function rejectPayload(overrides: Partial<RejectFeedbackPayload> = {}): RejectFeedbackPayload {
	return {
		feedbackId: '00000000-0000-4000-8000-000000000000',
		type: 'reject',
		feedback: 'too slow',
		sessionId: 'session-1',
		turnId: '1',
		files: ['src/a.ts'],
		model: 'deepseek-v4-pro',
		provider: 'covexcode',
		ideVersion: '1.99.0',
		timestamp: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function generalPayload(overrides: Partial<GeneralFeedbackPayload> = {}): GeneralFeedbackPayload {
	return {
		feedbackId: '00000000-0000-4000-8000-000000000000',
		type: 'general',
		feedback: 'nice work',
		model: 'deepseek-v4-pro',
		provider: 'covexcode',
		ideVersion: '1.99.0',
		os: 'darwin',
		timestamp: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

function memoryStorage(initial: Record<string, unknown> = {}): FeedbackStorage & { values: Map<string, unknown> } {
	const values = new Map(Object.entries(initial));
	return {
		get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
		update: (key: string, value: unknown): void => { values.set(key, value); },
		values,
	};
}

function fakeTransport(): FeedbackTransport & { sent: FeedbackPayload[]; fail: boolean } {
	const transport = {
		fail: true,
		sent: [] as FeedbackPayload[],
		async send(item: FeedbackPayload): Promise<void> {
			if (transport.fail) {
				throw new Error('network down');
			}
			transport.sent.push(item);
		},
	};
	return transport;
}

test('the default endpoint is the covexcode feedback route', () => {
	assert.equal(DEFAULT_FEEDBACK_ENDPOINT, 'https://covexcode.com/api/feedback');
});

test('normalizeFeedback trims and enforces the 10000-char limit', () => {
	assert.equal(normalizeFeedback('  keep me  '), 'keep me');
	assert.equal(normalizeFeedback('   '), '');

	const over = `${'  '}${'a'.repeat(FEEDBACK_MAX_LENGTH + 5_000)}${'  '}`;
	const capped = normalizeFeedback(over);
	assert.equal(capped.length, FEEDBACK_MAX_LENGTH);
	assert.equal(capped, 'a'.repeat(FEEDBACK_MAX_LENGTH));
});

test('isEmptyFeedback treats whitespace-only input as empty', () => {
	assert.equal(isEmptyFeedback(''), true);
	assert.equal(isEmptyFeedback(' \n\t '), true);
	assert.equal(isEmptyFeedback('why'), false);
});

test('feedbackForSubmission returns undefined for empty/whitespace, trimmed text otherwise', () => {
	assert.equal(feedbackForSubmission('   '), undefined);
	assert.equal(feedbackForSubmission('  because  '), 'because');
	assert.equal(feedbackForSubmission('a'.repeat(FEEDBACK_MAX_LENGTH + 500))?.length, FEEDBACK_MAX_LENGTH);
});

test('CRLF input is trimmed, capped, and rejected when whitespace-only', () => {
	assert.equal(normalizeFeedback('\r\n  a\r\nb  \r\n'), 'a\r\nb');
	assert.equal(feedbackForSubmission('\r\n\t\r\n'), undefined);
	const capped = feedbackForSubmission('a\r\n'.repeat(FEEDBACK_MAX_LENGTH));
	assert.equal(capped?.length, FEEDBACK_MAX_LENGTH);
});

test('feedbackPrefill parses /feedback: no text, with text, and extra whitespace', () => {
	assert.equal(feedbackPrefill(''), '');
	assert.equal(feedbackPrefill('the diff view is slow'), 'the diff view is slow');
	assert.equal(feedbackPrefill('   spaced out  '), 'spaced out');
	assert.equal(feedbackPrefill('\n\t  '), '');
});

test('feedbackOs maps the three supported platforms and falls back to linux', () => {
	assert.equal(feedbackOs('darwin'), 'darwin');
	assert.equal(feedbackOs('win32'), 'win32');
	assert.equal(feedbackOs('linux'), 'linux');
	assert.equal(feedbackOs('freebsd'), 'linux');
});

test('shouldSendFeedback gates the startup flush on telemetry state', () => {
	assert.equal(shouldSendFeedback('off', true), false);
	assert.equal(shouldSendFeedback('all', false), false);
	assert.equal(shouldSendFeedback('all', true), true);
	assert.equal(shouldSendFeedback(undefined, undefined), false);
	assert.equal(shouldSendFeedback('error', true), true);
});

test('shortcut: Cmd+Enter on macOS, Ctrl+Enter on Windows/Linux, no cross-misfire', () => {
	// macOS
	assert.equal(shouldSubmitFeedbackShortcut('Enter', true, false, 'MacIntel'), true);
	assert.equal(shouldSubmitFeedbackShortcut('Enter', false, true, 'macOS'), false);
	// Windows
	assert.equal(shouldSubmitFeedbackShortcut('Enter', false, true, 'Win32'), true);
	assert.equal(shouldSubmitFeedbackShortcut('Enter', true, false, 'Windows'), false);
	// Linux
	assert.equal(shouldSubmitFeedbackShortcut('Enter', false, true, 'Linux x86_64'), true);
	assert.equal(shouldSubmitFeedbackShortcut('Enter', true, false, 'Linux'), false);
	// Non-Enter never submits
	assert.equal(shouldSubmitFeedbackShortcut('Tab', true, true, 'MacIntel'), false);
});

test('path filter drops absolutes, drives, UNC, and .. traversal on every host', () => {
	const built = buildFeedbackPayload({
		type: 'reject',
		feedback: 'x',
		sessionId: 's',
		turnId: '1',
		files: [
			'/home/u/a.ts',
			'C:\\Users\\u\\a.ts',
			'C:/Users/u/a.ts',
			'c:\\x',
			'\\\\srv\\share\\a.ts',
			'../x',
			'..\\x',
			'src/../../x',
			'src/a.ts',
			'src\\dir/a.ts',
		],
		model: '',
		provider: '',
		ideVersion: '',
	});
	assert.equal(built.type, 'reject');
	assert.deepEqual(built.files, ['src/a.ts', 'src\\dir/a.ts']);
});

test('buildFeedbackPayload builds a reject payload with type reject and session fields', () => {
	const built = buildFeedbackPayload({
		type: 'reject',
		feedback: `  ${'x'.repeat(FEEDBACK_MAX_LENGTH + 20)}  `,
		sessionId: 's',
		turnId: '2',
		files: ['src/a.ts', '/Users/dev/secret.txt', 'C:\\Users\\dev\\secret.txt', '\\\\server\\share'],
		model: 'gpt-4o',
		provider: 'openai',
		ideVersion: '1.99.0',
		timestamp: '2026-01-01T00:00:00.000Z',
	});
	assert.equal(built.type, 'reject');
	assert.equal(built.feedback.length, FEEDBACK_MAX_LENGTH);
	assert.deepEqual(built.files, ['src/a.ts']);
	assert.equal(built.sessionId, 's');
	assert.equal(built.turnId, '2');
	assert.equal(built.timestamp, '2026-01-01T00:00:00.000Z');
	assert.match(built.feedbackId, UUID_V4);
	// No general-only field leaks into a reject payload.
	assert.equal('os' in built, false);
});

test('buildFeedbackPayload builds a general payload with os and no reject fields', () => {
	const built = buildFeedbackPayload({
		type: 'general',
		feedback: '  hi there  ',
		model: 'm',
		provider: 'p',
		ideVersion: '1.99.0',
		os: 'win32',
		timestamp: '2026-01-01T00:00:00.000Z',
	});
	assert.equal(built.type, 'general');
	assert.equal(built.feedback, 'hi there');
	assert.equal(built.os, 'win32');
	assert.match(built.feedbackId, UUID_V4);
	assert.equal('sessionId' in built, false);
	assert.equal('turnId' in built, false);
	assert.equal('files' in built, false);
});

test('buildFeedbackPayload honours an explicit feedbackId and generates one otherwise', () => {
	const explicit = buildFeedbackPayload({
		type: 'reject',
		feedbackId: '11111111-1111-4111-8111-111111111111',
		feedback: 'x',
		sessionId: 's',
		turnId: '',
		files: [],
		model: '',
		provider: '',
		ideVersion: '',
	});
	assert.equal(explicit.feedbackId, '11111111-1111-4111-8111-111111111111');

	const generated = buildFeedbackPayload({
		type: 'general',
		feedback: 'x',
		model: '',
		provider: '',
		ideVersion: '',
		os: 'darwin',
	});
	assert.match(generated.feedbackId, UUID_V4);
});

test('buildFeedbackPayload defaults timestamp to now when omitted', () => {
	const fixed = new Date('2026-02-03T04:05:06.000Z');
	const built = buildFeedbackPayload({
		type: 'reject',
		feedback: 'nope',
		sessionId: 's',
		turnId: '',
		files: [],
		model: '',
		provider: '',
		ideVersion: '',
	}, () => fixed);
	assert.equal(built.timestamp, '2026-02-03T04:05:06.000Z');
});

test('postFeedbackJson rejects non-https endpoints before any fetch', async () => {
	let called = false;
	const fetchImpl = (async () => { called = true; return new Response('', { status: 200 }); }) as typeof fetch;
	await assert.rejects(() => postFeedbackJson('http://covexcode.com/feedback', rejectPayload(), 1_000, fetchImpl));
	await assert.rejects(() => postFeedbackJson('', rejectPayload(), 1_000, fetchImpl));
	assert.equal(called, false);
});

test('postFeedbackJson posts JSON and resolves on a 2xx response', async () => {
	let seenUrl = '';
	let seenBody = '';
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		seenUrl = String(url);
		seenBody = String(init?.body ?? '');
		return new Response('', { status: 200 });
	}) as typeof fetch;
	await postFeedbackJson('https://covexcode.com/feedback', rejectPayload(), 1_000, fetchImpl);
	assert.equal(seenUrl, 'https://covexcode.com/feedback');
	assert.deepEqual(JSON.parse(seenBody), rejectPayload());
});

test('postFeedbackJson rejects on a non-2xx response', async () => {
	const fetchImpl = (async () => new Response('', { status: 500 })) as typeof fetch;
	await assert.rejects(() => postFeedbackJson('https://covexcode.com/feedback', rejectPayload(), 1_000, fetchImpl));
});

test('a queued payload keeps its feedbackId across flush retries', async () => {
	const storage = memoryStorage();
	const transport = fakeTransport();
	const service = new FeedbackService(storage, transport);
	const item = buildFeedbackPayload({
		type: 'reject',
		feedback: 'one',
		sessionId: 's',
		turnId: '1',
		files: [],
		model: '',
		provider: '',
		ideVersion: '',
	});
	await service.submit(item);
	assert.equal(service.list()[0].feedbackId, item.feedbackId);

	transport.fail = false;
	await service.flush();
	assert.equal(transport.sent[0].feedbackId, item.feedbackId);
});

test('queued state persists across a service restart (new instance, same storage)', async () => {
	const storage = memoryStorage();
	const first = new FeedbackService(storage, fakeTransport());
	await first.submit(rejectPayload({ feedback: 'queued' }));

	const secondTransport = fakeTransport();
	secondTransport.fail = false;
	const second = new FeedbackService(storage, secondTransport);
	await second.flush();
	assert.deepEqual(secondTransport.sent.map(item => item.feedback), ['queued']);
});

test('a read-only storage rejects submit without crashing a later flush', async () => {
	const storage: FeedbackStorage = {
		get: () => undefined,
		update: () => { throw new Error('read-only'); },
	};
	const transport = fakeTransport();
	transport.fail = false;
	const service = new FeedbackService(storage, transport);
	await assert.rejects(() => service.submit(rejectPayload({ feedback: 'lost on write' })));
	await service.flush();
	assert.deepEqual(transport.sent, []);
});

test('submit queues locally when the transport fails, and flush retries in order', async () => {
	const storage = memoryStorage();
	const transport = fakeTransport();
	const service = new FeedbackService(storage, transport);

	await service.submit(rejectPayload({ feedback: 'one' }));
	await service.submit(generalPayload({ feedback: 'two' }));
	assert.deepEqual(service.list().map(item => item.feedback), ['one', 'two']);

	transport.fail = false;
	await service.flush();
	assert.deepEqual(service.list(), []);
	assert.deepEqual(transport.sent.map(item => item.feedback), ['one', 'two']);
});

test('flush stops at the first failed send so later items are retried next time', async () => {
	const storage = memoryStorage();
	const transport = fakeTransport();
	const service = new FeedbackService(storage, transport);

	await service.submit(rejectPayload({ feedback: 'one' }));
	await service.submit(generalPayload({ feedback: 'two' }));
	await service.flush();
	assert.deepEqual(service.list().map(item => item.feedback), ['one', 'two']);
});

test('the queue drops the oldest item once the cap is reached', async () => {
	const storage = memoryStorage();
	const transport = fakeTransport();
	const service = new FeedbackService(storage, transport, { maxQueue: 2 });

	await service.submit(rejectPayload({ feedback: 'one' }));
	await service.submit(generalPayload({ feedback: 'two' }));
	await service.submit(generalPayload({ feedback: 'three' }));

	assert.deepEqual(service.list().map(item => item.feedback), ['two', 'three']);
});

test('the shared queue treats reject and general fairly (strict FIFO, no type priority)', async () => {
	const storage = memoryStorage();
	const transport = fakeTransport();
	const service = new FeedbackService(storage, transport, { maxQueue: 2 });

	// General is queued first, so a later reject evicts the general, not the
	// other way around -- order is by arrival, never by type.
	await service.submit(generalPayload({ feedback: 'general-first' }));
	await service.submit(rejectPayload({ feedback: 'reject-second' }));
	await service.submit(rejectPayload({ feedback: 'reject-third' }));

	assert.deepEqual(service.list().map(item => item.feedback), ['reject-second', 'reject-third']);
});

test('a corrupt persisted queue degrades to empty instead of throwing', async () => {
	const storage = memoryStorage({ 'covexcode.feedback.queue.v1': [{ nope: true }, null, 'junk'] });
	const transport = fakeTransport();
	transport.fail = false;
	const service = new FeedbackService(storage, transport);
	assert.deepEqual(service.list(), []);
	await service.flush();
	assert.deepEqual(transport.sent, []);
});

test('the default queue cap is exported and non-zero', () => {
	assert.ok(FEEDBACK_QUEUE_MAX_ITEMS > 0);
});
