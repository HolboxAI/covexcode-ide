/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	buildCompletionMessages,
	buildCompletionRequest,
	chatCompletionsUrl,
	extractContext,
	parseBoxcodeConfigToml,
	parseCompletionResponse,
	requestCompletion,
	trimPrefixOverlap,
} from './inlineCompletion';

test('chatCompletionsUrl tolerates the endpoint shapes people paste', () => {
	assert.equal(chatCompletionsUrl('https://api.example.com'), 'https://api.example.com/v1/chat/completions');
	assert.equal(chatCompletionsUrl('https://api.example.com/'), 'https://api.example.com/v1/chat/completions');
	assert.equal(chatCompletionsUrl('https://api.example.com/v1'), 'https://api.example.com/v1/chat/completions');
	assert.equal(chatCompletionsUrl('https://api.example.com/openai'), 'https://api.example.com/openai/chat/completions');
	assert.equal(chatCompletionsUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/chat/completions');
});

test('extractContext slices around the offset and caps each half', () => {
	// cursor after "abcdefghij", before "KLMNOP"
	const { prefix, suffix } = extractContext('abcdefghijKLMNOP', 10, 4, 3);
	assert.equal(prefix, 'ghij');
	assert.equal(suffix, 'KLM');
});

test('buildCompletionMessages names the file and language and fences the context', () => {
	const { system, user } = buildCompletionMessages('/src/app.ts', 'typescript', 'const x = ', ';');
	assert.ok(system.length > 0);
	assert.ok(user.includes('File: /src/app.ts'));
	assert.ok(user.includes('Language: typescript'));
	assert.ok(user.includes('<before>\nconst x = \n</before>'));
	assert.ok(user.includes('<after>\n;\n</after>'));
});

test('buildCompletionRequest sends a chat-completions-shaped body with bearer auth', () => {
	const req = buildCompletionRequest('https://api.example.com', 'deepseek-chat', 'sk-key', '/src/a.ts', 'ts', 'pre', 'suf');
	assert.equal(req.url, 'https://api.example.com/v1/chat/completions');
	assert.equal(req.headers.Authorization, 'Bearer sk-key');
	assert.equal(req.headers['Content-Type'], 'application/json');
	assert.equal(req.body.model, 'deepseek-chat');
	assert.deepEqual(req.body.messages.map(m => m.role), ['system', 'user']);
	assert.ok(req.body.max_tokens > 0);
	assert.equal(req.body.reasoning_effort, 'none');
});

test('parseCompletionResponse strips fences and stray fence lines', () => {
	assert.equal(parseCompletionResponse('  just code  '), 'just code');
	assert.equal(parseCompletionResponse('```python\nx = 1\n```'), 'x = 1');
	assert.equal(parseCompletionResponse('```\nx = 1'), 'x = 1');
	assert.equal(parseCompletionResponse('x = 1\n```'), 'x = 1');
	assert.equal(parseCompletionResponse('   '), '');
});

test('trimPrefixOverlap removes only what was already typed', () => {
	// Model echoed the word that was already there: strip the repeated tail.
	assert.equal(trimPrefixOverlap('const pri', 'print(1)'), 'nt(1)');
	// No overlap: returned verbatim.
	assert.equal(trimPrefixOverlap('const pri', 'nter(2)'), 'nter(2)');
	// The whole completion repeats the tail: nothing new to insert.
	assert.equal(trimPrefixOverlap('const pri', 'pri'), '');
	// A short prefix echoed in full.
	assert.equal(trimPrefixOverlap('x = ', 'x = 5'), '5');
});

test('parseBoxcodeConfigToml reads only the [llm] endpoint/model/api_key', () => {
	const toml = [
		'[llm]',
		'endpoint = "https://llm.boxcode.sh/v1/chat/completions"',
		'model = "deepseek-v4-pro"',
		'api_key = "sk-test"',
		'max_tokens = 256',
		'',
		'[tools]',
		'enabled = true',
	].join('\n');
	const parsed = parseBoxcodeConfigToml(toml);
	assert.equal(parsed.endpoint, 'https://llm.boxcode.sh/v1/chat/completions');
	assert.equal(parsed.model, 'deepseek-v4-pro');
	assert.equal(parsed.apiKey, 'sk-test');
});

test('parseBoxcodeConfigToml ignores unrelated sections and returns empty on garbage', () => {
	assert.equal(parseBoxcodeConfigToml('[deploy]\nenabled = true').endpoint, undefined);
	assert.deepEqual(parseBoxcodeConfigToml('not toml at all'), {});
});

test('requestCompletion reads message.content and throws on failure', async () => {
	const okFetch = (async () => ({
		ok: true,
		status: 200,
		json: async () => ({ choices: [{ message: { content: 'hello' } }] }),
		text: async () => '',
	})) as unknown as typeof fetch;
	assert.equal(await requestCompletion({ url: 'u', headers: {}, body: { model: 'm', messages: [], max_tokens: 1 } }, new AbortController().signal, okFetch), 'hello');

	const textFetch = (async () => ({
		ok: true,
		status: 200,
		json: async () => ({ choices: [{ text: 'completions-shape' }] }),
		text: async () => '',
	})) as unknown as typeof fetch;
	assert.equal(await requestCompletion({ url: 'u', headers: {}, body: { model: 'm', messages: [], max_tokens: 1 } }, new AbortController().signal, textFetch), 'completions-shape');

	const badFetch = (async () => ({
		ok: false,
		status: 429,
		json: async () => ({}),
		text: async () => 'rate limited',
	})) as unknown as typeof fetch;
	await assert.rejects(
		requestCompletion({ url: 'u', headers: {}, body: { model: 'm', messages: [], max_tokens: 1 } }, new AbortController().signal, badFetch),
		/429/,
	);
});
