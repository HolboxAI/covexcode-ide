/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';

/**
 * Reject/general feedback submission.
 *
 * The covexcode.com endpoint does not exist yet, so the IDE side is built
 * behind a small interface and every payload that cannot be posted is queued
 * locally (capped, oldest-first) instead of lost. This module deliberately
 * has no `vscode` import so the limit/queue/retry logic can be unit tested
 * directly.
 *
 * TODO(covexcode.com): build the matching HTTPS endpoint. The client sends a
 * single JSON object as the POST body with `Content-Type: application/json`.
 * `type` tells the two payloads apart:
 *
 *   reject:
 *   {
 *     "feedbackId": "<UUID v4, generated once and stable across retries>",
 *     "type":       "reject",
 *     "feedback":   "<trimmed, max 10000 chars>",
 *     "sessionId":  "<ACP session id>",
 *     "turnId":     "<ACP turn number, empty if the turn had not finished>",
 *     "files":      ["<workspace-relative paths, no absolutes>"],
 *     "model":      "<effective model name>",
 *     "provider":   "<provider id, may be empty for a custom endpoint>",
 *     "ideVersion": "<VS Code version string>",
 *     "timestamp":  "<ISO 8601>"
 *   }
 *
 *   general:
 *   {
 *     "feedbackId": "<UUID v4, generated once and stable across retries>",
 *     "type":       "general",
 *     "feedback":   "<trimmed, max 10000 chars>",
 *     "ideVersion": "<VS Code version string>",
 *     "model":      "<effective model name>",
 *     "provider":   "<provider id, may be empty for a custom endpoint>",
 *     "os":         "<darwin|win32|linux>",
 *     "timestamp":  "<ISO 8601>"
 *   }
 *
 * The endpoint should accept 2xx, be idempotent for retries (dedupe on
 * `feedbackId`), and never be surfaced back to the user on failure (the
 * client queues and retries).
 */

export const FEEDBACK_MAX_LENGTH = 10_000;
export const FEEDBACK_QUEUE_KEY = 'covexcode.feedback.queue.v1';
export const FEEDBACK_QUEUE_MAX_ITEMS = 20;
export const FEEDBACK_POST_TIMEOUT_MS = 5_000;

export type FeedbackType = 'general' | 'reject';
export type FeedbackOs = 'darwin' | 'win32' | 'linux';

interface FeedbackPayloadBase {
	feedbackId: string;
	type: FeedbackType;
	feedback: string;
	model: string;
	provider: string;
	ideVersion: string;
	timestamp: string;
}

export interface RejectFeedbackPayload extends FeedbackPayloadBase {
	type: 'reject';
	sessionId: string;
	turnId: string;
	files: string[];
}

export interface GeneralFeedbackPayload extends FeedbackPayloadBase {
	type: 'general';
	os: FeedbackOs;
}

export type FeedbackPayload = RejectFeedbackPayload | GeneralFeedbackPayload;

export interface FeedbackQueueEntry {
	payload: FeedbackPayload;
	queuedAt: string;
}

export interface FeedbackStorage {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): void | PromiseLike<void>;
}

export interface FeedbackTransport {
	send(payload: FeedbackPayload): Promise<void>;
}

export interface FeedbackServiceOptions {
	maxQueue?: number;
	storageKey?: string;
}

export interface BuildRejectFeedbackInput {
	feedbackId?: string;
	type: 'reject';
	feedback: string;
	sessionId: string;
	turnId: string;
	files: readonly string[];
	model: string;
	provider: string;
	ideVersion: string;
	timestamp?: string;
}

export interface BuildGeneralFeedbackInput {
	feedbackId?: string;
	type: 'general';
	feedback: string;
	model: string;
	provider: string;
	ideVersion: string;
	os: FeedbackOs;
	timestamp?: string;
}

export type BuildFeedbackInput = BuildRejectFeedbackInput | BuildGeneralFeedbackInput;

/** Trim surrounding whitespace and enforce the hard length cap. */
export function normalizeFeedback(text: string, maxLength: number = FEEDBACK_MAX_LENGTH): string {
	return text.trim().slice(0, maxLength);
}

/** Whether the box is effectively empty (Submit must stay disabled). */
export function isEmptyFeedback(text: string): boolean {
	return text.trim().length === 0;
}

/**
 * The one decision point for "should this text be submitted?" — returns the
 * trimmed text to send, or `undefined` when it is empty or whitespace only.
 * The webview uses this on the host side as a defense in depth behind the
 * client-side disabled button.
 */
export function feedbackForSubmission(text: string, maxLength: number = FEEDBACK_MAX_LENGTH): string | undefined {
	const feedback = normalizeFeedback(text, maxLength);
	return isEmptyFeedback(feedback) ? undefined : feedback;
}

/** Whether feedback is allowed to send/flush given the IDE's telemetry state. */
export function shouldSendFeedback(telemetryLevel: string | undefined, feedbackEnabled: boolean | undefined): boolean {
	return (telemetryLevel ?? 'off') !== 'off' && (feedbackEnabled ?? true) !== false;
}

/** UUID v4 used to dedupe feedback on the server; stable across retries. */
export function generateFeedbackId(): string {
	return randomUUID();
}

/**
 * The single place `process.platform` is read for the feedback `os` field.
 * Normalised to the three platforms the IDE ships on; no other feedback code
 * may branch on the host OS.
 */
export function feedbackOs(platform: string = process.platform): FeedbackOs {
	if (platform === 'darwin') {
		return 'darwin';
	}
	if (platform === 'win32') {
		return 'win32';
	}
	return 'linux';
}

