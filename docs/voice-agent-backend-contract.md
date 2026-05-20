# Voice-Agent Backend Contract (tinyhumansai backend repo)

> **Audience:** the team that owns the **tinyhumansai backend** (separate repo, deployed at `api.tinyhumans.ai` / `staging-api.tinyhumans.ai`).
>
> **Why this doc exists:** OpenHuman's desktop client is moving from push-to-talk to a continuous ElevenLabs Conversational Agent. The architecture keeps **OpenHuman as the brain** — ElevenLabs handles ASR + streaming TTS, but every LLM turn is delegated back to OpenHuman via a `custom-llm` webhook. The agent entity already exists (Phase 0, `openhuman-afn.2`); these routes are the backend half of the loop (`openhuman-afn.3` Phase 1 + `openhuman-afn.7` Phase 5 tool bridge).

---

## ElevenLabs side (already done, FYI)

- Agent: `OpenHuman Companion (voice)` on richard@rb2.nl ElevenLabs account.
- `ELEVENLABS_AGENT_ID = agent_4801ks3631qxfe58x7wb80kha6jm`
- TTS: `eleven_flash_v2` (~75ms TTFB, English-only).
- LLM: currently `gpt-oss-120b` (Eleven-hosted, no extra hop). **Phase 1 PATCHes this to `custom-llm` → route 2 below.**
- Shared secret: `OPENHUMAN_ELEVENLABS_AGENT_SECRET` — minted client-side, delivered out-of-band; needs to live in **both** the agent JSON (`request_headers.X-OpenHuman-Agent-Secret`) and the backend env.

---

## Required env vars (backend)

| Var | Source | Notes |
|---|---|---|
| `ELEVENLABS_API_KEY` | ElevenLabs dashboard | Server-side calls (signed-URL relay). NEVER ship to client. |
| `ELEVENLABS_AGENT_ID` | This doc | Default agent for `/signed-url`. Can be overridden per-request. |
| `OPENHUMAN_ELEVENLABS_AGENT_SECRET` | Out-of-band | Header secret ElevenLabs uses to authenticate calls into `/custom-llm/*` and `/tools/*`. |

---

## Route 1 — `POST /api/v1/elevenlabs/signed-url`

**Called by:** the OpenHuman desktop client (Rust core, via the existing backend HTTP client used for `/openai/v1/audio/speech`).

### Auth
OpenHuman user bearer token (same scheme as the existing TTS proxy).

### Request
```json
{ "agent_id": "string?  (optional override; default = ELEVENLABS_AGENT_ID env)" }
```

### Response — 200
```json
{
  "signed_url": "wss://api.elevenlabs.io/v1/convai/conversation?...token...",
  "expires_at": 1747765432
}
```

`expires_at` = unix seconds when the signed URL stops working. Clients schedule a refresh at `expires_at - 60s`.

### Behavior
1. Verify OpenHuman user bearer.
2. Resolve agent_id: request override → fall back to `ELEVENLABS_AGENT_ID`.
3. Call `GET https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=<id>` with header `xi-api-key: $ELEVENLABS_API_KEY`. (Python SDK: `ElevenLabs().conversational_ai.conversations.get_signed_url(agent_id=...)`.)
4. Cache by `(user_id, agent_id)` for **5 min** (ElevenLabs URLs expire in ~10 min; 5-min cache halves churn but always leaves a fresh-enough URL).
5. Rate limit: **12 req/min per user**. 429 with `Retry-After` on overflow.
6. Add `Server-Timing` headers for `el-fetch`, `cache-lookup`, `cache-store`.

### Error responses
| HTTP | Body |
|---|---|
| 401 | `{ "error": "auth_required" }` — missing/invalid bearer |
| 429 | `{ "error": "rate_limited" }` |
| 502 | `{ "error": "elevenlabs_unavailable", "upstream_status": "5xx" }` |

---

