// SPDX-License-Identifier: MPL-2.0
import type { PageRecord, RedirectResolution } from './types';

/** Never expose an address resolved for a different source revision or title. */
export function currentRedirectResolution(page: PageRecord): RedirectResolution | undefined {
  const resolution = page.redirectResolution;
  return page.isRedirect && !page.deleted &&
    resolution?.sourceTitle === page.title &&
    resolution.sourceRevisionId === page.revisionId
    ? resolution : undefined;
}
