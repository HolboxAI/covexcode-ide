/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Chat markdown must never carry a full screenshot as a `data:` URL.
 * `check_in_browser` returns a PNG as base64 for the *model*; splicing that
 * into `stream.markdown` dumps tens of thousands of characters into the
 * transcript. VS Code's chat renderer does not treat a multi-hundred-KB
 * data URI as an image -- it prints the raw base64 and the panel becomes
 * unusable. The human already sees the live page in the Integrated Browser.
 */

const DATA_URI_PATTERN = /data:(image\/[a-zA-Z0-9.+-]+);base64,[A-Za-z0-9+/=\s]+/gi;

export const BROWSER_PREVIEW_NOTICE = 'Preview is in the Integrated Browser.';

export function describeBrowserPreview(): string {
	return BROWSER_PREVIEW_NOTICE;
}

export function stripOversizedDataUris(text: string, maxChars = 2048): string {
	return text.replace(DATA_URI_PATTERN, (match, mime: string) => {
		if (match.length <= maxChars) {
			return match;
		}
		return `[${mime} — ${BROWSER_PREVIEW_NOTICE}]`;
	});
}
