/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { boxcodeBinaryCandidates } from './boxcodeBinary';

test('boxcodeBinaryCandidates() uses only the configured path when set', () => {
	assert.deepEqual(boxcodeBinaryCandidates('  /opt/boxcode  ', '/Users/dev', 'darwin'), ['/opt/boxcode']);
});

test('boxcodeBinaryCandidates() tries PATH then install.sh locations when unset', () => {
	const home = '/Users/dev';
	assert.deepEqual(boxcodeBinaryCandidates('', home, 'darwin'), [
		'boxcode',
		path.join(home, '.local', 'bin', 'boxcode'),
		'/usr/local/bin/boxcode',
		path.join(home, '.cargo', 'bin', 'boxcode'),
		path.join(home, '.boxcode', 'bin', 'boxcode'),
	]);
});

test('boxcodeBinaryCandidates() looks for boxcode.exe under Windows install locations', () => {
	const home = 'C:\\Users\\dev';
	assert.deepEqual(boxcodeBinaryCandidates('', home, 'win32'), [
		'boxcode',
		path.join(home, '.boxcode', 'bin', 'boxcode.exe'),
		path.join(home, '.cargo', 'bin', 'boxcode.exe'),
		path.join(home, '.local', 'bin', 'boxcode.exe'),
	]);
});

test('boxcodeBinaryCandidates() treats whitespace-only as unset', () => {
	assert.equal(boxcodeBinaryCandidates('   ', '/tmp', 'linux')[0], 'boxcode');
});
