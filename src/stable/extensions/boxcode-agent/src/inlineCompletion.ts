/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tab-style predictive multi-line completion: the pure, testable half of
 * boxcode's inline completion provider. It builds a fill-in-the-middle prompt
 * from the text around the cursor, posts it to the user's OpenAI-compatible
 * endpoint, and parses the continuation back.
 *
 * No `vscode` import on purpose -- same posture as `referenceContent.ts`, so
 * `inlineCompletion.test.ts` can exercise the prompt/payload/parse logic
 * without an extension host. The vscode wiring lives in
 * `inlineCompletionProvider.ts`; the network fetch is injected so a test can
 * pass a fake.
 */

export const DEFAULT_MAX_TOKENS = 256;
export const MAX_PREFIX_CHARS = 12_000;
export const MAX_SUFFIX_CHARS = 2_000;

export interface CompletionRequest {
	url: string;
	headers: Record<string, string>;
	body: {
		model: string;
		messages: Array<{ role: 'system' | 'user'; content: string }>;
		max_tokens: number;
		/**
		 * Disables a reasoning model's chain-of-thought so a completion comes
		 * back fast instead of burning the whole token budget "thinking" and
		 * returning an empty `content` (observed with `finish_reason: "length"`).
		 */
		reasoning_effort?: 'none';
	};
}

export interface CompletionContext {
	prefix: string;
	suffix: string;
}

export interface BoxcodeConfigToml {
	endpoint?: string;
	model?: string;
	apiKey?: string;
}

/**
 * Build the chat-completions URL, tolerating the same shapes the CLI does in
 * `src/llm.rs::chat_completions_url`: `https://host`, `https://host/`,
 * `https://host/v1`, `https://host/openai`, or the full endpoint path.
 */
export function chatCompletionsUrl(endpoint: string): string {
	const base = endpoint.trim().replace(/\/+$/, '');
	if (base.endsWith('/chat/completions')) {
		return base;
	}
	if (base.endsWith('/v1') || base.endsWith('/openai')) {
		return `${base}/chat/completions`;
	}
	return `${base}/v1/chat/completions`;
}

/**
 * Slices the text immediately around a character offset into the before-cursor
 * and after-cursor halves, capped so a huge file never becomes a huge prompt.
 */
export function extractContext(fullText: string, offset: number, maxPrefix: number, maxSuffix: number): CompletionContext {
	const prefix = fullText.slice(Math.max(0, offset - maxPrefix), offset);
	const suffix = fullText.slice(offset, offset + maxSuffix);
	return { prefix, suffix };
}

/**
 * Pulls the `[llm]` `endpoint`/`model`/`api_key` out of a
 * `~/.boxcode/config.toml` blob. Deliberately a tiny hand-rolled parser for
 * boxcode's flat, machine-written `key = "value"` shape -- no TOML dependency
 * for three known fields -- so someone who configured boxcode from the CLI gets
 * completions even before signing into the IDE.
 */
export function parseBoxcodeConfigToml(toml: string): BoxcodeConfigToml {
	const out: BoxcodeConfigToml = {};
	let inLlm = false;
	for (const raw of (toml ?? '').split(/\r?\n/)) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) {
			continue;
		}
		if (line === '[llm]') {
			inLlm = true;
			continue;
		}
		if (inLlm && line.startsWith('[') && line.endsWith(']')) {
			break;
		}
		if (!inLlm) {
			continue;
		}
		const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match) {
			continue;
		}
		const key = match[1];
		let value = match[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (key === 'endpoint') {
			out.endpoint = value;
		} else if (key === 'model') {
			out.model = value;
		} else if (key === 'api_key') {
			out.apiKey = value;
		}
	}
	return out;
}

export function buildCompletionMessages(filePath: string, languageId: string, prefix: string, suffix: string): { system: string; user: string } {
	const system = 'You are a code completion engine. Complete the code exactly where the cursor is, matching the style of the surrounding file. Output ONLY the text to insert after the cursor: no code fences, no explanation, and do not repeat code that is already present.';
	const user = [
		`File: ${filePath}`,
		`Language: ${languageId || 'unknown'}`,
		'',
		'<before>',
		prefix,
		'</before>',
		'',
		'<after>',
		suffix,
		'</after>',
		'',
		'Output only the exact characters to insert at the cursor (between <before> and <after>).',
	].join('\n');
	return { system, user };
}

export function buildCompletionRequest(
	endpoint: string,
	model: string,
	apiKey: string,
	filePath: string,
	languageId: string,
	prefix: string,
	suffix: string,
): CompletionRequest {
	const { system, user } = buildCompletionMessages(filePath, languageId, prefix, suffix);
	return {
		url: chatCompletionsUrl(endpoint),
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: {
			model,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user },
			],
			max_tokens: DEFAULT_MAX_TOKENS,
			reasoning_effort: 'none',
		},
	};
}

/**
 * Strips any wrapping or stray code fence the model emitted so it never shows
 * up as ghost text, then trims to the actual continuation.
 */
export function parseCompletionResponse(text: string): string {
	let out = (text ?? '').trim();
	out = out.replace(/^```[^\n]*\n?/, '');
	out = out.replace(/\n?```$/, '');
	return out.trim();
}

/**
 * Models often echo the tail of what was already typed (a "pri" before the
 * cursor plus a "print(...)" completion would otherwise duplicate the "pri").
 * Strip the longest suffix of the prefix that the completion repeats, so what
 * remains is exactly what to insert. Only the last line or so of the prefix is
 * considered -- a cross-line repeat is not a real overlap.
 */
export function trimPrefixOverlap(prefix: string, completion: string): string {
	const tail = prefix.slice(-120);
	const max = Math.min(completion.length, tail.length);
	for (let n = max; n > 0; n--) {
		if (completion.startsWith(tail.slice(tail.length - n))) {
			return completion.slice(n);
		}
	}
	return completion;
}

/**
 * Posts a completion request and returns the raw model text. Throws on a
 * non-2xx or a body with no text; the caller decides how to degrade.
 */
export async function requestCompletion(request: CompletionRequest, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<string> {
	const res = await fetchImpl(request.url, {
		method: 'POST',
		headers: request.headers,
		body: JSON.stringify(request.body),
		signal,
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`completion request failed (${res.status}): ${detail.slice(0, 200)}`);
	}
	const json = await res.json() as { choices?: Array<{ message?: { content?: unknown }; text?: unknown }> };
	const content = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text;
	if (typeof content !== 'string') {
		throw new Error('completion response had no text');
	}
	return content;
}
