// SPDX-License-Identifier: MPL-2.0
// Run through scripts/run-browser-playwright.sh after serving the IIFE fixture:
//   python3 -m http.server 8791 --bind 127.0.0.1 --directory .local/benchmark-browser
// Configuration (only read when the Playwright realm exposes process.env):
// CU_WIKI_BENCHMARK_URL, CU_WIKI_EXPECTED_VERSION, CU_WIKI_EXPECTED_MARKER,
// CU_WIKI_BENCHMARK_PHASE=all or comma-separated heap,search,input,snapshot,ui,cache,storage,
// CU_WIKI_BENCHMARK_SMOKE=1. Explicit defaults below also work without process.env.
// The tested playwright-cli run-code VM does not expose process; environment
// overrides are unavailable there. Copy this script into ignored .local/ and
// change the configuration defaults below for another URL, marker, or phase.
// Never attaches to, reloads, or closes a pre-existing test/user tab.
async page => {
  const environment = typeof process === 'undefined' ? {} : process.env;
  const configuration = {
    url: environment.CU_WIKI_BENCHMARK_URL ?? 'http://127.0.0.1:8791/candidate/index.html',
    version: environment.CU_WIKI_EXPECTED_VERSION ?? '0.3.9',
    marker: environment.CU_WIKI_EXPECTED_MARKER ?? 'CU_WIKI_BUILD_ID:local022-027-browser-candidate',
    phase: environment.CU_WIKI_BENCHMARK_PHASE ?? 'all',
    smoke: environment.CU_WIKI_BENCHMARK_SMOKE === '1',
  };
  const url = new URL(configuration.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('The synthetic browser fixture must use loopback');
  }
  const phases = new Set(configuration.phase.split(',').map(phase => phase.trim()));
  const known = ['all', 'heap', 'search', 'input', 'snapshot', 'ui', 'cache', 'storage'];
  if ([...phases].some(phase => !known.includes(phase))) throw new Error('Unknown fixture benchmark phase');
  const selected = phase => phases.has('all') || phases.has(phase);
  const tab = await page.context().newPage();
  let cdp;
  const report = {};
  try {
    await tab.goto(configuration.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await tab.bringToFront();
    await tab.waitForFunction(() => {
      const fixture = window.__CU_WIKI_BENCHMARK__;
      if (fixture?.error) throw new Error(fixture.error);
      return fixture?.ready;
    }, undefined, { timeout: 60000 });
    report.meta = await tab.evaluate(() => window.__CU_WIKI_BENCHMARK__.meta);
    if (report.meta.sourceVersion !== configuration.version || report.meta.buildMarker !== configuration.marker) {
      throw new Error('Unexpected fixture version/marker: ' + JSON.stringify({
        version: report.meta.sourceVersion, marker: report.meta.buildMarker,
      }));
    }
    report.browserVersion = tab.context().browser()?.version();
    report.smoke = configuration.smoke;
    report.phase = configuration.phase;
    if (selected('heap')) {
      cdp = await tab.context().newCDPSession(tab);
      await tab.evaluate(() => window.__CU_WIKI_BENCHMARK__.resetContentCache());
      const before = await heap();
      const warmed = await tab.evaluate(() => {
        const result = window.__CU_WIKI_BENCHMARK__.warmContentCache();
        return { counts: result.counts, results: result.results.length };
      });
      const after = await heap();
      report.heap = {
        before, after, warmed,
        usedSizeDeltaBytes: after.usedSize - before.usedSize,
        textPayloadEstimateBytes: report.meta.cache.estimatedLongTextPayloadBytes,
        scope: 'CDP GC/heap for this synthetic tab; total delta is not exact cache object size.',
      };
    }
    if (selected('search')) report.search = await tab.evaluate(
      smoke => window.__CU_WIKI_BENCHMARK__.measureQueries(smoke), configuration.smoke);
    if (selected('input')) report.input = await tab.evaluate(
      smoke => window.__CU_WIKI_BENCHMARK__.measureInputPaint(smoke), configuration.smoke);
    if (selected('snapshot')) report.snapshots = await tab.evaluate(
      smoke => window.__CU_WIKI_BENCHMARK__.measureSnapshots(smoke), configuration.smoke);
    if (selected('ui')) report.ui = await tab.evaluate(() => window.__CU_WIKI_BENCHMARK__.uiChecks());
    if (selected('cache')) report.cache = await tab.evaluate(() => window.__CU_WIKI_BENCHMARK__.cacheChecks());
    if (selected('storage')) report.storage = await tab.evaluate(() => window.__CU_WIKI_BENCHMARK__.storageChecks());
  } finally {
    try {
      if (!tab.isClosed()) report.cleanup = await tab.evaluate(async () => {
        const fixture = window.__CU_WIKI_BENCHMARK__;
        return fixture ? fixture.destroy() : { fixtureUnavailable: true };
      });
    } finally {
      try {
        if (cdp) await cdp.detach();
      } finally {
        try {
          if (!tab.isClosed()) await tab.close();
        } finally {
          if (!page.isClosed()) await page.bringToFront();
        }
      }
    }
  }
  return report;

  async function heap() {
    await cdp.send('HeapProfiler.collectGarbage');
    return cdp.send('Runtime.getHeapUsage');
  }
}
