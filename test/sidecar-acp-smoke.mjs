import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const binary = process.argv[2];
if (!binary) {
	console.error('usage: sidecar-acp-smoke.mjs <agent-binary>');
	process.exit(2);
}

const home = mkdtempSync(path.join(tmpdir(), 'covex-acp-smoke-'));
let child;
let buffer = '';
let finished = false;

function finish(code, message) {
	if (finished) {
		return;
	}
	finished = true;
	clearTimeout(timer);
	if (message) {
		(code === 0 ? console.log : console.error)(message);
	}
	try {
		child?.kill();
	} catch {
		// already gone
	}
	try {
		rmSync(home, { recursive: true, force: true });
	} catch {
		// best effort
	}
	process.exit(code);
}

const timer = setTimeout(() => finish(1, 'timed out waiting for the bundled agent ACP handshake'), 15_000);

try {
	child = spawn(binary, ['--acp'], {
		env: {
			...process.env,
			HOME: home,
			USERPROFILE: home,
		},
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
	});
} catch (error) {
	finish(1, `could not spawn ${binary}: ${error}`);
}

child.on('error', error => finish(1, `spawn error: ${error}`));
child.on('exit', code => finish(1, `agent exited before the handshake (code ${code})`));
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
		if (!line) {
			continue;
		}
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		if (message.id !== 1) {
			continue;
		}
		if (message.error) {
			finish(1, `agent rejected initialize: ${JSON.stringify(message.error)}`);
			return;
		}
		const result = message.result ?? {};
		if (result.protocolVersion !== 1) {
			finish(1, `agent returned ACP protocol ${result.protocolVersion}, expected 1`);
			return;
		}
		finish(0, `ACP handshake OK (protocol 1${result.agentInfo?.version ? `, agent ${result.agentInfo.version}` : ''})`);
		return;
	}
});

child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + '\n');
