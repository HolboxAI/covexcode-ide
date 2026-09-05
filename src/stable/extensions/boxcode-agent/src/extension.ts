/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	AcpClient,
	CheckInBrowserOutcome,
	CheckInBrowserRequest,
	RequestPermissionOutcome,
	RequestPermissionRequest,
	SessionNotification,
	SessionUpdate,
	ToolCallContent,
	ToolCallStatus,
} from './acpClient';
import { CdpClient } from './cdpClient';

const PARTICIPANT_ID = 'boxcode.agent';
const BOXCODE_COMMAND = 'boxcode';
const SECRET_API_KEY = 'boxcode.apiKey';
const DIFF_SCHEME = 'boxcode-diff';

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
 * Known limitation, stated rather than hidden: VS Code's own "new chat"
 * action does not currently start a fresh `boxcode` session -- every turn
 * in this window shares the one ACP session opened on the first message.
 * Scoped narrower on purpose, matching the same "small, honest first
 * version" precedent `headless.rs` itself documents.
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

	const diffContentProvider = new DiffContentProvider();
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffContentProvider),
	);
	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider('boxcode', new StubLanguageModelProvider()),
	);

	function ensureReady(): Promise<void> {
		if (!ready) {
			ready = (async () => {
				const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
				const envOverrides = await ensureCredentials(context);
				const acp = new AcpClient(BOXCODE_COMMAND, cwd, envOverrides);
				client = acp;
				await acp.initialize();
				sessionId = await acp.newSession(cwd);
			})().catch(error => {
				// A failed launch must not wedge every later message behind
				// the same rejected promise forever -- clear the memoized
				// attempt so the next chat message gets a fresh try, not a
				// permanently broken participant until the window reloads.
				ready = undefined;
				client = undefined;
				throw error;
			});
		}
		return ready;
	}

	const requestHandler: vscode.ChatRequestHandler = async (request, _chatContext, stream, token) => {
		try {
			await ensureReady();
		} catch (error) {
			if (error instanceof SetupCancelled) {
				stream.markdown('Configuration needed -- send another message when you\'re ready to set boxcode up.');
			} else {
				stream.markdown(
					`Couldn't start \`boxcode --acp\` (${describeError(error)}). Make sure \`boxcode\` is ` +
						'installed and on your PATH.',
				);
			}
			return;
		}
		if (!client || !sessionId) {
			stream.markdown("boxcode isn't ready yet -- try again in a moment.");
			return;
		}
		const activeClient = client;
		const activeSessionId = sessionId;
		// `tool_call_update`'s own `title` is usually absent (headless.rs
		// only sets it on the initial `tool_call`) -- without remembering
		// it here, the completion/failure line renderUpdate shows would
		// have no label at all. Scoped to one turn, not the whole session:
		// a fresh Map per requestHandler call, same lifetime as `stream`.
		const toolCallTitles = new Map<string, string>();

		const onUpdate = (notification: SessionNotification) => {
			if (notification.sessionId === activeSessionId) {
				renderUpdate(notification.update, stream, toolCallTitles);
			}
		};
		const onPermissionRequest = (
			permissionRequest: RequestPermissionRequest,
			respond: (outcome: RequestPermissionOutcome) => void,
		) => {
			if (permissionRequest.sessionId === activeSessionId) {
				void askPermission(permissionRequest, diffContentProvider).then(respond);
			}
		};
		const onBrowserCheckRequest = (
			browserRequest: CheckInBrowserRequest,
			respond: (outcome: CheckInBrowserOutcome) => void,
		) => {
			if (browserRequest.sessionId === activeSessionId) {
				void checkInBrowser(browserRequest.url).then(respond);
			}
		};

		activeClient.on('update', onUpdate);
		activeClient.on('permissionRequest', onPermissionRequest);
		activeClient.on('browserCheckRequest', onBrowserCheckRequest);
		// v1 has no cancellation plumbing into HeadlessSession yet -- see
		// boxcode's own transport.rs docs on `session/cancel`. A cancelled
		// request here still waits for the in-flight turn to finish rather
		// than abandoning it silently.
		const onCancel = token.onCancellationRequested(() => {});
		const { prompt, skippedImageCount } = attachReferencesToPrompt(request);
		if (skippedImageCount > 0) {
			stream.markdown(
				`_${skippedImageCount === 1 ? 'An image attachment' : `${skippedImageCount} image attachments`} ` +
					`(e.g. an element screenshot) ${skippedImageCount === 1 ? "wasn't" : "weren't"} sent -- ` +
					'boxcode can\'t take image input yet._\n\n',
			);
		}
		try {
			await activeClient.prompt(activeSessionId, prompt);
		} catch (error) {
			stream.markdown(`boxcode stopped responding: ${describeError(error)}`);
		} finally {
			activeClient.off('update', onUpdate);
			activeClient.off('permissionRequest', onPermissionRequest);
			activeClient.off('browserCheckRequest', onBrowserCheckRequest);
			onCancel.dispose();
		}
	};

	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, requestHandler);
	context.subscriptions.push(participant);
	context.subscriptions.push({ dispose: () => client?.dispose() });

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
}