/** The text typed after `/feedback`, used to prefill the general window. */
export function feedbackPrefill(prompt: string): string {
	return prompt.trim();
}

/**
 * Whether a keydown should submit feedback. macOS uses Cmd+Enter; Windows and
 * Linux use Ctrl+Enter. The webview mirrors this inline because it cannot
 * import TypeScript -- keep the two in sync.
 */
export function shouldSubmitFeedbackShortcut(key: string, metaKey: boolean, ctrlKey: boolean, platform: string): boolean {
	if (key !== 'Enter') {
		return false;
	}
	return /mac/i.test(platform) ? metaKey : ctrlKey;
}

/**
 * Keeps only workspace-relative paths. Normalises both separators first so the
 * result is identical on every host: POSIX absolutes, Windows drive letters,
 * UNC paths, and any `..` traversal segment are dropped.
 */
function isWorkspaceRelativePath(candidate: string): boolean {
	if (typeof candidate !== 'string' || candidate.length === 0) {
		return false;
	}
	const normalized = candidate.replace(/\\/g, '/');
	if (/^[a-zA-Z]:\//.test(normalized)) {
		return false; // Windows drive: C:/x or c:/x (after normalising C:\x)
	}
	if (normalized.startsWith('//')) {
		return false; // UNC: \\srv\share -> //srv/share
	}
	if (normalized.startsWith('/')) {
		return false; // POSIX absolute: /x
	}
	if (normalized.split('/').includes('..')) {
		return false; // parent-directory traversal, both separators
	}
	return true;
}

export function buildFeedbackPayload(input: BuildFeedbackInput, now: () => Date = () => new Date()): FeedbackPayload {
	const base = {
		feedbackId: input.feedbackId ?? generateFeedbackId(),
		feedback: normalizeFeedback(input.feedback),
		model: input.model,
		provider: input.provider,
		ideVersion: input.ideVersion,
		timestamp: input.timestamp ?? now().toISOString(),
	};
	if (input.type === 'general') {
		return { ...base, type: 'general', os: input.os };
	}
	return {
		...base,
		type: 'reject',
		sessionId: input.sessionId,
		turnId: input.turnId,
		files: input.files.filter(isWorkspaceRelativePath),
	};
}

/**
 * POST a payload to the configured endpoint. Kept as the single network entry
 * point so the real covexcode.com endpoint can be dropped in behind one
 * interface (`FeedbackTransport`) without touching the queue.
 */
export async function postFeedbackJson(
	endpoint: string,
	payload: FeedbackPayload,
	timeoutMs: number = FEEDBACK_POST_TIMEOUT_MS,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	const url = endpoint.trim();
	if (!/^https:\/\//i.test(url)) {
		throw new Error('covexcode.feedback.endpoint must be an https URL');
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`feedback endpoint returned ${response.status}`);
		}
	} finally {
		clearTimeout(timer);
	}
}

function isFeedbackPayload(value: unknown): value is FeedbackPayload {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.feedbackId !== 'string'
		|| typeof candidate.feedback !== 'string'
		|| typeof candidate.type !== 'string'
		|| typeof candidate.model !== 'string'
		|| typeof candidate.provider !== 'string'
		|| typeof candidate.ideVersion !== 'string'
		|| typeof candidate.timestamp !== 'string') {
		return false;
	}
	if (candidate.type === 'general') {
		return typeof candidate.os === 'string';
	}
	if (candidate.type === 'reject') {
		return typeof candidate.sessionId === 'string'
			&& typeof candidate.turnId === 'string'
			&& Array.isArray(candidate.files)
			&& candidate.files.every(file => typeof file === 'string');
	}
	return false;
}

function isQueueEntry(value: unknown): value is FeedbackQueueEntry {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return isFeedbackPayload(candidate.payload) && typeof candidate.queuedAt === 'string';
}

export class FeedbackService {
	constructor(
		private readonly storage: FeedbackStorage,
		private readonly transport: FeedbackTransport,
		private readonly options: FeedbackServiceOptions = {},
	) {}

	private queueKey(): string {
		return this.options.storageKey ?? FEEDBACK_QUEUE_KEY;
	}

	private maxQueue(): number {
		return this.options.maxQueue ?? FEEDBACK_QUEUE_MAX_ITEMS;
	}

	/** Read the persisted queue, dropping anything malformed or beyond the cap. */
	private read(): FeedbackQueueEntry[] {
		const raw = this.storage.get<unknown>(this.queueKey());
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw.filter(isQueueEntry).slice(0, this.maxQueue());
	}

	private write(entries: FeedbackQueueEntry[]): void | PromiseLike<void> {
		return this.storage.update(this.queueKey(), entries.slice(0, this.maxQueue()));
	}

	/** Queue a payload (oldest dropped past the cap) and try to flush immediately. */
	async submit(payload: FeedbackPayload): Promise<void> {
		const entries = this.read();
		entries.push({ payload, queuedAt: new Date().toISOString() });
		while (entries.length > this.maxQueue()) {
			entries.shift();
		}
		await this.write(entries);
		await this.flush();
	}

	/**
	 * Drain the queue in order. Stop at the first failed send so the failed
	 * item and everything after it stay queued for the next startup/submit.
	 */
	async flush(): Promise<void> {
		const entries = this.read();
		while (entries.length > 0) {
			try {
				await this.transport.send(entries[0].payload);
			} catch {
				return;
			}
			entries.shift();
			await this.write(entries);
		}
	}

	/** Payloads currently queued, in send order (exposed for tests/diagnostics). */
	list(): FeedbackPayload[] {
		return this.read().map(entry => entry.payload);
	}
}
