# QA Report — Inline Single-File Change Indicator (latest modification only)

Status: **COMPLETE** — unit tests, live six-turn agent run, and an installed build
in `Covexcode QA.app`.

Supersedes the cumulative behaviour of `docs/qa-expandable-diff-preview.md`:
the chat panel no longer lists files. It shows **one** row — the file the agent
modified *last* — and the next modification replaces it.

---

## 1. Behaviour

| Situation | Indicator |
|---|---|
| Agent modifies `index.html` | `index.html  +5 -0` |
| …then modifies `style.css` | `style.css  +1 -1` — `index.html` gone |
| …then modifies `script.js` | `script.js  +2 -0` — `style.css` gone |
| …then returns to `index.html` | `index.html  +6 -1` — `script.js` gone, counts recalculated |
| Agent only reads `style.css` | unchanged / nothing |
| Agent modifies nothing at all | nothing is rendered |
| Agent edits a file, then reverts it | nothing (a net-zero is not a change) |

Rules the implementation is held to:

- **One file, ever.** The entries array handed to the renderer is capped at one.
  There is no accumulation and no duplicate row for a path.
- **Replace on modification.** A different file's change supersedes the visible
  row; re-modifying the displayed file updates that row and its counts.
- **Nothing on speculation.** Reading, opening, inspecting, grepping, mentioning
  a filename or planning around it never records anything.
- **Counts are measured, never estimated.** `+N/-N` is a real line diff from the
  file's *task-start* content to its latest content, recomputed on every change.
  No before-image ⇒ filename-only row.
- **Preserved:** row is clickable into the native Git-style diff editor, native
  green/red counts, light and dark theme support, no collapsible file list.

## 2. Where the state lives

`src/stable/extensions/covexcode-agent/src/diffPreview.ts` (no `vscode` import, so
it is unit-testable):

| Symbol | Responsibility |
|---|---|
| `ChangeBaselines` | Session-scoped, first-capture-wins task-start text per path. `''` = the file did not exist when the task started. |
| `TurnChanges` | One turn's genuine modifications, each stamped with a monotonic `order`. Re-recording a path replaces its single entry and re-stamps it as latest. `byRecency()` resolves each record's before-image to the task-start baseline. |
| `selectIndicatorChange()` | Picks the single thing to render, or `none`. Walks newest-first, skips no-ops, returns `diff` / `binary` / `listOnly` / `none`. |
| `decideJournalDiff()` | Unchanged; still decides whether a journaled touch changed anything at all. |

`src/stable/extensions/covexcode-agent/src/extension.ts` keeps only the wiring:
`recordObservedFile()` captures the baseline at inspection time (never a change),
`renderUpdate()` records a completed `diff`, `askPermission()` records an approved
one, `appendJournalEntries()` covers edits that never put a diff on the wire, and
`renderChangeIndicator()` pushes exactly one `ChatResponseMultiDiffPart` with one
entry at the end of a clean panel turn.

### Why one entry and not a custom widget

`ChatResponseMultiDiffPart` is the only chat content type that renders a file row
with the real green/red line counts and opens the diff editor on click, in both
themes. A markdown row cannot carry green/red counts, and a chat response stream
is append-only — a pushed part can never be replaced mid-turn (the renderer
index-aligns content and only skips re-rendering parts whose `hasSameContent`
matches). "Replacement" is therefore: exactly one entry in the part, and a fresh
single-entry part per response.

## 3. Unit tests

Command (no `node` on `PATH`; the bundled Electron runtime *is* Node 24):

```sh
cd src/stable/extensions/covexcode-agent
ELECTRON_RUN_AS_NODE=1 "../../../../Covexcode QA.app/Contents/MacOS/Covexcode" \
  "$PWD/../../../../vscode/node_modules/typescript/lib/tsc.js" -p tsconfig.test.json
ELECTRON_RUN_AS_NODE=1 "../../../../Covexcode QA.app/Contents/MacOS/Covexcode" --test 'out-test/*.test.js'
```

Result: **394 tests, 394 pass, 0 fail** (16 new indicator tests).

