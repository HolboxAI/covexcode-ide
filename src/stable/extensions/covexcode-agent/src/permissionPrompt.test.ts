/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePermission } from './permissionEngine';
import {
	detectCodeLanguage,
	formatActionSubtitle,
	formatActionTitle,
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
		['Yes, allow this time', 'Yes, allow for this turn', 'Yes, allow for this session', 'Yes, always allow this', 'No'],
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
	assert.equal(reject.label, 'No');
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

test('formatActionTitle formats Antigravity card title per kind', () => {
	assert.equal(formatActionTitle('execute', 'npm test'), 'Allow execute npm test?');
	assert.equal(formatActionTitle('file_write', 'src/App.tsx'), 'Allow write src/App.tsx?');
	assert.equal(formatActionTitle('file_edit', 'src/App.tsx'), 'Allow edit src/App.tsx?');
	assert.equal(formatActionTitle('file_delete', 'src/App.tsx'), 'Allow delete src/App.tsx?');
	assert.equal(formatActionTitle('file_read', 'src/App.tsx'), 'Allow read src/App.tsx?');
	assert.equal(formatActionTitle('other', 'access network'), 'Allow access network?');
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

	// Header & Title
	assert.ok(card.includes('### $(shield) Allow execute npm install lucide-react?'));

	// Code block with bash syntax
	assert.ok(card.includes('```bash\nnpm install lucide-react\n```'));

	// Horizontal rule separator
	assert.ok(card.includes('---'));

	// Numbered options
	assert.ok(card.includes('**1.** [$(check) **Yes, allow this time**]'));
	assert.ok(card.includes('**2.** [$(sync) **Yes, allow for this turn**]'));
	assert.ok(card.includes('**3.** [$(history) **Yes, allow for this session**]'));
	assert.ok(card.includes('**4.** [$(shield) **Yes, always allow this**]'));
	assert.ok(card.includes('**5.** [$(x) **No**]'));
	assert.ok(card.includes('Skip'));
	assert.ok(card.includes('Submit Feedback'));
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

	assert.ok(card.includes('### $(shield) Allow write C:\\Users\\user\\project\\src\\components\\Login.tsx?'));
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

	assert.ok(card.includes('### $(shield) Allow delete src/old.ts?'));
	assert.ok(!card.includes('Yes, always allow this'));
	// Check remaining 4 options are numbered 1 through 4
	assert.ok(card.includes('**1.** [$(check) **Yes, allow this time**]'));
	assert.ok(card.includes('**2.** [$(sync) **Yes, allow for this turn**]'));
	assert.ok(card.includes('**3.** [$(history) **Yes, allow for this session**]'));
	assert.ok(card.includes('**4.** [$(x) **No**]'));
});

test('card does not appear when evaluatePermission returns "allow" or "deny"', () => {
	const dummyContext = { turnId: 'turn-1', sessionId: 'session-1' };

	// 1. Auto-approved read-only resource: evaluatePermission returns 'allow', so card does not show
	const readDecision = evaluatePermission({ kind: 'file_read', target: 'src/App.tsx' }, [], dummyContext);
	assert.equal(readDecision, 'allow');

	// 2. Auto-approved inspection command: evaluatePermission returns 'allow', so card does not show
	const gitStatusDecision = evaluatePermission({ kind: 'execute', target: 'git status' }, [], dummyContext);
	assert.equal(gitStatusDecision, 'allow');

	// 3. Denied rule: evaluatePermission returns 'deny', so card does not show
	const denyRule = {
		kind: 'execute',
		pattern: 'git push',
		match: 'exact' as const,
		decision: 'deny' as const,
		createdAt: '2026-11-16T00:00:00.000Z',
		source: 'user' as const,
	};
	const deniedDecision = evaluatePermission({ kind: 'execute', target: 'git push' }, [denyRule], dummyContext);
	assert.equal(deniedDecision, 'deny');

	// 4. Unapproved write/execute returns 'ask' - only this triggers the card
	const askDecision = evaluatePermission({ kind: 'execute', target: 'npm install' }, [], dummyContext);
	assert.equal(askDecision, 'ask');
});

