# MCP support — design

**Superseded (2026-10-07).** This document was written 2026-09-18 when nothing was
built, and the implementation has since landed. It is kept for the reasoning and the
verified seam, not as a status report. Specifically, the claims below that the CLI
"ignores" `mcpServers` are no longer true:

- The CLI parses the field into typed server configs (`src/mcp.rs`), and `headless.rs`
  builds an `McpRegistry` and genuinely connects (`connect_all`).
- `session/new` passes the configs into `SessionActor::spawn`, which calls
  `session.connect_mcp()` — off the request path, since handshaking takes seconds.
- The IDE half is implemented too: `mcpCatalog` / `mcpConfig` / `mcpLoader`, with tests.

For current state see `MCP-permissions.md` (permissions, still an open decision) and
`MCP-verification.md` (a historical probe against CLI 1.11.40).

## Why this is smaller than it sounds

The wire slot for MCP already exists and is already reserved. Two verified facts:

1. The extension already sends the field — `acpClient.ts:345`:
   ```ts
   const result = (await this.request('session/new', { cwd, mcpServers: [] })) as { sessionId ... }
   ```
2. The CLI declares the field — `src/protocol.rs:245-249`. **Status note (superseded in
   part):** the reading that the CLI *ignores* it is out of date. `src/mcp.rs` parses each
   entry into a server config, and `session/new` hands those configs to
   `SessionActor::spawn`, which calls `connect_mcp` — so they are genuinely used. The source
   comment quoted below may itself be stale:
   ```rust
   /// Required by the v1 schema (`required: ["cwd", "mcpServers"]`) --
   /// ... doesn't act as an MCP client yet
   #[serde(rename = "mcpServers", default)]
   pub mcp_servers: Vec<serde_json::Value>,
   ```

So MCP is not a new channel, a new subsystem, or a new protocol to invent. It is **two
implementations joined at a field that both sides already agree on**. That is what makes
this worth doing now rather than after a from-scratch connector framework.

### Accepted is not the same as understood (proven, not assumed)

Fact 2 above was read from source; it has since been **confirmed by execution**. The
installed CLI was driven with a `session/new` whose `mcpServers` entry pointed at a marker
command that writes a file when spawned:

- `initialize` returned `agentCapabilities` with `promptCapabilities.image` and a `session`
  key, and **no MCP capability of any kind**
- `session/new` carried a real `mcpServers` entry and returned a session id, **with no error**
- the marker file **was never created** — the server was not spawned

This is the failure mode that matters. `mcpServers` is *required* by the v1 schema, so an
agent that has no MCP support still **accepts the field, reports success, and connects
nothing**. From the client side that is indistinguishable from working MCP. For a feature
that spawns processes and grants lasting access, a silent no-op is the wrong failure.

**Therefore: an explicit MCP capability in the `initialize` response is a requirement, not
a nicety.** The extension must gate on it and refuse to send `mcpServers` when absent.
See `docs/MCP-verification.md` for the raw exchange.

## The split: who owns what

MCP is a *client* speaking to *servers*. The process split follows the sandbox and the
existing permission model, not convenience.

| Concern | Owner | Why |
| --- | --- | --- |
| Server config: add/remove/enable, secrets | Extension | It has settings UI, the secret store, and the user's trust context |
| Server catalog / presets | Extension | Pure data; testable without `vscode` |
| Spawning + connecting to servers | **CLI** | It owns the tool loop, the cwd, and the tool-call gate |
| Tool discovery (`tools/list`) | CLI | Discovered tools must land in the same registry as built-ins |
| Tool invocation | CLI | Must pass through the *same* approval gate — no bypass path |
| Rendering an MCP tool call in chat | Extension | Existing tool-call rendering already handles the frame |

**The rule that matters: an MCP tool call is not privileged.** It goes through the same
`tool_call` → permission command-link → `verdict_for` path as a built-in tool. If MCP
tools could execute without passing that gate, the whole permission story in
`chatPermission.ts` becomes decorative. A third-party server is *less* trustworthy than
the built-in tools, so this is the one non-negotiable constraint in this design.

## Config format

Follows the de-facto standard shape, so existing server snippets paste in unchanged:

```jsonc
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${secret:github.token}" }
    },
    "linear": {
      "type": "streamable-http",
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer ${secret:linear.token}" }
    }
  }
}
```

Notes:
- `type` is explicit rather than inferred — inferring stdio-vs-http from the presence of
  `command` vs `url` is exactly the kind of guess that produces a confusing failure.
- Both transports must be supported. The spec requires a conformant client to support at
  least one of stdio and Streamable HTTP, and to *should* support both; stdio-only is the
  common shortcut and it excludes every hosted server.
- `${secret:...}` resolves against the extension secret store, never into plain files.
  This is the one place the earlier "app-level secrets" backlog row (L107) genuinely
  overlaps — worth reconciling rather than building twice.
- Committed vs local scope: a repo's `.boxcode/mcp.json` should be committable (shared
  server definitions) while tokens stay in the secret store. Same split as
  `.boxcode/permissions.json` in PR #102.

## Catalog: what developers actually install

Ship presets, not just a blank config box. Ordered by how often they show up in practice:

