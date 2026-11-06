// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';
import {
  Analyzer,
  createBootstrapSegmenter,
} from '../../src/analyzer/analyzer';
import { SectionTitleIndex } from '../../src/search/section-title-index';
import { parseSectionQuery } from '../../src/search/section-query';
import { WikiSearchDatabase } from '../../src/storage/database';
import type { PageRecord } from '../../src/types';

let db: WikiSearchDatabase;
beforeEach(async () => {
  db = new WikiSearchDatabase(`sections-${crypto.randomUUID()}`);
  await db.open();
});
afterEach(async () => {
  db.close();
  await db.delete();
});
function page(id: number, title: string, content?: string): PageRecord {
  return {
    id,
    title,
    normalizedTitle: title,
    namespace: 0,
    namespaceName: '',
    isRedirect: false,
    localSeq: id,
    revisionId: id,
    contentRevisionId: content === undefined ? undefined : id,
    contentModel: 'wikitext',
    content,
  };
}
function index(): SectionTitleIndex {
  return new SectionTitleIndex(new Analyzer(createBootstrapSegmenter()), {
    yield: async () => undefined,
  });
}

it('splits on the first ASCII separator before normalizing', () => {
  expect(parseSectionQuery('全＃角 # 后#续 ')).toEqual({
    hasSeparator: true,
    pageQuery: '全＃角',
    sectionQuery: '后#续',
  });
  expect(parseSectionQuery('全＃角')).toEqual({
    hasSeparator: false,
    pageQuery: '',
    sectionQuery: '全＃角',
  });
});

it('applies both filters before the limit, supports binding, and reports partial coverage', async () => {
  const pages = Array.from({ length: 520 }, (_, i) =>
    page(
      i + 1,
      `地形${String(i).padStart(3, '0')}`,
      `== 你知道吗 ==\n== ${i === 510 ? '寻找目标' : '其他'} ==`,
    ),
  );
  pages.push(page(600, '地形缺失'));
  pages.push(page(601, '无关页面', '== 寻找目标 =='));
  await db.pages.bulkPut(pages);
  const sections = index();
  await sections.refresh(db);
  expect(sections.search('地形 #寻找目标').map((s) => s.id)).toEqual([511]);
  expect(sections.search('地形 #你知')).toHaveLength(20);
  expect(sections.search('地形 #你知', 0, 20, 511).map((s) => s.id)).toEqual([
    511,
  ]);
  expect(sections.search('#')).toEqual([]);
  expect(sections.search('地形#', 0, 3)).toHaveLength(3);
  expect(sections.search('!!!#你知')).toEqual([]);
  expect(sections.coverage(0, '地形')).toMatchObject({
    known: 521,
    covered: 520,
    missingPages: [{ id: 600 }],
    uncertainPages: 0,
  });
  expect(sections.findExactPage('地形缺失')?.id).toBe(600);
  expect(sections.findExactPage('地形')).toBeUndefined();
});

it('refreshes eligible revisions and discards stale, redirected, deleted and non-wikitext records', async () => {
  await db.pages.bulkPut([page(1, '一', '== 旧 =='), page(2, '二', '')]);
  await db.syncState.put({ key: 'local-sequence', value: 2 });
  const sections = index();
  await sections.refresh(db);
  expect(sections.coverage()).toMatchObject({ known: 2, covered: 2 });
  await db.pages.update(1, { revisionId: 3, localSeq: 3 });
  await db.pages.update(2, { isRedirect: true, localSeq: 4 });
  await db.syncState.put({ key: 'local-sequence', value: 4 });
  await sections.refresh(db);
  expect(sections.search('旧')).toEqual([]);
  expect(sections.coverage()).toMatchObject({
    known: 1,
    covered: 0,
    missingPages: [{ id: 1 }],
  });
  await db.pages.update(1, {
    content: '== 新 ==',
    contentRevisionId: 3,
    localSeq: 5,
  });
  await db.syncState.put({ key: 'local-sequence', value: 5 });
  await sections.refresh(db);
  expect(sections.search('新')[0]).toMatchObject({
    id: 1,
    revisionId: 3,
    sectionTitle: '新',
  });
  await db.pages.update(1, { contentModel: 'css', localSeq: 6 });
  await db.syncState.put({ key: 'local-sequence', value: 6 });
  await sections.refresh(db);
  expect(sections.coverage().known).toBe(0);
});

