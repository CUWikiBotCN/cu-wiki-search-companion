// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { Analyzer, createBootstrapSegmenter, createIntlSegmenter } from '../../src/analyzer/analyzer';
import { LocalDataMaintenance } from '../../src/maintenance/local-data-maintenance';
import { PageSearchRuntime } from '../../src/runtime/page-search-runtime';
import { VersionedSearchIndexCache } from '../../src/search/versioned-search-index-cache';
import { LinearTitleIndex } from '../../src/search/title-index';
import { WikiSearchDatabase } from '../../src/storage/database';
import type { PageRecord } from '../../src/types';

const resources: Array<{ database: WikiSearchDatabase; cache: VersionedSearchIndexCache }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { database, cache } of resources.splice(0)) {
    try { await cache.clear(); } catch { /* A failure test may close the database. */ }
    database.close();
    await database.delete();
  }
});

it('initializes lightly and coalesces content preparation without loading Lua', async () => {
  const { runtime, database, loadAnalyzer, synchronizeContent } = await harness();
  await runtime.initialize();
  expect(runtime.state.engine).toBe('bootstrap');
  expect(runtime.searchTitles('医疗').map(({ title }) => title)).toEqual(['医疗指南']);
  expect(runtime.hasLoadedContentIndex()).toBe(false);
  expect(loadAnalyzer).not.toHaveBeenCalled();
  expect(await database.indexSnapshots.count()).toBe(0);

  await Promise.all([runtime.prepare('content'), runtime.prepare('content')]);
  expect(runtime.searchContent('绷带').map(({ title }) => title)).toEqual(['医疗指南']);
  expect(runtime.searchLua('heal')).toEqual([]);
  expect(await database.indexSnapshots.get('search-index:lua')).toBeUndefined();
  expect(loadAnalyzer).toHaveBeenCalledOnce();
  expect(synchronizeContent).toHaveBeenCalledOnce();
});

it('prepares and refreshes titles without inspecting unused content or Lua snapshots', async () => {
  const { runtime, database, cache } = await harness();
  const analyzer = new Analyzer(createIntlSegmenter(), 'Intl.Segmenter');
  for (const kind of ['content', 'lua'] as const) {
    await cache.publish(await cache.restoreOrRebuild(kind, analyzer));
  }
  const inspect = vi.spyOn(cache, 'inspect');
  const allSnapshots = vi.spyOn(database.indexSnapshots, 'toArray');
  const get = vi.spyOn(database.indexSnapshots, 'get');
  await runtime.prepare('title');
  expect(runtime.searchContent('绷带')).toEqual([]);
  expect(runtime.searchLua('heal')).toEqual([]);
  for (const [key] of get.mock.calls) expect(key).toBe('search-index:title');
  expect(inspect).not.toHaveBeenCalled();
  expect(allSnapshots).not.toHaveBeenCalled();

  await database.pages.update(1, { title: '新版医疗指南', normalizedTitle: '新版医疗指南', localSeq: 3 });
  await database.syncState.put({ key: 'local-sequence', value: 3 });
  const digest = vi.spyOn(crypto.subtle, 'digest');
  get.mockClear();
  await runtime.refresh();
  expect(runtime.searchTitles('新版')[0]?.title).toBe('新版医疗指南');
  expect(runtime.state.snapshots.find(({ kind }) => kind === 'title')?.status).toBe('replay-required');
  expect(inspect).not.toHaveBeenCalled();
  expect(allSnapshots).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  expect(digest).not.toHaveBeenCalled();
  digest.mockRestore(); get.mockRestore(); allSnapshots.mockRestore(); inspect.mockRestore();
});

it.each([false, true])('finishes same-turn preparation/rebuild without a circular wait (rebuild first: %s)', async (rebuildFirst) => {
  const { runtime } = await harness();
  await runtime.initialize();
  await Promise.all(rebuildFirst
    ? [runtime.rebuildIndexes(), runtime.prepare('content')]
    : [runtime.prepare('content'), runtime.rebuildIndexes()]);
  expect(runtime.searchContent('绷带').map(({ title }) => title)).toEqual(['医疗指南']);
  expect(runtime.searchLua('heal').map(({ title }) => title)).toEqual(['模块:Health']);
}, 1_500);

