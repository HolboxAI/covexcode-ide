/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	AcpClient,
	BrowserInteraction,
	CheckInBrowserOutcome,
	CheckInBrowserRequest,
	fetchProviders,
	InteractInBrowserOutcome,
	InteractInBrowserRequest,
	probeAcpSupported,
	probeBinaryExists,
	ProviderDescriptor,
	PromptContentBlock,
	RequestPermissionOutcome,
	RequestPermissionRequest,
	SessionNotification,
	SessionUpdate,
	ToolCallContent,
	ToolCallStatus,
} from './acpClient';
import { CdpClient } from './cdpClient';
import { boxcodeBinaryCandidates } from './boxcodeBinary';
import {
	parsePermissionCommandArgs,
	permissionChoiceFromConfirmation,
	permissionCommandUri,
	permissionConfirmationData,
	permissionOutcomeFromGate,
	PermissionGate,
	PERMISSION_COMMAND,
} from './chatPermission';
import { isFreshChat } from './freshChat';
import { describeBrowserPreview, stripOversizedDataUris } from './chatMarkdown';
import { detectWorkspaceFramework, FRAMEWORK_LABELS, type Framework } from './frameworkDetector';
import {
	missingRecommendedExtensions,
	recommendationPrompt,
	recommendationSkipKey,
} from './frameworkRecommendations';
import { findLocalhostUrl, findReusableBrowserTab, localhostOrigin } from './localhostUrl';
import { describeReferenceValue } from './referenceDescription';
import { describeError, describeStartupFailure, AcpUnsupportedError } from './startupFailure';
import { createTurnUsage, TurnUsage } from './turnUsage';
import {
	describeRestrictedMode,
	folderTrustKey,
	shouldPromptForWorkspaceTrust,
	TRUST_COMMAND,
	TRUST_TOAST_ACTION,
	TRUST_TOAST_MESSAGE,
} from './workspaceTrust';
import {
	prependWorkspacePrefix,
	resolvePathAgainstCwd,
	resolveWorkspaceCwd,
	workspacePromptPrefix,
	type WorkspaceContext,
} from './workspaceContext';

const PARTICIPANT_ID = 'boxcode.agent';
const BOXCODE_COMMAND = 'boxcode';
const SECRET_API_KEY = 'boxcode.apiKey';
const DIFF_SCHEME = 'boxcode-diff';

/** The configured `boxcode.path` setting if set, otherwise the bare command
 * name plus the locations `install.sh` writes to -- an escape hatch for a
 * binary installed somewhere a GUI-launched app's inherited PATH doesn't
 * reach (e.g. `~/.local/bin` on macOS, invisible to a Finder-launched app
 * even though a login shell sees it fine). */
function configuredBoxcodePath(): string {
	return vscode.workspace.getConfiguration('boxcode').get<string>('path', '').trim();
}

/** Thrown by `ensureCredentials` when the user cancels the setup prompt -- distinguished from a real launch failure so the chat message shown for each reads correctly. */
class SetupCancelled extends Error {}

/**
 * A do-nothing `vscode.LanguageModelChat` provider, registered purely to
 * satisfy a check this extension never otherwise touches: VS Code core's
 * `$invokeAgent` (`extHostChatAgents2.ts`) resolves a default language model
 * for *every* chat participant request before calling that participant's
 * handler at all, regardless of whether the handler reads `request.model` --
 * this one never does, since it talks to the `boxcode` CLI directly over
 * ACP. Upstream's own default-resolution only ever picks a model whose
 * vendor is Copilot's (`languageModels.ts`'s `COPILOT_VENDOR_ID`), and
 * Copilot's extension is deleted from this fork, so without *some* model
 * registered under any vendor, every chat request fails before it starts
 * with "Language model unavailable" -- see this repo's own
 * `87-ext-language-model-default-fallback.patch`, which is the other half of
 * this fix: it makes VS Code fall back to the first available model of any
 * vendor when no Copilot one exists, which is what actually lets a request
 * carrying *this* stub through.
 *
 * `provideLanguageModelChatResponse`/`provideTokenCount` are never expected
 * to run -- if they do, some other code path started routing a real request
 * through `request.model` after all, which is worth knowing about loudly
 * rather than silently returning something plausible-looking.
 */
class StubLanguageModelProvider implements vscode.LanguageModelChatProvider {
	provideLanguageModelChatInformation(): vscode.LanguageModelChatInformation[] {
		return [
			{
				id: 'boxcode',
				name: 'boxcode',
				family: 'boxcode',
				version: '1.0.0',
				maxInputTokens: 128_000,
				maxOutputTokens: 8_192,
				capabilities: {},
			},
		];
	}

	provideLanguageModelChatResponse(): never {
		throw new Error('StubLanguageModelProvider was invoked for a real request -- boxcode.agent should never route through request.model.');
	}

	provideTokenCount(): never {
		throw new Error('StubLanguageModelProvider was invoked for a real request -- boxcode.agent should never route through request.model.');
	}
}

/**
 * The minimal-path wiring recorded in boxcode-ide's own `docs/BACKLOG.md`:
 * rather than implementing the full `IAgent` interface the real agentHost
 * backends (`ClaudeAgent`, `CodexAgent`) use -- 1000-2500 lines each,
 * session persistence and turn-history reconstruction included, and both
 * already deleted from this fork by `patches/52-ext-copilot-remove-it.json`
 * -- this registers `boxcode --acp` as an ordinary chat participant via the
 * stable `vscode.chat` API, the same extension surface any third-party AI
 * chat extension uses. `isDefault: true` in this extension's own
 * `package.json` (gated by the `defaultChatParticipant` proposed API,
 * enabled there) is what lets a plain, unmentioned prompt on the chat-first
 * landing page reach this participant at all -- with Copilot's own
 * `isDefault` contribution removed along with the rest of that extension,
 * nothing else claims that slot in this fork.
 *
 * One `AcpClient` (one subprocess, one ACP session) is shared across every
 * turn for the life of this extension host, not recreated per chat message
 * -- `HeadlessSession` on the other end already keeps its own conversation
 * history across `session/prompt` calls, so reusing one session here is
 * what lets that continuity actually work.
 *
 * Known limitation, stated rather than hidden: VS Code's own "New Chat"
 * action used to keep the same `boxcode` ACP session -- every turn in this
 * window shared the one session opened on the first message. An empty
 * `ChatContext.history` now disposes that session before `ensureReady`, so
 * "New Chat" actually starts fresh. Follow-up turns in the same thread keep
 * the session because their history is non-empty.
 *
 * First-run configuration: a fresh install has no `~/.boxcode/config.toml`
 * and no `boxcode.endpoint`/`boxcode.model` settings, so the very first
 * message would otherwise fail with a raw connection error (`headless.rs`
 * now fails fast on a missing API key specifically, but has no equivalent
 * for a missing endpoint/model, and no way to *collect* any of the three
 * from inside a headless subprocess either way). `ensureCredentials` below
 * prompts once, storing the endpoint/model as ordinary settings and the API
 * key in `SecretStorage` (never plain settings.json), and is skipped
 * entirely when `~/.boxcode/config.toml` already exists -- someone who's
 * already configured `boxcode` from the CLI must not be nagged to repeat
 * that inside the IDE.
 */
