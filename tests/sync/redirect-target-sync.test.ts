// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';
import {
  Analyzer,
  createBootstrapSegmenter,
} from '../../src/analyzer/analyzer';
import { currentRedirectResolution } from '../../src/redirect';
import { pageUrl } from '../../src/page-url';
import {
  CombinedTitleIndex,
  LinearTitleIndex,
  TitleIndex,
} from '../../src/search/title-index';
import {
  WikiSearchDatabase,
  readActivePageHeaders,
} from '../../src/storage/database';
import {
  parseRedirectTargets,
  syncRedirectTargets,
} from '../../src/sync/redirect-target-sync';
import { WikiApi } from '../../src/sync/wiki-api';
import type { PageRecord } from '../../src/types';
import { abortTransactionAfterCallback } from '../helpers/transaction-abort';

let database: WikiSearchDatabase;
beforeEach(async () => {
  database = new WikiSearchDatabase(`redirect-${crypto.randomUUID()}`);
  await database.open();
});
afterEach(async () => {
  database.close();
  await database.delete();
});
function page(id = 1): PageRecord {
  return {
    id,
    title: `旧名${id}`,
    normalizedTitle: `旧名${id}`,
    namespace: 0,
    namespaceName: '（主）',
    isRedirect: true,
    revisionId: 1,
    localSeq: id,
  };
}
function apiWith(
  query: (parameters: URLSearchParams) => unknown | Promise<unknown>,
): WikiApi {
  return new WikiApi({
    retries: 0,
    fetcher: async (input) =>
      new Response(
        JSON.stringify(
          await query(
            new URL(String(input), 'https://example.org').searchParams,
          ),
        ),
        { headers: { 'Content-Type': 'application/json' } },
      ),
  });
}
function resolvingApi(): WikiApi {
  return apiWith((params) => ({
    query: {
      redirects: params
        .get('titles')!
        .split('|')
        .map((title) => ({ from: title, to: '感染', tofragment: '败血症' })),
    },
  }));
}

it('reads the direct edge, normalized names, cycles and missing/external targets without following pages', () => {
  const result = parseRedirectTargets(
    {
      query: {
        normalized: [{ from: 'a', to: 'A' }],
        redirects: [
          { from: 'A', to: 'B', tofragment: '章节 # 1' },
          { from: 'B', to: 'C' },
          { from: 'C', to: 'A' },
          { from: '外部', to: 'w:Target' },
        ],
        interwiki: [{ title: 'w:Target' }],
        pages: [{ title: 'C' }],
      },
    },
    ['a', 'B', 'C', '未知', '外部'],
  );
  expect(result.get('a')).toEqual({ title: 'B', fragment: '章节 # 1' });
  expect(result.get('B')).toEqual({ title: 'C' });
  expect(result.get('C')).toEqual({ title: 'A' });
  expect(result.get('未知')).toBeUndefined();
  expect(result.get('外部')).toBeUndefined();
  expect(() => parseRedirectTargets({}, ['A'])).toThrow();
});

it('commits at most 50 titles per request, resumes only uncommitted batches and retains source identity', async () => {
  await database.pages.bulkPut(
    Array.from({ length: 51 }, (_, i) => page(i + 1)),
  );
  await database.syncState.put({ key: 'local-sequence', value: 51 });
  const calls: string[][] = [];
  const failing = apiWith((params) => {
    expect(params.get('redirects')).toBe('1');
    const titles = params.get('titles')!.split('|');
    calls.push(titles);
    if (calls.length === 2) throw new Error('offline');
    return {
      query: { redirects: titles.map((from) => ({ from, to: '目标' })) },
    };
  });
  const onBatch = vi.fn();
  await expect(
    syncRedirectTargets(database, failing, { requestIntervalMs: 0, onBatch }),
  ).rejects.toThrow('offline');
  expect(calls.map((batch) => batch.length)).toEqual([50, 1]);
  expect(onBatch).toHaveBeenCalledOnce();
  expect((await database.pages.get(1))?.title).toBe('旧名1');
  expect((await database.pages.get(51))?.redirectResolution).toBeUndefined();
  const resumed = vi.fn((params: URLSearchParams) => {
    expect(params.get('titles')).toBe('旧名51');
    return { query: { redirects: [{ from: '旧名51', to: '目标' }] } };
  });
  await syncRedirectTargets(database, apiWith(resumed));
  await syncRedirectTargets(database, apiWith(resumed));
  expect(resumed).toHaveBeenCalledOnce();
  expect((await database.syncState.get('local-sequence'))?.value).toBe(102);
});

