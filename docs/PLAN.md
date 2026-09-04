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
| P0 | Extract `AgentLoop` into a spawned task behind a documented protocol | **Not started — corrected 2026-09-04.** `boxcode`'s own `upgrade-plan.md` does not exist as a file in that repo; no JSON-RPC/IPC/protocol-server code exists anywhere in its `src/`. What does exist are similarly-numbered but unrelated phases (`Phase1-tool-parity` through `Phase4-subagent-ui`, all merged) — real work, but about the CLI agent's own internal capabilities, not about exposing an interface for an external consumer. `agent.rs`'s own doc comment names the real prerequisite directly: "step three of Phase 3... turns this trio into the body of a spawned `AgentLoop` task" — not yet done. See "P0 design, grounded in the real code" below for the concrete scoped shape of this. |
| P1 | Fork Code-OSS, rebrand, wire to Open VSX, ship a build with zero boxcode features | P0's protocol shape decided |
| P2 | Thin TS extension: chat panel, native diff viewer, approval prompts as native UI | P1. **Re-scope pending 2026-09-04 finding** — see "Onboarding & agent-surface UI" below: much of what P2 assumed as new engineering (chat panel, diff viewer) already exists upstream, gated off. Evaluate the `agentHost` integration path (§ below) against the original "thin extension" assumption before starting. |
| P3 | Port existing capabilities (session diff, todo checklist, `BOXCODE.md` memory, plan mode) into native panels | P2 |
| P4 | Manager view — visual dispatch of worktree-isolated parallel subagents | `boxcode` core's write-capable-subagent work (separately scoped). **Re-scope pending 2026-09-04 finding** — the Manager-view *shell* (`vs/sessions`, a complete separate "Agents Window" workbench) already exists upstream; what's still genuinely gated on the core work is the parallel-subagent *capability* it would visualize, not the UI. |
| P5 | Deploy/DB/auth/artifacts as native sidebar panels, not chat tool calls | P3 |
| P6 | Signed installer, auto-update, launch positioned at frontend engineers | P1–P5 |

## Build model for P1 — patch-at-build, not a diverged fork

Confirmed by reading VSCodium's actual build scripts (`github.com/VSCodium/vscodium`), not their marketing: their pipeline does a fresh shallow clone of a pinned upstream `microsoft/vscode` commit **every build**, overlays branding assets, rewrites `product.json` via `jq`, and applies ~69 patch files with `git apply`. There is no permanently-diverged git history to merge — VSCodium's own repo contains only build-script commits, never a merge of VS Code's history.

This is the opposite maintenance model from Cursor's. Cursor maintains a true diverged fork with deep architectural rewrites (core rendering, extension host, for inline diffs and background agents) — that's what forces their dedicated upstream-merge team. **As long as boxcode-ide stays at rebrand-and-repackage (P1–P3 as scoped), the standing maintenance cost is closer to VSCodium's (small, config-driven, patch-repair when upstream's build system shifts) than to Cursor's.** The heavier cost only applies once boxcode-ide starts doing Cursor-style deep core modifications — treat that as a distinct, later decision with its own staffing conversation, not a baseline cost of forking at all.

VSCodium's build scripts are MIT-licensed (confirmed by reading `LICENSE` directly) — legally reusable as the literal P1 starting point rather than building an equivalent from scratch. Naming is centralized in env vars (`APP_NAME`, `BINARY_NAME`, `ORG_NAME`, etc.) substituted into patches via tokens, and the Open VSX marketplace swap is already a clean, reusable patch (`patches/00-settings-gallery.patch`) — most of P1 is plausibly configuration, not new engineering.

## Why this base, not VS Code proper or Zed

