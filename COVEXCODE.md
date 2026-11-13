# Working notes

Facts about this repo that are not obvious from the code and that cost real time
to rediscover.

## Toolchain on this machine

- **There is no `node`/`npm` on `PATH`.** Use the bundled Electron runtime as
  Node — it is v24.15.0, exactly what `.nvmrc` pins:

  ```sh
  ELECTRON_RUN_AS_NODE=1 "./Covexcode QA.app/Contents/MacOS/Covexcode" -e "console.log(process.version)"
  ```

  That works for every `node` invocation, including `node --test` and `tsc`.
- **esbuild is not installed in the extension's `node_modules`**, but a full one
  exists in the VS Code tree:
  `vscode/extensions/node_modules/@esbuild/darwin-arm64/bin/esbuild`.
  `src/stable/extensions/covexcode-agent/esbuild.mts` cannot run as-is from a
  freshly-prepared `src/` tree — it imports `../esbuild-extension-common.mts`,
  which only exists at `vscode/extensions/esbuild-extension-common.mts`. Bundle
  the extension directly with the flags that helper uses:

  ```sh
  vscode/extensions/node_modules/@esbuild/darwin-arm64/bin/esbuild \
    src/extension.ts --bundle --platform=node --minify --tree-shaking=true \
    --sourcemap --target=es2024 --external:vscode --format=cjs \
    --main-fields=module,main --outfile=dist/extension.js
  ```
- `tsc -p tsconfig.json --noEmit` reports **80 pre-existing errors** (ES5 target,
  `Thenable`, QuickPick `label`). That is the baseline — compare against it
  rather than treating a non-zero exit as a regression. `tsconfig.test.json` is
  the clean one and excludes `src/extension.ts`.
- The extension's real entry point is `dist/extension.js` (see `package.json`
  `main: ./dist/extension`). `out/extension.js` is stale build output that
  nothing loads — do not edit or inspect it expecting current behaviour.

## ACP protocol: how file diffs actually travel

Verified against the bundled agent sidecar (v1.11.95) by capturing real
`--acp` traffic. This is the single most important thing to know before
touching the chat-panel diff feature:

- A file's before/after text (`ToolCallContent.diff`: `oldText`, `newText`,
  `hunks`) is emitted **only inside `session/request_permission`**.
- `tool_call` / `tool_call_update` **never** carry a `diff` block. An `edit`
  that changed a file on disk reports `content: { type: 'content', text:
  "Replaced 1 occurrence(s) in '...'" }` and nothing more.
- The agent is spawned with `COVEXCODE_TOOLS_APPROVAL=destructive` in the
  default `auto` permission mode (`permissionMode.ts`), so an ordinary edit does
  **not** stop for approval — meaning no `request_permission`, and therefore no
  diff content on the wire at all. Only `manual` mode produces diffs.
- `session/list_changes` reports the files a turn changed (`path`, `turn`,
  `action`, `touches`) but **no file text**; `action: 'delete'` means the file
  did not exist before the session, `action: 'blocked'` means covexcode only ran
  a shell command against it (no before-state). No ACP method exposes
  before-images.
- The bundled agent's file tools are only `read_file`, `edit_file`,
  `write_file` — there is no delete tool. A shell `rm` is journaled `blocked`.
- Writing the file happens **before** the client sees the `tool_call`
  `in_progress` notification, so reading the file from an `in_progress` handler
  yields post-edit content. A pre-image cannot be captured that way; it has to
  come from the turn's own `read` tool results (see `TurnFileObserver` in
  `diffPreview.ts`).
- `ChatMultiDiffContentPart` (upstream) only builds a diff row when **both**
  `originalUri` and `modifiedUri` are set. Passing `undefined` for either one
  silently degrades the row to a plain file entry.

## Verification tooling added

- `test/capture-diff-wire.mjs <binary> <cwd> <prompt> <out.jsonl>` — runs one
  real agent turn, auto-answers permission prompts, and records every
  notification plus the journal.
- `test/capture-multi-turn.mjs <binary> <cwd> <out.jsonl> <prompt>...` — runs
  several prompts in ONE session and records the journal after each turn.
- `test/verify-diff-pipeline.mjs <captured.jsonl> <compiled-dir>` — replays a
  capture through the real diff logic and prints what the chat summary would
  render.
- `test/run-extension-e2e.mjs <extension.js> <cwd> <prompt>` — **the strongest
  check available**: loads the real compiled bundle against a stubbed `vscode`,
  activates it, and invokes the chat participant with a real agent turn,
  printing every part pushed to the response stream. Use this to confirm a
  `ChatResponseMultiDiffPart` actually reaches the chat, with its counts.
