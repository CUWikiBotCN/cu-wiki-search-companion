// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { cut, cut_for_search } from 'jieba-wasm/node';

import { Analyzer } from '../../src/analyzer/analyzer';
import { extractContent } from '../../src/content/extract-content';
import { extractWikitext } from '../../src/content/extract-wikitext';
import { ContentIndex } from '../../src/search/content-index';
import { WikiSearchDatabase } from '../../src/storage/database';
import { prepareContentJobs, syncContent } from '../../src/sync/content-sync';
import { WikiApi } from '../../src/sync/wiki-api';
import type { JobRecord, PageRecord } from '../../src/types';

const analyzer = new Analyzer({ cut, cutForSearch: cut_for_search });

describe('wikitext content search', () => {
  it('keeps visible links and language variants while removing hidden markup', () => {
    const extracted = extractWikitext(`
      <!-- 不应索引 -->
      == 医疗 ==
      [[医用级兴奋剂|强效兴奋剂]]用于-{zh-hans:急救;zh-hant:急救處置}-。
      {{物品信息框|代码=highgradestimulant}}
      <ref>隐藏来源文字</ref>
    `);

    expect(extracted).toContain('医用级兴奋剂 强效兴奋剂');
    expect(extracted).toContain('急救 急救處置');
    expect(extracted).toContain('highgradestimulant');
    expect(extracted).not.toContain('不应索引');
    expect(extracted).not.toContain('隐藏来源文字');
  });

  it('decodes supported entities exactly once while preserving unknown entities as text', () => {
    expect(
      extractWikitext(
        '&amp; &lt; &gt; &quot; &apos; &nbsp; &#20320;&#x597D; &copy;',
      ),
    ).toBe('& < > " \' 你好 &copy;');
    expect(extractWikitext('&amp;lt;')).toBe('&lt;');
  });

  it('keeps an entity-encoded tag as searchable text instead of treating it as markup', () => {
    expect(
      extractWikitext('&lt;script&gt;alert(&quot;encoded&quot;)&lt;/script&gt;'),
    ).toBe('<script>alert("encoded")</script>');
  });

  it('extracts deeply nested BSON without exhausting the JavaScript call stack', () => {
    const depth = 12_000;
    const source = `${'{"level":'.repeat(depth)}"deepMarker"${'}'.repeat(depth)}`;

    expect(extractContent('BSON', source)).toContain('deepMarker');
  });

  it('indexes extracted body text and returns a useful snippet', () => {
    const index = new ContentIndex(analyzer);
    index.rebuild([
      page(1, '医疗指导', '使用[[医用级兴奋剂]]可以进行紧急救治。'),
      page(2, '武器指导', '手枪使用九毫米子弹。'),
    ]);

    expect(index.search('紧急救治')[0]).toMatchObject({
      kind: 'content',
      title: '医疗指导',
      snippet: expect.stringContaining('紧急救治'),
    });
  });

  it('finds a single CJK character inside a multi-character body term', () => {
    const index = new ContentIndex(analyzer);
    index.rebuild([page(1, '医疗指导', '接受紧急治疗。')]);

    expect(index.search('治')[0]?.id).toBe(1);
  });

  it('preserves a content update that arrives while an async rebuild is yielding', async () => {
    const index = new ContentIndex(analyzer);
    const oldPages = [
      page(1, '第一页', '稳定正文'),
      page(2, '第二页', '已经过时的正文'),
    ];
    index.rebuild(oldPages);

    const rebuilding = index.rebuildAsync(oldPages, 1);
    index.update([page(2, '第二页', '并发写入的最新正文')]);

    await expect(rebuilding).resolves.toBeUndefined();
    expect(index.search('最新正文').map(({ id }) => id)).toContain(2);
    expect(index.search('过时').map(({ id }) => id)).not.toContain(2);
  });

  it('uses the cooperative scheduler between content rebuild batches', async () => {
    const scheduler = { yield: vi.fn(async () => undefined) };
    const index = new ContentIndex(analyzer, scheduler);

    await index.rebuildAsync(
      [page(1, '第一页', '正文一'), page(2, '第二页', '正文二')],
      1,
    );

    expect(scheduler.yield).toHaveBeenCalledTimes(2);
  });

  it('centers snippets on traditional and full-width query matches', () => {
    const index = new ContentIndex(analyzer);
    const distantPrefix = '无关前言'.repeat(30);
    index.rebuild([
      page(1, '繁简页面', `${distantPrefix}紧急救治发生在这里。`),
      page(2, '全角页面', `${distantPrefix}设备编号 ABC123 位于这里。`),
    ]);

    expect(index.search('緊急救治')[0]?.snippet).toContain('紧急救治');
    expect(index.search('ＡＢＣ１２３')[0]?.snippet).toContain('ABC123');
  });

  it('bounds snippet normalization by the result limit without changing ranking', () => {
    const measuredAnalyzer = new Analyzer({ cut, cutForSearch: cut_for_search });
    const index = new ContentIndex(measuredAnalyzer);
    const content = `${'背景說明'.repeat(40)}醫療指南`;
    index.rebuild([
      page(20, '医疗首选', content),
      ...Array.from({ length: 11 }, (_, offset) =>
        page(offset + 1, `其他页面 ${offset + 1}`, content),
      ),
    ]);
    const normalize = vi.spyOn(measuredAnalyzer, 'normalize');

    const first = index.search('医疗', undefined, 1);

    expect(first.map(({ id }) => id)).toEqual([20]);
    expect(normalize.mock.calls.filter(([value]) => value.length > 100)).toHaveLength(1);

    normalize.mockClear();
    const firstThree = index.search('医疗', undefined, 3);

    expect(firstThree.map(({ id }) => id)).toEqual([20, 1, 2]);
    expect(firstThree[0]!.score).toBeCloseTo(firstThree[1]!.score * 3);
    expect(firstThree[1]!.score).toBe(firstThree[2]!.score);
    expect(normalize.mock.calls.filter(([value]) => value.length > 100)).toHaveLength(2);

    normalize.mockClear();
    expect(index.search('医疗', undefined, 3)).toEqual(firstThree);
    expect(normalize.mock.calls.filter(([value]) => value.length > 100)).toHaveLength(0);
  });

  it('leaves original and case-insensitive snippet hits out of the normalization cache', () => {
    const measuredAnalyzer = new Analyzer({ cut, cutForSearch: cut_for_search });
    const index = new ContentIndex(measuredAnalyzer);
    const content = `${'背景說明'.repeat(40)}TARGET 医疗`;
    index.rebuild([page(1, '原文页面', content)]);
    const normalize = vi.spyOn(measuredAnalyzer, 'normalize');

    expect(index.search('target')[0]?.snippet).toContain('TARGET');
    expect(index.search('医疗')[0]?.snippet).toContain('医疗');
    expect(normalize.mock.calls.filter(([value]) => value.length > 100)).toHaveLength(0);

    index.search('target 医疗');
    expect(normalize.mock.calls.filter(([value]) => value.length > 100)).toHaveLength(0);
  });

  it.each([
    [`${'背景說明'.repeat(40)}醫療指南位於尾部`, '医疗', ['医疗']],
    [`${'ﬃ '.repeat(80)}ＴＡＲＧＥＴ 尾部`, 'target', ['target']],
    [`${'背景說明'.repeat(40)}ＡＬＰＨＡ 與 ＢＥＴＡ`, 'alpha beta', ['alpha', 'beta']],
    [`${'背景說明'.repeat(40)}醫療 與 急救`, '医疗急救', ['医疗', '急救']],
  ])('keeps cold and cached snippet result fields identical for %s', (content, query, hits) => {
    const measuredAnalyzer = new Analyzer({ cut, cutForSearch: cut_for_search });
    const index = new ContentIndex(measuredAnalyzer);
    index.rebuild([page(1, '缓存页面', content)]);
    const normalize = vi.spyOn(measuredAnalyzer, 'normalize');

    const cold = index.search(query);
    expect(cold).toHaveLength(1);
    expect(normalize.mock.calls.filter(([value]) => value.length > 100)).toHaveLength(1);
    expect(cold[0]!.highlights!.map(({ start, end }) => cold[0]!.snippet.slice(start, end)))
      .toEqual(expect.arrayContaining(hits));

    normalize.mockClear();
    expect(index.search(query)).toEqual(cold);
    expect(normalize.mock.calls.filter(([value]) => value.length > 100)).toHaveLength(0);
  });

  it('invalidates cached snippets on updates, deletion, and re-adding the same page id', () => {
    const measuredAnalyzer = new Analyzer({ cut, cutForSearch: cut_for_search });
    const index = new ContentIndex(measuredAnalyzer);
    const before = page(1, '更新页面', '醫療 oldMarker');
    index.rebuild([before]);
    expect(index.search('医疗')[0]?.snippet).toContain('oldmarker');

    const after = page(1, '新标题', '醫療 newMarker');
    index.update([after]);
    const expected = index.search('医疗')[0]!;
    expect(expected.snippet).toContain('newmarker');
    expect(expected.snippet).not.toContain('oldmarker');
    expect(expected.title).toBe('新标题');

    index.update([{ ...after, deleted: true }]);
    expect(index.search('医疗')).toEqual([]);
    index.update([page(1, '再次新增', '醫療 revivedMarker')]);
    expect(index.search('医疗')[0]?.snippet).toContain('revivedmarker');
  });

  it.each(['rebuild', 'rebuildAsync', 'importSnapshot'] as const)(
    'starts a fresh lazy cache after %s without persisting it in snapshots',
    async (operation) => {
      const measuredAnalyzer = new Analyzer({ cut, cutForSearch: cut_for_search });
      const index = new ContentIndex(measuredAnalyzer, { yield: async () => undefined });
      const pages = [page(1, '重新建立', '醫療 freshMarker')];
      index.rebuild(pages);
      const expected = index.search('医疗');
      const snapshot = index.exportSnapshot();
      expect(Object.keys(snapshot as object).sort()).toEqual(['extractedById', 'miniSearch']);

      if (operation === 'importSnapshot') await index.importSnapshot(snapshot);
      else await index[operation](pages);
      const normalize = vi.spyOn(measuredAnalyzer, 'normalize');

      expect(index.search('医疗')).toEqual(expected);
      expect(normalize.mock.calls.filter(([value]) => value === '醫療 freshMarker')).toHaveLength(1);
      expect(index.search('医疗')).toEqual(expected);
      expect(normalize.mock.calls.filter(([value]) => value === '醫療 freshMarker')).toHaveLength(1);
    },
  );

  it.each(['rebuildAsync', 'importSnapshot'] as const)(
    'replays updates during %s after the current cache has been populated',
    async (operation) => {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const index = new ContentIndex(analyzer, { yield: () => blocked });
      const oldPages = [page(1, '并发缓存', '醫療 oldMarker')];
      index.rebuild(oldPages);
      expect(index.search('医疗')[0]?.snippet).toContain('oldmarker');

      const replacing = operation === 'rebuildAsync'
        ? index.rebuildAsync(oldPages, 1)
        : index.importSnapshot(index.exportSnapshot());
      index.update([page(1, '并发缓存', '醫療 newMarker')]);
      expect(index.search('医疗')[0]?.snippet).toContain('newmarker');
      release();
      await replacing;

      const result = index.search('医疗')[0]!;
      expect(result.snippet).toContain('newmarker');
      expect(result.snippet).not.toContain('oldmarker');
    },
  );

  it('retains the old snapshot whitespace normalization before caching a snippet fallback', async () => {
    const index = new ContentIndex(analyzer);
    index.rebuild([page(1, '旧快照', 'ＴＡＲＧＥＴ tail')]);
    const snapshot = index.exportSnapshot() as { miniSearch: unknown; extractedById: Array<[number, string]> };
    snapshot.extractedById = [[1, ' \n\t ＴＡＲＧＥＴ\t tail \n ']];
    await index.importSnapshot(snapshot);

    const result = index.search('target')[0]!;
    expect(result.snippet).toBe('target tail');
    expect(result.highlights).toEqual([{ start: 0, end: 6 }]);
    expect(index.search('target')[0]).toEqual(result);
  });

  it('counts an empty normalized fallback as a cache hit', () => {
    const measuredAnalyzer = new Analyzer({ cut, cutForSearch: cut_for_search });
    vi.spyOn(measuredAnalyzer, 'documentTokens').mockReturnValue(['target']);
    const content = 'ＭＡＲＫＥＲ';
    const index = new ContentIndex(measuredAnalyzer);
    index.rebuild([page(1, '空归一结果', content)]);
    const originalNormalize = measuredAnalyzer.normalize.bind(measuredAnalyzer);
    const normalize = vi.spyOn(measuredAnalyzer, 'normalize').mockImplementation(
      (value) => value === content ? '' : originalNormalize(value),
    );

    const first = index.search('target')[0]!;
    expect(first.snippet).toBe(content);
    expect(first.highlights).toEqual([]);
    expect(index.search('target')[0]).toEqual(first);
    expect(normalize.mock.calls.filter(([value]) => value === content)).toHaveLength(1);
  });

  it('caps the cache at 128 entries and promotes a hit before evicting the oldest', () => {
    const measuredAnalyzer = new Analyzer({ cut, cutForSearch: cut_for_search });
    vi.spyOn(measuredAnalyzer, 'documentTokens').mockReturnValue(['target']);
    const index = new ContentIndex(measuredAnalyzer);
    index.rebuild(Array.from({ length: 129 }, (_, offset) => ({
      ...page(offset + 1, 'LRU页面', `ＴＡＲＧＥＴ entry${offset + 1}`),
      namespace: offset + 1,
    })));
    const normalize = vi.spyOn(measuredAnalyzer, 'normalize');
    const bodyCalls = () => normalize.mock.calls.filter(([value]) => value.startsWith('ＴＡＲＧＥＴ'));
    for (let id = 1; id <= 128; id += 1) index.search('target', id);
    expect(bodyCalls()).toHaveLength(128);

    index.search('target', 1);
    index.search('target', 129);
    index.search('target', 1);
    expect(bodyCalls()).toHaveLength(129);
    index.search('target', 2);
    expect(bodyCalls()).toHaveLength(130);
  });

  it('charges normalized UTF-16 text, evicts by 8 MiB, and frees a deleted page payload', () => {
    const measuredAnalyzer = new Analyzer({ cut, cutForSearch: cut_for_search });
    vi.spyOn(measuredAnalyzer, 'documentTokens').mockReturnValue(['target']);
    const normalize = vi.spyOn(measuredAnalyzer, 'normalize').mockImplementation(
      (value) => value.normalize('NFKC').toLowerCase(),
    );
    const halfBudget = 2 * 1024 * 1024;
    const content = normalizedPayload(halfBudget);
    const index = new ContentIndex(measuredAnalyzer);
    index.rebuild([
      { ...page(1, '载荷一', content), namespace: 1 },
      { ...page(2, '载荷二', content), namespace: 2 },
      { ...page(3, '小载荷', 'ＴＡＲＧＥＴ'), namespace: 3 },
    ]);
    normalize.mockClear();
    const bodyCalls = () => normalize.mock.calls.filter(([value]) => value.includes('ＴＡＲＧＥＴ'));

    index.search('target', 1);
    index.search('target', 2);
    index.search('target', 1);
    expect(bodyCalls()).toHaveLength(2);
    index.search('target', 3);
    index.search('target', 1);
    expect(bodyCalls()).toHaveLength(3);
    index.search('target', 2);
    expect(bodyCalls()).toHaveLength(4);

    index.update([{ ...page(1, '载荷一', content), deleted: true }]);
    index.update([{ ...page(4, '载荷四', content), namespace: 4 }]);
    index.search('target', 4);
    index.search('target', 2);
    expect(bodyCalls()).toHaveLength(5);

    index.update([{ ...page(2, '缩小载荷', 'ＴＡＲＧＥＴ'), namespace: 2 }]);
    index.search('target', 2);
    index.update([{ ...page(5, '载荷五', content), namespace: 5 }]);
    index.search('target', 5);
    index.search('target', 2);
    expect(bodyCalls()).toHaveLength(7);
  });

  it('returns oversized fallback snippets without caching them or evicting other entries', () => {
    const measuredAnalyzer = new Analyzer({ cut, cutForSearch: cut_for_search });
    vi.spyOn(measuredAnalyzer, 'documentTokens').mockReturnValue(['target']);
    const normalize = vi.spyOn(measuredAnalyzer, 'normalize').mockImplementation(
      (value) => value.normalize('NFKC').toLowerCase(),
    );
    const content = normalizedPayload(4 * 1024 * 1024 + 1);
    const index = new ContentIndex(measuredAnalyzer);
    index.rebuild([
      { ...page(1, '常驻载荷', 'ＴＡＲＧＥＴ cached'), namespace: 1 },
      { ...page(2, '超预算', content), namespace: 2 },
    ]);
    normalize.mockClear();
    index.search('target', 1);

    const oversized = index.search('target', 2)[0]!;
    expect(oversized.snippet.endsWith('target')).toBe(true);
    expect(oversized.snippet.slice(oversized.highlights![0]!.start, oversized.highlights![0]!.end)).toBe('target');
    expect(index.search('target', 2)[0]).toEqual(oversized);
    index.search('target', 1);
    expect(normalize.mock.calls.filter(([value]) => value === content)).toHaveLength(2);
    expect(normalize.mock.calls.filter(([value]) => value === 'ＴＡＲＧＥＴ cached')).toHaveLength(1);
  });

  it('keeps snippet offsets aligned when compatibility characters expand', () => {
    const index = new ContentIndex(analyzer);
    index.rebuild([page(1, '坐标页面', `${'ﬃ '.repeat(80)}TARGET 结尾`)]);

    const snippet = index.search('target')[0]?.snippet;

    expect(snippet).toContain('TARGET');
    expect(snippet?.replace(/…/g, '').trim()).not.toBe('');
  });

  it('shows normalized text when only normalization can locate the query', () => {
    const index = new ContentIndex(analyzer);
    index.rebuild([
      page(1, '归一化页面', `${'无关前言'.repeat(30)} ＴＡＲＧＥＴ 尾声`),
    ]);

    const snippet = index.search('target')[0]?.snippet;

    expect(snippet).toContain('target');
    expect(snippet).not.toContain('ＴＡＲＧＥＴ');
  });

  it('aligns highlight ranges with the snippet for direct matches', () => {
    const index = new ContentIndex(analyzer);
    index.rebuild([
      page(1, '医疗指导', `${'背景'.repeat(40)}使用紧急救治手段。`),
    ]);

    const result = index.search('紧急救治')[0]!;

    expect(result.highlights).toEqual([
      { start: result.snippet.indexOf('紧急救治'), end: result.snippet.indexOf('紧急救治') + 4 },
    ]);
    expect(result.snippet.slice(result.highlights![0]!.start, result.highlights![0]!.end)).toBe(
      '紧急救治',
    );
    expect(result.titleHighlights).toEqual([]);
  });

  it('highlights the original title when the whole query is locatable there', () => {
    const index = new ContentIndex(analyzer);
    index.rebuild([
      page(1, '紧急救治指南', '收录紧急救治流程。'),
      page(2, '紧急处置手册', '紧急救治需快速反应。'),
    ]);

    const results = index.search('紧急救治');
    const hit = results.find(({ title }) => title === '紧急救治指南')!;
    const miss = results.find(({ title }) => title === '紧急处置手册')!;

    expect(hit.titleHighlights).toEqual([{ start: 0, end: 4 }]);
    expect(hit.title.slice(hit.titleHighlights![0]!.start, hit.titleHighlights![0]!.end)).toBe(
      '紧急救治',
    );
    expect(miss.titleHighlights).toEqual([]);
  });

  it('keeps highlight ranges aligned for case, width, and variant insensitive matches', () => {
    const index = new ContentIndex(analyzer);
    const distantPrefix = '无关前言'.repeat(30);
    index.rebuild([
      page(1, '繁简页面', `${distantPrefix}紧急救治发生在这里。`),
      page(2, '全角页面', `${distantPrefix}设备编号 ABC123 位于这里。`),
    ]);

    const variant = index.search('緊急救治')[0]!;
    expect(variant.snippet.slice(variant.highlights![0]!.start, variant.highlights![0]!.end)).toBe(
      '紧急救治',
    );

    const fullwidth = index.search('ＡＢＣ１２３')[0]!;
    expect(fullwidth.snippet.slice(fullwidth.highlights![0]!.start, fullwidth.highlights![0]!.end)).toBe(
      'ABC123',
    );
  });

  it('highlights the normalized fallback text at the query position', () => {
    const index = new ContentIndex(analyzer);
    index.rebuild([
      page(1, '归一化页面', `${'无关前言'.repeat(30)} ＴＡＲＧＥＴ 尾声`),
    ]);

    const result = index.search('target')[0]!;

    const at = result.snippet.indexOf('target');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(result.highlights).toEqual([{ start: at, end: at + 'target'.length }]);
    expect(result.snippet.slice(result.highlights![0]!.start, result.highlights![0]!.end)).toBe(
      'target',
    );
  });

  it('falls back to per-term highlights when only the OR search matches', () => {
    const index = new ContentIndex(analyzer);
    index.rebuild([page(1, '武器指导', '手枪使用九毫米子弹。')]);

    const result = index.search('手枪子弹')[0]!;

    const slices = (result.highlights ?? []).map(({ start, end }) => result.snippet.slice(start, end));
    expect(slices).toContain('手枪');
    expect(slices).toContain('子弹');
    const sorted = [...(result.highlights ?? [])].sort((l, r) => l.start - r.start);
    expect(sorted.every((range, at) => at === 0 || range.start >= sorted[at - 1]!.end)).toBe(true);
    expect(sorted.every((range) => range.end <= result.snippet.length)).toBe(true);
  });

  it.each([
    [
      '中文',
      `${'无关前言'.repeat(30)}手枪使用九毫米子弹。`,
      '手枪子弹',
      ['手枪', '子弹'],
    ],
    [
      '英文',
      `${'irrelevant preface '.repeat(30)}alpha appears near beta.`,
      'alpha beta',
      ['alpha', 'beta'],
    ],
  ])('在%s长正文中以实际逐词命中定位摘要', (_label, content, query, expected) => {
    const index = new ContentIndex(analyzer);
    index.rebuild([page(1, '定位页面', content)]);

    const result = index.search(query)[0]!;
    const slices = result.highlights!.map(({ start, end }) =>
      result.snippet.slice(start, end),
    );

    expect(result.snippet.startsWith('…')).toBe(true);
    expect(expected.every((term) => slices.includes(term))).toBe(true);
  });

  it('不让窗口外的重复词耗尽可见命中额度', () => {
    const index = new ContentIndex(analyzer);
    index.rebuild([
      page(1, '重复词页面', `子弹在这里。${'背景'.repeat(35)}${'手 '.repeat(12)}`),
    ]);

    const result = index.search('手枪子弹')[0]!;
    const slices = result.highlights!.map(({ start, end }) =>
      result.snippet.slice(start, end),
    );

    expect(result.snippet.startsWith('子弹')).toBe(true);
    expect(slices).toContain('子弹');
  });

  it('先合并窗口内命中再限制六处并保持省略号坐标', () => {
    const index = new ContentIndex(analyzer);
    const combined = `${'手'.repeat(12)}子弹`;
    index.rebuild([
      page(
        1,
        '合并页面',
        `${'无关前言'.repeat(30)}${combined} ${'手 '.repeat(8)}收尾`,
      ),
    ]);

    const result = index.search('手枪子弹')[0]!;

    expect(result.snippet.startsWith('…')).toBe(true);
    expect(result.highlights).toHaveLength(6);
    expect(
      result.snippet.slice(result.highlights![0]!.start, result.highlights![0]!.end),
    ).toBe(combined);
    expect(
      result.highlights!.every(
        ({ start, end }) => result.snippet.slice(start, end).length > 0,
      ),
    ).toBe(true);
  });

  it('fetches wikitext and BSON in ordinary-user-sized batches and resumes from cache', async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      calls.push(url);
      const ids = (url.searchParams.get('pageids') ?? '').split('|').map(Number);
      return json({
        query: {
          pages: ids.map((id) => ({
            pageid: id,
            ns: 0,
            title: id === 1 ? '医疗指导' : '武器指导',
            revisions: [
              {
                revid: id * 10,
                slots: {
                  main: {
                    contentmodel: id === 3 ? 'BSON' : 'wikitext',
                    content:
                      id === 1
                        ? '紧急救治正文'
                        : id === 2
                          ? '手枪正文'
                          : '{"id":"pistol","description":"半自动手枪"}',
                  },
                },
              },
            ],
          })),
        },
      });
    });
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.bulkPut([
      page(1, '医疗指导', undefined, 10),
      page(2, '武器指导', undefined, 20),
      { ...page(3, 'Data:Item/pistol.json', undefined, 30), contentModel: 'BSON' },
      { ...page(4, '旧标题', undefined, 40), isRedirect: true },
      { ...page(5, 'MediaWiki:Common.css', undefined, 50), contentModel: 'css' },
    ]);
    await database.syncState.put({ key: 'local-sequence', value: 5 });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });
    const indexedBatches: number[][] = [];

    const first = await syncContent(database, api, {
      requestIntervalMs: 0,
      onBatch: (pages) => {
        indexedBatches.push(pages.map(({ id }) => id));
      },
    });
    const second = await syncContent(database, api, { requestIntervalMs: 0 });

    expect(first).toEqual({ total: 3, done: 3, pending: 0, failed: 0 });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.searchParams.get('pageids') ?? '').split('|')).toHaveLength(3);
    expect(calls[0]!.searchParams.get('rvprop')).toBe('ids|content');
    expect(calls[0]!.searchParams.has('rvlimit')).toBe(false);
    expect(indexedBatches).toEqual([[1, 2, 3]]);
    expect((await database.pages.get(1))?.content).toBe('紧急救治正文');
    expect((await database.pages.get(1))?.contentRevisionId).toBe(10);
    expect((await database.pages.get(1))?.localSeq).toBe(6);
    expect((await database.pages.get(2))?.localSeq).toBe(7);
    expect((await database.pages.get(3))?.localSeq).toBe(8);
    expect((await database.syncState.get('local-sequence'))?.value).toBe(8);
    expect((await database.pages.get(3))?.content).toContain('半自动手枪');
    expect(await database.jobs.count()).toBe(4);
    expect(await database.jobs.where('pageId').equals(5).first()).toMatchObject({ status: 'pending' });

    database.close();
    await database.delete();
  });

  it('does not advance the local sequence when a forced response repeats identical content', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '相同正文', '没有变化', 10));
    await database.syncState.put({ key: 'local-sequence', value: 4 });
    const api = new WikiApi({
      fetcher: vi.fn(async () =>
        json({
          query: {
            pages: [
              {
                pageid: 1,
                revisions: [
                  {
                    revid: 10,
                    slots: { main: { contentmodel: 'wikitext', content: '没有变化' } },
                  },
                ],
              },
            ],
          },
        }),
      ) as typeof fetch,
      retries: 0,
    });

    await syncContent(database, api, { force: true, requestIntervalMs: 0 });

    expect((await database.pages.get(1))?.localSeq).toBe(1);
    expect((await database.syncState.get('local-sequence'))?.value).toBe(4);

    database.close();
    await database.delete();
  });

  it('recovers a missing sequence from page and file writer facts inside the content commit', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put({
      ...page(1, '旧库正文页', undefined, 10),
      localSeq: 7,
    });
    await database.fileResources.put({
      ...page(6_001, '文件:旧库资源.png', undefined, 60),
      namespace: 6,
      namespaceName: '文件',
      localSeq: 600,
      writerSeq: 9,
    });
    const api = new WikiApi({
      retries: 0,
      fetcher: vi.fn(async () =>
        json({
          query: {
            pages: [
              {
                pageid: 1,
                revisions: [
                  {
                    revid: 10,
                    slots: { main: { contentmodel: 'wikitext', content: '恢复后正文' } },
                  },
                ],
              },
            ],
          },
        }),
      ) as typeof fetch,
    });

    await syncContent(database, api, { requestIntervalMs: 0 });

    expect(await database.pages.get(1)).toMatchObject({
      content: '恢复后正文',
      localSeq: 10,
    });
    expect((await database.syncState.get('local-sequence'))?.value).toBe(10);

    database.close();
    await database.delete();
  });

  it('streams a large queue repair and leaves equivalent jobs untouched', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const pages = Array.from({ length: 240 }, (_, offset) =>
      page(
        offset + 1,
        `已缓存页面 ${offset + 1}`,
        `不应被整表保留的正文 ${offset + 1} ${'内容'.repeat(100)}`,
        (offset + 1) * 10,
      ),
    );
    await database.pages.bulkPut(pages);
    await database.jobs.bulkPut(
      pages.map(({ id, revisionId }) => ({
        type: 'wikitext-content',
        pageId: id,
        status: 'done' as const,
        targetRevisionId: revisionId,
        updatedAt: 123,
      })),
    );
    const pagesToArray = vi.spyOn(database.pages, 'toArray');
    const jobsWhere = vi.spyOn(database.jobs, 'where');
    const jobsBulkPut = vi.spyOn(database.jobs, 'bulkPut');

    await expect(prepareContentJobs(database, false)).resolves.toBeUndefined();

    expect(pagesToArray).not.toHaveBeenCalled();
    expect(jobsWhere).toHaveBeenCalledWith('type');
    expect(jobsBulkPut).not.toHaveBeenCalled();
    expect((await database.jobs.get(1))?.updatedAt).toBe(123);

    database.close();
    await database.delete();
  });

  it('reads pages once and performs no network work when 100 scoped jobs are already done', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const pages = Array.from({ length: 100 }, (_, offset) =>
      page(offset + 1, `缓存页面 ${offset + 1}`, `已缓存正文 ${offset + 1}`),
    );
    await database.pages.bulkPut(pages);
    await prepareContentJobs(database, false);
    const pageReads = vi.fn((value: PageRecord) => value);
    database.pages.hook('reading', pageReads);
    const pagesEach = vi.spyOn(database.pages, 'each');
    const fetcher = vi.fn(async () => { throw new Error('已完成队列不能发出请求'); });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const result = await syncContent(database, api, { requestIntervalMs: 0 });

    expect(result).toEqual({ total: 100, done: 100, pending: 0, failed: 0 });
    expect(pagesEach).toHaveBeenCalledTimes(1);
    expect(pageReads).toHaveBeenCalledTimes(100);
    expect(fetcher).not.toHaveBeenCalled();

    database.close();
    await database.delete();
  });

  it.each(['content', 'css'] as const)(
    'reuses the %s scope scan, keeps other eligible jobs, and removes all stale jobs',
    async (scope) => {
      const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
      await database.open();
      const models = ['wikitext', 'BSON', 'Scribunto', 'css', 'sanitized-css'];
      const pages = models.map((contentModel, offset) => ({
        ...page(offset + 1, `范围页面 ${offset + 1}`, `缓存正文 ${offset + 1}`),
        contentModel,
      }));
      await database.pages.bulkPut([
        ...pages,
        { ...page(6, '不可检索', '旧正文'), contentModel: 'JavaScript' },
        { ...page(7, '已删除', '旧正文'), deleted: true },
      ]);
      await database.syncState.put({ key: 'local-sequence', value: 7 });
      await database.jobs.bulkPut(Array.from({ length: 8 }, (_, offset) => ({
        type: 'wikitext-content',
        pageId: offset + 1,
        status: 'running' as const,
        targetRevisionId: 10,
      })));
      const pagesEach = vi.spyOn(database.pages, 'each');
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://example.test');
        const ids = (url.searchParams.get('pageids') ?? '').split('|').map(Number);
        return json({
          query: { pages: ids.map((id) => ({
            pageid: id,
            revisions: [{ revid: id * 10, slots: { main: {
              contentmodel: models[id - 1], content: `缓存正文 ${id}`,
            } } }],
          })) },
        });
      });
      const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });
      const onProgress = vi.fn();

      const result = await syncContent(database, api, {
        scope, force: true, requestIntervalMs: 0, onProgress,
      });

      const expectedIds = scope === 'css' ? [4, 5] : [1, 2, 3];
      expect(result).toEqual({ total: expectedIds.length, done: expectedIds.length, pending: 0, failed: 0 });
      expect(pagesEach).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      const request = new URL(String(fetcher.mock.calls[0]![0]), 'https://example.test');
      expect(request.searchParams.get('pageids')!.split('|').map(Number)).toEqual(expectedIds);
      expect(onProgress.mock.calls[0]![0]).toEqual({ total: expectedIds.length, done: 0, pending: expectedIds.length, failed: 0 });
      expect((await database.jobs.toArray()).map(({ pageId, status }) => [pageId, status]))
        .toEqual(pages.map(({ id }) => [id, 'done']));

      database.close();
      await database.delete();
    },
  );

  it('rolls back both content and sequence when their commit fails', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '原子写入', undefined, 10));
    await database.syncState.put({ key: 'local-sequence', value: 3 });
    await prepareContentJobs(database, false);
    const originalPut = database.syncState.put.bind(database.syncState);
    vi.spyOn(database.syncState, 'put').mockImplementation((record) => {
      if (record.key === 'local-sequence') throw new Error('模拟序列写入失败');
      return originalPut(record);
    });
    const api = new WikiApi({
      fetcher: vi.fn(async () =>
        json({
          query: {
            pages: [
              {
                pageid: 1,
                revisions: [
                  {
                    revid: 10,
                    slots: { main: { contentmodel: 'wikitext', content: '新正文' } },
                  },
                ],
              },
            ],
          },
        }),
      ) as typeof fetch,
      retries: 0,
    });

    await expect(syncContent(database, api, { requestIntervalMs: 0 })).rejects.toThrow(
      '模拟序列写入失败',
    );

    expect(await database.pages.get(1)).toMatchObject({
      content: undefined,
      contentRevisionId: undefined,
      localSeq: 1,
    });
    expect((await database.syncState.get('local-sequence'))?.value).toBe(3);

    database.close();
    await database.delete();
  });

  it('does not overwrite a newer revision job created while jobs are being prepared', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '准备竞态', '旧正文', 10));
    const writerDatabase = new WikiSearchDatabase(database.name);
    await writerDatabase.open();
    const jobId = await database.jobs.add({
      type: 'wikitext-content',
      pageId: 1,
      status: 'done',
      targetRevisionId: 10,
    });
    const originalEach = database.pages.each.bind(database.pages);
    let concurrentWrite: Promise<void> | undefined;
    vi.spyOn(database.pages, 'each').mockImplementation(
      (async (callback: Parameters<typeof originalEach>[0]) => {
        await originalEach(callback);
        if (!concurrentWrite) {
          concurrentWrite = writerDatabase.transaction(
            'rw',
            writerDatabase.pages,
            writerDatabase.jobs,
            async () => {
              await writerDatabase.pages.update(1, { revisionId: 20 });
              await writerDatabase.jobs.put({
                id: jobId,
                type: 'wikitext-content',
                pageId: 1,
                status: 'pending',
                targetRevisionId: 20,
              });
            },
          );
        }
      }) as never,
    );

    await prepareContentJobs(database, false);
    await concurrentWrite;

    expect(await database.pages.get(1)).toMatchObject({ revisionId: 20 });
    expect(await database.jobs.get(jobId)).toMatchObject({
      status: 'pending',
      targetRevisionId: 20,
    });

    writerDatabase.close();
    database.close();
    await database.delete();
  });

  it('removes jobs when a page no longer has a searchable content model', async () => {
    const calls: number[][] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      const ids = (url.searchParams.get('pageids') ?? '').split('|').map(Number);
      calls.push(ids);
      return json({
        query: {
          pages: ids.map((id) => ({
            pageid: id,
            revisions: [
              {
                revid: id * 10,
                slots: { main: { contentmodel: 'wikitext', content: `正文 ${id}` } },
              },
            ],
          })),
        },
      });
    });
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.bulkPut([
      page(1, '保留页面', undefined, 10),
      { ...page(2, 'Data:Item/removed.json', undefined, 20), contentModel: 'BSON' },
    ]);
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await syncContent(database, api, { requestIntervalMs: 0 });
    await database.pages.update(2, { contentModel: 'css' });
    const afterModelChange = await syncContent(database, api, { requestIntervalMs: 0 });

    expect(afterModelChange).toEqual({ total: 1, done: 1, pending: 0, failed: 0 });
    expect(calls).toEqual([[1, 2]]);

    database.close();
    await database.delete();
  });

  it('resumes at the remaining batch after a later request fails', async () => {
    const calls: number[][] = [];
    let failSecondBatch = true;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      const ids = (url.searchParams.get('pageids') ?? '').split('|').map(Number);
      calls.push(ids);
      if (ids[0] === 51 && failSecondBatch) {
        failSecondBatch = false;
        throw new Error('模拟第二批网络中断');
      }
      return json({
        query: {
          pages: ids.map((id) => ({
            pageid: id,
            revisions: [
              {
                revid: id * 10,
                slots: { main: { contentmodel: 'wikitext', content: `正文 ${id}` } },
              },
            ],
          })),
        },
      });
    });
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.bulkPut(
      Array.from({ length: 51 }, (_, offset) =>
        page(offset + 1, `测试页面 ${offset + 1}`, undefined, (offset + 1) * 10),
      ),
    );
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await expect(syncContent(database, api, { requestIntervalMs: 0 })).rejects.toThrow(
      '模拟第二批网络中断',
    );
    const resumed = await syncContent(database, api, { requestIntervalMs: 0 });

    expect(calls.map((ids) => [ids[0], ids.at(-1), ids.length])).toEqual([
      [1, 50, 50],
      [51, 51, 1],
      [51, 51, 1],
    ]);
    expect(resumed).toEqual({ total: 51, done: 51, pending: 0, failed: 0 });

    database.close();
    await database.delete();
  });

  it.each([500, 2_000, 10_000])(
    'keeps repeated prepare database work linear for %i unchanged jobs',
    async (pageCount) => {
      const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
      await database.open();
      const pages = Array.from({ length: pageCount }, (_, offset) =>
        page(offset + 1, `P${offset + 1}`, '已有正文'),
      );
      await database.pages.bulkAdd(pages);
      await database.jobs.bulkAdd(
        pages.map(({ id, revisionId }, offset) => ({
          id,
          type: 'wikitext-content',
          pageId: id,
          status: 'done' as const,
          targetRevisionId: revisionId,
          updatedAt: offset + 1,
        })),
      );
      await prepareContentJobs(database, false);

      const pageReads = vi.fn((record: PageRecord) => record);
      const jobReads = vi.fn((record: JobRecord) => record);
      database.pages.hook('reading', pageReads);
      database.jobs.hook('reading', jobReads);
      const pagesEach = vi.spyOn(database.pages, 'each');
      const jobsWhere = vi.spyOn(database.jobs, 'where');
      const jobsBulkPut = vi.spyOn(database.jobs, 'bulkPut');
      const jobsBulkDelete = vi.spyOn(database.jobs, 'bulkDelete');

      await prepareContentJobs(database, false);

      expect(pageReads).toHaveBeenCalledTimes(pageCount);
      expect(jobReads).toHaveBeenCalledTimes(pageCount);
      expect(pagesEach).toHaveBeenCalledTimes(1);
      expect(jobsWhere).toHaveBeenCalledTimes(1);
      expect(jobsBulkPut).not.toHaveBeenCalled();
      expect(jobsBulkDelete).not.toHaveBeenCalled();
      expect((await database.jobs.get(pageCount))?.updatedAt).toBe(pageCount);

      database.close();
      await database.delete();
    },
  );

  it('advances large-sync progress from batch transitions with linear job writes', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const pages = Array.from({ length: 120 }, (_, offset) =>
      page(offset + 1, `进度页面 ${offset + 1}`, undefined, (offset + 1) * 10),
    );
    await database.pages.bulkPut(pages);
    await prepareContentJobs(database, false);
    const jobsWhere = vi.spyOn(database.jobs, 'where');
    const jobsBulkPut = vi.spyOn(database.jobs, 'bulkPut');
    const onProgress = vi.fn();
    const api = new WikiApi({
      retries: 0,
      fetcher: vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://example.test');
        const ids = (url.searchParams.get('pageids') ?? '').split('|').map(Number);
        return json({
          query: {
            pages: ids.map((id) => ({
              pageid: id,
              revisions: [
                {
                  revid: id * 10,
                  slots: {
                    main: { contentmodel: 'wikitext', content: `批次正文 ${id}` },
                  },
                },
              ],
            })),
          },
        });
      }) as typeof fetch,
    });

    const result = await syncContent(database, api, {
      requestIntervalMs: 0,
      onProgress,
    });

    expect(result).toEqual({ total: 120, done: 120, pending: 0, failed: 0 });
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { total: 120, done: 0, pending: 120, failed: 0 },
      { total: 120, done: 50, pending: 70, failed: 0 },
      { total: 120, done: 100, pending: 20, failed: 0 },
      { total: 120, done: 120, pending: 0, failed: 0 },
      { total: 120, done: 120, pending: 0, failed: 0 },
    ]);
    expect(
      jobsWhere.mock.calls.filter(([index]) => String(index) === 'type'),
    ).toHaveLength(2);
    expect(jobsBulkPut).toHaveBeenCalledTimes(6);
    expect(
      jobsBulkPut.mock.calls.reduce((count, [jobs]) => count + jobs.length, 0),
    ).toBe(240);

    database.close();
    await database.delete();
  });

  it('only restores jobs claimed by the failing content sync', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '失败批次', undefined, 10));
    let otherJobId: number | undefined;
    const fetcher = vi.fn(async () => {
      otherJobId = await database.jobs.add({
        type: 'wikitext-content',
        pageId: 99,
        status: 'running',
        targetRevisionId: 990,
        updatedAt: Date.now(),
      });
      throw new Error('模拟当前批次网络中断');
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await expect(syncContent(database, api, { requestIntervalMs: 0 })).rejects.toThrow(
      '模拟当前批次网络中断',
    );

    expect(
      await database.jobs.filter((job) => job.pageId === 1).first(),
    ).toMatchObject({ status: 'pending', targetRevisionId: 10 });
    expect(await database.jobs.get(otherJobId)).toMatchObject({
      status: 'running',
      targetRevisionId: 990,
    });

    database.close();
    await database.delete();
  });

  it('restores a claimed job after a stalled content request times out', async () => {
    let requestSignal: AbortSignal | null | undefined;
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '超时页面', undefined, 10));
    const api = new WikiApi({
      retries: 0,
      requestTimeoutMs: 10,
      fetcher: vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          requestSignal = init?.signal;
          return new Promise<Response>(() => undefined);
        },
      ) as typeof fetch,
    });

    await expect(syncContent(database, api, { requestIntervalMs: 0 })).rejects.toThrow(
      '请求超时',
    );

    expect(requestSignal?.aborted).toBe(true);
    expect(
      await database.jobs.filter((job) => job.pageId === 1).first(),
    ).toMatchObject({ status: 'pending', targetRevisionId: 10 });

    database.close();
    await database.delete();
  });

  it('rejects a stale revision response without rolling cached content backward', async () => {
    const fetcher = vi.fn(async () =>
      json({
        query: {
          pages: [
            {
              pageid: 1,
              revisions: [
                {
                  revid: 15,
                  slots: { main: { contentmodel: 'wikitext', content: '较旧响应正文' } },
                },
              ],
            },
          ],
        },
      }),
    );
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(
      page(1, '竞态页面', 'RC 已写入的新正文', 20),
    );
    await database.pages.update(1, { contentRevisionId: 10 });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await expect(
      syncContent(database, api, { requestIntervalMs: 0 }),
    ).rejects.toThrow('正文响应版本落后');

    expect(await database.pages.get(1)).toMatchObject({
      revisionId: 20,
      contentRevisionId: 10,
      content: 'RC 已写入的新正文',
    });
    expect(
      await database.jobs.filter((job) => job.pageId === 1).first(),
    ).toMatchObject({ status: 'pending', targetRevisionId: 20 });

    database.close();
    await database.delete();
  });

  it('does not recreate a content job after an incremental delete wins the race', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '同步中删除', '旧正文', 10));
    const fetcher = vi.fn(async () => {
      await database.transaction('rw', database.pages, database.jobs, async () => {
        const stored = await database.pages.get(1);
        if (!stored) throw new Error('测试页面缺失');
        await database.pages.put({
          ...stored,
          deleted: true,
          content: undefined,
          contentRevisionId: undefined,
          localSeq: 2,
        });
        const jobIds = await database.jobs
          .filter((job) => job.pageId === 1)
          .primaryKeys();
        await database.jobs.bulkDelete(jobIds);
      });
      return json({
        query: {
          pages: [
            {
              pageid: 1,
              revisions: [
                {
                  revid: 10,
                  slots: { main: { contentmodel: 'wikitext', content: '过期响应正文' } },
                },
              ],
            },
          ],
        },
      });
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await syncContent(database, api, { force: true, requestIntervalMs: 0 });

    expect(await database.pages.get(1)).toMatchObject({
      deleted: true,
      content: undefined,
      contentRevisionId: undefined,
    });
    expect(await database.jobs.filter((job) => job.pageId === 1).count()).toBe(0);

    database.close();
    await database.delete();
  });
});

