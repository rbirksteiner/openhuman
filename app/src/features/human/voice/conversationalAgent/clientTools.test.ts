import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ChatDoneEvent,
  ChatErrorEvent,
  ChatEventListeners,
  ChatInferenceStartEvent,
  ChatSendParams,
  ChatTextDeltaEvent,
} from '../../../../services/chatService';
import { buildClientTools, voiceThreadIdFor } from './clientTools';

/**
 * Test harness that lets us deterministically replay the realtime chat
 * event stream the bridge subscribes to. Returns a fake `chatSend` /
 * `subscribeChatEvents` pair plus an emit helper that fans events out to
 * every active listener.
 */
function makeFakeChat(): {
  chatSend: (params: ChatSendParams) => Promise<void>;
  subscribeChatEvents: (listeners: ChatEventListeners) => () => void;
  lastSent: () => ChatSendParams | null;
  emit: <K extends keyof ChatEventListeners>(
    kind: K,
    event: Parameters<NonNullable<ChatEventListeners[K]>>[0]
  ) => void;
  activeListenerCount: () => number;
} {
  let last: ChatSendParams | null = null;
  const subs = new Set<ChatEventListeners>();
  return {
    chatSend: vi.fn(async (params: ChatSendParams) => {
      last = params;
    }),
    subscribeChatEvents: (listeners: ChatEventListeners) => {
      subs.add(listeners);
      return () => {
        subs.delete(listeners);
      };
    },
    lastSent: () => last,
    emit: (kind, event) => {
      for (const sub of subs) {
        const handler = sub[kind] as
          | ((e: typeof event) => void)
          | undefined;
        handler?.(event);
      }
    },
    activeListenerCount: () => subs.size,
  };
}