/**
 * Folds `request.references` -- context attached via the Integrated
 * Browser's own element-picker, console-log-to-chat, and screenshot
 * features (`browserEditorChatFeatures.ts`, upstream and unpatched in this
 * fork) -- into the plain-text prompt `AcpClient.prompt` actually sends.
 * boxcode never had to build any of the attachment UI itself: clicking an
 * element or attaching console logs already lands here as an ordinary
 * `ChatPromptReference`, the same mechanism any chat participant gets, once
 * `boxcode.agent` is the active default agent (see `ChatContextKeys.enabled`
 * in VS Code's own `chatAgents.ts` -- it only needs *some* default agent
 * active, not anything browser-specific).
 *
 * Image attachments (element screenshots) are the one thing this can't
 * carry yet: ACP's `session/prompt` only accepts `ContentBlock::Text` today
 * (`protocol.rs`'s own doc comment is explicit that this is a deliberate,
 * not-yet-filled gap, matching the v1 spec's minimum baseline). Silently
 * dropping an attachment the user explicitly chose to send would be worse
 * than saying so -- counted and surfaced as a plain notice in the caller,
 * not swallowed.
 */
function attachReferencesToPrompt(request: vscode.ChatRequest): { prompt: string; skippedImageCount: number } {
	const sections: string[] = [];
	let skippedImageCount = 0;

	for (const reference of request.references) {
		if (reference.value instanceof vscode.ChatReferenceBinaryData) {
			skippedImageCount++;
			continue;
		}
		const heading = reference.modelDescription ?? reference.id;
		const body = typeof reference.value === 'string' ? reference.value : String(reference.value);
		sections.push(`### Attached: ${heading}\n\n${body}`);
	}

	const prompt = sections.length > 0 ? `${sections.join('\n\n')}\n\n${request.prompt}` : request.prompt;
	return { prompt, skippedImageCount };
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

function renderUpdate(update: SessionUpdate, stream: vscode.ChatResponseStream, toolCallTitles: Map<string, string>): void {
	switch (update.sessionUpdate) {
		case 'agent_message_chunk': {
			const content = update.content;
			if (content?.type === 'text') {
				stream.markdown(content.text);
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
				// source. A command's own title starts with a literal "$ "
				// (tools.rs's Action::label) -- concatenated after this
				// icon's own leading "$(...)", two "$"s land close enough
				// together that the chat renderer's KaTeX math support
				// reads everything between them as inline math and
				// silently swallows it, which is genuinely what happened
				// here before this used the escaping builder API instead
				// of a template string.
				const line = new vscode.MarkdownString(undefined, true);
				line.appendMarkdown(`${toolCallStatusIcon(update.status)} `);
				line.appendText(title);
				line.appendMarkdown('\n\n');
				stream.markdown(line);
			}
			// check_in_browser's own result: rendered inline as an image for
			// the human. Also fed to the model as real vision input when
			// `config.tools.attach_browser_screenshots` is on -- see
			// headless.rs's own doc comment on why that's a separate path
			// from this one, which exists purely for the human.
			if (update.content?.type === 'image') {
				stream.markdown(`![screenshot](data:${update.content.mimeType};base64,${update.content.data})`);
			}
			break;
		}
		default:
			// Every other legal ACP v1 variant boxcode doesn't emit yet --
			// see protocol.rs's own doc comment on SessionUpdate. Nothing to
			// render, not an error.
			break;
	}
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
async function ensureCredentials(context: vscode.ExtensionContext): Promise<NodeJS.ProcessEnv> {
	const config = vscode.workspace.getConfiguration('boxcode');
	let endpoint = config.get<string>('endpoint', '');
	let model = config.get<string>('model', '');
	let apiKey = (await context.secrets.get(SECRET_API_KEY)) ?? '';

	if ((!endpoint || !model || !apiKey) && !configTomlExists()) {
		const entered = await runSetupFlow();
		if (!entered) {
			throw new SetupCancelled('boxcode setup was cancelled');
		}
		endpoint = entered.endpoint;
		model = entered.model;
		apiKey = entered.apiKey;
		await config.update('endpoint', endpoint, vscode.ConfigurationTarget.Global);
		await config.update('model', model, vscode.ConfigurationTarget.Global);
		await context.secrets.store(SECRET_API_KEY, apiKey);
	}

	const overrides: NodeJS.ProcessEnv = {};
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

async function runSetupFlow(): Promise<{ endpoint: string; model: string; apiKey: string } | undefined> {
	const endpoint = await vscode.window.showInputBox({
		title: 'boxcode setup (1/3)',
		prompt: "boxcode's LLM endpoint -- an OpenAI-compatible base URL",
		placeHolder: 'https://api.deepseek.com',
		ignoreFocusOut: true,
		validateInput: value => (value.trim() ? undefined : 'An endpoint is required.'),
	});
	if (!endpoint) {
		return undefined;
	}

	const model = await vscode.window.showInputBox({
		title: 'boxcode setup (2/3)',
		prompt: 'Model name to request from that endpoint',
		placeHolder: 'deepseek-chat',
		ignoreFocusOut: true,
		validateInput: value => (value.trim() ? undefined : 'A model name is required.'),
	});
	if (!model) {
		return undefined;
	}

	const apiKey = await vscode.window.showInputBox({
		title: 'boxcode setup (3/3)',
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
 * Diff` for the wire side of this). Scoped deliberately narrow, matching
 * the research this was built from: `vscode.changes` is a stable *viewer*,
 * not an approval workflow, so this shows the real diff right before the
 * existing Allow/Reject modal rather than attempting per-hunk accept/
 * reject, which would need proposed, unconfirmed-scope multi-diff-editor
 * menu APIs. Real per-hunk review stays a scoped-out v2.
 */
async function askPermission(
	request: RequestPermissionRequest,
	diffContentProvider: DiffContentProvider,
): Promise<RequestPermissionOutcome> {
	const action = request.toolCall.title ?? 'run this action';
	const allow = request.options.find(option => option.kind === 'allow_once') ?? request.options[0];
	const reject = request.options.find(option => option.kind === 'reject_once') ?? request.options.at(-1);
	const allowLabel = allow?.name ?? 'Allow';
	const rejectLabel = reject?.name ?? 'Reject';

	const diff = request.toolCall.content;
	if (diff?.type === 'diff') {
		await showDiff(diff, diffContentProvider);
	}

	const choice = await vscode.window.showWarningMessage(
		`boxcode wants to ${action}`,
		{ modal: true },
		allowLabel,
		rejectLabel,
	);

	if (allow && choice === allowLabel) {
		return { outcome: 'selected', optionId: allow.optionId };
	}
	return { outcome: 'cancelled' };
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
): Promise<void> {
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
	const labelUri = vscode.Uri.joinPath(cwd, diff.path);
	const leftUri = diffContentProvider.register(diff.oldText ?? '');
	const rightUri = diffContentProvider.register(diff.newText);
	try {
		await vscode.commands.executeCommand('vscode.changes', `boxcode: ${diff.path}`, [
			[labelUri, leftUri, rightUri],
		]);
	} catch {
		// Never block the actual Allow/Reject decision on the diff viewer
		// failing to open -- the modal that follows is still the real
		// approval gate, this is a courtesy on top of it.
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
async function checkInBrowser(url: string): Promise<CheckInBrowserOutcome> {
	let session: vscode.BrowserCDPSession | undefined;
	let cdp: CdpClient | undefined;
	try {
		const tab =
			vscode.window.browserTabs.find(t => t.url === url || t.url === `${url}/`) ??
			(await vscode.window.openBrowserTab(url, { preserveFocus: true, background: true }));
		session = await tab.startCDPSession();
		cdp = new CdpClient(session);

		// The tab itself is always the first `type: 'page'` target -- iframes
		// and workers the page happens to have loaded also show up here, so
		// this can't just take targetInfos[0].
		const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
		const page = targetInfos.find(t => t.type === 'page');
		if (!page) {
			throw new Error('No page target attached to this browser tab.');
		}
		const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: page.targetId, flatten: true });

		await cdp.send('Page.enable', undefined, sessionId);
		const loaded = cdp.waitForEvent('Page.loadEventFired', 10_000);
		await cdp.send('Page.navigate', { url }, sessionId);
		// A page that never fires the load event (a script error, an
		// infinite spinner) still gets screenshotted as-is below -- that is
		// itself useful evidence, not a reason to fail the whole check.
		await loaded.catch(() => undefined);

		const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, sessionId);
		void openBrowserPaneBeside(url);
		return { outcome: 'screenshot', mimeType: 'image/png', data };
	} catch (error) {
		return { outcome: 'failed', reason: describeError(error) };
	} finally {
		cdp?.dispose();
		void session?.close();
	}
}

/**
 * The visible half of `check_in_browser`: the CDP tab above is a hidden,
 * background-only surface for taking a screenshot, so a human watching chat
 * would otherwise never see the live page the agent just checked -- only a
 * static image after the fact. `workbench.action.browser.open`'s
 * `openToSide` opens (or, via `reuseUrlFilter`, reuses) a real Integrated
 * Browser pane next to whatever's currently active, matching the same
 * mechanism `LocalhostLinkOpenerContribution` already uses elsewhere in this
 * tree (`patches/83-ui-auto-open-localhost-browser.patch`) rather than
 * inventing a second way to open one.
 *
 * Deliberately fire-and-forget and swallowed on failure: this is a
 * convenience on top of an already-successful screenshot, not something
 * that should turn a working `check_in_browser` result into a failure if
 * the command is ever unavailable for some reason.
 */
async function openBrowserPaneBeside(url: string): Promise<void> {
	try {
		await vscode.commands.executeCommand('workbench.action.browser.open', {
			url,
			openToSide: true,
			reuseUrlFilter: url,
		});
	} catch {
		// See doc comment above -- not worth surfacing.
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function deactivate(): void {
	// Nothing to do here -- the disposable registered in activate() already
	// tears the subprocess down on extension host shutdown.
}
