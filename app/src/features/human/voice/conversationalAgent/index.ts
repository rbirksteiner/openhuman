export { ConversationalAgentSessionManager, type SessionManagerDeps } from './sessionManager';
export {
  useConversationalAgent,
  type UseConversationalAgentOptions,
  type UseConversationalAgentResult,
} from './useConversationalAgent';
export {
  type AgentEvent,
  type ConversationalAgentLifecycle,
  type ConversationalAgentState,
  type SignedUrlResponse,
  type DisconnectReason,
  DISCONNECT_REASON,
  INITIAL_CONVERSATIONAL_AGENT_STATE,
} from './types';
export { OCULUS_VISEME_BY_ID, tryAdaptVisemeFrame, type MaybeVisemeInput } from './visemeAdapter';
