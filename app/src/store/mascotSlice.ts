import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { REHYDRATE } from 'redux-persist';

import {
  defaultVoiceIdForLocale,
  ELEVENLABS_VOICE_PRESETS,
} from '../components/settings/panels/elevenlabsVoicePresets';
import type { MascotColor } from '../features/human/Mascot/mascotPalette';
import type { Locale } from '../lib/i18n/types';
import { MASCOT_VOICE_ID } from '../utils/config';
import { resetUserScopedState } from './resetActions';

export const SUPPORTED_MASCOT_COLORS: readonly MascotColor[] = [
  'yellow',
  'burgundy',
  'black',
  'navy',
  'green',
];

export const DEFAULT_MASCOT_COLOR: MascotColor = 'yellow';

export type MascotVoiceGender = 'male' | 'female';

/**
 * Push-to-talk vs. continuous conversation mode for the Human page mic
 * composer. Persisted so the user's preference survives restarts.
 *
 * - `push-to-talk` — default. MediaRecorder records, sends to STT RPC, the
 *   transcript is shipped through the existing send pipeline.
 * - `conversational` — opens an ElevenLabs Conversational Agent WebSocket,
 *   real-time full-duplex audio.
 * - `auto` — UI surfaces this option, but today it behaves the same as
 *   `conversational` (with a future graceful fallback to push-to-talk
 *   when the agent can't be reached). Treat as conversational at the call
 *   site for now.
 */
export type VoiceMode = 'push-to-talk' | 'conversational' | 'auto';

export const SUPPORTED_VOICE_MODES: readonly VoiceMode[] = [
  'push-to-talk',
  'conversational',
  'auto',
];

export const DEFAULT_VOICE_MODE: VoiceMode = 'push-to-talk';

function isVoiceMode(value: unknown): value is VoiceMode {
  return typeof value === 'string' && (SUPPORTED_VOICE_MODES as readonly string[]).includes(value);
}

/**
 * Default gender for the mascot's reply voice. Matches the default
 * voice id (`MASCOT_VOICE_ID` — George, a male multilingual ElevenLabs
 * voice) so new users see consistent state in the Mascot settings
 * panel without any extra writes.
 */
export const DEFAULT_MASCOT_VOICE_GENDER: MascotVoiceGender = 'male';

/**
 * Maximum length of a stored mascot voice id. ElevenLabs voice ids are
 * short opaque alphanumeric strings (typically 20 chars); the cap exists
 * solely so a stray paste of multi-megabyte clipboard data can never
 * land in localStorage and balloon the persisted blob. Anything longer
 * is dropped at the reducer boundary.
 */
export const MAX_MASCOT_VOICE_ID_LEN = 128;

/**
 * Loose shape check for a stored mascot voice id. Issue #1762 lets users
 * paste a custom ElevenLabs voice id, so we cannot enumerate the valid
 * set — instead we accept any non-empty trimmed string under the length
 * cap. The TTS path (`synthesizeSpeech` in
 * `app/src/features/human/voice/ttsClient.ts`) is the authoritative
 * gate: a syntactically valid id that ElevenLabs rejects falls back
 * cleanly via the existing TTS error handling, leaving `MASCOT_VOICE_ID`
 * as the implicit safe default.
 */
function isMascotVoiceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= MAX_MASCOT_VOICE_ID_LEN
  );
}

function isMascotVoiceGender(value: unknown): value is MascotVoiceGender {
  return value === 'male' || value === 'female';
}

export interface MascotState {
  color: MascotColor;
  /**
   * User-selected ElevenLabs voice id for the mascot's reply speech, or
   * `null` to use the build-time default (`MASCOT_VOICE_ID` in
   * `app/src/utils/config.ts`). Issue #1762: surfaces what was
   * previously a build-time-only env var (`VITE_MASCOT_VOICE_ID`) as a
   * persisted user preference so the choice survives restarts and a
   * reset is just `setMascotVoiceId(null)`.
   */
  voiceId: string | null;
  /**
   * Coarse gender bucket used by the Mascot settings panel to filter
   * the voice preset dropdown and to drive the "default voice from app
   * locale" toggle (combined with the current locale to pick a single
   * voice id). Independent of `voiceId` — the user can keep a manual
   * override and still flip gender for the locale-default branch.
   */
  voiceGender: MascotVoiceGender;
  /**
   * When true, ignore `voiceId` and pick the voice from the active
   * locale (+ `voiceGender`) via `defaultVoiceIdForLocale`. Lets users
   * say "speak in my UI language" once and have the mascot follow
   * locale changes without re-opening settings.
   */
  voiceUseLocaleDefault: boolean;
  /**
   * Server-side mascot id selected from the backend mascot library
   * (PR tinyhumansai/backend#770). `null` keeps the local YellowMascot
   * renderer; any non-empty value tells `BackendMascot` (loaded via
   * `mascotService`) to take over. The id is opaque server-side and
   * length-capped at the same threshold as voiceId to keep the
   * persisted blob bounded.
   */
  selectedMascotId: string | null;
  /**
   * User-selected voice mode for the Human page composer. See
   * `VoiceMode` for the lifecycle. Persisted so flipping into
   * conversational mode survives restarts. Defaults to push-to-talk —
   * the existing MediaRecorder flow — so this slice change cannot
   * regress the legacy mic UX on first install.
   */
  voiceMode: VoiceMode;
}

