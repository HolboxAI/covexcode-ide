/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalizeLocalhostUrl, findLocalhostUrl, findMatchingBrowserTab, findReusableBrowserTab, isIdleBrowserUrl, localhostOrigin, urlsAreSameLocalPage } from './localhostUrl';

test('findLocalhostUrl() finds a Vite-style "Local:" line inside real dev-server output', () => {
	const output = [
		'',
		'  VITE v5.2.0  ready in 312 ms',
		'',
		'  ➜  Local:   http://localhost:5173/',
		'  ➜  Network: use --host to expose',
		'',
	].join('\n');
	assert.equal(findLocalhostUrl(output), 'http://localhost:5173');
});

test('findLocalhostUrl() finds a plain http.server-style line', () => {
	const output = 'Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...';
	assert.equal(findLocalhostUrl(output), 'http://localhost:8000');
});

test('findLocalhostUrl() rewrites a bare 0.0.0.0 host to localhost, port included', () => {
	assert.equal(findLocalhostUrl('Listening on http://0.0.0.0:3000'), 'http://localhost:3000');
});

test('findLocalhostUrl() accepts 127.0.0.1 as the same local server as localhost', () => {
	assert.equal(findLocalhostUrl('Server started at http://127.0.0.1:4000/'), 'http://localhost:4000');
});

test('findLocalhostUrl() returns undefined for a real, non-local URL', () => {
	// The actual danger this guards against: a build log, a curl target, a
	// README a command happened to cat -- none of those are safe to open
	// without being asked.
	assert.equal(findLocalhostUrl('Deploying to https://myapp.example.com/dashboard'), undefined);
});

test('findLocalhostUrl() returns undefined for plain text with no URL at all', () => {
	assert.equal(findLocalhostUrl('node_modules present'), undefined);
});

test('findLocalhostUrl() finds the first localhost URL when multiple lines are present', () => {
	const output = 'compiling...\nLocal:   http://localhost:3000\nNetwork: http://192.168.1.5:3000';
	assert.equal(findLocalhostUrl(output), 'http://localhost:3000');
});

test('findLocalhostUrl() strips trailing sentence punctuation from the URL', () => {
	assert.equal(findLocalhostUrl('Started at http://localhost:3000.'), 'http://localhost:3000');
	assert.equal(findLocalhostUrl('see http://127.0.0.1:8080/), next'), 'http://localhost:8080');
});

test('canonicalizeLocalhostUrl() treats loopback hosts and trailing slashes as one page', () => {
	assert.equal(canonicalizeLocalhostUrl('http://127.0.0.1:5173/'), 'http://localhost:5173');
	assert.equal(canonicalizeLocalhostUrl('http://localhost:5173/'), 'http://localhost:5173');
	assert.equal(canonicalizeLocalhostUrl('http://0.0.0.0:5173'), 'http://localhost:5173');
	assert.equal(urlsAreSameLocalPage('http://127.0.0.1:5173/', 'http://localhost:5173'), true);
	assert.equal(urlsAreSameLocalPage('http://localhost:5173', 'http://localhost:3000'), false);
});

test('findMatchingBrowserTab() reuses a tab whose URL is a loopback spelling of the same server', () => {
	const tabs = [{ url: 'http://127.0.0.1:5173/' }, { url: 'http://localhost:3000' }];
	assert.equal(findMatchingBrowserTab(tabs, 'http://localhost:5173')?.url, 'http://127.0.0.1:5173/');
	assert.equal(findMatchingBrowserTab(tabs, 'http://localhost:8080'), undefined);
});

test('localhostOrigin() is one key per local server, ignoring path', () => {
	assert.equal(localhostOrigin('http://127.0.0.1:5173/menu'), 'http://localhost:5173');
	assert.equal(localhostOrigin('http://localhost:5173/'), 'http://localhost:5173');
});

test('findReusableBrowserTab() prefers the same origin, then an idle about:blank pane', () => {
	const originTabs = [{ url: 'http://localhost:5173/menu' }, { url: 'about:blank' }];
	assert.equal(findReusableBrowserTab(originTabs, 'http://localhost:5173/')?.url, 'http://localhost:5173/menu');

	const idleTabs = [{ url: 'about:blank' }, { url: 'http://localhost:3000' }];
	assert.equal(findReusableBrowserTab(idleTabs, 'http://localhost:5173')?.url, 'about:blank');
	assert.equal(isIdleBrowserUrl('about:blank'), true);
	assert.equal(findReusableBrowserTab([{ url: 'http://localhost:3000' }], 'http://localhost:5173'), undefined);
});