export function activate(context: vscode.ExtensionContext): void {
	let client: AcpClient | undefined;
	let sessionId: string | undefined;
	let ready: Promise<void> | undefined;
	// Last cwd handed to `session/new`. Compared at the start of each turn
	// so File > Open Folder (or switching roots in a multi-root window)
	// actually starts a new ACP session instead of keeping the one spawned
	// against `$HOME` on the chat-first landing page.
	let sessionCwd: string | undefined;
	const permissionGate = new PermissionGate();
	const promptedTrustFolders = new Set<string>();
	// Persists for the life of the extension host, not just one turn -- a
	// dev server started earlier in the conversation is still running, and
	// re-popping the browser open every time its URL appears again in later
	// command output (e.g. a second `curl` check) would be exactly the kind
	// of over-eager behavior the auto-open feature needs to avoid. See
	// renderUpdate's own doc comment on this whole mechanism.
	const openedDevServerUrls = new Set<string>();

	const diffContentProvider = new DiffContentProvider();
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffContentProvider),
	);
	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('boxcode', new StubLanguageModelProvider()),
	);

	// Detected once per cwd and reused by both the status-bar badge and the
	// agent's hidden context, so the two can't disagree about what framework
	// the workspace is and we don't re-read package.json every turn.
	// Invalidated when package.json changes -- a cache that never expires
	// would keep showing React after the user added `next`.
	const frameworkCache = new Map<string, Framework | undefined>();
	const frameworkFor = async (cwd: string): Promise<Framework | undefined> => {
		if (!frameworkCache.has(cwd)) {
			frameworkCache.set(cwd, await detectWorkspaceFramework(cwd));
		}
		return frameworkCache.get(cwd);
	};

	const frameworkIndicator = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	frameworkIndicator.name = 'boxcode: framework';
	context.subscriptions.push(frameworkIndicator);
	const updateFrameworkIndicator = async (workspace: WorkspaceContext): Promise<void> => {
		const framework = workspace.hasFolder ? await frameworkFor(workspace.cwd) : undefined;
		if (framework) {
			const label = FRAMEWORK_LABELS[framework];
			frameworkIndicator.text = `$(package) ${label}`;
			frameworkIndicator.tooltip = `boxcode detected ${label}`;
			frameworkIndicator.show();
		} else {
			frameworkIndicator.hide();
		}
	};

	const RECS_SKIP_STATE = 'boxcode.frameworkRecommendationSkips';
	const INSTALL_RECS_ACTION = 'Install';
	const LATER_RECS_ACTION = 'Later';

	async function promptFrameworkRecommendations(workspace: WorkspaceContext): Promise<void> {
		if (!workspace.hasFolder) {
			return;
		}
		const framework = await frameworkFor(workspace.cwd);
		if (!framework) {
			return;
		}
		const skipKey = recommendationSkipKey(workspace.cwd, framework);
		const skipped = context.workspaceState.get<string[]>(RECS_SKIP_STATE, []);
		if (skipped.includes(skipKey)) {
			return;
		}
		const installed = vscode.extensions.all.map(ext => ext.id);
		const missing = missingRecommendedExtensions(installed, framework);
		if (missing.length === 0) {
			return;
		}
		const choice = await vscode.window.showInformationMessage(
			recommendationPrompt(framework, missing),
			INSTALL_RECS_ACTION,
			LATER_RECS_ACTION,
		);
		if (choice !== INSTALL_RECS_ACTION) {
			await context.workspaceState.update(RECS_SKIP_STATE, [...skipped, skipKey]);
			return;
		}
		for (const id of missing) {
			try {
				await vscode.commands.executeCommand('workbench.extensions.installExtension', id);
			} catch {
				// Gallery miss or the user cancelled one id -- keep going.
			}
		}
		await context.workspaceState.update(RECS_SKIP_STATE, [...skipped, skipKey]);
	}

	async function refreshFrameworkSurfaces(invalidate = false): Promise<void> {
		const workspace = currentWorkspace();
		if (invalidate && workspace.hasFolder) {
			frameworkCache.delete(workspace.cwd);
		}
		await updateFrameworkIndicator(workspace);
		await promptFrameworkRecommendations(workspace);
	}

	let packageJsonWatchers: vscode.Disposable[] = [];
	function watchPackageJsonFiles(): void {
		for (const watcher of packageJsonWatchers) {
			watcher.dispose();
		}
		packageJsonWatchers = [];
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(folder, 'package.json'),
			);
			const onPackageJson = () => {
				frameworkCache.delete(folder.uri.fsPath);
				void refreshFrameworkSurfaces();
			};
			watcher.onDidChange(onPackageJson);
			watcher.onDidCreate(onPackageJson);
			watcher.onDidDelete(onPackageJson);
			packageJsonWatchers.push(watcher);
		}
	}

	function currentWorkspace(): WorkspaceContext {
		const folders = vscode.workspace.workspaceFolders?.map(folder => ({ fsPath: folder.uri.fsPath }));
		const activeUri = vscode.window.activeTextEditor?.document.uri;
		const activeFilePath = activeUri?.scheme === 'file' ? activeUri.fsPath : undefined;
		return resolveWorkspaceCwd(folders, activeFilePath, os.homedir());
	}

	function discardSession(): void {
		permissionGate.cancelAll();
		client?.dispose();
		client = undefined;
		sessionId = undefined;
		ready = undefined;
		sessionCwd = undefined;
	}

	async function requestFolderTrust(): Promise<void> {
		const requestTrust = (vscode.workspace as { requestWorkspaceTrust?: (options?: { message?: string }) => Thenable<boolean | undefined> }).requestWorkspaceTrust;
		if (typeof requestTrust === 'function') {
			await requestTrust({
				message: 'boxcode needs trust to read, write, and run commands in this folder.',
			});
			return;
		}
		await vscode.commands.executeCommand('workbench.trust.manage');
	}

	/**
	 * Chat-first is a trusted empty window. Opening a folder does not
	 * always show VS Code's own startup trust prompt, so Restricted Mode
	 * used to arrive silently and disable the agent. Ask immediately,
	 * with a non-modal toast -- not a center-screen system dialog -- and
	 * only once per folder set.
	 */
	async function promptTrustIfNeeded(): Promise<void> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (!shouldPromptForWorkspaceTrust(vscode.workspace.isTrusted, folders.length)) {
			return;
		}
		const key = folderTrustKey(folders.map(folder => folder.uri.toString()));
		if (promptedTrustFolders.has(key)) {
			return;
		}
		promptedTrustFolders.add(key);
		const choice = await vscode.window.showInformationMessage(TRUST_TOAST_MESSAGE, TRUST_TOAST_ACTION);
		if (choice === TRUST_TOAST_ACTION) {
			await requestFolderTrust();
		}
	}

	function ensureReady(workspace: WorkspaceContext): Promise<void> {
		if (!ready) {
			ready = (async () => {
				const candidates = boxcodeBinaryCandidates(configuredBoxcodePath(), os.homedir());
				let boxcodeCommand: string | undefined;
				for (const candidate of candidates) {
					if (await probeBinaryExists(candidate)) {
						boxcodeCommand = candidate;
						break;
					}
				}
				// Checked before ensureCredentials() runs at all -- a fresh
				// install with no `boxcode` CLI used to walk through three
				// credential prompts before ever learning the binary itself
				// was missing. Thrown with `code: 'ENOENT'` so it lands on
				// the exact branch `describeStartupFailure` already handles.
				if (!boxcodeCommand) {
					const notFound = new Error(`spawn ${candidates[0] ?? BOXCODE_COMMAND} ENOENT`) as NodeJS.ErrnoException;
					notFound.code = 'ENOENT';
					throw notFound;
				}
				if (!(await probeAcpSupported(boxcodeCommand))) {
					throw new AcpUnsupportedError();
				}
				const cwd = workspace.cwd;
				const envOverrides = await ensureCredentials(context, boxcodeCommand);
				const acp = new AcpClient(boxcodeCommand, cwd, envOverrides);
				client = acp;
				// A crash mid-session must not leave the participant dead until
				// the window reloads. AcpClient already emits 'exit' when the
				// subprocess dies; tear the session down so the next message
				// re-launches (ensureReady re-runs because `ready` is cleared).
				acp.on('exit', () => discardSession());
				await acp.initialize();
				sessionId = await acp.newSession(cwd);
				sessionCwd = cwd;
			})().catch(error => {
				// A failed launch must not wedge every later message behind
				// the same rejected promise forever -- clear the memoized
				// attempt so the next chat message gets a fresh try, not a
				// permanently broken participant until the window reloads.
				ready = undefined;
				client = undefined;
				sessionCwd = undefined;
				throw error;
			});
		}
		return ready;
	}

	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			discardSession();
			watchPackageJsonFiles();
			void promptTrustIfNeeded();
			void refreshFrameworkSurfaces(true);
		}),
		vscode.commands.registerCommand(PERMISSION_COMMAND, (...args: unknown[]) => {
			const parsed = parsePermissionCommandArgs(args);
			if (!parsed) {
				return;
			}
			permissionGate.respond(parsed.id, parsed.choice);
		}),
		vscode.commands.registerCommand(TRUST_COMMAND, async () => {
			await requestFolderTrust();
		}),
		vscode.workspace.onDidGrantWorkspaceTrust(() => {
			void vscode.commands.executeCommand('workbench.action.chat.open');
			void vscode.window.showInformationMessage('This folder is trusted. Chat can read, write, and run here now.');
		}),
		{ dispose: () => {
			for (const watcher of packageJsonWatchers) {
				watcher.dispose();
			}
		} },
	);
	watchPackageJsonFiles();
	void promptTrustIfNeeded();
	// The badge used to refresh only on folder change, so a window that
	// launched already inside a project never showed it.
	void refreshFrameworkSurfaces();

	const requestHandler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
		// A confirmation-card click is a new ChatRequest, not a new turn.
		// Resolve the in-flight ACP waiter and return -- starting another
		// `session/prompt` here would interleave two agent turns.
		const confirmation = permissionChoiceFromConfirmation(
			request.acceptedConfirmationData,
			request.rejectedConfirmationData,
		);
		if (confirmation) {
			permissionGate.respond(confirmation.id, confirmation.choice);
			return;
		}
		if (!vscode.workspace.isTrusted) {
			stream.markdown(restrictedModeMarkdown());
			return;
		}
		if (isFreshChat(chatContext.history.length) && client) {
			// VS Code's "New Chat" reuses this extension host, so without
			// this the next empty-history request would keep talking to the
			// previous HeadlessSession -- every "new chat" was the same
			// conversation on the daemon side.
			discardSession();
		}
		const workspace = currentWorkspace();
		// Attach the detected framework so workspacePromptPrefix() hides the
		// stack in the model's own context (see that function's comment on the
		// framework line). Memoized per cwd by frameworkFor() above, so this is
		// one package.json read per workspace, not per turn.
		const workspaceWithFramework = { ...workspace, framework: await frameworkFor(workspace.cwd) };
		if (sessionCwd !== undefined && sessionCwd !== workspace.cwd) {
			discardSession();
		}
		try {
			await ensureReady(workspace);
		} catch (error) {
			if (error instanceof SetupCancelled) {
				stream.markdown('Configuration needed -- send another message when you\'re ready to set boxcode up.');
			} else {
				stream.markdown(describeStartupFailure(error, process.platform));
			}
			return;
		}
		if (!client || !sessionId) {
			stream.markdown("boxcode isn't ready yet -- try again in a moment.");
			return;
		}
		if (!workspace.hasFolder) {
			stream.markdown(
				'No folder is open in this window, so I don\'t have a project working directory. ' +
					'Use **File > Open Folder**, then send your message again if you want me to work in a project.\n\n',
			);
		}
		const activeClient = client;
		const activeSessionId = sessionId;
		// `tool_call_update`'s own `title` is usually absent (headless.rs
		// only sets it on the initial `tool_call`) -- without remembering
		// it here, the completion/failure line renderUpdate shows would
		// have no label at all. Scoped to one turn, not the whole session:
		// a fresh Map per requestHandler call, same lifetime as `stream`.
		const toolCallTitles = new Map<string, string>();
		const shownBrowserPreviews = new Set<string>();
		const turnUsage = createTurnUsage();

		const onUpdate = (notification: SessionNotification) => {
			if (notification.sessionId === activeSessionId) {
				renderUpdate(notification.update, stream, toolCallTitles, openedDevServerUrls, shownBrowserPreviews, turnUsage);
			}
		};
		const onPermissionRequest = (
			permissionRequest: RequestPermissionRequest,
			respond: (outcome: RequestPermissionOutcome) => void,
		) => {
			if (permissionRequest.sessionId === activeSessionId) {
				void askPermission(permissionRequest, diffContentProvider, stream, permissionGate, workspace.cwd).then(respond);
			} else {
				respond({ outcome: 'cancelled' });
			}
		};
		const onBrowserCheckRequest = (
			browserRequest: CheckInBrowserRequest,
			respond: (outcome: CheckInBrowserOutcome) => void,
		) => {
			if (browserRequest.sessionId === activeSessionId) {
				void checkInBrowser(browserRequest.url).then(respond);
			} else {
				respond({ outcome: 'failed', reason: 'browser check arrived for a different session' });
			}
		};
		const onBrowserInteractRequest = (
			interactRequest: InteractInBrowserRequest,
			respond: (outcome: InteractInBrowserOutcome) => void,
		) => {
			if (interactRequest.sessionId === activeSessionId) {
				void interactInBrowser(interactRequest.url, interactRequest.interaction).then(respond);
			} else {
				respond({ outcome: 'failed', reason: 'browser interaction arrived for a different session' });
			}
		};

		activeClient.on('update', onUpdate);
		activeClient.on('permissionRequest', onPermissionRequest);
		activeClient.on('browserCheckRequest', onBrowserCheckRequest);
		activeClient.on('browserInteractRequest', onBrowserInteractRequest);
		// v1 has no cancellation plumbing into HeadlessSession yet -- see
		// boxcode's own transport.rs docs on `session/cancel`. A cancelled
		// request here still waits for the in-flight turn to finish rather
		// than abandoning it silently.
		const onCancel = token.onCancellationRequested(() => {
			permissionGate.cancelAll();
		});
		const content = await attachReferencesToPrompt(request, workspaceWithFramework);
		try {
			await activeClient.prompt(activeSessionId, content);
			// Rendered only on a clean turn end, never after an error -- a
			// failed turn's partial usage would be a misleading number. One
			// line regardless of how many `usage_update`s arrived, since a
			// multi-response turn emits one per LLM response.
			const footnote = turnUsage.footnote();
			if (footnote) {
				stream.markdown(`\n\n*${footnote}*\n`);
			}
		} catch (error) {
			stream.markdown(`boxcode stopped responding: ${describeError(error)}`);
		} finally {
			activeClient.off('update', onUpdate);
			activeClient.off('permissionRequest', onPermissionRequest);
			activeClient.off('browserCheckRequest', onBrowserCheckRequest);
			activeClient.off('browserInteractRequest', onBrowserInteractRequest);
			onCancel.dispose();
		}
	};

	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, requestHandler);
	context.subscriptions.push(participant);
	context.subscriptions.push({ dispose: () => discardSession() });

	context.subscriptions.push(
		vscode.commands.registerCommand('boxcode.rollback', async () => {
			// Reads client/sessionId fresh on each invocation, not a value
			// captured at registration time -- both are only set once the
			// first chat message actually establishes a session.
			if (!client || !sessionId) {
				void vscode.window.showInformationMessage("boxcode: no session yet -- send a message first.");
				return;
			}
			const activeClient = client;
			const activeSessionId = sessionId;
			// Same posture as the TUI's own /rollback: confirm before
			// touching disk, not after.
			const choice = await vscode.window.showWarningMessage(
				'Undo every file boxcode has written this session? Files it only ran commands ' +
					'against, not wrote, are not covered by this.',
				{ modal: true },
				'Undo',
			);
			if (choice !== 'Undo') {
				return;
			}
			try {
				const summary = await activeClient.rollback(activeSessionId);
				void vscode.window.showInformationMessage(`boxcode: ${summary}`);
			} catch (error) {
				void vscode.window.showErrorMessage(`boxcode: couldn't roll back (${describeError(error)})`);
			}
		}),
	);

	context.subscriptions.push(
		// Closes a real gap: before this, a mistyped API key (or a switch to
		// a different provider) had no in-product fix -- `ensureCredentials`
		// only re-prompts when a value is *missing*, never when it's wrong,
		// so the only recovery was hand-editing settings.json and clearing
		// SecretStorage by hand.
		vscode.commands.registerCommand('boxcode.changeProvider', async () => {
			await context.secrets.delete(SECRET_API_KEY);
			const config = vscode.workspace.getConfiguration('boxcode');
			await config.update('provider', undefined, vscode.ConfigurationTarget.Global);
			await config.update('endpoint', undefined, vscode.ConfigurationTarget.Global);
			await config.update('model', undefined, vscode.ConfigurationTarget.Global);
			// The next chat message must spawn a fresh session against the
			// new credentials, not reuse a client already running with the
			// old ones -- `ensureReady`'s own memoization exists precisely
			// to avoid a second spawn per turn, so it has to be cleared
			// explicitly here rather than just waiting for it to notice.
			discardSession();
			void vscode.window.showInformationMessage(
				'boxcode: cleared. Send a chat message to pick a new provider, model, and API key.',
			);
		}),
	);
}