## Route 2 — `POST /api/v1/elevenlabs/custom-llm/completions`

**Called by:** ElevenLabs servers (NOT the desktop client). This is the BYO-LLM hook — ElevenLabs delegates every LLM turn to this route.

### Auth
Header `X-OpenHuman-Agent-Secret` must equal `$OPENHUMAN_ELEVENLABS_AGENT_SECRET`. **Constant-time compare.** Reject with 401 otherwise.

### Request body (from ElevenLabs)
OpenAI chat-completions shape (streaming):
```json
{
  "model": "custom-llm",
  "messages": [
    { "role": "system", "content": "<agent system prompt>" },
    { "role": "user", "content": "<latest user turn>" },
    { "role": "assistant", "content": "<previous agent turn>" }
  ],
  "stream": true,
  "conversation_id": "el-conv-abc...",
  "agent_id": "agent_4801ks3631qxfe58x7wb80kha6jm",
  "user_id": "<from agent metadata or first message>",
  "temperature": 0.5
}
```

### Response — Server-Sent Events
```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache

data: {"choices":[{"delta":{"content":"Hi"}}]}
data: {"choices":[{"delta":{"content":" there"}}]}
data: {"choices":[{"delta":{"content":"."}}]}
data: [DONE]
```

Match OpenAI's exact SSE wire format — ElevenLabs parses it strictly.

### Behavior
1. Validate `X-OpenHuman-Agent-Secret` (constant-time, see above).
2. **Map `conversation_id → thread_id`** via a backend DB table:
   ```sql
   CREATE TABLE elevenlabs_conversation_thread (
     conversation_id TEXT PRIMARY KEY,
     user_id         TEXT NOT NULL,
     thread_id       TEXT NOT NULL,
     created_at      TIMESTAMPTZ DEFAULT now()
   );
   ```
   Create-on-first-see; same `conversation_id` later in the session reuses the same thread, so memory persists across mid-session reconnects.
