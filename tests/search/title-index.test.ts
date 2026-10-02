// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { cut, cut_for_search } from 'jieba-wasm/node';

import { Analyzer } from '../../src/analyzer/analyzer';
import { TitleIndex } from '../../src/search/title-index';
import {
  readActivePageHeaders,
  readPageHeadersAfter,
  WikiSearchDatabase,
} from '../../src/storage/database';
import type { PageRecord } from '../../src/types';

const analyzer = new Analyzer({ cut, cutForSearch: cut_for_search });

function page(id: number, title: string, namespace = 0): PageRecord {
  return {
    id,
    title,
    normalizedTitle: analyzer.normalize(title),
    namespace,
    namespaceName: namespace === 0 ? '（主）' : '模块',
    isRedirect: false,
    localSeq: id,
    seenInTitleSync: 1,
  };
}

describe('TitleIndex', () => {
  it('ranks exact and infix CJK matches', () => {
    const index = new TitleIndex(analyzer);
    index.rebuild([page(1, '12号鹿弹'), page(2, '12号霰弹弹盒'), page(3, '鹿弹')]);

    expect(index.search('鹿弹').slice(0, 2).map(({ title }) => title)).toEqual([
      '鹿弹',
      '12号鹿弹',
    ]);
  });

  it('supports traditional queries and latin mid-run queries', () => {
    const index = new TitleIndex(analyzer);
    index.rebuild([page(1, '医用级兴奋剂'), page(2, '模块:Popups', 828)]);

    expect(index.search('醫用級興奮劑')[0]?.title).toBe('医用级兴奋剂');
    expect(index.search('opu')[0]?.title).toBe('模块:Popups');
  });

  it('filters namespaces and replaces changed documents', () => {
    const index = new TitleIndex(analyzer);
    index.rebuild([page(1, '测试页面'), page(2, '模块:测试', 828)]);
    expect(index.search('测试', 828).map(({ id }) => id)).toEqual([2]);

    index.update([page(1, '重命名页面')]);
    expect(index.search('重命名')[0]?.id).toBe(1);
    expect(index.search('测试').map(({ id }) => id)).not.toContain(1);
  });

  it('normalizes each broad-match candidate once while still normalizing every query', () => {
    const tracedAnalyzer = new Analyzer({ cut, cutForSearch: cut_for_search });
    const compact = vi.spyOn(tracedAnalyzer, 'compact');
    const normalize = vi.spyOn(tracedAnalyzer, 'normalize');
    const index = new TitleIndex(tracedAnalyzer);
    const candidates = Array.from({ length: 2_000 }, (_, offset) =>
      page(offset + 1, `缓存候选 ${offset + 1}`),
    );
    index.rebuild(candidates);
    compact.mockClear();
    normalize.mockClear();

    const cold = index.search('缓存', undefined, candidates.length);

    expect(cold).toHaveLength(candidates.length);
    expect(compact).toHaveBeenCalledTimes(candidates.length + 1);
    expect(
      normalize.mock.calls.filter(([value]) => value.startsWith('缓存候选 ')),
    ).toHaveLength(candidates.length);
    compact.mockClear();
    normalize.mockClear();

    expect(index.search('缓存', undefined, candidates.length)).toEqual(cold);
    expect(compact).toHaveBeenCalledExactlyOnceWith('缓存');
    expect(normalize.mock.calls.length).toBeGreaterThan(0);
    expect(
      normalize.mock.calls.filter(([value]) => value.startsWith('缓存候选 ')),
    ).toEqual([]);
  });

  it('computes cached boosts from raw titles instead of legacy normalizedTitle values', async () => {
    const index = new TitleIndex(analyzer);
    index.rebuild([
      { ...page(1, '醫療'), normalizedTitle: 'unrelated legacy value' },
      { ...page(2, '醫療指南'), normalizedTitle: '医疗' },
      page(3, '模块:Ｐｏｐｕｐｓ', 828),
    ]);

    const cold = index.search('医疗');

    expect(cold.map(({ id }) => id)).toEqual([1, 2]);
    expect(index.search('医疗')).toEqual(cold);
    expect(index.search('POPU', 828)[0]?.id).toBe(3);
    expect(index.search('POPU', 828)).toEqual(index.search('ＰＯＰＵ', 828));
    const restored = new TitleIndex(analyzer);
    await restored.importSnapshot(index.exportSnapshot());
    expect(restored.search('医疗')).toEqual(cold);
    expect(restored.search('POPU', 828)).toEqual(index.search('POPU', 828));
  });

  it('invalidates only changed candidates and removes tombstoned candidates', () => {
    const tracedAnalyzer = new Analyzer({ cut, cutForSearch: cut_for_search });
    const compact = vi.spyOn(tracedAnalyzer, 'compact');
    const index = new TitleIndex(tracedAnalyzer);
    const unchanged = page(1, '缓存候选 保留');
    const renamed = page(2, '缓存候选 改名');
    const initial = [
      unchanged,
      page(2, '缓存候选 旧名'),
      page(3, '缓存候选 删除'),
    ];
    const updates = [renamed, { ...page(3, '缓存候选 删除'), deleted: true }];
    index.rebuild(initial);
    index.search('缓存');

    index.update(updates);
    compact.mockClear();
    const refreshed = index.search('缓存');

    expect(compact.mock.calls).toEqual([['缓存'], [renamed.title]]);
    expect(refreshed.map(({ id }) => id)).not.toContain(3);
    // MiniSearch prunes discarded postings during queries; compare the same
    // incremental query history so its existing score changes stay identical.
    const uncached = new TitleIndex(analyzer);
    uncached.rebuild(initial);
    uncached.update(updates);
    expect(refreshed).toEqual(uncached.search('缓存'));
    compact.mockClear();
    expect(index.search('缓存')).toEqual(uncached.search('缓存'));
    expect(compact).toHaveBeenCalledExactlyOnceWith('缓存');
  });

  it.each(['synchronous', 'asynchronous', 'snapshot'] as const)(
    'starts with an empty candidate cache after a %s replacement',
    async (replacement) => {
      const tracedAnalyzer = new Analyzer({ cut, cutForSearch: cut_for_search });
      const compact = vi.spyOn(tracedAnalyzer, 'compact');
      const index = new TitleIndex(tracedAnalyzer, { yield: async () => undefined });
      const titles = [page(1, '缓存候选 甲'), page(2, '缓存候选 乙')];
      index.rebuild(titles);
      const snapshot = index.exportSnapshot();
      const expected = index.search('缓存');
      expect(index.exportSnapshot()).toEqual(snapshot);
      expect(Object.keys(snapshot as object)).toEqual(['miniSearch']);

      if (replacement === 'synchronous') index.rebuild(titles);
      else if (replacement === 'asynchronous') await index.rebuildAsync(titles, 1);
      else await index.importSnapshot(snapshot);
      compact.mockClear();

      expect(index.search('缓存')).toEqual(expected);
      expect(compact).toHaveBeenCalledTimes(titles.length + 1);
      compact.mockClear();
      expect(index.search('缓存')).toEqual(expected);
      expect(compact).toHaveBeenCalledExactlyOnceWith('缓存');
    },
  );

  it('replays cache invalidation for updates during a yielding rebuild', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const tracedAnalyzer = new Analyzer({ cut, cutForSearch: cut_for_search });
    const compact = vi.spyOn(tracedAnalyzer, 'compact');
    const index = new TitleIndex(tracedAnalyzer, { yield: () => blocked });
    const initial = [page(1, '缓存候选 旧名'), page(2, '缓存候选 待删除')];
    index.rebuild(initial);
    index.search('缓存');

    const rebuilding = index.rebuildAsync(initial, 2);
    const renamed = page(1, '缓存候选 最新');
    index.update([renamed, { ...initial[1]!, deleted: true }]);
    const expected = index.search('缓存');
    release();
    await rebuilding;
    compact.mockClear();

    expect(index.search('缓存')).toEqual(expected);
    expect(compact.mock.calls).toEqual([['缓存'], [renamed.title]]);
    compact.mockClear();
    expect(index.search('缓存')).toEqual(expected);
    expect(compact).toHaveBeenCalledExactlyOnceWith('缓存');
  });

  it('uses page id as a stable tie-breaker regardless of index insertion order', () => {
    const forward = new TitleIndex(analyzer);
    const reverse = new TitleIndex(analyzer);
    const tiedPages = [page(1, '测试甲'), page(2, '测试乙')];
    forward.rebuild(tiedPages);
    reverse.rebuild([...tiedPages].reverse());

    expect(forward.search('测试').map(({ id }) => id)).toEqual([1, 2]);
    expect(reverse.search('测试').map(({ id }) => id)).toEqual([1, 2]);
  });

  it('finds a single CJK character inside a multi-character title', () => {
    const index = new TitleIndex(analyzer);
    index.rebuild([page(1, '紧急治疗指南')]);

    expect(index.search('治')[0]?.id).toBe(1);
  });

  it('does not broadly recall two-character CJK typos from one shared character', () => {
    const index = new TitleIndex(analyzer);
    index.rebuild([
      page(1, '治疗指南'),
      page(2, '治疗方案'),
      page(3, '治安手册'),
      page(4, '化疗说明'),
    ]);

    expect(index.search('治错')).toEqual([]);
  });

  it('preserves an update that arrives while an async rebuild is yielding', async () => {
    const index = new TitleIndex(analyzer);
    index.rebuild([page(1, '现有页面'), page(2, '第二页旧标题')]);

    const rebuilding = index.rebuildAsync(
      [page(1, '现有页面'), page(2, '第二页旧标题')],
      1,
    );
    index.update([page(2, '第二页最新标题')]);

    await expect(rebuilding).resolves.toBeUndefined();
    expect(index.search('最新标题')[0]?.id).toBe(2);
    expect(index.search('旧').map(({ id }) => id)).not.toContain(2);
  });

  it('uses the cooperative scheduler between title rebuild batches', async () => {
    const scheduler = { yield: vi.fn(async () => undefined) };
    const index = new TitleIndex(analyzer, scheduler);

    await index.rebuildAsync([page(1, '一'), page(2, '二'), page(3, '三')], 2);

    expect(scheduler.yield).toHaveBeenCalledTimes(2);
  });

  it('streams lean page headers for cold-start title search without retaining content', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.bulkPut([
      { ...page(1, '带正文页面'), content: '很长的正文', contentModel: 'wikitext' },
      { ...page(2, '已删除页面'), content: '删除页正文', deleted: true },
    ]);

    const headers = await readActivePageHeaders(database);

    expect(headers).toEqual([
      expect.objectContaining({ id: 1, title: '带正文页面', localSeq: 1 }),
    ]);
    expect(headers[0]).not.toHaveProperty('content');
    expect(headers[0]).not.toHaveProperty('contentModel');
    expect(headers[0]).not.toHaveProperty('revisionId');

    database.close();
    await database.delete();
  });

  it('streams lean changed title headers while preserving tombstones', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.bulkPut([
      { ...page(1, '未变化'), content: '旧正文', localSeq: 1 },
      { ...page(2, '已更新'), content: '新正文', localSeq: 2 },
      { ...page(3, '已删除'), content: '删除页正文', localSeq: 3, deleted: true },
    ]);

    const headers = await readPageHeadersAfter(database, 1);

    expect(headers.map(({ id }) => id)).toEqual([2, 3]);
    expect(headers[1]).toMatchObject({ id: 3, deleted: true, localSeq: 3 });
    expect(headers.every((header) => !('content' in header))).toBe(true);

    database.close();
    await database.delete();
  });
});
