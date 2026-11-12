/**
 * Multi-turn twin of `run-extension-e2e.mjs`: drives the REAL compiled
 * extension bundle through several consecutive prompts in ONE chat session and
 * reports, per turn, whether a `ChatResponseMultiDiffPart` reached the stream
 * and what it carried.
 *
 * This is the check for the reported "works on the first prompt, then stops
 * showing changes" symptom. Reading the code cannot settle it: the turn filter,
 * the per-session touch snapshot and the before-image cache all interact, so
 * the only reliable answer comes from running consecutive turns.
 *
 * Usage:
 *   run-extension-multi-turn.mjs <extension.js> <workspace-cwd> <prompt> [prompt...]
 */

import Module from 'node:module';
import { pathToFileURL } from 'node:url';

const [bundlePath, cwd, ...prompts] = process.argv.slice(2);
if (!bundlePath || !cwd || prompts.length === 0) {
	console.error('usage: run-extension-multi-turn.mjs <extension.js> <cwd> <prompt> [prompt...]');
	process.exit(2);
}

// ---------------------------------------------------------------- vscode stub
let pushes = [];
let markdown = [];
let participant;

class Uri {
	constructor(scheme, path, query) {
		this.scheme = scheme;
		this.path = path;
		this.query = query ?? '';
		this.fsPath = path;
	}
	toString() {
		return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}`;
	}
	with(change) {
		return new Uri(change.scheme ?? this.scheme, change.path ?? this.path, change.query ?? this.query);
	}
	static file(p) {
		return new Uri('file', p);
	}
	static from(parts) {
		return new Uri(parts.scheme, parts.path, parts.query);
	}
	static parse(value) {
		const scheme = value.split(':')[0];
		return new Uri(scheme, value.slice(scheme.length + 1));
	}
	static joinPath(base, ...segments) {
		return new Uri(base.scheme, [base.path.replace(/\/$/, ''), ...segments].join('/'));
	}
}

class ChatResponseMultiDiffPart {
	constructor(value, title, readOnly) {
		this.value = value;
		this.title = title;
		this.readOnly = readOnly;
	}
}

class MarkdownString {
	constructor(value, supportThemeIcons) {
		this.value = value ?? '';
		this.supportThemeIcons = supportThemeIcons;
		this.isTrusted = false;
	}
	appendMarkdown(text) {
		this.value += text;
		return this;
	}
	appendText(text) {
		this.value += text;
		return this;
	}
	appendCodeblock(code, lang) {
		this.value += `\n\`\`\`${lang ?? ''}\n${code}\n\`\`\`\n`;
		return this;
	}
}

function newStream() {
	return {
		push(part) {
			pushes.push(part);
		},
		markdown(value) {
			markdown.push(typeof value === 'string' ? value : value?.value);
		},
		textEdit() {},
		reference() {},
		progress() {},
		anchor() {},
		button() {},
		filetree() {},
		confirmation() {
			return { then: () => {} };
		},
		clearToPreviousToolInvocation() {},
	};
}

function anyStub() {
	const fn = function () {
		return anyStub();
	};
	return new Proxy(fn, {
		get(target, prop) {
			if (prop === 'then') {
				return undefined;
			}
			if (prop === Symbol.toPrimitive || prop === 'toString') {
				return () => '';
			}
			if (!(prop in target)) {
				target[prop] = anyStub();
			}
			return target[prop];
		},
		apply() {
			return anyStub();
		},
		construct() {
			return anyStub();
		},
	});
}

function withFallback(namespace) {
	return new Proxy(namespace, {
		get(target, prop) {
			if (prop in target) {
				return target[prop];
			}
			if (prop === 'then') {
				return undefined;
			}
			target[prop] = anyStub();
			return target[prop];
		},
	});
}

const configuration = {
	get: (key, fallback) => (key === 'permissionMode' ? 'auto' : fallback),
	has: () => true,
	inspect: () => undefined,
	update: async () => {},
};

