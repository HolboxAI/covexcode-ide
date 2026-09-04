# Backlog: Tier 1 now, Tier 2 on deck

Companion to `docs/PLAN.md` (phases) and the "Parity Without Bloat" feature-map design. This file exists so Tier 1/2 work has somewhere concrete to live instead of staying only in a chat conversation.

**Precedent worth knowing before treating the full fork as a blocker:** Cursor's actual first version (v0.1, March 2023) was built on CodeMirror, not a VS Code fork — they only moved to a VSCodium-based fork later, once they had product-market fit. Kiro started as a 3-person internal side project that grew through dogfooding before AWS invested infra behind it. Neither started by solving the heavy fork-build-pipeline problem first. Lean here, on purpose.

## Now: Tier 1 (baseline IDE — mostly "free" once P1 builds clean)

These aren't new engineering so much as *verification and enablement* once a build exists — the work is confirming Code-OSS's own capabilities carry over correctly through the rebrand, not building them from scratch.

- [ ] Confirm the Open VSX marketplace actually resolves/installs extensions end-to-end in a built instance (not just that the patch is applied) — ESLint, Prettier, Tailwind IntelliSense, a React and a Vue extension, minimum.
- [ ] Confirm integrated terminal, source control panel, and debugger all function unmodified post-rebrand.
- [ ] Confirm multi-root workspace support and settings sync aren't broken by any rebrand patch.
- [x] ~~First real downloadable build~~ — `.dmg` creation was gated behind Apple code-signing being configured (`CERTIFICATE_OSX_P12_DATA`), which meant zero dmg got built at all without Apple Developer Program enrollment first. Un-gated `build/osx/prepare_assets.sh`'s dmg step so `create-dmg` runs unconditionally — signing/notarization stay real optional steps layered on top when a certificate exists later, this block doesn't change either way. Unsigned dmg triggers a one-time Gatekeeper warning (right-click → Open), same as the zip already does.
- [ ] **Real code-signing/notarization** — likely *not* starting from zero. Legal entity is SpringtownAI LLC (Holbox is the DBA), and SpringtownAI LLC has an existing App Store app from last year — meaning an Apple Developer Program membership under this exact entity plausibly already exists, rather than needing fresh enrollment. What's still needed even so: confirm the membership is active (it's an annual $99 renewal, may have lapsed), and generate a **Developer ID Application** certificate specifically — the App Store app would have used a *different* certificate type (App Store distribution), which doesn't work for direct/outside-the-App-Store distribution like this. Once that cert exists: export as `.p12`, add as GitHub secrets (`CERTIFICATE_OSX_P12_DATA`, `CERTIFICATE_OSX_P12_PASSWORD`, `CERTIFICATE_OSX_APPLE_ID`, `CERTIFICATE_OSX_TEAM_ID`, `CERTIFICATE_OSX_APP_PASSWORD`) — `build/osx/prepare_assets.sh` already knows how to use them, no code changes needed. Still an account-access task only the account holder can do (checking developer.apple.com, generating the cert) — not something scriptable end-to-end from here.

## On deck, not now: Tier 2 (AI-native table stakes)

Scoped, sequenced, deliberately not started yet — P2/P3 territory once P1 and Tier 1 verification are solid.

- [ ] **Predictive multi-line completion ("Tab"-style) — added here, was a real gap.** Ranked the single most-loved, most "wow factor" feature in user sentiment research across competitors ("like having a psychic coding buddy," analyzes existing code and predicts multi-line edits, not just single completions) — was missing from this list entirely until now. Rank this at least alongside inline-edit, not below it.
- [ ] Inline edit command separate from chat (select code → instruction → inline diff)
- [ ] Per-hunk diff review UI with explicit accept/reject (the engine already exists via `/diff` in the CLI — this is surfacing it, not building a new diff engine)
- [ ] Import-from-VS-Code onboarding flow (settings/keybindings/extensions)
- [ ] Structured @-mention context attachment in chat (files/symbols/docs)

## Further out: Tier 3 (frontend-specific, beyond generic AI-IDE)

Not started, P3/P4 territory. What THIS audience (frontend engineers) expects that a backend-focused AI-IDE wouldn't bother with.

