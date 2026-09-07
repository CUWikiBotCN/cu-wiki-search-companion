// SPDX-License-Identifier: MPL-2.0
async (page, configuredUserscriptUrl) => {
  const environment = globalThis.process?.env ?? {};
  const wikiOrigin = (
    environment.CU_WIKI_ORIGIN ?? 'https://casualtiesunknown.huijiwiki.com'
  ).replace(/\/+$/, '');
  const editTarget =
    environment.CU_WIKI_INSTALL_EDIT_PATH ??
    '/index.php?title=12%E5%8F%B7%E9%B9%BF%E5%BC%B9&action=edit';
  const editUrl = /^https?:\/\//i.test(editTarget)
    ? editTarget
    : `${wikiOrigin.replace(/\/+$/, '')}/${editTarget.replace(/^\/+/, '')}`;
  const userscriptUrl =
    configuredUserscriptUrl ??
    environment.CU_WIKI_USERSCRIPT_URL ??
    'http://127.0.0.1:8788/cu-wiki-local-search.user.js';
  const context = page.context();
  const sourceResponse = await context.request.get(userscriptUrl, { timeout: 10_000 });
  if (!sourceResponse.ok()) {
    throw new Error(`无法读取待安装 userscript：HTTP ${sourceResponse.status()}`);
  }
  const userscriptSource = await sourceResponse.text();
  const expectedVersion = userscriptSource.match(
    /^\/\/ @version\s+(\S+)$/m,
  )?.[1];
  const expectedBuildId = userscriptSource.match(
    /CU_WIKI_BUILD_ID:[A-Za-z0-9._:-]+/,
  )?.[0];
  if (!expectedVersion || !expectedBuildId) {
    throw new Error('无法从待安装 userscript 解析版本/build marker');
  }
  const initialPages = new Set(context.pages());
  let wikiPage;
  let bridgePage;
  let askPage;
  try {
    wikiPage = await context.newPage();
    await wikiPage.goto(editUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await wikiPage.bringToFront();

    bridgePage = await context.newPage();
    await bridgePage.goto(userscriptUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    for (let attempt = 0; attempt < 40; attempt += 1) {
      askPage = context
        .pages()
        .find(
          (candidate) =>
            !initialPages.has(candidate) && candidate.url().includes('/ask.html'),
        );
      if (askPage) break;
      await bridgePage.waitForTimeout(250);
    }
    if (!askPage) throw new Error('Tampermonkey 安装确认页未出现');

    await askPage.waitForSelector(
      'button, input[type="button"], input[type="submit"]',
      { timeout: 15_000 },
    );
    const controls = askPage.locator('button, input[type="button"], input[type="submit"]');
    let installControl;
    const controlLabels = [];
    for (let index = 0; index < (await controls.count()); index += 1) {
      const control = controls.nth(index);
      const label =
        (await control.getAttribute('value')) ?? (await control.textContent()) ?? '';
      controlLabels.push(label.trim());
      if (/^(重新安装|安装|更新|Reinstall|Install|Update)$/i.test(label.trim())) {
        installControl = control;
        break;
      }
    }
    if (!installControl) {
      throw new Error(
        `Tampermonkey 确认页没有安装/重新安装/更新按钮：${JSON.stringify(controlLabels)}`,
      );
    }

    // Tampermonkey occasionally reports this visible button as outside the
    // extension page viewport. A DOM click is the same interaction the user
    // performs and avoids Playwright's unnecessary actionability retry loop.
    await installControl.evaluate((control) => control.click());
    await wikiPage.waitForTimeout(750);
    if (!askPage.isClosed()) await askPage.close();
    askPage = undefined;
    if (!bridgePage.isClosed()) await bridgePage.close();
    bridgePage = undefined;
    await wikiPage.bringToFront();
    await wikiPage.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await wikiPage.waitForFunction(
      ({ version, buildId }) => {
        const debug = window.__CU_WIKI_SEARCH__;
        return (
          debug?.ready === true &&
          debug.scriptVersion === version &&
          debug.buildId === buildId
        );
      },
      { version: expectedVersion, buildId: expectedBuildId },
      { timeout: 60_000 },
    );
    return {
      installed: true,
      wikiUrl: wikiPage.url(),
      engine: await wikiPage.evaluate(() => window.__CU_WIKI_SEARCH__?.engine),
      version: await wikiPage.evaluate(
        () => window.__CU_WIKI_SEARCH__?.scriptVersion,
      ),
      buildId: await wikiPage.evaluate(() => window.__CU_WIKI_SEARCH__?.buildId),
    };
  } finally {
    for (const candidate of [askPage, bridgePage, wikiPage]) {
      if (candidate && !candidate.isClosed() && !initialPages.has(candidate)) {
        await candidate.close().catch(() => undefined);
      }
    }
    if (!page.isClosed()) await page.bringToFront().catch(() => undefined);
  }
}
