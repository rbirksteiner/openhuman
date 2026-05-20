import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import debug from 'debug';

import { callCoreRpc } from '../../../../services/coreRpcClient';
import type { VisemeFrame } from '../ttsClient';
import {
  ConversationalAgentSessionManager,
  type SessionManagerDeps,
} from './sessionManager';
import type {
  AgentEvent,
  ConversationalAgentState,
  SignedUrlResponse,
} from './types';

const log = debug('openhuman:voice-agent:hook');

/**
 * The agent's-side return shape — see Rust `voice_agent_get_signed_url`
 * (`src/openhuman/voice_agent/schemas.rs`). We keep this loose at the wire
 * because the core RPC client returns `unknown`-ish results; the hook
 * narrows just what it needs.
 */
interface CoreSignedUrlResponse {
  ok: boolean;
  signed_url: string;
  expires_at: number;
  error?: string;
}

/**
 * Default `fetchSignedUrl` — hits the in-process core via `coreRpcClient`.
 * Tests pass a stubbed deps bag through `useConversationalAgent({deps})`.
 */
async function defaultFetchSignedUrl(): Promise<SignedUrlResponse> {
  const raw = (await callCoreRpc<CoreSignedUrlResponse>({
    method: 'openhuman.voice_agent_get_signed_url',
    params: {},
  })) as CoreSignedUrlResponse | undefined;
  if (!raw || raw.ok !== true || !raw.signed_url) {
    const reason = raw?.error ?? 'voice_agent_get_signed_url returned ok=false';
    throw new Error(reason);
  }
  return { signedUrl: raw.signed_url, expiresAt: raw.expires_at };
}

export interface UseConversationalAgentOptions {
  /**
   * Test-only: inject a fully-formed deps bag. In production callers should
   * leave this undefined; the hook constructs the manager with the real
   * RPC client + SDK.
   */
  deps?: Partial<SessionManagerDeps>;
}

export interface UseConversationalAgentResult {
  state: ConversationalAgentState;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  setMuted: (muted: boolean) => void;
  isListening: boolean;
  isSpeaking: boolean;
  isMuted: boolean;
  currentVisemeFrame: VisemeFrame | null;
  lastTranscript: { text: string; role: 'user' | 'agent'; isFinal: boolean } | null;
  error: string | null;
  conversationId: string | null;
}

/**
 * React hook around `ConversationalAgentSessionManager`. Single instance per
 * mount (do NOT put inside a global provider — the Human page owns it).
 *
 * Returns a stable object reference whose fields update through
 * `useSyncExternalStore`, so consumers can pass `connect` / `disconnect`
 * straight to `onClick` without `useCallback` gymnastics.
 */
export function useConversationalAgent(
  options: UseConversationalAgentOptions = {},
): UseConversationalAgentResult {
  // Manager survives re-renders; ref makes that explicit.
  const managerRef = useRef<ConversationalAgentSessionManager | null>(null);

  if (managerRef.current === null) {
    const fetchSignedUrl =
      options.deps?.fetchSignedUrl ?? defaultFetchSignedUrl;
    const onEvent = options.deps?.onEvent ?? ((event: AgentEvent) => {
      // Default sink: trace-log for diagnosis. Phase 7 wires Sentry breadcrumbs.
      log('[voice-agent] event: %s', event.kind);
    });
    managerRef.current = new ConversationalAgentSessionManager({
      fetchSignedUrl,
      onEvent,
      startSession: options.deps?.startSession,
    });
  }

  const manager = managerRef.current;

  // Tear down on unmount so a hot-reloaded page doesn't leak the WebSocket.
  useEffect(() => {
    return () => {
      void manager.disconnect();
    };
  }, [manager]);

  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);

  const connect = useCallback(() => manager.connect(), [manager]);
  const disconnect = useCallback(() => manager.disconnect(), [manager]);
  const setMuted = useCallback((muted: boolean) => manager.setMuted(muted), [manager]);

  return useMemo(
    () => ({
      state,
      connect,
      disconnect,
      setMuted,
      isListening: state.isListening,
      isSpeaking: state.isSpeaking,
      isMuted: state.isMuted,
      currentVisemeFrame: state.currentVisemeFrame,
      lastTranscript: state.lastTranscript,
      error: state.error,
      conversationId: state.conversationId,
    }),
    [state, connect, disconnect, setMuted],
  );
}
