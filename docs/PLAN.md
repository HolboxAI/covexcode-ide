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

## Build model for P1 — patch-at-build, not a diverged fork

Confirmed by reading VSCodium's actual build scripts (`github.com/VSCodium/vscodium`), not their marketing: their pipeline does a fresh shallow clone of a pinned upstream `microsoft/vscode` commit **every build**, overlays branding assets, rewrites `product.json` via `jq`, and applies ~69 patch files with `git apply`. There is no permanently-diverged git history to merge — VSCodium's own repo contains only build-script commits, never a merge of VS Code's history.

This is the opposite maintenance model from Cursor's. Cursor maintains a true diverged fork with deep architectural rewrites (core rendering, extension host, for inline diffs and background agents) — that's what forces their dedicated upstream-merge team. **As long as boxcode-ide stays at rebrand-and-repackage (P1–P3 as scoped), the standing maintenance cost is closer to VSCodium's (small, config-driven, patch-repair when upstream's build system shifts) than to Cursor's.** The heavier cost only applies once boxcode-ide starts doing Cursor-style deep core modifications — treat that as a distinct, later decision with its own staffing conversation, not a baseline cost of forking at all.

VSCodium's build scripts are MIT-licensed (confirmed by reading `LICENSE` directly) — legally reusable as the literal P1 starting point rather than building an equivalent from scratch. Naming is centralized in env vars (`APP_NAME`, `BINARY_NAME`, `ORG_NAME`, etc.) substituted into patches via tokens, and the Open VSX marketplace swap is already a clean, reusable patch (`patches/00-settings-gallery.patch`) — most of P1 is plausibly configuration, not new engineering.

## Why this base, not VS Code proper or Zed

- **VS Code fork over building from scratch:** ruled out building a from-scratch editor — both Cursor and Google (via Windsurf's lineage) already validated the fork-Code-OSS path, and Google paid to acquire an existing fork+team rather than build one, which is the closest thing to a market price for how expensive doing this from zero actually is.
- **Code-OSS over Zed:** Zed is Rust-native but GPL-3.0 — using it would mean either open-sourcing boxcode's proprietary layer or keeping the agent core in a separate process talking to a largely-unmodified Zed instance. Code-OSS is MIT, which avoids that constraint entirely, and the target audience (frontend engineers, AWS-not-Azure customers) doesn't need the Microsoft-exclusive slice of the VS Code Marketplace that Open VSX doesn't cover.

## Real risks, tracked here so they don't get silently dropped

1. **Patch-repair is recurring work, just smaller than a merge-conflict tax.** Upstream VS Code build-system changes do break patches — the actual maintenance task is fixing failed patch hunks (VSCodium's own `update_patches.sh` documents this workflow), not resolving deep merge conflicts. Real and ongoing, but not the ~300-person-scale cost that applies only once boxcode-ide does Cursor-style deep core modifications (see "Build model" above).
2. **Specific, confirmed-blocked extensions, not just a vague "10%."** Microsoft's C/C++ extension actively checks `product.json` and refuses to run on non-Microsoft builds (confirmed, not hypothetical). VSCodium's own docs additionally list **Live Share, Python/Pylance, and Remote-SSH/WSL/Containers** as license-incompatible with forks. Re-confirm none of the target frontend-eng customer base also needs Python/Pylance before this is load-bearing.
3. **Auto-update has documented reliability issues on VSCodium** — stuck installs, update loops on macOS Homebrew, false-positive update checks on Linux (multiple open upstream GitHub issues). Adopting VSCodium's update pipeline doesn't inherit a solved problem here; budget real QA time on the updater specifically.
4. **Marketplace supply-chain trust.** VS Code forks recommending Open VSX packages has drawn documented scrutiny as a supply-chain risk surface — vet whatever ships as default-recommended extensions.
5. **License and trademark decisions are open — see `README.md`.** Not resolved by this scaffolding commit.
