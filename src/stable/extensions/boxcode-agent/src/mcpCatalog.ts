/*---------------------------------------------------------------------------------------------
 *  Copyright (c) HolboxAI. Licensed under the MIT License. See LICENSE in the repository root.
 *--------------------------------------------------------------------------------------------*/

import { McpHttpServer, McpServer, McpStdioServer, McpTransport } from './mcpConfig';

/**
 * A curated list of MCP servers a developer is likely to want, so that adding one is
 * picking from a list rather than writing JSON from memory.
 *
 * ## On `verified`
 *
 * Every entry ships with `verified: false`, deliberately, and that is not an oversight.
 *
 * The catalog is static data - it cannot reach the package registry or the vendor's docs,
 * so it has no way to confirm that a launch recipe is still correct. MCP servers move
 * fast: the reference implementations under `modelcontextprotocol/servers` have been
 * reorganised more than once, several have been archived outright, and vendors migrate
 * from a local stdio package to a hosted endpoint without the old recipe stopping
 * working *silently* - the server just fails to start, or starts with a stale tool list.
 *
 * So an entry here is a *lead*, not a guarantee. A recipe is only promoted to
 * `verified: true` once someone has actually launched it and seen the tool list come
 * back; `unverifiedCatalogIds()` exists to make the outstanding work visible rather than
 * letting it hide behind a confident-looking table. Nothing in this file should be
 * presented to the user as "known good" until that has happened.
 *
 * `source` records provenance instead, which *is* knowable offline: who publishes it.
 */

export type McpCatalogCategory =
	| 'filesystem'
	| 'version-control'
	| 'cloud'
	| 'productivity'
	| 'communication'
	| 'data'
	| 'web'
	| 'devtools';

/** Who publishes the server, which is a question this file can answer without network access. */
export type McpCatalogSource = 'official-reference' | 'vendor' | 'community';

export interface McpCatalogEntry {
	readonly id: string;
	readonly label: string;
	readonly summary: string;
	readonly category: McpCatalogCategory;
	readonly source: McpCatalogSource;
	readonly transport: McpTransport;
	/** Present exactly when `transport` is `stdio`. */
	readonly command?: string;
	readonly args?: readonly string[];
	/** Present exactly when `transport` is `streamable-http`. */
	readonly url?: string;
	/**
	 * Whether the server needs credentials before it can be used. Entries flagged here
	 * need an authorization flow (MCP authorizes at the transport level, OAuth 2.1 for
	 * remote servers); a stdio server usually reads a token out of `env` instead.
	 */
	readonly requiresAuth: boolean;
	readonly verified: boolean;
	/** Where a human would confirm the launch recipe. */
	readonly docs?: string;
}

