/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MCP_CATALOG, catalogByCategory, catalogEntryToServer, catalogStats, findCatalogEntry, searchCatalog, unverifiedCatalogIds } from './mcpCatalog';

test('every catalog id is unique', () => {
	const ids = MCP_CATALOG.map(e => e.id);
	assert.equal(new Set(ids).size, ids.length);
});

test('transport-specific fields are consistent', () => {
	for (const e of MCP_CATALOG) {
		if (e.transport === 'stdio') {
			assert.ok(e.command, `${e.id} is stdio but has no command`);
			assert.equal(e.url, undefined, `${e.id} is stdio but declares a url`);
		} else {
			assert.ok(e.url, `${e.id} is http but has no url`);
			assert.equal(e.command, undefined, `${e.id} is http but declares a command`);
		}
	}
});

test('authenticated servers point at documentation', () => {
	for (const e of MCP_CATALOG.filter(e => e.requiresAuth)) {
		assert.ok(e.docs, `${e.id} requires auth but has no docs link`);
	}
});

test('no recipe is silently claimed as verified', () => {
	// Verification needs a registry check this module cannot do offline.
	assert.equal(catalogStats().verified, 0);
	assert.equal(unverifiedCatalogIds().length, MCP_CATALOG.length);
});

test('catalogEntryToServer builds a typed server', () => {
	const stdio = catalogEntryToServer(MCP_CATALOG.find(e => e.transport === 'stdio')!);
	assert.equal(stdio.transport, 'stdio');
	const http = catalogEntryToServer(MCP_CATALOG.find(e => e.transport === 'streamable-http')!);
	assert.equal(http.transport, 'streamable-http');
	assert.equal(catalogEntryToServer(MCP_CATALOG[0], 'renamed').name, 'renamed');
});

test('lookup and search behave', () => {
	assert.equal(findCatalogEntry('filesystem')?.id, 'filesystem');
	assert.equal(findCatalogEntry('nope-not-real'), undefined);
	assert.ok(searchCatalog('git').length > 0);
	assert.ok(catalogByCategory().get('cloud')?.some((e) => e.id === 'aws'));
});