const vscode = {
	Uri,
	MarkdownString,
	ChatResponseMultiDiffPart,
	ChatResponseDiffEntry: class {},
	ChatToolInvocationPart: class {
		constructor(name, id, errorMessage) {
			this.name = name;
			this.toolCallId = id;
			this.errorMessage = errorMessage;
		}
	},
	ChatResponseClearToPreviousToolInvocationReason: { NoReason: 0 },
	Range: class {
		constructor(a, b) {
			this.a = a;
			this.b = b;
		}
	},
	TextEdit: class {
		constructor(range, text) {
			this.range = range;
			this.newText = text;
		}
	},
	Position: class {
		constructor(line, character) {
			this.line = line;
			this.character = character;
		}
	},
	EventEmitter: class {
		constructor() {
			this.listeners = [];
			this.event = fn => {
				this.listeners.push(fn);
				return { dispose: () => {} };
			};
		}
		fire(value) {
			for (const listener of this.listeners) {
				listener(value);
			}
		}
		dispose() {}
	},
	StatusBarAlignment: { Left: 1, Right: 2 },
	ViewColumn: { One: 1, Two: 2, Active: -1, Beside: -2 },
	ConfigurationTarget: { Global: 1, Workspace: 2 },
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ChatResponseStream: class {},
	ChatRequestTurn: class {},
	ChatResponseTurn: class {},
	ThemeIcon: class {
		constructor(id) {
			this.id = id;
		}
	},
	workspace: {
		getConfiguration: () => configuration,
		workspaceFolders: [{ uri: Uri.file(cwd), name: 'workspace', index: 0 }],
		onDidChangeConfiguration: () => ({ dispose: () => {} }),
		onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
		openTextDocument: async () => ({ uri: Uri.file(cwd), getText: () => '', positionAt: () => ({}) }),
		textDocuments: [],
		fs: { readFile: async () => new Uint8Array(), writeFile: async () => {}, stat: async () => ({ type: 1 }) },
		isTrusted: true,
		applyEdit: async () => true,
		getWorkspaceFolder: () => ({ uri: Uri.file(cwd) }),
	},
	window: {
		showInformationMessage: async () => undefined,
		showWarningMessage: async () => undefined,
		showErrorMessage: async () => undefined,
		showQuickPick: async () => undefined,
		showInputBox: async () => undefined,
		withProgress: async (_o, task) => task({ report: () => {} }, { isCancellationRequested: false }),
		createOutputChannel: () => ({ appendLine: () => {}, append: () => {}, show: () => {}, dispose: () => {} }),
		createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show: () => {}, hide: () => {}, dispose: () => {} }),
		createWebviewPanel: () => ({
			webview: { html: '', onDidReceiveMessage: () => ({ dispose: () => {} }) },
			onDidDispose: () => ({ dispose: () => {} }),
			dispose: () => {},
		}),
		registerWebviewViewProvider: () => ({ dispose: () => {} }),
		activeTextEditor: undefined,
		tabGroups: { all: [] },
		showTextDocument: async () => ({}),
	},
	commands: {
		registerCommand: () => ({ dispose: () => {} }),
		registerTextEditorCommand: () => ({ dispose: () => {} }),
		executeCommand: async () => undefined,
		getCommands: async () => [],
	},
	chat: {
		createChatParticipant: (id, handler) => {
			participant = { id, handler };
			return { dispose: () => {} };
		},
	},
	authentication: {
		getSession: async () => undefined,
		registerAuthenticationProvider: () => ({ dispose: () => {} }),
		onDidChangeSessions: () => ({ dispose: () => {} }),
	},
	l10n: { t: message => message },
	extensions: { getExtension: () => undefined, all: [] },
	env: {
		openExternal: async () => true,
		clipboard: { writeText: async () => {} },
		appName: 'Covexcode',
		language: 'en',
		uriScheme: 'covexcode',
		machineId: 'test',
	},
	Disposable: class {
		constructor(fn) {
			this.disposeFn = fn;
		}
		dispose() {
			this.disposeFn?.();
		}
		static from(...items) {
			return { dispose: () => items.forEach(i => i.dispose?.()) };
		}
	},
	CancellationTokenSource: class {
		constructor() {
			this.token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };
		}
		cancel() {}
		dispose() {}
	},
	TreeItem: class {},
	ThemeColor: class {
		constructor(id) {
			this.id = id;
		}
	},
	FileType: { File: 1, Directory: 2 },
};

for (const name of ['workspace', 'window', 'commands', 'chat', 'languages', 'authentication', 'env', 'extensions', 'debug', 'tasks', 'lm']) {
	if (vscode[name] === undefined) {
		vscode[name] = {};
	}
	vscode[name] = withFallback(vscode[name]);
}