it('rejects late replies after a rename, revision change or deletion', async () => {
  for (const change of [
    { title: '新名' },
    { revisionId: 2 },
    { deleted: true },
  ]) {
    await database.pages.put(page());
    const api = apiWith(async () => {
      await database.pages.update(1, change);
      return { query: { redirects: [{ from: '旧名1', to: '目标' }] } };
    });
    await syncRedirectTargets(database, api);
    expect((await database.pages.get(1))?.redirectResolution).toBeUndefined();
  }
});

it('does not publish metadata or sequence when its transaction aborts', async () => {
  await database.pages.put(page());
  abortTransactionAfterCallback(database);
  const onBatch = vi.fn();
  await expect(
    syncRedirectTargets(database, resolvingApi(), { onBatch }),
  ).rejects.toBeDefined();
  expect(onBatch).not.toHaveBeenCalled();
  expect((await database.pages.get(1))?.redirectResolution).toBeUndefined();
  expect(await database.syncState.get('local-sequence')).toBeUndefined();
  await syncRedirectTargets(database, resolvingApi());
  expect((await database.pages.get(1))?.redirectResolution?.target?.title).toBe(
    '感染',
  );
});

it('rechecks full-scan generations without allocating sequences for unchanged addresses', async () => {
  await database.pages.put(page());
  await syncRedirectTargets(database, resolvingApi());
  const before = (await database.pages.get(1))!;
  await syncRedirectTargets(database, resolvingApi(), {
    refreshSince: Date.now() + 1,
  });
  expect((await database.pages.get(1))?.localSeq).toBe(before.localSeq);
  expect(
    currentRedirectResolution({ ...before, revisionId: 2 }),
  ).toBeUndefined();
  expect(
    currentRedirectResolution({ ...before, isRedirect: false }),
  ).toBeUndefined();
  await syncRedirectTargets(
    database,
    apiWith(() => ({ query: { pages: [] } })),
    { refreshSince: Date.now() + 1 },
  );
  expect(
    (await database.pages.get(1))?.redirectResolution?.target,
  ).toBeUndefined();
  expect((await database.pages.get(1))?.localSeq).toBeGreaterThan(
    before.localSeq,
  );
});

it('keeps redirect metadata in bootstrap, combined search and restored title snapshots', async () => {
  await database.pages.put(page());
  await syncRedirectTargets(database, resolvingApi());
  const headers = await readActivePageHeaders(database);
  const analyzer = new Analyzer(createBootstrapSegmenter(), 'bootstrap');
  const linear = new LinearTitleIndex(analyzer, headers);
  const primary = new TitleIndex(analyzer);
  primary.rebuild(headers);
  const restored = new TitleIndex(analyzer);
  await restored.importSnapshot(
    JSON.parse(JSON.stringify(primary.exportSnapshot())),
  );
  for (const backend of [
    linear,
    primary,
    restored,
    new CombinedTitleIndex(restored, linear),
  ]) {
    expect(backend.search('旧名1')[0]).toMatchObject({
      title: '旧名1',
      isRedirect: true,
      redirectResolved: true,
      redirectTarget: { title: '感染', fragment: '败血症' },
    });
  }
});

it('encodes the page and fragment separately with and without MediaWiki URL utilities', () => {
  const context = { location: { origin: 'https://example.org' } };
  const url = new URL(pageUrl(context, '页面 % &', '中文 空格#100%'));
  expect(decodeURIComponent(url.pathname)).toBe('/wiki/页面_%_&');
  expect(decodeURIComponent(url.hash.slice(1))).toBe('中文_空格#100%');
  expect(url.href).not.toContain('%2525');
  const escape = vi.fn(() => 'legacy.anchor');
  expect(
    pageUrl(
      {
        ...context,
        mw: {
          util: {
            getUrl: () => '/w/index.php?title=X',
            escapeIdForLink: escape,
          },
        },
      },
      'X',
      '标题',
    ),
  ).toBe('https://example.org/w/index.php?title=X#legacy.anchor');
  expect(escape).toHaveBeenCalledWith('标题');
});
