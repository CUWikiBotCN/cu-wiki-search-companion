// SPDX-License-Identifier: MPL-2.0
export interface WikiUrlContext {
  location: { origin: string };
  mw?: {
    util?: {
      getUrl(title: string): string;
      escapeIdForLink?(fragment: string): string;
    };
  };
}

export function pageUrl(
  context: WikiUrlContext,
  title: string,
  fragment?: string,
): string {
  const path =
    context.mw?.util?.getUrl(title) ??
    `/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const url = new URL(path, context.location.origin);
  if (fragment) {
    const escaped =
      context.mw?.util?.escapeIdForLink?.(fragment) ??
      encodeURIComponent(fragment.replace(/ /g, '_'));
    url.hash = escaped;
  }
  return url.href;
}
