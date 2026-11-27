# Omarchy Server assistant

Date: 2026-11-17
Status: approved
Repo: omarchy-server. Ship on `feat/assistant` from `upstream/main`. Open a PR against MyOwnDataCenter/server when the slices below are done. Do not add local clone-path wiring.

## 1. Goal

Give every signed-in person a chat assistant inside Omarchy Server. They add an AI provider and API key (or use a key someone shared with them). They can ask questions about this server and its Local swarm. They can ask for a change; the assistant proposes the same operations the UI already has, as step-by-step cards; the person hits Approve or Reject on each mutating step.

Example: “I need a new virtual machine running Ubuntu.” The assistant looks up images and host capacity (reads run on their own), then shows a card for `machines.create` with the proposed name, image, cores, memory, and disk. Approve runs that RPC. Further steps (start, and so on) appear the same way.

## 2. Why

The UI already knows how to install apps, create VMs, and manage swarm computers. People still have to find the right screen and remember the order. An assistant that can see those operations, explain a plan, and wait for Approve on each write is the smallest way to add that help without giving the model a shell.

## 3. Non-goals (v1)

- Shell, `podman exec`, or any “run this command”
- Writing or editing software, or writing files on the host
- Native Anthropic API (OpenAI-compatible covers OpenAI, Ollama, LiteLLM, SpaceXAI)
- SpaceXAI server-side web search / X search
- Manual MCP URLs; stdio MCP into a container
- MCP on `openPorts` (those skip the app gateway)
- Driving several Omarchy Server installs from one chat
- Encrypt-at-rest beyond `0600` on the keys file
- “Approve remaining”, editing args on a card, voice, file attachments
- Using the host’s Ollama unit unless the user adds it as an OpenAI-compatible key
- App-store listings that actually declare `mcp:` (follow-up store PR). This server accepts the field in v1 even if no listing uses it yet
- Browser E2E (Playwright `networkidle` already hangs on this SPA)

## 4. Architecture

The chat loop lives in omarchyd. The SPA is a window. Keys never reach the browser.

```
Phone Home tile / desktop window
        │ cookie session
        ▼
web :7780  /api/assistant/stream  + assistant.* RPCs
        │ session, size cap, no key in logs or responses
        ▼
omarchyd :2021
  assistant loop ──► HTTPS chat/completions (SpaceXAI or OpenAI-compatible)
       │
       ├─ read tool  → existing query RPC → tool result back to the model
       ├─ write tool → pending action + Approve card (do not run)
       └─ MCP tool   → only running installed apps whose listing declared mcp:
                       HTTP/SSE to 127.0.0.1 (loopback publish, not the browser gateway)
```

Provider HTTP is **OpenAI-compatible `POST /v1/chat/completions` with `tools`**, streamed. One client covers SpaceXAI (`https://api.x.ai/v1`) and Ollama/LiteLLM/OpenAI. Do not use the SpaceXAI Responses API: Ollama does not speak it.

SpaceXAI default model id is the current chat model on https://docs.x.ai/developers/models at implementation time (as of 2026-11-17 that is `grok-4.7`). Re-check the models page when writing the code. Tool-call streaming: xAI returns each function call in a single chunk, not split across chunks.

`parallel_tool_calls: false`. One in-flight provider request per conversation; a new send aborts the previous.

## 5. Components

| Piece | Lives | Job |
|---|---|---|
| Assistant store | `omarchyd/assistant/` | Keys, conversations, pending actions. `writeAtomic` with mode `0o600`, same as the swarm connector file. |
| Agent loop | `omarchyd/assistant/loop.mjs` | One turn: provider call, read tools, pending writes, stream events. |
| Built-in tools | `omarchyd/assistant/tools.mjs` | Curated wrappers around existing RPCs. Not every RPC. |
| MCP client | `omarchyd/assistant/mcp.mjs` | HTTP/SSE to a catalog-declared app port on `127.0.0.1`. |
| Providers | `omarchyd/assistant/providers.mjs` | SpaceXAI vs openai-compatible base URL, headers, parse stream. |
| Web proxy | `server/app.mjs` | Session cookie, `/api/assistant/stream`, allow-list the new RPCs. Never returns `apiKey`. |
| Chat UI | `web/src/screens/Assistant.tsx` | Thread, streaming text, Approve/Reject cards. |
| Settings | Settings → Assistant | Add provider/key, share, owner default. |
| Catalog field | `omarchy-app.yml` `mcp:` | Optional. Parsed in `omarchyd/apps.mjs` and kept on the installed app record. |

