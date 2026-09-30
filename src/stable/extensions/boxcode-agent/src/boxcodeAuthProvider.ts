/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	AUTH_PROVIDER_ID,
	AUTH_PROVIDER_LABEL,
	AccountCredentials,
	DeviceLoginError,
	authBaseUrl,
	heartbeatOnce,
	logoutLocal,
	pollDeviceLogin,
	readAccountStatus,
	saveAccountCredentials,
	startDeviceLogin,
	verificationUrl,
} from './accountLogin';

export { AUTH_PROVIDER_ID, AUTH_PROVIDER_LABEL };

const SESSION_ID = 'boxcode-device';

/**
 * Surfaces boxcode.sh in the IDE Accounts / Profile menu (same place as
 * GitHub / Microsoft). Create session = browser device login; remove = logout.
 */
export class BoxcodeAuthProvider implements vscode.AuthenticationProvider {
	private readonly _onDidChangeSessions = new vscode.EventEmitter<
		vscode.AuthenticationProviderAuthenticationSessionsChangeEvent
	>();
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	constructor(
		private readonly onCredentialsSaved?: (creds: AccountCredentials) => void | Promise<void>,
		private readonly onLoggedOut?: () => void | Promise<void>,
	) {}

	getSessions(
		_scopes?: readonly string[],
		_options?: vscode.AuthenticationProviderSessionOptions,
	): Thenable<vscode.AuthenticationSession[]> {
		return Promise.resolve(this.currentSessions());
	}

	async createSession(
		scopes: readonly string[],
		_options?: vscode.AuthenticationProviderSessionOptions,
	): Promise<vscode.AuthenticationSession> {
		const creds = await runBrowserDeviceLogin();
		saveAccountCredentials(creds);
		await this.onCredentialsSaved?.(creds);
		void heartbeatOnce();
		const session = sessionFromCredentials(creds, scopes);
		this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });
		return session;
	}

	async removeSession(sessionId: string): Promise<void> {
		const before = this.currentSessions();
		logoutLocal();
		await this.onLoggedOut?.();
		const removed = before.filter(s => s.id === sessionId);
		this._onDidChangeSessions.fire({
			added: [],
			removed: removed.length ? removed : before,
			changed: [],
		});
	}

	/** Re-read disk and notify Accounts UI (e.g. after CLI `boxcode login`). */
	refreshFromDisk(): void {
		const sessions = this.currentSessions();
		this._onDidChangeSessions.fire({
			added: sessions,
			removed: [],
			changed: sessions,
		});
	}

	private currentSessions(): vscode.AuthenticationSession[] {
		const status = readAccountStatus();
		if (!status.signedIn) {
			return [];
		}
		const label = status.email || 'boxcode.sh account';
		return [
			{
				id: SESSION_ID,
				accessToken: 'local',
				account: { id: label, label },
				scopes: [],
			},
		];
	}
}

export function registerBoxcodeAuthProvider(
	context: vscode.ExtensionContext,
	hooks: {
		onCredentialsSaved?: (creds: AccountCredentials) => void | Promise<void>;
		onLoggedOut?: () => void | Promise<void>;
	} = {},
): BoxcodeAuthProvider {
	const provider = new BoxcodeAuthProvider(hooks.onCredentialsSaved, hooks.onLoggedOut);
	context.subscriptions.push(
		vscode.authentication.registerAuthenticationProvider(AUTH_PROVIDER_ID, AUTH_PROVIDER_LABEL, provider, {
			supportsMultipleAccounts: false,
		}),
	);
	return provider;
}

/**
 * Opens the browser, shows a progress toast while polling, returns credentials
 * once the user approves on boxcode.sh. Shared by the auth provider and the
 * Sign In command / first-run wizard.
 */
export async function runBrowserDeviceLogin(
	token?: vscode.CancellationToken,
): Promise<AccountCredentials> {
	const base = authBaseUrl();
	const start = await startDeviceLogin(base);
	const url = verificationUrl(start);
	await vscode.env.openExternal(vscode.Uri.parse(url));

	const intervalMs = Math.max(1, start.interval ?? 2) * 1000;
	const deadline = Date.now() + 15 * 60 * 1000;

	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `boxcode: sign in — Device ID ${start.user_code}`,
			cancellable: true,
		},
		async (progress, progressToken) => {
			progress.report({
				message: 'Complete Google sign-in in the browser, then approve this device…',
			});
			while (Date.now() < deadline) {
				if (token?.isCancellationRequested || progressToken.isCancellationRequested) {
					throw new DeviceLoginError('Sign-in cancelled');
				}
				const outcome = await pollDeviceLogin(start.device_code, base);
				if (outcome.kind === 'approved') {
					if (!outcome.credentials.apiKey) {
						throw new DeviceLoginError('Sign-in succeeded but no API key was returned');
					}
					return outcome.credentials;
				}
				if (outcome.kind === 'expired') {
					throw new DeviceLoginError('Device code expired — try Sign In again');
				}
				if (outcome.kind === 'error') {
					throw new DeviceLoginError(outcome.message);
				}
				await sleep(intervalMs);
			}
			throw new DeviceLoginError('Timed out waiting for browser approval');
		},
	);
}

function sessionFromCredentials(
	creds: AccountCredentials,
	scopes: readonly string[],
): vscode.AuthenticationSession {
	const label = creds.email || 'boxcode.sh account';
	return {
		id: SESSION_ID,
		accessToken: creds.sessionToken || 'local',
		account: { id: label, label },
		scopes: [...scopes],
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
