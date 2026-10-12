# MCP server identity vs. the derived tool name

Status: **evidence update.** Re-bases `docs/MCP-permissions-decision.md` against the
approval layer that has since shipped in the CLI (`HolboxAI/boxcode`, `main`). It does
not overturn that brief's recommendation — it strengthens it, and adds a second,
independent way the derived name fails.

## What changed since the original brief

The CLI now has an MCP approval path (`Action::Mcp`, plus a `parse_tool_id` in
`src/mcp.rs`). Two consequences matter here:

- The CLI is **the only side that persists nothing**: its MCP approval always prompts
  and keeps no rule across sessions. The IDE is the side introducing persisted state,
  so the collision the original brief describes is the IDE's to solve.
- The CLI parses the server out of the `<server>__<tool>` id rather than storing the
  server separately. That is a second consumer of the same derived string, so whatever
  the IDE persists has to line up with an id that is already being re-interpreted
  elsewhere.

## The derived name is not a usable key (verified in-tree)

`src/stable/extensions/boxcode-agent/src/mcpConfig.ts`:

- `mcpToolName` (L452) builds `mcp__<sanitized server>__<sanitized tool>`.
- `parseMcpToolName` (L457) is the documented inverse, and its own docstring says the
  segments **"are sanitized, so they may differ from the originals."** The round trip is
  lossy by construction: the string cannot be used to recover the server name, so a
  permission keyed on it cannot be matched back to a server definition reliably.
- The JSDoc on `mcpToolName` (L442–451) already states the conclusion this brief argues
  for — a renamed server silently changes every derived tool name, persisted rules go
  stale, and the guidance is verbatim: *"Persist the server identity, not the derived
  tool name, or re-derive on load."*

So the recommendation is not a new proposal to argue for; it is a caveat the code
already commits to and the permission layer has not yet honoured.

## Interaction with the existing store

`permissionStore.ts` matches on a `kind` and a literal action string. A rule written
against an MCP tool therefore binds to the *text* of a derived id, which is exactly the
key the two points above show is unstable and non-invertible.

## The two sides sanitize in opposite directions (verified in both trees)

The CLI's rule and the IDE's rule are not the same rule, and they are not inverses:

| | CLI (`src/mcp.rs`) | IDE (`mcpConfig.ts`) |
|---|---|---|
| Characters kept | `A-Za-z0-9_-` | `A-Za-z0-9_` |
| `-` in a name | kept | folded to `_` |
| `_` in a name | folded to `-` (server segment) | kept |
| Two names folding together | rejected at config parse | no check found |

`server_id_fragment` (L152) is `slug(server).replace('_', "-")`, so a server fragment can
never contain the separator. That is what makes `parse_tool_id`'s split on the first `__`
unambiguous, and its docstring says so (L168–172). The same docstring states that two
server names collapsing onto one fragment "are rejected when the config is parsed", and a
test asserts exactly that (`src/mcp.rs:696`, error text contains `collide`).

The IDE folds the other way: `sanitizeSegment` (L438) replaces everything outside
`A-Za-z0-9_`, so `-` becomes `_` and `_` stays — the mirror image of the CLI. No collision
check was found in `mcpCatalog.ts` / `mcpConfig.ts`.

The same raw name therefore derives a *different* id on each side. The CLI's own test
(L701) pins the mapping: `tool_id("my server", "do.it")` is `"mcp__my-server__do_it"`,
where the IDE would derive `"mcp__my_server__do_it"` for that same server. A permission
persisted against one string does not match the other.

It is also worth being plain that neither mapping is injective. `my server`, `my-server`
and `my_server` all fold together. The CLI catches this while parsing the config and
refuses it; the IDE appears not to, so there the collision survives into a persisted rule.

## Still not confirmed

- whether the IDE's MCP modules reject two servers that sanitize to the same fragment —
  the greps found nothing, but that is an absence of hits, not proof of absence;
- the `ToolKind` variant the CLI maps `Action::Mcp` to on the ACP wire.

## Unrelated but current

`streamable-http` remains unimplemented in the CLI: it returns `"not implemented yet"`
at `src/mcp.rs:276`. Only stdio servers connect. This is a real feature gap, distinct
from the stale log message fixed earlier.
