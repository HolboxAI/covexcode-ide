/**
 * End-to-end harness: loads the REAL compiled extension bundle, activates it
 * against a stubbed `vscode` module, then invokes the registered chat
 * participant with a real prompt and records every part pushed to the response
 * stream.
 *
 * This exists because the diff feature cannot be checked by reading code: the
 * question is whether a `ChatResponseMultiDiffPart` actually reaches the chat
 * stream at the end of a real agent turn. Only the stream tells you that.
 *
 * Usage:
 *   run-extension-e2e.mjs <extension.js> <workspace-cwd> <prompt>
 *
 * It prints every pushed part and, if a multi-diff part is among them, the
 * files and added/removed counts it carries.
 */

import Module from 'node:module';
import { pathToFileURL } from 'node:url';

const [bundlePath, cwd, prompt] = process.argv.slice(2);
if (!bundlePath || !cwd || !prompt) {
	console.error('usage: run-extension-e2e.mjs <extension.js> <cwd> <prompt>');
	process.exit(2);
}

// ---------------------------------------------------------------- vscode stub
const pushes = [];
const markdown = [];

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

const stream = {
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

let chatHandler;

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

/**
 * Wraps a namespace so any member the extension touches that this harness has
 * not bothered to model resolves to a harmless stub instead of throwing. The
 * explicit members still win, so behaviour that matters (configuration, the
 * registered chat participant, the captured stream) stays under test.
 */
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
	get: (key, fallback) => {
		// The default `auto` permission mode is what the real IDE uses unless the
		// user switched it -- keep it, since it is the mode this feature failed in.
		if (key === 'permissionMode') {
			return 'auto';
		}
		return fallback;
	},
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
		openTextDocument: async () => ({
			uri: Uri.file(cwd),
			getText: () => '',
			positionAt: () => ({}),
		}),
		textDocuments: [],
		fs: {
			readFile: async () => new Uint8Array(),
			writeFile: async () => {},
			stat: async () => ({ type: 1 }),
		},
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
		withProgress: async (_options, task) => task({ report: () => {} }, { isCancellationRequested: false }),
		createOutputChannel: () => ({ appendLine: () => {}, append: () => {}, show: () => {}, dispose: () => {} }),
		createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show: () => {}, hide: () => {}, dispose: () => {} }),
		createWebviewPanel: () => ({ webview: { html: '', onDidReceiveMessage: () => ({ dispose: () => {} }) }, onDidDispose: () => ({ dispose: () => {} }), dispose: () => {} }),
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
		createChatParticipant: () => {
			return {
				dispose: () => {},
				iconPath: undefined,
				requestHandler: undefined,
			};
		},
	},
	authentication: {
		getSession: async () => undefined,
		registerAuthenticationProvider: () => ({ dispose: () => {} }),
		onDidChangeSessions: () => ({ dispose: () => {} }),
	},
	l10n: { t: (message, ...args) => message },
	extensions: { getExtension: () => undefined, all: [] },
	env: {
		openExternal: async () => true,
		clipboard: { writeText: async () => {} },
		appName: 'Covexcode',
		language: 'en',
		uriScheme: 'covexcode',
		machineId: 'test',
	},
	debug: { registerDebugConfigurationProvider: () => ({ dispose: () => {} }) },
	tasks: { registerTaskProvider: () => ({ dispose: () => {} }) },
	languages: {
		registerInlineCompletionItemProvider: () => ({ dispose: () => {} }),
		registerCodeActionsProvider: () => ({ dispose: () => {} }),
	},
	lm: { registerChatParticipantDetectionProvider: () => ({ dispose: () => {} }) },
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

// Wrap the namespaces the extension pokes at so an unmodelled member is a
// no-op rather than a crash.
for (const name of ['workspace', 'window', 'commands', 'chat', 'languages', 'authentication', 'env', 'extensions', 'debug', 'tasks', 'lm']) {
	vscode[name] = withFallback(vscode[name]);
}

// API classes the extension constructs (rather than just calls). Each needs to
// be newable; their methods are never asserted on here.
class SlashCommand {
	constructor(name) {
		this.name = name;
	}
}
for (const name of [
	'RelativePattern', 'CompletionItem', 'CompletionList', 'WorkspaceEdit', 'CodeAction',
	'CodeActionKind', 'SnippetString', 'Selection', 'Location', 'SymbolInformation',
	'DocumentSymbol', 'CallHierarchyItem', 'Diagnostic', 'DiagnosticSeverity',
	'FileSystemError', 'ThemeColor', 'TreeItem', 'ChatResponseTurn2', 'ChatResponseDiffEntry',
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
				Object.assign(this, { args });
			}
		};
	}
}
vscode.SlashCommand = SlashCommand;

// The extension bundle requires 'vscode'; intercept it.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return vscode;
	}
	return originalLoad.apply(this, arguments);
};

// --------------------------------------------------------------- run it
const ext = await import(pathToFileURL(bundlePath).href);

// Capture the participant the extension registers.
let participant;
vscode.chat.createChatParticipant = (id, handler) => {
	participant = { id, handler };
	return { dispose: () => {} };
};

const context = {
	subscriptions: [],
	extensionUri: Uri.file('/tmp/extension'),
	extensionPath: '/tmp/extension',
	globalState: { get: () => undefined, update: async () => {}, keys: () => [] },
	workspaceState: { get: () => undefined, update: async () => {}, keys: () => [] },
	secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
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
	console.log('NO chat participant registered -- cannot drive a turn');
	process.exit(1);
}

const request = {
	prompt,
	command: undefined,
	references: [],
	location: 1,
	toolInvocationToken: undefined,
	mode: undefined,
	sessionId: 'e2e-session',
};

const chatContext = { history: [], yieldRequested: false, chatSessionContext: undefined };

console.log(`driving participant '${participant.id}' with a real agent turn...`);
try {
	await participant.handler(request, chatContext, stream, {
		isCancellationRequested: false,
		onCancellationRequested: () => ({ dispose: () => {} }),
	});
} catch (error) {
	console.log('requestHandler threw:', error.message);
}

console.log(`\n=== pushed parts: ${pushes.length} ===`);
const summary = new Map();
for (const part of pushes) {
	const name = part?.constructor?.name ?? typeof part;
	summary.set(name, (summary.get(name) ?? 0) + 1);
}
console.log(Object.fromEntries(summary));

const multi = pushes.filter(p => p instanceof ChatResponseMultiDiffPart);
console.log(`\n=== ChatResponseMultiDiffPart count: ${multi.length} ===`);
for (const part of multi) {
	console.log(`title: ${part.title}`);
	for (const entry of part.value) {
		console.log(`  file        : ${entry.modifiedUri ?? entry.originalUri ?? entry.goToFileUri}`);
		console.log(`  originalUri : ${entry.originalUri ?? '(none)'}`);
		console.log(`  modifiedUri : ${entry.modifiedUri ?? '(none)'}`);
		console.log(`  added/removed: +${entry.added ?? '-'} -${entry.removed ?? '-'}`);
	}
}
if (multi.length === 0) {
	console.log('\nlast markdown emitted:');
	for (const line of markdown.slice(-6)) {
		console.log('  ' + String(line).slice(0, 200).replace(/\n/g, '\\n'));
	}
}
process.exit(0);