it('keeps local content usable during a failed settlement and retries without reloading the analyzer', async () => {
  const failure = new Error('network interrupted');
  let rejectNetwork!: (error: Error) => void;
  const blocked = new Promise<void>((_resolve, reject) => { rejectNetwork = reject; });
  let attempts = 0;
  const synchronizeContent = vi.fn(async () => {
    if (++attempts === 1) await blocked;
    return { total: 2, done: 2, pending: 0, failed: 0 };
  });
  const { runtime, loadAnalyzer } = await harness({ synchronizeContent });
  const preparing = runtime.prepare('content');
  const rejected = expect(preparing).rejects.toBe(failure);
  await vi.waitFor(() => expect(synchronizeContent).toHaveBeenCalledOnce());
  expect(runtime.searchContent('绷带').map(({ title }) => title)).toEqual(['医疗指南']);
  rejectNetwork(failure);
  await rejected;
  await runtime.prepare('content');
  expect(runtime.searchContent('绷带').map(({ title }) => title)).toEqual(['医疗指南']);
  expect(loadAnalyzer).toHaveBeenCalledOnce();
  expect(synchronizeContent).toHaveBeenCalledTimes(2);
});

it('refreshes committed content after a failed synchronization and preserves the original error', async () => {
  const failure = new Error('second batch failed');
  let database!: WikiSearchDatabase;
  const { runtime, database: storage } = await harness({ synchronizeContent: async () => {
    await database.transaction('rw', database.pages, database.syncState, async () => {
      await database.pages.update(1, { content: '新提交的纱布', localSeq: 3, revisionId: 2, contentRevisionId: 2 });
      await database.syncState.put({ key: 'local-sequence', value: 3 });
    });
    throw failure;
  } });
  database = storage;
  await expect(runtime.prepare('content')).rejects.toBe(failure);
  expect(runtime.searchContent('纱布').map(({ title }) => title)).toEqual(['医疗指南']);
  expect(runtime.searchContent('绷带')).toEqual([]);
});

it('replays renamed pages, replaced content and tombstones through every loaded query', async () => {
  const { runtime, database } = await harness();
  await runtime.prepare('content');
  await runtime.prepare('lua');
  await database.transaction('rw', database.pages, database.syncState, async () => {
    await database.pages.update(1, { title: '急救手册', normalizedTitle: '急救手册', content: '使用纱布', localSeq: 3 });
    await database.pages.update(2, { deleted: true, content: undefined, localSeq: 4 });
    await database.syncState.put({ key: 'local-sequence', value: 4 });
  });
  await runtime.refresh();
  expect(runtime.searchTitles('医疗')).toEqual([]);
  expect(runtime.searchTitles('急救', 0).map(({ title }) => title)).toEqual(['急救手册']);
  expect(runtime.searchTitles('急救', 828)).toEqual([]);
  expect(runtime.searchContent('纱布').map(({ title }) => title)).toEqual(['急救手册']);
  expect(runtime.searchContent('绷带')).toEqual([]);
  expect(runtime.searchLua('heal')).toEqual([]);
  expect(runtime.searchTitles('Health')).toEqual([]);
});

it('rebuilds locally without waiting for a pending remote settlement or reinstalling old handles', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const titleWriter = vi.fn(async () => held);
  const { runtime, database, synchronizeContent } = await harness({ synchronizeTitles: titleWriter });
  const preparing = runtime.prepare('content');
  try {
    await vi.waitFor(() => expect(titleWriter).toHaveBeenCalledOnce());
    await database.transaction('rw', database.pages, database.syncState, async () => {
      await database.pages.update(1, { title: '新版医疗指南', normalizedTitle: '新版医疗指南', content: '使用纱布', localSeq: 3 });
      await database.syncState.put({ key: 'local-sequence', value: 3 });
    });
    await runtime.rebuildIndexes();
    expect(synchronizeContent).not.toHaveBeenCalled();
    expect(runtime.searchContent('纱布').map(({ title }) => title)).toEqual(['新版医疗指南']);
    const afterRebuild = await database.indexSnapshots.toArray();
    release();
    await preparing;
    expect(runtime.searchContent('纱布').map(({ title }) => title)).toEqual(['新版医疗指南']);
    expect(runtime.searchContent('绷带')).toEqual([]);
    expect(await database.indexSnapshots.toArray()).toEqual(afterRebuild);
  } finally {
    release();
    await preparing.catch(() => undefined);
  }
}, 1_500);