Wire `createAssistant` from `omarchyd/server.mjs` the same way as apps/machines. Home tile next to Terminal. Desktop window kind `assistant`, same open/reuse pattern as Terminal. Members see the tile; the tool list still follows their role.

## 6. Data model

Directory: `<omarchyd dataDir>/assistant/`.

### Keys (`keys.json`, mode 0600)

```
{
  keys: [
    {
      id, ownerUserId, name,
      provider: 'spacexai' | 'openai-compatible',
      baseUrl,          // spacexai defaults to https://api.x.ai/v1
      model,
      apiKey,           // never in query output
      last4,
      sharedWith: [userId, ...],
      systemDefault: false,
      createdAt, updatedAt
    }
  ]
}
```

Client view of a key: `{id, name, provider, baseUrl, model, last4, ownerUserId, sharedWith, systemDefault, mine}`. Add/replace sends `apiKey` once. Update can change name, model, base URL, share list, replace secret, or (owner only, and only on a key they own) `systemDefault`. Setting default clears it on every other key. Delete asks in the UI first.

A user may use a key if they own it, it is in `sharedWith`, or it is the system default. Turn key pick: `keyId` in the request if allowed, else the thread’s last key, else one they own, else one shared with them, else system default. None → no provider call; UI shows the empty state.

### Conversations (`conversations/<id>.json`, mode 0600)

Per user. Fields: `id`, `userId`, `title`, `keyId`, `createdAt`, `updatedAt`, `messages[]`.

A message is one of:

- `{role: 'user', content, at}`
- `{role: 'assistant', content, at}`
- `{role: 'tool', toolCallId, name, content, at}`
- `{role: 'action', actionId, at}`

Keep the last 40 messages in the prompt. Unresolved pending actions in the thread are always included. Title: first user line, clipped to ~48 characters, until the user renames (v1: no rename UI; title stays auto).

### Pending actions (embedded in the conversation file)

```
{
  id, conversationId, userId,
  status: 'pending' | 'rejected' | 'running' | 'done' | 'error',
  kind: 'rpc' | 'mcp',
  toolName,
  title,          // card heading, e.g. Create VM “web”
  detail,         // human arg list
  rpc: {path, input} | null,
  mcp: {appId, tool, arguments} | null,
  createdAt, resolvedAt, error
}
```

Approve re-checks the caller is `userId`, the action is `pending`, and the caller may still run that RPC (or manage that app). Then `running` → the existing procedure → `done` or `error`. Reject sets `rejected` and does not call the procedure. The model is told the outcome on the next turn (Approve can optionally continue the loop immediately with the result; v1 does that so “approve, approve, approve” does not require typing between cards).

Captured `input` / `arguments` are frozen at propose time. v1 has no edit-on-card; reject and tell the assistant. There is no “approve remaining.”

## 7. RPCs and stream

All assistant RPCs require a session. Mutations that change keys or approve actions run as the signed-in user. `server/app.mjs` `ALLOWED` gains the new names.

| Name | Kind | Role |
|---|---|---|
| `assistant.keys` | query | Keys this user may see (no `apiKey`) |
| `assistant.addKey` | mutation | Create a key they own |
| `assistant.updateKey` | mutation | Owner of the key (or server owner for `systemDefault` on a key they own) |
| `assistant.removeKey` | mutation | Owner of the key |
| `assistant.conversations` | query | This user’s threads (id, title, updatedAt) |
| `assistant.getConversation` | query | One thread they own, including pending actions |
| `assistant.deleteConversation` | mutation | Owner of the thread |
| `assistant.approve` | mutation | `{actionId}` |
| `assistant.reject` | mutation | `{actionId}` |

Stream: `POST /api/assistant/stream` on the web server (not JSON-RPC). Body: `{conversationId?, message, keyId?}`. Session cookie required. omarchyd serves `POST /assistant/stream` on 127.0.0.1 only; the web process proxies it 1:1 as SSE and does not buffer the body. SSE events:

- `text` — assistant delta
- `tool` — read tool started/finished (optional, for a quiet activity line)
- `action` — new pending card (full action object minus secrets)
- `done` — `{conversationId}`
- `error` — `{message}`

Do not buffer the whole model response in the web process.

## 8. Built-in tools

Filter the list by the same rules as the UI: if `ownerOnly` would throw for this user, omit the tool. Unknown tool names from the model are not executed; return a tool error “unknown tool”.

**Reads (auto-run):**

