/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { permissionOutcomeFromChoice } from './permissionOutcome';

const allow = { optionId: 'allow-1', name: 'Allow', kind: 'allow_once' as const };
const reject = { optionId: 'reject-1', name: 'Reject', kind: 'reject_once' as const };

test('permissionOutcomeFromChoice() selects the allow option', () => {
	assert.deepEqual(permissionOutcomeFromChoice('Allow', allow, reject), {
		outcome: 'selected',
		optionId: 'allow-1',
	});
});

test('permissionOutcomeFromChoice() selects the reject option instead of cancelled', () => {
	assert.deepEqual(permissionOutcomeFromChoice('Reject', allow, reject), {
		outcome: 'selected',
		optionId: 'reject-1',
	});
});

test('permissionOutcomeFromChoice() returns cancelled when the modal is dismissed', () => {
	assert.deepEqual(permissionOutcomeFromChoice(undefined, allow, reject), { outcome: 'cancelled' });
});
