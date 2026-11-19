import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * ACP-path benchmark for the bundled agent: the same measurements as
 * `cx-bench`'s stream scenario, but through the real stdio transport and a
 * real child process, which is the path the IDE extension uses.
 *
 *   node test/sidecar-acp-bench.mjs <agent-binary> [--json] [--check]
 *
 * The mock LLM holds every response for one millisecond per chunk, so the
 * turn figure includes 20 ms of simulated provider time. TTFT is measured
 * from the prompt request to the first agent_message_chunk; handshake and
 * session/new are reported separately because they are one-time costs.
 *
 * `--check` is deliberately generous (TTFT < 3 s, turn < 10 s) and exists to
 * catch a stalled transport or a broken sidecar, not to grade a machine.
 */

const binary = process.argv[2];
if (!binary) {
	console.error('usage: sidecar-acp-bench.mjs <agent-binary> [--json] [--check]');
	process.exit(2);
}
const json = process.argv.includes('--json');
const check = process.argv.includes('--check');

const TOKENS = 20;
const CHUNK_DELAY_MS = 1;
const TTFT_BUDGET_MS = 3000;
const TURN_BUDGET_MS = 10000;

const root = mkdtempSync(path.join(tmpdir(), 'covex-acp-bench-'));
const configDir = path.join(root, 'config');
const workspace = path.join(root, 'workspace');
mkdirSync(configDir, { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(path.join(workspace, 'hello.txt'), 'hello\n');

let child;
let server;
let buffer = '';
let nextId = 1;
const pending = new Map();
let firstChunkAt;
let promptStartedAt;
let finished = false;

function cleanup() {
	try { child?.kill(); } catch { /* already gone */ }
	try { server?.close(); } catch { /* already closed */ }
	try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}

function finish(code, message, result) {
	if (finished) {
		return;
	}
	finished = true;
	cleanup();
	if (json && result) {
		console.log(JSON.stringify(result, null, 2));
	} else if (message) {
		(code === 0 ? console.log : console.error)(message);
	}
	process.exit(code);
}

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
	if (!line.trim()) {
		return;
	}
	let value;
	try {
		value = JSON.parse(line);
	} catch {
		return;
	}
	if (value.id && pending.has(value.id)) {
		const { resolve, reject } = pending.get(value.id);
		pending.delete(value.id);
		if (value.error) {
			reject(new Error(value.error.message ?? JSON.stringify(value.error)));
		} else {
			resolve(value.result);
		}
		return;
	}
	if (value.method === 'session/update' && value.params?.update) {
		const update = value.params.update;
		if (update.sessionUpdate === 'agent_message_chunk' && !firstChunkAt && promptStartedAt) {
			firstChunkAt = performance.now();
		}
	}
}

async function main() {
	server = createServer((req, res) => {
		req.resume();
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			Connection: 'close',
		});
		let sent = 0;
		const tick = () => {
			if (sent >= TOKENS) {
				res.write('data: [DONE]\n\n');
				res.end();
				return;
			}
			res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `tok${sent} ` } }] })}\n\n`);
			sent += 1;
			setTimeout(tick, CHUNK_DELAY_MS);
		};
		tick();
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const endpoint = `http://127.0.0.1:${server.address().port}`;
	writeFileSync(
		path.join(configDir, 'config.toml'),
		[
			'[llm]',
			`endpoint = "${endpoint}"`,
			'model = "cx-bench"',
			'api_key = "sk-bench"',
			'',
			'[tools]',
			'enabled = true',
			'approval = "destructive"',
			'',
		].join('\n'),
	);

	const spawnAt = performance.now();
	child = spawn(binary, ['--acp'], {
		cwd: workspace,
		env: {
			...process.env,
			HOME: root,
			USERPROFILE: root,
			COVEXCODE_CONFIG_DIR: configDir,
		},
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
	});
	child.on('error', error => finish(1, `spawn error: ${error}`));
	child.on('exit', code => {
		if (!finished) {
			finish(1, `agent exited early (code ${code})`);
		}
	});
	child.stderr.on('data', chunk => {
		const text = chunk.toString().trim();
		if (text) {
			console.error(`[agent stderr] ${text}`);
		}
	});
	child.stdout.on('data', chunk => {
		buffer += chunk.toString();
		let newline;
		while ((newline = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			handleLine(line);
		}
	});

	const init = await request('initialize', { protocolVersion: 1 });
	const handshakeMs = performance.now() - spawnAt;
	if (init?.protocolVersion !== 1) {
		finish(1, `unexpected ACP protocol ${init?.protocolVersion}`);
	}
	const capabilities = init?.agentCapabilities?.covexcode ?? {};
	const newSessionAt = performance.now();
	const session = await request('session/new', { cwd: workspace, mcpServers: [] });
	const newSessionMs = performance.now() - newSessionAt;
	const sessionId = session?.sessionId;
	if (!sessionId) {
		finish(1, 'session/new returned no sessionId');
	}

	promptStartedAt = performance.now();
	firstChunkAt = undefined;
	const turn = await request('session/prompt', {
		sessionId,
		prompt: [{ type: 'text', text: 'stream a short answer' }],
	});
	const turnMs = performance.now() - promptStartedAt;
	const ttftMs = firstChunkAt ? firstChunkAt - promptStartedAt : turnMs;

	const result = {
		agent: init?.agentInfo?.version ?? 'unknown',
		protocolVersion: init?.protocolVersion,
		capabilities,
		handshake_ms: handshakeMs,
		session_new_ms: newSessionMs,
		ttft_ms: ttftMs,
		turn_ms: turnMs,
		stopReason: turn?.stopReason,
	};
	const checks = {
		handshake: handshakeMs < TURN_BUDGET_MS,
		ttft: ttftMs < TTFT_BUDGET_MS,
		turn: turnMs < TURN_BUDGET_MS,
	};
	const ok = Object.values(checks).every(Boolean);
	const human = [
		`sidecar ACP bench (agent ${result.agent})`,
		`handshake ${handshakeMs.toFixed(1)}ms  session/new ${newSessionMs.toFixed(1)}ms`,
		`ttft ${ttftMs.toFixed(1)}ms  turn ${turnMs.toFixed(1)}ms  stop ${result.stopReason}`,
		check ? `checks ${ok ? 'pass' : 'FAIL'}` : '',
	].filter(Boolean).join('\n');

	if (check && !ok) {
		finish(1, human, { ...result, checks, ok });
	}
	finish(0, human, { ...result, checks, ok });
}

setTimeout(() => finish(1, 'timed out waiting for the ACP benchmark turn'), 30_000);
main().catch(error => finish(1, `benchmark failed: ${error}`));