it('performs a cold maintenance rebuild with no fact synchronization and keeps results after a later rebuild fails', async () => {
  const failure = new Error('snapshot rebuild failed');
  let fail = false;
  let maintenance!: LocalDataMaintenance;
  const result = await harness({ rebuildIndexes: async (analyzer) => {
    if (fail) throw failure;
    return maintenance.rebuildSearchIndexes(analyzer);
  } });
  maintenance = result.maintenance;
  await result.runtime.rebuildIndexes();
  expect(result.synchronizeTitles).not.toHaveBeenCalled();
  expect(result.synchronizeContent).not.toHaveBeenCalled();
  expect(result.runtime.searchContent('绷带').map(({ title }) => title)).toEqual(['医疗指南']);
  expect(result.runtime.searchLua('heal').map(({ title }) => title)).toEqual(['模块:Health']);
  fail = true;
  await expect(result.runtime.rebuildIndexes()).rejects.toBe(failure);
  expect(result.runtime.searchContent('绷带').map(({ title }) => title)).toEqual(['医疗指南']);
  expect(result.runtime.searchLua('heal').map(({ title }) => title)).toEqual(['模块:Health']);
});

it('does not materialize all page bodies when a forced content sync has no loaded derived index', async () => {
  const { runtime, database } = await harness();
  await runtime.initialize();
  const readBodies = vi.spyOn(database.pages, 'toArray');
  await runtime.synchronizeContent(true);
  expect(runtime.hasLoadedContentIndex()).toBe(false);
  expect(readBodies).not.toHaveBeenCalled();
});

function pages(): PageRecord[] {
  return [
    { id: 1, title: '医疗指南', normalizedTitle: '医疗指南', namespace: 0, namespaceName: '（主）',
      isRedirect: false, localSeq: 1, revisionId: 1, contentRevisionId: 1,
      contentModel: 'wikitext', content: '使用医疗绷带' },
    { id: 2, title: '模块:Health', normalizedTitle: '模块:health', namespace: 828, namespaceName: '模块',
      isRedirect: false, localSeq: 2, revisionId: 1, contentRevisionId: 1,
      contentModel: 'Scribunto', content: 'local p = {}\nfunction p.heal() return "bandage" end\nreturn p' },
  ];
}

async function harness(overrides: Partial<ConstructorParameters<typeof PageSearchRuntime>[0]> = {}) {
  const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
  await database.open();
  await database.pages.bulkPut(pages());
  await database.syncState.put({ key: 'local-sequence', value: 2 });
  const cache = new VersionedSearchIndexCache(database);
  resources.push({ database, cache });
  const maintenance = new LocalDataMaintenance(database, cache);
  const loadAnalyzer = vi.fn(async () => ({
    analyzer: new Analyzer(createIntlSegmenter(), 'Intl.Segmenter'),
    engine: 'Intl.Segmenter' as const,
  }));
  const synchronizeTitles = vi.fn(async () => undefined);
  const synchronizeContent = vi.fn(async () => ({ total: 2, done: 2, pending: 0, failed: 0 }));
  const onStateChange = vi.fn();
  const onResultsChanged = vi.fn();
  const runtime = new PageSearchRuntime({
    database,
    indexCache: cache,
    bootstrapAnalyzer: new Analyzer(createBootstrapSegmenter(), 'bootstrap'),
    loadAnalyzer,
    waitUntilVisible: async () => undefined,
    synchronizeTitles,
    synchronizeContent,
    onStateChange,
    onResultsChanged,
    rebuildIndexes: (analyzer) => maintenance.rebuildSearchIndexes(analyzer),
    ...overrides,
  });
  return { runtime, database, cache, maintenance, loadAnalyzer, synchronizeTitles, synchronizeContent,
    onStateChange, onResultsChanged };
}

