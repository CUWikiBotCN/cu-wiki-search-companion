// SPDX-License-Identifier: MPL-2.0
// Offline production-source benchmark. All documents and databases are synthetic.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    root: { type: 'string', default: runnerRoot },
    output: { type: 'string' },
    suite: { type: 'string', default: 'search,storage' },
    smoke: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
const root = resolve(values.root);

if (values.help) {
  process.stdout.write(
    [
      'Usage: node scripts/benchmark-local-search.mjs [options]',
      '',
      '  --root PATH       Load production source/config from another checkout.',
      '  --output FILE     Write the JSON report to this file; otherwise use stdout.',
      '  --suite NAMES     search, storage, bundle, or all (default: search,storage).',
      '  --smoke           Tiny correctness run; its timings are not performance evidence.',
      '  --help, -h        Show this help.',
      '',
      'Normal search runs: 3 rounds, 5 warmups, 30 samples per hot query/stage.',
      'Cold queries: one first query with an empty cache per case/round (n=1).',
      'Import/build time is outside query timing; call counters run separately.',
      'Storage uses fake-indexeddb; bundle uses production Vite config/write:false.',
      'This measures Node query/serialization work, not browser latency or heap.',
      '',
    ].join('\n'),
  );
} else {
  try {
    const requestedSuites =
      values.suite === 'all'
        ? ['search', 'storage', 'bundle']
        : values.suite.split(',');
    assert.ok(
      requestedSuites.length &&
        requestedSuites.every((suite) =>
          ['search', 'storage', 'bundle'].includes(suite),
        ),
      'Unknown suite; use search,storage,bundle or all',
    );
    const suites = new Set(requestedSuites);
    const packageInfo = JSON.parse(
      await readFile(resolve(root, 'package.json'), 'utf8'),
    );
    const protocol = {
      smoke: values.smoke,
      rounds: values.smoke ? 1 : 3,
      warmups: values.smoke ? 1 : 5,
      hotSamples: values.smoke ? 1 : 30,
      coldSamplesPerCaseAndRound: 1,
      coldPreparation:
        'Content uses snapshot import; titles use a fresh rebuild. Preparation is not timed.',
      percentile: 'Sorted samples: p50 at floor(n*0.5), p95 at ceil(n*0.95)-1.',
      resultHash:
        'SHA-256 of the full JSON result (ids, order, scores, snippets, metadata, highlights).',
      callCounts:
        'Separate untimed cold/warm queries; instrumentation is absent from timed samples.',
    };
    const report = {
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpu: cpus()[0]?.model,
        sourceRevision: git(['rev-parse', 'HEAD']),
        trackedSourceDirty: Boolean(
          git(['status', '--porcelain', '--untracked-files=no']),
        ),
        sourceVersion: packageInfo.version,
        dependencies: packageInfo.dependencies,
        devDependencies: packageInfo.devDependencies,
      },
      protocol,
      scope: [
        'Synthetic offline corpus using production TypeScript loaded through Vite SSR.',
        'No Wiki/API requests, real IndexedDB, browser timing, startup timing, or heap measurement.',
        'Storage reports calls and rows; fake-indexeddb latency is not browser disk latency.',
        'Snapshot stages exclude SHA, quota checks, IndexedDB writes, and index restoration.',
        'Bundle bytes/gzip are paired in-memory builds; size reductions are not startup speedups.',
        'Bootstrap refresh, runtime publication scheduling, and UI/focus/IME use correctness tests.',
      ],
    };
    const { createServer, build, loadConfigFromFile } = await import('vite');
    if (suites.has('storage')) await import('fake-indexeddb/auto');
    if (suites.has('search') || suites.has('storage')) {
      const server = await createServer({
        root,
        configFile: false,
        logLevel: 'silent',
        appType: 'custom',
        server: { middlewareMode: true, hmr: false, watch: null },
      });
      try {
        if (suites.has('search'))
          report.search = await searchSuite(server, protocol);
        if (suites.has('storage'))
          report.storage = await storageSuite(server, protocol);
      } finally {
        await server.close();
      }
    }
    if (suites.has('bundle'))
      report.bundle = await bundleSuite(build, loadConfigFromFile);
    const json = JSON.stringify(report, null, 2) + '\n';
    if (values.output) await writeFile(resolve(values.output), json);
    else process.stdout.write(json);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error))
      .replaceAll(root, '[source-root]')
      .replaceAll(runnerRoot, '[runner-root]');
    process.stderr.write('Offline benchmark failed: ' + message + '\n');
    process.exitCode = 1;
  }
}

