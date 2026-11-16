/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	detectCodeLanguage,
	formatActionSubtitle,
	isDestructiveAlwaysAllow,
	permissionPromptLinks,
	renderPermissionCard,
} from './permissionPrompt';

test('renders five links for a non-destructive file write', () => {
	const links = permissionPromptLinks({
		id: '1',
		allowLabel: 'CUSTOM-ALLOW',
		rejectLabel: 'CUSTOM-REJECT',
		kind: 'file_write',
		action: 'C:\\Users\\u\\src\\App.tsx',
	});
	assert.deepEqual(
		links.map(l => l.choice),
		['allow', 'allow-turn', 'allow-session', 'allow-always', 'reject'],
	);
	assert.deepEqual(
		links.map(l => l.label),
		['Allow Once', 'Allow for This Turn', 'Allow for This Session', 'Always Allow', 'Reject'],
	);
});

test('reject link still resolves to choice "reject"', () => {
	const links = permissionPromptLinks({
		id: '1',
		allowLabel: 'CUSTOM-ALLOW',
		rejectLabel: 'CUSTOM-REJECT',
		kind: 'execute',
		action: 'npm test',
	});
	const reject = links.at(-1);
	assert.ok(reject);
	assert.equal(reject.choice, 'reject');
	assert.equal(reject.label, 'Reject');
});

test('Always Allow is hidden for file_delete', () => {
	const links = permissionPromptLinks({
		id: '1',
		allowLabel: 'Allow',
		rejectLabel: 'Reject',
		kind: 'file_delete',
		action: 'C:\\Users\\u\\src\\App.tsx',
	});
	assert.ok(!links.some(l => l.choice === 'allow-always'));
});

test('destructive command markers hide Always Allow', () => {
	for (const marker of ['rm -rf /', 'del file.txt', 'rmdir /s', 'format C:', 'drop table', 'truncate x', ':(){:|:&};:']) {
		assert.equal(
			isDestructiveAlwaysAllow('execute', marker),
			true,
			`expected ${JSON.stringify(marker)} to be destructive`,
		);
	}
});

test('non-destructive commands and file paths are not destructive', () => {
	assert.equal(isDestructiveAlwaysAllow('execute', 'npm test'), false);
	// A path containing "format" must not lose its Always Allow link.
	assert.equal(isDestructiveAlwaysAllow('file_write', 'C:\\Users\\u\\src\\format.ts'), false);
	assert.equal(isDestructiveAlwaysAllow('file_write', 'C:\\Users\\u\\src\\App.tsx'), false);
});

test('formatActionSubtitle formats subtitles per kind', () => {
	assert.equal(formatActionSubtitle('execute'), 'covexcode wants to execute:');
	assert.equal(formatActionSubtitle('file_write'), 'covexcode wants to write:');
	assert.equal(formatActionSubtitle('write'), 'covexcode wants to write:');
	assert.equal(formatActionSubtitle('file_edit'), 'covexcode wants to edit:');
	assert.equal(formatActionSubtitle('file_delete'), 'covexcode wants to delete:');
	assert.equal(formatActionSubtitle('file_read'), 'covexcode wants to read:');
	assert.equal(formatActionSubtitle('unknown_tool'), 'covexcode wants to run:');
});

test('detectCodeLanguage infers syntax highlighting language from kind and path', () => {
	assert.equal(detectCodeLanguage('execute', 'npm test'), 'bash');
	assert.equal(detectCodeLanguage('file_write', 'src/App.tsx'), 'typescript');
	assert.equal(detectCodeLanguage('file_write', 'server.js'), 'javascript');
	assert.equal(detectCodeLanguage('file_write', 'config.json'), 'json');
	assert.equal(detectCodeLanguage('file_write', 'script.py'), 'python');
	assert.equal(detectCodeLanguage('file_write', 'deploy.sh'), 'bash');
	assert.equal(detectCodeLanguage('file_write', 'styles.css'), 'css');
	assert.equal(detectCodeLanguage('file_write', 'index.html'), 'html');
	assert.equal(detectCodeLanguage('file_write', 'Makefile'), '');
});

test('renderPermissionCard formats command execution card with Antigravity styling and numbered options', () => {
	const card = renderPermissionCard({
		id: 'perm-1',
		allowLabel: 'Allow',
		rejectLabel: 'Reject',
		kind: 'execute',
		action: 'npm install lucide-react',
	});

	// Header & Subtitle
	assert.ok(card.includes('### $(shield) covexcode needs permission'));
	assert.ok(card.includes('covexcode wants to execute:'));

	// Code block with bash syntax
	assert.ok(card.includes('```bash\nnpm install lucide-react\n```'));

	// Horizontal rule separator
	assert.ok(card.includes('---'));

	// Numbered options
	assert.ok(card.includes('**1.** [$(check) **Allow Once**]'));
	assert.ok(card.includes('**2.** [$(sync) **Allow for This Turn**]'));
	assert.ok(card.includes('**3.** [$(history) **Allow for This Session**]'));
	assert.ok(card.includes('**4.** [$(shield) **Always Allow**]'));
	assert.ok(card.includes('**5.** [$(x) **Reject**]'));
});

test('renderPermissionCard preserves Windows paths with backslashes verbatim', () => {
	const winPath = 'C:\\Users\\user\\project\\src\\components\\Login.tsx';
	const card = renderPermissionCard({
		id: 'perm-win',
		allowLabel: 'Allow',
		rejectLabel: 'Reject',
		kind: 'file_write',
		action: winPath,
	});

	assert.ok(card.includes('covexcode wants to write:'));
	// Verify backslashes are preserved verbatim without escaping
	assert.ok(card.includes(`\`\`\`typescript\n${winPath}\n\`\`\``));
});

test('renderPermissionCard hides Always Allow for destructive actions and numbers remaining 4 options', () => {
	const card = renderPermissionCard({
		id: 'perm-del',
		allowLabel: 'Allow',
		rejectLabel: 'Reject',
		kind: 'file_delete',
		action: 'src/old.ts',
	});

	assert.ok(card.includes('covexcode wants to delete:'));
	assert.ok(!card.includes('Always Allow'));
	// Check remaining 4 options are numbered 1 through 4
	assert.ok(card.includes('**1.** [$(check) **Allow Once**]'));
	assert.ok(card.includes('**2.** [$(sync) **Allow for This Turn**]'));
	assert.ok(card.includes('**3.** [$(history) **Allow for This Session**]'));
	assert.ok(card.includes('**4.** [$(x) **Reject**]'));
});

