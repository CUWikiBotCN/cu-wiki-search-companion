// SPDX-License-Identifier: MPL-2.0
// Build as a Vite IIFE library with @vitejs/plugin-vue, root=<checkout>,
// build.lib.entry=<this file>, and define.__CU_WIKI_BUILD_ID__=<unique JSON string>.
// Also define 'process.env.NODE_ENV' as JSON.stringify('production') in lib mode.
// Absolute /src imports select the requested checkout, including an older worktree.
// Serve the resulting script in a plain HTML page on loopback. No Wiki connection.
import { nextTick } from 'vue';
import packageInfo from '/package.json';
import { Analyzer, createBootstrapSegmenter } from '/src/analyzer/analyzer';
import { ContentIndex } from '/src/search/content-index';
import { TitleIndex, LinearTitleIndex } from '/src/search/title-index';
import { DataCodeIndex } from '/src/search/data-code-index';
import { LuaModuleIndex } from '/src/search/lua-module-index';
import { CssSourceIndex } from '/src/search/css-source-index';
import { WikiSearchDatabase } from '/src/storage/database';
import { VersionedSearchIndexCache } from '/src/search/versioned-search-index-cache';
import { SearchPanel } from '/src/ui/search-panel';

declare const __CU_WIKI_BUILD_ID__: string;

const analyzer = new Analyzer(createBootstrapSegmenter(), 'bootstrap');
const filler = '這是一段用於評估搜尋效能的測試文字，包含藥物、治療與裝備資訊。';
const longBody = filler.repeat(3_600) + ' sleepQuality 高品質睡眠可以恢復健康。';
const database = new WikiSearchDatabase('offline-browser-benchmark-' + crypto.randomUUID());
const content = new ContentIndex(analyzer);
const titles = new TitleIndex(analyzer);
const files = new LinearTitleIndex(analyzer, [
  { ...page(6_001, '文件:浏览器测试.png'), namespace: 6, namespaceName: '文件' },
]);
const lua = new LuaModuleIndex(analyzer);
const css = new CssSourceIndex();
let contentSnapshot;
let panel;
let cache;
let destroyed = false;
const calls = [];
const actions = [];
const dataRecords = [
  { source: 'Data:A', code: 'same', chineseName: '浏览器测试甲', dataType: 'item' },
  { source: 'Data:B', code: 'same', chineseName: '浏览器测试乙', dataType: 'item' },
].map(record => ({ ...record, normalizedName: analyzer.normalize(record.chineseName), syncedAt: 0 }));
let codes = new DataCodeIndex(analyzer, dataRecords);
const queries = [
  { category: 'direct-english', query: 'sleepQuality' },
  { category: 'simplified-fallback', query: '恢复健康' },
  { category: 'disjoint-terms', query: '睡眠 健康' },
];
const api = {
  ready: false,
  error: undefined,
  meta: {
    sourceVersion: packageInfo.version,
    buildMarker: typeof __CU_WIKI_BUILD_ID__ === 'undefined' ? 'unmarked-fixture' : __CU_WIKI_BUILD_ID__,
    engine: 'bootstrap (same old/new; separate from Node jieba and real Wiki)',
    userAgent: navigator.userAgent,
    corpus: { shortPages: 1_000, longPages: 20, longPageChars: longBody.length },
    cache: {
      budgetBytes: 8 * 1024 * 1024,
      entryLimit: 128,
      estimatedLongTextPayloadBytes: 20 * analyzer.normalize(longBody).length * 2,
      estimateScope: 'UTF-16 text payload only; not JS heap size or measured cache occupancy.',
    },
    database: 'Unique synthetic IndexedDB; production Wiki database is never opened.',
    controls: 'Six real index backends; synthetic copy/open/insert callback recording.',
  },
  resetContentCache,
  warmContentCache: () => countedQuery(() => content.search('恢复健康')),
  measureQueries,
  measureInputPaint,
  measureSnapshots,
  uiChecks,
  cacheChecks,
  storageChecks,
  async destroy() {
    if (destroyed) return { alreadyDestroyed: true };
    destroyed = true;
    api.ready = false;
    try {
      panel?.destroy();
      if (cache) await cache.clear();
    } finally {
      database.close();
      await database.delete();
      content.rebuild([]);
      titles.rebuild([]);
      contentSnapshot = undefined;
    }
    return { panelDestroyed: true, syntheticDatabaseDeleted: true };
  },
};
window.__CU_WIKI_BENCHMARK__ = api;
void initialize().catch(error => { api.error = String(error?.message ?? error); });

