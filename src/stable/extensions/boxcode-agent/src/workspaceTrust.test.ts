/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	describeRestrictedMode,
	folderTrustKey,
	shouldPromptForWorkspaceTrust,
	TRUST_TOAST_ACTION,
	TRUST_TOAST_MESSAGE,
} from './workspaceTrust';

test('shouldPromptForWorkspaceTrust() is true only for an untrusted folder workspace', () => {
	assert.equal(shouldPromptForWorkspaceTrust(false, 1), true);
	assert.equal(shouldPromptForWorkspaceTrust(false, 2), true);
	assert.equal(shouldPromptForWorkspaceTrust(true, 1), false);
	assert.equal(shouldPromptForWorkspaceTrust(false, 0), false);
	assert.equal(shouldPromptForWorkspaceTrust(true, 0), false);
});

test('folderTrustKey() is stable regardless of folder order', () => {
	assert.equal(folderTrustKey(['file:///b', 'file:///a']), folderTrustKey(['file:///a', 'file:///b']));
	assert.notEqual(folderTrustKey(['file:///a']), folderTrustKey(['file:///b']));
});

test('describeRestrictedMode() tells the user to trust the folder instead of implying chat is gone', () => {
	const message = describeRestrictedMode();
	assert.match(message, /Restricted Mode/);
	assert.match(message, /Trust the folder/);
	assert.doesNotMatch(message, /Drag a view here/);
});

test('trust toast copy names Restricted Mode and a Trust action', () => {
	assert.match(TRUST_TOAST_MESSAGE, /Trust this folder/);
	assert.match(TRUST_TOAST_MESSAGE, /Restricted Mode/);
	assert.equal(TRUST_TOAST_ACTION, 'Trust folder');
});
