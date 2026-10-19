/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeStartupFailure, AcpUnsupportedError } from './startupFailure';

function enoent(): NodeJS.ErrnoException {
	const error = new Error('spawn covexcode ENOENT') as NodeJS.ErrnoException;
	error.code = 'ENOENT';
	return error;
}

test('describeStartupFailure() gives the real install command when the covexcode binary is missing (macOS/Linux)', () => {
	const message = describeStartupFailure(enoent(), 'darwin');
	assert.match(message, /curl -fsSL https:\/\/covexcode\.com\/install\.sh \| bash/);
	assert.doesNotMatch(message, /Make sure `covexcode` is installed/);
});

test('describeStartupFailure() picks the PowerShell install command on win32', () => {
	const message = describeStartupFailure(enoent(), 'win32');
	assert.match(message, /irm https:\/\/covexcode\.com\/install\.ps1 \| iex/);
});

test('describeStartupFailure() tells an installed-but-old CLI to upgrade, not to reinstall', () => {
	const message = describeStartupFailure(new AcpUnsupportedError(), 'darwin');
	assert.match(message, /covexcode --upgrade/);
	assert.match(message, /too old/);
	assert.doesNotMatch(message, /Make sure `covexcode` is installed/);
	assert.doesNotMatch(message, /curl -fsSL/);
});

test('describeStartupFailure() treats exit code 2 as an unknown --acp flag', () => {
	const message = describeStartupFailure(new Error('covexcode --acp exited (code 2, signal null)'), 'darwin');
	assert.match(message, /covexcode --upgrade/);
});

test('describeStartupFailure() does not mistake another command exiting 2 for an old covexcode CLI', () => {
	// Exit 2 is covexcode's "unknown argument" convention only for the
	// `covexcode --acp` spawn; a different subprocess that happened to exit 2
	// must fall through to the generic failure prose, not the upgrade prompt.
	const message = describeStartupFailure(new Error('git exited (code 2, signal null)'), 'darwin');
	assert.match(message, /Make sure `covexcode` is installed and on your PATH/);
	assert.doesNotMatch(message, /covexcode --upgrade/);
});

test('describeStartupFailure() falls back to generic prose for a non-ENOENT failure', () => {
	// The real case this covers: covexcode is installed and found, but crashes
	// on startup for some other reason (bad config, permissions, etc.) --
	// telling that user to go run the install script would be actively
	// wrong, not just unhelpful.
	const message = describeStartupFailure(new Error('covexcode --acp exited (code 1, signal null)'), 'darwin');
	assert.match(message, /Make sure `covexcode` is installed and on your PATH/);
	assert.doesNotMatch(message, /curl -fsSL/);
});

test('describeStartupFailure() handles a non-Error thrown value the same way as a non-ENOENT failure', () => {
	const message = describeStartupFailure('a plain string was thrown', 'darwin');
	assert.match(message, /Make sure `covexcode` is installed and on your PATH/);
});
