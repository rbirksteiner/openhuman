import type { VisemeFrame } from '../ttsClient';

/**
 * Lifecycle states for the ElevenLabs conversational session.
 *
 * - `idle`         — never connected, or cleanly disconnected
 * - `connecting`   — fetching signed URL + opening WS handshake
 * - `connected`    — handshake done, full-duplex audio open
 * - `disconnected` — clean close (user clicked stop)
 * - `error`        — unrecoverable failure (Phase 6 layers reconnect/fallback on top)
 */
export type ConversationalAgentLifecycle =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

/** Snapshot consumed by the React hook. */
export interface ConversationalAgentState {
  lifecycle: ConversationalAgentLifecycle;
  conversationId: string | null;
  isListening: boolean;
  isSpeaking: boolean;
  isMuted: boolean;
  lastTranscript: { text: string; role: 'user' | 'agent'; isFinal: boolean } | null;
  currentVisemeFrame: VisemeFrame | null;
  error: string | null;
}

/** Initial state — call sites can spread this on top of partial overrides. */
export const INITIAL_CONVERSATIONAL_AGENT_STATE: ConversationalAgentState = {
  lifecycle: 'idle',
  conversationId: null,
  isListening: false,
  isSpeaking: false,
  isMuted: false,
  lastTranscript: null,
  currentVisemeFrame: null,
  error: null,
};

/**
 * Typed event stream the session manager dispatches. Consumers fold this
 * into the snapshot above (the hook does, via `useSyncExternalStore`).
 */
export type AgentEvent =
  | { kind: 'connecting' }
  | { kind: 'connected'; conversationId: string }
  | { kind: 'disconnected'; reason: string }
  | { kind: 'user_speech_started' }
  | { kind: 'user_speech_ended' }
  | { kind: 'agent_speech_started' }
  | { kind: 'agent_speech_ended' }
  | { kind: 'viseme'; frame: VisemeFrame }
  | { kind: 'transcript'; text: string; isFinal: boolean; role: 'user' | 'agent' }
  | { kind: 'mute_changed'; muted: boolean }
  | { kind: 'error'; message: string };

/** What `voice_agent_get_signed_url` returns to the frontend. */
export interface SignedUrlResponse {
  signedUrl: string;
  /** Unix seconds when the URL stops working. */
  expiresAt: number;
}

/** Reason codes for clean / unexpected disconnects. */
export const DISCONNECT_REASON = {
  USER_CLOSED: 'user_closed',
  ERROR: 'error',
  FALLBACK: 'fallback',
  EXPIRED: 'expired',
} as const;
export type DisconnectReason = (typeof DISCONNECT_REASON)[keyof typeof DISCONNECT_REASON];