describe('BSON content search', () => {
  it('indexes JSON keys and scalar values from Data pages', () => {
    const source = JSON.stringify({
      id: 'bricks',
      locales: {
        'zh-CN': {
          name: '砖块',
          description: '可用于搭建耐火墙体',
        },
      },
      properties: { blastResistance: 12.5, craftable: true },
    });

    expect(extractContent('BSON', source)).toBe(
      'id bricks locales zh-CN name 砖块 description 可用于搭建耐火墙体 properties blastResistance 12.5 craftable true',
    );

    const index = new ContentIndex(analyzer);
    index.rebuild([
      {
        ...page(3500, 'Data:Block/bricks.json', source, 24680),
        namespace: 3500,
        namespaceName: 'Data',
        contentModel: 'BSON',
      },
    ]);

    expect(index.search('耐火墙体')[0]).toMatchObject({
      kind: 'content',
      title: 'Data:Block/bricks.json',
      snippet: expect.stringContaining('耐火墙体'),
    });
    expect(index.search('blastResistance')[0]?.title).toBe('Data:Block/bricks.json');
  });

});

function normalizedPayload(codeUnits: number): string {
  const prefixLength = codeUnits - 'ＴＡＲＧＥＴ'.length;
  return `${'ﬃ'.repeat(Math.floor(prefixLength / 3))}${'x'.repeat(prefixLength % 3)}ＴＡＲＧＥＴ`;
}

function page(
  id: number,
  title: string,
  content?: string,
  revisionId = id * 10,
): PageRecord {
  return {
    id,
    title,
    normalizedTitle: analyzer.normalize(title),
    namespace: 0,
    namespaceName: '（主）',
    isRedirect: false,
    revisionId,
    contentModel: 'wikitext',
    content,
    contentRevisionId: content === undefined ? undefined : revisionId,
    localSeq: id,
    seenInTitleSync: 1,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
