/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	buildCompletionRequest,
	extractContext,
	parseBoxcodeConfigToml,
	parseCompletionResponse,
	requestCompletion,
	trimPrefixOverlap,
	type BoxcodeConfigToml,
	MAX_PREFIX_CHARS,
	MAX_SUFFIX_CHARS,
} from './inlineCompletion';

const DEFAULT_DEBOUNCE_MS = 150;

/**
 * Registers boxcode's Tab-style multi-line completion provider. The stable
 * `registerInlineCompletionItemProvider` API renders the ghost text, Tab-to-accept
 * and cycling for free; this provider only has to supply a continuation string.
 *
 * Best-effort by design: any failure -- missing endpoint/model/key, a cancelled
 * request, a non-2xx, a malformed body -- resolves to "no suggestion", never an
 * error toast. A completion is a convenience, and typing must never be
 * interrupted by a rejected promise.
 */
export function registerInlineCompletion(context: vscode.ExtensionContext): vscode.Disposable {
	const provider: vscode.InlineCompletionItemProvider = {
		async provideInlineCompletionItems(document, position, trigger, token) {
			const config = vscode.workspace.getConfiguration('boxcode');
			if (config.get<boolean>('inlineCompletionEnabled', true) === false) {
				return undefined;
			}
			let endpoint = (config.get<string>('endpoint', '') || '').trim();
			let model = (config.get<string>('model', '') || '').trim();
			let apiKey = (await context.secrets.get('boxcode.apiKey')) ?? '';
			// Fall back to the CLI's ~/.boxcode/config.toml when the IDE hasn't
			// stored credentials yet, mirroring how chat lets `boxcode --acp`
			// read the same file. IDE settings/SecretStorage always win.
			if (!endpoint || !model || !apiKey) {
				const toml = configTomlCredentials();
				endpoint = endpoint || toml.endpoint || '';
				model = model || toml.model || '';
				apiKey = apiKey || toml.apiKey || '';
			}
			if (!endpoint || !model || !apiKey) {
				return undefined;
			}

			// Trailing-edge throttle: automatic triggers wait until the user has
			// stopped typing for `debounceMs`, so a slow model isn't sent one
			// request per keystroke (each of which VS Code then cancels on the
			// next edit). An explicit Invoke (Ctrl+Space) fires immediately.
			if (trigger.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
				const proceeded = await debounceIdle(debounceMs(config), token);
				if (!proceeded) {
					return undefined;
				}
			}

			const text = document.getText();
			const offset = document.offsetAt(position);
			const { prefix, suffix } = extractContext(text, offset, MAX_PREFIX_CHARS, MAX_SUFFIX_CHARS);

			const request = buildCompletionRequest(endpoint, model, apiKey, document.uri.fsPath, document.languageId, prefix, suffix);

			const controller = new AbortController();
			const onCancel = token.onCancellationRequested(() => controller.abort());
			try {
				const raw = await requestCompletion(request, controller.signal);
				// Insert at the cursor rather than replacing the word there: after
				// `trimPrefixOverlap` the continuation is exactly the new text, and
				// an empty range sidesteps the stable API's same-line range rule.
				const insertText = trimPrefixOverlap(prefix, parseCompletionResponse(raw));
				if (!insertText) {
					return undefined;
				}
				return [new vscode.InlineCompletionItem(insertText, new vscode.Range(position, position))];
			} catch {
				return undefined;
			} finally {
				onCancel.dispose();
			}
		},
	};

	return vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, provider);
}

/**
 * Resolves `true` once `ms` elapses with no cancellation, or `false` the moment
 * the request token is cancelled (a newer edit superseded this one). The trailing
 * edge is what collapses a burst of keystrokes into a single request.
 */
function debounceIdle(ms: number, token: vscode.CancellationToken): Promise<boolean> {
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (ok: boolean) => {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			resolve(ok);
		};
		const onCancel = token.onCancellationRequested(() => finish(false));
		timer = setTimeout(() => {
			onCancel.dispose();
			finish(true);
		}, ms);
	});
}

function debounceMs(config: vscode.WorkspaceConfiguration): number {
	const raw = config.get<number>('inlineCompletionDebounceMs', DEFAULT_DEBOUNCE_MS);
	return typeof raw === 'number' && raw >= 0 ? raw : DEFAULT_DEBOUNCE_MS;
}

/** Reads the `[llm]` credentials from `~/.boxcode/config.toml`, or `{}` on any failure. */
function configTomlCredentials(): BoxcodeConfigToml {
	try {
		const p = path.join(os.homedir(), '.boxcode', 'config.toml');
		return parseBoxcodeConfigToml(fs.readFileSync(p, 'utf8'));
	} catch {
		return {};
	}
}
