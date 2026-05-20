import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ConversationStatusIndicator } from './ConversationStatusIndicator';
import type { ConversationalAgentState } from './voice/conversationalAgent/types';

function makeState(overrides: Partial<ConversationalAgentState> = {}): ConversationalAgentState {
  return {
    lifecycle: overrides.lifecycle ?? 'idle',
    conversationId: overrides.conversationId ?? null,
    isListening: overrides.isListening ?? false,
    isSpeaking: overrides.isSpeaking ?? false,
    isMuted: overrides.isMuted ?? false,
    lastTranscript: overrides.lastTranscript ?? null,
    currentVisemeFrame: overrides.currentVisemeFrame ?? null,
    error: overrides.error ?? null,
  };
}

describe('ConversationStatusIndicator', () => {
  it('renders the disconnected label when state is null', () => {
    render(<ConversationStatusIndicator state={null} />);
    expect(screen.getByTestId('conversation-status-indicator')).toHaveTextContent(/disconnected/i);
  });

  it('renders the connecting label while lifecycle === connecting', () => {
    render(<ConversationStatusIndicator state={makeState({ lifecycle: 'connecting' })} />);
    expect(screen.getByText(/connecting/i)).toBeInTheDocument();
  });

  it('renders the listening label when connected + isListening', () => {
    render(
      <ConversationStatusIndicator
        state={makeState({ lifecycle: 'connected', isListening: true })}
      />
    );
    expect(screen.getByText(/listening/i)).toBeInTheDocument();
  });

  it('renders the speaking label when connected + isSpeaking', () => {
    render(
      <ConversationStatusIndicator
        state={makeState({ lifecycle: 'connected', isSpeaking: true })}
      />
    );
    expect(screen.getByText(/speaking/i)).toBeInTheDocument();
  });

  it('renders the thinking label when connected with a transcript but no flags', () => {
    render(
      <ConversationStatusIndicator
        state={makeState({
          lifecycle: 'connected',
          lastTranscript: { text: 'hello', role: 'user', isFinal: true },
        })}
      />
    );
    expect(screen.getByText(/thinking/i)).toBeInTheDocument();
  });

  it('renders the connected label when connected with no transcript or flags', () => {
    render(<ConversationStatusIndicator state={makeState({ lifecycle: 'connected' })} />);
    expect(screen.getByText(/^connected$/i)).toBeInTheDocument();
  });

  it('renders the error label when lifecycle === error', () => {
    render(<ConversationStatusIndicator state={makeState({ lifecycle: 'error' })} />);
    expect(screen.getByText(/error/i)).toBeInTheDocument();
  });
});
