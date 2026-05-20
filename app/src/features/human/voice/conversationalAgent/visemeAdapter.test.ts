import { describe, expect, it } from 'vitest';
import { OCULUS_VISEME_BY_ID, tryAdaptVisemeFrame } from './visemeAdapter';

describe('OCULUS_VISEME_BY_ID', () => {
  it('contains 15 codes (Oculus 0..14)', () => {
    expect(OCULUS_VISEME_BY_ID).toHaveLength(15);
  });

  it('starts at silence and covers the full Oculus set', () => {
    expect(OCULUS_VISEME_BY_ID[0]).toBe('sil');
    expect(OCULUS_VISEME_BY_ID).toEqual([
      'sil',
      'PP',
      'FF',
      'TH',
      'DD',
      'kk',
      'CH',
      'SS',
      'nn',
      'RR',
      'aa',
      'E',
      'I',
      'O',
      'U',
    ]);
  });
});

describe('tryAdaptVisemeFrame', () => {
  it('returns null for empty / undefined input', () => {
    expect(tryAdaptVisemeFrame({})).toBeNull();
    // @ts-expect-error — guarding null at runtime
    expect(tryAdaptVisemeFrame(null)).toBeNull();
  });

  it.each([0, 1, 7, 14])('maps numeric id %i to the canonical Oculus string', (id) => {
    const frame = tryAdaptVisemeFrame({ id, timestampMs: 1000 });
    expect(frame).not.toBeNull();
    expect(frame!.viseme).toBe(OCULUS_VISEME_BY_ID[id]);
    expect(frame!.start_ms).toBe(1000);
    expect(frame!.end_ms).toBe(1080); // default 80ms hold
  });

  it.each([-1, 15, 99, 3.5])('returns null for out-of-range / non-integer numeric id (%s)', (id) => {
    expect(tryAdaptVisemeFrame({ id })).toBeNull();
  });

  it('accepts a known string code', () => {
    const frame = tryAdaptVisemeFrame({ id: 'PP', timestampMs: 200 });
    expect(frame).not.toBeNull();
    expect(frame!.viseme).toBe('PP');
  });

  it('returns null for unknown string code', () => {
    expect(tryAdaptVisemeFrame({ id: 'XX' })).toBeNull();
  });

  it('honors custom durationMs (clamped to >=1)', () => {
    const frame = tryAdaptVisemeFrame({ id: 5, timestampMs: 0, durationMs: 250 });
    expect(frame!.end_ms - frame!.start_ms).toBe(250);

    const tiny = tryAdaptVisemeFrame({ id: 5, durationMs: 0 });
    expect(tiny!.end_ms - tiny!.start_ms).toBe(1);
  });

  it('clamps negative timestamps to zero', () => {
    const frame = tryAdaptVisemeFrame({ id: 0, timestampMs: -500 });
    expect(frame!.start_ms).toBe(0);
  });
});
