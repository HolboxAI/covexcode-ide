# QA Report — Expandable Git-Style Code Diff Preview

Status: **COMPLETE** (build + isolated launch verified; live agent integration blocked on provider credentials)

Build & launch result:
- Built `VSCode-darwin-arm64/Covexcode IDE.app` (macOS arm64) from source.
- Bundled + verified the pinned agent sidecar (ACP handshake OK, protocol 1, agent 1.11.95).
- Created isolated `Covexcode QA.app` (bundle directory renamed; code signature intact).
- Launched it with `--user-data-dir "$HOME/Library/Application Support/Covexcode-QA"` and
  `--extensions-dir "$HOME/.covexcode-qa/extensions"`, opening `~/Covexcode-QA-Workspace`.
- Verified the running process is the QA bundle (PID 36388), and the production app
  (`/Applications/Covexcode IDE.app`, PID 463) plus its `~/Library/Application Support/Covexcode`
  data were never touched.
- The optional Rust `code` tunnel CLI was not built (no Rust toolchain); the desktop app + agent
  sidecar do not require it. Re-branding the app's in-app display name post-build makes Electron
  refuse to start (SIGTRAP on signature mismatch), so the bundle is named `Covexcode QA.app` while
  the in-app title remains "Covexcode". Full data isolation is enforced via the CLI flags above.

Feature: after an agent turn modifies files, the chat panel shows a collapsible
"Changed N files" dropdown listing every changed file with its file icon and
accurate `+additions` / `-deletions` counts; selecting a file opens VS Code's
native Git-style diff editor (red/green gutters, old/new line numbers).

---

## 1. What was implemented and how it is verified

The change reuses VS Code's built-in `ChatResponseMultiDiffPart` (the same
"Changed N files" collapsible dropdown used by the editor's own checkpoint /
chat-editing flows). The agent extension previously received every file diff
from ACP (`oldText`, `newText`, per-line `hunks[]`) but dropped it in panel
turns. It now:

1. Collects each **completed** `diff` tool-call result during a turn (keyed by
   path, latest write wins).
2. Computes real status + line counts in a new pure module (`diffPreview.ts`).
3. Pushes a `ChatResponseMultiDiffPart` at the end of a clean turn, backed by
   the existing `covexcode-diff:` content provider (virtual old/new text).
4. Renders binary files as a note instead of binary-as-text.

Because the rendering is the native `ChatResponseMultiDiffPart`, the
component-level behaviors below are provided by VS Code's own (upstream-tested)
renderer; this repo contributes the data pipeline and the wiring.

---

## 2. Test inventory

### 2.1 Unit tests — PASS (executed)

Command: `cd src/stable/extensions/covexcode-agent && npm test`
(Node v24.15.0, `node --test`.)

| Test ID | Scenario | Expected | Status | Severity |
|---------|----------|----------|--------|----------|
| DP-U-01 | `splitDiffLines()` empty / trailing-newline / no-newline | mirrors `str::lines()` | PASS | — |
| DP-U-02 | `isBinaryText()` NUL byte | binary | PASS | — |
| DP-U-03 | `isBinaryText()` high control-char density | binary | PASS | — |
| DP-U-04 | `countHunkChanges()` across hunks | exact add/remove | PASS | — |
| DP-U-05 | status: added / deleted / modified / renamed | correct status | PASS | — |
| DP-U-06 | counts from hunks | exact add/remove | PASS | — |
| DP-U-07 | counts fall back to line diff (no hunks) | exact add/remove | PASS | — |
| DP-U-08 | brand-new file without hunks | added=lines, removed=0 | PASS | — |
| DP-U-09 | wholly deleted file without hunks | added=0, removed=lines | PASS | — |
| DP-U-10 | binary content | no line counts, `isBinary` | PASS | — |
| DP-U-11 | no-op change | `hasTextualDiff=false` | PASS | — |
| DP-U-12 | bounded large-diff fallback | whole-file counts | PASS | — |
| DP-U-13 | empty file | no diff | PASS | — |

