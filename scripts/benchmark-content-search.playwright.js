// SPDX-License-Identifier: MPL-2.0
// Run through scripts/run-browser-playwright.sh with the current build installed.
// Creates a temporary edit tab, reads/warms its local indexes, and closes it.
// No Wiki edit is saved; existing user tabs are never selected or reloaded.
// Configuration: CU_WIKI_EXPECTED_VERSION, CU_WIKI_EXPECTED_MARKER,
// CU_WIKI_BENCHMARK_EDIT_URL. Defaults identify the validated 0.3.9 final build.
// The tested playwright-cli run-code VM does not expose process; environment
// overrides are unavailable there. Copy this script into ignored .local/ and
// change the defaults below when testing another installed version or marker.
async page => {
  const environment = typeof process === 'undefined' ? {} : process.env;
  const expectedVersion = environment.CU_WIKI_EXPECTED_VERSION ?? '0.3.9';
  const expectedMarker = environment.CU_WIKI_EXPECTED_MARKER ??
    'CU_WIKI_BUILD_ID:local022-027-final-039-r2-20261003';
  const editUrl = environment.CU_WIKI_BENCHMARK_EDIT_URL ??
    'https://casualtiesunknown.huijiwiki.com/index.php?title=12%E5%8F%B7%E9%B9%BF%E5%BC%B9&action=edit';
  const target = new URL(editUrl);
  if (target.origin !== 'https://casualtiesunknown.huijiwiki.com' ||
      target.searchParams.get('action') !== 'edit') throw new Error('Expected a Wiki edit URL');
  const tab = await page.context().newPage();
  try {
    await tab.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await tab.bringToFront();
    await tab.waitForFunction(() => window.__CU_WIKI_SEARCH__?.ready === true,
      undefined, { timeout: 60000 });
    const initial = await tab.evaluate(() => {
      const debug = window.__CU_WIKI_SEARCH__;
      return { version: debug.scriptVersion, marker: debug.buildId,
        indexedContentPages: debug.indexedContentPages, userAgent: navigator.userAgent };
    });
    if (initial.version !== expectedVersion || initial.marker !== expectedMarker) {
      throw new Error('Unexpected installed version/marker: ' + JSON.stringify({
        version: initial.version, marker: initial.marker,
      }));
    }
    const host = tab.locator('#cu-wiki-search-host');
    await host.locator('.toggle').click();
    await host.locator('.mode').selectOption('content');
    await tab.waitForFunction(() => {
      const debug = window.__CU_WIKI_SEARCH__;
      return debug?.contentReadyMs !== undefined && debug.indexedContentPages >= 1500;
    },
      undefined, { timeout: 120000 });

    // Retain the original 12-English-word warm-once/sample-once regression exactly.
    const queries = [
      'sleepQuality',
      'blastResistance',
      'scarf',
      'worldFluid',
      'criticalExpression',
      'assets',
      'entries',
      'aliases',
      'groundwater',
      'health',
      'wearableArmor',
      'footstep',
    ];
    await tab.evaluate((values) => {
      for (const query of values) window.__CU_WIKI_SEARCH__.searchContent(query);
    }, queries);
    const durations = await tab.evaluate((values) => {
      return values.map((query) => {
        const startedAt = performance.now();
        const resultCount = window.__CU_WIKI_SEARCH__.searchContent(query).length;
        return { query, resultCount, milliseconds: performance.now() - startedAt };
      });
    }, queries);
    const sorted = durations.map(({ milliseconds }) => milliseconds).sort((a, b) => a - b);
    const documentCount = await tab.evaluate(() => window.__CU_WIKI_SEARCH__.indexedContentPages);
    const report = {
      documentCount,
      p50Ms: sorted[Math.floor(sorted.length * 0.5)],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      maxMs: sorted.at(-1),
      durations,
      initial,
      browserVersion: tab.context().browser()?.version(),
      legacyScope: 'Original 12 English queries, warm once and sample each once; percentiles unchanged.',
    };
    if ((report.p95Ms ?? Infinity) > 150) {
      throw new Error('正文英文键查询 p95 超过 150ms：' + JSON.stringify(report));
    }

    const groups = [
      { category: 'chinese', queries: ['治疗', '药物', '睡眠'] },
      { category: 'simplified', queries: ['恢复健康', '装备', '医疗'] },
      { category: 'traditional', queries: ['恢復健康', '裝備', '醫療'] },
      { category: 'disjoint-terms', queries: ['睡眠 健康', '治疗 药物', '医用 兴奋剂'] },
    ];
    report.additionalQueries = await tab.evaluate(async groups => {
      const rows = [];
      const sleep = () => new Promise(resolve => setTimeout(resolve, 0));
      const hash = async result => {
        const digest = await crypto.subtle.digest('SHA-256',
          new TextEncoder().encode(JSON.stringify(result)));
        return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      };
      for (const { category, queries } of groups) {
        for (const query of queries) {
          let reference;
          for (let warmup = 0; warmup < 5; warmup += 1) {
            reference = window.__CU_WIKI_SEARCH__.searchContent(query);
            await sleep();
          }
          const referenceJson = JSON.stringify(reference);
          const samplesMs = [];
          let result;
          for (let sample = 0; sample < 30; sample += 1) {
            const startedAt = performance.now();
            result = window.__CU_WIKI_SEARCH__.searchContent(query);
            const elapsed = performance.now() - startedAt;
            if (JSON.stringify(result) !== referenceJson) {
              throw new Error('Unstable Wiki content results for ' + query +
                ' at sample ' + (sample + 1) + '; background changes invalidate this measurement');
            }
            samplesMs.push(elapsed);
            await sleep();
          }
          const sorted = [...samplesMs].sort((a, b) => a - b);
          rows.push({ category, query, results: result.length, resultHash: await hash(result),
            n: samplesMs.length, p50Ms: sorted[Math.floor(sorted.length * 0.5)],
            p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1), samplesMs });
        }
      }
      return { warmups: 5, samples: 30, rows,
        scope: 'Per-query hot function timing; full results checked against warmed reference outside the clock; no cold-cache claim.' };
    }, groups);

    report.inputToPaint = [];
    for (const { category, query } of [
      { category: 'direct-english', query: 'sleepQuality' },
      { category: 'simplified', query: '恢复健康' },
      { category: 'disjoint-terms', query: '睡眠 健康' },
    ]) {
      const expected = await tab.evaluate(query => {
        const result = window.__CU_WIKI_SEARCH__.searchContent(query);
        return { count: result.length };
      }, query);
      if (!expected.count) {
        report.inputToPaint.push({ category, query, skipped: 'No current Wiki result rows for this query.' });
        continue;
      }
      const samplesMs = [];
      let renderedHash;
      for (let sample = -5; sample < 30; sample += 1) {
        // Blank preparation is explicit and outside the timed input path.
        await tab.evaluate(() => {
          const root = document.querySelector('#cu-wiki-search-host').shadowRoot;
          const input = root.querySelector('.query');
          input.value = '';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          root.querySelector('.mode').dispatchEvent(new Event('change', { bubbles: true }));
        });
        await tab.waitForFunction(() => {
          const root = document.querySelector('#cu-wiki-search-host')?.shadowRoot;
          return root?.querySelector('.query')?.value === '' && root.querySelectorAll('.result').length === 0;
        }, undefined, { timeout: 10000 });
        const measured = await tab.evaluate(async ({ query, count }) => {
          if (document.visibilityState !== 'visible') throw new Error('Benchmark tab is hidden');
          const root = document.querySelector('#cu-wiki-search-host').shadowRoot;
          const input = root.querySelector('.query');
          const start = performance.now();
          input.value = query;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          const deadline = performance.now() + 10000;
          while (root.querySelectorAll('.result').length !== count) {
            if (performance.now() > deadline) throw new Error('Timed input did not paint expected rows');
            await new Promise(resolve => setTimeout(resolve, 2));
          }
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Paint did not finish within 3 seconds')), 3000);
            requestAnimationFrame(() => requestAnimationFrame(() => {
              clearTimeout(timeout);
              resolve();
            }));
          });
          const milliseconds = performance.now() - start;
          const digest = await crypto.subtle.digest('SHA-256',
            new TextEncoder().encode(root.querySelector('.results').textContent));
          return { milliseconds,
            renderedHash: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') };
        }, { query, count: expected.count });
        if (renderedHash !== undefined && measured.renderedHash !== renderedHash) {
          throw new Error('Unstable painted Wiki results for ' + query +
            ' at sample ' + (sample + 6) + '; background changes invalidate this measurement');
        }
        if (sample >= 0) samplesMs.push(measured.milliseconds);
        renderedHash ??= measured.renderedHash;
      }
      const sorted = [...samplesMs].sort((a, b) => a - b);
      report.inputToPaint.push({ category, query, results: expected.count, warmups: 5, n: 30,
        p50Ms: sorted[Math.floor(sorted.length * 0.5)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
        maxMs: sorted.at(-1), samplesMs, renderedHash });
    }
    report.inputScope = 'Hot input event -> 120ms debounce -> rendered rows -> two rAF; per-group painted signatures checked outside the clock; blank preparation excluded.';
    report.finalDocumentCount = await tab.evaluate(() => window.__CU_WIKI_SEARCH__.indexedContentPages);
    return report;
  } finally {
    try {
      if (!tab.isClosed()) await tab.close();
    } finally {
      if (!page.isClosed()) await page.bringToFront();
    }
  }
}