describe('buildClientTools — chat_with_openhuman', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves with the full_response when chat_done fires with matching request_id', async () => {
    const chat = makeFakeChat();
    const tools = buildClientTools({
      threadId: 'voice-test',
      chatSend: chat.chatSend,
      subscribeChatEvents: chat.subscribeChatEvents,
      callCoreRpc: vi.fn() as never,
    });

    const pending = tools.chat_with_openhuman({ message: 'hi human' }) as Promise<string>;
    // Let chatSend microtask resolve so the subscription is in place.
    await vi.advanceTimersByTimeAsync(0);

    chat.emit('onInferenceStart', {
      thread_id: 'voice-test',
      request_id: 'req-1',
    } satisfies ChatInferenceStartEvent);
    chat.emit('onTextDelta', {
      thread_id: 'voice-test',
      request_id: 'req-1',
      round: 1,
      delta: 'Hello',
    } satisfies ChatTextDeltaEvent);
    chat.emit('onTextDelta', {
      thread_id: 'voice-test',
      request_id: 'req-1',
      round: 1,
      delta: ' world',
    } satisfies ChatTextDeltaEvent);
    chat.emit('onDone', {
      thread_id: 'voice-test',
      request_id: 'req-1',
      full_response: 'Hello world',
      rounds_used: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
    } satisfies ChatDoneEvent);

    const result = await pending;
    expect(result).toBe('Hello world');
    expect(chat.lastSent()).toEqual({ threadId: 'voice-test', message: 'hi human' });
    // Listener should be cleaned up after settling.
    expect(chat.activeListenerCount()).toBe(0);
  });

  it('ignores events with a mismatched request_id', async () => {
    const chat = makeFakeChat();
    const tools = buildClientTools({
      threadId: 'voice-test',
      chatSend: chat.chatSend,
      subscribeChatEvents: chat.subscribeChatEvents,
    });

    const pending = tools.chat_with_openhuman({ message: 'hi' }) as Promise<string>;
    await vi.advanceTimersByTimeAsync(0);

    // Capture our turn
    chat.emit('onInferenceStart', { thread_id: 'voice-test', request_id: 'req-mine' });
    // A foreign chat completing in another tab — must be ignored
    chat.emit('onDone', {
      thread_id: 'voice-test',
      request_id: 'req-other',
      full_response: 'foreign response',
      rounds_used: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
    });
    // Stream the real reply
    chat.emit('onTextDelta', {
      thread_id: 'voice-test',
      request_id: 'req-mine',
      round: 1,
      delta: 'mine',
    });
    chat.emit('onDone', {
      thread_id: 'voice-test',
      request_id: 'req-mine',
      full_response: 'mine',
      rounds_used: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
    });

    expect(await pending).toBe('mine');
  });

  it('ignores events from a different thread_id', async () => {
    const chat = makeFakeChat();
    const tools = buildClientTools({
      threadId: 'voice-test',
      chatSend: chat.chatSend,
      subscribeChatEvents: chat.subscribeChatEvents,
    });
    const pending = tools.chat_with_openhuman({ message: 'hi' }) as Promise<string>;
    await vi.advanceTimersByTimeAsync(0);

    // Foreign thread — must NOT capture as our request_id
    chat.emit('onInferenceStart', { thread_id: 'other-thread', request_id: 'req-foreign' });
    chat.emit('onDone', {
      thread_id: 'other-thread',
      request_id: 'req-foreign',
      full_response: 'foreign',
      rounds_used: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
    });

    // Now our real turn
    chat.emit('onInferenceStart', { thread_id: 'voice-test', request_id: 'req-mine' });
    chat.emit('onDone', {
      thread_id: 'voice-test',
      request_id: 'req-mine',
      full_response: 'real',
      rounds_used: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
    });
    expect(await pending).toBe('real');
  });

  it('resolves with buffered text when the bridge times out', async () => {
    const chat = makeFakeChat();
    const tools = buildClientTools({
      threadId: 'voice-test',
      chatSend: chat.chatSend,
      subscribeChatEvents: chat.subscribeChatEvents,
      chatToolTimeoutMs: 1000,
    });

    const pending = tools.chat_with_openhuman({ message: 'hi' }) as Promise<string>;
    await vi.advanceTimersByTimeAsync(0);

    chat.emit('onInferenceStart', { thread_id: 'voice-test', request_id: 'req-1' });
    chat.emit('onTextDelta', {
      thread_id: 'voice-test',
      request_id: 'req-1',
      round: 1,
      delta: 'partial answer',
    });

    await vi.advanceTimersByTimeAsync(1100);
    expect(await pending).toBe('partial answer');
    // Subscription cleaned up after timeout.
    expect(chat.activeListenerCount()).toBe(0);
  });

  it('returns an empty string for empty messages without subscribing', async () => {
    const chat = makeFakeChat();
    const tools = buildClientTools({
      threadId: 'voice-test',
      chatSend: chat.chatSend,
      subscribeChatEvents: chat.subscribeChatEvents,
    });
    const result = (await tools.chat_with_openhuman({ message: '   ' })) as string;
    expect(result).toBe('');
    expect(chat.activeListenerCount()).toBe(0);
    expect(chat.lastSent()).toBeNull();
  });

  it('settles with the error message when an error event fires for our request_id', async () => {
    const chat = makeFakeChat();
    const tools = buildClientTools({
      threadId: 'voice-test',
      chatSend: chat.chatSend,
      subscribeChatEvents: chat.subscribeChatEvents,
    });
    const pending = tools.chat_with_openhuman({ message: 'hi' }) as Promise<string>;
    await vi.advanceTimersByTimeAsync(0);

    chat.emit('onInferenceStart', { thread_id: 'voice-test', request_id: 'req-1' });
    chat.emit('onError', {
      thread_id: 'voice-test',
      request_id: 'req-1',
      message: 'inference failed',
      error_type: 'inference',
      round: 1,
    } satisfies ChatErrorEvent);

    const result = await pending;
    expect(result).toMatch(/error: inference failed/);
  });
});

