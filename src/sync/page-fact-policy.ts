// SPDX-License-Identifier: MPL-2.0
import type { PageRecord } from '../types';

/** Searchable facts shared by title scans, RecentChanges, and reconciliation. */
export function searchablePageFactChanged(
  previous: PageRecord | undefined,
  next: PageRecord,
): boolean {
  if (!previous) return true;
  return (
    previous.title !== next.title ||
    previous.namespace !== next.namespace ||
    previous.namespaceName !== next.namespaceName ||
    previous.isRedirect !== next.isRedirect ||
    previous.deleted !== next.deleted ||
    previous.revisionId !== next.revisionId ||
    previous.contentModel !== next.contentModel ||
    previous.contentRevisionId !== next.contentRevisionId ||
    previous.content !== next.content
  );
}