**Tier 1 — near-universal**
- **GitHub** — issues, PRs, code search. Hosted now; the `npx` server is legacy.
- **Filesystem** — reference implementation, good first test target since it needs no auth or network.
- **Fetch / web** — URL retrieval; low risk, no credentials.
- **Puppeteer / Playwright** — browser automation; overlaps L91's `interact_in_browser`.
- **Context7** — versioned library docs; directly complements the existing `@`-mention work (L36).

**Tier 2 — the named clouds/identity targets**
- **AWS** — two shapes: the official AWS MCP servers (docs, CDK, cost) and the
  `aws-api` style server exposing broad API calls. The second needs an IAM story:
  which credentials, which region, read-only or not.
- **GCP** — auth is the whole problem; ADC or a service-account JSON path via `${secret:}`.
- **Gmail** — OAuth, so it has the heaviest consent flow of the set. Defer behind the others.
- **GitLab / Jira / Slack / Linear / Sentry / Postgres / Notion** — long tail, all fit the
  same two transports.

The presets should be *templates with placeholders*, not one-click installs that
silently acquire credentials. A preset that appears to work and has actually connected
with the user's ambient cloud credentials is a security bug wearing a convenience
feature's clothes.

## Transports — current spec state

Spec revision **2026-07-28** is current (previous: 2025-11-25). Relevant points:
- Streamable HTTP replaces the old HTTP+SSE transport: single endpoint, POST per
  JSON-RPC message.
- It **requires** `Mcp-Method` and `Mcp-Name` headers (SEP-2243) so gateways can route
  without parsing the body; mismatches between headers and body are rejected.
- Authorization is defined at the transport level (OAuth-style), which is why hosted
  servers are a different amount of work from local ones.

Rust side: this doc recommended `rmcp` (the official SDK, implementing 2026-07-28 while
staying compatible with 2025-11-25) over hand-rolled JSON-RPC framing — the version
negotiation and header mirroring being exactly where a hand-rolled client rots.
**That is not what shipped.** The CLI hand-rolled the client in `src/mcp.rs`, and
`streamable-http` is still unimplemented there (`src/mcp.rs:276`, "not implemented
yet"). Read this as intent, not as a description of the code.

## Phased plan

**Phase 1 — the seam, end to end, with one local server.**
CLI: consume `mcp_servers`, connect over stdio, `initialize`, `tools/list`, merge the
discovered tools into the dispatch match, route invocation through the existing
permission gate. Extension: populate `mcpServers` from config instead of `[]`.
Prove it with **Filesystem** — no auth, no network, so a failure is definitely our bug.

**Phase 2 — config surface.** Settings UI, `${secret:}` resolution, presets, per-server
enable/disable, and a visible connected/failed state. A server that failed to start must
say so in the UI; silent absence is indistinguishable from "no tools" and will be the
most common bug report.

**Phase 3 — hosted transports.** Streamable HTTP with the required headers, then auth.

**Phase 4 — the identity/credential story** (the original AWS/GCP/GitHub/Gmail ask):
per-server credential scoping, read-only-by-default where the server allows it, and
reconciliation with the CLI's existing `config.tools.approval` and PR #102's store.

## Open questions — status as of 2026-10-07

1. **Which repo first?** *(Both done.)* The CLI was the load-bearing half and it is
   implemented in `HolboxAI/boxcode` (`src/mcp.rs`); that clone is **no longer stale** — it
   sits level with `origin/main`, so the worktree is safe to read directly. The extension
   half is no longer inert either: it sends `mcpServers` in `session/new`, gated on
   `agentSupportsMcp`, so it is not "config that silently does nothing".
2. **Is `rmcp` acceptable as a dependency?** *(Decided, differently.)* This doc
   recommended `rmcp`; the CLI instead **hand-rolled** the client in `src/mcp.rs`, and no
   manifest carries an `rmcp` dependency. The "Transports" section below therefore
   describes an intent that was not taken.
3. **Trust model for tool names.** *(Implemented as recommended, with a caveat.)*
   Tool ids are namespaced by `mcpToolName` (`mcp__<server>__<tool>`), so two servers'
   `search` cannot shadow each other. What remains open is not the namespacing but what
   a *persisted* rule binds to — see `MCP-permissions-decision.md`.
4. **How does this relate to `config.tools.approval`?** *(Still open — now the single
   blocking decision.)* Same overlap already flagged on PR #102; MCP makes it sharper,
   because per-server trust is a natural granularity that a global approval list does
   not have. Narrowed to a concrete choice in `MCP-permissions-decision.md`.
5. **Does the earlier "connectors" idea still exist separately?** If MCP covers
   AWS/GCP/GitHub/Gmail, the separate connector registry is probably unnecessary — worth
   confirming rather than building both.

## What not to do

- Do not let MCP tools bypass the permission gate. (Restated because it is the one
  decision that is expensive to reverse.)
- Do not auto-install presets that acquire credentials without an explicit step.
- Do not build an abstraction over "connectors" before MCP proves the shape.
- Do not start with Gmail. OAuth consent is the least representative first case.
- **Do not ship the extension half before the CLI advertises an MCP capability.**
  Accepting `mcpServers` proves nothing (see above); without the handshake the extension
  will report MCP support while connecting nothing.
- Do not rely on `--version` to decide MCP support. `--acp` itself is undocumented in
  `--help`, which is exactly why capability probing is the existing convention.
