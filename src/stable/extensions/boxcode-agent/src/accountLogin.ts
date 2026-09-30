/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * boxcode.sh device login for the IDE — same flow as `boxcode login` in the
 * CLI: POST /api/auth/device/start → open browser → poll until approved →
 * write ~/.boxcode/{config.toml,account.token,account.email}.
 *
 * Deep-link return (`boxcode://`) is not required: the IDE stays open and
 * finishes as soon as the browser approval lands, which is the Cursor /
 * Antigravity “Settings → Profile → browser → back in the app” experience.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const DEFAULT_AUTH_BASE = 'https://boxcode.sh';
export const AUTH_PROVIDER_ID = 'boxcode';
export const AUTH_PROVIDER_LABEL = 'boxcode.sh';

export interface DeviceStartResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	interval?: number;
	expires_at?: string;
}

export interface DevicePollResponse {
	status?: string;
	endpoint?: string;
	model?: string;
	api_key?: string;
	session_token?: string;
	email?: string;
	error?: string;
}

export interface AccountCredentials {
	endpoint: string;
	model: string;
	apiKey: string;
	provider: string;
	sessionToken: string;
	email: string;
}

export interface AccountStatus {
	signedIn: boolean;
	email: string | undefined;
	endpoint: string;
	model: string;
	viaBoxcodeProxy: boolean;
}

export class DeviceLoginError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DeviceLoginError';
	}
}

export function authBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.BOXCODE_AUTH_URL || env.BOXCODE_SITE_URL || DEFAULT_AUTH_BASE;
	return raw.trim().replace(/\/+$/, '');
}

export function boxcodeDir(home: string = os.homedir()): string {
	return path.join(home, '.boxcode');
}

export function accountTokenPath(home?: string): string {
	return path.join(boxcodeDir(home), 'account.token');
}

export function accountEmailPath(home?: string): string {
	return path.join(boxcodeDir(home), 'account.email');
}

export function configTomlPath(home?: string): string {
	return path.join(boxcodeDir(home), 'config.toml');
}

export function readAccountStatus(home: string = os.homedir()): AccountStatus {
	const email = readTrimmedFile(accountEmailPath(home));
	const token = readTrimmedFile(accountTokenPath(home));
	const llm = readLlmFields(readFileOrEmpty(configTomlPath(home)));
	const endpoint = llm.endpoint ?? '';
	const viaBoxcodeProxy = endpoint.toLowerCase().includes('llm.boxcode.sh');
	return {
		signedIn: Boolean(token),
		email: email || undefined,
		endpoint,
		model: llm.model ?? '',
		viaBoxcodeProxy,
	};
}

export function verificationUrl(start: DeviceStartResponse): string {
	if (start.verification_uri_complete) {
		return start.verification_uri_complete;
	}
	const sep = start.verification_uri.includes('?') ? '&' : '?';
	return `${start.verification_uri}${sep}code=${encodeURIComponent(start.user_code)}`;
}

export async function startDeviceLogin(
	baseUrl: string = authBaseUrl(),
	fetchImpl: typeof fetch = fetch,
): Promise<DeviceStartResponse> {
	const res = await fetchImpl(`${baseUrl}/api/auth/device/start`, { method: 'POST' });
	if (!res.ok) {
		throw new DeviceLoginError(`device start failed (${res.status})`);
	}
	const body = (await res.json()) as DeviceStartResponse;
	if (!body.device_code || !body.user_code || !body.verification_uri) {
		throw new DeviceLoginError('device start returned an incomplete response');
	}
	return body;
}

export type PollOutcome =
	| { kind: 'pending' }
	| { kind: 'expired' }
	| { kind: 'error'; message: string }
	| { kind: 'approved'; credentials: AccountCredentials };

export async function pollDeviceLogin(
	deviceCode: string,
	baseUrl: string = authBaseUrl(),
	fetchImpl: typeof fetch = fetch,
): Promise<PollOutcome> {
	const res = await fetchImpl(`${baseUrl}/api/auth/device/poll`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ device_code: deviceCode }),
	});
	if (res.status === 410) {
		return { kind: 'expired' };
	}
	const body = (await res.json().catch(() => ({}))) as DevicePollResponse;
	if (body.api_key) {
		return {
			kind: 'approved',
			credentials: {
				endpoint: (body.endpoint ?? '').replace(/\/+$/, ''),
				model: body.model ?? '',
				apiKey: body.api_key,
				provider: 'deepseek',
				sessionToken: (body.session_token ?? '').trim(),
				email: (body.email ?? '').trim(),
			},
		};
	}
	if (body.status === 'expired') {
		return { kind: 'expired' };
	}
	if (body.error) {
		return { kind: 'error', message: body.error };
	}
	return { kind: 'pending' };
}

export function saveAccountCredentials(creds: AccountCredentials, home: string = os.homedir()): void {
	const dir = boxcodeDir(home);
	fs.mkdirSync(dir, { recursive: true });

	const configPath = configTomlPath(home);
	const existing = readFileOrEmpty(configPath);
	const next = upsertLlmFields(existing, {
		endpoint: creds.endpoint,
		model: creds.model,
		api_key: creds.apiKey,
		provider: creds.provider,
	});
	writePrivate(configPath, next);

	if (creds.sessionToken) {
		writePrivate(accountTokenPath(home), creds.sessionToken);
	}
	if (creds.email) {
		writePrivate(accountEmailPath(home), creds.email);
	}
}

