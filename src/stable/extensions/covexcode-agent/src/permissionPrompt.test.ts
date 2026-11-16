/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDestructiveAlwaysAllow, permissionPromptLinks } from './permissionPrompt';

test('renders five links for a non-destructive file write', () => {
	const links = permissionPromptLinks({
		id: '1',
		allowLabel: 'CUSTOM-ALLOW',
		rejectLabel: 'CUSTOM-REJECT',
		kind: 'file_write',
		action: 'C:\\Users\\u\\src\\App.tsx',
	});
	assert.deepEqual(
		links.map(l => l.choice),
		['allow', 'allow-turn', 'allow-session', 'allow-always', 'reject'],
	);
	assert.deepEqual(
		links.map(l => l.label),
		['Allow Once', 'Allow for This Turn', 'Allow for This Session', 'Always Allow', 'Reject'],
	);
});

test('reject link still resolves to choice "reject"', () => {
	const links = permissionPromptLinks({
		id: '1',
		allowLabel: 'CUSTOM-ALLOW',
		rejectLabel: 'CUSTOM-REJECT',
		kind: 'execute',
		action: 'npm test',
	});
	const reject = links.at(-1);
	assert.ok(reject);
	assert.equal(reject.choice, 'reject');
	assert.equal(reject.label, 'Reject');
});

test('Always Allow is hidden for file_delete', () => {
	const links = permissionPromptLinks({
		id: '1',
		allowLabel: 'Allow',
		rejectLabel: 'Reject',
		kind: 'file_delete',
		action: 'C:\\Users\\u\\src\\App.tsx',
	});
	assert.ok(!links.some(l => l.choice === 'allow-always'));
});

test('destructive command markers hide Always Allow', () => {
	for (const marker of ['rm -rf /', 'del file.txt', 'rmdir /s', 'format C:', 'drop table', 'truncate x', ':(){:|:&};:']) {
		assert.equal(
			isDestructiveAlwaysAllow('execute', marker),
			true,
			`expected ${JSON.stringify(marker)} to be destructive`,
		);
	}
});

test('non-destructive commands and file paths are not destructive', () => {
	assert.equal(isDestructiveAlwaysAllow('execute', 'npm test'), false);
	// A path containing "format" must not lose its Always Allow link.
	assert.equal(isDestructiveAlwaysAllow('file_write', 'C:\\Users\\u\\src\\format.ts'), false);
	assert.equal(isDestructiveAlwaysAllow('file_write', 'C:\\Users\\u\\src\\App.tsx'), false);
});