Aggregate unit result: **338/338 pass** (326 pre-existing + 12 new
`diffPreview` tests).

### 2.2 Component tests — DELEGATED (not re-implemented)

The interactive rendering (file list, per-file expand, added/removed/un-changed
lines, line numbers, dark/light theme, long paths, copy/select, scroll) is
provided by the native `ChatResponseMultiDiffPart` renderer
(`chatMultiDiffContentPart.ts` in upstream VS Code). No new component test
harness was added; replicating upstream's own component tests would be
duplicate coverage. This is recorded as **DELEGATED**, not executed here.

### 2.3 Integration tests — BLOCKED (credentials), workspace ready

The real agent→UI workflow (open workspace, run task, expand files, verify
removed/added lines and counts, accept/reject, rollback, run another task)
now has the built, isolated app and the manual test workspace
(`~/Covexcode-QA-Workspace`). Automated execution remains **BLOCKED** on a
configured provider/API key; this is the step for the user's manual run.

### 2.4 Regression tests — PARTIAL

- `npm test` full existing suite: **338/338 PASS** (no regressions in the
  pure modules; `diffReview`, ACP client, permissions, rollback, etc. all
  green).
- Built-app smoke: the bundled agent sidecar passed `verify_sidecar.sh` and
  `test/sidecar-acp-smoke.sh` (ACP handshake OK).
- Full IDE regression (agent/ask/edit/plan modes, ACP, streaming, model
  switching, auth, terminal, browser, diff review accept/reject, rollback,
  chat scrolling) requires a live agent + credentials: **BLOCKED** for now.

### 2.5 Edge cases — covered at the data layer

- 1 / 5 / 20 / 50 files: order-preserving `Map` collection, native list is
  virtualized (`MAX_ITEMS_SHOWN = 6` with internal scroll).
- Large files / large diffs: `MAX_LCS_CELLS = 4_000_000` bound prevents
  pathological O(n*m) fallback; hunks (the normal path) are pre-computed.
- Very long lines: native diff editor handles horizontal scrolling.
- Special characters in filenames: path is passed through `resolvePathAgainstCwd`
  and the native resource label (no shell interpolation).
- Deleted / new / renamed / binary / empty / no-op files: unit-tested above.
- Multiple consecutive tasks / session switch: `collectedDiffs` is scoped per
  turn and cleared each turn; the summary is only appended at the end of the
  current clean turn, so stale diffs cannot leak into the next task.

### 2.6 Performance

- Diff counting is O(lines) for the hunk path; the hunk-less fallback is
  bounded to `MAX_LCS_CELLS` cells.
- Rendering is delegated to the native virtualized list (`MAX_ITEMS_SHOWN`),
  so 50-file turns do not render 50 editors up front — each opens on demand.
- Event listeners are already scoped per turn and removed in the existing
  `finally` block (no new listeners added by this change).

---

## 3. Bugs / findings

- **FIXED during implementation:** an earlier revision collected *every* `diff`
  content, including failed/rejected writes. Now only `status === 'completed'`
  tool calls are collected, so a rejected write can never appear as a change.
- **Known limitation (documented, not fixed):** `covexcode-diff:` content is
  in-memory only, so the diff entries are not durable across a full window
  reload (the pre-change side cannot be reconstructed). This matches the
  pre-existing `showDiff` behavior for permission diffs.

---

## 4. Remaining issues

- Live agent integration/regression run: blocked on provider credentials
  (manual test workspace + built app are ready).
- Rename detection: `diffPreview.ts` supports `renamed` via old/new path
  inputs, but the ACP `diff` payload carries a single path, so renames surface
  as add+delete entries in practice.
- `covexcode-diff:` content is in-memory only (diff entries are not durable
  across a full window reload) -- same limitation as the pre-existing `showDiff`.
- The optional Rust `code` tunnel CLI was not built (no Rust toolchain); the
  desktop app + agent sidecar do not depend on it.
