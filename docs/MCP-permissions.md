# MCP tools and the persistent permission store

Status: proposal, needs a maintainer decision before MCP tools flow through the
permission prompt.

## The collision

PR #102 adds a persistent permission store whose rules match on an exact
`{ kind, action }` pair, with deny beating allow. That is the right model for the
built-in tools, whose names are fixed and known at compile time (`run_command`,
`write_file`, `read_file`).

MCP tool names are neither fixed nor known at compile time. They are:

- **dynamic** — a server decides its own tool list at runtime, and the list often
  changes between versions of that server;
- **namespaced per server** — the id a tool presents as is derived from the server
  it came from, so `mcp__github__create_issue` names two things: the server, and
  the tool.

A rule persisted against a concrete tool id therefore has two ways to go stale,
and they fail in opposite directions:

| Event | Effect on a persisted rule | Failure mode |
| --- | --- | --- |
| Server renamed in config | Rule no longer matches anything | Fails **closed** — user is re-prompted. Noisy but safe. |
| Tool removed or renamed upstream | Rule no longer matches | Fails **closed** — safe, noisy. |
| Server name reused for a *different* server | Rule matches the new server's tool | Fails **open** — lasting access granted to something the user never approved. |
| Same tool name, different server | Rule matches the other server's tool | Fails **open** — same problem. |

The last two are the ones that matter. This is a store that grants *lasting*
access, so matching a rule to the wrong server is the one outcome that must not
happen — and it is reachable through no user error at all, just a rename or a
name being reused.

## Proposal: separate a rule's identity from its display name

The fix is to stop using the human-facing name as the key.

A rule for an MCP tool records:

- `serverId` — a stable identifier minted when the server is first registered,
  stored alongside the server definition in the workspace config, and **never
  derived from the display name**;
- `configHash` — a hash of the server's transport and endpoint (`command` + `args`
  for stdio, `url` for http), so a rule is bound to a specific server *definition*,
  not just a label;
- `tool` — the tool name as the server reports it;
- `createdAt` and `source` — already in `PermissionRule`, kept for auditability.

Matching then becomes, in order:

1. If any deny rule matches `{ serverId, tool }`, deny.
2. If an allow rule matches `{ serverId, tool }` **and** its `configHash` equals the
   server's current hash, allow.
3. If the hash differs, treat as unmatched → re-prompt. A changed command or URL
   means this may no longer be the server the user approved.

Consequences worth stating plainly:

- **A rename is safe.** The display name can change freely; `serverId` is what the
  rule is keyed on, so nothing goes stale and nothing silently re-binds.
- **A config change invalidates.** Editing a server's command or URL drops its rules
  back to prompting rather than carrying a grant onto a differently-defined process.
- **Name reuse cannot grant access.** Two servers with the same display name get
  different `serverId`s, so they can never satisfy each other's rules.

## Scoping and wildcards

- **Project-scoped by default.** A grant made in one repository must not silently
  apply in another. Global scope only on an explicit user action.
- **Allow `serverId:*`** (every tool from one known server) — useful, and bounded to
  a single server identity.
- **Never allow a bare `*`** that spans servers. That is a lasting grant over every
  MCP server including ones added later, which is not a decision a user can make
  meaningfully at grant time.
- **Deny beats allow** stays as it is in #102, evaluated before the allow path.

## Open questions for the maintainer

1. **Same rules file or a separate one?** MCP rules have a different lifecycle
   (bound to a config hash, invalidated by config edits). Keeping them in the same
   `permissions.json` means one place to audit and revoke; a separate file keeps the
   two lifecycles from being confused. Recommendation: same file, distinct `kind`,
   so revocation has one front door.
2. **Revocation UX.** #102 currently leaves the user hand-editing
   `.boxcode/permissions.json` to revoke. For rules bound to a config hash, a stale
   entry is invisible in the UI but still present on disk. A list/revoke command is
   worth having before MCP rules ship, not after.
3. **Default grant width for MCP.** A blanket "always allow this server" is the
   convenient choice and the risky one. A narrower default — read-only tools of one
   server — is defensible and can be widened deliberately.

## Interaction with the CLI's own approval config

The Rust CLI already has `config.tools.approval`, applied through
`approval::verdict_for` before a permission request is built. A client-side store is
therefore a **second** place policy can live, and the two can disagree. Worth
deciding which wins, and recording it, before MCP tools add a third source of names.