3. **Resolve user_id → OpenHuman account.** For MVP: shared agent, `user_id` is passed in via the agent's first-message metadata (set by the desktop client on session start). If absent → 400.
4. **Dispatch to OpenHuman core**: existing `openhuman.channel_web_chat` RPC. Pass the latest `user`-role message + the resolved `thread_id`. (If `channel_web_chat` semantics don't fit, file a follow-up to add `openhuman.voice_agent_turn` — but try `channel_web_chat` first.)
5. **Stream the core's `text_delta` events back as SSE deltas** in the OpenAI shape above.
6. **Emit `data: [DONE]\n\n`** when the core agent fires `chat_done`.
7. Tool calls inside OpenHuman run normally (they happen inside the core, invisible to ElevenLabs). ElevenLabs only sees the final text stream.

### Latency budget
- Receive request → first core token in stream: **< 800 ms** target.
- Add `Server-Timing` headers: `auth`, `thread-lookup`, `core-dispatch`, `core-first-token`.

### Error responses
| HTTP | Body |
|---|---|
| 401 | (no body) — missing/bad shared secret |
| 400 | `{ "error": "missing_user_id" }` |
| 500 | SSE `data: {"error": "..."}\n\ndata: [DONE]` so ElevenLabs can recover gracefully |

---

## Route 3 — `POST /api/v1/elevenlabs/tools/current-time`

**Phase 5 tool bridge.** Called by ElevenLabs when the agent invokes the `get_current_time` webhook tool.

### Auth
Header `X-OpenHuman-Agent-Secret` (same as Route 2).

### Request
```json
{ "conversation_id": "el-conv-abc" }
```

(May come with empty body too — ElevenLabs sometimes sends `{}`.)

### Response — 200
```json
{ "result": "Wednesday, 20 May 2026, 14:32 (Europe/Amsterdam)" }
```

### Behavior
1. Validate shared secret.
2. Resolve `conversation_id → user_id` via the table from Route 2 (look up user's timezone if available; default UTC otherwise).
3. Return current time as a plain natural-language string.

---

## Route 4 — `POST /api/v1/elevenlabs/tools/memory-recall`

### Auth
Header `X-OpenHuman-Agent-Secret`.

### Request
```json
{
  "conversation_id": "el-conv-abc",
  "query": "Q3 launch plans",
  "limit": 5
}
```

### Response — 200
```json
{
  "result": "1. Q3 launch is scheduled for Aug 15.\n2. Marketing slides due Aug 1.\n3. Demo recorded last week."
}
```

### Behavior
1. Validate shared secret.
2. Resolve `conversation_id → user_id`.
3. Call `openhuman.memory_search` RPC with `{ query, limit, user_id }`.
4. Concatenate top results into a single string `result` (numbered list ≤ 800 chars; the agent will speak it).

Timeout: 8 s.

---

## Route 5 — `POST /api/v1/elevenlabs/tools/memory-store`

### Auth
Header `X-OpenHuman-Agent-Secret`.

### Request
```json
{
  "conversation_id": "el-conv-abc",
  "content": "User wants a 30-min meeting with Alice every Monday.",
  "tags": ["scheduling", "alice"]
}
```

### Response — 200
```json
{ "result": "OK, saved." }
```

### Behavior
1. Validate shared secret.
2. Resolve `conversation_id → user_id`.
3. Call `openhuman.memory_store` RPC.
4. Return short ack string.

Timeout: 5 s.

---

## Observability

Each route logs structured JSON:
```
{ "ts": "...", "route": "custom-llm/completions", "conversation_id": "...", "user_id": "...",
  "latency_ms": 723, "core_dispatch_ms": 410, "outcome": "ok" }
```

Per-conversation rolling log buffer (last 30 turns) helps debug "agent said the wrong thing" reports.

---

## Acceptance (what unblocks the OpenHuman client work)

For Phase 1 (`openhuman-afn.3`):
1. `curl -X POST $BACKEND/api/v1/elevenlabs/signed-url -H "Authorization: Bearer $OH_TOKEN" -d '{}'` returns a `wss://...` URL.
2. PATCH the ElevenLabs agent to `llm: "custom-llm"` with `custom_llm.url = <backend>/api/v1/elevenlabs/custom-llm/completions` and `request_headers.X-OpenHuman-Agent-Secret = $OPENHUMAN_ELEVENLABS_AGENT_SECRET`.
3. Open the ElevenLabs Agent test console → speak → reply text matches what `openhuman.channel_web_chat` would produce on the same prompt.
4. Hit `/custom-llm/completions` without the header → 401.
5. Reconnect mid-session with the same `conversation_id` → same OpenHuman thread (memory persists).

For Phase 5 (`openhuman-afn.7`):
1. Live session: *"What time is it?"* → tool fires → correct local time spoken.
2. *"What did I tell you about the Q3 launch last week?"* → `memory-recall` fires → results spoken; latency end-to-end < 3 s.
3. *"Remember that I want a 30-min meeting with Alice every Monday."* → `memory-store` fires → memory visible in OpenHuman's Memory UI.

---

## Open questions for the backend team

1. **Existing `/openai/v1/audio/speech` proxy auth** — reuse the same bearer flow for Route 1?
2. **`channel_web_chat` streaming shape** — does the core already emit `text_delta` events suitable for SSE forwarding, or do you need a new `voice_agent_turn` RPC variant?
3. **User → conversation binding**: confirm the desktop client can pass `user_id` via agent first-message metadata at `Conversation.startSession` time; otherwise we need a different binding strategy (e.g. signed URL embeds a per-user agent variant).
4. **Quota tracking**: ElevenLabs charges per minute. Decide where session-minute counters live (backend metering table vs. OpenHuman core).
5. **Rate limit**: 12 req/min for signed-URL OK with mobile / multiple-window use cases?
