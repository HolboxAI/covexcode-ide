/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	pollDeviceLogin,
	readLlmFields,
	upsertLlmFields,
	verificationUrl,
	type DeviceStartResponse,
} from './accountLogin';

test('verificationUrl prefers verification_uri_complete', () => {
	const start: DeviceStartResponse = {
		device_code: 'abc',
		user_code: 'ABCD-EFGH',
		verification_uri: 'https://covexcode.com/login/device',
		verification_uri_complete: 'https://covexcode.com/login/device?code=ABCD-EFGH',
	};
	assert.equal(verificationUrl(start), 'https://covexcode.com/login/device?code=ABCD-EFGH');
});

test('verificationUrl falls back to appending code', () => {
	const start: DeviceStartResponse = {
		device_code: 'abc',
		user_code: 'ABCD-EFGH',
		verification_uri: 'https://covexcode.com/login/device',
	};
	assert.equal(verificationUrl(start), 'https://covexcode.com/login/device?code=ABCD-EFGH');
});

test('upsertLlmFields creates [llm] when missing', () => {
	const out = upsertLlmFields('', {
		endpoint: 'https://llm.covexcode.com/v1',
		model: 'm',
		api_key: 'k',
		provider: 'deepseek',
	});
	assert.match(out, /^\[llm\]\n/);
	assert.deepEqual(readLlmFields(out), {
		endpoint: 'https://llm.covexcode.com/v1',
		model: 'm',
		api_key: 'k',
		provider: 'deepseek',
	});
});

test('upsertLlmFields preserves other sections and non-llm keys', () => {
	const input = `[llm]
endpoint = "https://old.example/v1"
model = "old"
api_key = "oldkey"
max_tokens = 8192
provider = ""

[tools]
enabled = true
workspace = "."
`;
	const out = upsertLlmFields(input, {
		endpoint: 'https://llm.covexcode.com/v1',
		model: 'new-model',
		api_key: 'new-key',
		provider: 'deepseek',
	});
	const llm = readLlmFields(out);
	assert.equal(llm.endpoint, 'https://llm.covexcode.com/v1');
	assert.equal(llm.model, 'new-model');
	assert.equal(llm.api_key, 'new-key');
	assert.equal(llm.provider, 'deepseek');
	assert.match(out, /\[tools\]/);
	assert.match(out, /enabled = true/);
	assert.match(out, /max_tokens = 8192/);
});

test('upsertLlmFields can clear api_key on logout', () => {
	const input = `[llm]
endpoint = "https://llm.covexcode.com/v1"
api_key = "secret"
provider = "deepseek"
`;
	const out = upsertLlmFields(input, { api_key: '' });
	assert.equal(readLlmFields(out).api_key, '');
	assert.equal(readLlmFields(out).endpoint, 'https://llm.covexcode.com/v1');
});

test('pollDeviceLogin does not stamp provider=deepseek for proxy keys', async () => {
	const fetchImpl = (async () =>
		new Response(
			JSON.stringify({
				api_key: 'bx-live-abc',
				endpoint: 'https://llm.covexcode.com/v1',
				model: 'deepseek-v4-flash',
				session_token: 'sess',
				email: 'a@b.com',
			}),
			{ status: 200 },
		)) as typeof fetch;
	const outcome = await pollDeviceLogin('device', 'https://covexcode.com', fetchImpl);
	assert.equal(outcome.kind, 'approved');
	if (outcome.kind !== 'approved') {
		return;
	}
	assert.equal(outcome.credentials.provider, '');
	assert.equal(outcome.credentials.endpoint, 'https://llm.covexcode.com/v1');
	assert.equal(outcome.credentials.apiKey, 'bx-live-abc');
});