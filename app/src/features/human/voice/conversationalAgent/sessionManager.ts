import debug from 'debug';
import * as Sentry from '@sentry/react';
import { Conversation } from '@elevenlabs/client';
import type {
  AgentEvent,
  ConversationalAgentState,
  SignedUrlResponse,
} from './types';
import { INITIAL_CONVERSATIONAL_AGENT_STATE, DISCONNECT_REASON } from './types';

const log = debug('openhuman:voice-agent:session');

/**
 * Drop a structured breadcrumb so production failures from the voice-agent
 * pipeline are debuggable in Sentry. Phase 7 acceptance #3 requires that a
 * 30s session produces at least the connecting/connected/disconnected
 * breadcrumb trio.
 */
function addBreadcrumb(message: string, data: Record<string, unknown> = {}): void {
  try {
    Sentry.addBreadcrumb({
      category: 'voice-agent',
      level: 'info',
      message,
      data,
    });
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
   */
  fetchSignedUrl: () => Promise<SignedUrlResponse>;
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

  constructor(deps: SessionManagerDeps) {
    this.deps = deps;
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

    let signed: SignedUrlResponse;
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

    const start = this.deps.startSession ?? Conversation.startSession;
    try {
      this.conv = await start({
        signedUrl: signed.signedUrl,
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
          this.updateSnapshot({
            lastTranscript: { text: message, role, isFinal: true },
          });
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
