# boxcode-ide

A Code-OSS-based editor for boxcode, aimed at frontend engineers. This repo owns the editor surface only — the agent brain stays in [`HolboxAI/boxcode`](https://github.com/HolboxAI/boxcode) and is reused over a protocol, not reimplemented here.

**Status: pre-P1.** No fork source has been imported yet. This repo currently holds planning docs and scaffolding only.

## Architecture

Two repos, one brain:

- **`HolboxAI/boxcode`** (existing) — the daemon. Agent loop, tool execution, approval gating, all in Rust. Exposes a JSON-RPC-style protocol once the in-progress `upgrade-plan.md` Phase 3/4 work lands.
- **`boxcode-ide`** (this repo) — the face. A Code-OSS fork with a thin TypeScript extension that talks to the daemon. No agent logic lives here.

Full plan: [`docs/PLAN.md`](docs/PLAN.md).

## Open decisions — do not assume, ask before proceeding

These are deliberately **not** decided by this scaffolding commit:

- **License.** Code-OSS itself is MIT. Whatever boxcode-specific code lands in this repo (the extension, any modified `product.json`, build tooling) needs its own explicit license decision — this is a business call, not a default to inherit silently.
- **Trademark handling.** "Visual Studio Code" and the official product name/icon are Microsoft trademarks. A clean Code-OSS fork (see [VSCodium](https://github.com/VSCodium/vscodium) for precedent) has to strip Microsoft's `product.json` branding, telemetry endpoints, and default-marketplace wiring before any public build ships. Not done yet — do not ship a build with Microsoft's branding/telemetry intact.
- **Repo visibility.** Currently private. Flipping to public is a one-way door (forks/clones persist even if re-privated) — confirm deliberately when that decision is actually made.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).
