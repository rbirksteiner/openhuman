import type { VisemeFrame } from '../ttsClient';

/**
 * ElevenLabs Conversational SDK (`@elevenlabs/client@0.7.x`) does NOT emit
 * Oculus viseme frames. Audio arrives as base64 PCM via `onAudio`; no
 * per-frame phoneme metadata. For lipsync the mascot needs visemes, so this
 * adapter is the seam where we'll wire up an alternative source later
 * (likely: derive visemes from audio energy + `onModeChange` transitions,
 * or wait for the SDK to add a viseme event).
 *
 * For Phase 3 the adapter exposes:
 *   - `OCULUS_VISEME_BY_ID` — the canonical Oculus-15 string code for each
 *     integer ID, so future code that DOES receive numeric viseme indices
 *     (from a v3+ SDK or from a derived analyzer) can map straight to the
 *     existing `VisemeFrame.viseme` string contract used by `useHumanMascot`.
 *   - `tryAdaptVisemeFrame` — best-effort: returns `null` when input isn't
 *     a recognized shape. Phase 4/6 may replace the body with a real
 *     analyzer; the surface stays stable.
 */

/**
 * Oculus / Microsoft 15-viseme set, indexed 0..14.
 *
 * Matches the string codes already produced by the Rust core's TTS pipeline
 * (`src/openhuman/voice/reply_speech.rs`) and consumed by
 * `app/src/features/human/voice/visemeMap.ts`.
 */
export const OCULUS_VISEME_BY_ID: readonly string[] = [
  'sil', // 0  silence
  'PP', // 1  p, b, m
  'FF', // 2  f, v
  'TH', // 3  th
  'DD', // 4  t, d, n, l
  'kk', // 5  k, g
  'CH', // 6  tS, dZ, S
  'SS', // 7  s, z
  'nn', // 8  N
  'RR', // 9  r
  'aa', // 10 A
  'E', // 11  e
  'I', // 12  i
  'O', // 13  o
  'U', // 14 u
] as const;

/** Any input shape we might encounter from the SDK or a derived source. */
export interface MaybeVisemeInput {
  /** Either an integer 0..14, or one of the Oculus string codes above. */
  id?: number | string;
  /** Optional weight, defaults to 1.0. */
  weight?: number;
  /** Milliseconds from session start. */
  timestampMs?: number;
  /** Duration the frame should hold for, defaults to 80ms (12.5 fps). */
  durationMs?: number;
}

/**
 * Best-effort: return a `VisemeFrame` if the input is interpretable.
 *
 * Returns `null` when:
 *   - `id` is missing or out of range (numeric < 0 / > 14)
 *   - `id` is a string but not in `OCULUS_VISEME_BY_ID`
 *
 * Callers (`sessionManager`) should treat `null` as "no viseme this tick"
 * and leave the mascot's mouth in its current pose.
 */
export function tryAdaptVisemeFrame(input: MaybeVisemeInput): VisemeFrame | null {
  if (input == null || input.id == null) return null;

  let visemeCode: string | null = null;
  if (typeof input.id === 'number') {
    if (!Number.isInteger(input.id) || input.id < 0 || input.id >= OCULUS_VISEME_BY_ID.length) {
      return null;
    }
    visemeCode = OCULUS_VISEME_BY_ID[input.id] ?? null;
  } else if (typeof input.id === 'string') {
    visemeCode = OCULUS_VISEME_BY_ID.includes(input.id) ? input.id : null;
  }
  if (visemeCode === null) return null;

  const startMs = Math.max(0, Math.trunc(input.timestampMs ?? 0));
  const durationMs = Math.max(1, Math.trunc(input.durationMs ?? 80));
  return {
    viseme: visemeCode,
    start_ms: startMs,
    end_ms: startMs + durationMs,
  };
}
