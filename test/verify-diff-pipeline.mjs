/**
 * Replays a captured ACP wire log through the extension's real diff-collection
 * logic, so the chat panel's changed-file summary can be checked against what
 * the agent actually sent rather than against a hand-written fixture.
 *
 * Usage:
 *   verify-diff-pipeline.mjs <captured.jsonl> <module-dir>
 *
 * <module-dir> is the compiled output directory holding `diffPreview.js`
 * (`out-test/` after `tsc -p tsconfig.test.json`).
 *
 * It reports the two numbers that decide whether the summary can render at all:
 * how many diffs the old collection gate sees on the wire, and how many entries
 * the journal fallback produces once that comes up empty.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [logPath, moduleDir] = process.argv.slice(2);
if (!logPath || !moduleDir) {
	console.error('usage: verify-diff-pipeline.mjs <captured.jsonl> <module-dir>');
	process.exit(2);
}

const { computeFileDiffSummary, TurnFileObserver, toolTitlePath } = await import(
	pathToFileURL(path.resolve(moduleDir, 'diffPreview.js')).href
);

const records = readFileSync(logPath, 'utf8')
	.trim()
	.split('\n')
	.filter(Boolean)
	.map(line => JSON.parse(line));

const updates = records.filter(r => r.kind === 'update');
const journal = records.find(r => r.kind === 'list_changes')?.result?.changes ?? [];
const turn = records.find(r => r.kind === 'prompt_result')?.result?.turn;

// --- Path 1: the collection gate as it was -- only a `diff` content block. ---
const collectedFromWire = updates.filter(u => u.update?.content?.type === 'diff');

// --- Path 2: the observer fed from the same updates, as renderUpdate now does. ---
const titles = new Map();
const observed = new TurnFileObserver();
for (const record of updates) {
	const update = record.update ?? {};
	if (update.toolCallId && update.title) {
		titles.set(update.toolCallId, update.title);
	}
	if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
		continue;
	}
	const title = update.title ?? (update.toolCallId ? titles.get(update.toolCallId) : undefined);
	if (!title) {
		continue;
	}
	const parsed = toolTitlePath(title);
	if (!parsed) {
		continue;
	}
	if (parsed.action === 'read' || parsed.action === 'view') {
		if (update.status === 'completed' && update.content?.type === 'content') {
			observed.noteRead(parsed.path, update.content.text);
		}
	} else {
		observed.noteMutation(parsed.path);
	}
}

// --- Path 3: the journal fallback, as appendJournalEntries now builds it. ---
const entries = [];
for (const change of journal) {
	if (change.turn !== turn || change.action === 'blocked') {
		continue;
	}
	// Mirror `appendJournalEntries` exactly: a `delete` action means the file did
	// not exist before the session, so its before-image is undefined (status
	// `added`), not an empty string (which would read as `modified`).
	const before = change.action === 'delete' ? undefined : observed.beforeFor(change.path);
	const newText = readFileSync(path.resolve(process.env.WORKSPACE ?? '.', change.path), 'utf8');
	entries.push({ change, before, newText });
}

console.log(`updates on the wire              : ${updates.length}`);
console.log(`diff content blocks (old gate)   : ${collectedFromWire.length}`);
console.log(`journal entries for this turn    : ${journal.filter(c => c.turn === turn).length}`);
console.log('');

for (const { change, before, newText } of entries) {
	const knownBefore = before !== undefined;
	const summary = knownBefore
		? computeFileDiffSummary({ oldText: before, newText })
		: undefined;
	const listed = change.action === 'delete' ? 'added (all-green)' : knownBefore ? 'diff' : 'listOnly (filename only)';
	console.log(`file        : ${change.path}  (${change.action}, turn ${change.turn})`);
	console.log(`rendered as : ${listed}`);
	if (summary) {
		console.log(`status      : ${summary.status}`);
		console.log(`added       : ${summary.added}`);
		console.log(`removed     : ${summary.removed}`);
		const beforeLine = (before ?? '').split('\n').find(l => !newText.split('\n').includes(l));
		const addedLine = newText.split('\n').find(l => !(before ?? '').split('\n').includes(l));
		console.log(`removed line: ${beforeLine === undefined ? '(none)' : JSON.stringify(beforeLine)}`);
		console.log(`added line  : ${addedLine === undefined ? '(none)' : JSON.stringify(addedLine)}`);
	}
}

const renderable = entries.filter(e => e.change.action === 'delete' || e.before !== undefined).length;
console.log('');
console.log(`entries the summary can render   : ${renderable} of ${entries.length}`);
