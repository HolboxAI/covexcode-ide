# Third-Party Notices

## Build tooling: VSCodium

The build scripts, patch set, GitHub Actions workflows, and source overlay under
`build/`, `dev/`, `docs/`, `icons/`, `patches/`, `src/`, `stores/`,
`.github/workflows/ci-build-*.yml`, `build.sh`, `build_cli.sh`,
`check_cron_or_pr.sh`, `check_tags.sh`, `get_pr.sh`, `get_repo.sh`, `npmrc`,
`prepare_assets.sh`, `prepare_checksums.sh`, `prepare_src.sh`,
`prepare_vscode.sh`, `undo_telemetry.sh`, `update_upstream.sh`,
`update_version.sh`, `upload_sourcemaps.sh`, `utils.sh`, and `version.sh` are
adapted from [VSCodium](https://github.com/VSCodium/vscodium), used and
modified under the terms of its MIT license:

```
MIT License

Copyright (c) 2018-present The VSCodium contributors
Copyright (c) 2018-present Peter Squicciarini
Copyright (c) 2015-present Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

We have adapted, not blindly copied, this tooling: naming/branding is
re-pointed at boxcode identity (see `utils.sh`, `prepare_vscode.sh`, and the
CI workflow `env:` blocks) rather than reusing VSCodium's own product
identifiers, bundle IDs, GUIDs, or update infrastructure. The patch logic
itself (de-branding upstream Code-OSS, the Open VSX marketplace swap, telemetry
removal, etc.) is kept as-is because that logic is what the patches are for —
only the identity tokens substituted into it change.

## Upstream: Microsoft/vscode (Code-OSS)

At build time, `get_repo.sh` performs a fresh shallow clone of a pinned commit
of [`microsoft/vscode`](https://github.com/microsoft/vscode) (MIT licensed).
No modified/diverged fork of that source is vendored into this repository —
consistent with VSCodium's own approach, only the patch set in `patches/` is
tracked here, and it is applied to a fresh checkout at build time.

## Overall repo license

This repo's own original code (the boxcode branding overlay content, the
adapted build/CI scripts as modified here, and any future extension code) is
**not yet under a declared license** — see `README.md` "Open decisions". Do
not assume MIT applies to boxcode-original contributions beyond what is
required to comply with the notices above.
