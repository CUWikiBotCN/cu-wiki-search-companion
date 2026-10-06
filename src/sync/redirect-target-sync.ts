// SPDX-License-Identifier: MPL-2.0
import { currentRedirectResolution } from '../redirect';
import type { WikiSearchDatabase } from '../storage/database';
import { LOCAL_SEQUENCE_KEY, readLocalSequence } from '../storage/sync-state';
import type { PageRecord, RedirectResolution, RedirectTarget } from '../types';
import { delay, type WikiApi } from './wiki-api';

interface RedirectResponse {
  query?: {
    normalized?: Array<{ from: string; to: string }>;
    redirects?: Array<{
      from: string;
      to: string;
      tofragment?: string;
      interwiki?: string;
    }>;
    interwiki?: Array<{ title: string }>;
    pages?: unknown[];
  };
}

export interface RedirectSyncOptions {
  /** Recheck rows not checked since the latest completed full scan. */
  refreshSince?: number;
  requestIntervalMs?: number;
  onBatch?(pages: PageRecord[]): void;
}

/** Called inside the existing writer lock; each network batch precedes its transaction. */
export async function syncRedirectTargets(
  database: WikiSearchDatabase,
  api: WikiApi,
  options: RedirectSyncOptions = {},
): Promise<void> {
  const pending: PageRecord[] = [];
  await database.pages.each((page) => {
    if (page.deleted || !page.isRedirect) return;
    const cached = currentRedirectResolution(page);
    if (!cached || cached.checkedAt < (options.refreshSince ?? 0)) {
      // Keep only the identity fence, never retain cached page bodies.
      pending.push({ ...page, content: undefined });
    }
  });
  for (let offset = 0; offset < pending.length; offset += 50) {
    const batch = pending.slice(offset, offset + 50);
    const response = await api.query<RedirectResponse>({
      titles: batch.map((page) => page.title).join('|'),
      redirects: 1,
    });
    const targets = parseRedirectTargets(
      response,
      batch.map((page) => page.title),
    );
    const checkedAt = Date.now();
    const changed = await database.transaction(
      'rw',
      database.pages,
      database.fileResources,
      database.syncState,
      async () => {
        let sequence = await readLocalSequence(database);
        const updated: PageRecord[] = [];
        for (const requested of batch) {
          const page = await database.pages.get(requested.id);
          if (
            !page ||
            page.deleted ||
            !page.isRedirect ||
            page.title !== requested.title ||
            page.revisionId !== requested.revisionId ||
            page.localSeq !== requested.localSeq
          )
            continue;
          const previous = currentRedirectResolution(page);
          const resolution: RedirectResolution = {
            sourceTitle: page.title,
            sourceRevisionId: page.revisionId,
            checkedAt,
            target: targets.get(page.title),
          };
          const factChanged =
            !previous ||
            previous.target?.title !== resolution.target?.title ||
            previous.target?.fragment !== resolution.target?.fragment;
          page.redirectResolution = resolution;
          if (factChanged) {
            page.localSeq = ++sequence;
            updated.push(page);
          }
          await database.pages.put(page);
        }
        if (updated.length)
          await database.syncState.put({
            key: LOCAL_SEQUENCE_KEY,
            value: sequence,
          });
        return updated;
      },
    );
    if (changed.length) options.onBatch?.(changed);
    if (offset + 50 < pending.length)
      await delay(options.requestIntervalMs ?? 300);
  }
}

export function parseRedirectTargets(
  response: RedirectResponse,
  titles: string[],
): Map<string, RedirectTarget | undefined> {
  const query = response?.query;
  if (
    !query ||
    typeof query !== 'object' ||
    (!Array.isArray(query.pages) &&
      !Array.isArray(query.redirects) &&
      !Array.isArray(query.interwiki))
  ) {
    throw new Error('重定向 API 响应缺少查询结果');
  }
  const normalized = new Map<string, string>();
  const redirects = new Map<string, RedirectTarget>();
  const external = new Set<string>();
  if (query.interwiki !== undefined && !Array.isArray(query.interwiki))
    throw new Error('站外重定向响应无效');
  for (const row of query.interwiki ?? []) {
    if (!row || typeof row.title !== 'string')
      throw new Error('站外重定向响应无效');
    external.add(row.title);
  }
  for (const [name, rows] of [
    ['normalized', query.normalized],
    ['redirects', query.redirects],
  ] as const) {
    if (rows !== undefined && !Array.isArray(rows))
      throw new Error('重定向映射格式无效');
    for (const row of rows ?? []) {
      if (
        !row ||
        typeof row.from !== 'string' ||
        !row.from ||
        typeof row.to !== 'string' ||
        !row.to
      ) {
        throw new Error('重定向映射缺少来源或目标');
      }
      if (name === 'normalized') normalized.set(row.from, row.to);
      else {
        const edge = row as NonNullable<
          NonNullable<RedirectResponse['query']>['redirects']
        >[number];
        if (
          edge.tofragment !== undefined &&
          typeof edge.tofragment !== 'string'
        )
          throw new Error('重定向章节格式无效');
        if (edge.interwiki || external.has(edge.to)) continue;
        redirects.set(edge.from, {
          title: edge.to,
          ...(edge.tofragment ? { fragment: edge.tofragment } : {}),
        });
      }
    }
  }
  return new Map(
    titles.map((title) => [
      title,
      redirects.get(normalized.get(title) ?? title),
    ]),
  );
}