function page(id, title, body = '') {
  return {
    id, title, normalizedTitle: analyzer.normalize(title), namespace: 0,
    namespaceName: '', localSeq: id, isRedirect: false,
    contentModel: 'wikitext', content: body, revisionId: 1, contentRevisionId: 1,
  };
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms = 0) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function paint() {
  check(document.visibilityState === 'visible', 'Fixture tab is hidden; paint timing is unavailable');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture paint did not finish within 3 seconds')), 3_000);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timeout);
      resolve(undefined);
    }));
  });
}

async function hash(value) {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function stats(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    n: sorted.length, p50Ms: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1), samplesMs,
  };
}

function protocol(smoke = false) {
  return { smoke, rounds: smoke ? 1 : 3, warmups: smoke ? 1 : 5, samples: smoke ? 1 : 30 };
}

async function measure(fn, options) {
  for (let n = 0; n < options.warmups; n += 1) { fn(); await delay(); }
  const samplesMs = [];
  let last;
  for (let n = 0; n < options.samples; n += 1) {
    const start = performance.now();
    last = fn();
    samplesMs.push(performance.now() - start);
    await delay(); // One measured operation per task; yield time is outside the clock.
  }
  return { timing: stats(samplesMs), last };
}

function countedQuery(fn, candidateTitles = new Set()) {
  const original = analyzer.normalize;
  const counts = { normalizeCalls: 0, longNormalizeCalls: 0, longNormalizeChars: 0, candidateNormalizeCalls: 0 };
  analyzer.normalize = function (text) {
    counts.normalizeCalls += 1;
    if (text.length > 1_000) { counts.longNormalizeCalls += 1; counts.longNormalizeChars += text.length; }
    if (candidateTitles.has(text)) counts.candidateNormalizeCalls += 1;
    return original.call(this, text);
  };
  try {
    return { counts, results: fn() };
  } finally {
    analyzer.normalize = original;
  }
}

async function initialize() {
  const pages = Array.from({ length: 1_000 }, (_, n) =>
    page(n + 1, '測試條目' + (n + 1), filler.repeat(10) + ' ordinaryRecord' + n));
  pages.push(...Array.from({ length: 20 }, (_, n) => page(1_001 + n, '長篇資料' + n, longBody)));
  content.rebuild(pages);
  contentSnapshot = content.exportSnapshot();
  const titlePages = Array.from({ length: 2_000 }, (_, n) => page(n + 1, '治療裝備資料' + (n + 1)));
  titles.rebuild([...titlePages, redirectPage(), page(2_002, '浏览器测试普通页'), {
    ...page(2_003, '模块:浏览器测试'), namespace: 828, namespaceName: '模块',
  }]);
  lua.rebuild([{
    ...page(8_281, '模块:浏览器测试', 'local p = {}; function p.test() return "浏览器测试" end; return p'),
    namespace: 828, namespaceName: '模块', contentModel: 'Scribunto',
  }]);
  await database.pages.bulkPut([
    page(7_001, '存储测试页', '本地正文'),
    { ...page(7_002, 'MediaWiki:浏览器测试.css', '.浏览器测试 { color: red; }'),
      namespace: 8, namespaceName: 'MediaWiki', contentModel: 'css' },
  ]);
  await database.syncState.put({ key: 'local-sequence', value: 7_002 });
  await css.refresh(database);
  const search = (mode, fn) => (query, namespace) => {
    calls.push({ mode, query, namespace });
    return fn(query, namespace);
  };
  panel = new SearchPanel({
    prepareSearch: () => undefined, prepareFiles: () => undefined,
    search: search('title', (...args) => titles.search(...args)),
    searchContent: search('content', (...args) => content.search(...args)),
    searchFiles: search('files', query => files.search(query)),
    searchLua: search('lua', query => lua.search(query)),
    searchCss: search('css', query => css.search(query)),
    searchCodes: search('data-code', query => codes.search(query)),
    insert: result => actions.push({ action: 'insert', id: result.id }),
    copyTitle: result => actions.push({ action: 'copy', id: result.id }),
    copy: result => actions.push({ action: 'copy-link', id: result.id }),
    copyCode: result => actions.push({ action: 'copy-code', source: result.source, code: result.code }),
    open: result => actions.push({ action: 'open', id: result.id }),
    openCode: result => actions.push({ action: 'open-code', source: result.source }),
    redirectUrl: target => '#synthetic-' + encodeURIComponent(target.title),
    refresh: () => undefined, refreshFiles: () => undefined,
    saveDataCodeRules: async () => undefined, saveHighlightPreferences: () => undefined,
  });
  panel.setNamespaces([{ id: 0, name: '（主）' }, { id: 828, name: '模块' }]);
  panel.setDataCodeRules('item = .name', 'item = .name');
  panel.setStatus('离线浏览器合成夹具');
  api.ready = true;
}

