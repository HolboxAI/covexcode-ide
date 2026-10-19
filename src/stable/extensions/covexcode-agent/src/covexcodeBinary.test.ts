/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { covexcodeBinaryCandidates } from './covexcodeBinary';

test('covexcodeBinaryCandidates() uses only the configured path when set', () => {
	assert.deepEqual(covexcodeBinaryCandidates('  /opt/covexcode  ', '/Users/dev', 'darwin'), ['/opt/covexcode']);
});

test('covexcodeBinaryCandidates() tries PATH then install.sh locations when unset', () => {
	const home = '/Users/dev';
	assert.deepEqual(covexcodeBinaryCandidates('', home, 'darwin'), [
		'covexcode',
		path.join(home, '.local', 'bin', 'covexcode'),
		'/usr/local/bin/covexcode',
		path.join(home, '.cargo', 'bin', 'covexcode'),
		path.join(home, '.covexcode', 'bin', 'covexcode'),
	]);
});

test('covexcodeBinaryCandidates() looks for covexcode.exe under Windows install locations', () => {
	const home = 'C:\\Users\\dev';
	assert.deepEqual(covexcodeBinaryCandidates('', home, 'win32'), [
		'covexcode',
		path.join(home, '.covexcode', 'bin', 'covexcode.exe'),
		path.join(home, '.cargo', 'bin', 'covexcode.exe'),
		path.join(home, '.local', 'bin', 'covexcode.exe'),
	]);
});

test('covexcodeBinaryCandidates() treats whitespace-only as unset', () => {
	assert.equal(covexcodeBinaryCandidates('   ', '/tmp', 'linux')[0], 'covexcode');
});
