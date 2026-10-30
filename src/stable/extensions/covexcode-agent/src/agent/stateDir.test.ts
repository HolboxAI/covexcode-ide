/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ensureAgentStateDir, resolveAgentStateDir } from './stateDir';

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'covexcode-agent-state-'));
}

function withTempDirs(run: (root: string) => void): void {
	const root = tempDir();
	try {
		run(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test('an empty setting uses the IDE-managed directory under global storage', () => {
	withTempDirs(root => {
		const location = resolveAgentStateDir({
			setting: '',
			env: {},
			globalStorage: path.join(root, 'globalStorage'),
			home: path.join(root, 'home'),
		});
		assert.equal(location.source, 'isolated');
		assert.equal(location.dir, path.join(root, 'globalStorage', 'agent'));
	});
});

test('the setting wins over COVEXCODE_CONFIG_DIR and expands ~', () => {
	withTempDirs(root => {
		const home = path.join(root, 'home');
		const location = resolveAgentStateDir({
			setting: '~/agent-state',
			env: { COVEXCODE_CONFIG_DIR: path.join(root, 'from-env') },
			globalStorage: path.join(root, 'globalStorage'),
			home,
		});
		assert.equal(location.source, 'custom');
		assert.equal(location.dir, path.join(home, 'agent-state'));
	});
});

test('pointing the setting at ~/.covexcode is recognized as shared CLI state', () => {
	withTempDirs(root => {
		const home = path.join(root, 'home');
		const location = resolveAgentStateDir({
			setting: '~/.covexcode',
			env: {},
			globalStorage: path.join(root, 'globalStorage'),
			home,
		});
		assert.equal(location.source, 'shared-cli');
		assert.equal(location.dir, path.join(home, '.covexcode'));
	});
});

test('COVEXCODE_CONFIG_DIR is honored when the setting is empty', () => {
	withTempDirs(root => {
		const location = resolveAgentStateDir({
			setting: '',
			env: { COVEXCODE_CONFIG_DIR: path.join(root, 'from-env') },
			globalStorage: path.join(root, 'globalStorage'),
			home: path.join(root, 'home'),
		});
		assert.equal(location.source, 'environment');
		assert.equal(location.dir, path.join(root, 'from-env'));
	});
});

test('the first isolated run copies CLI state and hardens secrets', () => {
	withTempDirs(root => {
		const home = path.join(root, 'home');
		const legacy = path.join(home, '.covexcode');
		fs.mkdirSync(path.join(legacy, 'sessions'), { recursive: true });
		fs.mkdirSync(path.join(legacy, 'python'), { recursive: true });
		fs.writeFileSync(path.join(legacy, 'config.toml'), '[llm]\napi_key = "sk-test"\n');
		fs.writeFileSync(path.join(legacy, 'account.token'), 'session-token');
		fs.writeFileSync(path.join(legacy, 'sessions', 'abc.json'), '{"id":"abc"}');
		fs.writeFileSync(path.join(legacy, 'python', 'ignored'), 'skip');

		const location = ensureAgentStateDir(
			resolveAgentStateDir({
				setting: '',
				env: {},
				globalStorage: path.join(root, 'globalStorage'),
				home,
			}),
		);

		assert.equal(location.source, 'isolated');
		assert.equal(location.migrated, true);
		assert.equal(fs.readFileSync(path.join(location.dir, 'config.toml'), 'utf8'), '[llm]\napi_key = "sk-test"\n');
		assert.equal(fs.readFileSync(path.join(location.dir, 'account.token'), 'utf8'), 'session-token');
		assert.equal(fs.readFileSync(path.join(location.dir, 'sessions', 'abc.json'), 'utf8'), '{"id":"abc"}');
		assert.equal(fs.existsSync(path.join(location.dir, 'python')), false);
		assert.equal(fs.existsSync(path.join(location.dir, '.ide-state-v1')), true);

		if (process.platform !== 'win32') {
			assert.equal(fs.statSync(location.dir).mode & 0o777, 0o700);
			assert.equal(fs.statSync(path.join(location.dir, 'config.toml')).mode & 0o777, 0o600);
			assert.equal(fs.statSync(path.join(location.dir, 'account.token')).mode & 0o777, 0o600);
		}
	});
});

test('migration never overwrites state the IDE directory already has', () => {
	withTempDirs(root => {
		const home = path.join(root, 'home');
		const legacy = path.join(home, '.covexcode');
		const globalStorage = path.join(root, 'globalStorage');
		const isolated = path.join(globalStorage, 'agent');
		fs.mkdirSync(legacy, { recursive: true });
		fs.mkdirSync(isolated, { recursive: true });
		fs.writeFileSync(path.join(legacy, 'config.toml'), 'legacy');
		fs.writeFileSync(path.join(isolated, 'config.toml'), 'keep');

		ensureAgentStateDir(
			resolveAgentStateDir({ setting: '', env: {}, globalStorage, home }),
		);

		assert.equal(fs.readFileSync(path.join(isolated, 'config.toml'), 'utf8'), 'keep');
	});
});

test('a completed migration is not repeated on the next activation', () => {
	withTempDirs(root => {
		const home = path.join(root, 'home');
		const legacy = path.join(home, '.covexcode');
		const globalStorage = path.join(root, 'globalStorage');
		fs.mkdirSync(legacy, { recursive: true });
		fs.writeFileSync(path.join(legacy, 'account.token'), 'first');

		const first = ensureAgentStateDir(
			resolveAgentStateDir({ setting: '', env: {}, globalStorage, home }),
		);
		fs.writeFileSync(path.join(legacy, 'account.token'), 'second');
		const second = ensureAgentStateDir(
			resolveAgentStateDir({ setting: '', env: {}, globalStorage, home }),
		);

		assert.equal(second.migrated, false);
		assert.equal(fs.readFileSync(path.join(first.dir, 'account.token'), 'utf8'), 'first');
	});
});

test('a shared or custom location is created but never migrated into', () => {
	withTempDirs(root => {
		const home = path.join(root, 'home');
		const legacy = path.join(home, '.covexcode');
		fs.mkdirSync(legacy, { recursive: true });
		fs.writeFileSync(path.join(legacy, 'config.toml'), 'legacy');
		const custom = path.join(root, 'custom');
		const location = ensureAgentStateDir(
			resolveAgentStateDir({ setting: custom, env: {}, globalStorage: path.join(root, 'globalStorage'), home }),
		);
		assert.equal(location.source, 'custom');
		assert.equal(fs.existsSync(custom), true);
		assert.equal(fs.existsSync(path.join(custom, 'config.toml')), false);
		assert.equal(fs.existsSync(path.join(custom, '.ide-state-v1')), false);
	});
});