function redirectPage() {
  const value = page(2_001, '浏览器测试别名');
  return { ...value, isRedirect: true, redirectResolution: {
    sourceTitle: value.title, sourceRevisionId: 1, checkedAt: 1,
    target: { title: '浏览器测试目标', fragment: '测试章节' },
  } };
}

function root() {
  const value = document.querySelector('#cu-wiki-search-host')?.shadowRoot;
  check(value, 'Fixture panel is missing');
  return value;
}

async function setMode(mode) {
  if (!panel.state.visible) panel.open();
  await nextTick();
  const select = root().querySelector('.mode');
  select.value = mode;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
}

async function setQuery(query) {
  const input = root().querySelector('.query');
  input.value = query;
  panel.refreshResults();
  await nextTick();
}

async function resetContentCache() {
  check(!destroyed, 'Fixture has been destroyed');
  await content.importSnapshot(contentSnapshot);
  return { cacheEmpty: true };
}

async function measureQueries(smoke = false) {
  const options = protocol(smoke);
  const rows = [];
  for (let round = 1; round <= options.rounds; round += 1) {
    for (const { category, query } of queries) {
      await resetContentCache();
      const start = performance.now();
      const cold = content.search(query);
      const coldMs = performance.now() - start;
      check(cold.length === 20, 'Synthetic long-page query did not return 20 results');
      const hot = await measure(() => content.search(query), options);
      check(JSON.stringify(hot.last) === JSON.stringify(cold), 'Cold/hot result signature changed');
      await resetContentCache();
      const coldCalls = countedQuery(() => content.search(query));
      const warmCalls = countedQuery(() => content.search(query));
      check(JSON.stringify(coldCalls.results) === JSON.stringify(cold), 'Counted cold result changed');
      check(JSON.stringify(warmCalls.results) === JSON.stringify(cold), 'Counted warm result changed');
      rows.push({
        round, category, query, resultHash: await hash(cold), results: cold.length,
        cold: { n: 1, ms: coldMs }, hot: hot.timing,
        coldCalls: coldCalls.counts, warmCalls: warmCalls.counts,
      });
    }
  }
  const titleSnapshot = titles.exportSnapshot();
  const candidateTitles = new Set(Array.from({ length: 2_000 }, (_, n) => '治療裝備資料' + (n + 1)));
  const titleCounts = [];
  for (let round = 1; round <= options.rounds; round += 1) {
    await titles.importSnapshot(titleSnapshot);
    const cold = countedQuery(() => titles.search('资料'), candidateTitles);
    const warm = countedQuery(() => titles.search('资料'), candidateTitles);
    check(JSON.stringify(cold.results) === JSON.stringify(warm.results), 'Title cache changed results');
    titleCounts.push({
      round, candidatePages: 2_000, returnedResults: cold.results.length,
      coldCalls: cold.counts, warmCalls: warm.counts, resultHash: await hash(cold.results),
    });
  }
  return { protocol: options, corpusHash: await hash(contentSnapshot.extractedById), rows, titleCounts };
}

