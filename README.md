# boxcode-ide

A Code-OSS-based editor for boxcode, aimed at frontend engineers. This repo owns the editor surface only — the agent brain stays in [`HolboxAI/boxcode`](https://github.com/HolboxAI/boxcode) and is reused over a protocol, not reimplemented here.

**Status: P1 in progress.** Build tooling (adapted from [VSCodium](https://github.com/VSCodium/vscodium)'s MIT-licensed scripts — see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)) has landed: a pinned `microsoft/vscode` checkout, a patch set for de-branding/Open VSX/telemetry, and boxcode's own product identity (`utils.sh`, `prepare_vscode.sh`). See [`docs/howto-build.md`](docs/howto-build.md) to build locally.

## Architecture

Two repos, one brain:

- **`HolboxAI/boxcode`** (existing) — the daemon. Agent loop, tool execution, approval gating, all in Rust. Exposes a JSON-RPC-style protocol once the in-progress `upgrade-plan.md` Phase 3/4 work lands.
- **`boxcode-ide`** (this repo) — the face. A Code-OSS fork with a thin TypeScript extension that talks to the daemon. No agent logic lives here.

Full plan: [`docs/PLAN.md`](docs/PLAN.md).

## Open decisions — do not assume, ask before proceeding

These are deliberately **not** decided by this scaffolding commit:

- **License.** Code-OSS itself is MIT. Whatever boxcode-specific code lands in this repo (the extension, any modified `product.json`, build tooling) needs its own explicit license decision — this is a business call, not a default to inherit silently.
- **Trademark handling.** "Visual Studio Code" and the official product name/icon are Microsoft trademarks. A clean Code-OSS fork (see [VSCodium](https://github.com/VSCodium/vscodium) for precedent) has to strip Microsoft's `product.json` branding, telemetry endpoints, and default-marketplace wiring before any public build ships. Not done yet — do not ship a build with Microsoft's branding/telemetry intact.
- **Repo visibility.** Made public 2026-09-04 (deliberate decision — nothing confidential was found in the tree, confirmed by a secret-pattern scan before flipping). This was a one-way door: forks/clones from before this point persist even if the repo is re-privated later, so treat "private again" as "newly private," not "back to before."

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).