- `test/run-extension-multi-turn.mjs <extension.js> <cwd> <prompt>...` — the
  same, for several consecutive prompts in one session. This is the only way to
  check the "works on the first prompt, then stops" class of bug.

## Journal `turn` is first-touch, not latest-touch

`session/list_changes` pins `turn` to the turn a file was **first** touched and
increments `touches` instead. Editing the same file in turn 1 and turn 2 leaves
`{ turn: 1, touches: 2 }`. Filtering a turn's changes by `entry.turn ===
turn` therefore silently drops every later edit to that file — the summary
shows once and then never again. Compare against a `touches` snapshot instead
(`selectTurnChanges`).

## A `read` result is not always the whole file

The turn's `read` tool output is the only client-side source of a before-image
when no approval prompt fires, but models often read only part of a file. Using
a 60-line read as the pre-image of a 239-line file reported a one-line edit as
`+239 -60`. `isPlausibleBeforeImage()` requires the two texts to be ~90%
identical before their difference is shown, and falls back to a filename-only
row otherwise.

## The agent often uses `grep`, not `read_file`

The single biggest cause of "the dropdown shows a file but no line counts": in a
captured turn the agent never read the file at all -- it went
`grep min\(1120px in styles.css` -> `edit styles.css` -> `grep ... in` to verify.
There is therefore no `read` result to use as a before-image. Two sources cover
it, both in `recordObservedFile` / `appendJournalEntries`:

1. **Snapshot from disk at first interest.** Any inspecting tool (`read`,
   `view`, `grep`, `search`) runs while the file is still untouched, so reading
   it from disk at that moment is a true pre-image. Take the text from the file,
   **never** from the tool's own output -- `grep` returns only matching lines
   with `path:line:` prefixes, which would poison the diff.
2. **Carry the previous turn's content forward** (`lastKnownFiles`). Covers an
   agent that edits a file it already edited, with no inspection first.

The path comes from the tool-call title (`toolTitlePath`), which is the only
client-visible record of which file a call touched -- `tool_call_update` has no
path field. Mutating actions freeze the path so a later verification read cannot
overwrite the snapshot.

Verified shape of the titles: `read <path>`, `edit <path>`, `grep <pattern> in
<path>` (split on the LAST ` in `, the pattern may contain one).

## Testing the feature: check WHICH install you are in

A feature can be absent from an install even when the source has it, which looks
exactly like "the feature is broken":

```sh
for E in "/Applications/Covexcode IDE.app" \
         "Covexcode QA.app" \
         "VSCode-darwin-arm64/Covexcode IDE.app"; do
  D="$E/Contents/Resources/app/extensions/covexcode-agent/dist/extension.js"
  printf '%-46s %s MultiDiff=%s\n' "$E" "$(stat -f '%Sm' "$D")" "$(grep -c MultiDiff "$D")"
 done
```

`MultiDiff=0` means that build cannot show the changed-files dropdown at all.
The installed bundle is `dist/extension.js`, **not** `out/`.

Launching a second, isolated instance (own profile + own extensions dir), and
the `COVEXCODE_CONFIG_DIR` trap that makes it share production agent state:

```sh
env -u COVEXCODE_CONFIG_DIR \
  "./Covexcode QA.app/Contents/Resources/app/bin/covexcode-ide" \
  --user-data-dir "$HOME/Library/Application Support/Covexcode-QA" \
  --extensions-dir "$HOME/.covexcode-qa/extensions" \
  "$HOME/Documents/COVEXCODE-IDE-TESTING"
```

`COVEXCODE_CONFIG_DIR` outranks the profile (precedence: setting → env →
profile), so leaving it set points the "isolated" instance at production's
agent state.

## Inline (single-column) diff view

Clicking a row opens VS Code's diff editor
(`chat.editing.openChangedFileInDiffEditor` defaults to `true`). To show green
added / red removed lines in ONE column instead of side by side, set
`"diffEditor.renderSideBySide": false` -- it is a plain boolean and applies
live, no reload. `ChatEditingEditorOverlay`'s Accept/Reject chips are **not**
available to this extension: they come from a chat editing session, and
covexcode implements no `IChatEditingSession`.

## The chat response stream is append-only — parts cannot be replaced

Anything that wants a "live, updating" piece of chat UI has to work with this:

- `stream.push` only ever **appends**. A part already pushed cannot be replaced
  or removed, so "replace the previous entry" is not expressible mid-turn.
- The renderer index-aligns the response's content array against the parts it
  already built and asks `hasSameContent` per index; a newly pushed part lands at
  a new index and is always rendered as an extra part. Only `ChatToolInvocationPart`
  updates in place, and only because its `toolCallId` + `enablePartialUpdate` are
  matched by the renderer.
- Consequence for the file-change indicator: it is rendered once, at the end of a
  panel turn, and "replacement" means *one* entry in the part plus a fresh
  single-entry part per response. A turn that edits three files reports the third.
- `ChatResponseMultiDiffPart` is the only content type that renders a file row
  with real green/red `+N/-N` counts and opens the diff editor on click in both
  themes. A markdown row cannot carry those colours; don't try.

## `vscode/out` is not compiled in this checkout

`vscode/out/vs` contains only `tsconfig.tsbuildinfo` — the workbench has never
been compiled here. The app bundles under `VSCode-darwin-arm64/` and
`Covexcode QA.app` were built elsewhere, which means:

- A core change (`src/vs/**`) can be written and shipped as a `patches/NNN-*.patch`
  for the release build, but **cannot be built or verified in this checkout**.
- What *is* verifiable end to end is the extension: esbuild → `dist/extension.js`
  → copy into `Covexcode QA.app/Contents/Resources/app/extensions/covexcode-agent/dist/`
  → launch the QA app. Prefer an extension-only answer when a request can be
  satisfied that way, and say so when a core patch is only proposed, not proven.
- The built app's workbench CSS (`.../out/vs/workbench/workbench.desktop.main.css`)
  does contain the `patches/NNN-ui-*.patch` rules, so a CSS-only patch is
  verifiable by grepping that file — the JS bundle is not.

## Pushing to a closed response stream

A cancelled turn closes the response stream while the agent keeps emitting
notifications for a moment; every `stream.push` then throws and the extension
logged 413 errors in one second. `onUpdate` wraps `renderUpdate` in a try/catch
for that reason — do not remove it, or a cancel can abort the rest of the turn's
rendering, including the end-of-turn diff summary.

Provider credentials come from `COVEXCODE_API_KEY` / `COVEXCODE_MODEL` /
`COVEXCODE_ENDPOINT` in the environment; a live turn costs real tokens.

## Journal `action: 'delete'` does NOT mean "created this turn"

It means "the file did not exist before the **session**", and it stays that way
for the rest of the session. Reading it as "every line is new" made any later
turn that merely wrote such a file again report `+<all lines> -0` — and report
the file at all even when the write put back byte-identical content. Verified
with `test/run-extension-multi-turn.mjs`: turn 1 created `index.html` +
`styles.css`, turn 2 changed one line of the CSS, and turn 2 reported
`styles.css +3 -0`. Both branches now go through `decideJournalDiff` in
`diffPreview.ts`, which compares against the previous content first.

## `isPlausibleBeforeImage` must not gate a whole-file before-image

Its 90%-similarity rule exists to reject a *partial read* used as a before
image. Both real sources are whole files read from disk (`TurnFileObserver`
reads the file itself; `lastKnown` is the extension's own read), so applying the
ratio to them rejects the ordinary case instead: one changed line in a three-line
file is 67% similar and degraded to a no-counts dropdown row. Keep the ratio for
what it was written for; do not put it in front of a whole-file pre-image.

## `node --test` will happily pass against STALE compiled tests

`bin/tsc` only forwards to `lib/tsc.js`, and a wrong relative path to it fails
with `MODULE_NOT_FOUND` while leaving the previous `out-test/*.js` in place — so
the suite reports all-green for code that was never compiled. Compile with the
absolute entry point, then check the output actually contains the new symbols:

```sh
ELECTRON_RUN_AS_NODE=1 "./Covexcode QA.app/Contents/MacOS/Covexcode" \
  "$PWD/vscode/node_modules/typescript/lib/tsc.js" -p tsconfig.test.json
ELECTRON_RUN_AS_NODE=1 "./Covexcode QA.app/Contents/MacOS/Covexcode" \
  --test 'out-test/*.test.js'    # a bare `out-test/` directory reports a bogus failure
```

`tsconfig.test.json` also emits `TS5107` (deprecated `moduleResolution=node10`)
— that is a warning-shaped error, it still writes the output. And the "80
errors" figure for `-p tsconfig.json --noEmit` is version-dependent: with the
TypeScript in `vscode/node_modules` the same run reports 38, all pre-existing
(`Cannot find module 'vscode'`, `Thenable`, `RollbackPickItem.label`).