describe('buildClientTools — recall_memory', () => {
  it('calls memory_query_namespace with the right params and returns JSON', async () => {
    const rpc = vi.fn().mockResolvedValue({ context: { entities: ['alice'] } });
    const tools = buildClientTools({
      threadId: 'voice-test',
      callCoreRpc: rpc as never,
    });

    const result = (await tools.recall_memory({ query: 'who is alice' })) as string;
    expect(rpc).toHaveBeenCalledWith({
      method: 'openhuman.memory_query_namespace',
      params: { namespace: 'voice-agent', query: 'who is alice', max_chunks: 5 },
    });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.results).toEqual({ context: { entities: ['alice'] } });
  });

  it('uses the custom namespace when provided', async () => {
    const rpc = vi.fn().mockResolvedValue(null);
    const tools = buildClientTools({
      threadId: 'voice-test',
      memoryNamespace: 'custom-ns',
      callCoreRpc: rpc as never,
    });
    await tools.recall_memory({ query: 'q' });
    expect(rpc).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ namespace: 'custom-ns' }) })
    );
  });

  it('returns a structured error envelope when the RPC throws', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('boom'));
    const tools = buildClientTools({
      threadId: 'voice-test',
      callCoreRpc: rpc as never,
    });
    const result = (await tools.recall_memory({ query: 'q' })) as string;
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('boom');
  });

  it('short-circuits on empty queries without RPC', async () => {
    const rpc = vi.fn();
    const tools = buildClientTools({
      threadId: 'voice-test',
      callCoreRpc: rpc as never,
    });
    const result = (await tools.recall_memory({ query: '' })) as string;
    expect(rpc).not.toHaveBeenCalled();
    expect(JSON.parse(result).ok).toBe(false);
  });
});

describe('buildClientTools — store_memory', () => {
  it('returns "saved" and calls memory_doc_ingest on success', async () => {
    const rpc = vi.fn().mockResolvedValue({});
    const tools = buildClientTools({
      threadId: 'voice-test',
      callCoreRpc: rpc as never,
    });
    const result = (await tools.store_memory({ note: 'remember the milk' })) as string;
    expect(result).toBe('saved');
    expect(rpc).toHaveBeenCalledTimes(1);
    const callArgs = rpc.mock.calls[0][0];
    expect(callArgs.method).toBe('openhuman.memory_doc_ingest');
    expect(callArgs.params.namespace).toBe('voice-agent');
    expect(callArgs.params.content).toBe('remember the milk');
    expect(callArgs.params.source_type).toBe('voice_agent');
    expect(typeof callArgs.params.key).toBe('string');
    expect(callArgs.params.key.length).toBeGreaterThan(0);
  });

  it('returns an error string when ingest fails', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('disk full'));
    const tools = buildClientTools({
      threadId: 'voice-test',
      callCoreRpc: rpc as never,
    });
    const result = (await tools.store_memory({ note: 'note' })) as string;
    expect(result).toMatch(/error: disk full/);
  });

  it('refuses to call RPC for empty notes', async () => {
    const rpc = vi.fn();
    const tools = buildClientTools({
      threadId: 'voice-test',
      callCoreRpc: rpc as never,
    });
    const result = (await tools.store_memory({ note: '' })) as string;
    expect(rpc).not.toHaveBeenCalled();
    expect(result).toMatch(/empty note/);
  });
});

describe('buildClientTools — get_current_time', () => {
  it('returns the injected `now()` ISO string and never hits RPC', () => {
    const rpc = vi.fn();
    const tools = buildClientTools({
      threadId: 'voice-test',
      now: () => '2026-05-21T12:00:00.000Z',
      callCoreRpc: rpc as never,
    });
    const result = tools.get_current_time({});
    expect(result).toBe('2026-05-21T12:00:00.000Z');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('default `now` returns a valid ISO 8601 string', () => {
    const tools = buildClientTools({ threadId: 'voice-test' });
    const result = tools.get_current_time({}) as string;
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

describe('voiceThreadIdFor', () => {
  it('prefixes with `voice-` and uses the conversation id when present', () => {
    expect(voiceThreadIdFor('conv-abc')).toBe('voice-conv-abc');
  });
  it('falls back to a local timestamped id when conversation id is missing', () => {
    const id = voiceThreadIdFor(null);
    expect(id.startsWith('voice-local-')).toBe(true);
  });
  it('trims whitespace-only conversation ids', () => {
    const id = voiceThreadIdFor('   ');
    expect(id.startsWith('voice-local-')).toBe(true);
  });
});
