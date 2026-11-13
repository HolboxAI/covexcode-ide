# Review Bar — Verification & Phase 0 Spike Notes

Pinned upstream VS Code commit: `7e7950df89d055b5a378379db9ee14290772148a`  
Next free patch number verified from `patches/ | sort -V`: **`122`** (`patches/122-ui-chat-review-bar.patch`)

---

## 1. Verified Upstream VS Code Identifiers

All identifiers were grepped and read directly from the pinned upstream tree before writing code:

| Concept / Role | Verified Identifier | Location in Upstream (`7e7950df89...`) |
|---|---|---|
| Chat widget interface | `export interface IChatWidget` | `src/vs/workbench/contrib/chat/browser/chat.ts:346` |
| Chat widget implementation | `export class ChatWidget extends Disposable implements IChatWidget` | `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:210` |
| Chat input box widget | `export class ChatInputPart extends Disposable implements IHistoryNavigationWidget` | `src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts:231` |
| Input DOM class | `.interactive-input-part` | `src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts:2611,2639` |
| Native editing session container | `chatEditingSessionWidgetContainer` / `.chat-editing-session` | `src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts:333,2620,2648` |
| Pre-input docked widget pattern | `chatSuggestNextWidget: ChatSuggestNextWidget` | `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:284,540,745-760` |
| Docked widget CSS pattern | `.interactive-session > .chat-suggest-next-widget` | `src/vs/workbench/contrib/chat/browser/widget/media/chat.css:3997` |
| Layout & height accounting | `layout(height, width)` and `_layoutListForInputHeight()` | `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts:2857-2908` |
| Request footer menu ID (moved by patch `121`) | `MenuId.ChatMessageTitle` (`.chat-request-footer`) | `src/vs/workbench/contrib/chat/browser/widget/chatListRenderer.ts:547` |
| Editing session interface | `IChatEditingService`, `IChatEditingSession`, `IChatEditingSessionProvider` | `src/vs/workbench/contrib/chat/common/editing/chatEditingService.ts:102` |
| Extension external edit bridge | `ExtHostChatRequestResponseStream.externalEdit` | `src/vs/workbench/api/common/extHostChatAgents2.ts:300-340` |

### `ChatWidget` DOM & Layout Hook (`chatWidget.ts:745-760`, `2857-2908`)
- When `!renderInputOnTop`, `ChatWidget.render` appends `.interactive-list`, then `this.chatSuggestNextWidget.domNode`, then calls `this.createInput(...)`.
- Height changes fire `onDidChangeHeight` which calls `if (this.bodyDimension) { this.layout(this.bodyDimension.height, this.bodyDimension.width); }`.
- Both `layout()` and `_layoutListForInputHeight()` subtract docked widget height from `inputMaxHeight` and `contentHeight` before laying out `listWidget`, `welcomeMessageContainer`, and `listContainer`.
- Routing per widget instance matches existing code in `chatWidget.ts:447,643`: `isEqual(this.viewModel?.sessionResource, resource)` combined with `this.onDidChangeViewModel`.

---

## 2. Why `IChatEditingSession` Cannot Be Cheaply Fed from the ACP Sidecar (Phase 4 Note)

1. **Lifecycle mismatch (`externalEdit` vs post-hoc sidecar journal):**
   - `IChatEditingSession.startExternalEdits` (`chatEditingSession.ts:660-835`) and extension API `stream.externalEdit(target, callback)` (`extHostChatAgents2.ts:300-340`) require the participant to declare each modified `URI` **before** touching disk so VS Code can snapshot its buffer, hold an edit lock, and record an entry.
   - `covexcode --acp` executes file edits autonomously inside `session/prompt` and returns only post-hoc journal entries via `session/list_changes` (`{ path, turn, touches, action }`). Shell edits cannot be bracketed at all beforehand.