/**
 * Folds `request.references` -- context attached via the Integrated
 * Browser's own element-picker, console-log-to-chat, and screenshot
 * features (`browserEditorChatFeatures.ts`, upstream and unpatched in this
 * fork) -- into the content blocks `AcpClient.prompt` actually sends.
 * boxcode never had to build any of the attachment UI itself: clicking an
 * element or attaching console logs already lands here as an ordinary
 * `ChatPromptReference`, the same mechanism any chat participant gets, once
 * `boxcode.agent` is the active default agent (see `ChatContextKeys.enabled`
 * in VS Code's own `chatAgents.ts` -- it only needs *some* default agent
 * active, not anything browser-specific).
 *
 * Image attachments (element screenshots) are real `ContentBlock::Image`
 * blocks now, not dropped -- `ChatReferenceBinaryData.data()` is async
 * (returns the bytes as a `Thenable<Uint8Array>`), which is the whole
 * reason this function itself is `async`. A `Location` reference (e.g. a
 * console-log's source position) is stringified by hand rather than via a
 * bare `String(...)`, which on a `Location` object yields the useless
 * `"[object Object]"` -- `vscode.d.ts`'s own type for `.value` is
 * `string | Uri | Location | unknown`, so those are the two known non-string
 * shapes actually worth special-casing.
 */
