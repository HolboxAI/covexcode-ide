/**
 * Tests for the permission-mode helpers (the IDE's Shift+Tab counterpart).
 *
 * Run with `npm test` from `src/stable/extensions/covexcode-agent`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	approvalEnvValue,
	cyclePermissionMode,
	permissionModeFromSetting,
	permissionModeMarkdown,
} from './permissionMode';

test('permissionModeFromSetting defaults to auto and only honours "manual"', () => {
	assert.equal(permissionModeFromSetting(undefined), 'auto');
	assert.equal(permissionModeFromSetting(''), 'auto');
	assert.equal(permissionModeFromSetting('garbage'), 'auto');
	assert.equal(permissionModeFromSetting('auto'), 'auto');
	assert.equal(permissionModeFromSetting('manual'), 'manual');
});

test('approvalEnvValue maps auto -> destructive and manual -> always', () => {
	assert.equal(approvalEnvValue('auto'), 'destructive');
	assert.equal(approvalEnvValue('manual'), 'always');
});

test('cyclePermissionMode flips auto <-> manual', () => {
	assert.equal(cyclePermissionMode('auto'), 'manual');
	assert.equal(cyclePermissionMode('manual'), 'auto');
});

test('permissionModeMarkdown announces the mode and the way back', () => {
	assert.match(permissionModeMarkdown('manual'), /MANUAL/);
	assert.match(permissionModeMarkdown('manual'), /\/mode/);
	assert.match(permissionModeMarkdown('auto'), /AUTO/);
});