2. **Rollback journal split-brain:**
   - Native `IChatEditingSession.reject()` only restores VS Code's own `chatEditingSession` baseline snapshot on disk; it never updates `covexcode`'s internal sidecar rollback journal, leaving `session/list_changes` and per-turn `covexcode.restoreCheckpoint` out of sync.
3. **Missing requirements & high patch surface:**
   - `IChatEditingSessionProvider` has no representation for un-undoable `blocked` / `shellWarning` rows, no Section 6 external-edit safety checks against `agentWrote[path]`, and wiring a proposed/custom provider from an extension requires patching `vscode.proposed.*.d.ts`, `extHost`, `mainThread`, and `chatEditingService` across multiple core files (vs ~15 lines in `chatWidget.ts` + scoped CSS + one self-contained widget `chatReviewChangesBar.ts`).
4. **Conclusion:** Keeping `chatReviewChangesBar.ts` fed via extension commands (`getState` + push event routed by `sessionResource`) is far thinner, safer against upstream drift, and keeps core diffs isolated to `chatWidget.ts`, `chat.css`, and the new widget file.

---

## 3. Phase 0 Sidecar Spike Results (`scripts/spike-rollback.ts`)

Tested live against `/Users/krishsharma/.local/bin/covexcode` (`covexcode 1.11.94`, ACP `protocolVersion: 1`) in isolated temporary workspaces.

### Scenario 1: Multi-turn edits (`a.ts` T1, `b.ts` T2, `a.ts` T3) -> `session/rollback({ files: ['a.ts'] })`
- **Before rollback `list_changes`:**
  - `a.ts`: `{ action: "restore", turn: 1, touches: 2, reason: null }`
  - `b.ts`: `{ action: "restore", turn: 2, touches: 1, reason: null }`
- **`rollback({ files: ['a.ts'] })` response:** `"Rolled back 1 file(s): 1 restored, 0 deleted.\n  restored  a.ts"`
- **Result on disk:** `a.ts` was restored to `"export const a = 0;\n"` (**the pre-session original state**, NOT Turn 2 state). `b.ts` remained `"export const b = 2;\n"`.
- **After rollback `list_changes`:** Only `b.ts` (`turn: 2, touches: 1`) remains.

### Scenario 2: Roll back `a.ts`, then edit `a.ts` again in Turn 4
- **Turn 4 result:** `a.ts` becomes `"export const a = 4;\n"`.
- **After Turn 4 `list_changes`:** `a.ts` reappears as `{ action: "restore", turn: 4, touches: 1, reason: null }`.
- **Answer:** **`touches` resets to `1` after rollback** (so `touches` counts can repeat across rollbacks and are insufficient alone without content-hash comparison).

### Scenario 3: `rollback` with `turn` and `restoreBeforeTurn` on a single file
Setup: `x.ts` edited in Turn 1 (`v1`) and Turn 2 (`v2`); `y.ts` edited in Turn 2 (`y2`).
- **3A — `rollback({ files: ['x.ts'], turn: 2 })`:**
  - Returned: `"Rolled back nothing — every file was already as the session found it."`
  - Disk unchanged (`x.ts` still `v2`, `y.ts` still `y2`); `list_changes` unchanged (`x.ts` has `turn: 1`). `turn` only matches files *first touched* in that turn.
- **3B — `rollback({ files: ['x.ts'], restoreBeforeTurn: 2 })`:**
  - Returned: `"Rolled back 2 file(s): 2 restored, 0 deleted.\n  restored  x.ts\n  restored  y.ts"`
  - Disk: `x.ts` became `"v1\n"` AND **`y.ts` was also rolled back to `"y0\n"`** — `restoreBeforeTurn` **ignores `files`** and rolls back ALL files touched at `turn >= 2`.
  - **CRITICAL:** `list_changes` after 3B became **`{ changes: [], shellWarning: null }`** even though `x.ts` still has Turn 1 edits on disk (`v1\n`).

