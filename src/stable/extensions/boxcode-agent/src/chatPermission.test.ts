/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	parsePermissionCommandArgs,
	parseReviewCommandArgs,
	permissionCommandUri,
	permissionOutcomeFromGate,
	PermissionGate,
	PERMISSION_COMMAND,
	REVIEW_COMMAND,
	reviewCommandUri,
} from './chatPermission';

const allow = { optionId: 'allow-1', name: 'Allow', kind: 'allow_once' as const };
const reject = { optionId: 'reject-1', name: 'Reject', kind: 'reject_once' as const };

test('PermissionGate.respond() resolves the matching waiter with allow or reject', async () => {
	const gate = new PermissionGate();
	const { id, wait } = gate.create();
	assert.equal(gate.size, 1);
	assert.equal(gate.respond(id, 'allow'), true);
	assert.deepEqual(await wait, { choice: 'allow' });
	assert.equal(gate.size, 0);
});

test('PermissionGate.respond() carries the merged text for a partial answer', async () => {
	const gate = new PermissionGate();
	const { id, wait } = gate.create();
	assert.equal(gate.respond(id, 'partial', 'a\nb\n'), true);
	assert.deepEqual(await wait, { choice: 'partial', newText: 'a\nb\n' });
});

test('PermissionGate.respond() is a no-op for an unknown id or a bad choice', async () => {
	const gate = new PermissionGate();
	const { id, wait } = gate.create();
	assert.equal(gate.respond('nope', 'allow'), false);
	assert.equal(gate.respond(id, 'maybe'), false);
	assert.equal(gate.size, 1);
	assert.equal(gate.respond(id, 'reject'), true);
	assert.deepEqual(await wait, { choice: 'reject' });
});

test('PermissionGate.cancelAll() resolves every waiter as cancelled', async () => {
	const gate = new PermissionGate();
	const first = gate.create();
	const second = gate.create();
	gate.cancelAll();
	assert.deepEqual(await first.wait, { choice: 'cancelled' });
	assert.deepEqual(await second.wait, { choice: 'cancelled' });
	assert.equal(gate.size, 0);
});

test('parsePermissionCommandArgs() accepts only allow/reject with a string id', () => {
	assert.deepEqual(parsePermissionCommandArgs(['7', 'allow']), { id: '7', choice: 'allow' });
	assert.deepEqual(parsePermissionCommandArgs(['7', 'reject']), { id: '7', choice: 'reject' });
	assert.equal(parsePermissionCommandArgs(['7', 'cancelled']), undefined);
	assert.equal(parsePermissionCommandArgs([7, 'allow']), undefined);
	assert.equal(parsePermissionCommandArgs([]), undefined);
});

test('parseReviewCommandArgs() accepts a bare string id', () => {
	assert.equal(parseReviewCommandArgs(['7']), '7');
	assert.equal(parseReviewCommandArgs([7]), undefined);
	assert.equal(parseReviewCommandArgs([]), undefined);
});

test('permissionOutcomeFromGate() selects the ACP option instead of cancelled', () => {
	assert.deepEqual(permissionOutcomeFromGate({ choice: 'allow' }, allow, reject), {
		outcome: 'selected',
		optionId: 'allow-1',
	});
	assert.deepEqual(permissionOutcomeFromGate({ choice: 'reject' }, allow, reject), {
		outcome: 'selected',
		optionId: 'reject-1',
	});
	assert.deepEqual(permissionOutcomeFromGate({ choice: 'cancelled' }, allow, reject), { outcome: 'cancelled' });
});

test('permissionOutcomeFromGate() maps a partial answer onto the merged-text outcome', () => {
	assert.deepEqual(permissionOutcomeFromGate({ choice: 'partial', newText: 'a\nb\n' }, allow, reject), {
		outcome: 'partial',
		newText: 'a\nb\n',
	});
	// A partial answer with no text (shouldn't happen) degrades to cancelled.
	assert.deepEqual(permissionOutcomeFromGate({ choice: 'partial' }, allow, reject), { outcome: 'cancelled' });
});

test('permissionCommandUri() encodes the command arguments VS Code command links expect', () => {
	const uri = permissionCommandUri('2', 'allow');
	assert.equal(uri.startsWith(`command:${PERMISSION_COMMAND}?`), true);
	const args = JSON.parse(decodeURIComponent(uri.slice(`command:${PERMISSION_COMMAND}?`.length)));
	assert.deepEqual(args, ['2', 'allow']);
});

test('reviewCommandUri() encodes the review command and its gate id', () => {
	const uri = reviewCommandUri('9');
	assert.equal(uri.startsWith(`command:${REVIEW_COMMAND}?`), true);
	const args = JSON.parse(decodeURIComponent(uri.slice(`command:${REVIEW_COMMAND}?`.length)));
	assert.deepEqual(args, ['9']);
});
