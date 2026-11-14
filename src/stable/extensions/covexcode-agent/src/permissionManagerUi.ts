/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { type PermissionRule, type SerializedRule, serializeRules } from './permissionStore';

export const EMPTY_STATE_MESSAGE = 'No saved permissions. When you choose Always Allow on a tool request, it will appear here.';

let activePermissionPanel: vscode.WebviewPanel | undefined;

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i += 1) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

export function renderRulesHtml(rules: readonly SerializedRule[]): string {
	if (rules.length === 0) {
		return `<div class="empty-state">${escapeHtml(EMPTY_STATE_MESSAGE)}</div>`;
	}

	const rows = rules
		.map(rule => {
			const formattedDate = escapeHtml(new Date(rule.createdAt).toLocaleDateString());
			const kindLabel = escapeHtml(rule.kind || 'action');
			const targetLabel = escapeHtml(rule.pattern);
			const ruleId = escapeHtml(rule.id);

			return `<tr class="rule-row" data-id="${ruleId}">
				<td class="col-kind"><span class="badge">${kindLabel}</span></td>
				<td class="col-target" title="${targetLabel}"><code>${targetLabel}</code></td>
				<td class="col-date">${formattedDate}</td>
				<td class="col-action">
					<button class="revoke-btn" data-id="${ruleId}" aria-label="Revoke permission for ${targetLabel}">Revoke</button>
				</td>
			</tr>`;
		})
		.join('\n');

	return `<table class="rules-table">
		<thead>
			<tr>
				<th>Resource</th>
				<th>Target</th>
				<th>Date Added</th>
				<th class="col-action">Action</th>
			</tr>
		</thead>
		<tbody>
			${rows}
		</tbody>
	</table>`;
}

