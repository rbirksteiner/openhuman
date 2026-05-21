import { useCallback } from 'react';

import { useConversationalAgent } from './useConversationalAgent';

/**
 * The ElevenLabs Conversational Agent's `agent_id` (Phase 0 deliverable).
 * Created on the project's ElevenLabs account; uses TTS `eleven_flash_v2`
 * (~75 ms TTFB) + LLM `gpt-oss-120b` (ElevenLabs-hosted realtime).
 *
 * The allowlist on this agent permits `tauri.localhost` and `localhost`
 * origins, so the desktop client can open the WebSocket directly without
 * a server-side signed-URL relay. Once Phase 1's backend route is live,
 * the relay path takes over and this constant becomes a fallback.
 *
 * Override at build time via `VITE_OPENHUMAN_VOICE_AGENT_ID`.
 */
const VOICE_AGENT_ID =
  (import.meta.env.VITE_OPENHUMAN_VOICE_AGENT_ID as string | undefined)?.trim() ||
  'agent_4801ks3631qxfe58x7wb80kha6jm';

/**
 * Inline test panel for the ElevenLabs Conversational Agent. Lives on the
 * Human page so a user can click → speak → hear a streamed reply without
 * any of the Phase 4 push-to-talk UX being touched.
 *
 * Deliberately a separate component (NOT a `MicComposer` mode toggle) until
 * Phase 4 (`openhuman-afn.6`) replaces this with the full conversation-vs-
 * push-to-talk mode switch in Settings.
 */
export function VoiceAgentTester() {
  const agent = useConversationalAgent({ agentId: VOICE_AGENT_ID });

  const onToggle = useCallback(() => {
    if (agent.state.lifecycle === 'connected' || agent.state.lifecycle === 'connecting') {
      void agent.disconnect();
    } else {
      void agent.connect();
    }
  }, [agent]);

  const onToggleMute = useCallback(() => {
    agent.setMuted(!agent.isMuted);
  }, [agent]);

  const isLive = agent.state.lifecycle === 'connected' || agent.state.lifecycle === 'connecting';

  const statusLabel = labelForLifecycle(agent.state, isLive);

  return (
    <div className="pointer-events-auto absolute top-4 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2 rounded-2xl bg-white/85 dark:bg-neutral-900/85 backdrop-blur-md border border-stone-300 dark:border-neutral-700 px-4 py-3 shadow-soft text-sm text-stone-800 dark:text-neutral-100 min-w-[280px] max-w-[380px]">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggle}
          className={`px-3 py-1.5 rounded-full font-medium transition-colors ${
            isLive
              ? 'bg-rose-500 hover:bg-rose-600 text-white'
              : 'bg-ocean-500 hover:bg-ocean-600 text-white'
          }`}>
          {isLive ? 'Stop voice mode' : 'Try voice mode'}
        </button>
        {isLive && (
          <button
            type="button"
            onClick={onToggleMute}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              agent.isMuted
                ? 'bg-amber-100 border-amber-300 text-amber-900 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-700'
                : 'bg-stone-100 border-stone-300 text-stone-700 dark:bg-neutral-800 dark:text-neutral-200 dark:border-neutral-700'
            }`}>
            {agent.isMuted ? 'Unmute' : 'Mute'}
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs text-stone-600 dark:text-neutral-400">
        <span
          className={`inline-block w-2 h-2 rounded-full ${dotColor(agent.state.lifecycle, isLive, agent.isSpeaking, agent.isListening)}`}
        />
        <span>{statusLabel}</span>
      </div>

      {agent.lastTranscript && (
        <div className="w-full text-xs leading-snug text-stone-700 dark:text-neutral-200 text-center px-2">
          <span className="opacity-60">
            {agent.lastTranscript.role === 'user' ? 'You: ' : 'Agent: '}
          </span>
          {agent.lastTranscript.text}
        </div>
      )}

      {agent.error && (
        <div className="w-full text-xs text-rose-700 dark:text-rose-300 text-center px-2">
          {agent.error}
        </div>
      )}

      <div className="text-[10px] uppercase tracking-wider text-stone-400 dark:text-neutral-500">
        Voice mode · BETA
      </div>
    </div>
  );
}

function labelForLifecycle(
  state: ReturnType<typeof useConversationalAgent>['state'],
  isLive: boolean
): string {
  if (state.lifecycle === 'connecting') return 'Connecting…';
  if (state.lifecycle === 'error') return 'Error';
  if (state.lifecycle === 'disconnected') return 'Disconnected';
  if (!isLive) return 'Idle';
  if (state.isSpeaking) return 'Agent speaking…';
  if (state.isListening) return 'Listening…';
  return 'Connected';
}

function dotColor(
  lifecycle: ReturnType<typeof useConversationalAgent>['state']['lifecycle'],
  isLive: boolean,
  isSpeaking: boolean,
  isListening: boolean
): string {
  if (lifecycle === 'error') return 'bg-rose-500';
  if (lifecycle === 'connecting') return 'bg-amber-400 animate-pulse';
  if (!isLive) return 'bg-stone-400 dark:bg-neutral-500';
  if (isSpeaking) return 'bg-sky-500 animate-pulse';
  if (isListening) return 'bg-emerald-500 animate-pulse';
  return 'bg-emerald-500';
}
