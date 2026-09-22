// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';
import { CssSourceIndex } from '../../src/search/css-source-index';
import { WikiSearchDatabase } from '../../src/storage/database';
import { syncContent } from '../../src/sync/content-sync';
import { WikiApi } from '../../src/sync/wiki-api';
import type { PageRecord } from '../../src/types';

let database: WikiSearchDatabase;
beforeEach(async () => { database = new WikiSearchDatabase(`css-${crypto.randomUUID()}`); await database.open(); });
afterEach(async () => { database.close(); await database.delete(); });
function page(id: number, model: string, content?: string): PageRecord {
  return { id, title: `样式${id}`, normalizedTitle: `样式${id}`, namespace: 8, namespaceName: 'MediaWiki',
    isRedirect: false, localSeq: id, revisionId: id, contentRevisionId: content === undefined ? undefined : id, contentModel: model, content };
}
function index(): CssSourceIndex { return new CssSourceIndex({ yield: async () => undefined }); }

it('finds literal CSS across models with CRLF line numbers, comments, punctuation and bounded snippets', async () => {
  await database.pages.bulkPut([
    page(1, 'css', '/* .My-class */\r\n#item { --Color: 1; }\r\n.My-class:hover {\r\n color: var(--Color);\r\n}'),
    page(2, 'sanitized-css', '.My-class ' + 'x'.repeat(1000)),
    page(3, 'wikitext', '.My-class'), page(4, 'javascript', '.My-class'),
  ]);
  const css = index(); await css.refresh(database);
  const matches = css.search('.My-class');
  expect(matches.map((row) => row.id)).toEqual([1, 2]);
  expect(matches[0]?.matches.map((hit) => hit.line)).toEqual([1, 3]);
  expect(css.search('.my-class')).toEqual([]);
  expect(css.search('#item')[0]?.matches[0]?.line).toBe(2);
  expect(css.search('--Color')).toHaveLength(1);
  expect(matches[1]?.matches[0]?.text.length).toBeLessThanOrEqual(240);
  expect(css.search(' ')).toEqual([]);
  expect(css.size).toBe(2);
  expect(await database.indexSnapshots.count()).toBe(0);
});

it('replays renames, stale revisions, tombstones and model changes even after other indexes advanced', async () => {
  await database.pages.bulkPut([page(1, 'css', '.one {}'), page(2, 'css', '.two {}')]);
  const css = index(); await css.refresh(database);
  await database.pages.update(1, { title: '新名称', content: '.new {}', revisionId: 3, contentRevisionId: 3, localSeq: 3 });
  await database.pages.update(2, { contentModel: 'wikitext', localSeq: 4 });
  await css.refresh(database);
  expect(css.search('.one')).toEqual([]);
  expect(css.search('.two')).toEqual([]);
  expect(css.search('.new')[0]?.title).toBe('新名称');
  await database.pages.update(1, { revisionId: 4, localSeq: 5 });
  await css.refresh(database);
  expect(css.search('.new')).toEqual([]);
  await database.pages.update(1, { contentRevisionId: 4, localSeq: 6 });
  await css.refresh(database);
  expect(css.size).toBe(1);
  await database.pages.update(1, { deleted: true, localSeq: 7 });
  await css.refresh(database);
  expect(css.size).toBe(0);
});

it('keeps literal CSS escapes and Unicode intact and limits pages and hits deterministically', async () => {
  await database.pages.bulkPut(Array.from({ length: 22 }, (_, i) => page(i + 1, 'css', '.a\\:b {}\n.Ａ {}\n.繁體 {}\n.x {} .x {} .x {} .x {}')));
  const css = index(); await css.refresh(database);
  expect(css.search('.a\\:b')).toHaveLength(20);
  expect(css.search('.a:b')).toEqual([]);
  expect(css.search('.A')).toEqual([]);
  expect(css.search('.繁体')).toEqual([]);
  expect(css.search('.x')[0]?.matches).toHaveLength(3);
  const fresh = index(); await fresh.refresh(database);
  expect(css.search('.x')).toEqual(fresh.search('.x'));
});

it('downloads CSS and existing content separately, including a forced retry and cached restart', async () => {
  await database.pages.bulkPut([page(1, 'css'), page(2, 'sanitized-css'), page(3, 'wikitext'), page(4, 'Scribunto')]);
  const requests: number[][] = [];
  let fail = true;
  const api = new WikiApi({ retries: 0, fetcher: async (input) => {
    const ids = new URL(String(input), 'https://example.org').searchParams.get('pageids')!.split('|').map(Number);
    requests.push(ids);
    if (fail) throw new Error('offline');
    return new Response(JSON.stringify({ query: { pages: ids.map((id) => ({ pageid: id,
      revisions: [{ revid: id, slots: { main: { contentmodel: id === 1 ? 'css' : id === 2 ? 'sanitized-css' : id === 3 ? 'wikitext' : 'Scribunto', content: '.example {}' } } }],
    })) } }));
  } });
  await expect(syncContent(database, api, { scope: 'css', requestIntervalMs: 0 })).rejects.toThrow('offline');
  expect(await database.jobs.where('status').equals('running').count()).toBe(0);
  fail = false;
  await expect(syncContent(database, api, { scope: 'css', requestIntervalMs: 0 })).resolves.toEqual({ total: 2, done: 2, pending: 0, failed: 0 });
  expect((await database.pages.get(3))?.content).toBeUndefined();
  await syncContent(database, api, { requestIntervalMs: 0 });
  await syncContent(database, api, { scope: 'css', force: true, requestIntervalMs: 0 });
  await syncContent(database, api, { scope: 'css', requestIntervalMs: 0 });
  await syncContent(database, api, { requestIntervalMs: 0 });
  expect(requests).toEqual([[1, 2], [1, 2], [3, 4], [1, 2]]);
});
