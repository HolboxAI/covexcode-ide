/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeStartupFailure } from './startupFailure';

function enoent(): NodeJS.ErrnoException {
	const error = new Error('spawn boxcode ENOENT') as NodeJS.ErrnoException;
	error.code = 'ENOENT';
	return error;
}

test('describeStartupFailure() gives the real install command when the boxcode binary is missing (macOS/Linux)', () => {
	const message = describeStartupFailure(enoent(), 'darwin');
	assert.match(message, /curl -fsSL https:\/\/boxcode\.sh\/install\.sh \| bash/);
	assert.doesNotMatch(message, /Make sure `boxcode` is installed/);
});

test('describeStartupFailure() picks the PowerShell install command on win32', () => {
	const message = describeStartupFailure(enoent(), 'win32');
	assert.match(message, /irm https:\/\/boxcode\.sh\/install\.ps1 \| iex/);
});

test('describeStartupFailure() falls back to generic prose for a non-ENOENT failure', () => {
	// The real case this covers: boxcode is installed and found, but crashes
	// on startup for some other reason (bad config, permissions, etc.) --
	// telling that user to go run the install script would be actively
	// wrong, not just unhelpful.
	const message = describeStartupFailure(new Error('boxcode --acp exited (code 1, signal null)'), 'darwin');
	assert.match(message, /Make sure `boxcode` is installed and on your PATH/);
	assert.doesNotMatch(message, /curl -fsSL/);
});

test('describeStartupFailure() handles a non-Error thrown value the same way as a non-ENOENT failure', () => {
	const message = describeStartupFailure('a plain string was thrown', 'darwin');
	assert.match(message, /Make sure `boxcode` is installed and on your PATH/);
});
