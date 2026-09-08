# Iterate locally without packaging a `.dmg`

The macOS workflow's `generate_assets` input is `workflow_dispatch`-only. A
normal PR compile does **not** zip or sign anything -- it stops after
`./build.sh` produces `VSCode-darwin-arm64/Boxcode IDE.app`.

## Compile, then run the `.app`

From this repo, with Node (see `.nvmrc`), `jq`, Python 3.11, and Rust:

```sh
export APP_NAME=Boxcode
export BINARY_NAME=boxcode-ide
export ORG_NAME=HolboxAI
export OS_NAME=osx
export VSCODE_ARCH=arm64
export VSCODE_QUALITY=stable
# Set DISABLE_UPDATE=no to bake in the rolling-build update feed
# (https://raw.githubusercontent.com/HolboxAI/boxcode-ide/update-feed).
export DISABLE_UPDATE=yes
export SHOULD_BUILD=yes
export SHOULD_BUILD_REH=no
export SHOULD_BUILD_REH_WEB=no

./get_repo.sh
./build.sh
```

Launch the unsigned tree with:

```sh
codesign --force --deep --sign - "VSCode-darwin-${VSCODE_ARCH}"/*.app
open "VSCode-darwin-${VSCODE_ARCH}/Boxcode IDE.app"
```

The ad-hoc `codesign` is required even for a local tree: Electron's
linker-signed stub has no sealed resources, so `open` otherwise fails
before Gatekeeper can show a dialog.

## Agent unit tests (no vscode checkout)

```sh
cd src/stable/extensions/boxcode-agent
npm ci
npm test
```

These compile with `tsconfig.test.json`, which excludes `extension.ts`
(the only file that imports the `vscode` module).

## Packaging a zip/dmg

Only needed when you want a distributable. Dispatch
`CI - Build - macOS` with `generate_assets: true`, or run
`./prepare_assets.sh` after a local compile (sets `OS_NAME=osx`).
The packaging script ad-hoc-signs when no Developer ID certificate is
configured, then builds the zip/dmg. That same dispatch also publishes
`latest.json` on the `update-feed` branch. A previously installed app
with updates enabled will notify that a new version is available and
ask before opening the zip; it will not replace itself in the
background.

## Windows portable build

`CI - Build - Windows` now runs on PRs the same way macOS does. After
`pack (windows-x64)` is green, download the `compiled-win32-x64`
artifact, then:

```bat
tar -xzf compiled.tar.gz
VSCode-win32-x64\Boxcode.exe
```

Installers (exe/msi) are still dispatch-only (`generate_assets: true`).
arm64 Windows packing is dispatch-only too. The `boxcode` CLI is a
separate install: `irm https://boxcode.sh/install.ps1 | iex`.