async function measureInputPaint(smoke = false) {
  const options = protocol(smoke);
  await setMode('content');
  const input = root().querySelector('.query');
  const rows = [];
  for (let round = 1; round <= options.rounds; round += 1) {
    for (const { category, query } of queries) {
      const expected = content.search(query);
      check(expected.length === 20, 'Input benchmark query has no expected long-page rows');
      const samples = [];
      for (let n = -options.warmups; n < options.samples; n += 1) {
        await setQuery('');
        await paint();
        const before = calls.length;
        const start = performance.now();
        input.value = query;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const deadline = performance.now() + 5_000;
        while (calls.length === before) {
          check(performance.now() < deadline, 'Debounced input did not query');
          await delay(2);
        }
        await nextTick();
        await paint();
        const elapsed = performance.now() - start;
        check(root().querySelectorAll('.result').length === expected.length, 'Input result rows were not painted');
        if (n >= 0) samples.push(elapsed);
      }
      rows.push({ round, category, query, results: expected.length,
        resultHash: await hash(panel.state.results), inputToPaint: stats(samples) });
    }
  }
  return { protocol: options, scope: 'Hot input event -> 120ms debounce -> Vue update -> two rAF; blank prep excluded.', rows };
}

async function measureSnapshots(smoke = false) {
  const options = protocol(smoke);
  const referenceJson = JSON.stringify(content.exportSnapshot());
  const payloadHash = await hash(JSON.parse(referenceJson));
  await delay();
  const longTasks = [];
  const supported = PerformanceObserver.supportedEntryTypes.includes('longtask');
  const observer = supported ? new PerformanceObserver(list => {
    longTasks.push(...list.getEntries().map(entry => ({ startMs: entry.startTime, durationMs: entry.duration })));
  }) : undefined;
  observer?.observe({ entryTypes: ['longtask'] });
  try {
    await delay();
    const rows = [];
    const encoder = new TextEncoder();
    let payloadBytes;
    for (let round = 1; round <= options.rounds; round += 1) {
      const serialization = await measure(() => JSON.stringify(content.exportSnapshot()), options);
      check(serialization.last === referenceJson, 'Serialized snapshot changed between rounds');
      const encode = await measure(() => encoder.encode(serialization.last), options);
      payloadBytes = encode.last.byteLength;
      rows.push({ round, exportAndStringify: serialization.timing, encode: encode.timing });
    }
    await delay(50);
    return {
      protocol: options, payloadBytes, payloadHash, rows,
      longTasks: { supported, entries: longTasks },
      scope: 'One serialization/encode per task; no SHA/quota/IDB included in stage timing.',
    };
  } finally {
    observer?.disconnect();
  }
}