- **VS Code fork over building from scratch:** ruled out building a from-scratch editor — both Cursor and Google (via Windsurf's lineage) already validated the fork-Code-OSS path, and Google paid to acquire an existing fork+team rather than build one, which is the closest thing to a market price for how expensive doing this from zero actually is.
- **Code-OSS over Zed:** Zed is Rust-native but GPL-3.0 — using it would mean either open-sourcing boxcode's proprietary layer or keeping the agent core in a separate process talking to a largely-unmodified Zed instance. Code-OSS is MIT, which avoids that constraint entirely, and the target audience (frontend engineers, AWS-not-Azure customers) doesn't need the Microsoft-exclusive slice of the VS Code Marketplace that Open VSX doesn't cover.

## P0 design, grounded in the real code (2026-09-04)

Read `agent.rs` (727 lines) and `approval.rs` (65 lines) in full rather than guessing at the shape of this. Two things are already done, one is not.

**Already done (Phase 3 steps 1-2, both merged in `boxcode`):**
- `approval.rs` — a clean typed seam between "the model wants to do X" and "the user decided Y": `ApprovalRequest { call, action, remaining, preview: Option<FileDiff> }` and `Decision::{Allowed, Refused}`. Its own doc comment: *"When the agent loop becomes its own task, these become the messages on the channel between it and the UI."* `preview` already carries the before/after diff — this is P2's "native diff viewer" data, already computed, already there.
- `agent.rs` — the fire→stream→execute cycle already extracted out of `main.rs`'s event loop: `fire_request`, `handle_event`, `execute_approved`, `run_subagent`, each operating on `&mut App` plus an `mpsc::Sender<StreamEvent>`. `StreamEvent` (`Token`, `Reasoning`, `ToolCalls`, `ToolsFinished`, `AgentActivity`, `Usage`, `Done`, `Notice`, `Error`) is already a clean, serializable-shaped enum — already wire-protocol-shaped, just not yet serialized or sent across a process boundary.

**Not done — the actual P0 scope:** `handle_event` today takes `&mut App` directly, tightly coupled to the TUI. The real, well-bounded refactor: introduce a trait (e.g. `AgentSink`) with methods mirroring `App`'s own mutation methods (`append_token`, `request_tools`, `finish_tools`, `record_subagent_activity`, `note`, `fail_stream`, ...), implement it for `App` (TUI, behavior unchanged) and for a new `RpcSink` (serializes the same calls as JSON-RPC-over-stdio notifications). `App` becomes one consumer of the agent loop; a new stdio JSON-RPC server becomes the second. This is an extraction along a seam the codebase already anticipated, not a rewrite.

## Onboarding & agent-surface UI — verified against the real pinned source (2026-09-04)

Prompted by hands-on competitive testing (Cursor, Antigravity, Codex, Copilot all land in a chat/agent surface before the editor, not a blank IDE) plus deep research into each vendor's stated design rationale. **Every specific claim below was personally re-verified by shallow-cloning the exact commit boxcode-ide pins (`microsoft/vscode` @ `7e7950df89d055b5a378379db9ee14290772148a`, tag `1.126.0`, per `upstream/stable.json`) and grepping the real source — not taken on trust from the research pass alone.** Two things the research got wrong are corrected inline below.

**Confirmed present in the pinned commit, unmodified by any current patch:**
- `src/vs/sessions/` — a complete, separate "Agents Window" workbench layer, architecturally parallel to `src/vs/workbench/` (own `README.md`, `LAYOUT.md`, `SESSIONS.md`). Fixed layout, sessions-first, opens as a real separate native window via `workbench.action.openAgentsWindow`, pluggable `ISessionsProvider` contract. This is the same shape as Cursor's Agents Window / Antigravity's Manager — we'd register a provider, not build a workbench.
- `src/vs/platform/agentHost/` — 881 non-test `.ts` files, 123 test files, 23 docs (verified count; an earlier pass mis-estimated this at "~70 files," corrected here). A full pluggable agent-host framework: session database, checkpoints, changesets, permissions, command auto-approval, terminal manager, git/PR operations, remote hosts.
- `src/vs/platform/agentHost/node/codex/codexAppServerClient.ts` — confirmed verbatim: `// JSON-RPC 2.0 over NDJSON`, transport writes via `this._transport.stdin.write(JSON.stringify(message) + '\n')`. This is the exact protocol shape this doc already specifies for the `boxcode` bridge (see Architecture, above) — already proven working in the same tree, not a novel design.
- `workbench.startupEditor` — confirmed the `'agentSessionsWelcomePage'` enum value exists (`gettingStarted.contribution.ts`), confirmed its real default is `'welcomePage'` (verified the literal `'default': 'welcomePage'` line), confirmed the gate: `agentSessionsWelcome.contribution.ts` only activates when `!chatEntitlementService.sentiment.hidden && startupEditor === 'agentSessionsWelcomePage'`.
- `chat.agentHost.enabled` — confirmed verbatim in `agentHost/common/agentHost.config.contribution.ts`: `default: !isWeb && product.quality !== 'stable'`. **Confirmed this evaluates to `false` in our actual build**: `prepare_vscode.sh` sets `product.quality = "stable"` whenever `VSCODE_QUALITY=stable` (our CI's setting, line ~115), so `!isWeb && false` = `false`. Flipping this on is a required, not optional, step for any of this to matter.
- `src/vs/workbench/contrib/browserView/` — a full Integrated Browser editor pane: CDP service, Playwright service, device emulation, and (in `browserEditorChatFeatures.ts`) element-selection-to-chat with an actual element screenshot, area selection, viewport/fullPage screenshots, console-log attachment. This is P2/Tier-3's "browser screenshot + visual-comment feedback" item, already built.

**Corrections to the earlier research pass, found by checking the patches directly rather than trusting a "zero references" summary:**
- `patches/52-ext-copilot-remove-it.json` + `53-ext-copilot-remove-it.patch` **do** reference `agentHost` extensively — but only to delete the Copilot/Claude/Codex vendor-specific adapter code (`agentHost/node/copilot/*`, `agentHost/node/claude`, `agentHost/node/codex`, `agentHost/node/otel`) and clean up now-dangling imports in files like `agentHostMain.ts`/`agentHostServerMain.ts`/`agentService.ts`. The core framework (`vs/sessions`, the session/changeset/permission machinery, the codex JSON-RPC transport file itself) is untouched. Net effect matches the intended reading: adapters removed, framework kept.
- `patches/00-ui-custom-font.patch` **does** touch `welcomeAgentSessions/browser/agentSessionsWelcome.ts` directly — checked the actual hunk: it's a cosmetic font-scaling fix (swaps a hardcoded `22px` row-height constant for a `FONT.sidebarSize22` token, matching what this patch does to every other list view in the product), not a functional change. If anything this confirms the page is alive and reachable — VSCodium's patch author bothered to font-scale it.
- `browserView` is confirmed genuinely untouched by any current patch (checked directly, zero matches).

**What's still unverified — needs a real running build, not source-reading:** whether `vs/sessions` and `browserView` actually open and function once compiled into a stable-quality boxcode-ide `.app`, versus being blocked by some other experiment gate or a missing dependency not visible from source alone. This is the literal next step once a working `.dmg` exists.

**Recommendation (full reasoning and every citation in the research session, not reproduced here in full — see chat history 2026-09-04):**
1. Chat-first landing: flip `workbench.startupEditor`'s default to `'agentSessionsWelcomePage'`, patch the `chatEntitlementService.sentiment.hidden` gate so it isn't Copilot-conditional, seed real example prompts (required, not polish — a bare prompt box has no more affordance than a search box). Keep "Open Folder" always visible — both Cursor and Google shipped this default and took real user backlash for making the editor path non-obvious; make the toggle back to editor-first stable and discoverable from day one.
2. Editor surface: one binary, two windows (Cursor's shape — `vs/sessions` as a second native window), not two separate apps (Antigravity's shape). Cheaper, and it's what's already built.
3. Evaluate registering `boxcode` as an `agentHost` provider (stdio JSON-RPC, matching § above) as a real alternative to the "thin extension, no agent logic" assumption in P2 — inherits session persistence, diff/changeset plumbing, permissions, and terminal integration for free. Real trade-off: this is fork-layer coupling, not extension-layer — spike it with real numbers before committing either way.
4. Promote the browser/visual-feedback item off Tier 3: verify it survives the build (Tier 1), wire element-selection-to-chat (Tier 2). Argument, not just convenience: Cursor's own design team (their Design Mode launch post) states plainly that chat is the *weaker* surface for exactly this audience — *"UI work tends to be spatial... frontend developers often communicate through annotations."* For a fork whose whole positioning is "for frontend engineers," this is a stronger differentiating first-run moment than the chat box every competitor already has.

## Post-scaffold preview: what Cursor and Codex actually do (2026-09-04)

Follow-up research, prompted by hands-on testing showing both Cursor and Codex surface the running app's UI right after scaffolding a project — before, or without, opening a full code editor. Sourced from official docs/changelogs plus vendor-staff forum posts (this session's web-search budget was exhausted; everything below came from direct fetches, not search).

**The mechanism has a name, and it's Cursor-specific:** a real, named setting, `autoOpenLocalhostUrls` ("Show Localhost Links in Browser," Settings → Tools & MCP). Confirmed by Cursor staff (forum, not docs — this setting is undocumented in the actual docs): it auto-captures any localhost URL the agent's terminal prints into the integrated Browser pane, and per the same staff reply this is *"a separate mechanism for the agents window, doesn't happen in editor window"* — i.e. it's specific to the chat-first Agents Window, not the code editor. It's URL interception, not the agent deciding to open a browser and not the user clicking anything. Default-on is inferred from complaint volume (users asking how to turn it *off*), not confirmed in writing anywhere.

**Codex's "no IDE" is permanent architecture, not a preview mode:** confirmed directly — *"Browser isn't available in Codex CLI or the Codex IDE extension. Open the ChatGPT desktop app to use the built-in browser."* There is no code editor anywhere in the desktop app for a preview to substitute for. Whether it auto-opens unprompted after a scaffold specifically is genuinely unverified either way — could easily be the agent invoking it itself via `@Browser`.

**No vendor anywhere has published a design rationale for "preview before editor."** Checked exhaustively (both vendors' blogs, docs, changelogs, forums). This is unclaimed positioning territory — worth treating as an opportunity to state something neither competitor has, not as a pattern to imitate blindly.

**A real correction to this doc, not just an addition:** the "Onboarding & agent-surface UI" section above describes `vs/sessions` correctly as a real separate native window (confirmed independently, twice) — but it should NOT be conflated with the chat-first landing page. `AgentSessionsWelcomePage` (the `'agentSessionsWelcomePage'` startup editor) is a plain `EditorPane` that renders **inside the normal workbench window**, the same window `browserView` lives in — it is not `vs/sessions`, and not a separate window at all. So "chat-first landing" and "the post-scaffold preview" are both just editor panes in one ordinary window; `vs/sessions` (the Agents Window) is a third, genuinely separate surface, reserved for actual multi-agent orchestration (P4).

**Refines recommendation #4 above, doesn't replace it:** after a scaffold finishes, open `browserView` as a sibling editor pane next to chat, in the *same* chat-first window — not the full code editor, not the separate Agents Window. Cheap, because both panes already exist as siblings in one workbench. Concrete implementation details the research surfaced, not guessed:
- **Gate on the dev server actually responding**, not on the printed URL line — poll the port before opening. Cursor users report seeing connection-refused pages from skipping this.
- **Restrict auto-open to localhost URLs from servers the agent itself started this session.** Cursor's actual user complaints are about *over-broad* interception hijacking unrelated links (PR/GitHub URLs opening in a browser with no auth cookies) — don't repeat that.
- **Ship it as a documented, named, default-on toggle** (mirror `autoOpenLocalhostUrls`'s existence, not its lack of documentation), with a one-keystroke escape to the real editor.

**A landmine for whoever builds this:** `patches/00-ui-custom-font.patch` deletes `AgentSessionsListDelegate.ITEM_HEIGHT`/`SECTION_HEIGHT` (replaced with `FONT.*` tokens) — new pane-layout code referencing the old constant names won't compile.

## Real risks, tracked here so they don't get silently dropped

1. **Patch-repair is recurring work, just smaller than a merge-conflict tax.** Upstream VS Code build-system changes do break patches — the actual maintenance task is fixing failed patch hunks (VSCodium's own `update_patches.sh` documents this workflow), not resolving deep merge conflicts. Real and ongoing, but not the ~300-person-scale cost that applies only once boxcode-ide does Cursor-style deep core modifications (see "Build model" above).
2. **Specific, confirmed-blocked extensions, not just a vague "10%."** Microsoft's C/C++ extension actively checks `product.json` and refuses to run on non-Microsoft builds (confirmed, not hypothetical). VSCodium's own docs additionally list **Live Share, Python/Pylance, and Remote-SSH/WSL/Containers** as license-incompatible with forks. Re-confirm none of the target frontend-eng customer base also needs Python/Pylance before this is load-bearing.
3. **Auto-update has documented reliability issues on VSCodium** — stuck installs, update loops on macOS Homebrew, false-positive update checks on Linux (multiple open upstream GitHub issues). Adopting VSCodium's update pipeline doesn't inherit a solved problem here; budget real QA time on the updater specifically.
4. **Marketplace supply-chain trust.** VS Code forks recommending Open VSX packages has drawn documented scrutiny as a supply-chain risk surface — vet whatever ships as default-recommended extensions.
5. **License and trademark decisions are open — see `README.md`.** Not resolved by this scaffolding commit.