class SlashCommand {
	constructor(name) {
		this.name = name;
	}
}
for (const name of [
	'RelativePattern', 'CompletionItem', 'CompletionList', 'WorkspaceEdit', 'CodeAction',
	'CodeActionKind', 'SnippetString', 'Selection', 'Location', 'SymbolInformation',
	'DocumentSymbol', 'CallHierarchyItem', 'Diagnostic', 'DiagnosticSeverity',
	'FileSystemError', 'ThemeColor', 'TreeItem', 'ChatResponseTurn2',
	'ChatResponseThinkingProgressPart', 'ChatResponseExternalEditPart', 'ChatResponseFileTreePart',
	'ChatResponseAnchorPart', 'ChatResponseReferencePart', 'ChatResponseCodeCitationPart',
	'ChatResponseMarkdownPart', 'ChatResponseProgressPart', 'ChatResponseWarningPart',
	'ChatResponseConfirmationPart', 'ChatResponseMovePart', 'ChatResponseExtensionsPart',
	'ChatResponsePullRequestPart', 'ChatResponseWorkspaceEditPart', 'ChatResponseTextEditPart',
	'ChatResponseNotebookEditPart', 'ChatResponseQuestionCarouselPart', 'ChatResponseCommandButtonPart',
]) {
	if (!vscode[name]) {
		vscode[name] = class {
			constructor(...args) {
				this.args = args;
			}
		};
	}
}
vscode.SlashCommand = SlashCommand;

const originalLoad = Module._load;
Module._load = function (request) {
	if (request === 'vscode') {
		return vscode;
	}
	return originalLoad.apply(this, arguments);
};

// --------------------------------------------------------------- run turns
const ext = await import(pathToFileURL(bundlePath).href);

const context = {
	subscriptions: [],
	extensionUri: Uri.file('/tmp/extension'),
	extensionPath: '/tmp/extension',
	globalState: { get: () => undefined, update: async () => {}, keys: () => [] },
	workspaceState: { get: () => undefined, update: async () => {}, keys: () => [] },
	secrets: {
		get: async () => undefined,
		store: async () => {},
		delete: async () => {},
		onDidChange: () => ({ dispose: () => {} }),
	},
	storageUri: Uri.file('/tmp/storage'),
	globalStorageUri: Uri.file('/tmp/globalStorage'),
	logUri: Uri.file('/tmp/logs'),
	extensionMode: 3,
	asAbsolutePath: p => `/tmp/extension/${p}`,
	environmentVariableCollection: { replace: () => {}, append: () => {}, prepend: () => {}, clear: () => {}, get: () => undefined, delete: () => {} },
	extension: { packageJSON: { version: '1.1.2' } },
};

try {
	ext.activate(context);
} catch (error) {
	console.log('activate() threw:', error.message);
}
if (!participant) {
	console.log('NO chat participant registered');
	process.exit(1);
}

const history = [];
let failures = 0;

for (const [index, prompt] of prompts.entries()) {
	pushes = [];
	markdown = [];
	const turnNo = index + 1;
	console.log(`\n────────── prompt ${turnNo}: ${prompt.slice(0, 80)}`);

	const request = {
		prompt,
		command: undefined,
		references: [],
		location: 1,
		toolInvocationToken: undefined,
		mode: undefined,
		sessionId: 'e2e-session',
	};
	const chatContext = { history: [...history], yieldRequested: false, chatSessionContext: undefined };

	try {
		await participant.handler(request, chatContext, newStream(), {
			isCancellationRequested: false,
			onCancellationRequested: () => ({ dispose: () => {} }),
		});
	} catch (error) {
		console.log('  requestHandler threw:', error.message);
		failures++;
	}

	const multi = pushes.filter(p => p instanceof ChatResponseMultiDiffPart);
	const parts = new Map();
	for (const part of pushes) {
		const name = part?.constructor?.name ?? typeof part;
		parts.set(name, (parts.get(name) ?? 0) + 1);
	}
	console.log(`  pushed: ${JSON.stringify(Object.fromEntries(parts))}`);
	if (multi.length === 0) {
		console.log('  ❌ NO ChatResponseMultiDiffPart -- dropdown would not appear');
		console.log('  last markdown:');
		for (const line of markdown.slice(-4)) {
			console.log('    ' + String(line).slice(0, 160).replace(/\n/g, '\\n'));
		}
		failures++;
	}
	for (const part of multi) {
		console.log(`  ✅ ChatResponseMultiDiffPart "${part.title}" with ${part.value.length} entr${part.value.length === 1 ? 'y' : 'ies'}:`);
		for (const entry of part.value) {
			const label = String(entry.modifiedUri ?? entry.originalUri ?? entry.goToFileUri).replace('covexcode-diff:', '');
			const counts = entry.added === undefined && entry.removed === undefined
				? '(no counts -- filename only)'
				: `+${entry.added ?? '-'} -${entry.removed ?? '-'}`;
			const both = entry.originalUri && entry.modifiedUri ? 'diff' : 'PLAIN ROW (no diff)';
			console.log(`     - ${label}  ${counts}  [${both}]`);
		}
	}

	history.push({ prompt }, { response: pushes });
}

console.log(`\n=== turns with no dropdown: ${failures} ===`);
process.exit(0);
