/**
 * Drives a real agent turn over ACP and records every notification it emits,
 * so the chat-panel diff pipeline can be checked against the actual wire data
 * instead of against assumptions about what covexcode sends.
 *
 * Usage:
 *   capture-diff-wire.mjs <agent-binary> <cwd> <prompt> <out.jsonl>
 *
 * Every `session/update` notification is appended to <out.jsonl> verbatim, one
 * JSON object per line. Permission prompts are auto-approved with the first
 * `allow_once` option so the turn can run unattended -- this is a capture tool,
 * not an approval harness.
 */

import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [binary, cwd, prompt, outPath] = process.argv.slice(2);
if (!binary || !cwd || !prompt || !outPath) {
	console.error('usage: capture-diff-wire.mjs <agent-binary> <cwd> <prompt> <out.jsonl>');
	process.exit(2);
}

const out = createWriteStream(outPath, { flags: 'w' });
let child;
let buffer = '';
let nextId = 1;
const pending = new Map();
let finished = false;
let updates = 0;
let diffUpdates = 0;

function finish(code, message) {
	if (finished) {
		return;
	}
	finished = true;
	clearTimeout(timer);
	if (message) {
		(code === 0 ? console.log : console.error)(message);
	}
	out.end();
	try {
		child?.kill();
	} catch {
		// already gone
	}
	process.exitCode = code;
	setTimeout(() => process.exit(code), 50);
}

// Generous: a real model turn with an edit can take a while.
const timer = setTimeout(() => finish(1, `timed out after 240s (${updates} updates, ${diffUpdates} with diff content)`), 240_000);

child = spawn(binary, ['--acp'], {
	env: { ...process.env },
	stdio: ['pipe', 'pipe', 'pipe'],
	windowsHide: true,
});

child.on('error', error => finish(1, `spawn error: ${error}`));
child.on('exit', code => finish(code === 0 ? 0 : 1, `agent exited (code ${code})`));
child.stderr.on('data', chunk => {
	const text = chunk.toString().trim();
	if (text) {
		console.error(`[agent stderr] ${text}`);
	}
});

function send(message) {
	child.stdin.write(JSON.stringify(message) + '\n');
}

function request(method, params) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		send({ jsonrpc: '2.0', id, method, params });
	});
}

function handleLine(line) {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}

	// Agent -> client notification. Checked BEFORE the request branch: an ACP
	// notification and an ACP request both carry `method`, so testing for a
	// method at all would swallow every `session/update` as an unsupported
	// request -- which is exactly what made the first capture look empty
	// while the file really had changed on disk.
	if (message.method === 'session/update' || message.params?.update) {
		updates++;
		const update = message.params?.update ?? {};
		if (update.content?.type === 'diff') {
			diffUpdates++;
		}
		// Snapshot-timing probe: when a mutating tool call BEGINS, record what the
		// file looks like right now. If this still holds the pre-edit content, a
		// client can capture a trustworthy "before" image at `in_progress`.
		if (process.env.PROBE_SNAPSHOT && update.sessionUpdate === 'tool_call' && update.status === 'in_progress' && typeof update.title === 'string') {
			const match = /^(edit|write|create|delete|apply_patch)\s+(.+)$/.exec(update.title.trim());
			if (match) {
				const target = path.resolve(cwd, match[2].trim());
				const snapshot = existsSync(target) ? readFileSync(target, 'utf8') : null;
				out.write(JSON.stringify({ kind: 'snapshot', at: update.status, tool: match[1], path: match[2].trim(), existed: snapshot !== null, before: snapshot }) + '\n');
			}
		}
		out.write(JSON.stringify({ kind: 'update', sessionUpdate: update.sessionUpdate, status: update.status, toolCallId: update.toolCallId, contentType: update.content?.type, hasHunks: Array.isArray(update.content?.hunks) && update.content.hunks.length > 0, update }) + '\n');
		return;
	}

	// Agent -> client request (permission prompts, browser checks).
	if (message.method) {
		const id = message.id;
		if (message.method === 'session/request_permission') {
			const options = message.params?.options ?? [];
			const allow = options.find(o => o.kind === 'allow_once') ?? options[0];
			out.write(JSON.stringify({ kind: 'permission_request', params: message.params, answeredWith: allow?.optionId }) + '\n');
			send({ jsonrpc: '2.0', id, result: { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } } });
			return;
		}
		// Any other client-side request: decline rather than hang the turn.
		send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported in capture harness: ${message.method}` } });
		return;
	}

	// Response to one of our own requests.
	if (message.id !== undefined && pending.has(message.id)) {
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) {
			reject(new Error(JSON.stringify(message.error)));
		} else {
			resolve(message.result);
		}
	}
}

child.stdout.on('data', chunk => {
	buffer += chunk.toString();
	let newline;
	while ((newline = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line) {
			handleLine(line);
		}
	}
});

try {
	const init = await request('initialize', { protocolVersion: 1 });
	out.write(JSON.stringify({ kind: 'initialize', result: init }) + '\n');
	const session = await request('session/new', { cwd, mcpServers: [] });
	const sessionId = session.sessionId;
	out.write(JSON.stringify({ kind: 'session_new', sessionId, result: session }) + '\n');
	const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }], mode: 'normal' });
	out.write(JSON.stringify({ kind: 'prompt_result', result }) + '\n');
	// The journal is what `appendJournalEntries` falls back on when the turn
	// emitted no diff content at all. Capture it to confirm it reports this
	// turn's files with a matching turn number.
	const journal = await request('session/list_changes', { sessionId });
	out.write(JSON.stringify({ kind: 'list_changes', result: journal }) + '\n');
	console.log('journal:', JSON.stringify(journal));
	writeFileSync(`${outPath}.summary.json`, JSON.stringify({ updates, diffUpdates, result }, null, 2));
	finish(0, `turn finished: ${updates} updates, ${diffUpdates} carrying diff content`);
} catch (error) {
	finish(1, `turn failed: ${error.message}`);
}