async function attachReferencesToPrompt(request: vscode.ChatRequest, workspace: WorkspaceContext): Promise<PromptContentBlock[]> {
	const sections: string[] = [];
	const images: PromptContentBlock[] = [];

	for (const reference of request.references) {
		if (reference.value instanceof vscode.ChatReferenceBinaryData) {
			const bytes = await reference.value.data();
			images.push({
				type: 'image',
				data: Buffer.from(bytes).toString('base64'),
				mimeType: reference.value.mimeType,
			});
			continue;
		}
		const heading = reference.modelDescription ?? reference.id;
		const body = describeReferenceValue(reference.value);
		sections.push(`### Attached: ${heading}\n\n${body}`);
	}

	const userText = sections.length > 0 ? `${sections.join('\n\n')}\n\n${request.prompt}` : request.prompt;
	const text = prependWorkspacePrefix(userText, workspacePromptPrefix(workspace));
	return [{ type: 'text', text }, ...images];
}

function restrictedModeMarkdown(): vscode.MarkdownString {
	const line = new vscode.MarkdownString(undefined, true);
	line.isTrusted = { enabledCommands: [TRUST_COMMAND] };
	line.appendMarkdown(`${describeRestrictedMode()}\n\n`);
	line.appendMarkdown(`[$(shield) Trust this folder](command:${TRUST_COMMAND})\n\n`);
	return line;
}

/**
 * A codicon per `ToolCallStatus`, matching the pattern VS Code's own
 * built-in chat participants already use for tool-call rendering (a
 * spinning icon that becomes a check or an error, not plain text) --
 * `stream.markdown` renders `$(name)` codicon syntax natively as long as
 * the `MarkdownString` passed to it has `supportThemeIcons` set, which
 * `stream.markdown(someString)` alone does not (see the call site below).
 */
function toolCallStatusIcon(status: ToolCallStatus | undefined): string {
	switch (status) {
		case 'pending':
			return '$(circle-outline)';
		case 'in_progress':
			return '$(loading~spin)';
		case 'completed':
			return '$(check)';
		case 'failed':
			return '$(error)';
		default:
			return '$(circle-outline)';
	}
}

/**
 * Appends a tool-call title, working around a real gap in `appendText()`'s
 * own escaping rather than a hypothetical one -- confirmed live in a built
 * dmg, not just reasoned about, and confirmed again here against the real
 * bundled `marked` + KaTeX extension (`src/vs/base/common/marked/marked.js`,
 * `markedKatexExtension.ts`), not just by re-reading the code a second time.
 *
 * A command's title starts with a literal "$ " (`tools.rs`'s
 * `Action::label`); `appendText()`'s escaping calls `escapeIcons()`, which
 * only escapes text shaped like `$(word)` (protecting prose that happens to
 * mention a real icon), never a bare "$" with no parens after it. That "$ "
 * sails through unescaped, lands right after this icon's own "$(...)"
 * syntax, and the chat renderer's KaTeX math support reads everything
 * between the two "$"s as inline math -- silently swallowing the icon and
 * however much of the title comes before the next "$", which is exactly the
 * "$ " itself.
 *
 * A first attempt at fixing this wrapped a `$`-containing title in an inline
 * code span instead, on the theory that code spans are tokenized before any
 * later inline rule gets to look inside them -- verified false by actually
 * running the real tokenizer: `marked`'s inline-token loop tries registered
 * extensions (including the KaTeX one) *before* its own code-span rule, so
 * the backtick fence is just an ordinary character to the math regex, and
 * the span never exists. It also leaked a stray backtick into the next
 * markdown link. Left as a cautionary comment, not a second version to
 * maintain: the actual fix is to escape the character `appendText()` misses,
 * not to route around its escaping with a different construct.
 *
 * `escapeMarkdownSyntaxTokens`'s own character class (`\`*_{}[]()#+!~`, see
 * `htmlContent.ts`) never included `$` -- there was never a supported way to
 * ask `appendText()` to do this for us. This runs the real `appendText()`
 * first (for everything it already escapes correctly) via a throwaway
 * `MarkdownString`, then escapes the one remaining gap by hand.
 */