export function logoutLocal(home: string = os.homedir()): { clearedProxyKey: boolean } {
	unlinkQuiet(accountTokenPath(home));
	unlinkQuiet(accountEmailPath(home));

	const configPath = configTomlPath(home);
	const existing = readFileOrEmpty(configPath);
	if (!existing) {
		return { clearedProxyKey: false };
	}
	const llm = readLlmFields(existing);
	const endpoint = (llm.endpoint ?? '').toLowerCase();
	if (!endpoint.includes('llm.boxcode.sh')) {
		return { clearedProxyKey: false };
	}
	const next = upsertLlmFields(existing, { api_key: '' });
	writePrivate(configPath, next);
	return { clearedProxyKey: true };
}

export async function heartbeatOnce(
	baseUrl: string = authBaseUrl(),
	home: string = os.homedir(),
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	const token = readTrimmedFile(accountTokenPath(home));
	if (!token) {
		return;
	}
	try {
		await fetchImpl(`${baseUrl}/api/heartbeat`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ client: 'ide' }),
		});
	} catch {
		// Best-effort DAU ping — never block chat on this.
	}
}

const LLM_MANAGED_KEYS = ['endpoint', 'model', 'api_key', 'provider'] as const;
type LlmManagedKey = (typeof LLM_MANAGED_KEYS)[number];

/** Find the `[llm]` section body as line indices (exclusive end). */
function findLlmSection(lines: string[]): { start: number; end: number } | undefined {
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (/^\[llm\]\s*$/.test(lines[i]) || lines[i] === '[llm]') {
			start = i;
			continue;
		}
		if (start >= 0 && /^\[/.test(lines[i])) {
			return { start, end: i };
		}
	}
	return start >= 0 ? { start, end: lines.length } : undefined;
}

/**
 * Patch only managed `[llm]` keys inside a TOML document, leaving every other
 * section and any unknown `[llm]` keys (e.g. `max_tokens`) alone. Avoids
 * pulling a TOML parser into the extension.
 */
export function upsertLlmFields(
	toml: string,
	updates: Partial<Record<LlmManagedKey, string>>,
): string {
	const normalized = toml.replace(/\r\n/g, '\n');
	const lines = normalized.length ? normalized.replace(/\n$/, '').split('\n') : [];
	const section = findLlmSection(lines);
	const managed = stripUndefined(updates);

	if (!section) {
		const block = `[llm]\n${renderManagedLlmLines(managed)}`.replace(/\n$/, '');
		if (!normalized.trim()) {
			return `${block}\n`;
		}
		const base = normalized.replace(/\n*$/, '');
		return `${base}\n\n${block}\n`;
	}

	const bodyLines = lines.slice(section.start + 1, section.end);
	const rebuiltBody = patchLlmBody(bodyLines.join('\n'), managed).replace(/\n$/, '');
	const before = lines.slice(0, section.start);
	const after = lines.slice(section.end);
	const llmBlock = rebuiltBody ? [`[llm]`, ...rebuiltBody.split('\n')] : ['[llm]'];
	const merged = [...before, ...llmBlock, ...after];
	return `${merged.join('\n')}\n`;
}

export function readLlmFields(toml: string): Partial<Record<LlmManagedKey, string>> {
	const normalized = toml.replace(/\r\n/g, '\n');
	const lines = normalized.length ? normalized.replace(/\n$/, '').split('\n') : [];
	const section = findLlmSection(lines);
	if (!section) {
		return {};
	}
	const out: Partial<Record<LlmManagedKey, string>> = {};
	for (const line of lines.slice(section.start + 1, section.end)) {
		const m = line.match(/^\s*(endpoint|model|api_key|provider)\s*=\s*(.*?)\s*$/);
		if (!m) {
			continue;
		}
		out[m[1] as LlmManagedKey] = unquoteToml(m[2]);
	}
	return out;
}

function patchLlmBody(body: string, updates: Record<string, string>): string {
	const lines = body.replace(/\n$/, '').split('\n');
	const seen = new Set<string>();
	const out: string[] = [];
	for (const line of lines) {
		const m = line.match(/^\s*(endpoint|model|api_key|provider)\s*=/);
		if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
			out.push(`${m[1]} = ${quoteToml(updates[m[1]])}`);
			seen.add(m[1]);
			continue;
		}
		if (line.trim() === '' && out.length === 0) {
			continue;
		}
		out.push(line);
	}
	for (const key of LLM_MANAGED_KEYS) {
		if (Object.prototype.hasOwnProperty.call(updates, key) && !seen.has(key)) {
			out.push(`${key} = ${quoteToml(updates[key])}`);
		}
	}
	while (out.length && out[out.length - 1].trim() === '') {
		out.pop();
	}
	return out.length ? `${out.join('\n')}\n` : '';
}

function renderManagedLlmLines(fields: Record<string, string>): string {
	const lines: string[] = [];
	for (const key of LLM_MANAGED_KEYS) {
		if (fields[key] === undefined) {
			continue;
		}
		lines.push(`${key} = ${quoteToml(fields[key])}`);
	}
	return lines.length ? `${lines.join('\n')}\n` : '';
}

function stripUndefined(updates: Partial<Record<LlmManagedKey, string>>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(updates)) {
		if (v !== undefined) {
			out[k] = v;
		}
	}
	return out;
}

function quoteToml(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function unquoteToml(raw: string): string {
	const trimmed = raw.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
	}
	return trimmed;
}

function readFileOrEmpty(filePath: string): string {
	try {
		return fs.readFileSync(filePath, 'utf8');
	} catch {
		return '';
	}
}

function readTrimmedFile(filePath: string): string {
	return readFileOrEmpty(filePath).trim();
}

function writePrivate(filePath: string, contents: string): void {
	fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
	try {
		fs.chmodSync(filePath, 0o600);
	} catch {
		// Windows / unusual FS — ignore.
	}
}

function unlinkQuiet(filePath: string): void {
	try {
		fs.unlinkSync(filePath);
	} catch {
		// already gone
	}
}