- [ ] **Agent-driven browser screenshot/video capture, with visual comment-based feedback — sharpened from a vague "browser debugging integration."** Real, validated finding: Codex and Antigravity independently converged on the exact same pattern for frontend work — the agent drives a real browser, takes screenshots/video of its own work, and the human responds by leaving comments **directly on the visual artifact** (annotating a screenshot), not by typing a text description of what's wrong. Both vendors bet on this specifically, not generic devtools-attach. This is the actual bar, not "add a browser debugger."
- [ ] Live preview panel tied to the dev server — see the running app next to the code, not just a terminal log of `npm run dev`.
- [ ] Framework-aware scaffolding — detect React/Vue/Next/Svelte from the opened project, tailor extension recommendations and AI context automatically (this one's actually P1/onboarding-adjacent, not deep new engineering — worth doing early once Tier 1 verification is done).
- **Natural link to Tier 2, not a merge of scope:** once Tier 2's "structured @-mention context attachment in chat" exists, extending it to accept a screenshot/image attachment (not just files/symbols/docs) is a small, natural addition riding on that same mechanism — not a reason to pull browser automation into Tier 2 itself.

## Small, high-priority items workable in parallel with current P1 debugging

Chosen specifically because none of them require a working build to make progress on — safe to pick up while Windows/Linux are still being diagnosed.

- [x] ~~Default dev-iteration CI runs to `generate_assets: false`~~ — done differently than originally planned. Manual-only triggering was reverted: it meant zero real signal on any PR ("all checks passed" while the build was known broken — worse than the noise problem it fixed). Restored automatic `pull_request` triggering instead; since `generate_assets` only exists as a `workflow_dispatch` input, PR-triggered runs already skip packaging by construction, so this is covered without a separate default.
- [x] ~~Make the real build check a required status check~~ — done. `hygiene`, `build (macos-14, arm64)`, and `build (macos-15-intel, x64)` are required in branch protection; a broken macOS build now genuinely blocks merge, not just shows red.
- **Scope decision, dated:** macOS-only for now — Windows and Linux workflows are deliberately back to `workflow_dispatch`-only (not automatic, not required-to-merge) while testing is focused on macOS. Their code stays in the repo, not deleted, and comes back into scope later. Don't re-add them to required checks without a real decision to resume testing them.
- [x] ~~Rename remaining literal "vscodium"-named internal files~~ — partially done, and the full scope turned out riskier than first flagged, worth recording precisely:
  - `dev/cli.sh` (unused by CI - `build.sh` calls `build_cli.sh` instead, confirmed by grep) — fixed the app-bundle path string for consistency. Left `VSCODE_CLI_DOWNLOAD_URL`/`UPDATE_URL` pointing at VSCodium's own infrastructure on purpose: boxcode-ide is stable-only right now (no insider channel), so there's no real boxcode insider release/update infra to point these at - inventing fake boxcode URLs that would silently 404 is worse than leaving real VSCodium ones. Fix for real once an insider channel exists.
  - **`build/windows/msi/*.wxs`/`*.wxl`/`*.wxi` (13 files) — deliberately NOT renamed.** Confirmed via grep that `vscodium.wxs` is referenced by exact filename in `build/windows/msi/build.sh` - renaming blind risks silently breaking Windows MSI packaging that nobody is currently testing (Windows is out of scope right now, see above), which would sit undetected until Windows testing resumes. Revisit together with restoring Windows to active testing scope, not before.
- [x] ~~Set up the GitHub Release skeleton~~ — done. A "Publish to the rolling macOS dev-build release" step lands in `ci-build-macos.yml` after asset generation, publishing to a single stable tag (`macos-dev-latest`) so testers get one bookmarkable link instead of hunting through Actions run pages. Only real when a maintainer manually dispatches with `generate_assets: true` — never fires on the automatic per-PR compile-only runs. Explicitly marked unsigned/dev-only in the release notes (no code-signing/notarization set up yet, so Gatekeeper will warn on first launch — expected, not a bug).
- [ ] Write the one-page "how to iterate locally without full packaging" doc referencing `generate_assets` above, so this doesn't get rediscovered from scratch next time.
