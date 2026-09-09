// SPDX-License-Identifier: MPL-2.0
// Temporary acceptance setup (no repository files):
// node --input-type=module -e "import { build } from 'vite'; import vue from '@vitejs/plugin-vue'; await build({ configFile: false, plugins: [vue()], define: { 'process.env.NODE_ENV': JSON.stringify('production'), __VUE_OPTIONS_API__: false, __VUE_PROD_DEVTOOLS__: false, __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false }, build: { outDir: '/tmp/cu-ui-layout-008', emptyOutDir: false, lib: { entry: 'src/ui/search-panel.ts', name: 'CuSearchPanel', formats: ['iife'], fileName: () => 'search-panel.js' } } })"
// python3 -m http.server 18765 --bind 127.0.0.1 --directory /tmp/cu-ui-layout-008
// bash scripts/run-browser-playwright.sh scripts/test-search-panel-layout.playwright.js

async page => {
  const bundleURL = 'http://127.0.0.1:18765/search-panel.js';
  const wikiEditURL =
    'https://casualtiesunknown.huijiwiki.com/index.php?title=12%E5%8F%B7%E9%B9%BF%E5%BC%B9&action=edit';
  let fixturePage;

  try {
    fixturePage = await page.context().newPage();
    const response = await page.request.get(bundleURL, { timeout: 10_000 });
    if (!response.ok()) {
      throw new Error(`临时 SearchPanel bundle 请求失败：HTTP ${response.status()}`);
    }
    const bundle = await response.text();

    await fixturePage.goto(wikiEditURL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    if (
      await fixturePage.evaluate(() =>
        Boolean(document.querySelector('#cu-wiki-search-layout-test')),
      )
    ) {
      throw new Error('新的 Wiki edit tab 已有测试搜索面板，拒绝覆盖既有 UI');
    }
    await fixturePage.evaluate((source) => {
      const script = document.createElement('script');
      script.textContent = source;
      (document.head ?? document.documentElement).append(script);
      script.remove();
    }, bundle);
    await fixturePage.waitForFunction(
      () => Boolean(window.CuSearchPanel?.SearchPanel),
      undefined,
      { timeout: 10_000 },
    );

    const setup = await fixturePage.evaluate(() => {
      const SearchPanel = window.CuSearchPanel.SearchPanel;
      const results = Array.from({ length: 60 }, (_, index) => ({
        kind: 'content',
        id: index + 1,
        title: `固定测试页面 ${index + 1}`,
        namespace: 0,
        namespaceName: '（主）',
        snippet: `命中正文 ${index + 1}：` + '长诊断片段 '.repeat(10),
        score: 60 - index,
        highlights: [{ start: 0, end: 2 }],
        titleHighlights: [{ start: 0, end: 2 }],
      }));
      const longStatus = '状态第一行：本地镜像可用\n状态第二行：正文队列仍在处理\n状态第三行：详细诊断可展开复制';
      const diagnostics = {
        counts: { pages: 60, files: 12, dataCodes: 8, contentSources: 60, luaSources: 4 },
        jobs: { done: 55, pending: 5, running: 0, failed: 0 },
        snapshots: [],
        storage: { usage: 4096, quota: 16384, persisted: false },
      };
      const state = { refreshes: 0, maintenanceLoads: 0, siteTabs: 0 };
      window.addEventListener('keydown', (event) => {
        if (event.key === 'Tab') state.siteTabs += 1;
      });
      const callbacks = {
        prepareSearch: () => undefined,
        prepareFiles: () => undefined,
        search: () => [],
        searchFiles: () => [],
        searchLua: () => [],
        searchContent: (query) => (query ? results : []),
        searchCodes: () => [],
        insert: () => undefined,
        copyTitle: () => undefined,
        copy: () => undefined,
        copyCode: () => undefined,
        open: () => undefined,
        openCode: () => undefined,
        refresh: () => {
          state.refreshes += 1;
        },
        refreshFiles: () => undefined,
        saveDataCodeRules: async () => undefined,
        saveHighlightPreferences: () => undefined,
        loadMaintenance: async () => {
          state.maintenanceLoads += 1;
          return diagnostics;
        },
        rebuildSearchIndexes: async () => undefined,
        rebuildContentQueue: async () => undefined,
        reconcileNow: async () => undefined,
        clearSnapshots: async () => undefined,
        requestPersistence: async () => ({ status: 'unsupported' }),
        resetLocalMirror: async () => undefined,
      };
      const panel = new SearchPanel(callbacks);
      const hosts = [...document.querySelectorAll('#cu-wiki-search-host')];
      const ownedHost = hosts[hosts.length - 1];
      if (!(ownedHost instanceof HTMLDivElement) || !ownedHost.shadowRoot) {
        throw new Error('无法识别刚创建的 SearchPanel host');
      }
      ownedHost.id = 'cu-wiki-search-layout-test';
      const hideLegacy = document.createElement('style');
      hideLegacy.textContent = '#cu-wiki-search-host { display: none !important; }';
      (document.head ?? document.documentElement).append(hideLegacy);

      panel.open();
      const root = ownedHost.shadowRoot;
      const input = root.querySelector('.query');
      const mode = root.querySelector('.mode');
      if (!(input instanceof HTMLInputElement) || !(mode instanceof HTMLSelectElement)) {
        throw new Error('搜索面板控件没有挂载');
      }
      input.value = '命中';
      mode.value = 'content';
      mode.dispatchEvent(new Event('change'));
      panel.setStatus(longStatus, 'error');
      window.__CU_WIKI_LAYOUT_ACCEPTANCE__ = { longStatus, state };
      return { resultCount: results.length, legacyHostCount: hosts.length - 1 };
    });

    const host = fixturePage.locator('#cu-wiki-search-layout-test');
    const maintenanceToggle = host.locator('.maintenance-toggle');
    await maintenanceToggle.click({ timeout: 5_000 });
    await fixturePage.waitForFunction(
      () => {
        const root = document.querySelector('#cu-wiki-search-layout-test')?.shadowRoot;
        return root?.querySelector('.maintenance-output')?.textContent?.startsWith('页面 ');
      },
      undefined,
      { timeout: 10_000 },
    );
    await fixturePage.waitForTimeout(80);

    const viewports = [
      { name: 'normal', width: 1200, height: 800 },
      { name: 'low', width: 800, height: 420 },
      { name: 'narrow', width: 360, height: 760 },
      { name: 'wide', width: 3840, height: 2160 },
    ];
    const reports = [];
    for (const viewport of viewports) {
      await fixturePage.setViewportSize({ width: viewport.width, height: viewport.height });
      await fixturePage.waitForTimeout(80);

      const panel = host.locator('.panel');
      const detailsToggle = host.locator('.status-details-toggle');
      await detailsToggle.click({ timeout: 5_000 });
      const expanded = await fixturePage.evaluate(() => {
        const root = document.querySelector('#cu-wiki-search-layout-test')?.shadowRoot;
        const details = root?.querySelector('.status-details');
        const toggle = root?.querySelector('.status-details-toggle');
        const expected = window.__CU_WIKI_LAYOUT_ACCEPTANCE__.longStatus;
        return (
          details instanceof HTMLElement &&
          toggle instanceof HTMLButtonElement &&
          !details.hidden &&
          details.textContent === expected &&
          toggle.textContent === '收起完整状态'
        );
      });
      if (!expanded) throw new Error(`状态详情无法展开：${viewport.name}`);
      await detailsToggle.click({ timeout: 5_000 });

      await host.locator('.refresh').click({ timeout: 5_000 });
      await maintenanceToggle.click({ timeout: 5_000 });
      await maintenanceToggle.click({ timeout: 5_000 });
      await host.locator('.close').click({ timeout: 5_000 });
      await host.locator('.toggle').click({ timeout: 5_000 });
      await panel.waitFor({ state: 'visible', timeout: 5_000 });

      reports.push(
        await fixturePage.evaluate(({ name, width, height, resultCount }) => {
          const root = document.querySelector('#cu-wiki-search-layout-test')?.shadowRoot;
          const panel = root?.querySelector('.panel');
          const body = root?.querySelector('.panel-body');
          const header = root?.querySelector('.header');
          const footer = root?.querySelector('.footer');
          const statusToggle = root?.querySelector('.status-details-toggle');
          const details = root?.querySelector('.status-details');
          if (
            !(panel instanceof HTMLElement) ||
            !(body instanceof HTMLElement) ||
            !(header instanceof HTMLElement) ||
            !(footer instanceof HTMLElement) ||
            !(statusToggle instanceof HTMLButtonElement) ||
            !(details instanceof HTMLElement)
          ) {
            throw new Error('面板布局没有挂载');
          }
          const panelRect = panel.getBoundingClientRect();
          const layoutWidth = document.documentElement.clientWidth || window.innerWidth;
          const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
          const usableWidth = Math.min(
            layoutWidth,
            window.visualViewport?.width ?? layoutWidth,
          );
          const usableHeight = Math.min(
            layoutHeight,
            window.visualViewport?.height ?? layoutHeight,
          );
          const expectedWidth =
            usableWidth <= 640
              ? usableWidth - 24
              : Math.min(960, Math.max(420, usableWidth * 0.36), usableWidth - 24);
          const controls = ['.query', '.maintenance-toggle', '.refresh', '.close'].map(
            (selector) => {
              const element = root.querySelector(selector);
              const rect = element?.getBoundingClientRect();
              return {
                selector,
                visible:
                  element instanceof HTMLElement &&
                  !element.hidden &&
                  !!rect &&
                  rect.width > 0 &&
                  rect.height > 0,
                inside:
                  !!rect &&
                  rect.left >= panelRect.left &&
                  rect.right <= panelRect.right &&
                  rect.top >= panelRect.top &&
                  rect.bottom <= panelRect.bottom,
              };
            },
          );
          return {
            name,
            width,
            height,
            usableWidth,
            usableHeight,
            panel: {
              width: panelRect.width,
              top: panelRect.top,
              left: panelRect.left,
              right: panelRect.right,
              bottom: panelRect.bottom,
            },
            expectedWidth,
            body: {
              overflowY: getComputedStyle(body).overflowY,
              scrollHeight: body.scrollHeight,
              clientHeight: body.clientHeight,
              headerInside: body.contains(header),
              footerInside: body.contains(footer),
              bodyCount: root.querySelectorAll('.panel-body').length,
            },
            resultCount: root.querySelectorAll('.result').length,
            expectedResultCount: resultCount,
            statusToggleVisible:
              !statusToggle.hidden && statusToggle.getBoundingClientRect().width > 0,
            detailsUserSelect: getComputedStyle(details).userSelect,
            controls,
            refreshes: window.__CU_WIKI_LAYOUT_ACCEPTANCE__.state.refreshes,
          };
        },
        { ...viewport, resultCount: setup.resultCount }),
      );
    }

    for (const report of reports) {
      if (Math.abs(report.panel.width - report.expectedWidth) > 1) {
        throw new Error(`面板宽度不符合 ${report.name}：${JSON.stringify(report)}`);
      }
      if (
        report.panel.left < 11 ||
        report.panel.right > report.usableWidth - 11 ||
        report.panel.top < 11 ||
        report.panel.bottom > report.usableHeight - 11
      ) {
        throw new Error(`面板越过安全边距 ${report.name}：${JSON.stringify(report)}`);
      }
      if (
        report.body.overflowY === 'visible' ||
        report.body.clientHeight <= 0 ||
        report.body.scrollHeight <= report.body.clientHeight ||
        report.body.headerInside ||
        report.body.footerInside ||
        report.body.bodyCount !== 1 ||
        report.detailsUserSelect !== 'text'
      ) {
        throw new Error(`主体滚动区域不符合 ${report.name}：${JSON.stringify(report)}`);
      }
      if (
        report.resultCount !== report.expectedResultCount ||
        !report.statusToggleVisible ||
        report.controls.some((control) => !control.visible || !control.inside)
      ) {
        throw new Error(`面板交互控件不符合 ${report.name}：${JSON.stringify(report)}`);
      }
    }

    const nativeViewport = { name: 'native-drag', width: 1200, height: 800 };
    await fixturePage.setViewportSize({
      width: nativeViewport.width,
      height: nativeViewport.height,
    });
    await fixturePage.waitForTimeout(80);
    const nativePanel = host.locator('.panel');
    await nativePanel.waitFor({ state: 'visible', timeout: 5_000 });
    const nativeMaintenance = host.locator('.maintenance-toggle');
    const maintenanceHidden = await fixturePage.evaluate(() => {
      const root = document.querySelector('#cu-wiki-search-layout-test')?.shadowRoot;
      return root?.querySelector('.maintenance')?.hidden ?? false;
    });
    if (!maintenanceHidden) {
      await nativeMaintenance.click({ timeout: 5_000 });
    }
    await fixturePage.waitForFunction(
      () => {
        const root = document.querySelector('#cu-wiki-search-layout-test')?.shadowRoot;
        return root?.querySelector('.maintenance')?.hidden === true;
      },
      undefined,
      { timeout: 5_000 },
    );
    const query = host.locator('.query');
    const firstFocusable = host.locator('.drag-handle');
    const lastFocusable = host.locator('.status-details-toggle');
    await query.focus();
    await fixturePage.keyboard.press('Tab');
    const internalTab = await fixturePage.evaluate(() => {
      const root = document.querySelector('#cu-wiki-search-layout-test')?.shadowRoot;
      return {
        activeClass: root?.activeElement?.className ?? '',
        siteTabs: window.__CU_WIKI_LAYOUT_ACCEPTANCE__.state.siteTabs,
      };
    });
    if (!internalTab.activeClass.includes('mode') || internalTab.siteTabs !== 0) {
      throw new Error(`普通 Tab 未留在面板内：${JSON.stringify(internalTab)}`);
    }

    await lastFocusable.focus();
    await fixturePage.keyboard.press('Tab');
    const forwardWrap = await fixturePage.evaluate(() => {
      const root = document.querySelector('#cu-wiki-search-layout-test')?.shadowRoot;
      return {
        activeClass: root?.activeElement?.className ?? '',
        siteTabs: window.__CU_WIKI_LAYOUT_ACCEPTANCE__.state.siteTabs,
      };
    });
    if (!forwardWrap.activeClass.includes('drag-handle') || forwardWrap.siteTabs !== 0) {
      throw new Error(`末项 Tab 未循环到首项：${JSON.stringify(forwardWrap)}`);
    }

    await firstFocusable.focus();
    await fixturePage.keyboard.press('Shift+Tab');
    const backwardWrap = await fixturePage.evaluate(() => {
      const root = document.querySelector('#cu-wiki-search-layout-test')?.shadowRoot;
      return {
        activeClass: root?.activeElement?.className ?? '',
        siteTabs: window.__CU_WIKI_LAYOUT_ACCEPTANCE__.state.siteTabs,
      };
    });
    if (
      !backwardWrap.activeClass.includes('status-details-toggle') ||
      backwardWrap.siteTabs !== 0
    ) {
      throw new Error(`首项 Shift+Tab 未循环到末项：${JSON.stringify(backwardWrap)}`);
    }
    const keyboardAcceptance = { internalTab, forwardWrap, backwardWrap };

    await query.fill('');
    await fixturePage.waitForFunction(
      () => {
        const root = document.querySelector('#cu-wiki-search-layout-test')?.shadowRoot;
        const input = root?.querySelector('.query');
        return (
          input instanceof HTMLInputElement &&
          input.value === '' &&
          root?.querySelectorAll('.result').length === 0
        );
      },
      undefined,
      { timeout: 10_000 },
    );
    await fixturePage.waitForTimeout(120);
    await host.locator('.reset-position').click({ timeout: 5_000 });
    await fixturePage.waitForTimeout(80);

    const readPanelRect = async () => {
      const box = await nativePanel.boundingBox();
      if (!box) throw new Error('原生拖动测试无法读取面板坐标');
      return {
        left: box.x,
        top: box.y,
        right: box.x + box.width,
        bottom: box.y + box.height,
        width: box.width,
        height: box.height,
      };
    };
    const initial = await readPanelRect();
    const initialHandle = host.locator('.drag-handle');
    const initialHandleBox = await initialHandle.boundingBox();
    if (!initialHandleBox) throw new Error('原生拖动测试无法读取拖动手柄坐标');
    const start = {
      x: initialHandleBox.x + initialHandleBox.width / 2,
      y: initialHandleBox.y + initialHandleBox.height / 2,
    };
    const target = { x: start.x - 80, y: start.y - 40 };
    await fixturePage.mouse.move(start.x, start.y);
    await fixturePage.mouse.down();
    await fixturePage.mouse.move(target.x, target.y, { steps: 4 });
    await fixturePage.mouse.up();
    await fixturePage.waitForTimeout(80);
    const moved = await readPanelRect();
    const usableBounds = await fixturePage.evaluate(() => {
      const layoutWidth = document.documentElement.clientWidth || window.innerWidth;
      const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
      return {
        width: Math.min(layoutWidth, window.visualViewport?.width ?? layoutWidth),
        height: Math.min(layoutHeight, window.visualViewport?.height ?? layoutHeight),
      };
    });
    const expectedMoved = {
      left: Math.min(
        Math.max(initial.left - 80, 12),
        Math.max(12, usableBounds.width - moved.width - 12),
      ),
      top: Math.min(
        Math.max(initial.top - 40, 12),
        Math.max(12, usableBounds.height - moved.height - 12),
      ),
    };
    if (
      Math.abs(moved.left - expectedMoved.left) > 1 ||
      Math.abs(moved.top - expectedMoved.top) > 1
    ) {
      throw new Error(
        `原生拖动位置不符合：initial=${JSON.stringify(initial)} start=${JSON.stringify(start)} target=${JSON.stringify(target)} moved=${JSON.stringify(moved)} expected=${JSON.stringify(expectedMoved)} bounds=${JSON.stringify(usableBounds)}`,
      );
    }

    await host.locator('.close').click({ timeout: 5_000 });
    await nativePanel.waitFor({ state: 'hidden', timeout: 5_000 });
    await host.locator('.toggle').click({ timeout: 5_000 });
    await nativePanel.waitFor({ state: 'visible', timeout: 5_000 });
    await fixturePage.waitForTimeout(80);
    const reopened = await readPanelRect();
    if (
      Math.abs(reopened.left - moved.left) > 1 ||
      Math.abs(reopened.top - moved.top) > 1
    ) {
      throw new Error(
        `关闭重开没有保留位置：moved=${JSON.stringify(moved)} reopened=${JSON.stringify(reopened)}`,
      );
    }

    const secondHandle = host.locator('.drag-handle');
    const secondHandleBox = await secondHandle.boundingBox();
    if (!secondHandleBox) throw new Error('原生取消测试无法读取拖动手柄坐标');
    const secondStart = {
      x: secondHandleBox.x + secondHandleBox.width / 2,
      y: secondHandleBox.y + secondHandleBox.height / 2,
    };
    const secondTarget = { x: secondStart.x + 40, y: secondStart.y + 20 };
    await fixturePage.mouse.move(secondStart.x, secondStart.y);
    await fixturePage.mouse.down();
    await fixturePage.mouse.move(secondTarget.x, secondTarget.y, { steps: 3 });
    await secondHandle.focus();
    await fixturePage.keyboard.press('Escape');
    await fixturePage.mouse.up();
    await fixturePage.waitForTimeout(80);
    const canceled = await readPanelRect();
    if (
      (await nativePanel.isVisible()) === false ||
      Math.abs(canceled.left - moved.left) > 1 ||
      Math.abs(canceled.top - moved.top) > 1
    ) {
      throw new Error(
        `第二次拖动 Escape 未回滚：start=${JSON.stringify(secondStart)} target=${JSON.stringify(secondTarget)} committed=${JSON.stringify(moved)} canceled=${JSON.stringify(canceled)}`,
      );
    }

    await secondHandle.focus();
    await fixturePage.keyboard.press('ArrowLeft');
    await fixturePage.waitForTimeout(80);
    const arrowMoved = await readPanelRect();
    const arrowBounds = await fixturePage.evaluate(() => {
      const layoutWidth = document.documentElement.clientWidth || window.innerWidth;
      return Math.min(layoutWidth, window.visualViewport?.width ?? layoutWidth);
    });
    const expectedArrowLeft = Math.max(12, moved.left - 10);
    if (
      Math.abs(arrowMoved.left - expectedArrowLeft) > 1 ||
      arrowMoved.right > arrowBounds - 11
    ) {
      throw new Error(
        `拖动手柄方向键未移动：before=${JSON.stringify(moved)} after=${JSON.stringify(arrowMoved)} expectedLeft=${expectedArrowLeft} bounds=${arrowBounds}`,
      );
    }

    await host.locator('.reset-position').click({ timeout: 5_000 });
    await fixturePage.waitForTimeout(80);
    const reset = await readPanelRect();
    if (
      Math.abs(reset.left - initial.left) > 1 ||
      Math.abs(reset.top - initial.top) > 1
    ) {
      throw new Error(
        `恢复默认位置失败：initial=${JSON.stringify(initial)} reset=${JSON.stringify(reset)}`,
      );
    }
    const nativeDrag = {
      viewport: nativeViewport,
      initial,
      start,
      target,
      moved,
      expectedMoved,
      reopened,
      secondStart,
      secondTarget,
      canceled,
      arrowMoved,
      expectedArrowLeft,
      reset,
    };
    return { reports, keyboardAcceptance, nativeDrag };
  } finally {
    if (fixturePage && !fixturePage.isClosed()) await fixturePage.close();
    await page.bringToFront();
  }
}
