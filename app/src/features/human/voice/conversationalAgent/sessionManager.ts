import * as Sentry from '@sentry/react';
import { Conversation } from '@elevenlabs/client';
import debug from 'debug';

import {
  DISCONNECT_REASON,
  INITIAL_CONVERSATIONAL_AGENT_STATE,
  type AgentEvent,
  type ConversationalAgentState,
  type SignedUrlResponse,
} from './types';

const log = debug('openhuman:voice-agent:session');

/**
 * Drop a structured breadcrumb so production failures from the voice-agent
 * pipeline are debuggable in Sentry. Phase 7 acceptance #3 requires that a
 * 30s session produces at least the connecting/connected/disconnected
 * breadcrumb trio.
 */
function addBreadcrumb(message: string, data: Record<string, unknown> = {}): void {
  try {
    Sentry.addBreadcrumb({ category: 'voice-agent', level: 'info', message, data });
  } catch {
    /* Sentry not initialized in tests — swallow */
  }
}

/**
 * Plain TS class that owns the ElevenLabs Conversational Agent WebSocket
 * session. Framework-agnostic on purpose so unit tests can drive it without
 * a React renderer.
 *
 * Reconnect-with-backoff and proactive signed-URL refresh are deliberately
 * NOT here yet — that's `Phase 6 (hardening, openhuman-afn.8)`. The seams
 * (e.g. `reconnect` no-op, `expiresAt` tracking) are in place so adding
 * them is a localized change.
 *
 * SDK choice: `@elevenlabs/client` (the lower-level framework-agnostic
 * package) rather than `@elevenlabs/react`. Reason: the React package is a
 * thin hook on top of `Conversation` and would force us to drive
 * everything from a React context — which makes the manager untestable
 * outside a renderer and harder to plumb into the existing
 * `useHumanMascot` viseme pipeline.
 */
export interface SessionManagerDeps {
  /**
   * Returns a fresh signed URL + its expiry. In production this hits the
   * Rust core RPC `openhuman.voice_agent_get_signed_url`; tests inject a
   * stub.
   *
   * If both `agentId` and `fetchSignedUrl` are provided, `agentId` wins —
   * the SDK opens a direct WebSocket using the agent's allowlisted origin
   * auth. Use this for testing before the backend signed-URL relay (Phase 1)
   * is deployed.
   */
  fetchSignedUrl: () => Promise<SignedUrlResponse>;
  /**
   * Direct `agent_id` for SDK-side connection (bypasses the signed-URL
   * relay). Works as long as the agent's `platform_settings.auth.allowlist`
   * includes the desktop app's origin (`tauri.localhost` / `localhost`).
   * Optional; if absent, `fetchSignedUrl` is used.
   */
  agentId?: string;
  /**
   * Per-session voice id override forwarded to the SDK as
   * `overrides.tts.voiceId`. The ElevenLabs agent must have
   * `platform_settings.overrides.conversation_config_override.tts.voice_id`
   * enabled server-side or this is silently ignored. Empty / undefined →
   * use the agent's server-configured default voice.
   */
  voiceId?: string;
  /**
   * Side-channel for typed events. The React hook folds these into snapshot
   * state via `useSyncExternalStore`.
   */
  onEvent: (event: AgentEvent) => void;
  /**
   * Optional override for the SDK entrypoint — tests pass a mocked
   * `Conversation.startSession` here. Defaults to the real SDK.
   */
  startSession?: (typeof Conversation)['startSession'];
  /**
   * Phase 5 brain bridge — client-side tools the ElevenLabs agent invokes
   * inside our running app. Matches the `ClientToolsConfig.clientTools`
   * shape from `@elevenlabs/client/dist/BaseConversation.d.ts`. Forwarded
   * verbatim into `sdkOptions.clientTools` at `connect()` time. Omit to
   * keep the SDK in its default "no tools" configuration.
   *
   * Sampled at `connect()` time (so the React hook can update them via
   * {@link ConversationalAgentSessionManager.setClientTools} without
   * reconstructing the manager).
   */
  clientTools?: Record<
    string,
    (parameters: unknown) => Promise<string | number | void> | string | number | void
  >;
}

type ActiveConversation = Awaited<ReturnType<(typeof Conversation)['startSession']>>;

export class ConversationalAgentSessionManager {
  private readonly deps: SessionManagerDeps;
  private conv: ActiveConversation | null = null;
  private snapshot: ConversationalAgentState = { ...INITIAL_CONVERSATIONAL_AGENT_STATE };
  private expiresAt: number | null = null;
  private startedAt: number | null = null;
  private turnCount = 0;
  private listeners = new Set<() => void>();
  // Mutable per-session settings sampled at connect() time. Distinct from
  // `deps.*` so the React hook can update them on every render via
  // `setVoiceId` / `setAgentId` without having to reconstruct the manager
  // (which would drop subscribe listeners + active conversation).
  private voiceIdOverride: string | undefined;
  private agentIdOverride: string | undefined;
  private clientToolsOverride: SessionManagerDeps['clientTools'];