- `system_cpuUsage`, `system_memoryUsage`, `system_diskUsage`, `system_gpuUsage`, `system_cpuTemperature`, `system_uptime`, `system_device`, `system_getHostname`, `system_getIpAddresses`
- `apps_list`, `apps_details`
- `appStore_registry` (search/filter args only; do not dump the entire catalog into the prompt — pass `q` / category / limit, cap results)
- `machines_list`, `machines_details`, `machines_osImages`, `machines_capabilities`
- `swarm_list`
- `omarchy_plugins` (list)
- `notifications_get`

**Writes (pending action, then Approve):**

- `apps_install`, `apps_start`, `apps_stop`, `apps_restart`, `apps_uninstall`, `apps_update`
- `machines_create`, `machines_start`, `machines_stop`, `machines_restart`, `machines_uninstall`, `machines_updateSettings`
- `swarm_action` (plugin-install / plugin-remove / theme-set / reboot only), `swarm_rename`
- `omarchy_setTheme`, `omarchy_installPlugin`, `omarchy_removePlugin`
- `system_restart`, `system_shutdown` (already owner-only)

Each tool’s JSON schema is the existing RPC input, trimmed to what the UI sends. `machines_create` schema includes name, osId, cores, memoryGb, diskSizeGb, arch, username; password: if the model omits it, omarchyd generates one and the card shows “password will be set on create” without putting a generated secret in the model prompt after the fact if we generated it server-side at Approve time. Prefer: require username; generate password at Approve if missing, store only the way `machines.create` already does.

**Out of the v1 tool list:** files write, shares, storage grow, `files.list` of `$HOME`, anything not in the tables above.

Cap: at most 16 auto-run tool calls per turn. A write does not run inside the loop and does not count toward that cap the same way: each write becomes a card and the loop waits.

## 9. MCP from installed apps

Listing field, optional:

```yaml
mcp:
  service: web
  port: 8080
  path: /mcp
  transport: http   # http or sse
```

Parse next to `web:` / `openPorts`. Persist on the installed app. The MCP port is published on `127.0.0.1` only, like the web port. It must not be copied to `openPorts`.

When building tools for a turn, for each installed app that is running and has `mcp:`:

1. Connect from omarchyd to `127.0.0.1:<loopback-port>` (the container mapping, not the public gateway port).
2. MCP initialize + list tools. Cache the list until the app stops or a 60s TTL.
3. Expose each tool as `app__<appId>__<mcpToolName>` with the MCP description and input schema.
4. `readOnlyHint === true` → auto-run (still inside the 16-call cap). Missing or false → pending action `kind: 'mcp'`.
5. Stopped or unreachable app → no tools from it. A pending MCP action errors on Approve if the app is gone.

No stdio. No user-pasted URL. Catalog without `mcp:` contributes nothing.

## 10. Agent loop

1. Load conversation (or create). Resolve key. Build tool list.
2. System prompt (fixed text plus a short facts block: hostname, OS, user role, installed app ids, swarm names). State: you are the Omarchy Server assistant; you do not write programs or propose shell; you use only the given tools; reads run now; writes become cards the user approves; stay on this host and its Local swarm.
3. `POST /v1/chat/completions` with `stream: true`, `tools`, `parallel_tool_calls: false`, `tool_choice: auto`.
4. Stream `text` events. On a tool call: if unknown, return error content to the model. If read, run, append tool result, continue (count toward cap). If write, persist pending action, emit `action`, **stop this provider request**, wait for Approve/Reject.
5. On Approve: run the captured call, append a tool result, start a follow-up provider request so the next card or a closing sentence can appear. On Reject: append “user rejected this step”, follow-up provider request.
6. `done` when the model returns a message with no tool calls.

Cancel: client aborts the fetch; omarchyd aborts the provider HTTP request. Partial assistant text is saved.

## 11. UI

**Phone.** Home tile beside Terminal, same size, icon distinct (chat/spark). Full-screen chat, back to Home.

**Desktop.** Window kind `assistant`. Super+Space launcher lists it. Opening reuses the existing window if any. It is not pinned to the default dock; the user can pin it like any other app.

**Chat.** Existing glass, type, accent. User bubbles, assistant markdown, streaming cursor. Write = card with title, detail, Approve / Reject. Pending cards stay visible after a disconnect. A new user message while a card is pending is allowed: it aborts an in-flight provider call, leaves the card pending, and starts a new turn. Approving a leftover card still runs it if still valid.

**Empty.** No usable key: explain, button to Settings → Assistant. Member with neither own key, shared key, nor default: “Ask the owner to share a key, or add your own.”

