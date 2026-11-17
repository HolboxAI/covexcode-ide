/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { FEEDBACK_MAX_LENGTH, feedbackForSubmission } from './feedbackService';

/**
 * The information the feedback panel needs about the rejected change. The
 * panel itself only shows the affected files; the host keeps the rest and
 * turns it into the payload when (and if) the user submits.
 */
export interface RejectFeedbackContext {
	sessionId: string;
	toolCallId: string;
	files: string[];
	model: string;
	provider: string;
	/** Called at submit time: the ACP turn id is only known once the turn ends. */
	turnId: () => string;
}

export type FeedbackWindowMode = 'reject' | 'general';

export interface FeedbackWindowOptions {
	mode: FeedbackWindowMode;
	heading: string;
	placeholder: string;
	subtitle?: string;
	prefill?: string;
	onSubmit: (feedback: string) => void;
	onDismiss?: () => void;
}

// One feedback panel at a time, shared by reject and general feedback. A
// second request of the same kind focuses the existing panel instead of
// stacking; a different kind replaces it.
let activeFeedbackPanel: vscode.WebviewPanel | undefined;
let activeFeedbackMode: FeedbackWindowMode | undefined;

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i += 1) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function renderHtml(nonce: string, options: FeedbackWindowOptions): string {
	const subtitle = options.subtitle ? `<p class="subtitle">${escapeHtml(options.subtitle)}</p>` : '';
	const prefill = escapeHtml(options.prefill ?? '');

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>covexcode feedback</title>
<style>
	:root { color-scheme: light dark; }
	* { box-sizing: border-box; }
	body {
		margin: 0;
		padding: 12px;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		max-width: 460px;
		animation: covexcode-feedback-in 0.18s ease-out;
	}
	@keyframes covexcode-feedback-in {
		from { opacity: 0; transform: translateY(6px) scale(0.985); }
		to { opacity: 1; transform: translateY(0) scale(1); }
	}
	.heading {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		color: var(--vscode-descriptionForeground);
	}
	.subtitle {
		margin: -4px 0 0;
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 11px;
		color: var(--vscode-descriptionForeground);
		word-break: break-all;
	}
	textarea {
		width: 100%;
		min-height: 84px;
		resize: vertical;
		padding: 8px;
		font: inherit;
		color: var(--vscode-input-foreground);
		background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, transparent);
		border-radius: 4px;
		outline: none;
		transition: border-color 0.12s ease, box-shadow 0.12s ease, background-color 0.12s ease;
	}
	textarea:focus {
		border-color: var(--vscode-focusBorder);
		box-shadow: 0 0 0 1px var(--vscode-focusBorder);
	}
	.meta {
		display: flex;
		justify-content: flex-end;
		font-size: 11px;
		color: var(--vscode-descriptionForeground);
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	button {
		font: inherit;
		padding: 4px 12px;
		border-radius: 3px;
		border: 1px solid transparent;
		cursor: pointer;
		transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease, opacity 0.12s ease, transform 0.06s ease;
	}
	button.primary {
		color: var(--vscode-button-foreground);
		background: var(--vscode-button-background);
	}
	button.primary:hover:not(:disabled) {
		background: var(--vscode-button-hoverBackground);
	}
	button.primary:active:not(:disabled) {
		transform: scale(0.98);
	}
	button.primary:disabled {
		opacity: 0.5;
		cursor: default;
	}
	button.secondary {
		color: var(--vscode-button-secondaryForeground);
		background: var(--vscode-button-secondaryBackground);
	}
	button.secondary:hover {
		background: var(--vscode-button-secondaryHoverBackground);
	}
	button.secondary:active {
		transform: scale(0.98);
	}
	@media (prefers-reduced-motion: reduce) {
		.card { animation: none; }
		textarea, button { transition: none; }
		button:active { transform: none; }
	}
</style>
</head>
<body>
	<div class="card">
		<p class="heading">${escapeHtml(options.heading)}</p>
		${subtitle}
		<textarea id="feedback" maxlength="${FEEDBACK_MAX_LENGTH}" placeholder="${escapeHtml(options.placeholder)}">${prefill}</textarea>
		<div class="meta"><span id="counter">0 / ${FEEDBACK_MAX_LENGTH}</span></div>
		<div class="actions">
			<button class="secondary" id="skip">Skip</button>
			<button class="primary" id="submit" disabled>Submit</button>
		</div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const textarea = document.getElementById('feedback');
		const counter = document.getElementById('counter');
		const submit = document.getElementById('submit');
		const skip = document.getElementById('skip');
		const MAX = ${FEEDBACK_MAX_LENGTH};
		const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
		const isMac = /mac/i.test(platform);

		function refresh() {
			if (textarea.value.length > MAX) {
				textarea.value = textarea.value.slice(0, MAX);
			}
			counter.textContent = textarea.value.length + ' / ' + MAX;
			submit.disabled = textarea.value.trim().length === 0;
		}

		function send() {
			const text = textarea.value.trim();
			if (!text) {
				vscode.postMessage({ type: 'skip' });
				return;
			}
			vscode.postMessage({ type: 'submit', text: text });
		}

		textarea.addEventListener('input', refresh);
		textarea.addEventListener('paste', () => setTimeout(refresh, 0));
		textarea.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && (isMac ? event.metaKey : event.ctrlKey)) {
				event.preventDefault();
				if (!submit.disabled) {
					send();
				}
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				vscode.postMessage({ type: 'skip' });
			}
		});
		window.addEventListener('blur', () => {
			if (textarea.value.trim().length === 0) {
				vscode.postMessage({ type: 'skip' });
			}
		});
		skip.addEventListener('click', () => vscode.postMessage({ type: 'skip' }));
		submit.addEventListener('click', send);
		refresh();
		textarea.focus();
	</script>