it('invalidates an in-flight cooperative refresh before it can install old results', async () => {
  await db.pages.put(page(1, '旧页', '== 旧 =='));
  let proceed!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const sections = new SectionTitleIndex(
    new Analyzer(createBootstrapSegmenter()),
    {
      yield: async () => {
        started();
        await resume;
      },
    },
  );
  const refresh = sections.refresh(db);
  await waiting;
  sections.invalidate();
  proceed();
  expect(await refresh).toBe(false);
  expect(sections.search('旧')).toEqual([]);
});

it('invalidates cached coverage after incremental refresh and does not expose cached mutable results', async () => {
  await db.pages.put(page(1, '待更新'));
  await db.syncState.put({ key: 'local-sequence', value: 1 });
  const sections = index();
  await sections.refresh(db);
  const first = sections.coverage(0, '待');
  expect(first).toMatchObject({
    known: 1,
    covered: 0,
    missingPages: [{ id: 1 }],
  });
  first.missingPages[0]!.title = '外部修改';
  first.missingPages.length = 0;
  expect(sections.coverage(0, '待').missingPages[0]?.title).toBe('待更新');
  await db.pages.update(1, { content: '', contentRevisionId: 1, localSeq: 2 });
  await db.syncState.put({ key: 'local-sequence', value: 2 });
  await sections.refresh(db);
  expect(sections.coverage(0, '待')).toMatchObject({
    known: 1,
    covered: 1,
    missingPages: [],
  });
  sections.invalidate();
  expect(sections.coverage(0, '待')).toMatchObject({
    known: 0,
    covered: 0,
    missingPages: [],
  });
});

it('returns direct fragments only for the verified plain-source subset', async () => {
  await db.pages.bulkPut([
    page(1, '简单页', '== 重复 ==\n== 重复_2 ==\n== 重复 =='),
    page(2, '模板页', '{{dynamic}}\n== 重复 =='),
  ]);
  const sections = index();
  await sections.refresh(db);
  const results = sections.search('重复', undefined, 10);
  expect(
    results
      .filter((result) => result.id === 1)
      .sort((a, b) => a.headingStart - b.headingStart)
      .map(({ fragment, needsResolution }) => [fragment, needsResolution]),
  ).toEqual([
    ['重复', false],
    ['重复_2', false],
    ['重复_3', false],
  ]);
  expect(results.find((result) => result.id === 2)).toMatchObject({
    needsResolution: true,
  });
  expect(results.find((result) => result.id === 2)?.fragment).toBeUndefined();
  expect(
    results
      .filter((result) => result.id === 1 && result.sectionTitle === '重复')
      .map((result) => result.occurrence),
  ).toEqual([1, 2]);
  expect(
    results.find((result) => result.sectionTitle === '重复_2')?.occurrence,
  ).toBeUndefined();
});

it('filters the full bound page before truncating its directory', async () => {
  await db.pages.put(
    page(
      1,
      '目录',
      Array.from(
        { length: 35 },
        (_, i) => `== ${i === 34 ? '最后的目标' : `小节${i}`} ==`,
      ).join('\n'),
    ),
  );
  const sections = index();
  await sections.refresh(db);
  expect(sections.search('目录#', undefined, 20, 1)).toHaveLength(20);
  expect(sections.search('目录#最后', undefined, 20, 1)).toMatchObject([
    { sectionTitle: '最后的目标' },
  ]);
});