function appendTitleSafely(line: vscode.MarkdownString, title: string): void {
	const escaped = new vscode.MarkdownString(undefined, true);
	escaped.appendText(title);
	line.appendMarkdown(escaped.value.replace(/\$/g, '\\$&'));
}

/**
 * Auto-opens the Integrated Browser the moment a shell command's own output
 * mentions a dev server it just started (a "Local: http://localhost:5173/"
 * line, the same shape `npm run dev`/`vite`/`python3 -m http.server` all
 * print) -- without the model needing to decide to call `check_in_browser`
 * first. Cursor's own equivalent (`autoOpenLocalhostUrls`) does the same
 * thing for exactly the same reason: a human watching an agent scaffold a
 * project expects to *see* it the moment it's running, not only once the
 * model separately decides that's worth doing.
 *
 * Scoped deliberately narrow to avoid the false-positive class this could
 * otherwise cause:
 * - Only from a shell command's (`run_command`, title `"$ ..."`) own
 *   *plain-text* output (`ToolCallContent`'s `content` variant) -- never
 *   from a file read/write, whose content could just as easily be a URL
 *   *string* the code happens to contain (a comment, a config value)
 *   rather than a server this session actually started.
 * - `findLocalhostUrl` itself only ever matches `localhost`/`127.0.0.1`/
 *   `0.0.0.0` (see that module's own doc comment) -- never a real,
 *   non-local URL a command's output might mention (a deploy target, a
 *   README link, a curl target).
 * - Each URL only triggers this once per extension-host lifetime
 *   (`openedDevServerUrls`), not once per line of matching output -- a dev
 *   server's own log output often repeats its own "Local:" URL, and
 *   `ensureBrowserTab` reuses the Integrated Browser pane rather than
 *   opening a second one, but there's no reason to redo that work every
 *   time the server reprints its Local: line.
 * - Fire-and-forget, failure swallowed: this is a convenience layered on
 *   top of whatever the command's own result already is, never something
 *   that should turn a successful command into a failed turn.
 */
function autoOpenDevServerUrl(update: SessionUpdate, title: string | undefined, openedDevServerUrls: Set<string>): void {
	if (update.content?.type !== 'content' || !title?.startsWith('$ ')) {
		return;
	}
	const url = findLocalhostUrl(update.content.text);
	if (!url || openedDevServerUrls.has(url)) {
		return;
	}
	openedDevServerUrls.add(url);
	// Reveal only. `checkInBrowser` used to run here too, which opened a
	// second editor group beside the one `LocalhostLinkOpenerContribution`
	// already created from the same terminal "Local:" line.
	void ensureBrowserTab(url);
}

function renderUpdate(
	update: SessionUpdate,
	stream: vscode.ChatResponseStream,
	toolCallTitles: Map<string, string>,
	openedDevServerUrls: Set<string>,
	shownBrowserPreviews: Set<string>,
	turnUsage: TurnUsage,
): void {
	switch (update.sessionUpdate) {
		case 'agent_message_chunk': {
			const content = update.content;
			if (content?.type === 'text') {
				stream.markdown(stripOversizedDataUris(content.text));
			}
			break;
		}
		case 'tool_call':
		case 'tool_call_update': {
			if (update.toolCallId && update.title) {
				toolCallTitles.set(update.toolCallId, update.title);
			}
			const title = update.title ?? (update.toolCallId ? toolCallTitles.get(update.toolCallId) : undefined);
			if (title) {
				// appendText(), not raw interpolation: a tool title is
				// arbitrary text boxcode chose (a shell command, a file
				// path), never something safe to splice into markdown
				// source. This alone turned out not to be enough for one
				// specific case -- see appendTitleSafely's own doc comment.
				const line = new vscode.MarkdownString(undefined, true);
				line.appendMarkdown(`${toolCallStatusIcon(update.status)} `);
				appendTitleSafely(line, title);
				line.appendMarkdown('\n\n');
				stream.markdown(line);
			}
			// check_in_browser's screenshot is for the model (ACP image
			// block). Putting it in chat as a data URI used to flood the
			// panel with raw base64 -- the renderer does not treat a
			// hundreds-of-KB data URI as an image. The live page is already
			// in the Integrated Browser; tell the human that once per tool.
			if (update.content?.type === 'image') {
				const previewKey = update.toolCallId ?? 'browser-preview';
				if (!shownBrowserPreviews.has(previewKey)) {
					shownBrowserPreviews.add(previewKey);
					const line = new vscode.MarkdownString(undefined, true);
					line.appendMarkdown(`$(globe) ${describeBrowserPreview()}\n\n`);
					stream.markdown(line);
				}
			}
			autoOpenDevServerUrl(update, title, openedDevServerUrls);
			break;
		}
		case 'usage_update':
			// Consumed, not rendered: one footnote at end of turn (see
			// createTurnUsage) rather than a line per update, because a
			// multi-response turn would otherwise print several counts
			// mid-stream.
			turnUsage.record(update);
			break;
		default:
			// Every other legal ACP v1 variant boxcode doesn't emit yet --
			// see protocol.rs's own doc comment on SessionUpdate. Nothing to
			// render, not an error.
			break;
	}
}

interface SetupResult {
	/** Registry id from `providers.rs` (e.g. "deepseek"), or '' for a
	 * manually-entered custom endpoint -- same meaning as `LlmConfig.provider`
	 * on the Rust side, see that field's own doc comment on why it matters
	 * (it's what makes a provider's `default_temperature()` apply). */
	provider: string;
	endpoint: string;
	model: string;
	apiKey: string;
}

/**
 * Resolves the env-var overrides to hand `boxcode --acp` (see
 * `AcpClient`'s own doc comment on why these are additive, never blanking):
 * whatever this extension already has stored (settings + `SecretStorage`)
 * is used as-is; if nothing is stored yet AND `~/.boxcode/config.toml`
 * doesn't exist either (the file-existence check is a deliberately simple
 * proxy for "has this person configured boxcode from the CLI before" --
 * no need to actually parse the TOML just to decide whether to prompt),
 * this runs a one-time setup prompt and persists the result. Throws
 * `SetupCancelled` if the user backs out of that prompt.
 */
async function ensureCredentials(context: vscode.ExtensionContext, boxcodeCommand: string): Promise<NodeJS.ProcessEnv> {
	const config = vscode.workspace.getConfiguration('boxcode');
	let provider = config.get<string>('provider', '');
	let endpoint = config.get<string>('endpoint', '');
	let model = config.get<string>('model', '');
	let apiKey = (await context.secrets.get(SECRET_API_KEY)) ?? '';

	if ((!endpoint || !model || !apiKey) && !configTomlExists()) {
		const entered = await runSetupFlow(boxcodeCommand);
		if (!entered) {
			throw new SetupCancelled('boxcode setup was cancelled');
		}
		provider = entered.provider;
		endpoint = entered.endpoint;
		model = entered.model;
		apiKey = entered.apiKey;
		await config.update('provider', provider, vscode.ConfigurationTarget.Global);
		await config.update('endpoint', endpoint, vscode.ConfigurationTarget.Global);
		await config.update('model', model, vscode.ConfigurationTarget.Global);
		await context.secrets.store(SECRET_API_KEY, apiKey);
	}

	const overrides: NodeJS.ProcessEnv = {};
	if (provider) {
		overrides.BOXCODE_PROVIDER = provider;
	}
	if (endpoint) {
		overrides.BOXCODE_ENDPOINT = endpoint;
	}
	if (model) {
		overrides.BOXCODE_MODEL = model;
	}
	if (apiKey) {
		overrides.BOXCODE_API_KEY = apiKey;
	}
	return overrides;
}

