// SPDX-License-Identifier: MPL-2.0
import {
  DEFAULT_HIGHLIGHT_PREFERENCES,
  HIGHLIGHT_PREFERENCE_KEY,
  highlightPreference,
  parseHighlightPreferences,
} from '../../src/storage/highlight-preference';

describe('highlightPreference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns defaults when GM storage is unavailable', async () => {
    vi.stubGlobal('GM_getValue', undefined);

    await expect(highlightPreference.get()).resolves.toEqual({
      ...DEFAULT_HIGHLIGHT_PREFERENCES,
    });
  });

  it('reads persisted preferences and merges them over defaults', async () => {
    vi.stubGlobal(
      'GM_getValue',
      vi.fn(() =>
        JSON.stringify({ titleEnabled: true, titleColor: '#123ABC' }),
      ),
    );

    await expect(highlightPreference.get()).resolves.toEqual({
      titleEnabled: true,
      contentEnabled: DEFAULT_HIGHLIGHT_PREFERENCES.contentEnabled,
      titleColor: '#123abc',
      contentColor: DEFAULT_HIGHLIGHT_PREFERENCES.contentColor,
    });
  });

  it('falls back per field when persisted values are invalid', async () => {
    vi.stubGlobal(
      'GM_getValue',
      vi.fn(() =>
        JSON.stringify({
          titleEnabled: 'yes',
          contentEnabled: false,
          titleColor: 'red',
          contentColor: '#00ff00',
        }),
      ),
    );

    await expect(highlightPreference.get()).resolves.toEqual({
      titleEnabled: DEFAULT_HIGHLIGHT_PREFERENCES.titleEnabled,
      contentEnabled: false,
      titleColor: DEFAULT_HIGHLIGHT_PREFERENCES.titleColor,
      contentColor: '#00ff00',
    });
  });

  it('falls back to defaults for malformed payloads', async () => {
    vi.stubGlobal('GM_getValue', vi.fn(() => '{not json'));
    await expect(highlightPreference.get()).resolves.toEqual({
      ...DEFAULT_HIGHLIGHT_PREFERENCES,
    });

    vi.stubGlobal('GM_getValue', vi.fn(() => 42));
    await expect(highlightPreference.get()).resolves.toEqual({
      ...DEFAULT_HIGHLIGHT_PREFERENCES,
    });
  });

  it('persists preferences as JSON under the preference key', async () => {
    const setValue = vi.fn();
    vi.stubGlobal('GM_setValue', setValue);

    await highlightPreference.set({
      titleEnabled: true,
      contentEnabled: false,
      titleColor: '#aee2ff',
      contentColor: '#fff3a3',
    });

    expect(setValue).toHaveBeenCalledWith(
      HIGHLIGHT_PREFERENCE_KEY,
      JSON.stringify({
        titleEnabled: true,
        contentEnabled: false,
        titleColor: '#aee2ff',
        contentColor: '#fff3a3',
      }),
    );
  });

  it('silently skips persisting when GM storage is unavailable', async () => {
    vi.stubGlobal('GM_setValue', undefined);

    await expect(
      highlightPreference.set({ ...DEFAULT_HIGHLIGHT_PREFERENCES }),
    ).resolves.toBeUndefined();
  });

  it('treats non-object parsed payloads as defaults', () => {
    expect(parseHighlightPreferences(JSON.stringify(['nope']))).toEqual({
      ...DEFAULT_HIGHLIGHT_PREFERENCES,
    });
    expect(parseHighlightPreferences(JSON.stringify(null))).toEqual({
      ...DEFAULT_HIGHLIGHT_PREFERENCES,
    });
  });
});