</body>
</html>`;
}

/**
 * Open (or focus) the shared floating feedback window. A second request of
 * the same mode focuses the existing panel; a different mode replaces it.
 * This never awaits or blocks anything.
 */
export function showFeedbackWindow(options: FeedbackWindowOptions): void {
	if (activeFeedbackPanel && activeFeedbackMode === options.mode) {
		activeFeedbackPanel.reveal();
		return;
	}
	if (activeFeedbackPanel) {
		activeFeedbackPanel.dispose();
	}

	const panel = vscode.window.createWebviewPanel(
		'covexcode.feedback',
		'covexcode feedback',
		{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
		{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
	);
	activeFeedbackPanel = panel;
	activeFeedbackMode = options.mode;

	panel.webview.html = renderHtml(getNonce(), options);

	let settled = false;
	const settle = (submit: boolean, feedback?: string): void => {
		if (settled) {
			return;
		}
		settled = true;
		panel.dispose();
		if (submit && feedback !== undefined) {
			try {
				options.onSubmit(feedback);
			} catch {
				// Feedback must never surface an error into the chat flow.
			}
		} else {
			options.onDismiss?.();
		}
	};

	panel.webview.onDidReceiveMessage((message: { type?: string; text?: unknown }) => {
		if (message?.type === 'submit') {
			const feedback = feedbackForSubmission(typeof message.text === 'string' ? message.text : '');
			if (feedback === undefined) {
				settle(false);
			} else {
				settle(true, feedback);
			}
		} else if (message?.type === 'skip') {
			settle(false);
		}
	});

	panel.onDidDispose(() => {
		if (activeFeedbackPanel === panel) {
			activeFeedbackPanel = undefined;
			activeFeedbackMode = undefined;
		}
		if (!settled) {
			settled = true;
			options.onDismiss?.();
		}
	});
}

/**
 * Open the small, non-modal reject-feedback panel beside the active editor.
 * The reject itself has already completed by the time this is called.
 */
export function showRejectFeedback(
	context: RejectFeedbackContext,
	onSubmit: (feedback: string) => void,
	onDismiss: () => void = () => {},
): void {
	const subtitle = context.files.length === 0
		? undefined
		: context.files.length === 1
			? context.files[0]
			: `${context.files.length} files`;

	showFeedbackWindow({
		mode: 'reject',
		heading: 'Why did you reject this change? (optional)',
		placeholder: 'Tell us why you rejected this (optional)',
		subtitle,
		onSubmit,
		onDismiss,
	});
}
