# MCP verification — what the installed CLI actually does

Date: 2026-09-18. Status: **observed empirically, not inferred from source.**

## Why this exists

`docs/MCP.md` claims the `mcpServers` field already exists in the ACP `session/new`
params and that the CLI parses but ignores it. That was read from source. This file
records an end-to-end test that promotes it to fact — and that turned up something
the source reading had missed.

## Method

The risk with "does it ignore MCP servers?" is that a silent no-op looks identical to
a feature that is merely misconfigured. So the test did not ask "did it error?" —
it asked **"did it run the server?"**

1. A `session/new` request was sent with a real `mcpServers` entry whose `command`
   writes a marker file. Any attempt to honour that entry would touch the file.
2. The request was piped to the installed binary in ACP mode, with a kill guard.
3. The marker file's existence was checked afterwards.

If the CLI acted on `mcpServers`, the marker file exists. If it ignored them, it does not.

## Result

- The CLI **accepted `--acp`** and responded on stdio. So the flag is real on the
  installed binary even though `--help` does not list it.
- `initialize` answered with:

      "agentCapabilities": { "promptCapabilities": { "image": true }, "session": {} }

  **There is no MCP capability in that response.** The only advertised prompt
  capability is `image`.
- `session/new` was **accepted without error** and returned a session id, despite
  carrying a populated `mcpServers` entry.
- **The marker file was never created.** The server was not spawned.

## What this establishes

1. **`mcpServers` is accepted and silently discarded.** The CLI returns success for a
   request it does not fulfil. This is the dangerous shape: the extension cannot use
   "did the call fail?" as evidence that MCP worked, because it never fails.
2. **The capability handshake is the only reliable signal.** `initialize` is where a
   future MCP-capable CLI would advertise the capability. Until that field appears,
   sending server configs is a silent no-op. The extension therefore must gate on an
   explicit MCP capability in `initialize` and must **not** infer support from the
   request being accepted, nor from the version string.
3. **The claim in `docs/MCP.md` is confirmed**, with the addition that the failure is
   silent rather than loud — which raises the priority of the capability gate.

## Scope and limits

- Tested against the binary at `/usr/local/bin/boxcode`, reporting version `1.11.40`.
- `--acp` is not listed in `--help`; it was confirmed by running it.
- This says nothing about how a future MCP-capable CLI will behave. The gate must be
  written against the capability field, not against this binary's observed behaviour.
- The probe used a benign marker command, and was torn down after the run.
