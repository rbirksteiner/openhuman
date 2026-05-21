# Developer loop guide

Quick reference for the three ways to run openhuman-core locally and how
to wire the Docker cloud-stack to ElevenLabs.

---

## Desktop dev (Tauri, default)

```bash
pnpm dev:app          # full CEF + React hot-reload
pnpm dev              # React-only (no Tauri runtime — no IPC, no core)
```

`pnpm dev:app` is the canonical loop. It:
1. Calls `pnpm tauri:ensure` to guarantee the vendored CEF-aware `tauri-cli`
   is on PATH (see `scripts/ensure-tauri-cli.sh`).
2. Loads `.env` via `scripts/load-dotenv.sh`.
3. Launches the CEF runtime with HMR.

Use this for any work that touches Tauri IPC, native windows, or the
authentication flow (OAuth callbacks redirect to `openhuman://` — a
custom protocol that only resolves in the built app).

---

## Browser dev-fast (no Tauri rebuild)

```bash
pnpm dev:fast         # starts standalone openhuman-core + Vite dev server
```

`scripts/dev-fast.sh` starts `openhuman-core serve` in the background
(reads `~/.openhuman/core.token` for the bearer token) and starts the Vite
dev server pointing at it. Useful for pure-frontend iteration where you
don't need Tauri IPC.

**Known limitation:** the OAuth provider redirects to the desktop's
`openhuman://` custom protocol on sign-in completion. That redirect is not
handled in browser mode, so SSO login cannot complete. `dev:fast` only
works for non-login flows (conversations, settings, memory browsing, etc.)
after the user is already authenticated (token cached in `~/.openhuman`).

---

## Docker cloud-stack (ElevenLabs integration dev)

Use this stack to develop the cloud-shaped openhuman-core and wire it to
ElevenLabs Cloud without deploying anywhere.

### Prerequisites

- Docker Desktop (or `docker` + `docker compose` v2 CLI)
- An ElevenLabs agent configured with Custom LLM and webhook tools
  (see [ElevenLabs dashboard setup](#elevenlabs-dashboard-setup) below)

### Start the stack

```bash
cp .env.example .env
# Edit .env — fill in at minimum:
#   OPENHUMAN_CORE_TOKEN=<openssl rand -hex 32>
#   OPENHUMAN_ELEVENLABS_WEBHOOK_SECRET=<openssl rand -hex 32>

docker compose -f docker-compose.dev.yml up
```

Three services start:

| Service | Role | Port |
|---|---|---|
| `postgres` | Postgres 17 — ready before `core` starts | 5432 |
| `core` | openhuman-core binary (built from `Dockerfile`) | container `7788`, host `17788` by default |
| `cloudflared` | Quick tunnel — public HTTPS URL for ElevenLabs | — |

### Find the cloudflared tunnel URL

```bash
docker compose -f docker-compose.dev.yml logs cloudflared | grep trycloudflare
```

The output contains a line like:

```
Your quick Tunnel has been created! Visit it at (it may take some time to start up):
https://random-words.trycloudflare.com
```

That URL is valid until you stop the container. It changes on every
`docker compose up` (quick-tunnel, no Cloudflare account required). For a
stable URL, create a named tunnel with `cloudflared tunnel create`.

### Self-hosted direct inference

The Docker dev stack can run the agent loop without a tinyhumansai backend
session by routing workload providers directly to OpenRouter/OpenAI/Anthropic
and enabling the self-hosted direct-inference policy:

```bash
# in .env
OPENHUMAN_SELF_HOSTED_DIRECT_INFERENCE=1
OPENROUTER_API_KEY=sk-or-...
OPENHUMAN_CHAT_PROVIDER=openrouter:openai/gpt-4o-mini
OPENHUMAN_AGENTIC_PROVIDER=openrouter:openai/gpt-4o-mini
OPENHUMAN_REASONING_PROVIDER=openrouter:anthropic/claude-3.5-sonnet
OPENHUMAN_CODING_PROVIDER=openrouter:anthropic/claude-3.5-sonnet
OPENHUMAN_MEMORY_PROVIDER=openrouter:openai/gpt-4o-mini
OPENHUMAN_CHAT_ONBOARDING_COMPLETED=1
```

The self-hosted flag only bypasses the OpenHuman backend session gate for direct
providers (`openrouter:*`, `openai:*`, `anthropic:*`, `ollama:*`, custom slugs).
The `openhuman` provider still requires a real app-session JWT. If provider API
keys are configured through Settings → AI → LLM instead, the same routing fields
are used; the env vars are just a container-friendly bootstrap path.

### ElevenLabs dashboard setup

In the [ElevenLabs agent dashboard](https://elevenlabs.io/app/conversational-ai):

1. **Custom LLM URL** — set to:
   ```
   https://<tunnel-url>/elevenlabs/custom-llm
   ```

2. **Webhook tools** — add three webhook tools:

   | Tool name | URL |
   |---|---|
   | `current_time` | `https://<tunnel-url>/elevenlabs/tools/current-time` |
   | `memory_recall` | `https://<tunnel-url>/elevenlabs/tools/memory-recall` |
   | `memory_store` | `https://<tunnel-url>/elevenlabs/tools/memory-store` |

3. **Webhook Secret** — paste the same value you put in
   `OPENHUMAN_ELEVENLABS_WEBHOOK_SECRET`. ElevenLabs sends it in the
   `X-ElevenLabs-Secret` header; the core rejects calls without it.

4. **Switch the agent** — once the webhook tools are configured and
   tested, you can switch the agent's "Brain" from "Client tools" (the
   existing TS bridge in `app/src/features/human/voice/conversationalAgent/clientTools.ts`)
   to "Webhook tools + Custom LLM". The TS bridge remains in place and
   is unaffected until you explicitly remove it from the SDK configuration.

### Postgres storage backend

The `core` service mounts local runtime state at `./.openhuman-docker` and
sets `OPENHUMAN_WORKSPACE=/openhuman-data` inside the container. The mount
path intentionally is not named `/workspace`: the core keeps a legacy heuristic
where paths ending in `workspace` are treated as workspace subdirectories whose
config lives in a parent `.openhuman` directory.

The `core` service receives `OPENHUMAN_DATABASE_URL` pointing at the
compose-managed Postgres. To activate the Postgres storage path:

```bash
# in .env
OPENHUMAN_STORAGE_BACKEND=postgres
OPENHUMAN_DATABASE_URL=postgres://openhuman:dev@postgres:5432/openhuman
```

With that flag set the core logs `[postgres_store] connected and ping OK`
on startup. The full memory-layer swap to Postgres is a follow-up — at
Phase 1 only the connection is verified; all data reads/writes still use
the default SQLite/TOML stores.

### Useful commands

```bash
# Smoke-test the Docker core from the host (uses the collision-safe host port)
curl -fsS http://127.0.0.1:${OPENHUMAN_CORE_HOST_PORT:-17788}/health

# Tail all logs
docker compose -f docker-compose.dev.yml logs -f

# Restart core after a code change (rebuilds the image)
docker compose -f docker-compose.dev.yml up --build core

# psql into the dev Postgres
docker compose -f docker-compose.dev.yml exec postgres \
  psql -U openhuman -d openhuman

# Stop everything and remove the cloudflared tunnel
docker compose -f docker-compose.dev.yml down
```
