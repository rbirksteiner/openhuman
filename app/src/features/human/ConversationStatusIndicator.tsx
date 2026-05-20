import type { ConversationalAgentState } from './voice/conversationalAgent/types';

/**
 * Status pill for the ElevenLabs Conversational Agent. Renders a colored
 * dot + short text label that mirrors the agent's lifecycle so users can
 * tell at a glance whether the session is live, who is talking, and
 * whether something has gone wrong.
 *
 * Text-first, no emojis — same aesthetic as `VoiceAgentTester`. Mount it
 * somewhere visible on the Human page while conversational mode is on.
 */
export interface ConversationStatusIndicatorProps {
  state: ConversationalAgentState | null;
}

interface PillVariant {
  label: string;
  dotClass: string;
  containerClass: string;
}

function variantForState(state: ConversationalAgentState | null): PillVariant {
  if (!state || state.lifecycle === 'disconnected' || state.lifecycle === 'idle') {
    return {
      label: 'Disconnected',
      dotClass: 'bg-stone-400 dark:bg-neutral-500',
      containerClass:
        'border-stone-300 dark:border-neutral-700 text-stone-500 dark:text-neutral-400 bg-white/80 dark:bg-neutral-900/80',
    };
  }
  if (state.lifecycle === 'error') {
    return {
      label: 'Error',
      dotClass: 'bg-rose-500',
      containerClass:
        'border-rose-300 dark:border-rose-700 text-rose-700 dark:text-rose-300 bg-rose-50/90 dark:bg-rose-950/60',
    };
  }
  if (state.lifecycle === 'connecting') {
    return {
      label: 'Connecting…',
      dotClass: 'bg-amber-400 animate-pulse',
      containerClass:
        'border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200 bg-amber-50/90 dark:bg-amber-950/60',
    };
  }
  // lifecycle === 'connected'
  if (state.isSpeaking) {
    return {
      label: 'Speaking…',
      dotClass: 'bg-sky-500 animate-pulse',
      containerClass:
        'border-sky-300 dark:border-sky-700 text-sky-800 dark:text-sky-200 bg-sky-50/90 dark:bg-sky-950/60',
    };
  }
  if (state.isListening) {
    return {
      label: 'Listening…',
      dotClass: 'bg-emerald-500 animate-pulse',
      containerClass:
        'border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200 bg-emerald-50/90 dark:bg-emerald-950/60',
    };
  }
  if (state.lastTranscript) {
    // Connected but neither flag is set and a transcript exists — agent is
    // processing the user's latest turn.
    return {
      label: 'Thinking…',
      dotClass: 'bg-stone-500',
      containerClass:
        'border-stone-300 dark:border-neutral-700 text-stone-700 dark:text-neutral-200 bg-white/85 dark:bg-neutral-900/85',
    };
  }
  return {
    label: 'Connected',
    dotClass: 'bg-emerald-500',
    containerClass:
      'border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-200 bg-emerald-50/90 dark:bg-emerald-950/60',
  };
}

export function ConversationStatusIndicator({ state }: ConversationStatusIndicatorProps) {
  const variant = variantForState(state);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="conversation-status-indicator"
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium shadow-soft backdrop-blur-sm ${variant.containerClass}`}>
      <span className={`inline-block w-2 h-2 rounded-full ${variant.dotClass}`} aria-hidden />
      <span>{variant.label}</span>
    </div>
  );
}

export default ConversationStatusIndicator;
