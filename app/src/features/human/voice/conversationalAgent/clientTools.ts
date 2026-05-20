/**
 * Brain bridge for the ElevenLabs Conversational Agent — Phase 5 (pragmatic
 * client-side variant).
 *
 * The Phase 5 spec (`openhuman-afn.7`) calls for `recall_memory` /
 * `store_memory` / `get_current_time` wired as server-side **webhook tools**
 * on the tinyhumansai backend (`/api/v1/elevenlabs/tools/*`). Those routes
 * belong to Phase 1 (`openhuman-afn.3`), which is still open, so we can't
 * land the webhook variant from this repo.
 *
 * The ElevenLabs `@elevenlabs/client` SDK supports **client-side tools** that
 * the agent invokes inside our running Tauri app. By wiring those tools to
 * OpenHuman's core RPC we achieve the same end result — every spoken reply
 * goes through the orchestrator (memory + tools + subagents) instead of the
 * hosted LLM doing its own thinking.
 *
 * Public surface:
 *   - {@link buildClientTools}: factory that returns the `clientTools` map
 *     consumed by `Conversation.startSession`.
 *   - {@link ClientToolsDeps}: dependency bag. Tests inject fakes.
 */
import debug from 'debug';

import { callCoreRpc } from '../../../../services/coreRpcClient';
import {
  chatSend as defaultChatSend,
  subscribeChatEvents as defaultSubscribeChatEvents,
  type ChatEventListeners,
  type ChatSendParams,
} from '../../../../services/chatService';

const log = debug('openhuman:voice-agent:tools');

/**
 * Default namespace memory tools read from / write to. The
 * `openhuman.memory_*` RPCs all require a namespace; using a stable
 * dedicated one means memories the agent stores during a voice session
 * don't pollute the user's primary memory bucket.
 */
const DEFAULT_MEMORY_NAMESPACE = 'voice-agent';

/** Hard ceiling on `chat_with_openhuman` so a stalled core can't deadlock the SDK. */
const CHAT_TOOL_TIMEOUT_MS = 30_000;

/** Recall sane default — pass-through the spec says "limit 5", we map to `max_chunks=5`. */
const DEFAULT_RECALL_LIMIT = 5;

export interface ClientToolsDeps {
  /**
   * Thread id all `chat_with_openhuman` invocations target. Voice sessions
   * use a deterministic id derived from the agent conversation id so the
   * voice exchange has its own thread (and doesn't pollute the user's text
   * chat history). Required.
   */
  threadId: string;
  /**
   * Memory namespace `recall_memory` / `store_memory` operate against.
   * Optional; defaults to {@link DEFAULT_MEMORY_NAMESPACE}.
   */
  memoryNamespace?: string;
  /** Test seam — defaults to the production `chatSend`. */
  chatSend?: (params: ChatSendParams) => Promise<void>;
  /** Test seam — defaults to the production `subscribeChatEvents`. */
  subscribeChatEvents?: (listeners: ChatEventListeners) => () => void;
  /** Test seam — defaults to the production `callCoreRpc`. */
  callCoreRpc?: typeof callCoreRpc;
  /** Test seam — defaults to `() => new Date().toISOString()`. */
  now?: () => string;
  /** Test seam — chat tool timeout (ms). Defaults to {@link CHAT_TOOL_TIMEOUT_MS}. */
  chatToolTimeoutMs?: number;
}

/**
 * Map matching `ClientToolsConfig.clientTools` from the ElevenLabs SDK
 * (`@elevenlabs/client/dist/BaseConversation.d.ts`). The SDK declares
 * parameters as `any` (so it accepts arbitrary shapes from the model);
 * we use `unknown` for the contravariant-safe match with
 * `SessionManagerDeps['clientTools']` and narrow inside each handler.
 */
export type VoiceClientTools = Record<
  string,
  (parameters: unknown) => Promise<string | number | void> | string | number | void
>;

/** Narrow an `unknown` SDK parameter bag to a plain record for safe property access. */
function asRecord(parameters: unknown): Record<string, unknown> {
  return parameters && typeof parameters === 'object'
    ? (parameters as Record<string, unknown>)
    : {};
}

/**
 * Build the four-tool brain bridge.
 *
 * The agent must call `chat_with_openhuman` for every user turn (system
 * prompt enforced — see `gitbooks/developing/voice-agent-brain.md`).
 * `recall_memory` / `store_memory` / `get_current_time` are optional helpers
 * for cases the orchestrator doesn't already cover.
 */
