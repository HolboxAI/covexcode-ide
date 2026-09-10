/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * No `vscode` import on purpose (see `cdpClient.ts`'s/`startupFailure.ts`'s
 * own doc comments for the same reasoning) -- kept plain so
 * `localhostUrl.test.ts` can exercise it directly.
 *
 * Deliberately scoped to `localhost`/`127.0.0.1`/`0.0.0.0` only, matching
 * `LocalhostLinkOpenerContribution`'s own authority check
 * (`browserTabManagementFeatures.ts`'s `isLocalhostAuthority`/
 * `isAllInterfacesAuthority`) -- this must never propose opening an
 * arbitrary URL a command's output happened to print (a build log quoting a
 * production URL, a curl target, a link in a README a command cat'd out).
 * A dev-server address is the one class of URL safe to open without the
 * model or the human asking: it points at something running on this same
 * machine, for this same user, right now.
 */
const LOCALHOST_URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{1,5})?[^\s'"<>)\]]*/i;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

/**
 * One key per local server, so `http://127.0.0.1:5173/` and
 * `http://localhost:5173` reuse the same Integrated Browser tab instead of
 * stacking a new one for every trailing-slash / loopback-host spelling.
 */
export function canonicalizeLocalhostUrl(raw: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return raw;
	}
	if (LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
		parsed.hostname = 'localhost';
	}
	if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) {
		parsed.port = '';
	}
	const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
	return `${parsed.protocol}//${parsed.host}${path}${parsed.search}${parsed.hash}`;
}

export function urlsAreSameLocalPage(left: string, right: string): boolean {
	return canonicalizeLocalhostUrl(left) === canonicalizeLocalhostUrl(right);
}

/** `http://localhost:5173` — one Integrated Browser pane per local server. */
export function localhostOrigin(raw: string): string {
	try {
		const parsed = new URL(canonicalizeLocalhostUrl(raw));
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return raw;
	}
}

export function urlsAreSameLocalOrigin(left: string, right: string): boolean {
	return localhostOrigin(left) === localhostOrigin(right);
}

export function isIdleBrowserUrl(url: string | undefined): boolean {
	return !url || url === 'about:blank';
}

export function findMatchingBrowserTab<T extends { url: string }>(tabs: readonly T[], url: string): T | undefined {
	return tabs.find(tab => urlsAreSameLocalPage(tab.url, url));
}

/**
 * Prefer the same page, then any tab already on that local origin, then an
 * unused `about:blank` pane — never a second editor for the same preview.
 */
export function findReusableBrowserTab<T extends { url: string }>(tabs: readonly T[], url: string): T | undefined {
	return findMatchingBrowserTab(tabs, url)
		?? tabs.find(tab => !isIdleBrowserUrl(tab.url) && urlsAreSameLocalOrigin(tab.url, url))
		?? tabs.find(tab => isIdleBrowserUrl(tab.url));
}

/**
 * Finds the first localhost/loopback URL in `text` (typically a shell
 * command's own stdout/stderr, e.g. Vite's "Local: http://localhost:5173/"),
 * or `undefined` if none appears. `0.0.0.0` / `127.0.0.1` are rewritten to
 * `localhost` so later tab reuse can match.
 */
export function findLocalhostUrl(text: string): string | undefined {
	const match = text.match(LOCALHOST_URL_PATTERN);
	if (!match) {
		return undefined;
	}
	// Logs and prose often put a URL at the end of a sentence. The greedy
	// path class above does not stop at `.` / `,` / `;`, so
	// "http://localhost:3000." would otherwise be opened as-is and miss.
	const url = match[0].replace(/[.,;:]+$/, '');
	return canonicalizeLocalhostUrl(url);
}