/**
 * The catalog.
 *
 * Ordering is meaningful only in that local, no-auth, single-purpose servers come first:
 * they are the ones that can be brought up and proven end to end before any OAuth stack
 * exists. The cloud and SaaS entries are the hard end of this list, not the easy end.
 */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
	// --- Local, no auth: the ones worth proving the plumbing with ------------------------
	{
		id: 'filesystem',
		label: 'Filesystem',
		summary: 'Read and write files under directories you explicitly grant.',
		category: 'filesystem',
		source: 'official-reference',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
		requiresAuth: false,
		verified: false,
		docs: 'https://github.com/modelcontextprotocol/servers'
	},
	{
		id: 'git',
		label: 'Git',
		summary: 'Inspect history, diffs and branches of a local repository.',
		category: 'version-control',
		source: 'official-reference',
		transport: 'stdio',
		command: 'uvx',
		args: ['mcp-server-git', '--repository', '.'],
		requiresAuth: false,
		verified: false,
		docs: 'https://github.com/modelcontextprotocol/servers'
	},
	{
		id: 'memory',
		label: 'Memory',
		summary: 'A persistent knowledge graph the agent can write to across sessions.',
		category: 'devtools',
		source: 'official-reference',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-memory'],
		requiresAuth: false,
		verified: false,
		docs: 'https://github.com/modelcontextprotocol/servers'
	},
	{
		id: 'fetch',
		label: 'Fetch',
		summary: 'Retrieve a URL and convert it to markdown for the model to read.',
		category: 'web',
		source: 'official-reference',
		transport: 'stdio',
		command: 'uvx',
		args: ['mcp-server-fetch'],
		requiresAuth: false,
		verified: false,
		docs: 'https://github.com/modelcontextprotocol/servers'
	},
	{
		id: 'sequential-thinking',
		label: 'Sequential Thinking',
		summary: 'An explicit scratchpad for multi-step reasoning.',
		category: 'devtools',
		source: 'official-reference',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
		requiresAuth: false,
		verified: false,
		docs: 'https://github.com/modelcontextprotocol/servers'
	},
	{
		id: 'everything',
		label: 'Everything (conformance)',
		summary: 'A test server exposing every MCP feature; useful for verifying a client.',
		category: 'devtools',
		source: 'official-reference',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-everything'],
		requiresAuth: false,
		verified: false,
		docs: 'https://github.com/modelcontextprotocol/servers'
	},
	{
		id: 'sqlite',
		label: 'SQLite',
		summary: 'Query and inspect a local SQLite database file.',
		category: 'data',
		source: 'community',
		transport: 'stdio',
		command: 'uvx',
		args: ['mcp-server-sqlite', '--db-path', './data.db'],
		requiresAuth: false,
		verified: false,
		docs: 'https://github.com/modelcontextprotocol/servers'
	},

	// --- Developer tooling --------------------------------------------------------------
	{
		id: 'github',
		label: 'GitHub',
		summary: 'Issues, pull requests, releases and repository metadata.',
		category: 'version-control',
		source: 'vendor',
		transport: 'streamable-http',
		url: 'https://api.githubcopilot.com/mcp/',
		requiresAuth: true,
		verified: false,
		docs: 'https://docs.github.com/en/copilot'
	},
	{
		id: 'gitlab',
		label: 'GitLab',
		summary: 'Merge requests, issues and pipelines.',
		category: 'version-control',
		source: 'vendor',
		transport: 'streamable-http',
		url: 'https://gitlab.com/api/v4/mcp',
		requiresAuth: true,
		verified: false,
		docs: 'https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/'
	},
	{
		id: 'playwright',
		label: 'Playwright',
		summary: 'Drive a real browser: navigate, click, fill forms, assert on the page.',
		category: 'web',
		source: 'vendor',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@playwright/mcp@latest'],
		requiresAuth: false,
		verified: false,
		docs: 'https://github.com/microsoft/playwright-mcp'
	},
	{
		id: 'sentry',
		label: 'Sentry',
		summary: 'Read issues, stack traces and releases from a Sentry project.',
		category: 'devtools',
		source: 'vendor',
		transport: 'streamable-http',
		url: 'https://mcp.sentry.dev/mcp',
		requiresAuth: true,
		verified: false,
		docs: 'https://docs.sentry.io/product/sentry-mcp/'
	},
	{
		id: 'context7',
		label: 'Context7',
		summary: 'Up-to-date library documentation injected into the prompt on request.',
		category: 'devtools',
		source: 'community',
		transport: 'streamable-http',
		url: 'https://mcp.context7.com/mcp',
		requiresAuth: false,
		verified: false,
		docs: 'https://context7.com/'
	},

	// --- Cloud providers: the hard end. OAuth 2.1, not a static token. --------------------
	{
		id: 'aws',
		label: 'AWS',
		summary: 'Interrogate AWS services - docs, and per-service MCP servers.',
		category: 'cloud',
		source: 'vendor',
		transport: 'stdio',
		command: 'uvx',
		args: ['awslabs.core-mcp-server@latest'],
		requiresAuth: true,
		verified: false,
		docs: 'https://github.com/awslabs/mcp'
	},
	{
		id: 'gcp',
		label: 'Google Cloud (gcloud)',
		summary: 'Run against GCP resources using the local gcloud credential chain.',
		category: 'cloud',
		source: 'vendor',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@google-cloud/gcloud-mcp'],
		requiresAuth: true,
		verified: false,
		docs: 'https://github.com/googleapis/gcloud-mcp'
	},
	{
		id: 'azure',
		label: 'Azure',
		summary: 'Read and manage Azure resources through an Azure MCP server.',
		category: 'cloud',
		source: 'vendor',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@azure/mcp@latest', 'server', 'start'],
		requiresAuth: true,
		verified: false,
		docs: 'https://github.com/microsoft/mcp'
	},

	// --- Productivity and communication ---------------------------------------------------
	{
		id: 'gmail',
		label: 'Gmail',
		summary: 'Search, read and draft mail in a Google account.',
		category: 'communication',
		source: 'community',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
		requiresAuth: true,
		verified: false,
		docs: 'https://www.npmjs.com/package/@gongrzhe/server-gmail-autoauth-mcp'
	},
	{
		id: 'google-drive',
		label: 'Google Drive',
		summary: 'Search and read files in a Google Drive account.',
		category: 'productivity',
		source: 'community',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-gdrive'],
		requiresAuth: true,
		verified: false,
		docs: 'https://github.com/modelcontextprotocol/servers'
	},
	{
		id: 'notion',
		label: 'Notion',
		summary: 'Read and search Notion pages and databases.',
		category: 'productivity',
		source: 'vendor',
		transport: 'streamable-http',
		url: 'https://mcp.notion.com/mcp',
		requiresAuth: true,
		verified: false,
		docs: 'https://developers.notion.com/docs/mcp'
	},
	{
		id: 'linear',
		label: 'Linear',
		summary: 'Issues, projects and cycles.',
		category: 'productivity',
		source: 'vendor',
		transport: 'streamable-http',
		url: 'https://mcp.linear.app/mcp',
		requiresAuth: true,
		verified: false,
		docs: 'https://linear.app/docs/mcp'
	},
	{
		id: 'slack',
		label: 'Slack',
		summary: 'Read channels and post messages.',
		category: 'communication',
		source: 'community',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-slack'],
		requiresAuth: true,
		verified: false,
		docs: 'https://github.com/modelcontextprotocol/servers'
	},
	{
		id: 'brave-search',
		label: 'Brave Search',
		summary: 'Web and local search through the Brave API.',
		category: 'web',
		source: 'vendor',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-brave-search'],
		requiresAuth: true,
		verified: false,
		docs: 'https://github.com/modelcontextprotocol/servers'
	},
	{
		id: 'postgres',
		label: 'PostgreSQL',
		summary: 'Read-only schema inspection and queries against a Postgres database.',
		category: 'data',
		source: 'official-reference',
		transport: 'stdio',
		command: 'npx',
		args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/postgres'],
		requiresAuth: true,
		verified: false,
		docs: 'https://github.com/modelcontextprotocol/servers'
	}
];