| Test ID | Scenario | Expected | Status |
|---|---|---|---|
| IF-U-01 | no modification recorded | `{ kind: 'none' }` | PASS |
| IF-U-02 | html → css → js | row is always the most recent file | PASS |
| IF-U-03 | return to an earlier file | that file is back in front, counts cover the whole task | PASS |
| IF-U-04 | same path recorded three times | `size === 1`, one row, no duplicate | PASS |
| IF-U-05 | counts after two edits of one file | measured from task-start content (`+2 -1`, not `+1 -0`) | PASS |
| IF-U-06 | file only inspected | `{ kind: 'none' }` | PASS |
| IF-U-07 | latest write put the bytes back | earlier real change still shown | PASS |
| IF-U-08 | edit then revert | `{ kind: 'none' }` | PASS |
| IF-U-09 | no before-image | `listOnly`, filename only | PASS |
| IF-U-10 | binary change | `binary`, no line counts | PASS |
| IF-U-11 | record removed by the journal | falls through to the remaining file | PASS |
| IF-U-12 | brand-new file | baseline `''`, every line added | PASS |
| IF-U-13 | deletion | every task-added line removed | PASS |
| IF-U-14 | `ChangeBaselines` first-capture-wins, clear | as documented | PASS |
| IF-U-15 | re-stamp without duplication | newest first, `length === 2` | PASS |
| IF-U-16 | stale wire hunks after a second edit | hunks dropped, text recount used | PASS |

Type check: `tsc -p tsconfig.json --noEmit` reports the documented 38 pre-existing
errors and nothing in `diffPreview.ts` / the changed regions of `extension.ts`.

## 4. Live agent run (real bundle, real turns)

Bundle + harness (see `COVEXCODE.md`):

```sh
vscode/extensions/node_modules/@esbuild/darwin-arm64/bin/esbuild \
  src/extension.ts --bundle --platform=node --minify --tree-shaking=true \
  --sourcemap --target=es2024 --external:vscode --format=cjs \
  --main-fields=module,main --outfile=dist/extension.js

ELECTRON_RUN_AS_NODE=1 "./Covexcode QA.app/Contents/MacOS/Covexcode" \
  test/run-extension-multi-turn.mjs dist/extension.js <qa-workspace> \
  "<prompt 1>" "<prompt 2>" … "<prompt 6>"
```

Observed (one session, six consecutive prompts, workspace with `index.html`,
`style.css`, `script.js`):

| # | Prompt | Part reached the stream |
|---|---|---|
| 1 | add a footer to `index.html` | `index.html` — 1 entry, `+5 -0` |
| 2 | change the body background in `style.css` | `style.css` — 1 entry, `+1 -1` (html gone) |
| 3 | add a `console.log` to `script.js` | `script.js` — 1 entry, `+2 -0` (css gone) |
| 4 | change the `h1` text in `index.html` | `index.html` — 1 entry, `+6 -1` (js gone, counts from task start) |
| 5 | read `style.css`, change nothing | **no part pushed** |
| 6 | add a second paragraph to `index.html` | `index.html` — 1 entry, `+7 -1` |

Every turn pushed at most one `ChatResponseMultiDiffPart`, and every part carried
exactly one entry — the QA sequence from the request, reproduced end to end.

## 5. Installed build

The rebuilt `dist/extension.js` was copied into
`Covexcode QA.app/Contents/Resources/app/extensions/covexcode-agent/dist/` and the
QA app launched against the same workspace with an isolated profile:

```sh
env -u COVEXCODE_CONFIG_DIR \
  "./Covexcode QA.app/Contents/Resources/app/bin/covexcode-ide" \
  --user-data-dir "$HOME/Library/Application Support/Covexcode-QA" \
  --extensions-dir "$HOME/.covexcode-qa/extensions" \
  "<qa-workspace>"
```

`COVEXCODE_CONFIG_DIR` must stay unset, or the "isolated" instance reads and
writes production's agent state (`COVEXCODE.md`).

## 6. Known boundaries

- The response stream is append-only, so an *earlier* turn's indicator stays in
  the conversation scrollback; only the current response's indicator is ever the
  live one. Mid-turn replacement within one response is not expressible in the
  chat API, so a turn that modifies three files reports the third.
- The native widget keeps its one-line header ("Changed 1 file") above the row.
  Removing that last piece of chrome needs a core change in
  `chatMultiDiffContentPart.ts`; `vscode/out` is not compiled in this checkout, so
  such a patch could not be built or verified here.
