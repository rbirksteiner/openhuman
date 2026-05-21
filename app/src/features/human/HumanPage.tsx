import { useEffect, useMemo, useState } from 'react';

import { useT } from '../../lib/i18n/I18nContext';
import Conversations from '../../pages/Conversations';
import { useAppSelector } from '../../store/hooks';
import { selectMascotColor, selectVoiceMode } from '../../store/mascotSlice';
import { openhumanVoiceAgentConfigGet } from '../../utils/tauriCommands/voice';
import { ConversationStatusIndicator } from './ConversationStatusIndicator';
import { YellowMascot } from './Mascot';
import { MicComposer } from './MicComposer';
import { useHumanMascot } from './useHumanMascot';
import { buildClientTools, voiceThreadIdFor } from './voice/conversationalAgent/clientTools';
import { useConversationalAgent } from './voice/conversationalAgent/useConversationalAgent';

const SPEAK_REPLIES_KEY = 'human.speakReplies';

const HumanPage = () => {
  const { t } = useT();
  const [speakReplies, setSpeakReplies] = useState<boolean>(() => {
    const raw = window.localStorage.getItem(SPEAK_REPLIES_KEY);
    return raw === null ? true : raw === '1';
  });
  const voiceMode = useAppSelector(selectVoiceMode);
  // The Conversations sidebar already mounts its own MicComposer in
  // push-to-talk mode (composer="mic-cloud"). When voice mode is
  // conversational we mount a second MicComposer instance below the
  // mascot stage — that's the one that opens the WebSocket. The agent
  // state read here drives the status indicator + mascot face/mouth.
  const isConversational = voiceMode === 'conversational' || voiceMode === 'auto';
  // `agent_id` and `voice_id` are read from `voice_agent_config_get` so
  // the values a user types in Settings → Voice → Conversation mode
  // actually reach the SDK at session start. Priority order for the
  // connection agent:
  //   1. user-configured `agent_id` (Settings panel)
  //   2. `VITE_OPENHUMAN_VOICE_AGENT_ID` build-time env override
  //   3. hardcoded test-agent fallback (only viable while the user
  //      hasn't yet configured their own agent in Settings)
  // Without (1) the app silently connects to the test agent even when
  // the user has configured their own — that mismatch was the cause
  // of "my voice / overrides / language don't apply" because they were
  // set on a different agent than the one being connected to.
  const envAgentId = (import.meta.env.VITE_OPENHUMAN_VOICE_AGENT_ID as string | undefined)?.trim();
  const FALLBACK_AGENT_ID = 'agent_4801ks3631qxfe58x7wb80kha6jm';
  const [voiceAgentConfigAgentId, setVoiceAgentConfigAgentId] = useState<string | undefined>(
    undefined
  );
  const [voiceAgentVoiceId, setVoiceAgentVoiceId] = useState<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void openhumanVoiceAgentConfigGet()
      .then(cfg => {
        if (!alive) return;
        const cfgAgentId = cfg.agent_id?.trim() || undefined;
        setVoiceAgentConfigAgentId(cfgAgentId);
        setVoiceAgentVoiceId(cfg.voice_id?.trim() || undefined);
      })
      .catch(() => {
        // Keep undefined → fall through to env / hardcoded fallback.
      });
    return () => {
      alive = false;
    };
  }, [voiceMode]);
  // Single agent instance shared between the mascot face mapper, the status
  // pill, and the conversational composer below. Mounting the hook
  // unconditionally is fine — the manager only opens a WebSocket on
  // `connect()`, not on construction.
  const agentId = voiceAgentConfigAgentId || envAgentId || FALLBACK_AGENT_ID;
  // Stable per-mount voice thread id. The agent's `conversationId` only
  // becomes known after `onConnect`, so we can't seed from it without a
  // re-render storm; instead we generate once and reuse for every tool
  // call in the lifetime of this page. The thread is voice-scoped so it
  // never collides with the user's text chat history.
  const [voiceThreadId] = useState(() => voiceThreadIdFor(null));
  const clientTools = useMemo(() => buildClientTools({ threadId: voiceThreadId }), [voiceThreadId]);
  const agent = useConversationalAgent({ agentId, voiceId: voiceAgentVoiceId, clientTools });

  useEffect(() => {
    window.localStorage.setItem(SPEAK_REPLIES_KEY, speakReplies ? '1' : '0');
  }, [speakReplies]);

  // Visemes are intentionally unused — the YellowMascot has its own talking lipsync.
  const { face } = useHumanMascot({
    speakReplies,
    voiceMode: isConversational ? 'conversational' : 'push-to-talk',
    agentState: isConversational ? agent.state : null,
    agentVisemeFrame: isConversational ? agent.currentVisemeFrame : null,
  });
  const mascotColor = useAppSelector(selectMascotColor);

  // Sidebar reserves ~436px (420px panel + 16px gutter) on the right; the
  // mascot stage takes the remaining width so the two never overlap.
  return (
    <div className="absolute inset-0 bg-stone-100 dark:bg-neutral-950 overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse at 35% 40%, rgba(74,131,221,0.10), transparent 60%)',
        }}
      />

      {/* Conversation status pill — top-center, only while voice mode is on. */}
      {isConversational && (
        <div className="pointer-events-none absolute top-4 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-1">
          <ConversationStatusIndicator state={agent.state} />
          {/* Diagnostic: surfaces which agent + voice override the SDK is
              actually being driven with. Remove once Phase 6 hardening
              lands an in-app debug overlay. */}
          <div className="rounded-full bg-white/85 dark:bg-neutral-900/85 backdrop-blur-md border border-stone-300 dark:border-neutral-700 px-2 py-0.5 text-[10px] font-mono text-stone-600 dark:text-neutral-400 max-w-[420px] truncate">
            agent={agentId.slice(0, 22)}… · voice=
            {voiceAgentVoiceId ? voiceAgentVoiceId.slice(0, 12) + '…' : '(default)'}
          </div>
        </div>
      )}

      {/* Mascot stage — fills the area to the left of the reserved sidebar column. */}
      <div className="absolute inset-y-0 left-0 right-[436px] flex flex-col items-center justify-center">
        <div className="relative w-[min(80vh,90%)] aspect-square">
          <YellowMascot face={face} mascotColor={mascotColor} />
        </div>
        {/* Conversational mic — sits under the mascot when voice mode is on.
            The shared `agent` (with build-time-fallback agent_id) handles
            connect/disconnect; this composer just renders the power UI. */}
        {isConversational && (
          <div className="mt-2 z-10">
            <MicComposer
              mode="conversational"
              agent={agent}
              disabled={false}
              onSubmit={() => {}}
              onError={msg => console.warn('[human:voice-agent] %s', msg)}
            />
          </div>
        )}
      </div>

      {/* Push-to-talk's "speak replies" checkbox is meaningless in
          conversational mode — hide it. The agent always speaks its replies
          via the live audio stream there. */}
      {!isConversational && (
        <label className="absolute top-4 left-4 z-10 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/80 dark:bg-neutral-900/80 backdrop-blur-sm border border-stone-300 dark:border-neutral-700 text-xs text-stone-700 dark:text-neutral-200 shadow-soft cursor-pointer select-none">
          <input
            type="checkbox"
            checked={speakReplies}
            onChange={e => setSpeakReplies(e.target.checked)}
            className="cursor-pointer"
          />
          {t('voice.pushToTalk')}
        </label>
      )}

      {/* Chat sidebar — vertically centered above the BottomTabBar (~80px). */}
      <div className="absolute right-4 top-0 bottom-20 z-10 flex items-center">
        <aside className="w-[420px] h-[min(720px,calc(100vh-160px))] rounded-2xl border border-stone-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-soft flex flex-col overflow-hidden">
          <Conversations variant="sidebar" composer="mic-cloud" />
        </aside>
      </div>
    </div>
  );
};

export default HumanPage;