  constructor(deps: SessionManagerDeps) {
    this.deps = deps;
    this.voiceIdOverride = deps.voiceId;
    this.agentIdOverride = deps.agentId;
    this.clientToolsOverride = deps.clientTools;
  }

  /**
   * Update the voice override that the next `connect()` will send to the
   * SDK as `overrides.tts.voiceId`. Calling this while a session is already
   * live does NOT re-stream with the new voice — ElevenLabs binds the
   * voice at session start. Disconnect + reconnect to apply.
   */
  setVoiceId(voiceId: string | undefined): void {
    this.voiceIdOverride = voiceId?.trim() || undefined;
  }

  /**
   * Update the agent_id the next `connect()` will hand to the SDK. Same
   * caveat as `setVoiceId`: a live session is bound to its current agent
   * and won't migrate on the fly; user has to disconnect + reconnect.
   * Empty / undefined → fall through to the signed-URL relay path.
   */
  setAgentId(agentId: string | undefined): void {
    this.agentIdOverride = agentId?.trim() || undefined;
  }

  /**
   * Replace the client-tools map the next `connect()` will forward to the
   * SDK. Same caveat as the other setters: changing tools while a session
   * is live doesn't migrate the running connection (the SDK binds tools at
   * `startSession` time). Disconnect + reconnect to apply.
   */
  setClientTools(clientTools: SessionManagerDeps['clientTools']): void {
    this.clientToolsOverride = clientTools;
  }

  /** External-store API consumed by `useSyncExternalStore`. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** External-store snapshot. MUST be stable between events (no inline `{...}`). */
  getSnapshot = (): ConversationalAgentState => this.snapshot;

  get state(): ConversationalAgentState {
    return this.snapshot;
  }