it('prepares CSS without loading the analyzer or snapshots and restores offline source before retry', async () => {
  let offline = true;
  const synchronizeContent = vi.fn(async (_force: boolean, scope?: string) => {
    expect(scope).toBe('css');
    if (offline) throw new Error('offline');
    return { total: 1, done: 1, pending: 0, failed: 0 };
  });
  const { runtime, database, cache, loadAnalyzer } = await harness({ synchronizeContent });
  await database.pages.put({ ...pages()[0]!, id: 3, contentModel: 'css', title: 'MediaWiki:Common.css', content: '.card {}', localSeq: 3 });
  await database.syncState.put({ key: 'local-sequence', value: 3 });
  const inspect = vi.spyOn(cache, 'inspect');
  await runtime.initialize();
  expect(runtime.searchCss('.card')).toEqual([]);
  await expect(runtime.prepare('css')).rejects.toThrow('offline');
  expect(runtime.searchCss('.card')).toHaveLength(1);
  expect(loadAnalyzer).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
  expect(await database.indexSnapshots.count()).toBe(0);
  offline = false;
  await runtime.prepare('css');
  expect(runtime.state.readiness.css).toBe('ready');
  expect(runtime.state.readiness.content).toBe('not-started');
  await database.pages.update(3, { deleted: true, localSeq: 4 });
  await database.syncState.put({ key: 'local-sequence', value: 4 });
  await runtime.refresh();
  expect(runtime.searchCss('.card')).toEqual([]);
});

it('does not let a pending content download swallow CSS preparation', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const synchronizeContent = vi.fn(async (_force: boolean, scope?: string) => {
    if (scope !== 'css') await blocked;
    return { total: 0, done: 0, pending: 0, failed: 0 };
  });
  const { runtime } = await harness({ synchronizeContent });
  const content = runtime.prepare('content');
  await vi.waitFor(() => expect(synchronizeContent).toHaveBeenCalled());
  await runtime.prepare('css');
  expect(synchronizeContent).toHaveBeenCalledWith(false, 'css');
  release(); await content;
  expect(runtime.state.readiness.css).toBe('ready');
  expect(runtime.state.readiness.content).toBe('ready');
});

it('notifies only newly installed modes while readiness and snapshot state settle', async () => {
  const { runtime, onResultsChanged, onStateChange } = await harness();
  await runtime.initialize();
  await runtime.prepare('content');
  await runtime.prepare('lua');
  expect(onResultsChanged.mock.calls).toEqual([
    [['title']], [['title']], [['content']], [['lua']],
  ]);
  expect(onStateChange.mock.calls.length).toBeGreaterThan(onResultsChanged.mock.calls.length);
  onResultsChanged.mockClear();
  onStateChange.mockClear();

  await runtime.refreshSnapshotStatus();
  await runtime.refresh();
  await runtime.synchronizeContent(false);
  await runtime.prepare('content');
  await runtime.prepare('lua');

  expect(onResultsChanged).not.toHaveBeenCalled();
  expect(onStateChange).toHaveBeenCalled();
  expect(runtime.state.readiness).toMatchObject({ title: 'ready', content: 'ready', lua: 'ready' });
});

