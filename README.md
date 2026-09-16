# boxcode-ide

A Code-OSS-based editor for boxcode, aimed at frontend engineers. This repo owns the editor surface only — the agent brain stays in [`HolboxAI/boxcode`](https://github.com/HolboxAI/boxcode) and is reused over a protocol, not reimplemented here.

**Status: P1 in progress.** Build tooling (adapted from [VSCodium](https://github.com/VSCodium/vscodium)'s MIT-licensed scripts — see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)) has landed: a pinned `microsoft/vscode` checkout, a patch set for de-branding/Open VSX/telemetry, and boxcode's own product identity (`utils.sh`, `prepare_vscode.sh`). The boxcode chat participant and boxcode's own themes ship in-tree, and macOS/Windows/Linux builds compile in CI. See [`docs/howto-build.md`](docs/howto-build.md) to build locally.

## What ships today

Two boxcode-specific extensions are bundled under `src/stable/extensions/`:

- **`boxcode-agent`** — the chat participant. Registers `boxcode` as the default chat participant (ask/edit/agent modes) and drives the `boxcode` binary over its ACP stdio interface. Ships commands for undoing a session's file changes, switching provider/model/API key, responding to a permission prompt, and trusting the open folder.
- **`boxcode-theme`** — boxcode's own color themes ("Boxcode Dark" and "Boxcode Light"), an amber/orange accent on top of Dark Modern / Light Modern.

On top of the fork, the patch set adds a chat-first landing page, an Integrated Browser pane (with `check_in_browser`), auto-open of localhost dev servers, and the rebrand. What's done vs. planned lives in [`docs/BACKLOG.md`](docs/BACKLOG.md), not here.

## Install

boxcode-ide and the `boxcode` CLI are separate installs: this repo is only the editor surface, and the chat participant it ships shells out to a `boxcode` binary already on your `PATH` (see the Architecture section below). Install that binary first:

```sh
curl -fsSL https://boxcode.sh/install.sh | bash      # macOS/Linux
irm https://boxcode.sh/install.ps1 | iex              # Windows (PowerShell)
```

### Install the IDE itself (macOS dev builds)

Download the latest `.dmg` from the [latest release](https://github.com/HolboxAI/boxcode-ide/releases/latest) and drag **Boxcode IDE** into `Applications`. These builds are **unsigned while the IDE is still in development** (code-signing/notarization isn't set up yet — see [docs/BACKLOG.md](docs/BACKLOG.md), Tier 1), so macOS applies a quarantine flag to the downloaded app and it won't launch until that flag is cleared:

```sh
xattr -cr "/Applications/Boxcode IDE.app"
```

(Alternative: right-click the app → Open, and confirm the Gatekeeper prompt.) After that, launch Boxcode IDE normally.

Then open a folder in boxcode-ide and send a chat message — the first message walks you through picking a model provider and API key if `~/.boxcode/config.toml` doesn't already exist (from using the CLI directly).

### Linux

The `.deb`, `.rpm`, AppImage, Flatpak, and `.tar.gz` packages ship on the [latest release](https://github.com/HolboxAI/boxcode-ide/releases/latest). Every merge to `main` produces a new release with all formats. See the Release model section for how each format updates.

#### .deb / .rpm

Download the package for your architecture and install it. The package manager handles updates:

```sh
sudo apt install ./boxcode-ide_<version>_amd64.deb   # Debian / Ubuntu
sudo dnf install ./boxcode-ide-<version>.x86_64.rpm   # Fedora / RHEL
```

#### AppImage

Download the AppImage, make it executable, and run it. The AppImage updates itself with zsync:

```sh
chmod +x Boxcode_IDE-<version>.glibc2.34-x86_64.AppImage
./Boxcode_IDE-<version>.glibc2.34-x86_64.AppImage
```

#### Flatpak

The Flatpak is a sideloaded bundle. There is no Flathub listing yet:

```sh
flatpak remote-add --if-not-exists --user flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user ./Boxcode-x86_64.flatpak
flatpak run ai.holbox.Boxcode
```

The sandbox can see the host home directory, so the CLI in `~/.local/bin` still works.

#### Snap

CI does not build the Snap. Build it locally with `snapcraft` and install it with `--dangerous`. There is no Snap Store listing yet:

```sh
cd stores/snapcraft/stable
snapcraft
sudo snap install --dangerous boxcode-ide_<version>_amd64.snap
```

The Snap is a classic-confinement bundle. It downloads the `.deb` from the latest release and wraps it.

## Release model

boxcode-ide ships versioned releases. Every merge to `main` produces one new release. The release is immutable. It carries every file format for every platform.

The latest release is always at [`/releases/latest`](https://github.com/HolboxAI/boxcode-ide/releases/latest). Older releases keep their own versioned tags.

### Version scheme

Each release gets a version like `1.126.0.233`:

- The first three parts are the pinned upstream tag, `1.126.0`.
- The fourth part is the build counter: the number of commits on `main`.

CI computes the counter with `git rev-list --count HEAD`. The counter is monotonic and identical across the Linux, macOS, and Windows workflows that run in parallel on the same push. So all three converge on one tag.

### What one release holds

| Platform | Formats |
|---|---|
| Linux | `.deb`, `.rpm`, AppImage, Flatpak, `.tar.gz`, and checksums |
| macOS | `.dmg` and `.zip` |
| Windows | `.zip`, `.exe`, `.msi`, and checksums |

### Update feed

The built-in updater reads a JSON feed. `updateUrl` in `product.json` points at `https://raw.githubusercontent.com/HolboxAI/boxcode-ide/update-feed`. The app fetches `${updateUrl}/${quality}/${platform}/${arch}/latest.json`. CI writes that file on every release run.

Only two formats use the built-in updater:

| Format | Update path |
|---|---|
| macOS `.zip` | built-in updater |
| Linux `.tar.gz` | built-in updater |
| Linux `.deb` / `.rpm` | package manager |
| Linux AppImage | zsync |
| Linux Flatpak | sideloaded bundle (no store yet) |
| Linux Snap | classic bundle (no store yet) |

## Architecture

Two repos, one brain:

- **`HolboxAI/boxcode`** (existing) — the daemon. Agent loop, tool execution, approval gating, all in Rust. Exposes a JSON-RPC-over-NDJSON protocol (`src/protocol.rs`) consumed over stdio.
- **`boxcode-ide`** (this repo) — the face. A Code-OSS fork with a thin TypeScript extension that talks to the daemon. No agent logic lives here.

The `boxcode-agent` extension launches `boxcode --acp` and speaks to it over stdio — the same pattern OpenAI's Codex app-server proves across CLI, Desktop, IDE, and Cloud from one backend.

Full plan: [`docs/PLAN.md`](docs/PLAN.md). Current priority (Tier 1 baseline-IDE verification, Tier 2 on deck, small parallel-track items): [`docs/BACKLOG.md`](docs/BACKLOG.md).

## Repository layout

| path | what it is |
|---|---|
| `src/stable/extensions/` | bundled boxcode extensions (`boxcode-agent`, `boxcode-theme`) |
| `patches/` | VSCodium-style build-time patch set (de-branding, Open VSX, telemetry, UI) |
| `docs/` | `PLAN.md`, `BACKLOG.md`, and the how-to/usage guides |
| `build/` | platform packaging (linux/osx/windows/alpine) |
| `dev/` | dev build helpers (`build.sh`, `patch.sh`, `update_patches.sh`) |
| `stores/` | snapcraft, winget, and Flatpak packaging metadata |
| `upstream/` | pinned `microsoft/vscode` tag/commit |
| `product.json` | boxcode product identity (name, quality, marketplace wiring) |

## Building

The fork tracks a pinned upstream and patches it at build time — VSCodium's model, so there's no permanently-diverged VS Code history to merge:

- **Upstream pin:** `microsoft/vscode` `1.126.0` @ `7e7950df89d055b5a378379db9ee14290772148a` (`upstream/stable.json`)
- **Node:** `24.15.0` (`.nvmrc`); plus `jq`, `git`, `python3` 3.11, and `rustup`

```sh
./dev/build.sh          # dev build (Linux/macOS; Git Bash on Windows)
./dev/build.sh -p       # also generate packages/installers
```

Full dependency lists (including Windows WiX/MSI and Linux dpkg/rpm/snap/flatpak) and the CI/downstream flow are in [`docs/howto-build.md`](docs/howto-build.md); the no-packaging dev loop is in [`docs/iterate-locally.md`](docs/iterate-locally.md). CI compiles macOS and Windows x64 on PRs; Linux stays workflow-dispatch-only.

## Documentation

- [`docs/PLAN.md`](docs/PLAN.md) — the phases and the reasoning behind them
- [`docs/BACKLOG.md`](docs/BACKLOG.md) — Tier 1 → Tier 4, with `[ ]`/`[x]`/`[~]` status markers
- [`docs/howto-build.md`](docs/howto-build.md) — building locally (all platforms)
- [`docs/iterate-locally.md`](docs/iterate-locally.md) — dev loop without packaging a `.dmg`
- [`docs/usage.md`](docs/usage.md) / [`docs/troubleshooting.md`](docs/troubleshooting.md) — using + debugging a build
- [`docs/extensions.md`](docs/extensions.md) / [`docs/extensions-compatibility.md`](docs/extensions-compatibility.md) — marketplace + extension compatibility
- [`docs/telemetry.md`](docs/telemetry.md) — what's disabled and how to verify it

## Open decisions — do not assume, ask before proceeding

These are deliberately **not** decided by this scaffolding commit:

- **License.** Code-OSS itself is MIT. Whatever boxcode-specific code lands in this repo (the extension, any modified `product.json`, build tooling) needs its own explicit license decision — this is a business call, not a default to inherit silently.
- **Trademark handling.** "Visual Studio Code" and the official product name/icon are Microsoft trademarks. A clean Code-OSS fork (see [VSCodium](https://github.com/VSCodium/vscodium) for precedent) has to strip Microsoft's `product.json` branding, telemetry endpoints, and default-marketplace wiring before any public build ships. Not done yet — do not ship a build with Microsoft's branding/telemetry intact.
- **Repo visibility.** Made public 2026-09-04 (deliberate decision — nothing confidential was found in the tree, confirmed by a secret-pattern scan before flipping). This was a one-way door: forks/clones from before this point persist even if the repo is re-privated later, so treat "private again" as "newly private," not "back to before."

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).
