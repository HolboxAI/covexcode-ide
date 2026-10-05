# MCP permissions — decision brief

**Status:** decision needed. This narrows the open questions in `MCP-permissions.md` to a
concrete choice; it does not replace that document's design.
**Date:** 2026-09-30

## Why this is the remaining blocker

MCP is connected on both sides, so permissions is now the only thing standing between the
current state and MCP being finished:

- CLI: `src/mcp.rs` parses `mcpServers` with per-server validation, `McpRegistry::connect_all`
  spawns the servers, and `src/transport.rs:149` calls `session.connect_mcp(&mcp_configs)`
  from `SessionActor::spawn` — deliberately off the request path, since the handshake takes
  seconds and `session/new` must reply first.
- IDE: `mcpCatalog` / `mcpConfig` / `mcpLoader` plus tests are on `main` and `dev`.

The permission store (`permissionStore.ts`) predates MCP tool names. It matches by `kind`
plus a literal action string, exact or prefix. That is fine for a fixed tool set and wrong
for names that are derived.

## The problem, precisely

MCP tool ids are derived from the **server name** (`mcpCatalog.ts`, `mcpToolName`) — the name
is part of the string that rules match against. So a rule persisted as
`allow mcp__github__list_repos` is bound to the text `github`, not to the server it came from.

Three consequences:

1. **Rename ⇒ silent rebind.** Rename the server and the persisted rule stops matching its
   intended target — fail-open for a deny rule, fail-closed for an allow rule. Either way it
   is the wrong failure mode for a store whose whole job is to grant lasting access.
2. **Name reuse ⇒ stale rule re-bound.** The CLI already rejects *simultaneous* id collisions
   at parse time (`src/mcp.rs:221`, asking the user to rename one), so two live servers cannot
   share an id. But a rule persisted from a server that has since been removed can be silently
   re-bound by a different server later claiming the same name.
3. **Scope leakage.** A rule granted in one workspace should not silently apply in another,
   and user-scope should not inherit workspace-scope grants.

## Recommendation: match on identity, not on a name

Persist a **stable server identity** alongside the display name, and match rules against the
resolved identity:

- Key rules on a stable id derived from the server *definition* — for stdio, the command plus
  args; for http, the URL — not on the display name.
- Keep the name as a **label only**: for the UI, and for constructing the tool id. Nothing
  that grants access should depend on it.
- On connect, resolve each server's id from its definition and match rules against that.
- If a server's definition changes materially, treat prior rules as **not yet granted** and
  re-ask. One extra prompt is a far cheaper failure than a silently-skipped deny.

This makes rename a non-event, kills the name-reuse rebind, and gives scope a place to live
in the key.

## Second open item — found in this audit, independent of permissions

The CLI comment above `parse_servers` is close to right, but the IDE's copy of it is stale, so
the two disagree. Concretely:

- **Stale half.** `src/mcpConfig.ts` (~L387) says the CLI "parses this field as an untyped
  `Vec<serde_json::Value>` and ignores it." No longer true — the CLI parses it typed, validates
  each server, and connects.
- **Still-true half.** The same comment says the `streamable-http` variant "must be agreed with
  the CLI before either side relies on it." **Still accurate, and still unimplemented:** the CLI
  returns `Err("streamable-http servers are not implemented yet")` (`src/mcp.rs:276`). Only stdio
  actually runs today.

That matters for this decision: the definition-hash scheme is load-bearing for stdio now, but
the http shape has to be pinned before either side persists rules against it.

## What the maintainer is being asked to choose

1. **Key:** definition-derived stable id (recommended), or name + scope?
2. **On a material definition change:** re-prompt (recommended) or carry rules forward?
3. **Scope:** where does workspace-vs-user scope live in the key — prefix, separate store, or
   a field on the rule?

Two smaller cleanups fall out of this brief and are independent of the answers:
update the stale `mcpConfig.ts` comment, and fix the same stale claim in the CLI's
`src/transport.rs` (already done — PR #190).