it('aggregates one refresh notification and replays lean title headers alongside full content facts', async () => {
  const { runtime, database, cache, onResultsChanged } = await preparedHarness();
  const refresh = vi.spyOn(cache, 'refresh');
  await runtime.refresh();
  const title = refresh.mock.calls.find(([handle]) => handle.kind === 'title')![0];
  const content = refresh.mock.calls.find(([handle]) => handle.kind === 'content')![0];
  const titleUpdates = vi.spyOn(title.index, 'updateAsync');
  const contentUpdates = vi.spyOn(content.index, 'updateAsync');
  const linearUpdates = vi.spyOn(LinearTitleIndex.prototype, 'update');
  const fullHeaders = vi.spyOn(database.pages, 'filter');
  const fullBodies = vi.spyOn(database.pages, 'toArray');
  const schedule = vi.spyOn(cache, 'schedulePublish');
  onResultsChanged.mockClear();
  await commit(database, [
    { ...pages()[0]!, title: '新版医疗指南', normalizedTitle: '新版医疗指南', content: '使用纱布', localSeq: 3 },
    { ...pages()[1]!, content: 'local p = {}\nfunction p.treat() return "gauze" end\nreturn p', localSeq: 4 },
  ], 4);

  await runtime.refresh();

  expect(onResultsChanged).toHaveBeenCalledTimes(1);
  expect([...onResultsChanged.mock.calls[0]![0]].sort()).toEqual(['content', 'lua', 'title']);
  expect(schedule).toHaveBeenCalledTimes(3);
  expect(fullHeaders).not.toHaveBeenCalled();
  expect(fullBodies).not.toHaveBeenCalled();
  for (const batch of [titleUpdates.mock.calls[0]![0], linearUpdates.mock.calls[0]![0]]) {
    expect(batch.map(({ id }) => id)).toEqual([1, 2]);
    for (const page of batch) {
      expect(page).not.toHaveProperty('content');
      expect(page).not.toHaveProperty('contentModel');
      expect(page).not.toHaveProperty('contentRevisionId');
    }
  }
  expect(contentUpdates.mock.calls[0]![0][0]?.content).toBe('使用纱布');
  expect(runtime.searchContent('纱布').map(({ id }) => id)).toEqual([1]);
  expect(runtime.searchLua('treat').map(({ id }) => id)).toEqual([2]);
});

it('advances loaded handles for a file-only sequence without page scans, bootstrap rebuilds or publishing', async () => {
  const { runtime, database, cache, onResultsChanged } = await preparedHarness();
  await runtime.prepare('css');
  const refresh = vi.spyOn(cache, 'refresh');
  const schedule = vi.spyOn(cache, 'schedulePublish');
  const linearUpdates = vi.spyOn(LinearTitleIndex.prototype, 'update');
  const fullHeaders = vi.spyOn(database.pages, 'filter');
  const fullBodies = vi.spyOn(database.pages, 'toArray');
  const pageReads = vi.fn((page: PageRecord) => page);
  database.pages.hook('reading', pageReads);
  onResultsChanged.mockClear();
  await database.transaction('rw', database.fileResources, database.syncState, async () => {
    await database.fileResources.put({ ...pages()[0]!, id: 6, namespace: 6, namespaceName: '文件',
      title: '文件:新图片.png', normalizedTitle: '文件:新图片.png', writerSeq: 3, localSeq: 1 });
    await database.syncState.put({ key: 'local-sequence', value: 3 });
  });

  await runtime.refresh();

  expect(runtime.state.throughLocalSeq).toBe(3);
  expect(refresh.mock.calls).toHaveLength(3);
  expect(refresh.mock.calls.map(([handle]) => handle.throughLocalSeq)).toEqual([3, 3, 3]);
  expect(onResultsChanged).not.toHaveBeenCalled();
  expect(schedule).not.toHaveBeenCalled();
  expect(linearUpdates).not.toHaveBeenCalled();
  expect(fullHeaders).not.toHaveBeenCalled();
  expect(fullBodies).not.toHaveBeenCalled();
  expect(pageReads).not.toHaveBeenCalled();
  expect(runtime.state.indexedPages).toBe(2);
});