export function buildClientTools(deps: ClientToolsDeps): VoiceClientTools {
  const chatSend = deps.chatSend ?? defaultChatSend;
  const subscribeChatEvents = deps.subscribeChatEvents ?? defaultSubscribeChatEvents;
  const rpc = deps.callCoreRpc ?? callCoreRpc;
  const now = deps.now ?? (() => new Date().toISOString());
  const timeoutMs = deps.chatToolTimeoutMs ?? CHAT_TOOL_TIMEOUT_MS;
  const namespace = deps.memoryNamespace ?? DEFAULT_MEMORY_NAMESPACE;
  const threadId = deps.threadId;

  return {
    /**
     * The brain. The ElevenLabs agent's system prompt tells it to call this
     * with the verbatim user message and speak the return value back
     * unchanged. We push the message into `channel_web_chat`, accumulate
     * `text_delta`s for the matching `request_id`, and resolve on
     * `chat_done`.
     */
    chat_with_openhuman: async (parameters: unknown): Promise<string> => {
      const p = asRecord(parameters);
      const message = typeof p.message === 'string' ? p.message : '';
      if (!message.trim()) {
        log('chat_with_openhuman called with empty message — returning empty string');
        return '';
      }
      return await runChatBridge({
        message,
        threadId,
        timeoutMs,
        chatSend,
        subscribeChatEvents,
      });
    },

    /**
     * Search OpenHuman's memory store. Returns a JSON-encoded summary that
     * the agent reads as its tool result. The agent then either incorporates
     * the snippets in its reply or hands them back to `chat_with_openhuman`.
     */
    recall_memory: async (parameters: unknown): Promise<string> => {
      const p = asRecord(parameters);
      const query = typeof p.query === 'string' ? p.query.trim() : '';
      if (!query) return JSON.stringify({ ok: false, error: 'empty query', results: [] });
      try {
        log('recall_memory query=%s namespace=%s', query, namespace);
        const resp = await rpc<unknown>({
          method: 'openhuman.memory_query_namespace',
          params: { namespace, query, max_chunks: DEFAULT_RECALL_LIMIT },
        });
        return JSON.stringify({ ok: true, results: resp ?? null });
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        log('recall_memory failed: %s', errMessage);
        return JSON.stringify({ ok: false, error: errMessage, results: [] });
      }
    },

    /**
     * Persist a short note. We generate a `key` from the current timestamp
     * so callers don't have to invent one. Successful writes return
     * `"saved"`, which is short enough for the agent to vocalise as a
     * confirmation without prompting weirdness.
     */
    store_memory: async (parameters: unknown): Promise<string> => {
      const p = asRecord(parameters);
      const note = typeof p.note === 'string' ? p.note.trim() : '';
      if (!note) return 'error: empty note';
      const timestamp = Date.now();
      const key = `voice-${timestamp}`;
      try {
        log('store_memory key=%s namespace=%s chars=%d', key, namespace, note.length);
        await rpc<unknown>({
          method: 'openhuman.memory_doc_ingest',
          params: {
            namespace,
            key,
            title: `Voice note ${new Date(timestamp).toISOString()}`,
            content: note,
            source_type: 'voice_agent',
          },
        });
        return 'saved';
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : String(err);
        log('store_memory failed: %s', errMessage);
        return `error: ${errMessage}`;
      }
    },

    /**
     * ISO timestamp. Trivial enough that no RPC round-trip is justified —
     * the in-process tokio core's clock is the JS clock anyway.
     */
    get_current_time: (): string => now(),
  };
}

interface ChatBridgeArgs {
  message: string;
  threadId: string;
  timeoutMs: number;
  chatSend: (params: ChatSendParams) => Promise<void>;
  subscribeChatEvents: (listeners: ChatEventListeners) => () => void;
}

/**
 * Run one `chat_with_openhuman` call to completion.
 *
 * Correlation strategy: `chatSend` doesn't currently return the
 * request_id, so we subscribe **before** sending and capture the first
 * `inference_start` event whose `thread_id` matches ours. Every
 * subsequent text_delta / chat_done event is filtered by that request_id.
 *
 * This is the smallest possible bridge — there's no retry, no
 * cancellation propagation, no streaming back to the agent (the SDK
 * doesn't support partial returns from client tools yet). On hard
 * timeout we resolve with whatever's accumulated so the agent has
 * *something* to speak rather than hanging the session forever.
 */
async function runChatBridge(args: ChatBridgeArgs): Promise<string> {
  const { message, threadId, timeoutMs, chatSend, subscribeChatEvents } = args;
  return await new Promise<string>(resolve => {
    let requestId: string | null = null;
    let buffered = '';
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const settle = (value: string): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch (err) {
          log('unsubscribe threw: %s', err instanceof Error ? err.message : err);
        }
      }
      resolve(value);
    };

    unsubscribe = subscribeChatEvents({
      onInferenceStart: event => {
        if (event.thread_id !== threadId) return;
        if (requestId !== null) return; // first-wins: capture our turn's id
        requestId = event.request_id;
        log('chat bridge captured request_id=%s', requestId);
      },
      onTextDelta: event => {
        if (event.thread_id !== threadId) return;
        if (requestId === null || event.request_id !== requestId) return;
        buffered += event.delta;
      },
      onDone: event => {
        if (event.thread_id !== threadId) return;
        // If we never saw `inference_start` (older core?) accept any done on our thread.
        if (requestId !== null && event.request_id !== requestId) return;
        const finalText = event.full_response || buffered;
        log(
          'chat bridge resolved request_id=%s chars=%d',
          requestId ?? '<unknown>',
          finalText.length
        );
        settle(finalText);
      },
      onError: event => {
        if (event.thread_id !== threadId) return;
        if (requestId !== null && event.request_id !== requestId) return;
        log('chat bridge error: %s', event.message);
        settle(buffered || `error: ${event.message}`);
      },
    });

    timeoutHandle = setTimeout(() => {
      log('chat bridge timed out after %dms — resolving with %d buffered chars', timeoutMs, buffered.length);
      settle(buffered || 'sorry, I had trouble thinking that one through');
    }, timeoutMs);

    // Fire-and-forget send. If it throws synchronously (no socket) settle
    // immediately so the agent doesn't sit on a dead promise.
    chatSend({ threadId, message }).catch(err => {
      const errMessage = err instanceof Error ? err.message : String(err);
      log('chatSend rejected: %s', errMessage);
      settle(`error: ${errMessage}`);
    });
  });
}

/** Re-exported for callers that want to seed a thread id consistently. */
export function voiceThreadIdFor(conversationId: string | null | undefined): string {
  const seed = conversationId?.trim() || `local-${Date.now()}`;
  return `voice-${seed}`;
}
