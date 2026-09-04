# Plan: Two Repos, One Brain

## Thesis

Fork Code-OSS into a JS-native IDE targeting frontend engineers — without rewriting the Rust agent core that already ships PRs today against `HolboxAI/boxcode`. The fork gets a face; the daemon stays the brain.

## Architecture

- **`HolboxAI/boxcode`** (existing, unchanged in kind) — the daemon. Agent loop, tool execution, approval gating. Ships as a spawned task behind a documented protocol once the in-progress `upgrade-plan.md` Phase 3/4 extraction lands.
- **`boxcode-ide`** (this repo) — the face. Fork of Code-OSS, rebranded chrome, a thin TypeScript extension with no agent logic in it, distributed via Open VSX instead of Microsoft's marketplace.
- The two talk over JSON-RPC-over-stdio — the same pattern OpenAI's Codex app-server already proves works across four surfaces (CLI, Desktop, IDE extension, Cloud) from one backend.

Every PR shipped against the Rust core continues to compound into this repo for free once the protocol bridge exists — nothing in `boxcode` gets rewritten to support this.

## Phases

| Phase | What ships | Depends on |
|---|---|---|
| P0 | Finish extracting `AgentLoop` into a spawned task behind a documented protocol | In progress in `boxcode`'s own `upgrade-plan.md` |
| P1 | Fork Code-OSS, rebrand, wire to Open VSX, ship a build with zero boxcode features | P0's protocol shape decided |
| P2 | Thin TS extension: chat panel, native diff viewer, approval prompts as native UI | P1 |
| P3 | Port existing capabilities (session diff, todo checklist, `BOXCODE.md` memory, plan mode) into native panels | P2 |
| P4 | Manager view — visual dispatch of worktree-isolated parallel subagents | `boxcode` core's write-capable-subagent work (separately scoped) |
| P5 | Deploy/DB/auth/artifacts as native sidebar panels, not chat tool calls | P3 |
| P6 | Signed installer, auto-update, launch positioned at frontend engineers | P1–P5 |

## Why this base, not VS Code proper or Zed

- **VS Code fork over building from scratch:** ruled out building a from-scratch editor — both Cursor and Google (via Windsurf's lineage) already validated the fork-Code-OSS path, and Google paid to acquire an existing fork+team rather than build one, which is the closest thing to a market price for how expensive doing this from zero actually is.
- **Code-OSS over Zed:** Zed is Rust-native but GPL-3.0 — using it would mean either open-sourcing boxcode's proprietary layer or keeping the agent core in a separate process talking to a largely-unmodified Zed instance. Code-OSS is MIT, which avoids that constraint entirely, and the target audience (frontend engineers, AWS-not-Azure customers) doesn't need the Microsoft-exclusive slice of the VS Code Marketplace that Open VSX doesn't cover.

## Real risks, tracked here so they don't get silently dropped

1. **Upstream merge burden is permanent, not one-time.** Every Code-OSS release needs merging in. Budget a standing function, not a launch sprint.
2. **Marketplace supply-chain trust.** VS Code forks recommending Open VSX packages has drawn documented scrutiny as a supply-chain risk surface — vet whatever ships as default-recommended extensions.
3. **The missing ~10% (Microsoft-exclusive extensions) is invisible until a customer hits it.** Confirmed acceptable for this specific audience — re-confirm before it's load-bearing on a bigger customer base.
4. **License and trademark decisions are open — see `README.md`.** Not resolved by this scaffolding commit.