async function uiChecks() {
  if (typeof panel.invalidateResults !== 'function') {
    return { status: 'unsupported', reason: 'Baseline has no invalidateResults API; new behavior is not asserted.' };
  }
  const passed = [];
  const invalidate = modes => panel.invalidateResults(modes);
  await setMode('title');
  await setQuery('浏览器测试');
  let before = calls.length;
  invalidate(['files', 'data-code', 'content', 'lua', 'css']);
  panel.setStatus('纯诊断状态');
  await delay(30);
  check(calls.length === before, 'Unrelated mode or status queried title results');
  passed.push('unrelated-mode-and-state');
  invalidate(['title']); invalidate(['title']); invalidate(['title']);
  await delay(30);
  check(calls.length === before + 1, 'Repeated invalidations did not coalesce');
  passed.push('coalesced-invalidations');
  const input = root().querySelector('.query');
  before = calls.length;
  input.value = '浏览器测试';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  invalidate(['title']);
  await delay(60);
  check(calls.length === before, 'External invalidation advanced input debounce');
  await delay(120);
  check(calls.length === before + 1, 'Input debounce and external update queried more than once');
  passed.push('input-debounce-merge');
  panel.close();
  before = calls.length;
  titles.update([page(2_004, '浏览器测试新增')]);
  invalidate(['title']);
  await delay(160);
  check(calls.length === before, 'Hidden panel queried');
  panel.open();
  await delay(30);
  check(calls.length === before + 1 && panel.state.results.some(result => result.id === 2_004),
    'Reopened panel did not consume latest dirty results');
  passed.push('hidden-reopen');
  for (const selector of ['.query', '.data-rules']) {
    if (selector === '.data-rules') { await setMode('data-code'); panel.actions.configure(); await nextTick(); }
    before = calls.length;
    const control = root().querySelector(selector);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    invalidate([panel.state.mode]);
    await delay(160);
    check(calls.length === before, 'Query ran during composition in ' + selector);
    control.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await delay(30);
    check(calls.length === before + 1, 'Composition end did not resume exactly once in ' + selector);
    passed.push('ime-' + selector);
  }
  await setMode('title');
  await setQuery('浏览器测试');
  before = calls.length;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await setMode('content');
  const afterMode = calls.length;
  await delay(160);
  check(afterMode === before + 1 && calls.length === afterMode, 'Old timer survived mode change');
  passed.push('mode-consumes-timer');
  await setMode('title');
  await setQuery('浏览器测试');
  const namespace = root().querySelector('.namespace');
  namespace.value = '828'; namespace.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  check(panel.state.results.every(result => result.namespace === 828), 'Namespace filter failed');
  before = calls.length;
  panel.setNamespaces([{ id: 0, name: '（主）' }]);
  await delay(30);
  check(panel.state.namespace === '' && calls.length === before + 1, 'Removed namespace did not invalidate');
  const namespaces = panel.state.namespaces;
  panel.setNamespaces([{ id: 0, name: '（主）' }]);
  check(panel.state.namespaces === namespaces, 'Unchanged namespace options were replaced');
  passed.push('namespace-filter-delete-stability');
  await setQuery('浏览器测试');
  const link = root().querySelector('.redirect-target');
  check(link, 'Synthetic redirect link is missing');
  link.focus(); await nextTick();
  titles.update([page(2_005, '浏览器测试')]);
  invalidate(['title']); await delay(30);
  check(panel.state.results[panel.state.selectedIndex]?.id === 2_001, 'Background refresh changed selected identity');
  check(root().activeElement === link && link.isConnected, 'Background refresh moved redirect focus');
  titles.update([{ ...redirectPage(), deleted: true }]);
  invalidate(['title']); await delay(30);
  check(root().activeElement === input && panel.state.selectedIndex === 0, 'Removed result focus was not repaired');
  passed.push('selection-and-redirect-focus');
  await setMode('data-code');
  await setQuery('浏览器测试');
  panel.actions.select(1);
  const selectedSource = panel.state.results[1].source;
  codes = new DataCodeIndex(analyzer, [...dataRecords].reverse());
  invalidate(['data-code']); await delay(30);
  check(panel.state.results[panel.state.selectedIndex]?.source === selectedSource,
    'Data selection lost source/code identity');
  passed.push('data-selection');
  const modeRows = [];
  for (const mode of ['title', 'content', 'data-code', 'lua', 'css', 'files']) {
    const query = mode === 'content' ? '恢复健康' : '浏览器测试';
    await setQuery(query);
    before = calls.length;
    await setMode(mode);
    check(calls.at(-1)?.mode === mode && calls.length === before + 1, 'Wrong callback for ' + mode);
    check(panel.state.results.length > 0, 'Synthetic backend returned no rows for ' + mode);
    modeRows.push({ mode, query, results: panel.state.results.length });
  }
  passed.push('six-mode-routing');
  invalidate([panel.state.mode]);
  before = calls.length;
  panel.destroy();
  await delay(160);
  check(calls.length === before, 'Destroyed panel queried from a timer');
  passed.push('destroy-cancels-timer');
  return { status: 'passed', passed, modeRows, callbackActionScope: api.meta.controls };
}

async function cacheChecks() {
  if (typeof panel.invalidateResults !== 'function') return { status: 'unsupported' };
  await resetContentCache();
  const cold = countedQuery(() => content.search('恢复健康'));
  const warm = countedQuery(() => content.search('恢复健康'));
  check(cold.counts.longNormalizeCalls === 20 && warm.counts.longNormalizeCalls === 0,
    'Long-page lazy cache did not normalize once per page');
  const local = new ContentIndex(analyzer);
  local.rebuild([page(99_001, '摘要更新测试', longBody)]);
  local.search('恢复健康');
  local.update([page(99_001, '摘要更新测试', '完全不同的新内容')]);
  check(local.search('恢复健康').length === 0, 'Update returned an old cached snippet');
  local.update([{ ...page(99_001, '摘要更新测试', longBody), deleted: true }]);
  check(local.size === 0, 'Tombstoned cache page remained indexed');
  local.rebuild([page(99_001, '超预算摘要', '恢復健康')]);
  const payload = local.exportSnapshot();
  // Tail terms stay indexed; the imported extracted text isolates cache budgeting
  // without spending millions of tokens on repetitive filler during this check.
  const oversize = filler.repeat(Math.ceil((8 * 1024 * 1024 / 2 + 1) / filler.length)) + ' 恢復健康';
  payload.extractedById[0][1] = oversize;
  await local.importSnapshot(payload);
  const first = countedQuery(() => local.search('恢复健康'));
  const repeated = countedQuery(() => local.search('恢复健康'));
  check(first.counts.longNormalizeCalls === 1 && repeated.counts.longNormalizeCalls === 1,
    'Over-budget single page was cached');
  check(first.results[0]?.snippet.includes('恢复健康') &&
    JSON.stringify(first.results) === JSON.stringify(repeated.results), 'Over-budget tail snippet changed');
  return {
    status: 'passed', coldCalls: cold.counts, warmCalls: warm.counts,
    updateDelete: 'passed', overBudget: {
      normalizedTextBytesEstimate: analyzer.normalize(oversize).length * 2,
      normalizationCalls: [first.counts.longNormalizeCalls, repeated.counts.longNormalizeCalls],
      resultHash: await hash(first.results), snippet: first.results[0].snippet,
      scope: 'Imported synthetic snapshot tail terms, not a full oversize index-build benchmark.',
    },
  };
}

