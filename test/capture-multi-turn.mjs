/**
 * Runs several consecutive prompts against ONE ACP session and records the
 * journal (`session/list_changes`) after each turn.
 *
 * This is the multi-turn counterpart of capture-diff-wire.mjs, written to
 * answer one question: when the same file is edited in turn 1 and again in
 * turn 2, what `turn` does the journal report for it? The chat-panel summary
 * filters journal entries by the turn that just finished, so if the journal
 * keeps reporting the FIRST turn a file was touched, every later edit to that
 * file is dropped from the summary.
 *
 * Usage:
 *   capture-multi-turn.mjs <agent-binary> <cwd> <out.jsonl> <prompt1> [prompt2] ...
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

const [binary, cwd, outPath, ...prompts] = process.argv.slice(2);
if (!binary || !cwd || !outPath || prompts.length === 0) {
	console.error('usage: capture-multi-turn.mjs <agent-binary> <cwd> <out.jsonl> <prompt> [prompt...]');
	process.exit(2);
}

const out = createWriteStream(outPath, { flags: 'w' });
const child = spawn(binary, ['--acp'], { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let buffer = '';
let nextId = 1;
let updates = 0;
let diffUpdates = 0;
let finished = false;
const pending = new Map();

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
		child.kill();
	} catch {
		// already gone
	}
	setTimeout(() => process.exit(code), 50);
}

const timer = setTimeout(() => finish(1, `timed out (${updates} updates)`), 600_000);

child.on('error', error => finish(1, `spawn error: ${error}`));
child.on('stderr', () => {});
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

	if (message.method === 'session/update' || message.params?.update) {
		updates++;
		const update = message.params?.update ?? {};
		if (update.content?.type === 'diff') {
			diffUpdates++;
		}
		out.write(JSON.stringify({ kind: 'update', sessionUpdate: update.sessionUpdate, status: update.status, contentType: update.content?.type, title: update.title, update }) + '\n');
		return;
	}

	if (message.method) {
		const id = message.id;
		if (message.method === 'session/request_permission') {
			const options = message.params?.options ?? [];
			const allow = options.find(o => o.kind === 'allow_once') ?? options[0];
			out.write(JSON.stringify({ kind: 'permission_request', params: message.params, answeredWith: allow?.optionId }) + '\n');
			send({ jsonrpc: '2.0', id, result: { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } } });
			return;
		}
		send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported: ${message.method}` } });
		return;
	}

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
	await request('initialize', { protocolVersion: 1 });
	const { sessionId } = await request('session/new', { cwd, mcpServers: [] });

	for (const [index, prompt] of prompts.entries()) {
		updates = 0;
		diffUpdates = 0;
		const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }], mode: 'normal' });
		const journal = await request('session/list_changes', { sessionId });
		out.write(JSON.stringify({ kind: 'turn', index, prompt, result, updates, diffUpdates, journal }) + '\n');
		console.log(`turn ${result.turn}: ${updates} updates, ${diffUpdates} diff blocks, journal=${JSON.stringify(journal.changes)}`);
	}
	finish(0, 'all turns finished');
} catch (error) {
	finish(1, `failed: ${error.message}`);
}
