/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnosticsSummary, parseLspDiagnostics, parseLspLocations } from './lspDiagnostics';

test('parseLspDiagnostics() reads the agent one-line-per-diagnostic format', () => {
	const text = [
		'src/main.rs:12:5 error: cannot find value `x` [rust-analyzer]',
		'src/lib.rs:3:1 warning: unused import',
		'',
	].join('\n');
	assert.deepEqual(parseLspDiagnostics(text), [
		{
			path: 'src/main.rs',
			line: 12,
			column: 5,
			severity: 'error',
			message: 'cannot find value `x`',
			source: 'rust-analyzer',
		},
		{
			path: 'src/lib.rs',
			line: 3,
			column: 1,
			severity: 'warning',
			message: 'unused import',
			source: undefined,
		},
	]);
});

test('parseLspDiagnostics() keeps colons that belong to a Windows path', () => {
	const [diagnostic] = parseLspDiagnostics('C:/work/src/main.rs:7:2 hint: try this');
	assert.equal(diagnostic?.path, 'C:/work/src/main.rs');
	assert.equal(diagnostic?.line, 7);
	assert.equal(diagnostic?.column, 2);
	assert.equal(diagnostic?.severity, 'hint');
});

test('parseLspDiagnostics() ignores prose results', () => {
	assert.deepEqual(parseLspDiagnostics("No diagnostics reported for 'src/main.rs'."), []);
	assert.deepEqual(parseLspDiagnostics('The language server did not publish diagnostics'), []);
	assert.deepEqual(parseLspDiagnostics(''), []);
});

test('diagnosticsSummary() counts each severity and omits zeroes', () => {
	const diagnostics = parseLspDiagnostics([
		'a.rs:1:1 error: one',
		'a.rs:2:1 error: two',
		'a.rs:3:1 warning: three',
		'a.rs:4:1 hint: four',
	].join('\n'));
	assert.equal(diagnosticsSummary(diagnostics), '2 errors, 1 warning, 1 hint');
	assert.equal(diagnosticsSummary([]), 'no diagnostics');
});

test('parseLspLocations() reads bare definition/reference rows', () => {
	const text = [
		'src/lib.rs:5:2',
		'src/main.rs:12:9',
		'C:/work/src/main.rs:7:3',
		'',
	].join('\n');
	assert.deepEqual(parseLspLocations(text), [
		{ path: 'src/lib.rs', line: 5, column: 2 },
		{ path: 'src/main.rs', line: 12, column: 9 },
		{ path: 'C:/work/src/main.rs', line: 7, column: 3 },
	]);
});

test('parseLspLocations() ignores hover/prose text', () => {
	assert.deepEqual(parseLspLocations('```rust\nfn target()\n```'), []);
	assert.deepEqual(parseLspLocations('No definition found'), []);
	assert.deepEqual(parseLspLocations(''), []);
});