async function storageChecks() {
  if (typeof panel.invalidateResults !== 'function') return { status: 'unsupported' };
  cache = new VersionedSearchIndexCache(database);
  const handle = await cache.restoreOrRebuild('title', analyzer);
  let reads = 0;
  let serializations = 0;
  const get = database.indexSnapshots.get.bind(database.indexSnapshots);
  const exportSnapshot = handle.index.exportSnapshot.bind(handle.index);
  database.indexSnapshots.get = (...args) => { reads += 1; return get(...args); };
  handle.index.exportSnapshot = () => { serializations += 1; return exportSnapshot(); };
  try {
    cache.schedulePublish(handle);
    const published = await cache.publish(handle);
    check(published.status === 'published', 'Fixture immediate publication failed');
    const duringExplicit = { reads, serializations };
    await delay(5_200);
    check(reads === duringExplicit.reads && serializations === duringExplicit.serializations,
      'Consumed 5-second publish timer performed residual work');
    const residual = { reads: reads - duringExplicit.reads, serializations: serializations - duringExplicit.serializations };
    const concurrent = await concurrentPublicationChecks();
    return { status: 'passed', delayMs: 5_200, duringExplicit,
      residual, concurrent };
  } finally {
    database.indexSnapshots.get = get;
    handle.index.exportSnapshot = exportSnapshot;
    await cache.clear();
    cache = undefined;
  }
}

async function concurrentPublicationChecks() {
  const writer = new WikiSearchDatabase(database.name);
  const results = [];
  await writer.open();
  try {
    for (const race of ['sequence', 'clear']) {
      let release;
      const blocked = new Promise(resolve => { release = resolve; });
      let entered;
      const paused = new Promise(resolve => { entered = resolve; });
      const contender = new VersionedSearchIndexCache(database, {
        storage: { estimate: async () => {
          entered(); await blocked;
          return { usage: 0, quota: 1024 * 1024 * 1024 };
        } },
      });
      const handle = await contender.restoreOrRebuild(race === 'sequence' ? 'content' : 'title', analyzer);
      const publishing = contender.publish(handle);
      try {
        await Promise.race([paused, publishing.then(() => { throw new Error('Publication did not reach quota gate'); })]);
        if (race === 'sequence') {
          await writer.transaction('rw', writer.pages, writer.syncState, async () => {
            await writer.pages.put(page(7_003, '并发写入测试', '并发正文 freshmarker'));
            await writer.syncState.put({ key: 'local-sequence', value: 7_003 });
          });
          await contender.refresh(handle);
        } else {
          await new VersionedSearchIndexCache(writer).clear();
        }
      } finally { release(); }
      const result = await publishing;
      const reason = race === 'sequence' ? 'sequence-changed' : 'cleared-this-session';
      check(result.status === 'skipped' && result.reason === reason, 'Unsafe concurrent candidate: ' + race);
      if (race === 'sequence') {
        const retried = await contender.publish(handle);
        check(retried.status === 'published' && retried.record.throughLocalSeq === 7_003 &&
          retried.record.json.includes('freshmarker'), 'Concurrent update was lost after retry');
      } else {
        check(await writer.indexSnapshots.count() === 0, 'A cleared candidate wrote back');
      }
      results.push({ race, reason, status: 'passed' });
    }
    return { connection: 'Second connection to the same synthetic IndexedDB only', results };
  } finally { writer.close(); }
}