function configTomlExists(): boolean {
	try {
		return fs.existsSync(path.join(os.homedir(), '.boxcode', 'config.toml'));
	} catch {
		return false;
	}
}

/** Mirrors `providers.rs`'s `env_var_name()` exactly -- "deepseek" ->
 * "DEEPSEEK_API_KEY" -- so a key a user already has exported for a
 * provider's own conventional env var is picked up here without asking
 * again, the same way `/provider` in the TUI does. */
function providerEnvVarName(providerId: string): string {
	return `${providerId.toUpperCase()}_API_KEY`;
}

const CUSTOM_ENDPOINT_ITEM = 'Custom endpoint…';

/**
 * Provider -> model -> API key, mirroring the TUI's own `/provider` overlay
 * flow (`ProviderPicker`/`ModelPicker`/`ApiKeyPrompt` in `app.rs`) instead
 * of asking for a raw endpoint URL -- see this function's own git history
 * for why: a real tester hit the old three-bare-textbox version and asked
 * "why do you need an endpoint? it should be pick a provider and model and
 * enter an API key," which is exactly what the TUI already had.
 *
 * Falls back to the old raw endpoint/model/key flow (renamed
 * `runCustomEndpointFlow` below) both for "Custom endpoint…" and, silently,
 * if `boxcode --providers-json` fails for any reason -- an older `boxcode`
 * binary predating this flag must still be onboardable, not just a binary
 * that doesn't exist at all (that case is `probeBinaryExists`'s, checked
 * before this ever runs).
 */
async function runSetupFlow(boxcodeCommand: string): Promise<SetupResult | undefined> {
	let providers: ProviderDescriptor[];
	try {
		providers = await fetchProviders(boxcodeCommand);
	} catch {
		const custom = await runCustomEndpointFlow('boxcode setup');
		return custom && { provider: '', ...custom };
	}
	if (providers.length === 0) {
		const custom = await runCustomEndpointFlow('boxcode setup');
		return custom && { provider: '', ...custom };
	}

	const providerPick = await vscode.window.showQuickPick(
		[...providers.map(p => p.label), CUSTOM_ENDPOINT_ITEM],
		{
			title: 'boxcode setup (1/3) -- pick a provider',
			ignoreFocusOut: true,
		},
	);
	if (!providerPick) {
		return undefined;
	}
	if (providerPick === CUSTOM_ENDPOINT_ITEM) {
		const custom = await runCustomEndpointFlow('boxcode setup (custom endpoint)');
		return custom && { provider: '', ...custom };
	}
	const provider = providers.find(p => p.label === providerPick);
	if (!provider) {
		return undefined;
	}

	const model = await vscode.window.showQuickPick(provider.models, {
		title: `boxcode setup (2/3) -- pick a model for ${provider.label}`,
		ignoreFocusOut: true,
	});
	if (!model) {
		return undefined;
	}

	const envName = providerEnvVarName(provider.id);
	const envKey = process.env[envName]?.trim();
	if (envKey) {
		return { provider: provider.id, endpoint: provider.endpoint, model, apiKey: envKey };
	}

	const apiKey = await vscode.window.showInputBox({
		title: `boxcode setup (3/3) -- API key for ${provider.label}`,
		prompt: `API key for ${provider.label} -- stored securely, never written to settings.json. ` +
			`Tip: export ${envName} in your shell and this step is skipped next time.`,
		password: true,
		ignoreFocusOut: true,
		validateInput: value => (value.trim() ? undefined : 'An API key is required.'),
	});
	if (!apiKey) {
		return undefined;
	}

	return { provider: provider.id, endpoint: provider.endpoint, model, apiKey: apiKey.trim() };
}

/** The original raw endpoint/model/key flow -- kept as the escape hatch for
 * "Custom endpoint…" and as a fallback for a `boxcode` binary too old to
 * support `--providers-json`. `titlePrefix` lets callers distinguish "the
 * whole setup is a custom endpoint" from "the picker itself fell back". */
async function runCustomEndpointFlow(
	titlePrefix: string,
): Promise<{ endpoint: string; model: string; apiKey: string } | undefined> {
	const endpoint = await vscode.window.showInputBox({
		title: `${titlePrefix} (1/3)`,
		prompt: "boxcode's LLM endpoint -- an OpenAI-compatible base URL",
		placeHolder: 'https://api.deepseek.com',
		ignoreFocusOut: true,
		validateInput: value => (value.trim() ? undefined : 'An endpoint is required.'),
	});
	if (!endpoint) {
		return undefined;
	}

	const model = await vscode.window.showInputBox({
		title: `${titlePrefix} (2/3)`,
		prompt: 'Model name to request from that endpoint',
		ignoreFocusOut: true,
		validateInput: value => (value.trim() ? undefined : 'A model name is required.'),
	});
	if (!model) {
		return undefined;
	}

	const apiKey = await vscode.window.showInputBox({
		title: `${titlePrefix} (3/3)`,
		prompt: 'API key for that endpoint -- stored securely, never written to settings.json',
		password: true,
		ignoreFocusOut: true,
		validateInput: value => (value.trim() ? undefined : 'An API key is required.'),
	});
	if (!apiKey) {
		return undefined;
	}

	return { endpoint: endpoint.trim(), model: model.trim(), apiKey: apiKey.trim() };
}

/**
 * A developer approving a write/edit over ACP was approving blind -- only a
 * title string, never what would actually change (see `HeadlessSession::
 * ask_permission`'s own doc comment on `protocol.rs`'s `ToolCallContent::
 * Diff` for the wire side of this). The diff still opens in `vscode.changes`
 * (a stable *viewer*, not an approval workflow). The Allow/Reject choice
 * itself used to be `showWarningMessage({ modal: true })`, a system-level
 * dialog in the middle of the screen, outside chat. That blocks the whole
 * window and is easy to miss as "not part of this conversation." The
 * decision now lives on the in-flight chat response as trusted command
 * links -- `session/prompt` is still awaiting, so a follow-up ChatRequest
 * (`stream.confirmation`) would deadlock behind VS Code's one-request-at-a-
 * time Send button.
 */
async function askPermission(
	request: RequestPermissionRequest,
	diffContentProvider: DiffContentProvider,
	stream: vscode.ChatResponseStream,
	permissionGate: PermissionGate,
	cwd: string,
): Promise<RequestPermissionOutcome> {
	const action = request.toolCall.title ?? 'run this action';
	const allow = request.options.find(option => option.kind === 'allow_once') ?? request.options[0];
	const reject = request.options.find(option => option.kind === 'reject_once') ?? request.options.at(-1);
	const allowLabel = allow?.name ?? 'Allow';
	const rejectLabel = reject?.name ?? 'Reject';

	const diff = request.toolCall.content;
	if (diff?.type === 'diff') {
		await showDiff(diff, diffContentProvider, cwd);
	}

	const { id, wait } = permissionGate.create();
	// Native in-chat confirmation card when the proposed API is present.
	// Clicks arrive as a follow-up ChatRequest (`acceptedConfirmationData`)
	// and are consumed at the top of requestHandler. Command links below
	// are the path that cannot deadlock: `session/prompt` is still awaiting
	// this turn, so Send is disabled until it finishes.
	if (typeof stream.confirmation === 'function') {
		stream.confirmation(
			`boxcode wants to ${action}`,
			'Allow or reject this in chat to continue.',
			permissionConfirmationData(id),
			[allowLabel, rejectLabel],
		);
	}
	stream.markdown(permissionDecisionMarkdown(action, allowLabel, rejectLabel, id));
	const choice = await wait;
	return permissionOutcomeFromGate(choice, allow, reject);
}