it('incrementally updates namespace names, moves, last-page tombstones and same-count redirect targets', async () => {
  const { runtime, database, onResultsChanged } = await harness();
  await runtime.initialize();
  const fullHeaders = vi.spyOn(database.pages, 'filter');
  const fullBodies = vi.spyOn(database.pages, 'toArray');
  const linearUpdates = vi.spyOn(LinearTitleIndex.prototype, 'update');
  onResultsChanged.mockClear();
  await commit(database, [{ ...pages()[0]!, namespaceName: '新版主空间', localSeq: 3 }], 3);
  await runtime.refresh();
  expect(runtime.state.namespaces).toEqual([{ id: 0, name: '新版主空间' }, { id: 828, name: '模块' }]);

  const moved = { ...pages()[0]!, title: '模板:医疗指南', normalizedTitle: '模板:医疗指南',
    namespace: 10, namespaceName: '模板', localSeq: 4 };
  await commit(database, [moved], 4);
  await runtime.refresh();
  expect(runtime.searchTitles('医疗', 0)).toEqual([]);
  expect(runtime.searchTitles('医疗', 10).map(({ id }) => id)).toEqual([1]);
  expect(runtime.state.namespaces).toEqual([{ id: 10, name: '模板' }, { id: 828, name: '模块' }]);

  await commit(database, [{ ...pages()[1]!, deleted: true, localSeq: 5 }], 5);
  await runtime.refresh();
  expect(runtime.state.namespaces).toEqual([{ id: 10, name: '模板' }]);
  const redirect = { ...moved, isRedirect: true, localSeq: 6, redirectResolution: {
    sourceTitle: moved.title, sourceRevisionId: moved.revisionId, checkedAt: 1,
    target: { title: '急救指导', fragment: '医疗' },
  } };
  await commit(database, [redirect], 6);
  await runtime.refresh();
  expect(runtime.searchTitles('医疗', 10)[0]).toMatchObject({
    redirectResolved: true, redirectTarget: { title: '急救指导', fragment: '医疗' },
  });
  expect(runtime.state.indexedPages).toBe(1);
  expect(onResultsChanged.mock.calls).toEqual(Array.from({ length: 4 }, () => [['title']]));
  expect(linearUpdates.mock.calls.map(([batch]) => batch.map(({ id }) => id))).toEqual([[1], [1], [2], [1]]);
  expect(fullHeaders).not.toHaveBeenCalled();
  expect(fullBodies).not.toHaveBeenCalled();
});

it('catches a fact committed after the bootstrap read even when handles already observe its sequence', async () => {
  const { runtime, database, cache, onResultsChanged } = await preparedHarness();
  const refresh = cache.refresh.bind(cache);
  let committed = false;
  vi.spyOn(cache, 'refresh').mockImplementation(async (handle) => {
    if (!committed) {
      committed = true;
      await commit(database, [{ ...pages()[0]!, title: '追平医疗指南', normalizedTitle: '追平医疗指南',
        namespaceName: '新名称', content: '刚提交的纱布', localSeq: 3 }], 3);
    }
    return refresh(handle);
  });
  const linearUpdates = vi.spyOn(LinearTitleIndex.prototype, 'update');
  onResultsChanged.mockClear();

  await runtime.refresh();

  expect(linearUpdates.mock.calls.map(([batch]) => batch.map(({ id, localSeq }) => [id, localSeq])))
    .toEqual([[[1, 3]]]);
  expect(runtime.state.namespaces.find(({ id }) => id === 0)?.name).toBe('新名称');
  expect(runtime.searchTitles('追平').map(({ id }) => id)).toEqual([1]);
  expect(runtime.searchContent('纱布').map(({ id }) => id)).toEqual([1]);
  expect(runtime.state.throughLocalSeq).toBe(3);
  expect(onResultsChanged).toHaveBeenCalledTimes(1);
});