  /**
   * Open a session. Idempotent: if already connecting/connected, the call
   * is a no-op and resolves immediately.
   */
  async connect(): Promise<void> {
    if (this.snapshot.lifecycle === 'connecting' || this.snapshot.lifecycle === 'connected') {
      log('[voice-agent] connect() called while %s — ignored', this.snapshot.lifecycle);
      return;
    }
    this.updateSnapshot({ lifecycle: 'connecting', error: null });
    this.emit({ kind: 'connecting' });
    addBreadcrumb('state -> connecting');

    // Two connection paths:
    //   1. `agentId` — direct SDK connection via the agent's allowlisted origin.
    //      Works without the backend signed-URL relay; ideal for testing now,
    //      while Phase 1 (`openhuman-afn.3`) is still pending.
    //   2. `fetchSignedUrl` — hits the Rust core, which in turn hits the
    //      tinyhumansai backend relay. Required for production server-issued
    //      auth + cost tracking.
    const directAgentId = this.agentIdOverride?.trim() ?? '';
    let signed: SignedUrlResponse | null = null;
    if (!directAgentId) {
      try {
        signed = await this.deps.fetchSignedUrl();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('[voice-agent] fetchSignedUrl failed: %s', message);
        this.updateSnapshot({ lifecycle: 'error', error: message });
        this.emit({ kind: 'error', message });
        addBreadcrumb('state -> error', { stage: 'fetch_signed_url', message });
        return;
      }
      this.expiresAt = signed.expiresAt;
    }

    const start = this.deps.startSession ?? Conversation.startSession;
    const sdkOptions: Record<string, unknown> = directAgentId
      ? { agentId: directAgentId }
      : { signedUrl: signed!.signedUrl };
    // Per-session voice override. Only attached when the caller provided a
    // non-empty `voiceId`, so an unset config keeps the agent's
    // server-configured default. ElevenLabs requires the override to be
    // explicitly allowlisted on the agent definition; if it isn't, the SDK
    // silently drops this key and uses the default voice — which is the
    // failure mode that first surfaced this missing wiring (#openhuman-afn.6).
    const voiceId = this.voiceIdOverride?.trim();
    if (voiceId) {
      sdkOptions.overrides = {
        ...((sdkOptions.overrides as Record<string, unknown> | undefined) ?? {}),
        tts: { voiceId },
      };
      log('[voice-agent] connect with voice override voice_id=%s', voiceId);
    }
    // Phase 5 brain bridge: attach client tools if the caller provided any.
    // We deliberately don't set an empty `clientTools` key when none were
    // configured — the SDK type still permits a missing key, and passing
    // `{}` would clobber any defaults the SDK or agent definition supplies.
    if (this.clientToolsOverride && Object.keys(this.clientToolsOverride).length > 0) {
      sdkOptions.clientTools = this.clientToolsOverride;
      log(
        '[voice-agent] connect with %d client tool(s): %s',
        Object.keys(this.clientToolsOverride).length,
        Object.keys(this.clientToolsOverride).join(', ')
      );
    }
    try {
      this.conv = await start({
        ...(sdkOptions as Parameters<(typeof Conversation)['startSession']>[0]),
        onConnect: ({ conversationId }: { conversationId: string }) => {
          this.startedAt = Date.now();
          this.turnCount = 0;
          this.updateSnapshot({ lifecycle: 'connected', conversationId });
          this.emit({ kind: 'connected', conversationId });
          addBreadcrumb('state -> connected', { conversation_id: conversationId });
        },
        onDisconnect: (details: { reason: string }) => {
          const reason =
            details.reason === 'user'
              ? DISCONNECT_REASON.USER_CLOSED
              : details.reason === 'error'
                ? DISCONNECT_REASON.ERROR
                : DISCONNECT_REASON.EXPIRED;
          this.updateSnapshot({
            lifecycle: 'disconnected',
            isListening: false,
            isSpeaking: false,
            conversationId: null,
          });
          this.emit({ kind: 'disconnected', reason });
          addBreadcrumb('state -> disconnected', {
            reason,
            duration_ms: this.startedAt ? Date.now() - this.startedAt : 0,
            turn_count: this.turnCount,
          });
          this.conv = null;
        },
        onError: (message: string) => {
          log('[voice-agent] SDK onError: %s', message);
          this.updateSnapshot({ lifecycle: 'error', error: message });
          this.emit({ kind: 'error', message });
        },
        onMessage: ({ message, source }: { message: string; source: 'user' | 'ai' }) => {
          const role: 'user' | 'agent' = source === 'ai' ? 'agent' : 'user';
          if (role === 'user') this.turnCount += 1;
          this.updateSnapshot({ lastTranscript: { text: message, role, isFinal: true } });
          this.emit({ kind: 'transcript', text: message, isFinal: true, role });
        },
        onModeChange: ({ mode }: { mode: 'speaking' | 'listening' }) => {
          if (mode === 'speaking') {
            this.updateSnapshot({ isSpeaking: true, isListening: false });
            this.emit({ kind: 'agent_speech_started' });
          } else {
            // Mode `listening` — agent just finished speaking, user mic open
            if (this.snapshot.isSpeaking) {
              this.emit({ kind: 'agent_speech_ended' });
            }
            this.updateSnapshot({ isSpeaking: false, isListening: true });
            this.emit({ kind: 'user_speech_started' });
          }
        },
        onStatusChange: ({ status }: { status: string }) => {
          log('[voice-agent] status -> %s', status);
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('[voice-agent] startSession threw: %s', message);
      this.updateSnapshot({ lifecycle: 'error', error: message });
      this.emit({ kind: 'error', message });
      this.conv = null;
    }
  }

  /** Cleanly end the session. Safe to call from any state. */
  async disconnect(): Promise<void> {
    // No-op when the manager has never connected. Without this guard, React
    // strict-mode's double-mount cleanup flips the UI from `idle` → `disconnected`
    // before the user has done anything, which made the button label lie.
    if (this.snapshot.lifecycle === 'idle' && this.conv === null) {
      return;
    }
    const conv = this.conv;
    this.conv = null;
    if (!conv) {
      // Still emit disconnected so consumers move out of `connecting`/`error`.
      this.updateSnapshot({
        lifecycle: 'disconnected',
        isListening: false,
        isSpeaking: false,
        conversationId: null,
      });
      this.emit({ kind: 'disconnected', reason: DISCONNECT_REASON.USER_CLOSED });
      return;
    }
    try {
      await conv.endSession();
    } catch (err) {
      log('[voice-agent] endSession threw: %s', err instanceof Error ? err.message : err);
    }
    // `onDisconnect` will fire and update the snapshot — but if the SDK
    // missed it (e.g. already closed), make sure we land in `disconnected`.
    if (this.snapshot.lifecycle !== 'disconnected') {
      this.updateSnapshot({
        lifecycle: 'disconnected',
        isListening: false,
        isSpeaking: false,
        conversationId: null,
      });
      this.emit({ kind: 'disconnected', reason: DISCONNECT_REASON.USER_CLOSED });
    }
  }

  setMuted(muted: boolean): void {
    if (muted === this.snapshot.isMuted) return;
    this.conv?.setMicMuted(muted);
    this.updateSnapshot({ isMuted: muted });
    this.emit({ kind: 'mute_changed', muted });
  }

  /** For telemetry consumers (Phase 7). */
  getSessionStats(): { durationMs: number; turnCount: number } {
    const durationMs = this.startedAt ? Date.now() - this.startedAt : 0;
    return { durationMs, turnCount: this.turnCount };
  }

  /** Phase 6 seam — reconnect logic will land here. */
  async reconnect(): Promise<void> {
    log('[voice-agent] reconnect() requested — stub, Phase 6 will implement');
    await this.disconnect();
    await this.connect();
  }

  /** Phase 6 helper — when the manager should proactively refresh the URL. */
  get expiresAtSeconds(): number | null {
    return this.expiresAt;
  }

  private updateSnapshot(patch: Partial<ConversationalAgentState>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private emit(event: AgentEvent): void {
    try {
      this.deps.onEvent(event);
    } catch (err) {
      log('[voice-agent] onEvent listener threw: %s', err instanceof Error ? err.message : err);
    }
  }
}