function escapeMarkdownLinkLabel(label: string): string {
	return label.replace(/[[\]()]/g, '\\$&');
}

function permissionDecisionMarkdown(
	action: string,
	allowLabel: string,
	rejectLabel: string,
	id: string,
): vscode.MarkdownString {
	const line = new vscode.MarkdownString(undefined, true);
	line.isTrusted = { enabledCommands: [PERMISSION_COMMAND] };
	line.appendMarkdown('$(warning) **boxcode needs permission**\n\nboxcode wants to ');
	line.appendText(action);
	line.appendMarkdown('.\n\n');
	line.appendMarkdown(`[$(check) ${escapeMarkdownLinkLabel(allowLabel)}](${permissionCommandUri(id, 'allow')})`);
	line.appendMarkdown(`&nbsp;&nbsp;[$(x) ${escapeMarkdownLinkLabel(rejectLabel)}](${permissionCommandUri(id, 'reject')})\n\n`);
	return line;
}

/**
 * Backs the virtual `boxcode-diff:` documents `showDiff` hands to
 * `vscode.changes` -- a document provider is the only stable way to give
 * VS Code's own diff viewer text that doesn't exist as a real file (the
 * "before" side of an edit, in particular, is what's on disk *right now*,
 * not a file `showDiff` is meant to create). One provider instance for the
 * whole extension host, registered once in `activate()`; each diff gets
 * its own pair of URIs so two overlapping permission requests (there
 * should never really be more than one in flight, but nothing enforces
 * that here) can't clobber each other's content.
 */
