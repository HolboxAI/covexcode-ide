# Contributing

This repo is pre-P1 (see `docs/PLAN.md`) — no fork source has landed yet, so contribution shape will change once it does. For now:

- **Open a PR, don't push to `main`.** Branch protection requires review; this mirrors the convention already in use on `HolboxAI/boxcode`.
- **Bump nothing silently.** Once a `package.json`/`product.json` exist, version bumps follow whatever convention gets established when P1 lands — don't invent one ahead of that.
- **Flag license/trademark questions instead of resolving them inline.** See the "Open decisions" section in `README.md`. If a change touches licensing, Microsoft trademark/branding, or telemetry endpoints, raise it explicitly in the PR description rather than deciding silently.
- **Keep agent logic out of this repo.** If a change starts reimplementing something the Rust daemon (`HolboxAI/boxcode`) already does, that's a sign it belongs in the protocol contract between the two repos, not duplicated here.