const initialState: MascotState = {
  color: DEFAULT_MASCOT_COLOR,
  voiceId: null,
  voiceGender: DEFAULT_MASCOT_VOICE_GENDER,
  voiceUseLocaleDefault: false,
  selectedMascotId: null,
  voiceMode: DEFAULT_VOICE_MODE,
};

function isMascotColor(value: unknown): value is MascotColor {
  return (
    typeof value === 'string' && (SUPPORTED_MASCOT_COLORS as readonly string[]).includes(value)
  );
}

const mascotSlice = createSlice({
  name: 'mascot',
  initialState,
  reducers: {
    setMascotColor(state, action: PayloadAction<MascotColor>) {
      if (isMascotColor(action.payload)) {
        state.color = action.payload;
      }
    },
    /**
     * Select a backend mascot by id. Trimmed; empty / oversize / null
     * clears the override and falls back to the local YellowMascot.
     */
    setSelectedMascotId(state, action: PayloadAction<string | null>) {
      if (action.payload == null) {
        state.selectedMascotId = null;
        return;
      }
      if (isMascotVoiceId(action.payload)) {
        state.selectedMascotId = action.payload.trim();
      } else {
        state.selectedMascotId = null;
      }
    },
    /**
     * Set or clear the user-selected mascot voice id. Whitespace is
     * trimmed; empty / oversize / non-string values clear the override
     * (falling back to the build-time default voice). Pass `null` from
     * the UI's Reset button to explicitly drop the override.
     */
    setMascotVoiceId(state, action: PayloadAction<string | null>) {
      if (action.payload == null) {
        state.voiceId = null;
        return;
      }
      if (isMascotVoiceId(action.payload)) {
        state.voiceId = action.payload.trim();
      } else {
        // Invalid input is treated as a reset rather than left in place
        // — a half-typed or junk-pasted value would otherwise silently
        // poison the TTS path on the next reply.
        state.voiceId = null;
      }
    },
    setMascotVoiceGender(state, action: PayloadAction<MascotVoiceGender>) {
      if (isMascotVoiceGender(action.payload)) {
        state.voiceGender = action.payload;
      }
    },
    setMascotVoiceUseLocaleDefault(state, action: PayloadAction<boolean>) {
      state.voiceUseLocaleDefault = Boolean(action.payload);
    },
    /**
     * Switch the Human page mic composer between push-to-talk and
     * continuous conversation modes. Unknown values are scrubbed back
     * to the safe default so corrupted persisted blobs cannot poison
     * the composer branch select.
     */
    setVoiceMode(state, action: PayloadAction<VoiceMode>) {
      state.voiceMode = isVoiceMode(action.payload) ? action.payload : DEFAULT_VOICE_MODE;
    },
  },
  extraReducers: builder => {
    builder.addCase(resetUserScopedState, () => initialState);
    // Guard against unknown/missing values surviving a rehydrate (e.g.
    // a future build removed a variant that was previously persisted).
    builder.addCase(REHYDRATE, (state, action) => {
      const rehydrateAction = action as {
        type: typeof REHYDRATE;
        key: string;
        payload?: {
          color?: unknown;
          voiceId?: unknown;
          voiceGender?: unknown;
          voiceUseLocaleDefault?: unknown;
          selectedMascotId?: unknown;
          voiceMode?: unknown;
        };
      };
      if (rehydrateAction.key !== 'mascot') return;
      const restoredColor = rehydrateAction.payload?.color;
      state.color = isMascotColor(restoredColor) ? restoredColor : DEFAULT_MASCOT_COLOR;
      const restoredSelectedMascotId = rehydrateAction.payload?.selectedMascotId;
      state.selectedMascotId =
        restoredSelectedMascotId == null
          ? null
          : isMascotVoiceId(restoredSelectedMascotId)
            ? (restoredSelectedMascotId as string).trim()
            : null;
      // `voiceId` is optional in older persisted blobs (pre-#1762) — the
      // `null` fallback is the intended default and matches a fresh
      // install. Invalid values are scrubbed so a corrupted localStorage
      // blob can never make it into the TTS payload.
      const restoredVoiceId = rehydrateAction.payload?.voiceId;
      state.voiceId =
        restoredVoiceId == null
          ? null
          : isMascotVoiceId(restoredVoiceId)
            ? (restoredVoiceId as string).trim()
            : null;
      const restoredGender = rehydrateAction.payload?.voiceGender;
      state.voiceGender = isMascotVoiceGender(restoredGender)
        ? restoredGender
        : DEFAULT_MASCOT_VOICE_GENDER;
      state.voiceUseLocaleDefault =
        typeof rehydrateAction.payload?.voiceUseLocaleDefault === 'boolean'
          ? rehydrateAction.payload.voiceUseLocaleDefault
          : false;
      // Scrub unknown voice modes back to the push-to-talk default so a
      // future build that drops the `auto` variant cannot leave the
      // composer in an unselectable state on rehydrate.
      const restoredVoiceMode = rehydrateAction.payload?.voiceMode;
      state.voiceMode = isVoiceMode(restoredVoiceMode) ? restoredVoiceMode : DEFAULT_VOICE_MODE;
    });
  },
});

