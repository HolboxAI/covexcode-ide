/**
 * Tests for the IDE slash-command list and the `/help` + `/doctor` readouts.
 *
 * Run with `npm test` from `src/stable/extensions/covexcode-agent`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doctorMarkdown, helpMarkdown, IDE_SLASH_COMMANDS } from './slashCommands';

test('helpMarkdown lists every slash command, driven by the single list', () => {
	const readout = helpMarkdown();
	for (const command of IDE_SLASH_COMMANDS) {
		assert.match(readout, new RegExp(command.name.replace('/', '\\/')));
	}
});

test('helpMarkdown advertises the new /mode, /help and /doctor commands', () => {
	const readout = helpMarkdown();
	assert.match(readout, /\/mode/);
	assert.match(readout, /\/help/);
	assert.match(readout, /\/doctor/);
});

test('doctorMarkdown reports the api key as present/absent, never its value', () => {
	const readout = doctorMarkdown({
		version: 'covexcode 1.11.88',
		agentSource: 'external',
		platform: 'darwin',
		arch: 'arm64',
		configPath: '/home/u/.covexcode/config.toml',
		configFound: true,
		provider: 'deepseek',
		model: 'deepseek-v4-pro',
		endpoint: 'https://api.deepseek.com',
		apiKeySet: true,
		workspace: '/tmp/project',
		workspaceIsGit: true,
		stateDirFound: true,
	});
	assert.match(readout, /set \(not shown\)/);
	assert.doesNotMatch(readout, /bx-live-/);
	assert.match(readout, /git repo/);
	assert.match(readout, /deepseek-v4-pro/);
	assert.match(readout, /Agent:\*\* external/);
});

test('doctorMarkdown shows the bundled agent source and path', () => {
	const readout = doctorMarkdown({
		version: 'covexcode 1.11.92',
		agentSource: 'bundled',
		agentPath: '/Applications/Covexcode IDE.app/Contents/Resources/app/extensions/covexcode-agent/resources/bin/covexcode',
		platform: 'darwin',
		arch: 'arm64',
		configPath: '/c',
		configFound: true,
		provider: '',
		model: '',
		endpoint: '',
		apiKeySet: false,
		workspace: '',
		workspaceIsGit: false,
		stateDirFound: true,
	});
	assert.match(readout, /Agent:\*\* bundled \(.*resources\/bin\/covexcode\)/);
});

test('doctorMarkdown marks an empty workspace as not set', () => {
	const readout = doctorMarkdown({
		version: 'covexcode 1.11.88',
		agentSource: 'external',
		platform: 'darwin',
		arch: 'arm64',
		configPath: '/c',
		configFound: false,
		provider: '',
		model: '',
		endpoint: '',
		apiKeySet: false,
		workspace: '',
		workspaceIsGit: false,
		stateDirFound: false,
	});
	assert.match(readout, /Workspace:\*\* not set/);
	assert.match(readout, /not set/);
});