it('serializes refresh calls and emits once when a commit arrives during the first refresh', async () => {
  const { runtime, database, cache, onResultsChanged } = await preparedHarness();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  const refresh = cache.refresh.bind(cache);
  let calls = 0;
  let active = 0;
  let maximum = 0;
  vi.spyOn(cache, 'refresh').mockImplementation(async (handle) => {
    active += 1; maximum = Math.max(maximum, active);
    try {
      if (++calls === 1) { entered(); await blocked; }
      return await refresh(handle);
    } finally { active -= 1; }
  });
  onResultsChanged.mockClear();
  const first = runtime.refresh();
  await firstEntered;
  const second = runtime.refresh();
  await commit(database, [{ ...pages()[0]!, content: '排队提交的纱布', localSeq: 3 }], 3);
  expect(calls).toBe(1);
  release();
  await Promise.all([first, second]);

  expect(maximum).toBe(1);
  expect(runtime.searchContent('纱布').map(({ id }) => id)).toEqual([1]);
  expect(runtime.state.throughLocalSeq).toBe(3);
  expect(onResultsChanged).toHaveBeenCalledTimes(1);
});

it('drops old refresh installation and notifications after a rebuild replaces the indexes', async () => {
  const { runtime, database, cache, onResultsChanged } = await preparedHarness();
  await commit(database, [{ ...pages()[0]!, title: '过期医疗指南', normalizedTitle: '过期医疗指南', localSeq: 3 }], 3);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  const refresh = cache.refresh.bind(cache);
  vi.spyOn(cache, 'refresh').mockImplementationOnce(async (handle) => {
    entered(); await blocked; return refresh(handle);
  });
  const schedule = vi.spyOn(cache, 'schedulePublish');
  const linearUpdates = vi.spyOn(LinearTitleIndex.prototype, 'update');
  onResultsChanged.mockClear();
  const refreshing = runtime.refresh();
  await firstEntered;
  try {
    await commit(database, [
      { ...pages()[0]!, title: '最终医疗指南', normalizedTitle: '最终医疗指南', content: '最终纱布', localSeq: 4 },
      { ...pages()[1]!, deleted: true, localSeq: 5 },
      { ...pages()[0]!, id: 3, title: '新增指南', normalizedTitle: '新增指南', content: '新增纱布', localSeq: 6 },
    ], 6);
    await runtime.rebuildIndexes();
    expect(onResultsChanged).toHaveBeenCalledTimes(1);
    linearUpdates.mockClear(); schedule.mockClear();
    release(); await refreshing;
    expect(linearUpdates).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(onResultsChanged).toHaveBeenCalledTimes(1);
    expect(runtime.searchTitles('过期')).toEqual([]);
    expect(runtime.searchTitles('最终').map(({ id }) => id)).toEqual([1]);
    expect(runtime.searchContent('纱布').map(({ id }) => id).sort()).toEqual([1, 3]);
    expect(runtime.state).toMatchObject({ indexedPages: 2, indexedContentPages: 2,
      indexedLuaModules: 0, throughLocalSeq: 6 });
  } finally {
    release(); await refreshing.catch(() => undefined);
  }
});

it('recovers a failed refresh without advancing bootstrap past the failed application', async () => {
  const { runtime, database, cache, onResultsChanged } = await preparedHarness();
  await commit(database, [{ ...pages()[0]!, title: '重试医疗指南', normalizedTitle: '重试医疗指南',
    content: '重试纱布', localSeq: 3 }], 3);
  const failure = new Error('content replay interrupted');
  const refresh = cache.refresh.bind(cache);
  let fail = true;
  vi.spyOn(cache, 'refresh').mockImplementation(async (handle) => {
    if (handle.kind === 'content' && fail) { fail = false; throw failure; }
    return refresh(handle);
  });
  onResultsChanged.mockClear();
  await expect(runtime.refresh()).rejects.toBe(failure);
  expect(onResultsChanged.mock.calls).toEqual([[['title']]]);

  await runtime.refresh();

  expect(runtime.searchTitles('重试').map(({ id }) => id)).toEqual([1]);
  expect(runtime.searchContent('纱布').map(({ id }) => id)).toEqual([1]);
  expect(runtime.state.throughLocalSeq).toBe(3);
  expect(onResultsChanged).toHaveBeenCalledTimes(2);
  expect([...onResultsChanged.mock.calls[1]![0]].sort()).toEqual(['content', 'lua', 'title']);
});