class DiffContentProvider implements vscode.TextDocumentContentProvider {
	private readonly documents = new Map<string, string>();
	private nextId = 1;

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.documents.get(uri.toString()) ?? '';
	}

	/** Registers `content` under a fresh URI and returns it. Never removed -- see the class doc comment; the extension host's lifetime is short enough that this isn't worth the bookkeeping to garbage-collect. */
	register(content: string): vscode.Uri {
		const uri = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${this.nextId++}` });
		this.documents.set(uri.toString(), content);
		return uri;
	}
}

/**
 * Opens boxcode's own diff via VS Code's stable `vscode.changes` command --
 * the same multi-file diff viewer Source Control's own Changes panel uses
 * (confirmed against this tree's real `extHostApiCommands.ts`, not a
 * proposed API). It's a viewer, not an approval workflow -- see
 * `askPermission`'s own doc comment for why this stops at "show the diff"
 * rather than attempting per-hunk accept/reject here.
 */
async function showDiff(
	diff: Extract<ToolCallContent, { type: 'diff' }>,
	diffContentProvider: DiffContentProvider,
	cwd: string,
): Promise<void> {
	const labelUri = vscode.Uri.file(resolvePathAgainstCwd(cwd, diff.path));
	const leftUri = diffContentProvider.register(diff.oldText ?? '');
	const rightUri = diffContentProvider.register(diff.newText);
	try {
		await vscode.commands.executeCommand('vscode.changes', `boxcode: ${diff.path}`, [
			[labelUri, leftUri, rightUri],
		]);
	} catch {
		// Never block the actual Allow/Reject decision on the diff viewer
		// failing to open -- the in-chat buttons that follow are still the
		// real approval gate, this is a courtesy on top of it.
	}
}

/**
 * Fulfills `check_in_browser` on the client side: finds or opens the tab at
 * `url`, forces a fresh navigation (a reused tab could otherwise show
 * stale content for a page with no hot-reload of its own), and screenshots
 * it via raw CDP -- `vscode.proposed.browser`'s `BrowserCDPSession` is a
 * bare bidirectional message channel, not a request/response API, so
 * `CdpClient` below does the request-id correlation `boxcode`'s own ACP
 * client (`AcpClient`) already does for a different protocol.
 *
 * A `BrowserCDPSession` starts out attached to nothing but the *browser*
 * level of the CDP proxy (`platform/browserView/common/cdp/proxy.ts`'s
 * `CDPBrowserProxy`), which only understands a handful of `Browser.*`/
 * `Target.*` methods -- not `Page.*`. Every `Page.*` call needs a real
 * page-session `sessionId`, obtained by listing the tab's own CDP targets
 * and explicitly attaching to the page one (`flatten: true` is required,
 * the proxy rejects `attachToTarget` without it). Skipping this and
 * sending `Page.enable` bare is what silently makes it come back
 * `Method not found` -- indistinguishable from the method genuinely not
 * existing, which is what made this take a while to actually root-cause.
 *
 * Never throws: a failure becomes `{ outcome: 'failed', reason }`, which
 * `HeadlessSession::check_browser` on the other end already knows how to
 * turn into text the model can react to (see its own doc comment) --
 * this function's job is only to describe what went wrong, not to decide
 * what the model does about it.
 */
interface BrowserPageAttachment {
	session: vscode.BrowserCDPSession;
	cdp: CdpClient;
	sessionId: string;
	targetId: string;
}

/**
 * The find-or-open-tab, attach-to-its-page-target preamble both
 * `checkInBrowser` and `interactInBrowser` need identically -- factored out
 * once both existed, rather than duplicated, per this same doc comment's own
 * explanation (still accurate, read it below) of why `flatten: true` and an
 * explicit page-session `sessionId` are required at all.
 *
 * Deliberately does NOT navigate -- that is `checkInBrowser`'s own next
 * step, not this shared preamble's job. `interactInBrowser` acts on
 * whatever the tab already shows (the same tab a prior `check_in_browser`
 * call already looked at); forcing a fresh `Page.navigate` here would
 * reload the page out from under it and destroy the exact state -- a
 * filled-in form, a clicked-open menu -- the interaction exists to act on.
 *
 * A `BrowserCDPSession` starts out attached to nothing but the *browser*
 * level of the CDP proxy (`platform/browserView/common/cdp/proxy.ts`'s
 * `CDPBrowserProxy`), which only understands a handful of `Browser.*`/
 * `Target.*` methods -- not `Page.*`/`Input.*`. Every such call needs a real
 * page-session `sessionId`, obtained by listing the tab's own CDP targets
 * and explicitly attaching to the page one (`flatten: true` is required,
 * the proxy rejects `attachToTarget` without it). Skipping this and
 * sending `Page.enable` bare is what silently makes it come back
 * `Method not found` -- indistinguishable from the method genuinely not
 * existing, which is what made this take a while to actually root-cause.
 */
async function attachToBrowserTab(url: string): Promise<BrowserPageAttachment> {
	const tab = await ensureBrowserTab(url);
	const session = await tab.startCDPSession();
	const cdp = new CdpClient(session);

	// The tab itself is always the first `type: 'page'` target -- iframes
	// and workers the page happens to have loaded also show up here, so
	// this can't just take targetInfos[0].
	const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
	const page = targetInfos.find(t => t.type === 'page');
	if (!page) {
		cdp.dispose();
		void session.close();
		throw new Error('No page target attached to this browser tab.');
	}
	const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true });
	await cdp.send('Page.enable', undefined, sessionId);

	return { session, cdp, sessionId, targetId: page.targetId };
}

/**
 * Immediately before capturing, not immediately after attaching --
 * matching exactly where VS Code's own BrowserView.captureScreenshot()
 * does the identical toggle for its internal callers (its own comment:
 * "ensures the webContents rendering pipeline is ready"). A tab opened
 * with `background: true` can leave the view without a single composited
 * frame, which makes `Page.captureScreenshot` fail with Electron's own
 * "UnknownVizError" -- confirmed live, then root-caused against that exact
 * method. Raw CDP never goes through captureScreenshot() at all, so it
 * never got that protection until this call -- see the core patch
 * implementing `Target.activateTarget` (previously an empty
 * `// TODO@kycutler` stub) for the actual mechanism. Harmless if the tab is
 * already visible: `wakeCompositorIfHidden()` on the other end is a no-op
 * once the view already is.
 */
async function captureScreenshot(attachment: BrowserPageAttachment): Promise<string> {
	await attachment.cdp.send('Target.activateTarget', { targetId: attachment.targetId });
	const { data } = await attachment.cdp.send<{ data: string }>(
		'Page.captureScreenshot',
		{ format: 'png' },
		attachment.sessionId,
	);
	return data;
}

/**
 * Fulfills `check_in_browser` on the client side: finds or opens the tab at
 * `url`, forces a fresh navigation (a reused tab could otherwise show
 * stale content for a page with no hot-reload of its own), and screenshots
 * it via raw CDP -- `vscode.proposed.browser`'s `BrowserCDPSession` is a
 * bare bidirectional message channel, not a request/response API, so
 * `CdpClient` does the request-id correlation `boxcode`'s own ACP client
 * (`AcpClient`) already does for a different protocol.
 *
 * Never throws: a failure becomes `{ outcome: 'failed', reason }`, which
 * `HeadlessSession::check_browser` on the other end already knows how to
 * turn into text the model can react to (see its own doc comment) --
 * this function's job is only to describe what went wrong, not to decide
 * what the model does about it.
 */
async function checkInBrowser(url: string): Promise<CheckInBrowserOutcome> {
	let attachment: BrowserPageAttachment | undefined;
	try {
		attachment = await attachToBrowserTab(url);
		// Catch immediately, not only after navigate succeeds: the finally
		// below dispose()s the client, and waitForEvent now rejects on
		// dispose. Awaiting loaded only after navigate used to leave that
		// rejection unhandled when navigate itself threw.
		const loaded = attachment.cdp.waitForEvent('Page.loadEventFired', 10_000).catch(() => undefined);
		await attachment.cdp.send('Page.navigate', { url }, attachment.sessionId);
		// A page that never fires the load event (a script error, an
		// infinite spinner) still gets screenshotted as-is below -- that is
		// itself useful evidence, not a reason to fail the whole check.
		await loaded;

		const data = await captureScreenshot(attachment);
		return { outcome: 'screenshot', mimeType: 'image/png', data };
	} catch (error) {
		return { outcome: 'failed', reason: describeError(error) };
	} finally {
		attachment?.cdp.dispose();
		void attachment?.session.close();
	}
}

/**
 * Fulfills `interact_in_browser` on the client side: clicks or types into
 * the SAME tab `checkInBrowser` already looked at (no fresh navigation --
 * see `attachToBrowserTab`'s own doc comment for why), via CDP's `Input`
 * domain, then screenshots the result the same way `checkInBrowser` does so
 * the model sees what actually happened rather than guessing.
 *
 * `Input.dispatchMouseEvent` needs an explicit press-then-release pair --
 * a single event with no `type` distinction is not a click, it is a mouse
 * sitting at a point. `Input.insertText` (rather than synthesizing
 * `Input.dispatchKeyEvent` per character) inserts at whatever element
 * currently has focus, the same primitive Playwright's own `page.fill()`
 * uses -- simpler and more reliable than simulating individual keystrokes
 * for the click+type slice this is scoped to.
 *
 * Never throws, same posture and same reason as `checkInBrowser`.
 */
async function interactInBrowser(url: string, interaction: BrowserInteraction): Promise<InteractInBrowserOutcome> {
	let attachment: BrowserPageAttachment | undefined;
	try {
		attachment = await attachToBrowserTab(url);
		if (interaction.action === 'click') {
			const { x, y } = interaction;
			await attachment.cdp.send(
				'Input.dispatchMouseEvent',
				{ type: 'mousePressed', x, y, button: 'left', clickCount: 1 },
				attachment.sessionId,
			);
			await attachment.cdp.send(
				'Input.dispatchMouseEvent',
				{ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 },
				attachment.sessionId,
			);
		} else {
			await attachment.cdp.send('Input.insertText', { text: interaction.text }, attachment.sessionId);
		}

		const data = await captureScreenshot(attachment);
		return { outcome: 'screenshot', mimeType: 'image/png', data };
	} catch (error) {
		return { outcome: 'failed', reason: describeError(error) };
	} finally {
		attachment?.cdp.dispose();
		void attachment?.session.close();
	}
}

/**
 * The visible half of `check_in_browser`. Terminal output already opens a
 * pane via `workbench.browser.openLocalhostLinks`. Do not open a second
 * editor beside it, and do not call `openBrowserTab` (that is what created
 * the extra `about:blank` tab). Wait for the first pane, then reuse it.
 */
const PANE_OPEN_TIMEOUT_MS = 5_000;
const TAB_APPEAR_WAIT_MS = 1_200;
const TAB_APPEAR_STEP_MS = 80;
const openingBrowserTabs = new Map<string, Promise<void>>();

async function ensureBrowserTab(url: string) {
	const key = localhostOrigin(url);
	let opening = openingBrowserTabs.get(key);
	if (!opening) {
		opening = revealOrOpenBrowserTab(url).finally(() => {
			openingBrowserTabs.delete(key);
		});
		openingBrowserTabs.set(key, opening);
	}
	await opening;

	const tab = findReusableBrowserTab(vscode.window.browserTabs, url);
	if (!tab) {
		throw new Error('Browser tab did not open.');
	}
	return tab;
}

async function revealOrOpenBrowserTab(url: string): Promise<void> {
	if (await waitForReusableTab(url, TAB_APPEAR_WAIT_MS)) {
		await openBrowserPane(url);
		return;
	}
	await openBrowserPane(url);
	await waitForReusableTab(url, TAB_APPEAR_WAIT_MS);
}

async function waitForReusableTab(url: string, ms: number) {
	const deadline = Date.now() + ms;
	for (;;) {
		const existing = findReusableBrowserTab(vscode.window.browserTabs, url);
		if (existing) {
			return existing;
		}
		if (Date.now() >= deadline) {
			return undefined;
		}
		await delay(TAB_APPEAR_STEP_MS);
	}
}

function browserReuseFilter(url: string): string {
	return localhostOrigin(url);
}

async function openBrowserPane(url: string): Promise<void> {
	try {
		await Promise.race([
			vscode.commands.executeCommand('workbench.action.browser.open', {
				url,
				openToSide: false,
				reuseUrlFilter: browserReuseFilter(url),
			}),
			new Promise<void>(resolve => setTimeout(resolve, PANE_OPEN_TIMEOUT_MS)),
		]);
	} catch {
		// See ensureBrowserTab -- not worth surfacing.
	}
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export function deactivate(): void {
	// Nothing to do here -- the disposable registered in activate() already
	// tears the subprocess down on extension host shutdown.
}
