import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConversationalAgentSessionManager, type SessionManagerDeps } from './sessionManager';
import type { AgentEvent, SignedUrlResponse } from './types';

interface FakeConversation {
  endSession: ReturnType<typeof vi.fn>;
  setMicMuted: ReturnType<typeof vi.fn>;
  /** Test hook: triggers the SDK callbacks the manager registered. */
  callbacks: {
    onConnect?: (p: { conversationId: string }) => void;
    onDisconnect?: (d: { reason: string }) => void;
    onError?: (m: string) => void;
    onMessage?: (p: { message: string; source: 'user' | 'ai' }) => void;
    onModeChange?: (p: { mode: 'speaking' | 'listening' }) => void;
    onStatusChange?: (p: { status: string }) => void;
  };
}

function makeFakeSdk(): {
  startSession: (opts: Record<string, unknown>) => Promise<FakeConversation>;
  lastConversation: () => FakeConversation | null;
} {
  let last: FakeConversation | null = null;
  return {
    async startSession(opts) {
      const conv: FakeConversation = {
        endSession: vi.fn().mockResolvedValue(undefined),
        setMicMuted: vi.fn(),
        callbacks: {
          onConnect: opts.onConnect as never,
          onDisconnect: opts.onDisconnect as never,
          onError: opts.onError as never,
          onMessage: opts.onMessage as never,
          onModeChange: opts.onModeChange as never,
          onStatusChange: opts.onStatusChange as never,
        },
      };
      last = conv;
      return conv;
    },
    lastConversation: () => last,
  };
}

function buildManager(
  override: Partial<SessionManagerDeps> = {},
  signedUrl: SignedUrlResponse = { signedUrl: 'wss://test', expiresAt: 9999999 }
): {
  manager: ConversationalAgentSessionManager;
  events: AgentEvent[];
  sdk: ReturnType<typeof makeFakeSdk>;
} {
  const events: AgentEvent[] = [];
  const sdk = makeFakeSdk();
  const manager = new ConversationalAgentSessionManager({
    fetchSignedUrl: override.fetchSignedUrl ?? (async () => signedUrl),
    onEvent: override.onEvent ?? (e => events.push(e)),
    startSession: (override.startSession ?? sdk.startSession) as never,
  });
  return { manager, events, sdk };
}

describe('ConversationalAgentSessionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('emits connecting then connected on a successful handshake', async () => {
    const { manager, events, sdk } = buildManager();
    await manager.connect();
    // SDK onConnect callback fires when the session is "live"
    sdk.lastConversation()!.callbacks.onConnect?.({ conversationId: 'conv-1' });

    expect(events.map(e => e.kind)).toEqual(['connecting', 'connected']);
    expect(manager.state.lifecycle).toBe('connected');
    expect(manager.state.conversationId).toBe('conv-1');
  });

  it('publishes error event when fetchSignedUrl rejects, stays in error state', async () => {
    const { manager, events } = buildManager({
      fetchSignedUrl: async () => {
        throw new Error('backend 401');
      },
    });
    await manager.connect();
    expect(manager.state.lifecycle).toBe('error');
    expect(manager.state.error).toBe('backend 401');
    expect(events.some(e => e.kind === 'error')).toBe(true);
  });

  it('publishes error event when SDK startSession throws', async () => {
    const { manager, events } = buildManager({
      startSession: (async () => {
        throw new Error('ws handshake failed');
      }) as never,
    });
    await manager.connect();
    expect(manager.state.lifecycle).toBe('error');
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'ws handshake failed' });
  });

  it('disconnect cleanly transitions to disconnected and emits user_closed', async () => {
    const { manager, events, sdk } = buildManager();
    await manager.connect();
    sdk.lastConversation()!.callbacks.onConnect?.({ conversationId: 'c' });
    await manager.disconnect();
    // Either onDisconnect callback already fired (via the fake) or our fallback path emitted.
    expect(manager.state.lifecycle).toBe('disconnected');
    expect(events.some(e => e.kind === 'disconnected')).toBe(true);
  });

  it('forwards SDK message events as typed transcripts and counts user turns', async () => {
    const { manager, events, sdk } = buildManager();
    await manager.connect();
    const cb = sdk.lastConversation()!.callbacks;
    cb.onConnect?.({ conversationId: 'c' });
    cb.onMessage?.({ message: 'hello', source: 'user' });
    cb.onMessage?.({ message: 'hi there', source: 'ai' });

    const transcripts = events.filter(
      (e): e is Extract<AgentEvent, { kind: 'transcript' }> => e.kind === 'transcript'
    );
    expect(transcripts).toHaveLength(2);
    expect(transcripts[0]).toMatchObject({ text: 'hello', role: 'user', isFinal: true });
    expect(transcripts[1]).toMatchObject({ text: 'hi there', role: 'agent', isFinal: true });
    expect(manager.getSessionStats().turnCount).toBe(1);
  });

  it('mode change toggles isListening / isSpeaking and emits speech events', async () => {
    const { manager, events, sdk } = buildManager();
    await manager.connect();
    const cb = sdk.lastConversation()!.callbacks;
    cb.onConnect?.({ conversationId: 'c' });
    cb.onModeChange?.({ mode: 'speaking' });
    expect(manager.state.isSpeaking).toBe(true);
    expect(manager.state.isListening).toBe(false);
    cb.onModeChange?.({ mode: 'listening' });
    expect(manager.state.isSpeaking).toBe(false);
    expect(manager.state.isListening).toBe(true);
    expect(events.filter(e => e.kind === 'agent_speech_started')).toHaveLength(1);
    expect(events.filter(e => e.kind === 'agent_speech_ended')).toHaveLength(1);
  });

  it('setMuted forwards to SDK and is idempotent', async () => {
    const { manager, events, sdk } = buildManager();
    await manager.connect();
    sdk.lastConversation()!.callbacks.onConnect?.({ conversationId: 'c' });
    manager.setMuted(true);
    expect(sdk.lastConversation()!.setMicMuted).toHaveBeenCalledWith(true);
    // Second call with same value should not double-emit
    manager.setMuted(true);
    expect(sdk.lastConversation()!.setMicMuted).toHaveBeenCalledTimes(1);
    expect(events.filter(e => e.kind === 'mute_changed')).toHaveLength(1);
  });

  it('idempotent connect: second call while connecting/connected is a no-op', async () => {
    const { manager, events } = buildManager();
    await manager.connect();
    await manager.connect();
    expect(events.filter(e => e.kind === 'connecting')).toHaveLength(1);
  });

  it('disconnect from idle is a no-op (stays idle, no event)', async () => {
    const { manager, events } = buildManager();
    await manager.disconnect();
    // Guards against React strict-mode's double-mount cleanup flipping the
    // user-visible status from `idle` to `disconnected` before any click.
    expect(manager.state.lifecycle).toBe('idle');
    expect(events).toHaveLength(0);
  });
});
