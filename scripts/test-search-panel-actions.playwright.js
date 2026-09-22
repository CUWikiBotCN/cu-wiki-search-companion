// SPDX-License-Identifier: MPL-2.0
// Run after installing the current build:
// bash scripts/run-edge-playwright.sh scripts/test-search-panel-actions.playwright.js

async page => {
  const context = page.context();
  const editURL = 'https://casualtiesunknown.huijiwiki.com/index.php?title=12%E5%8F%B7%E9%B9%BF%E5%BC%B9&action=edit';
  let fixturePage;
  try {
    fixturePage = await context.newPage();
    await fixturePage.bringToFront();
    await fixturePage.goto(editURL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await fixturePage.waitForFunction(
      () => window.__CU_WIKI_SEARCH__?.ready === true &&
        window.__CU_WIKI_SEARCH__.scriptVersion === '0.3.7',
      undefined,
      { timeout: 60_000 },
    );
    const buildId = await fixturePage.evaluate(() => window.__CU_WIKI_SEARCH__.buildId);
    if (!buildId?.startsWith('CU_WIKI_BUILD_ID:')) throw new Error('缺少整包 build marker');

    const host = fixturePage.locator('#cu-wiki-search-host');
    const panel = host.locator('.panel');
    const query = host.locator('.query');
    const mode = host.locator('.mode');
    const cases = [
      { mode: 'title', method: 'search', query: '12号鹿弹' },
      { mode: 'content', method: 'searchContent', query: '12号鹿弹' },
      { mode: 'data-code', method: 'searchCodes', query: '鹿弹' },
      { mode: 'lua', method: 'searchLua', query: '_meta' },
      { mode: 'files', method: 'searchFiles', query: 'morphine' },
      { mode: 'css', method: 'searchCss', query: 'color' },
    ];
    const reports = [];
    await host.locator('.toggle').click({ timeout: 5_000 });
    for (const testCase of cases) {
      const result = await renderMode(testCase);
      const first = host.locator('.result').first();
      const pageActions = !['data-code', 'lua', 'css'].includes(testCase.mode);
      const labels = await first.locator('.action').allTextContents();
      const expectedLabels = pageActions ? ['打开', '复制插入内容', '插入']
        : [['data-code', 'css'].includes(testCase.mode) ? '打开来源' : '打开'];
      if (labels.join('|') !== expectedLabels.join('|')) {
        throw new Error(`${testCase.mode} 结果按钮不符：${labels.join('、')}`);
      }
      await verifyClipboard(
        () => first.locator('.result-primary').click({ timeout: 5_000 }),
        result.kind === 'data-code' ? result.code : result.title,
        `${testCase.mode} 主点击`,
      );
      if (pageActions) {
        await verifyClipboard(
          () => first.locator('.copy-result').click({ timeout: 5_000 }),
          insertionText(result, testCase.query),
          `${testCase.mode} 复制插入内容`,
        );
      } else {
        await query.focus({ timeout: 5_000 });
        await fixturePage.keyboard.press('Shift+Enter');
        const status = await host.locator('.status').textContent();
        if (!(await panel.isVisible()) || !status?.includes('不支持插入')) {
          throw new Error(`${testCase.mode} 不支持的插入被错误执行`);
        }
      }
      if (testCase.mode === 'title') {
        await verifyClipboard(async () => {
          await query.focus({ timeout: 5_000 });
          await fixturePage.keyboard.press('Enter');
        }, result.title, 'query Enter');
        await assertOpensResult(async () => {
          await query.focus({ timeout: 5_000 });
          await fixturePage.keyboard.press('Control+Enter');
        }, result.title);
      } else if (testCase.mode === 'data-code' || testCase.mode === 'css') {
        await assertOpensResult(
          () => first.locator('.open-result').click({ timeout: 5_000 }),
          result.kind === 'data-code' ? result.source : result.title,
        );
      }
      reports.push({ mode: testCase.mode, primary: 'copied', actions: labels });
    }

    if (await drawerOpen()) throw new Error('面板 Tab 验收前侧栏已打开，无法取得干净基线');
    await query.focus({ timeout: 5_000 });
    await fixturePage.keyboard.press('Tab');
    await fixturePage.waitForTimeout(200);
    const focusedMode = await fixturePage.evaluate(() =>
      document.querySelector('#cu-wiki-search-host')?.shadowRoot?.activeElement?.classList.contains('mode'),
    );
    if (!focusedMode || await drawerOpen()) throw new Error('面板 Tab 未转到模式选择，或误开站点侧栏');
    await host.locator('.close').click({ timeout: 5_000 });

    // A fixed external control tests both ways of closing without touching wiki content.
    await fixturePage.evaluate(() => {
      const origin = document.createElement('button');
      origin.id = 'cu-actions-focus-origin';
      origin.textContent = '焦点返回探针';
      origin.style.cssText = 'position:fixed;left:12px;top:12px;z-index:2147483647';
      document.body.append(origin);
    });
    for (const closeKey of ['Escape', 'Alt+K']) {
      await fixturePage.locator('#cu-actions-focus-origin').focus({ timeout: 5_000 });
      await fixturePage.keyboard.press('Alt+K');
      await panel.waitFor({ state: 'visible', timeout: 5_000 });
      await fixturePage.keyboard.press(closeKey);
      await panel.waitFor({ state: 'hidden', timeout: 5_000 });
      if (!(await fixturePage.evaluate(() => document.activeElement?.id === 'cu-actions-focus-origin'))) {
        throw new Error(`${closeKey} 未恢复原焦点`);
      }
    }
    await fixturePage.evaluate(() => document.querySelector('#cu-actions-focus-origin').remove());

    // Outside the panel the site's native Tab shortcut must still toggle its drawer.
    await fixturePage.evaluate(() => {
      document.body.tabIndex = -1;
      document.body.focus();
    });
    await fixturePage.keyboard.press('Tab');
    await fixturePage.waitForFunction(
      () => {
        const drawer = document.querySelector('.drawer-left-container');
        return drawer && drawer.getBoundingClientRect().right > 0;
      },
      undefined,
      { timeout: 5_000 },
    );
    await fixturePage.keyboard.press('Tab');
    await fixturePage.waitForFunction(
      () => {
        const drawer = document.querySelector('.drawer-left-container');
        return !drawer || drawer.getBoundingClientRect().right <= 0;
      },
      undefined,
      { timeout: 5_000 },
    );

    const originalText = await editorText(true);
    await fixturePage.keyboard.press('Alt+K');
    await panel.waitFor({ state: 'visible', timeout: 5_000 });
    const title = await renderMode(cases[0]);
    await query.focus({ timeout: 5_000 });
    await fixturePage.keyboard.press('Shift+Enter');
    await panel.waitFor({ state: 'hidden', timeout: 5_000 });
    if (await editorText() !== originalText + insertionText(title, cases[0].query)) {
      throw new Error('Shift+Enter 未在原编辑器末尾插入预期文本');
    }
    await editorText(false);
    await fixturePage.keyboard.press('Control+Z');
    if (await editorText() !== originalText) throw new Error('原生撤销未恢复原编辑器内容');

    return {
      passed: true, version: '0.3.7', buildId, reports,
      panelTab: true, siteTab: true, focusReturn: ['Escape', 'Alt+K'],
      insertionUndone: true,
    };

    async function renderMode(testCase) {
      // Switching mode is what prepares its lazy index; ready alone only covers cold startup.
      await mode.selectOption(testCase.mode, { timeout: 5_000 });
      await query.fill(testCase.query, { timeout: 5_000 });
      await fixturePage.waitForFunction(
        ({ mode, method, query }) => {
          const root = document.querySelector('#cu-wiki-search-host')?.shadowRoot;
          const result = window.__CU_WIKI_SEARCH__?.[method](query)?.[0];
          return root?.querySelector('.mode')?.value === mode &&
            root?.querySelector('.query')?.value === query && result &&
            root.querySelector('.result .result-title')?.textContent ===
              (result.kind === 'data-code' ? result.chineseName : result.title);
        },
        testCase,
        { timeout: 60_000 },
      );
      return fixturePage.evaluate(
        ({ method, query }) => window.__CU_WIKI_SEARCH__[method](query)[0], testCase,
      );
    }

    async function verifyClipboard(trigger, expected, label) {
      await trigger();
      if (!(await panel.isVisible())) throw new Error(`${label} 意外关闭面板`);
      await fixturePage.waitForTimeout(150);
      await fixturePage.evaluate(() => {
        const probe = document.createElement('textarea');
        probe.id = 'cu-actions-clipboard-probe';
        probe.style.cssText = 'position:fixed;left:12px;bottom:12px;width:240px;height:60px;z-index:2147483647';
        probe.setAttribute('aria-label', '临时剪贴板验收');
        document.body.append(probe);
        probe.focus();
      });
      await fixturePage.keyboard.press('Control+V');
      const actual = await fixturePage.locator('#cu-actions-clipboard-probe').inputValue({ timeout: 5_000 });
      await fixturePage.evaluate(() => document.querySelector('#cu-actions-clipboard-probe').remove());
      if (actual !== expected) throw new Error(`${label} 剪贴板不符：expected=${expected} actual=${actual}`);
    }

    async function assertOpensResult(trigger, title) {
      const expectedURL = await fixturePage.evaluate((title) => {
        const path = window.mw?.util?.getUrl(title) ?? `/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
        return new URL(path, location.origin).href;
      }, title);
      const existing = new Set(context.pages());
      let opened;
      try {
        await trigger();
        const deadline = Date.now() + 10_000;
        do {
          opened = context.pages().find((candidate) => !existing.has(candidate) && candidate.url() === expectedURL);
          if (opened) break;
          await fixturePage.waitForTimeout(100);
        } while (Date.now() < deadline);
        if (!opened) throw new Error(`没有打开预期同源页面：${title}`);
      } finally {
        if (opened && !opened.isClosed()) await opened.close();
        await fixturePage.bringToFront();
      }
    }

    function insertionText(result, query) {
      const target = result.namespace === 6 || result.namespace === 14
        ? `:${result.title.replace(/^:/, '')}` : result.title;
      const label = result.kind === 'content' ? result.title : query.trim();
      return !label || label.toLocaleLowerCase() === result.title.toLocaleLowerCase()
        ? `[[${target}]]` : `[[${target}|${label}]]`;
    }

    async function drawerOpen() {
      return fixturePage.evaluate(() => {
        const drawer = document.querySelector('.drawer-left-container');
        return Boolean(drawer && drawer.getBoundingClientRect().right > 0);
      });
    }

    async function editorText(focusAtEnd) {
      return fixturePage.evaluate((focusAtEnd) => {
        const textarea = document.querySelector('#wpTextbox1');
        if (!(textarea instanceof HTMLTextAreaElement)) throw new Error('编辑页没有 wpTextbox1');
        const cm = [...document.querySelectorAll('.CodeMirror')]
          .map((element) => element.CodeMirror)
          .find((editor) => editor?.getTextArea?.() === textarea);
        const text = cm ? cm.getValue() : textarea.value;
        if (typeof focusAtEnd === 'boolean') {
          if (cm) {
            cm.focus();
            if (focusAtEnd) cm.setCursor(cm.posFromIndex(text.length));
          } else {
            textarea.focus();
            if (focusAtEnd) textarea.setSelectionRange(text.length, text.length);
          }
        }
        return text;
      }, focusAtEnd);
    }
  } finally {
    if (fixturePage && !fixturePage.isClosed()) await fixturePage.close();
    if (!page.isClosed()) await page.bringToFront();
  }
}
