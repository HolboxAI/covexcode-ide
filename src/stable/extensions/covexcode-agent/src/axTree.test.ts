/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serializeAxTree, AxNode, AX_TREE_MAX_NODES } from './axTree';

/** Builds an `AxNode` with the fields a test cares about, defaulting the rest. */
function node(id: string, role: string, extra: Partial<AxNode> = {}): AxNode {
	return { nodeId: id, role: { value: role }, ...extra };
}

test('an empty tree serializes to an empty string', () => {
	assert.equal(serializeAxTree([]), '');
});

test('a small tree serializes roles, names, and text as indented lines', () => {
	const nodes: AxNode[] = [
		node('1', 'RootWebArea', { name: { value: 'My App' }, childIds: ['2', '4'] }),
		node('2', 'banner', { childIds: ['3'] }),
		node('3', 'heading', { name: { value: 'My App' } }),
		node('4', 'main', { childIds: ['5', '7'] }),
		node('5', 'StaticText', { name: { value: 'Hello world' }, ignored: true, childIds: ['6'] }),
		node('6', 'InlineTextBox', { name: { value: 'Hello world' }, ignored: true }),
		node('7', 'button', { name: { value: 'Submit' } }),
	];

	assert.equal(
		serializeAxTree(nodes),
		[
			'rootwebarea "My App"',
			'  banner',
			'    heading "My App"',
			'  main',
			'    Hello world',
			'    button "Submit"',
		].join('\n'),
	);
});

test('an ignored structural container is folded but its text survives', () => {
	const nodes: AxNode[] = [
		node('1', 'rootwebarea', { childIds: ['2'] }),
		node('2', 'generic', { ignored: true, childIds: ['3'] }),
		node('3', 'StaticText', { name: { value: 'kept' }, ignored: true }),
	];

	assert.equal(serializeAxTree(nodes), ['rootwebarea', '  kept'].join('\n'));
});

test('an input-like role includes its current value', () => {
	const nodes: AxNode[] = [
		node('1', 'rootwebarea', { childIds: ['2'] }),
		node('2', 'textbox', { name: { value: 'Search' }, value: { value: 'query' } }),
	];

	assert.equal(serializeAxTree(nodes), ['rootwebarea', '  textbox "Search" = "query"'].join('\n'));
});

test('a tree wider than the cap is cut off with an explicit marker', () => {
	const children: string[] = [];
	const nodes: AxNode[] = [node('root', 'rootwebarea', { childIds: children })];
	for (let i = 0; i < AX_TREE_MAX_NODES + 50; i++) {
		const id = `b${i}`;
		children.push(id);
		nodes.push(node(id, 'button', { name: { value: `Button ${i}` } }));
	}

	const out = serializeAxTree(nodes);
	const lines = out.split('\n');
	assert.equal(lines[0], 'rootwebarea');
	assert.equal(lines[lines.length - 1], '… (truncated)');
	// root line + up to AX_TREE_MAX_NODES emitted + one marker line.
	assert.ok(lines.length <= AX_TREE_MAX_NODES + 2, `too many lines: ${lines.length}`);
});
