# Voice agent — OpenHuman as the brain

Until Phase 1 (`openhuman-afn.3`) lands, the ElevenLabs Conversational Agent
runs in **client-side tool** mode: OpenHuman's orchestrator decides what gets
spoken, and the hosted LLM is reduced to a thin "STT → call tool → speak the
result → TTS" relay. This document describes:

1. How the bridge works in the desktop app
2. What you have to configure on the ElevenLabs dashboard for the brain to
   actually take over

## In-app bridge

The bridge lives in
`app/src/features/human/voice/conversationalAgent/clientTools.ts`. It exports
`buildClientTools(deps)` which returns a four-tool map the
`@elevenlabs/client` SDK invokes inside the running Tauri app. Each tool is a
narrow wrapper around an existing core RPC:

| Tool                  | Parameters         | Backed by                            |
| --------------------- | ------------------ | ------------------------------------ |
| `chat_with_openhuman` | `{ message }`      | `openhuman.channel_web_chat` (full agent loop, memory, sub-agents) |
| `recall_memory`       | `{ query }`        | `openhuman.memory_query_namespace` (default namespace `voice-agent`) |
| `store_memory`        | `{ note }`         | `openhuman.memory_doc_ingest`        |
| `get_current_time`    | `{}`               | `new Date().toISOString()` — local   |

The factory is invoked once per `HumanPage` mount with a stable
`threadId` (prefixed `voice-…`) so the voice conversation runs in its own
thread and never pollutes the user's text chat history.

`chat_with_openhuman` is the load-bearing tool. The implementation:

1. Subscribes to the realtime chat event stream
2. Calls `chatSend({ threadId, message })`
3. Captures `request_id` from the first matching `inference_start`
4. Buffers `text_delta` chunks for that `request_id`
5. Resolves on `chat_done` with `full_response` (or the buffered text)
6. Hard-times out at 30 s

## ElevenLabs dashboard setup

The agent definition lives on ElevenLabs and the desktop app cannot push
changes to it. To flip the brain on for your agent
(`agent_id` you've set in Settings → Voice → Conversation mode):

### 1. Add four client tools

In `Agent → Tools → Custom Tools`, click **Add Tool** for each of the four
below. Set **Type** to `Client-side` for all four. The names must match
exactly — the SDK routes by string equality.

#### `chat_with_openhuman`

- **Description**: "Send the user's verbatim message to OpenHuman's brain and
  return the spoken reply. ALWAYS call this for every user turn. The return
  value is what you must say to the user, verbatim."
- **Parameters**:
  ```json
  {
    "type": "object",
    "properties": {
      "message": {
        "type": "string",
        "description": "The user's verbatim message, exactly as transcribed."
      }
    },
    "required": ["message"]
  }
  ```

#### `recall_memory`

- **Description**: "Search OpenHuman's long-term memory for relevant context.
  Returns JSON. Call only when the user references prior context."
- **Parameters**:
  ```json
  {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "Natural-language search query." }
    },
    "required": ["query"]
  }
  ```

#### `store_memory`

- **Description**: "Save a short note into OpenHuman's long-term memory.
  Call only when the user explicitly asks you to remember something."
- **Parameters**:
  ```json
  {
    "type": "object",
    "properties": {
      "note": { "type": "string", "description": "The thing to remember." }
    },
    "required": ["note"]
  }
  ```

#### `get_current_time`

- **Description**: "Return the current ISO 8601 timestamp. Use only when the
  user asks about time."
- **Parameters**: `{ "type": "object", "properties": {} }`

### 2. Replace the system prompt

In `Agent → Behaviour → System Prompt`, paste the following (or splice it
into your existing prompt):

> For ANY user message, you MUST call the `chat_with_openhuman` tool with
> the user's verbatim message as the `message` parameter. Use the returned
> text as your spoken reply, EXACTLY as returned, without paraphrasing or
> commentary. Do not answer from your own knowledge — OpenHuman's
> orchestrator is the source of truth.
>
> Use `recall_memory` and `store_memory` only when the user explicitly
> references prior context or asks you to remember something. Use
> `get_current_time` when the user asks about time.

### 3. Save and reconnect

Click **Save** on the agent. In the desktop app, disconnect and reconnect
the voice session (the SDK binds tools at `startSession` time, so a live
session needs to be cycled to pick up changes).

You should now see, on every user turn:

1. The mascot shows "listening" briefly while STT completes
2. The mascot shows "speaking" only after OpenHuman's tool loop finishes
   (so it can take longer than the old hosted-LLM path)
3. In `~/.openhuman/logs/openhuman-core.log` you should see a
   `channel_web_chat` request for the `voice-…` thread on every turn

## Limitations (deliberate, will be fixed in later phases)

- **No streaming back to the agent**: the tool returns the full reply once
  the core finishes generating. There's no way to stream partial tokens
  back through a client tool yet (ElevenLabs SDK constraint). This adds
  latency compared to the old hosted-LLM path.
- **No retry on tool error**: if `channel_web_chat` errors mid-turn, the
  user hears "error: …" and the SDK moves on. Reconnect/retry is Phase 6
  (`openhuman-afn.8`).
- **Single thread per page mount**: refreshing the Human page starts a new
  voice thread. Across-session memory persists via `recall_memory`.
- **Migration target**: once Phase 1 ships the backend webhook routes
  (`/api/v1/elevenlabs/tools/*`), the same four tools can move
  server-side and the client bridge becomes a fallback for
  desktop-without-network paths.
