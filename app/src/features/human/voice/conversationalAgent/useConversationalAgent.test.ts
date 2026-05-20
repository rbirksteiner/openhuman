import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent, SignedUrlResponse } from './types';
import { useConversationalAgent } from './useConversationalAgent';

interface FakeConv {
  endSession: ReturnType<typeof vi.fn>;
  setMicMuted: ReturnType<typeof vi.fn>;
  _onConnect?: (p: { conversationId: string }) => void;
}

function makeStubSdk(): {
  startSession: (opts: Record<string, unknown>) => Promise<FakeConv>;
  getLast: () => FakeConv | null;
} {
  let last: FakeConv | null = null;
  return {
    async startSession(opts) {
      const c: FakeConv = {
        endSession: vi.fn().mockResolvedValue(undefined),
        setMicMuted: vi.fn(),
        _onConnect: opts.onConnect as never,
      };
      last = c;
      return c;
    },
    getLast: () => last,
  };
}

describe('useConversationalAgent', () => {
  it('renders with the initial idle snapshot', () => {
    const stub = makeStubSdk();
    const { result } = renderHook(() =>
      useConversationalAgent({
        deps: {
          fetchSignedUrl: async (): Promise<SignedUrlResponse> => ({
            signedUrl: 'wss://x',
            expiresAt: 1,
          }),
          onEvent: () => {},
          startSession: stub.startSession as never,
        },
      })
    );
    expect(result.current.state.lifecycle).toBe('idle');
    expect(result.current.isMuted).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('connect transitions to connecting then connected when SDK fires onConnect', async () => {
    const stub = makeStubSdk();
    const events: AgentEvent[] = [];
    const { result } = renderHook(() =>
      useConversationalAgent({
        deps: {
          fetchSignedUrl: async () => ({ signedUrl: 'wss://x', expiresAt: 1 }),
          onEvent: e => events.push(e),
          startSession: stub.startSession as never,
        },
      })
    );
    await act(async () => {
      await result.current.connect();
    });
    // Fire the SDK onConnect post-handshake
    act(() => {
      stub.getLast()!._onConnect?.({ conversationId: 'c1' });
    });
    await waitFor(() => expect(result.current.state.lifecycle).toBe('connected'));
    expect(result.current.conversationId).toBe('c1');
    expect(events.map(e => e.kind)).toEqual(['connecting', 'connected']);
  });

  it('disconnect from idle still resolves cleanly', async () => {
    const stub = makeStubSdk();
    const { result } = renderHook(() =>
      useConversationalAgent({
        deps: {
          fetchSignedUrl: async () => ({ signedUrl: 'wss://x', expiresAt: 1 }),
          onEvent: () => {},
          startSession: stub.startSession as never,
        },
      })
    );
    await act(async () => {
      await result.current.disconnect();
    });
    expect(result.current.state.lifecycle).toBe('disconnected');
  });

  it('setMuted updates the snapshot', async () => {
    const stub = makeStubSdk();
    const { result } = renderHook(() =>
      useConversationalAgent({
        deps: {
          fetchSignedUrl: async () => ({ signedUrl: 'wss://x', expiresAt: 1 }),
          onEvent: () => {},
          startSession: stub.startSession as never,
        },
      })
    );
    await act(async () => {
      await result.current.connect();
    });
    act(() => {
      stub.getLast()!._onConnect?.({ conversationId: 'c1' });
    });
    act(() => {
      result.current.setMuted(true);
    });
    await waitFor(() => expect(result.current.isMuted).toBe(true));
  });
});
