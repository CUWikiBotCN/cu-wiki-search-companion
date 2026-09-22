// SPDX-License-Identifier: MPL-2.0
// Prerequisites: the current build installed in the dedicated browser profile.
// Reads Wiki APIs and populates the normal local cache. Never saves Wiki edits.
// Creates and closes only its own tabs; run via run-browser-playwright.sh.
async page => {
  const tab = await page.context().newPage();
  let targetTab;
  try {
    await tab.goto('https://casualtiesunknown.huijiwiki.com/index.php?title=12%E5%8F%B7%E9%B9%BF%E5%BC%B9&action=edit', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await tab.bringToFront();
    await tab.waitForFunction(() => window.__CU_WIKI_SEARCH__?.ready, undefined, { timeout: 30000 });
    const initial = await tab.evaluate(() => {
      const debug = window.__CU_WIKI_SEARCH__;
      return { version: debug.scriptVersion, buildId: debug.buildId,
        cssCold: debug.indexedCssSources === 0, loggedIn: Boolean(window.mw?.config?.get('wgUserName')),
        hasEditor: Boolean(document.querySelector('#wpTextbox1')) };
    });
    if (!initial.buildId.includes('local014-015')) throw new Error('Install the LOCAL-014/015 build before acceptance');
    const host = tab.locator('#cu-wiki-search-host');
    await host.locator('.toggle').click();
    await host.locator('.query').fill('败血症');
    await host.locator('.redirect-target').filter({ hasText: '感染' }).waitFor({ timeout: 55000 });
    const link = host.locator('.redirect-target').filter({ hasText: '感染' }).first();
    const redirect = await link.evaluate(a => ({ text: a.textContent, href: a.href, independent: !a.closest('button') }));
    if (!redirect.independent || !decodeURIComponent(redirect.href.split('#')[1] ?? '').includes('败血症')) throw new Error('Wrong redirect link');
    [targetTab] = await Promise.all([tab.context().waitForEvent('page', { timeout: 10000 }), link.click()]);
    await targetTab.waitForLoadState('domcontentloaded', { timeout: 30000 });
    const landing = await targetTab.evaluate(() => {
      const id = decodeURIComponent(location.hash.slice(1));
      return { hash: id, anchorExists: Boolean(document.getElementById(id)), title: document.title };
    });
    if (!landing.anchorExists) throw new Error('Redirect section did not resolve to a real anchor');
    await targetTab.close(); targetTab = undefined;
    await tab.bringToFront();
    await host.locator('.mode').selectOption('css');
    await host.locator('.query').fill('color');
    await host.locator('.css-match').first().waitFor({ timeout: 55000 });
    const css = await tab.evaluate(async () => {
      const result = window.__CU_WIKI_SEARCH__.searchCss('color').find(r => r.title === 'MediaWiki:Common.css');
      if (!result) throw new Error('Common.css missing from source search');
      const response = await fetch('/api.php?' + new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', prop: 'revisions', titles: result.title, rvprop: 'content', rvslots: 'main' }));
      const data = await response.json();
      const source = data.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content;
      if (typeof source !== 'string') throw new Error('Cannot verify CSS source');
      const first = source.indexOf('color');
      const expectedLine = source.slice(0, first).split(/\r\n|\r|\n/).length;
      if (result.matches[0].line !== expectedLine) throw new Error('CSS line mismatch');
      return { title: result.title, line: expectedLine, sourceCount: window.__CU_WIKI_SEARCH__.indexedCssSources,
        caseSensitive: window.__CU_WIKI_SEARCH__.searchCss('COLOR_DOES_NOT_EXIST').length === 0 };
    });
    if (await host.locator('.insert-result, .copy-result').count()) throw new Error('CSS must not offer Wiki insertion');
    const geometries = [];
    for (const size of [{ width: 1200, height: 800 }, { width: 360, height: 760 }]) {
      const cdp = await tab.context().newCDPSession(tab);
      try {
        await cdp.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false });
        await tab.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const geometry = await host.locator('.panel').evaluate(panel => ({ width: panel.clientWidth, scrollWidth: panel.scrollWidth, right: panel.getBoundingClientRect().right, viewport: innerWidth }));
        if (geometry.scrollWidth > geometry.width + 1 || geometry.right > geometry.viewport + 1) throw new Error('Panel overflow');
        geometries.push({ ...size, ...geometry });
      } finally { await cdp.send('Emulation.clearDeviceMetricsOverride'); await cdp.detach(); }
    }
    // A new page must restore the downloaded CSS without a revisions request.
    await tab.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await tab.waitForFunction(() => window.__CU_WIKI_SEARCH__?.ready, undefined, { timeout: 30000 });
    const revisionRequests = [];
    const capture = request => { if (/[?&]prop=revisions(?:&|$)/.test(request.url())) revisionRequests.push('/api.php'); };
    tab.on('request', capture);
    await host.locator('.toggle').click();
    await host.locator('.mode').selectOption('css');
    await host.locator('.query').fill('color');
    await host.locator('.css-match').first().waitFor({ timeout: 30000 });
    await tab.waitForFunction(() => document.querySelector('#cu-wiki-search-host')?.shadowRoot?.querySelector('.status')?.textContent?.includes('CSS 同步完成'), undefined, { timeout: 30000 });
    tab.off('request', capture);
    if (revisionRequests.length) throw new Error('Cached CSS was downloaded again');
    return { initial, redirect, landing, css, geometries, cachedReload: true, revisionRequests: revisionRequests.length };
  } finally {
    if (targetTab && !targetTab.isClosed()) await targetTab.close();
    await tab.close();
    if (!page.isClosed()) await page.bringToFront();
  }
}