function git(args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function resultHash(result) {
  return sha256(JSON.stringify(result));
}

function timedQuery(fn) {
  const started = performance.now();
  const result = fn();
  return { ms: performance.now() - started, result };
}

function measure(fn, protocol) {
  for (let sample = 0; sample < protocol.warmups; sample += 1) fn();
  const samplesMs = [];
  let lastResult;
  for (let sample = 0; sample < protocol.hotSamples; sample += 1) {
    const timed = timedQuery(fn);
    samplesMs.push(timed.ms);
    lastResult = timed.result;
  }
  const sorted = [...samplesMs].sort((left, right) => left - right);
  return {
    timing: {
      n: sorted.length,
      p50Ms: sorted[Math.floor(sorted.length * 0.5)],
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      maxMs: sorted.at(-1),
      samplesMs,
    },
    lastResult,
  };
}

function countAnalyzerCalls(analyzer, fn, candidateTitles = new Set()) {
  const normalize = analyzer.normalize;
  const compact = analyzer.compact;
  const counts = {
    normalizeCalls: 0,
    normalizeChars: 0,
    longNormalizeCalls: 0,
    longNormalizeChars: 0,
    candidateNormalizeCalls: 0,
    compactCalls: 0,
    candidateCompactCalls: 0,
  };
  analyzer.normalize = function (text) {
    counts.normalizeCalls += 1;
    counts.normalizeChars += text.length;
    if (text.length > 1_000) {
      counts.longNormalizeCalls += 1;
      counts.longNormalizeChars += text.length;
    }
    if (candidateTitles.has(text)) counts.candidateNormalizeCalls += 1;
    return normalize.call(this, text);
  };
  analyzer.compact = function (text) {
    counts.compactCalls += 1;
    if (candidateTitles.has(text)) counts.candidateCompactCalls += 1;
    return compact.call(this, text);
  };
  try {
    const results = fn();
    return {
      ...counts,
      results: results.length,
      resultHash: resultHash(results),
    };
  } finally {
    analyzer.normalize = normalize;
    analyzer.compact = compact;
  }
}

function page(analyzer, id, title, content) {
  return {
    id,
    title,
    normalizedTitle: analyzer.normalize(title),
    namespace: 0,
    namespaceName: '',
    localSeq: id,
    isRedirect: false,
    contentModel: 'wikitext',
    content,
    revisionId: 1,
    contentRevisionId: 1,
  };
}

async function searchSuite(server, protocol) {
  const { cut, cut_for_search } = await import('jieba-wasm/node');
  const { Analyzer } = await server.ssrLoadModule('/src/analyzer/analyzer.ts');
  const { ContentIndex } = await server.ssrLoadModule(
    '/src/search/content-index.ts',
  );
  const { TitleIndex, LinearTitleIndex } = await server.ssrLoadModule(
    '/src/search/title-index.ts',
  );
  const analyzer = new Analyzer({ cut, cutForSearch: cut_for_search }, 'jieba');
  const filler =
    '這是一段用於評估搜尋效能的測試文字，包含藥物、治療與裝備資訊。';
  const queries = [
    { category: 'direct-english', query: 'sleepQuality' },
    { category: 'simplified-fallback', query: '恢复健康' },
    { category: 'disjoint-terms', query: '睡眠 健康' },
    { category: 'traditional-direct', query: '恢復健康' },
    { category: 'english-case', query: 'SLEEPQUALITY' },
    { category: 'full-width', query: 'ｓｌｅｅｐＱｕａｌｉｔｙ' },
    { category: 'single-cjk', query: '眠' },
    { category: 'mixed-terms', query: 'sleepQuality 健康' },
  ];
  const results = { content: [], titles: [], snapshots: [] };
  for (let round = 1; round <= protocol.rounds; round += 1) {
    for (const largeCount of protocol.smoke ? [1] : [1, 5, 20]) {
      const pages = Array.from(
        { length: protocol.smoke ? 20 : 1_000 },
        (_, offset) =>
          page(
            analyzer,
            offset + 1,
            '測試條目' + (offset + 1),
            filler.repeat(10) + ' ordinaryRecord' + offset,
          ),
      );
      for (let offset = 0; offset < largeCount; offset += 1) {
        pages.push(
          page(
            analyzer,
            1_001 + offset,
            '長篇資料' + offset,
            filler.repeat(protocol.smoke ? 10 : 3_600) +
              ' sleepQuality 高品質睡眠可以恢復健康。',
          ),
        );
      }
      const index = new ContentIndex(analyzer);
      const started = performance.now();
      index.rebuild(pages);
      const buildMs = performance.now() - started;
      const snapshot = index.exportSnapshot();
      const dataset = {
        round,
        largeCount,
        totalPages: pages.length,
        longPageChars: pages.at(-1).content.length,
        corpusHash: resultHash(pages),
      };
      for (const { category, query } of queries) {
        await index.importSnapshot(snapshot);
        const cold = timedQuery(() => index.search(query));
        assert.equal(
          cold.result.length,
          largeCount,
          'Unexpected synthetic content result count',
        );
        const hot = measure(() => index.search(query), protocol);
        assert.deepEqual(
          hot.lastResult,
          cold.result,
          'Cold/hot content result mismatch',
        );
        // Restore again so call counts observe the first fallback, not a cache hit.
        await index.importSnapshot(snapshot);
        const coldCalls = countAnalyzerCalls(analyzer, () =>
          index.search(query),
        );
        const warmCalls = countAnalyzerCalls(analyzer, () =>
          index.search(query),
        );
        const signature = resultHash(cold.result);
        assert.equal(coldCalls.resultHash, signature);
        assert.equal(warmCalls.resultHash, signature);
        results.content.push({
          ...dataset,
          category,
          query,
          buildMs,
          results: cold.result.length,
          resultHash: signature,
          cold: { n: 1, ms: cold.ms },
          hot: hot.timing,
          coldCalls,
          warmCalls,
        });
      }
      const exported = measure(
        () => JSON.stringify(index.exportSnapshot()),
        protocol,
      );
      const json = exported.lastResult;
      const encoder = new TextEncoder();
      const encoded = measure(() => encoder.encode(json), protocol);
      const parsed = measure(() => JSON.parse(json), protocol);
      assert.equal(encoded.lastResult.byteLength, Buffer.byteLength(json));
      assert.equal(parsed.lastResult.miniSearch.documentCount, pages.length);
      results.snapshots.push({
        ...dataset,
        payloadBytes: encoded.lastResult.byteLength,
        payloadHash: sha256(json),
        exportAndStringify: exported.timing,
        encode: encoded.timing,
        parse: parsed.timing,
      });
    }
    const titles = Array.from(
      { length: protocol.smoke ? 20 : 2_000 },
      (_, offset) =>
        page(analyzer, offset + 1, '治療裝備資料' + (offset + 1), ''),
    );
    const candidateTitles = new Set(titles.map(({ title }) => title));
    const primary = new TitleIndex(analyzer);
    primary.rebuild(titles);
    const snapshot = primary.exportSnapshot();
    const cold = timedQuery(() => primary.search('资料'));
    const hot = measure(() => primary.search('资料'), protocol);
    assert.deepEqual(
      hot.lastResult,
      cold.result,
      'Cold/hot title result mismatch',
    );
    await primary.importSnapshot(snapshot);
    const coldCalls = countAnalyzerCalls(
      analyzer,
      () => primary.search('资料'),
      candidateTitles,
    );
    const warmCalls = countAnalyzerCalls(
      analyzer,
      () => primary.search('资料'),
      candidateTitles,
    );
    assert.equal(coldCalls.resultHash, resultHash(cold.result));
    assert.equal(warmCalls.resultHash, resultHash(cold.result));
    const linear = new LinearTitleIndex(analyzer, titles);
    const fallback = measure(() => linear.search('资料'), protocol);
    results.titles.push({
      round,
      pages: titles.length,
      corpusHash: resultHash(titles),
      query: '资料',
      results: cold.result.length,
      resultHash: resultHash(cold.result),
      cold: { n: 1, ms: cold.ms },
      hot: hot.timing,
      coldCalls,
      warmCalls,
      linear: {
        ...fallback.timing,
        resultHash: resultHash(fallback.lastResult),
      },
    });
  }
  return results;
}

async function storageSuite(server, protocol) {
  const { WikiSearchDatabase } = await server.ssrLoadModule(
    '/src/storage/database.ts',
  );
  const { syncContent, prepareContentJobs } = await server.ssrLoadModule(
    '/src/sync/content-sync.ts',
  );
  const { VersionedSearchIndexCache } = await server.ssrLoadModule(
    '/src/search/versioned-search-index-cache.ts',
  );
  const { Analyzer, createBootstrapSegmenter } = await server.ssrLoadModule(
    '/src/analyzer/analyzer.ts',
  );
  const rounds = [];
  for (let round = 1; round <= protocol.rounds; round += 1) {
    const database = new WikiSearchDatabase(
      'offline-search-benchmark-' + crypto.randomUUID(),
    );
    const analyzer = new Analyzer(createBootstrapSegmenter(), 'bootstrap');
    const pageCount = 100;
    const body = '正文'.repeat(2_048);
    let cache;
    try {
      const pages = Array.from({ length: pageCount }, (_, offset) => ({
        ...page(analyzer, offset + 1, '条目' + offset, body),
        namespaceName: '主',
        deleted: false,
      }));
      await database.pages.bulkPut(pages);
      await database.syncState.put({ key: 'local-sequence', value: pageCount });
      await prepareContentJobs(database, false);
      let pagePasses = 0;
      let pageRows = 0;
      let networkCalls = 0;
      const originalEach = database.pages.each.bind(database.pages);
      database.pages.each = (callback) => {
        pagePasses += 1;
        return originalEach((row, cursor) => {
          pageRows += 1;
          callback(row, cursor);
        });
      };
      const progress = await syncContent(
        database,
        {
          query: async () => {
            networkCalls += 1;
            throw new Error(
              'Unexpected request in fully cached offline content sync',
            );
          },
        },
        { requestIntervalMs: 0 },
      );
      database.pages.each = originalEach;
      assert.equal(networkCalls, 0);
      assert.equal(pageRows, pagePasses * pageCount);
      assert.deepEqual(progress, {
        total: pageCount,
        done: pageCount,
        pending: 0,
        failed: 0,
      });
      cache = new VersionedSearchIndexCache(database);
      const handle = await cache.restoreOrRebuild('title', analyzer);
      assert.equal((await cache.publish(handle)).status, 'published');
      let snapshotGets = 0;
      let returnedJsonChars = 0;
      const originalGet = database.indexSnapshots.get.bind(
        database.indexSnapshots,
      );
      database.indexSnapshots.get = async (key) => {
        snapshotGets += 1;
        const record = await originalGet(key);
        returnedJsonChars += record?.json.length ?? 0;
        return record;
      };
      const publication = await cache.publish(handle);
      database.indexSnapshots.get = originalGet;
      assert.deepEqual(publication, { status: 'skipped', reason: 'not-newer' });
      assert.equal(snapshotGets, 1);
      let appliedRows = 0;
      let rowsWithContent = 0;
      const originalUpdate = handle.index.updateAsync.bind(handle.index);
      handle.index.updateAsync = (rows, ...args) => {
        appliedRows += rows.length;
        rowsWithContent += rows.filter((row) => 'content' in row).length;
        return originalUpdate(rows, ...args);
      };
      await database.pages.put({
        ...pages[0],
        title: '改名条目',
        normalizedTitle: analyzer.normalize('改名条目'),
        localSeq: pageCount + 1,
      });
      await database.syncState.put({
        key: 'local-sequence',
        value: pageCount + 1,
      });
      const replayed = await cache.refresh(handle);
      assert.equal(replayed, 1);
      assert.equal(appliedRows, 1);
      assert.equal(handle.throughLocalSeq, pageCount + 1);
      const titleReplay = { replayed, appliedRows, rowsWithContent };
      await database.fileResources.put({
        ...page(analyzer, 50_000, '文件:offline.png', ''),
        namespace: 6,
        namespaceName: '文件',
        localSeq: pageCount + 2,
      });
      await database.syncState.put({
        key: 'local-sequence',
        value: pageCount + 2,
      });
      const fileOnlyReplay = await cache.refresh(handle);
      assert.equal(fileOnlyReplay, 0);
      assert.equal(handle.throughLocalSeq, pageCount + 2);
      assert.equal(handle.index.size, pageCount);
      rounds.push({
        round,
        database: 'fake-indexeddb (disposable memory only)',
        dataset: {
          pages: pageCount,
          bodyCharsPerPage: body.length,
          corpusHash: resultHash(pages),
        },
        noOpContentSync: { pagePasses, pageRows, networkCalls, progress },
        noOpPublish: { snapshotGets, returnedJsonChars, publication },
        titleReplay,
        fileOnlyReplay: {
          replayed: fileOnlyReplay,
          throughLocalSeq: handle.throughLocalSeq,
        },
      });
    } finally {
      if (cache) await cache.clear();
      database.close();
      await database.delete();
    }
  }
  return { rounds };
}

async function bundleSuite(build, loadConfigFromFile) {
  const marker = 'offline-local-search-benchmark';
  const previousMarker = process.env.CU_WIKI_BUILD_ID;
  process.env.CU_WIKI_BUILD_ID = marker;
  try {
    const pair = [];
    for (const entry of ['full', 't2cn']) {
      const loaded = await loadConfigFromFile(
        { command: 'build', mode: 'production' },
        resolve(root, 'vite.config.ts'),
        root,
        'silent',
      );
      assert.ok(loaded, 'Production Vite config is unavailable');
      const config = loaded.config;
      const result = await build({
        ...config,
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          ...(config.plugins ?? []),
          {
            name: 'offline-opencc-entry-comparison',
            enforce: 'pre',
            transform(code, id) {
              if (
                !id.replace(/\?.*$/, '').endsWith('/src/analyzer/analyzer.ts')
              )
                return;
              const importPattern = /from (['"])opencc-js(?:\/t2cn)?\1/;
              if (!importPattern.test(code))
                throw new Error('Expected Analyzer OpenCC import is missing');
              return code.replace(
                importPattern,
                'from "opencc-js' + (entry === 't2cn' ? '/t2cn' : '') + '"',
              );
            },
          },
        ],
        build: { ...config.build, write: false },
      });
      const userscripts = (Array.isArray(result) ? result : [result])
        .flatMap((part) => part.output)
        .filter((item) => item.fileName.endsWith('.user.js'));
      assert.equal(userscripts.length, 1, 'Expected one userscript bundle');
      const artifact = userscripts[0];
      const source =
        artifact.type === 'asset' ? artifact.source : artifact.code;
      pair.push({
        entry,
        filename: artifact.fileName,
        bytes: Buffer.byteLength(source),
        gzipBytes: gzipSync(source).length,
        sha256: sha256(source),
      });
    }
    return {
      marker: 'CU_WIKI_BUILD_ID:' + marker,
      configuration:
        'Same production config/source/options; force only the OpenCC import; write:false.',
      gzip: 'node:zlib gzipSync defaults for both artifacts',
      pair,
      byteReductionPercent: (1 - pair[1].bytes / pair[0].bytes) * 100,
      gzipReductionPercent: (1 - pair[1].gzipBytes / pair[0].gzipBytes) * 100,
    };
  } finally {
    if (previousMarker === undefined) delete process.env.CU_WIKI_BUILD_ID;
    else process.env.CU_WIKI_BUILD_ID = previousMarker;
  }
}
