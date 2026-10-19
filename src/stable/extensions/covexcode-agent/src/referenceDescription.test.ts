/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeReferenceValue } from './referenceDescription';

test('describeReferenceValue() returns a string reference as-is', () => {
	assert.equal(describeReferenceValue('hello world'), 'hello world');
});

test('describeReferenceValue() renders a Location-like value with a 1-based line number', () => {
	const location = {
		uri: { toString: () => 'file:///Users/dhruv/project/src/index.ts' },
		range: { start: { line: 41 }, end: { line: 41 } },
	};
	assert.equal(
		describeReferenceValue(location),
		'file:///Users/dhruv/project/src/index.ts (line 42)',
	);
});

test('describeReferenceValue() renders a Uri-like value via its own toString()', () => {
	const uri = { toString: () => 'file:///Users/dhruv/project/README.md' };
	assert.equal(describeReferenceValue(uri), 'file:///Users/dhruv/project/README.md');
});

test('describeReferenceValue() does not stringify an unrecognized plain object to "[object Object]"', () => {
	const mystery = { foo: 'bar' };
	assert.equal(describeReferenceValue(mystery), '[unrecognized reference type, skipped]');
	assert.notEqual(describeReferenceValue(mystery), '[object Object]');
});

test('describeReferenceValue() handles null and undefined without throwing', () => {
	assert.equal(describeReferenceValue(null), '[unrecognized reference type, skipped]');
	assert.equal(describeReferenceValue(undefined), '[unrecognized reference type, skipped]');
});
