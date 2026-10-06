// SPDX-License-Identifier: MPL-2.0

export const HIGHLIGHT_PREFERENCE_KEY = 'search-highlight-preferences';

export interface HighlightPreferences {
  titleEnabled: boolean;
  contentEnabled: boolean;
  titleColor: string;
  contentColor: string;
}

export const DEFAULT_HIGHLIGHT_PREFERENCES: HighlightPreferences = {
  titleEnabled: false,
  contentEnabled: true,
  titleColor: '#aee2ff',
  contentColor: '#fff3a3',
};

export interface HighlightPreferenceStore {
  get(): Promise<HighlightPreferences>;
  set(value: HighlightPreferences): Promise<void>;
}

export const highlightPreference: HighlightPreferenceStore = {
  async get(): Promise<HighlightPreferences> {
    if (typeof GM_getValue !== 'function') {
      return { ...DEFAULT_HIGHLIGHT_PREFERENCES };
    }
    return parseHighlightPreferences(
      GM_getValue<unknown>(HIGHLIGHT_PREFERENCE_KEY),
    );
  },
  async set(value: HighlightPreferences): Promise<void> {
    if (typeof GM_setValue === 'function') {
      GM_setValue(HIGHLIGHT_PREFERENCE_KEY, JSON.stringify(value));
    }
  },
};

/** Merges persisted preferences over defaults; every invalid field falls back. */
export function parseHighlightPreferences(raw: unknown): HighlightPreferences {
  if (typeof raw !== 'string') return { ...DEFAULT_HIGHLIGHT_PREFERENCES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_HIGHLIGHT_PREFERENCES };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ...DEFAULT_HIGHLIGHT_PREFERENCES };
  }
  const record = parsed as Record<string, unknown>;
  return {
    titleEnabled:
      typeof record.titleEnabled === 'boolean'
        ? record.titleEnabled
        : DEFAULT_HIGHLIGHT_PREFERENCES.titleEnabled,
    contentEnabled:
      typeof record.contentEnabled === 'boolean'
        ? record.contentEnabled
        : DEFAULT_HIGHLIGHT_PREFERENCES.contentEnabled,
    titleColor:
      normalizeColor(record.titleColor) ??
      DEFAULT_HIGHLIGHT_PREFERENCES.titleColor,
    contentColor:
      normalizeColor(record.contentColor) ??
      DEFAULT_HIGHLIGHT_PREFERENCES.contentColor,
  };
}

function normalizeColor(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}