it('keeps independent handle cursors and replays each lagging index from its own sequence', async () => {
  const { runtime, database, cache, onResultsChanged } = await preparedHarness();
  const refresh = vi.spyOn(cache, 'refresh');
  await runtime.refresh();
  const handles = new Map(refresh.mock.calls.map(([handle]) => [handle.kind, handle]));
  refresh.mockRestore();
  const atThree = { ...pages()[0]!, content: '第三版纱布 ancientomega', localSeq: 3 };
  const atFour = { ...pages()[1]!, content: 'local p = {}\nfunction p.treat() return "gauze" end\nreturn p', localSeq: 4 };
  handles.get('title')!.index.rebuild(pages()); handles.get('title')!.throughLocalSeq = 2;
  handles.get('content')!.index.rebuild([atThree, pages()[1]!]); handles.get('content')!.throughLocalSeq = 3;
  handles.get('lua')!.index.rebuild([atThree, atFour]); handles.get('lua')!.throughLocalSeq = 4;
  await commit(database, [{ ...atThree, title: '最终医疗指南', normalizedTitle: '最终医疗指南',
    content: '第五版纱布 freshsigma', localSeq: 5 }, atFour], 5);
  const replay = cache.refresh.bind(cache);
  const observed: Array<[string, number, number]> = [];
  vi.spyOn(cache, 'refresh').mockImplementation(async (handle) => {
    const before = handle.throughLocalSeq;
    const rows = await replay(handle);
    observed.push([handle.kind, before, rows]);
    return rows;
  });
  onResultsChanged.mockClear();

  await runtime.refresh();

  expect(observed).toEqual([['title', 2, 2], ['content', 3, 2], ['lua', 4, 1]]);
  expect([...handles.values()].map(({ throughLocalSeq }) => throughLocalSeq)).toEqual([5, 5, 5]);
  expect(runtime.searchTitles('最终').map(({ id }) => id)).toEqual([1]);
  expect(runtime.searchContent('第五版')[0]?.snippet).toContain('第五版');
  expect(runtime.searchContent('ancientomega')).toEqual([]);
  expect(runtime.searchLua('treat').map(({ id }) => id)).toEqual([2]);
  expect(onResultsChanged).toHaveBeenCalledTimes(1);
});

it('notifies an applied content change even if a later Lua refresh fails and content replay is zero on retry', async () => {
  const { runtime, database, cache, onResultsChanged } = await preparedHarness();
  await commit(database, [{ ...pages()[0]!, content: '已应用的纱布', localSeq: 3 }], 3);
  const failure = new Error('Lua replay interrupted');
  const refresh = cache.refresh.bind(cache);
  let fail = true;
  vi.spyOn(cache, 'refresh').mockImplementation(async (handle) => {
    if (handle.kind === 'lua' && fail) { fail = false; throw failure; }
    return refresh(handle);
  });
  onResultsChanged.mockClear();

  await expect(runtime.refresh()).rejects.toBe(failure);

  expect(runtime.searchContent('纱布').map(({ id }) => id)).toEqual([1]);
  expect(onResultsChanged).toHaveBeenCalledTimes(1);
  expect([...onResultsChanged.mock.calls[0]![0]].sort()).toEqual(['content', 'title']);
  await runtime.refresh();
  expect(onResultsChanged).toHaveBeenCalledTimes(2);
  expect([...onResultsChanged.mock.calls[1]![0]].sort()).toEqual(['lua', 'title']);
  expect(onResultsChanged.mock.calls.filter(([kinds]) => kinds.includes('content'))).toHaveLength(1);
  expect(runtime.state.throughLocalSeq).toBe(3);
});

async function preparedHarness() {
  const setup = await harness();
  await setup.runtime.prepare('content');
  await setup.runtime.prepare('lua');
  return setup;
}

async function commit(database: WikiSearchDatabase, records: PageRecord[], sequence: number): Promise<void> {
  await database.transaction('rw', database.pages, database.syncState, async () => {
    await database.pages.bulkPut(records);
    await database.syncState.put({ key: 'local-sequence', value: sequence });
  });
}
