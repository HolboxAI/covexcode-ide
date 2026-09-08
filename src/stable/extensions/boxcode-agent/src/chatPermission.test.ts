/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	parsePermissionCommandArgs,
	permissionChoiceFromConfirmation,
	permissionCommandUri,
	permissionConfirmationData,
	permissionOutcomeFromGate,
	PermissionGate,
	PERMISSION_COMMAND,
} from './chatPermission';

const allow = { optionId: 'allow-1', name: 'Allow', kind: 'allow_once' as const };
const reject = { optionId: 'reject-1', name: 'Reject', kind: 'reject_once' as const };

test('PermissionGate.respond() resolves the matching waiter with allow or reject', async () => {
	const gate = new PermissionGate();
	const { id, wait } = gate.create();
	assert.equal(gate.size, 1);
	assert.equal(gate.respond(id, 'allow'), true);
	assert.equal(await wait, 'allow');
	assert.equal(gate.size, 0);
});

test('PermissionGate.respond() is a no-op for an unknown id or a bad choice', async () => {
	const gate = new PermissionGate();
	const { id, wait } = gate.create();
	assert.equal(gate.respond('nope', 'allow'), false);
	assert.equal(gate.respond(id, 'maybe'), false);
	assert.equal(gate.size, 1);
	assert.equal(gate.respond(id, 'reject'), true);
	assert.equal(await wait, 'reject');
});

test('PermissionGate.cancelAll() resolves every waiter as cancelled', async () => {
	const gate = new PermissionGate();
	const first = gate.create();
	const second = gate.create();
	gate.cancelAll();
	assert.equal(await first.wait, 'cancelled');
	assert.equal(await second.wait, 'cancelled');
	assert.equal(gate.size, 0);
});

test('parsePermissionCommandArgs() accepts only allow/reject with a string id', () => {
	assert.deepEqual(parsePermissionCommandArgs(['7', 'allow']), { id: '7', choice: 'allow' });
	assert.deepEqual(parsePermissionCommandArgs(['7', 'reject']), { id: '7', choice: 'reject' });
	assert.equal(parsePermissionCommandArgs(['7', 'cancelled']), undefined);
	assert.equal(parsePermissionCommandArgs([7, 'allow']), undefined);
	assert.equal(parsePermissionCommandArgs([]), undefined);
});

test('permissionChoiceFromConfirmation() maps accepted/rejected payloads onto the gate', () => {
	const data = permissionConfirmationData('3');
	assert.deepEqual(permissionChoiceFromConfirmation([data], undefined), { id: '3', choice: 'allow' });
	assert.deepEqual(permissionChoiceFromConfirmation(undefined, [data]), { id: '3', choice: 'reject' });
	assert.equal(permissionChoiceFromConfirmation([{ kind: 'other' }], undefined), undefined);
	assert.equal(permissionChoiceFromConfirmation(undefined, undefined), undefined);
});

test('permissionOutcomeFromGate() selects the ACP option instead of cancelled', () => {
	assert.deepEqual(permissionOutcomeFromGate('allow', allow, reject), {
		outcome: 'selected',
		optionId: 'allow-1',
	});
	assert.deepEqual(permissionOutcomeFromGate('reject', allow, reject), {
		outcome: 'selected',
		optionId: 'reject-1',
	});
	assert.deepEqual(permissionOutcomeFromGate('cancelled', allow, reject), { outcome: 'cancelled' });
});

test('permissionCommandUri() encodes the command arguments VS Code command links expect', () => {
	const uri = permissionCommandUri('2', 'allow');
	assert.equal(uri.startsWith(`command:${PERMISSION_COMMAND}?`), true);
	const args = JSON.parse(decodeURIComponent(uri.slice(`command:${PERMISSION_COMMAND}?`.length)));
	assert.deepEqual(args, ['2', 'allow']);
});