export function renderPermissionManagerHtml(nonce: string, initialRules: readonly SerializedRule[]): string {
	const initialContent = renderRulesHtml(initialRules);

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Covexcode Permissions</title>
<style>
	:root { color-scheme: light dark; }
	* { box-sizing: border-box; }
	body {
		margin: 0;
		padding: 1.5rem;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		line-height: 1.4;
	}
	.container {
		max-width: 900px;
		margin: 0 auto;
	}
	header {
		margin-bottom: 1.5rem;
		border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, #33333322));
		padding-bottom: 0.75rem;
	}
	h1 {
		margin: 0 0 0.25rem 0;
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--vscode-foreground);
	}
	.description {
		margin: 0;
		font-size: 0.85rem;
		color: var(--vscode-descriptionForeground);
	}
	.empty-state {
		padding: 2.5rem 1rem;
		text-align: center;
		color: var(--vscode-descriptionForeground);
		background: var(--vscode-editorWidget-background, transparent);
		border: 1px dashed var(--vscode-widget-border, var(--vscode-editorWidget-border, #44444433));
		border-radius: 6px;
		margin-top: 1rem;
		font-size: 0.95rem;
	}
	.rules-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.9rem;
	}
	.rules-table th {
		text-align: left;
		padding: 0.6rem 0.8rem;
		font-size: 0.8rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: var(--vscode-descriptionForeground);
		border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, #33333322));
	}
	.rules-table td {
		padding: 0.65rem 0.8rem;
		vertical-align: middle;
		border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, #33333315));
	}
	.badge {
		display: inline-block;
		padding: 0.15rem 0.45rem;
		font-size: 0.75rem;
		font-weight: 500;
		border-radius: 3px;
		background: var(--vscode-badge-background);
		color: var(--vscode-badge-foreground);
		text-transform: lowercase;
	}
	.col-target code {
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 0.85rem;
		color: var(--vscode-textPreformat-foreground, inherit);
		word-break: break-all;
	}
	.col-date {
		white-space: nowrap;
		color: var(--vscode-descriptionForeground);
		font-size: 0.82rem;
	}
	.col-action {
		text-align: right;
		width: 90px;
	}
	.revoke-btn {
		cursor: pointer;
		padding: 0.3rem 0.75rem;
		font-family: inherit;
		font-size: 0.82rem;
		font-weight: 500;
		color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
		background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
		border: 1px solid var(--vscode-button-border, transparent);
		border-radius: 3px;
		outline: none;
		transition: background 0.1s ease;
	}
	.revoke-btn:hover {
		background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
	}
	.revoke-btn:focus-visible {
		outline: 1px solid var(--vscode-focusBorder);
		outline-offset: 1px;
	}
	@media (prefers-reduced-motion: reduce) {
		* {
			transition: none !important;
			animation: none !important;
		}
	}
</style>
</head>
<body>
<div class="container">
	<header>
		<h1>Covexcode Permissions</h1>
		<p class="description">Review and revoke permission rules saved with Always Allow.</p>
	</header>
	<div id="content">
		${initialContent}
	</div>
</div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	const contentDiv = document.getElementById('content');

	function attachListeners() {
		document.querySelectorAll('.revoke-btn').forEach(button => {
			button.addEventListener('click', () => {
				const ruleId = button.getAttribute('data-id');
				if (ruleId) {
					button.disabled = true;
					vscode.postMessage({ type: 'revoke', ruleId });
				}
			});
		});
	}

	window.addEventListener('message', event => {
		const message = event.data;
		if (message && message.type === 'rules' && Array.isArray(message.rules)) {
			if (message.rules.length === 0) {
				contentDiv.innerHTML = '<div class="empty-state">${escapeHtml(EMPTY_STATE_MESSAGE)}</div>';
			} else {
				let html = '<table class="rules-table"><thead><tr><th>Resource</th><th>Target</th><th>Date Added</th><th class="col-action">Action</th></tr></thead><tbody>';
				for (const rule of message.rules) {
					const dateStr = rule.createdAt ? new Date(rule.createdAt).toLocaleDateString() : '';
					html += '<tr class="rule-row" data-id="' + escape(rule.id) + '">' +
						'<td class="col-kind"><span class="badge">' + escape(rule.kind || 'action') + '</span></td>' +
						'<td class="col-target" title="' + escape(rule.pattern) + '"><code>' + escape(rule.pattern) + '</code></td>' +
						'<td class="col-date">' + escape(dateStr) + '</td>' +
						'<td class="col-action"><button class="revoke-btn" data-id="' + escape(rule.id) + '" aria-label="Revoke permission for ' + escape(rule.pattern) + '">Revoke</button></td>' +
						'</tr>';
				}
				html += '</tbody></table>';
				contentDiv.innerHTML = html;
				attachListeners();
			}
		}
	});

	function escape(text) {
		if (typeof text !== 'string') return '';
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	attachListeners();
</script>
</body>
</html>`;
}

export interface PermissionManagerContext {
	getRules: () => readonly PermissionRule[];
	onRevoke: (ruleId: string) => PermissionRule | undefined;
}

export function showPermissionManager(context: PermissionManagerContext): vscode.WebviewPanel {
	if (activePermissionPanel) {
		activePermissionPanel.reveal(vscode.ViewColumn.Active);
		const currentRules = serializeRules(context.getRules());
		void activePermissionPanel.webview.postMessage({ type: 'rules', rules: currentRules });
		return activePermissionPanel;
	}

	const panel = vscode.window.createWebviewPanel(
		'covexcode.permissions',
		'Covexcode Permissions',
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	activePermissionPanel = panel;

	const initialRules = serializeRules(context.getRules());
	panel.webview.html = renderPermissionManagerHtml(getNonce(), initialRules);

	panel.webview.onDidReceiveMessage((message: { type?: string; ruleId?: unknown }) => {
		if (message?.type === 'revoke' && typeof message.ruleId === 'string') {
			const revoked = context.onRevoke(message.ruleId);
			if (revoked) {
				const resourceType = revoked.kind.length > 0 ? revoked.kind : 'action';
				void vscode.window.showInformationMessage(`Permission revoked: ${resourceType} ${revoked.pattern}`);
			}
			const updated = serializeRules(context.getRules());
			void panel.webview.postMessage({ type: 'rules', rules: updated });
		}
	});

	panel.onDidDispose(() => {
		if (activePermissionPanel === panel) {
			activePermissionPanel = undefined;
		}
	});

	return panel;
}
