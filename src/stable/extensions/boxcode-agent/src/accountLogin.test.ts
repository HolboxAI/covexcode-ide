/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	readLlmFields,
	upsertLlmFields,
	verificationUrl,
	type DeviceStartResponse,
} from './accountLogin';

test('verificationUrl prefers verification_uri_complete', () => {
	const start: DeviceStartResponse = {
		device_code: 'abc',
		user_code: 'ABCD-EFGH',
		verification_uri: 'https://boxcode.sh/login/device',
		verification_uri_complete: 'https://boxcode.sh/login/device?code=ABCD-EFGH',
	};
	assert.equal(verificationUrl(start), 'https://boxcode.sh/login/device?code=ABCD-EFGH');
});

test('verificationUrl falls back to appending code', () => {
	const start: DeviceStartResponse = {
		device_code: 'abc',
		user_code: 'ABCD-EFGH',
		verification_uri: 'https://boxcode.sh/login/device',
	};
	assert.equal(verificationUrl(start), 'https://boxcode.sh/login/device?code=ABCD-EFGH');
});

test('upsertLlmFields creates [llm] when missing', () => {
	const out = upsertLlmFields('', {
		endpoint: 'https://llm.boxcode.sh/v1',
		model: 'm',
		api_key: 'k',
		provider: 'deepseek',
	});
	assert.match(out, /^\[llm\]\n/);
	assert.deepEqual(readLlmFields(out), {
		endpoint: 'https://llm.boxcode.sh/v1',
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
		endpoint: 'https://llm.boxcode.sh/v1',
		model: 'new-model',
		api_key: 'new-key',
		provider: 'deepseek',
	});
	const llm = readLlmFields(out);
	assert.equal(llm.endpoint, 'https://llm.boxcode.sh/v1');
	assert.equal(llm.model, 'new-model');
	assert.equal(llm.api_key, 'new-key');
	assert.equal(llm.provider, 'deepseek');
	assert.match(out, /\[tools\]/);
	assert.match(out, /enabled = true/);
	assert.match(out, /max_tokens = 8192/);
});

test('upsertLlmFields can clear api_key on logout', () => {
	const input = `[llm]
endpoint = "https://llm.boxcode.sh/v1"
api_key = "secret"
provider = "deepseek"
`;
	const out = upsertLlmFields(input, { api_key: '' });
	assert.equal(readLlmFields(out).api_key, '');
	assert.equal(readLlmFields(out).endpoint, 'https://llm.boxcode.sh/v1');
});