/** Unique categories actually used by the catalog, in catalog order. */
export function catalogCategories(): readonly McpCatalogCategory[] {
	const seen: McpCatalogCategory[] = [];
	for (const entry of MCP_CATALOG) {
		if (!seen.includes(entry.category)) {
			seen.push(entry.category);
		}
	}
	return seen;
}

/** Catalog entries grouped by category, preserving catalog order within each group. */
export function catalogByCategory(): ReadonlyMap<McpCatalogCategory, readonly McpCatalogEntry[]> {
	const grouped = new Map<McpCatalogCategory, McpCatalogEntry[]>();
	for (const entry of MCP_CATALOG) {
		const bucket = grouped.get(entry.category);
		if (bucket) {
			bucket.push(entry);
		} else {
			grouped.set(entry.category, [entry]);
		}
	}
	return grouped;
}

/** Look up one entry by its stable id. */
export function findCatalogEntry(id: string): McpCatalogEntry | undefined {
	return MCP_CATALOG.find(entry => entry.id === id);
}

/**
 * Substring search over id, label, summary and category, case-insensitive.
 * An empty or whitespace-only query returns the whole catalog.
 */
export function searchCatalog(query: string): readonly McpCatalogEntry[] {
	const needle = query.trim().toLowerCase();
	if (needle === '') {
		return MCP_CATALOG;
	}
	return MCP_CATALOG.filter(entry =>
		entry.id.toLowerCase().includes(needle)
		|| entry.label.toLowerCase().includes(needle)
		|| entry.summary.toLowerCase().includes(needle)
		|| entry.category.toLowerCase().includes(needle)
	);
}

/**
 * Turn a catalog entry into a server declaration ready to be written into config.
 *
 * The entry's `id` is used as the server name unless one is given, so that rules learned
 * later - a permission rule, say - attach to a stable name rather than to whatever the
 * user typed. Throws rather than returning something half-formed if the entry does not
 * carry the fields its transport requires.
 */
export function catalogEntryToServer(entry: McpCatalogEntry, name: string = entry.id): McpServer {
	if (entry.transport === 'stdio') {
		if (!entry.command) {
			throw new Error(`Catalog entry '${entry.id}' declares stdio transport but no command.`);
		}
		const server: McpStdioServer = {
			name,
			transport: 'stdio',
			command: entry.command,
			...(entry.args ? { args: entry.args } : {})
		};
		return server;
	}

	if (!entry.url) {
		throw new Error(`Catalog entry '${entry.id}' declares streamable-http transport but no url.`);
	}
	const server: McpHttpServer = {
		name,
		transport: 'streamable-http',
		url: entry.url
	};
	return server;
}

/** Ids of entries whose launch recipe still needs to be confirmed by hand. */
export function unverifiedCatalogIds(): readonly string[] {
	return MCP_CATALOG.filter(entry => !entry.verified).map(entry => entry.id);
}

export interface McpCatalogStats {
	readonly total: number;
	readonly verified: number;
	readonly unverified: number;
	readonly requiresAuth: number;
	readonly byCategory: Readonly<Record<string, number>>;
	readonly byTransport: Readonly<Record<string, number>>;
	readonly bySource: Readonly<Record<string, number>>;
}

function tally(values: readonly string[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const value of values) {
		counts[value] = (counts[value] ?? 0) + 1;
	}
	return counts;
}

/** Summary counts for the catalog, for a status line or a test assertion. */
export function catalogStats(): McpCatalogStats {
	const verified = MCP_CATALOG.filter(entry => entry.verified).length;
	return {
		total: MCP_CATALOG.length,
		verified,
		unverified: MCP_CATALOG.length - verified,
		requiresAuth: MCP_CATALOG.filter(entry => entry.requiresAuth).length,
		byCategory: tally(MCP_CATALOG.map(entry => entry.category)),
		byTransport: tally(MCP_CATALOG.map(entry => entry.transport)),
		bySource: tally(MCP_CATALOG.map(entry => entry.source))
	};
}