**Settings → Assistant.** Key list (name, provider, model, `…last4`). Add sheet: provider (SpaceXAI / OpenAI-compatible), name, model, API key (password field), base URL only when compatible. Share: checkboxes of other accounts. Owner: “Use as system default.” Delete confirms.

**Keys.** Enter sends, Shift+Enter newline. Window close control closes the desktop window; `Q` does not quit the SPA.

## 12. Errors

| Situation | User-visible |
|---|---|
| Provider 401 | Turn error: key rejected. Key remains; they can replace it. |
| Timeout / network | Turn error, retry that message. Pending actions unchanged. |
| Read tool fails | Tool error to the model; it can explain. |
| Approve but role no longer allows it | Toast, action `error`, nothing runs. |
| Target gone (app/VM/swarm) | Action `error`. |
| MCP app stopped | Tools absent; pending MCP action errors on Approve. |
| Stream drop | Partial text kept; user can resend. |
| Empty key / model on Add | Submit disabled. |
| Model calls a non-tool (shell-like) | Unknown tool error to the model; log name server-side; do not execute. |

## 13. Security

- Keys: `0600`, never in `assistant.keys` / logs / stream events / conversation files.
- Web layer does not persist keys. omarchyd is localhost-only, same as today.
- Tool list is role-filtered every turn. Approve checks again.
- Members cannot set `systemDefault`. They can share keys they own.
- MCP only to loopback mappings omarchyd created. Never to `openPorts`, never to arbitrary URLs.
- No shell tool exists to call.
- Stream and RPCs require the same session as the rest of the SPA. Body size capped like other POSTs.
- Conversation files are per `userId`; get/delete/approve check ownership.

## 14. Testing

`test/assistant-keys.test.mjs`, `test/assistant-loop.test.mjs`, `test/assistant-mcp.test.mjs`, plus `ALLOWED` / fake-omarchyd coverage in `test/server.test.mjs` and `test/omarchyd.test.mjs`. Fake provider (no live xAI/Ollama). Fake MCP HTTP server on 127.0.0.1.

Must cover:

- Add/share/default; `apiKey` absent from query output
- Member cannot approve `swarm.action` or `system.restart`
- Read tool runs; write tool only creates pending
- Approve runs the captured RPC once; second Approve is a no-op/error
- Reject does not run
- Listing without `mcp:` contributes no app tools
- Stopped app contributes none
- `openPorts` is not used as MCP
- Tool cap
- Unknown tool is not executed
- Stream cancel leaves pending actions

Typecheck and `vite build` on the PR. Full `npm test`. The known `connector.test.mjs` theme-set fail on machines that have `omarchy-theme-set` is unrelated; mention it in the PR body.

## 15. Key decisions

1. **Server-side agent, interrupt on writes.** Keys and MCP stay in omarchyd. Reads execute. Writes become Approve cards that call existing RPCs or catalog MCP.
2. **Every signed-in user, existing permissions.** Tool list and Approve use the same `ownerOnly` / role rules as the UI.
3. **Per-user keys, share list, owner default.** The key only pays for the model. Actions still run as the chatting user.
4. **This host plus Local swarm.** Not a multi-server control plane. Swarm writes stay plugin/theme/reboot.
5. **Catalog `mcp:` only.** No pasted URLs, no stdio, no `openPorts`.
6. **SpaceXAI + OpenAI-compatible via chat/completions.** One HTTP client. Default SpaceXAI model from docs.x.ai at implement time (`grok-4.7` on 2026-11-17).
7. **Home tile plus desktop window**, like Terminal.
8. **No shell, no writing software.** Unknown tools never run.
9. **Isolated branch `feat/assistant` from `upstream/main`, then a PR to TouchWorkStation.** Maintainer owns version and What’s New. No local clone paths.

## 16. Implementation slices (PR plan)

Prefer stacked PRs from `feat/assistant` so each is reviewable. If the maintainer would rather take one PR, squash at the end; do not mix unrelated work.

1. **Keys and Settings** — store, RPCs, Settings → Assistant, tests for share/default/secret redaction. No chat.
2. **Chat + read tools** — loop, stream proxy, Assistant screen, Home tile, desktop window, system prompt, fake provider, read-only tools.
3. **Approve writes** — pending actions, cards, curated write tools, follow-up turn after Approve/Reject.
4. **MCP field + client** — parse `mcp:` in `apps.mjs`, loopback connect, `readOnlyHint`, tests with a fake MCP server. App-store listings that set the field are a separate store PR.

Each slice: typecheck, build, `npm test`, PR template (What this changes / How you tested it / Anything to know). Leave `package.json` version and `web/src/changelog.ts` to the maintainer.
