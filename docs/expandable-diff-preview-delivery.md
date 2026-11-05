# Delivery Report — Expandable Git-Style Code Diff Preview

## A. Implementation summary

After an agent turn modifies files, the chat panel now shows a collapsible
**"Changed N files"** dropdown. The implementation reuses VS Code's native
`ChatResponseMultiDiffPart` (the same component the editor's own checkpoint and
chat-editing flows use), rather than building a parallel diff system.

- The agent extension already received every file diff over ACP as
  `oldText` + `newText` + per-line `hunks[]` (`DiffHunkLine` with 1-based
  `oldNo`/`newNo`), but panel turns dropped that data.
- `renderUpdate` now collects each **completed** `diff` tool-call result (keyed
  by path, latest write wins, failed/rejected writes excluded).
- At the end of a clean turn, `renderDiffSummary` pushes a
  `ChatResponseMultiDiffPart` whose entries carry virtual `covexcode-diff:` URIs
  (via the existing `DiffContentProvider`), the real on-disk file as
  `goToFileUri`, and **actual** `added`/`removed` line counts.
- Selecting a file opens VS Code's Git-style diff editor (red/green gutters,
  old/new line numbers, horizontal/vertical scroll, copy/select). Binary files
  are rendered as a note instead of binary-as-text.

Diff accounting lives in a new pure module (`diffPreview.ts`), free of `vscode`
imports so it is unit-tested under `node --test`.

## B. Modified files

| File | Purpose |
|------|---------|
| `src/stable/extensions/covexcode-agent/src/extension.ts` | Collect completed `diff` contents per turn; render the end-of-turn `ChatResponseMultiDiffPart` summary; binary-file notes. |

## C. New files

| File | Purpose |
|------|---------|
| `src/stable/extensions/covexcode-agent/src/diffPreview.ts` | Pure diff accounting: status detection, binary detection, hunk tallies, bounded line-diff fallback. |
| `src/stable/extensions/covexcode-agent/src/diffPreview.test.ts` | 12 unit tests covering the cases in section 2.1 of the QA report. |
| `docs/qa-expandable-diff-preview.md` | Full QA report (test inventory, results, findings, remaining issues). |

## D. Testing results

- Unit: **338/338 pass** (326 pre-existing + 12 new).
- Component: **DELEGATED** — rendering is VS Code's native, upstream-tested
  `ChatResponseMultiDiffPart`; no duplicate component harness added.
- Integration: **BLOCKED** (provider/API credentials) — built app + manual
  workspace are ready.
- Regression: unit suite **338/338 PASS**; built-app sidecar smoke **PASS**
  (`verify_sidecar.sh`, `sidecar-acp-smoke.sh`, ACP handshake OK).
- Edge/perf: covered at the data layer (see QA report §2.5/§2.6); large-diff
  fallback is bounded to `MAX_LCS_CELLS = 4_000_000`.

## E. Build results

- Build command: `./dev/build.sh` (macOS arm64, `OS_NAME=osx`,
  `VSCODE_ARCH=arm64`, `VSCODE_QUALITY=stable`), Node v24.15.0.
- Status: **SUCCESS** for the desktop app bundle + agent sidecar.
  The optional Rust `code` tunnel CLI step failed (`rustup: command not found`)
  and was skipped; it is not required to launch or test the diff feature.
- Architecture: arm64 (`Mac14,3`, macOS 26.4.1).
- Bundle: `VSCode-darwin-arm64/Covexcode IDE.app` (then copied to
  `Covexcode QA.app`).
- Sidecar: staged `covexcode` v1.11.95 (darwin-arm64), SHA-256 verified, ACP
  handshake OK.

## F. Isolated IDE launch

- **Launched:** yes. Running process PID **36388**:
  `…/covexcode_main_developing/Covexcode QA.app/Contents/MacOS/Covexcode`
  with `--user-data-dir "$HOME/Library/Application Support/Covexcode-QA"`
  and `--extensions-dir "$HOME/.covexcode-qa/extensions"`, opening
  `~/Covexcode-QA-Workspace`.
- **Production untouched:** confirmed — the pre-existing production app
  (`/Applications/Covexcode IDE.app`, PID 463) and its
  `~/Library/Application Support/Covexcode` data were not modified.
- **Separate dirs:** confirmed (`Covexcode-QA` user data, `~/.covexcode-qa/extensions`).
- QA app location: `/Users/bhavyabulani/Documents/covexcode_main_developing/Covexcode QA.app`.

## G. Remaining issues

- Live agent integration/regression run requires a provider/API key (manual
  steps below).
- Rename status is not surfaced by the ACP `diff` payload (single path), so a
  rename appears as add + delete entries.
- `covexcode-diff:` content is in-memory; diff entries are not durable across a
  full window reload (same as the pre-existing `showDiff`).
- The in-app title remains "Covexcode" (the bundle is named `Covexcode QA.app`).
  Re-branding the signed bundle post-build makes Electron refuse to start
  (SIGTRAP), so isolation is enforced by CLI flags instead.
- The optional Rust tunnel CLI was not built (no Rust toolchain).

## H. Manual testing instructions

1. The **Covexcode QA** app is already running with the QA workspace open. If it
   is closed, relaunch with:
   ```bash
   "/Users/bhavyabulani/Documents/covexcode_main_developing/Covexcode QA.app/Contents/Resources/app/bin/covexcode-ide" \
     --user-data-dir "$HOME/Library/Application Support/Covexcode-QA" \
     --extensions-dir "$HOME/.covexcode-qa/extensions" \
     "$HOME/Covexcode-QA-Workspace"
   ```
2. Configure a provider/model/key in the QA app (Sign In, `/provider`, or
   Settings → covexcode). This is separate from the production app's config.
3. In the chat panel, ask the agent to modify several files (e.g. "change the
   theme in App.jsx and add a dark-mode class to styles.css, and add a new
   component").
4. When the turn finishes, expand the **"Changed N files"** dropdown: each file
   shows its file icon and `+additions` / `-deletions` counts.
5. Click a file to open the Git-style diff (red removed, green added, line
   numbers). Test copy/select, horizontal scrolling for long lines, and multiple
   files.
6. Test Accept/Reject and rollback through the existing permission review /
   `covexcode: Undo Session's File Changes` flows — they are unchanged.
