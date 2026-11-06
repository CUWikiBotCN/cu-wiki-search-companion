// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';
import { WikiSearchDatabase } from '../../src/storage/database';
import { syncContent } from '../../src/sync/content-sync';
import { WikiApi } from '../../src/sync/wiki-api';
import type { PageRecord } from '../../src/types';

function page(id: number, model = 'wikitext'): PageRecord {
  return {
    id,
    title: `页面 ${id}`,
    normalizedTitle: `页面 ${id}`,
    namespace: 0,
    namespaceName: '',
    isRedirect: false,
    localSeq: id,
    revisionId: 10,
    contentModel: model,
  };
}

describe('page-scoped content synchronization', () => {
  it('only prepares selected eligible jobs and installs the newest revision', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.bulkPut([page(1), page(2), page(3, 'css')]);
    const otherJobs = [
      {
        type: 'wikitext-content',
        pageId: 2,
        status: 'failed' as const,
        error: 'keep',
        targetRevisionId: 1,
        updatedAt: 123,
      },
      {
        type: 'wikitext-content',
        pageId: 3,
        status: 'running' as const,
        targetRevisionId: 1,
        updatedAt: 123,
      },
      {
        type: 'wikitext-content',
        pageId: 99,
        status: 'pending' as const,
        updatedAt: 123,
      },
    ];
    await database.jobs.bulkAdd(otherJobs);
    const before = await database.jobs.toArray();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(
        new URL(String(input), 'https://example.test').searchParams.get(
          'pageids',
        ),
      ).toBe('1');
      return new Response(
        JSON.stringify({
          query: {
            pages: [
              {
                pageid: 1,
                revisions: [
                  {
                    revid: 12,
                    slots: {
                      main: { contentmodel: 'wikitext', content: '新正文' },
                    },
                  },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });
    const result = await syncContent(database, api, {
      pageIds: [1, 3],
      requestIntervalMs: 0,
    });

    expect(result).toEqual({ total: 1, done: 1, pending: 0, failed: 0 });
    expect(await database.pages.get(1)).toMatchObject({
      revisionId: 12,
      contentRevisionId: 12,
      content: '新正文',
    });
    expect(
      (await database.jobs.toArray()).filter((job) => job.pageId !== 1),
    ).toEqual(before);
    expect(fetcher).toHaveBeenCalledOnce();
    database.close();
    await database.delete();
  });

  it('rejects a stale response for the selected page without changing another job', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.bulkPut([page(1), page(2)]);
    const id = await database.jobs.add({
      type: 'wikitext-content',
      pageId: 2,
      status: 'failed',
      error: 'keep',
      updatedAt: 123,
    });
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            query: {
              pages: [
                {
                  pageid: 1,
                  revisions: [
                    { revid: 9, slots: { main: { content: '旧正文' } } },
                  ],
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    );
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await expect(
      syncContent(database, api, { pageIds: [1], requestIntervalMs: 0 }),
    ).rejects.toThrow('正文响应版本落后');
    expect(await database.pages.get(1)).toMatchObject({ revisionId: 10 });
    expect((await database.pages.get(1))?.content).toBeUndefined();
    expect(await database.jobs.get(id)).toMatchObject({
      status: 'failed',
      error: 'keep',
      updatedAt: 123,
    });
    expect(
      await database.jobs.filter((job) => job.pageId === 1).first(),
    ).toMatchObject({ status: 'pending' });
    database.close();
    await database.delete();
  });
});

it('publishes revision-only source freshness changes so section indexes can replay them', async () => {
  const { Analyzer, createBootstrapSegmenter } =
    await import('../../src/analyzer/analyzer');
  const { SectionTitleIndex } =
    await import('../../src/search/section-title-index');
  const database = new WikiSearchDatabase(
    `section-freshness-${crypto.randomUUID()}`,
  );
  await database.open();
  try {
    await database.pages.put({
      ...page(1),
      content: '== 获取 ==',
      contentRevisionId: 9,
    });
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const index = new SectionTitleIndex(
      new Analyzer(createBootstrapSegmenter()),
    );
    await index.refresh(database);
    expect(index.coverage().covered).toBe(0);
    const api = new WikiApi({
      retries: 0,
      fetcher: async () =>
        new Response(
          JSON.stringify({
            query: {
              pages: [
                {
                  pageid: 1,
                  revisions: [
                    {
                      revid: 10,
                      slots: {
                        main: {
                          contentmodel: 'wikitext',
                          content: '== 获取 ==',
                        },
                      },
                    },
                  ],
                },
              ],
            },
          }),
        ),
    });
    await syncContent(database, api, { pageIds: [1], requestIntervalMs: 0 });
    expect((await database.pages.get(1))?.localSeq).toBe(2);
    await index.refresh(database);
    expect(index.coverage().covered).toBe(1);
    expect(index.search('页面#获取')).toHaveLength(1);
  } finally {
    database.close();
    await database.delete();
  }
});