export const {
  setMascotColor,
  setMascotVoiceId,
  setMascotVoiceGender,
  setMascotVoiceUseLocaleDefault,
  setSelectedMascotId,
  setVoiceMode,
} = mascotSlice.actions;

export const selectMascotColor = (state: { mascot: MascotState }): MascotColor =>
  state.mascot.color;

export const selectMascotVoiceId = (state: { mascot: MascotState }): string | null =>
  state.mascot.voiceId;

export const selectMascotVoiceGender = (state: { mascot: MascotState }): MascotVoiceGender =>
  state.mascot.voiceGender;

export const selectMascotVoiceUseLocaleDefault = (state: { mascot: MascotState }): boolean =>
  state.mascot.voiceUseLocaleDefault;

export const selectSelectedMascotId = (state: { mascot: MascotState }): string | null =>
  state.mascot.selectedMascotId;

export const selectVoiceMode = (state: { mascot: MascotState }): VoiceMode =>
  state.mascot.voiceMode;

/**
 * Resolve the voice id the next reply will be synthesised with, taking
 * into account every mascot-voice setting plus the active locale. This
 * is the single source of truth read by both UI ("what does the picker
 * show as current?") and the TTS hook ("what voice should I pass to
 * synthesizeSpeech?"), so they can never drift.
 *
 * Resolution order:
 *   1. `voiceUseLocaleDefault` on → locale-default for `voiceGender`.
 *   2. Manual `voiceId` set → that id.
 *   3. Otherwise → `MASCOT_VOICE_ID` (the build-time default).
 *
 * The first branch deliberately wins over a manual override so the
 * "speak in my UI language" toggle behaves predictably — flipping it on
 * without first clearing a stale override would otherwise silently do
 * nothing. The UI in `MascotPanel` makes this precedence visible by
 * disabling the manual picker while the toggle is on.
 */
export const selectEffectiveMascotVoiceId = (state: {
  mascot: MascotState;
  locale?: { current: Locale };
}): string => {
  if (state.mascot.voiceUseLocaleDefault) {
    // `locale` slice may be absent in narrow test harnesses (e.g.
    // MascotPanel.test wires only the mascot reducer). Default to `en`
    // so the resolver still produces a usable id rather than throwing.
    const current = state.locale?.current ?? 'en';
    return defaultVoiceIdForLocale(current, state.mascot.voiceGender);
  }
  if (state.mascot.voiceId) return state.mascot.voiceId;
  // Belt-and-braces: if the build-time default ever drops out of the
  // curated preset list, fall back to the first preset rather than a
  // bogus empty string.
  return MASCOT_VOICE_ID || ELEVENLABS_VOICE_PRESETS[0].id;
};

export { mascotSlice };
export default mascotSlice.reducer;