### Scenario 4: Shell command modifies a file (`echo "from-shell" >> s.txt`)
- **`list_changes` response:**
  ```json
  {
    "changes": [],
    "shellWarning": "1 shell command(s) also ran this session and are not undone by this: echo \"from-shell\" >> s.txt"
  }
  ```
- **Answer:** Shell side effects are reported via **`listChanges.shellWarning`** (string), NOT as an entry in `listChanges.changes` (`action: 'blocked'` in `changes` covers non-shell blocked entries). `computePending` must synthesize a dismissible `kind: 'shell', undoable: false` entry from `shellWarning` when present, in addition to handling `action === 'blocked'` entries in `changes`.

### Scenario 5: Cancel / error a turn mid-edit
- `session/cancel` JSON-RPC notification is not wired into `HeadlessSession` in v1 (matching `extension.ts:1214`), so in-flight writes continue unless aborted by process exit/permission rejection; all completed file edits remain recorded in `list_changes` (`c1.ts`, `c2.ts` both present with `action: "restore", turn: 1`). Therefore refreshing on cancelled/errored turns is required so the Review Bar surfaces partial edits.

### Scenario 6: Agent creates `temp.ts`, then deletes `temp.ts`
- **`list_changes` response:**
  - `changes`: `[{ action: "delete", path: "temp.ts", reason: null, touches: 1, turn: 1 }]`
  - `shellWarning`: `"1 shell command(s) also ran this session and are not undone by this: rm temp.ts && ls"`
- **Answer:** Even when `temp.ts` is already `<ABSENT>` on disk, `list_changes` still returns `{ action: "delete", path: "temp.ts" }`! Comparing the disk hash (`'absent'`) handles this cleanly: if `action === 'delete'` and the normalized file is currently `'absent'` on disk, there is nothing created left on disk to review/delete, so `computePending` should omit it (no phantom `Added` row).

---

## 4. Phase 0 Architecture Decision (`planReject`)

**Decision: `phase0Mode = 'snapshots'`**

1. Because sidecar `rollback({ files })` always restores pre-session originals and `restoreBeforeTurn` ignores `files` (and wipes journal entries from earlier turns), **the extension MUST capture accept-time content snapshots** whenever a file is accepted (for files within the size cap; or metadata fallback note if oversized).
2. **`planReject(pending, state, 'snapshots')` splits targets cleanly:**
   - **Never-accepted files** (`!state.accepted[path]`): put into `sidecarRollback` -> executed via `client.rollback(sessionId, { files })` (verified safe for single/subset files in Scenario 1).
   - **Previously-accepted files** (`state.accepted[path]` exists): put into `restoreFromSnapshot` -> restored directly from the extension's accept-time snapshot (write snapshot bytes if `hash !== 'absent'`, or safe delete + close tab if snapshot was `'absent'`), WITHOUT calling sidecar `rollback` (which would wrongly wipe earlier accepted edits).
   - After snapshot restore of a previously-accepted file, record `accepted[path]` at the current snapshot/touches so the file leaves pending until modified again, and update `agentWrote[path]`.

### Invariant: Never call `restoreBeforeTurn` from the Review Bar
As verified in Phase 0 Scenario 3B above, passing `restoreBeforeTurn` to `session/rollback` **ignores `files`** (reverting unrelated files touched in subsequent turns) and **wipes journal entries from earlier turns** (`list_changes` goes empty even when earlier accepted/unaccepted edits remain on disk).
- **Enforcement in `src/stable/extensions/covexcode-agent/src/reviewController.ts`:** `ReviewAcpClient.rollback` types `restoreBeforeTurn?: never; turn?: never`, and all sidecar rollbacks go through `safeRollbackFiles(client, sessionId, files)` which throws immediately if `restoreBeforeTurn` is ever supplied. Only `{ files }` may be passed to sidecar `rollback`, and only for never-accepted files.

