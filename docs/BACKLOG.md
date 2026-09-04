# Backlog: Tier 1 now, Tier 2 on deck

Companion to `docs/PLAN.md` (phases) and the "Parity Without Bloat" feature-map design. This file exists so Tier 1/2 work has somewhere concrete to live instead of staying only in a chat conversation.

**Precedent worth knowing before treating the full fork as a blocker:** Cursor's actual first version (v0.1, March 2023) was built on CodeMirror, not a VS Code fork — they only moved to a VSCodium-based fork later, once they had product-market fit. Kiro started as a 3-person internal side project that grew through dogfooding before AWS invested infra behind it. Neither started by solving the heavy fork-build-pipeline problem first. Lean here, on purpose.

## Now: Tier 1 (baseline IDE — mostly "free" once P1 builds clean)

These aren't new engineering so much as *verification and enablement* once a build exists — the work is confirming Code-OSS's own capabilities carry over correctly through the rebrand, not building them from scratch.

- [ ] Confirm the Open VSX marketplace actually resolves/installs extensions end-to-end in a built instance (not just that the patch is applied) — ESLint, Prettier, Tailwind IntelliSense, a React and a Vue extension, minimum.
- [ ] Confirm integrated terminal, source control panel, and debugger all function unmodified post-rebrand.
- [ ] Confirm multi-root workspace support and settings sync aren't broken by any rebrand patch.
- [ ] First real downloadable build (once macOS passes) — this is also the first moment "can I test this myself" becomes literally true.

## On deck, not now: Tier 2 (AI-native table stakes)

Scoped, sequenced, deliberately not started yet — P2/P3 territory once P1 and Tier 1 verification are solid.

- [ ] Inline edit command separate from chat (select code → instruction → inline diff)
- [ ] Per-hunk diff review UI with explicit accept/reject (the engine already exists via `/diff` in the CLI — this is surfacing it, not building a new diff engine)
- [ ] Import-from-VS-Code onboarding flow (settings/keybindings/extensions)
- [ ] Structured @-mention context attachment in chat (files/symbols/docs)

## Small, high-priority items workable in parallel with current P1 debugging

Chosen specifically because none of them require a working build to make progress on — safe to pick up while Windows/Linux are still being diagnosed.

- [x] ~~Default dev-iteration CI runs to `generate_assets: false`~~ — done differently than originally planned. Manual-only triggering was reverted: it meant zero real signal on any PR ("all checks passed" while the build was known broken — worse than the noise problem it fixed). Restored automatic `pull_request` triggering instead; since `generate_assets` only exists as a `workflow_dispatch` input, PR-triggered runs already skip packaging by construction, so this is covered without a separate default.
- [x] ~~Make the real build check a required status check~~ — done. `hygiene`, `build (macos-14, arm64)`, and `build (macos-15-intel, x64)` are required in branch protection; a broken macOS build now genuinely blocks merge, not just shows red.
- **Scope decision, dated:** macOS-only for now — Windows and Linux workflows are deliberately back to `workflow_dispatch`-only (not automatic, not required-to-merge) while testing is focused on macOS. Their code stays in the repo, not deleted, and comes back into scope later. Don't re-add them to required checks without a real decision to resume testing them.
- [ ] **Rename remaining literal "vscodium"-named internal files** (e.g. `build/windows/msi/i18n/vscodium.*.wxl`, `dev/cli.sh`'s hardcoded `VSCodium - Insiders.app` path) — cosmetic, flagged earlier, deliberately deferred until the pipeline wasn't actively on fire. Safe to do now in parallel since it doesn't touch build logic.
- [x] ~~Set up the GitHub Release skeleton~~ — done. A "Publish to the rolling macOS dev-build release" step lands in `ci-build-macos.yml` after asset generation, publishing to a single stable tag (`macos-dev-latest`) so testers get one bookmarkable link instead of hunting through Actions run pages. Only real when a maintainer manually dispatches with `generate_assets: true` — never fires on the automatic per-PR compile-only runs. Explicitly marked unsigned/dev-only in the release notes (no code-signing/notarization set up yet, so Gatekeeper will warn on first launch — expected, not a bug).
- [ ] Write the one-page "how to iterate locally without full packaging" doc referencing `generate_assets` above, so this doesn't get rediscovered from scratch next time.
