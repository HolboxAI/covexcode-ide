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
 * arbitrary URL a shell command happened to print (a build log quoting a
 * production URL, a curl target, a link in a README a command cat'd out).
 * A dev-server address is the one class of URL safe to open without the
 * model or the human asking: it points at something running on this same
 * machine, for this same user, right now.
 */
const LOCALHOST_URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{1,5})?[^\s'"<>)\]]*/i;

/**
 * Finds the first localhost/loopback URL in `text` (typically a shell
 * command's own stdout/stderr, e.g. Vite's "Local: http://localhost:5173/"),
 * or `undefined` if none appears. `0.0.0.0` is what a dev server binding to
 * every interface actually prints, but isn't itself a fetchable address --
 * rewritten to `localhost`, which is.
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
	return url.replace(/^(https?:\/\/)0\.0\.0\.0/i, '$1localhost');
}
