// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom

import { nextTick } from 'vue';
import type { ContentSearchResult } from '../../src/search/content-index';
import type { DataCodeSearchResult } from '../../src/search/data-code-index';
import type { LuaModuleSearchResult } from '../../src/search/lua-module-index';
import type { TitleSearchResult } from '../../src/search/title-index';
import { SearchPanel } from '../../src/ui/search-panel';

afterEach(() => {
  document
    .querySelectorAll('#cu-wiki-search-host')
    .forEach((host) => host.remove());
  document.querySelector('#editor-focus-target')?.remove();
});

describe('SearchPanel file resource mode', () => {
  it('uses an isolated file search entry and prepares it only when selected', async () => {
    const fileResult: TitleSearchResult = {
      id: 6002,
      title: '文件:Item morphine.png',
      namespace: 6,
      namespaceName: '文件',
      score: 100,
    };
    const callbacks = {
      prepareSearch: vi.fn(),
      prepareFiles: vi.fn(),
      search: vi.fn(() => []),
      searchFiles: vi.fn(() => [fileResult]),
      searchLua: vi.fn(() => []),
      searchCss: vi.fn(() => []),
      searchContent: vi.fn(() => []),
      searchCodes: vi.fn(() => []),
      insert: vi.fn(),
      copyTitle: vi.fn(),
      copy: vi.fn(),
      copyCode: vi.fn(),
      open: vi.fn(),
      openCode: vi.fn(),
      refresh: vi.fn(),
      refreshFiles: vi.fn(),
      saveDataCodeRules: vi.fn(async () => undefined),
      saveHighlightPreferences: vi.fn(),
    };
    const panel = new SearchPanel(callbacks);
    panel.open();
    callbacks.prepareSearch.mockClear();
    callbacks.search.mockClear();
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('.query');
    const mode = root?.querySelector<HTMLSelectElement>('.mode');
    if (!root || !input || !mode) throw new Error('搜索面板没有挂载');

    input.value = 'morphine';
    mode.value = 'files';
    mode.dispatchEvent(new Event('change'));
    await nextTick();

    expect(callbacks.prepareFiles).toHaveBeenCalledOnce();
    expect(callbacks.searchFiles).toHaveBeenCalledWith('morphine');
    expect(callbacks.search).not.toHaveBeenCalled();
    expect(root.querySelector('.heading')?.textContent).toBe('查找文件资源');
    expect(root.querySelector<HTMLElement>('.namespace')?.hidden).toBe(true);
    expect(root.querySelector('.results')?.textContent).toContain(
      '文件:Item morphine.png',
    );
  });
});

describe('SearchPanel Lua module mode', () => {
  it('routes only to structured Lua search, copies the primary title, and only offers source opening', async () => {
    const luaResult: LuaModuleSearchResult = {
      kind: 'lua',
      id: 828,
      title: '模块:About',
      namespace: 828,
      namespaceName: '模块',
      matches: [{ kind: 'function', value: 'p.main' }],
      score: 100,
    };
    const callbacks = {
      prepareSearch: vi.fn(),
      prepareFiles: vi.fn(),
      search: vi.fn(() => []),
      searchFiles: vi.fn(() => []),
      searchLua: vi.fn(() => [luaResult]),
      searchCss: vi.fn(() => []),
      searchContent: vi.fn(() => []),
      searchCodes: vi.fn(() => []),
      insert: vi.fn(),
      copyTitle: vi.fn(),
      copy: vi.fn(),
      copyCode: vi.fn(),
      open: vi.fn(),
      openCode: vi.fn(),
      refresh: vi.fn(),
      refreshFiles: vi.fn(),
      saveDataCodeRules: vi.fn(async () => undefined),
      saveHighlightPreferences: vi.fn(),
    };
    const panel = new SearchPanel(callbacks);
    panel.open();
    callbacks.prepareSearch.mockClear();
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('.query');
    const mode = root?.querySelector<HTMLSelectElement>('.mode');
    if (!root || !input || !mode) throw new Error('搜索面板没有挂载');

    input.value = 'main';
    mode.value = 'lua';
    mode.dispatchEvent(new Event('change'));
    await nextTick();

    expect(callbacks.prepareSearch).toHaveBeenCalledOnce();
    expect(callbacks.prepareSearch).toHaveBeenCalledWith('lua');
    expect(callbacks.searchLua).toHaveBeenCalledWith('main');
    expect(callbacks.searchContent).not.toHaveBeenCalled();
    expect(root.querySelector('.heading')?.textContent).toBe('查找 Lua 模块');
    expect(root.querySelector<HTMLElement>('.namespace')?.hidden).toBe(true);
    expect(root.querySelector('.results')?.textContent).toContain(
      '函数 · p.main',
    );

    root.querySelector<HTMLButtonElement>('.result-primary')?.click();
    await nextTick();
    expect(callbacks.copyTitle).toHaveBeenCalledWith(luaResult);
    expect(callbacks.insert).not.toHaveBeenCalled();
    expect(root.querySelectorAll('.copy-result, .insert-result')).toHaveLength(
      0,
    );
    root.querySelector<HTMLButtonElement>('.open-result')?.click();
    await nextTick();
    expect(callbacks.open).toHaveBeenCalledWith(luaResult);
  });
});

describe('SearchPanel result actions', () => {
  it('copies page titles from the primary action and orders the available secondary actions', async () => {
    const result: TitleSearchResult = {
      id: 12,
      title: '12号鹿弹',
      namespace: 0,
      namespaceName: '',
      score: 100,
    };
    const callbacks = maintenanceCallbacks({ search: vi.fn(() => [result]) });
    const panel = new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    const panelElement = root?.querySelector<HTMLElement>('.panel');
    const input = root?.querySelector<HTMLInputElement>('.query');
    if (!root || !panelElement || !input) throw new Error('搜索面板没有挂载');

    panel.open();
    await nextTick();
    input.value = '鹿弹';
    panel.refreshResults();
    await nextTick();
    expect(
      [...root.querySelectorAll<HTMLElement>('.result .action')].map(
        (action) => action.textContent,
      ),
    ).toEqual(['打开', '复制插入内容', '插入']);

    const primary = root.querySelector<HTMLButtonElement>(
      '.insert.result-primary',
    );
    if (!primary) throw new Error('结果主按钮没有挂载');
    primary.click();
    await nextTick();
    expect(callbacks.copyTitle).toHaveBeenCalledWith(result);
    expect(panelElement.hidden).toBe(false);

    root.querySelector<HTMLButtonElement>('.open-result')?.click();
    await nextTick();
    expect(callbacks.open).toHaveBeenCalledWith(result);
    root.querySelector<HTMLButtonElement>('.copy-result')?.click();
    await nextTick();
    expect(callbacks.copy).toHaveBeenCalledWith(result, '鹿弹');
    root.querySelector<HTMLButtonElement>('.insert-result')?.click();
    await nextTick();
    expect(callbacks.insert).toHaveBeenCalledWith(result, '鹿弹');
    expect(panelElement.hidden).toBe(true);
    panel.open();
    await nextTick();
    panel.setInsertMode(false);
    await nextTick();
    panel.refreshResults();
    await nextTick();
    expect(root.querySelector('.insert-result')).toBeNull();
  });

  it('copies Data codes from the primary action and only offers opening the source', async () => {
    const result: DataCodeSearchResult = {
      kind: 'data-code',
      source: 'Data:Item.json',
      chineseName: '鹿弹代码',
      code: 'buckshot_12',
      dataType: 'item',
      score: 100,
    };
    const callbacks = maintenanceCallbacks({
      searchCodes: vi.fn(() => [result]),
    });
    const panel = new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('.query');
    const mode = root?.querySelector<HTMLSelectElement>('.mode');
    if (!root || !input || !mode) throw new Error('搜索面板没有挂载');

    panel.open();
    await nextTick();
    input.value = 'buckshot';
    mode.value = 'data-code';
    mode.dispatchEvent(new Event('change'));
    await nextTick();

    root.querySelector<HTMLButtonElement>('.result-primary')?.click();
    await nextTick();
    expect(callbacks.copyCode).toHaveBeenCalledWith(result);
    expect(callbacks.copyTitle).not.toHaveBeenCalled();
    expect(
      [...root.querySelectorAll<HTMLElement>('.result .action')].map(
        (action) => action.textContent,
      ),
    ).toEqual(['打开来源']);
    root.querySelector<HTMLButtonElement>('.open-result')?.click();
    await nextTick();
    expect(callbacks.openCode).toHaveBeenCalledWith(result);
  });
});

describe('SearchPanel lazy search preparation', () => {
  it('prepares only the selected heavy mode and leaves Data code mode lightweight', async () => {
    const callbacks = maintenanceCallbacks();
    const panel = new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('.query');
    const mode = root?.querySelector<HTMLSelectElement>('.mode');
    if (!root || !input || !mode) throw new Error('搜索面板没有挂载');

    panel.open();
    await nextTick();
    expect(callbacks.prepareSearch).toHaveBeenLastCalledWith('title');

    mode.value = 'content';
    mode.dispatchEvent(new Event('change'));
    await nextTick();
    expect(callbacks.prepareSearch).toHaveBeenLastCalledWith('content');

    mode.value = 'data-code';
    mode.dispatchEvent(new Event('change'));
    await nextTick();
    expect(callbacks.prepareSearch).toHaveBeenCalledTimes(2);
    expect(input.placeholder).toBe('中文名、英文代码片段或已配置字段值');
    expect(input.getAttribute('aria-label')).toBe('搜索 Data 代码');
    expect(root.querySelector('.results')?.textContent).toContain(
      '输入中文名、英文代码片段或已配置字段值查找代码',
    );
    expect(
      root.querySelector('.settings .settings-help')?.textContent,
    ).toContain('英文 id 本身始终可搜索');

    mode.value = 'files';
    mode.dispatchEvent(new Event('change'));
    await nextTick();
    expect(callbacks.prepareFiles).toHaveBeenCalledOnce();
    expect(callbacks.prepareSearch).toHaveBeenCalledTimes(2);
    expect(input.getAttribute('aria-label')).toBe('搜索文件资源');
  });
});

describe('SearchPanel local maintenance', () => {
  it('shows diagnostics, labels network work, and uses inline reset confirmation', async () => {
    const callbacks = {
      prepareSearch: vi.fn(),
      prepareFiles: vi.fn(),
      search: vi.fn(() => []),
      searchFiles: vi.fn(() => []),
      searchLua: vi.fn(() => []),
      searchCss: vi.fn(() => []),
      searchContent: vi.fn(() => []),
      searchCodes: vi.fn(() => []),
      insert: vi.fn(),
      copyTitle: vi.fn(),
      copy: vi.fn(),
      copyCode: vi.fn(),
      open: vi.fn(),
      openCode: vi.fn(),
      refresh: vi.fn(),
      refreshFiles: vi.fn(),
      saveDataCodeRules: vi.fn(async () => undefined),
      saveHighlightPreferences: vi.fn(),
      loadMaintenance: vi.fn(async () => ({
        counts: {
          pages: 3,
          files: 1,
          dataCodes: 2,
          contentSources: 2,
          luaSources: 1,
        },
        jobs: { done: 2, pending: 1, running: 0, failed: 0 },
        snapshots: [
          {
            kind: 'title' as const,
            status: 'available' as const,
            throughLocalSeq: 3,
          },
          { kind: 'content' as const, status: 'missing' as const },
          { kind: 'lua' as const, status: 'not-started' as const },
        ],
        storage: { usage: 1_024, quota: 4_096, persisted: false },
      })),
      rebuildSearchIndexes: vi.fn(async () => undefined),
      rebuildContentQueue: vi.fn(async () => undefined),
      reconcileNow: vi.fn(async () => undefined),
      clearSnapshots: vi.fn(async () => undefined),
      requestPersistence: vi.fn(async () => ({ status: 'denied' as const })),
      resetLocalMirror: vi.fn(async () => undefined),
    };
    new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    if (!root) throw new Error('搜索面板没有挂载');

    root.querySelector<HTMLButtonElement>('.maintenance-toggle')?.click();
    await nextTick();
    await vi.waitFor(() => {
      expect(root.querySelector('.maintenance-output')?.textContent).toContain(
        '页面 3',
      );
    });
    expect(root.querySelector('.reconcile-now')?.textContent).toContain(
      '需要联网',
    );
    expect(
      root.querySelector<HTMLElement>('.danger-confirmation')?.hidden,
    ).toBe(true);

    root.querySelector<HTMLButtonElement>('.reveal-danger')?.click();
    await nextTick();
    expect(
      root.querySelector<HTMLElement>('.danger-confirmation')?.hidden,
    ).toBe(false);
    const checkbox = root.querySelector<HTMLInputElement>('.reset-data-rules');
    expect(checkbox?.checked).toBe(false);
    if (!checkbox) throw new Error('缺少重置规则复选框');
    checkbox.click();
    await nextTick();
    root.querySelector<HTMLButtonElement>('.reset-local')?.click();
    await nextTick();
    expect(callbacks.resetLocalMirror).toHaveBeenCalledWith(true);

    await vi.waitFor(() => {
      expect(
        root.querySelector<HTMLButtonElement>('.reset-local')?.disabled,
      ).toBe(false);
    });

    root.querySelector<HTMLButtonElement>('.request-persistence')?.click();
    await nextTick();
    await vi.waitFor(() => {
      expect(root.querySelector('.status')?.textContent).toContain(
        '未授予持久保存',
      );
    });
  });

  it('serializes destructive maintenance actions and reports reset failures inline', async () => {
    let rejectReset!: (error: Error) => void;
    const reset = new Promise<void>((_resolve, reject) => {
      rejectReset = reject;
    });
    const callbacks = maintenanceCallbacks({
      resetLocalMirror: vi.fn(() => reset),
    });
    new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    if (!root) throw new Error('搜索面板没有挂载');

    root.querySelector<HTMLButtonElement>('.reveal-danger')?.click();
    await nextTick();
    const resetButton = root.querySelector<HTMLButtonElement>('.reset-local');
    const rebuildButton =
      root.querySelector<HTMLButtonElement>('.rebuild-indexes');
    const reconcileButton =
      root.querySelector<HTMLButtonElement>('.reconcile-now');
    if (!resetButton || !rebuildButton || !reconcileButton) {
      throw new Error('维护按钮没有挂载');
    }

    resetButton.click();
    await nextTick();
    resetButton.click();
    await nextTick();
    rebuildButton.click();
    await nextTick();
    reconcileButton.click();
    await nextTick();

    expect(callbacks.resetLocalMirror).toHaveBeenCalledOnce();
    expect(callbacks.rebuildSearchIndexes).not.toHaveBeenCalled();
    expect(callbacks.reconcileNow).not.toHaveBeenCalled();
    expect(resetButton.disabled).toBe(true);
    expect(rebuildButton.disabled).toBe(true);
    expect(reconcileButton.disabled).toBe(true);

    rejectReset(new Error('IndexedDB 删除失败'));
    await vi.waitFor(() => {
      expect(root.querySelector('.maintenance-output')?.textContent).toContain(
        '本地维护操作失败：IndexedDB 删除失败',
      );
    });
    expect(root.querySelector('.status')?.textContent).not.toContain(
      '操作完成',
    );
    expect(resetButton.disabled).toBe(false);
    expect(rebuildButton.disabled).toBe(false);
    expect(reconcileButton.disabled).toBe(false);
  });

  it('keeps all maintenance actions busy until the active action finishes', async () => {
    let finishRebuild!: () => void;
    const rebuilding = new Promise<void>((resolve) => {
      finishRebuild = resolve;
    });
    const callbacks = maintenanceCallbacks({
      rebuildSearchIndexes: vi.fn(() => rebuilding),
    });
    new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    if (!root) throw new Error('搜索面板没有挂载');
    const rebuildButton =
      root.querySelector<HTMLButtonElement>('.rebuild-indexes');
    const queueButton = root.querySelector<HTMLButtonElement>(
      '.rebuild-content-queue',
    );
    const resetButton = root.querySelector<HTMLButtonElement>('.reset-local');
    if (!rebuildButton || !queueButton || !resetButton)
      throw new Error('维护按钮没有挂载');

    rebuildButton.click();
    await nextTick();

    expect([
      ...root.querySelectorAll<HTMLButtonElement>('.maintenance-action'),
    ]).toSatisfy((buttons: HTMLButtonElement[]) =>
      buttons.every((button) => button.disabled),
    );
    queueButton.click();
    await nextTick();
    resetButton.click();
    await nextTick();
    expect(callbacks.rebuildContentQueue).not.toHaveBeenCalled();
    expect(callbacks.resetLocalMirror).not.toHaveBeenCalled();

    finishRebuild();
    await vi.waitFor(() => expect(rebuildButton.disabled).toBe(false));
    expect(root.querySelector('.status')?.textContent).toBe('本地维护操作完成');
  });

  it('shows an optional successful rebuild warning without reporting maintenance failure', async () => {
    const callbacks = maintenanceCallbacks({
      rebuildSearchIndexes: vi.fn(async () => ({
        message:
          '索引已重建，某些快照未保存：标题快照未保存：浏览器剩余配额不足；当前搜索可用',
        tone: 'normal' as const,
      })),
    });
    new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    if (!root) throw new Error('搜索面板没有挂载');

    root.querySelector<HTMLButtonElement>('.rebuild-indexes')?.click();
    await nextTick();

    await vi.waitFor(() => {
      expect(root.querySelector('.status')?.textContent).toContain(
        '索引已重建，某些快照未保存',
      );
    });
    expect(root.querySelector<HTMLElement>('.status')?.dataset.tone).toBe(
      'normal',
    );
    expect(
      root.querySelector('.maintenance-output')?.textContent,
    ).not.toContain('本地维护操作失败');
  });
});

describe('SearchPanel startup recovery', () => {
  it('shows a reload recovery action instead of remaining in loading state', async () => {
    const reload = vi.fn();
    const callbacks = maintenanceCallbacks();
    const panel = new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    if (!root) throw new Error('搜索面板没有挂载');

    panel.setStartupFailure('IndexedDB 无法打开', reload);
    await nextTick();
    panel.open();
    await nextTick();

    expect(root.querySelector('.status')?.textContent).toContain(
      'IndexedDB 无法打开',
    );
    expect(root.querySelector<HTMLElement>('.status')?.dataset.tone).toBe(
      'error',
    );
    expect(callbacks.prepareSearch).not.toHaveBeenCalled();
    const reloadButton =
      root.querySelector<HTMLButtonElement>('.reload-startup');
    expect(reloadButton?.hidden).toBe(false);
    reloadButton?.click();
    await nextTick();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('keeps mode and refresh controls from restarting work after startup failed', async () => {
    const callbacks = maintenanceCallbacks();
    const panel = new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    if (!root) throw new Error('搜索面板没有挂载');
    const mode = root.querySelector<HTMLSelectElement>('.mode');
    const refresh = root.querySelector<HTMLButtonElement>('.refresh');
    if (!mode || !refresh) throw new Error('搜索控件没有挂载');

    panel.setStartupFailure('IndexedDB 无法打开', vi.fn());
    await nextTick();
    mode.value = 'files';
    mode.dispatchEvent(new Event('change'));
    await nextTick();
    refresh.click();
    await nextTick();

    expect(callbacks.prepareSearch).not.toHaveBeenCalled();
    expect(callbacks.prepareFiles).not.toHaveBeenCalled();
    expect(callbacks.refresh).not.toHaveBeenCalled();
    expect(callbacks.refreshFiles).not.toHaveBeenCalled();
    expect(root.querySelector('.status')?.textContent).toContain(
      'IndexedDB 无法打开',
    );
  });
});

describe('SearchPanel keyboard lifecycle', () => {
  it('accepts only plain Alt+K and gives the shortcut to the latest panel instance', async () => {
    new SearchPanel(maintenanceCallbacks());
    new SearchPanel(maintenanceCallbacks());
    const panels = [
      ...document.querySelectorAll<HTMLDivElement>('#cu-wiki-search-host'),
    ].map((host) => host.shadowRoot?.querySelector<HTMLElement>('.panel'));
    if (panels.some((panel) => !panel)) throw new Error('搜索面板没有挂载');
    const latest = panels[1]!;

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', altKey: true, ctrlKey: true }),
    );
    await nextTick();
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', altKey: true, metaKey: true }),
    );
    await nextTick();
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', altKey: true, shiftKey: true }),
    );
    await nextTick();
    const altGraph = new KeyboardEvent('keydown', { key: 'k', altKey: true });
    vi.spyOn(altGraph, 'getModifierState').mockImplementation(
      (key) => key === 'AltGraph',
    );
    window.dispatchEvent(altGraph);
    await nextTick();

    expect(panels.every((panel) => panel?.hidden)).toBe(true);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'K', altKey: true }),
    );
    await nextTick();
    expect(panels[0]?.hidden).toBe(true);
    expect(latest.hidden).toBe(false);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', altKey: true }),
    );
    await nextTick();
    expect(latest.hidden).toBe(true);
  });

  it.each(['.query', '.mode', '.data-rules', '.rebuild-indexes'])(
    'closes from %s when Escape bubbles through the open panel',
    async (selector) => {
      const panel = new SearchPanel(maintenanceCallbacks());
      const root = document.querySelector<HTMLDivElement>(
        '#cu-wiki-search-host',
      )?.shadowRoot;
      const panelElement = root?.querySelector<HTMLElement>('.panel');
      const control = root?.querySelector<HTMLElement>(selector);
      if (!root || !panelElement || !control)
        throw new Error('搜索面板没有挂载');
      panel.open();
      await nextTick();

      control.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await nextTick();

      expect(panelElement.hidden).toBe(true);
    },
  );

  it('leaves Escape to IME composition outside the query input and honors isComposing', async () => {
    const panel = new SearchPanel(maintenanceCallbacks());
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    const panelElement = root?.querySelector<HTMLElement>('.panel');
    const dataRules = root?.querySelector<HTMLTextAreaElement>('.data-rules');
    if (!root || !panelElement || !dataRules)
      throw new Error('搜索面板没有挂载');
    panel.open();
    await nextTick();

    dataRules.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );
    await nextTick();
    dataRules.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await nextTick();
    expect(panelElement.hidden).toBe(false);

    dataRules.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    );
    await nextTick();
    dataRules.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        isComposing: true,
      }),
    );
    await nextTick();
    expect(panelElement.hidden).toBe(false);

    dataRules.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await nextTick();
    expect(panelElement.hidden).toBe(true);
  });

  it('preserves modified input arrows and dispatches only defined query shortcuts', async () => {
    const first: TitleSearchResult = {
      id: 1,
      title: '第一页',
      namespace: 0,
      namespaceName: '',
      score: 2,
    };
    const second: TitleSearchResult = {
      id: 2,
      title: '第二页',
      namespace: 0,
      namespaceName: '',
      score: 1,
    };
    const callbacks = maintenanceCallbacks({
      search: vi.fn(() => [first, second]),
    });
    const panel = new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('.query');
    const mode = root?.querySelector<HTMLSelectElement>('.mode');
    if (!root || !input || !mode) throw new Error('搜索面板没有挂载');
    panel.open();
    await nextTick();
    input.value = '页面';
    panel.refreshResults();
    await nextTick();
    mode.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await nextTick();
    expect(callbacks.copyTitle).not.toHaveBeenCalled();

    const shiftArrow = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    const controlArrow = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(input.dispatchEvent(shiftArrow)).toBe(true);
    expect(input.dispatchEvent(controlArrow)).toBe(true);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await nextTick();
    expect(callbacks.copyTitle).toHaveBeenLastCalledWith(first);
    expect(root.querySelector<HTMLElement>('.panel')?.hidden).toBe(false);

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    await nextTick();
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await nextTick();
    expect(callbacks.copyTitle).toHaveBeenLastCalledWith(second);

    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
      }),
    );
    await nextTick();
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
      }),
    );
    await nextTick();
    expect(callbacks.open).toHaveBeenCalledTimes(2);
    expect(callbacks.open).toHaveBeenLastCalledWith(second);

    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    await nextTick();
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        altKey: true,
        bubbles: true,
      }),
    );
    await nextTick();
    expect(callbacks.copyTitle).toHaveBeenCalledTimes(2);
    expect(callbacks.open).toHaveBeenCalledTimes(2);
    expect(callbacks.insert).not.toHaveBeenCalled();

    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
      }),
    );
    await nextTick();
    expect(callbacks.insert).toHaveBeenCalledWith(second, '页面');
    expect(root.querySelector<HTMLElement>('.panel')?.hidden).toBe(true);
  });

  it('uses the focused result for primary shortcuts and restores query focus before refresh removes it', async () => {
    const first: TitleSearchResult = {
      id: 1,
      title: '第一页',
      namespace: 0,
      namespaceName: '',
      score: 2,
    };
    const second: TitleSearchResult = {
      id: 2,
      title: '第二页',
      namespace: 0,
      namespaceName: '',
      score: 1,
    };
    let results = [first, second];
    const callbacks = maintenanceCallbacks({ search: vi.fn(() => results) });
    const panel = new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('.query');
    if (!root || !input) throw new Error('搜索面板没有挂载');
    panel.open();
    await nextTick();
    input.value = '页面';
    panel.refreshResults();
    await nextTick();
    const primaries = [
      ...root.querySelectorAll<HTMLButtonElement>('.result-primary'),
    ];
    const items = [...root.querySelectorAll<HTMLElement>('.result')];
    if (primaries.length !== 2 || items.length !== 2)
      throw new Error('结果按钮没有挂载');

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    await nextTick();
    primaries[0]?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
      }),
    );
    await nextTick();
    expect(callbacks.open).toHaveBeenLastCalledWith(first);

    primaries[1]?.focus();
    await nextTick();
    expect(items[1]?.dataset.selected).toBe('true');
    primaries[0]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await nextTick();
    expect(callbacks.copyTitle).toHaveBeenLastCalledWith(first);

    const secondary = root.querySelector<HTMLButtonElement>('.open-result');
    if (!secondary) throw new Error('打开结果按钮没有挂载');
    const nativeEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    expect(secondary.dispatchEvent(nativeEnter)).toBe(true);

    primaries[1]?.focus();
    await nextTick();
    results = [];
    panel.refreshResults();
    await nextTick();
    expect(root.activeElement).toBe(input);
  });

  it('cycles Tab inside the panel, skips unavailable controls, and stops site propagation', async () => {
    const panel = new SearchPanel(maintenanceCallbacks());
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    const handle = root?.querySelector<HTMLElement>('.drag-handle');
    const input = root?.querySelector<HTMLInputElement>('.query');
    const mode = root?.querySelector<HTMLSelectElement>('.mode');
    const namespace = root?.querySelector<HTMLSelectElement>('.namespace');
    if (!root || !handle || !input || !mode || !namespace) {
      throw new Error('搜索面板没有挂载');
    }
    panel.open();
    await nextTick();
    namespace.disabled = true;
    for (const control of root.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, [tabindex]',
    )) {
      vi.spyOn(control, 'getClientRects').mockReturnValue([
        makeLayoutRect(0, 0, 10, 10),
      ] as unknown as DOMRectList);
    }

    const siteKeydown = vi.fn();
    window.addEventListener('keydown', siteKeydown);
    try {
      input.focus();
      await nextTick();
      const internalTab = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      input.dispatchEvent(internalTab);
      await nextTick();
      expect(internalTab.defaultPrevented).toBe(false);
      expect(siteKeydown).not.toHaveBeenCalled();

      handle.focus();
      await nextTick();
      const backward = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      handle.dispatchEvent(backward);
      await nextTick();
      expect(backward.defaultPrevented).toBe(true);
      expect(root.activeElement).toBe(mode);

      const forward = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      mode.dispatchEvent(forward);
      await nextTick();
      expect(forward.defaultPrevented).toBe(true);
      expect(root.activeElement).toBe(handle);
      expect(siteKeydown).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', siteKeydown);
    }
  });

  it('leaves Escape to the active IME and restores the editor focus when closing later', async () => {
    const editor = document.createElement('textarea');
    editor.id = 'editor-focus-target';
    document.body.append(editor);
    editor.focus();
    await nextTick();
    const panel = new SearchPanel(maintenanceCallbacks());
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('.query');
    const panelElement = root?.querySelector<HTMLElement>('.panel');
    if (!root || !input || !panelElement) throw new Error('搜索面板没有挂载');

    panel.open();
    await nextTick();
    input.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    );
    await nextTick();
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await nextTick();

    expect(panelElement.hidden).toBe(false);

    input.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true }),
    );
    await nextTick();
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await nextTick();

    expect(panelElement.hidden).toBe(true);
    expect(document.activeElement).toBe(editor);
  });

  it('keeps editor focus established by the explicit insert action', async () => {
    const editor = document.createElement('textarea');
    editor.id = 'editor-focus-target';
    document.body.append(editor);
    const result: TitleSearchResult = {
      id: 1,
      title: '12号鹿弹',
      namespace: 0,
      namespaceName: '',
      score: 100,
    };
    const callbacks = maintenanceCallbacks({
      search: vi.fn(() => [result]),
      insert: vi.fn(() => editor.focus()),
    });
    const panel = new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>(
      '#cu-wiki-search-host',
    )?.shadowRoot;
    const toggle = root?.querySelector<HTMLButtonElement>('.toggle');
    const input = root?.querySelector<HTMLInputElement>('.query');
    if (!root || !toggle || !input) throw new Error('搜索面板没有挂载');

    toggle.click();
    await nextTick();
    input.value = '鹿弹';
    panel.refreshResults();
    await nextTick();
    root.querySelector<HTMLButtonElement>('.insert-result')?.click();
    await nextTick();

    expect(callbacks.insert).toHaveBeenCalledWith(result, '鹿弹');
    expect(document.activeElement).toBe(editor);
  });
});

describe('SearchPanel full-text hit highlighting', () => {
  const contentResult: ContentSearchResult = {
    kind: 'content',
    id: 7,
    title: '紧急救治指南',
    namespace: 0,
    namespaceName: '（主）',
    snippet: '使用紧急救治手段。',
    score: 10,
    highlights: [{ start: 2, end: 6 }],
    titleHighlights: [{ start: 0, end: 4 }],
  };

  function mount(
    overrides: Partial<ConstructorParameters<typeof SearchPanel>[0]> = {},
  ): {
    callbacks: ConstructorParameters<typeof SearchPanel>[0];
    panel: SearchPanel;
    root: ShadowRoot;
    mode: HTMLSelectElement;
    input: HTMLInputElement;
    host: HTMLDivElement;
  } {
    const callbacks = maintenanceCallbacks(overrides);
    const panel = new SearchPanel(callbacks);
    panel.open();
    const host = document.querySelector<HTMLDivElement>('#cu-wiki-search-host');
    const root = host?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('.query');
    const mode = root?.querySelector<HTMLSelectElement>('.mode');
    if (!host || !root || !input || !mode) throw new Error('搜索面板没有挂载');
    return { callbacks, panel, root, mode, input, host };
  }

  it('shows highlight settings only in content mode with correct defaults', async () => {
    const { root, mode } = mount();
    const section = root.querySelector<HTMLElement>('.highlight-settings');
    if (!section) throw new Error('缺少高亮设置区');

    expect(section.hidden).toBe(true);
    mode.value = 'content';
    mode.dispatchEvent(new Event('change'));
    await nextTick();
    expect(section.hidden).toBe(false);
    expect(
      root.querySelector<HTMLInputElement>('.title-highlight-toggle')?.checked,
    ).toBe(false);
    expect(
      root.querySelector<HTMLInputElement>('.content-highlight-toggle')
        ?.checked,
    ).toBe(true);
    expect(
      root.querySelector<HTMLInputElement>('.title-highlight-color')?.value,
    ).toBe('#aee2ff');
    expect(
      root.querySelector<HTMLInputElement>('.content-highlight-color')?.value,
    ).toBe('#fff3a3');

    mode.value = 'title';
    mode.dispatchEvent(new Event('change'));
    await nextTick();
    expect(section.hidden).toBe(true);
  });

  it('renders snippet marks by default and leaves the title plain', async () => {
    const { callbacks, root, mode, input } = mount({
      searchContent: vi.fn(() => [contentResult]),
    });

    input.value = '紧急救治';
    mode.value = 'content';
    mode.dispatchEvent(new Event('change'));
    await nextTick();

    const title = root.querySelector<HTMLElement>('.result-title');
    const namespace = root.querySelector<HTMLElement>('.result-namespace');
    if (!title || !namespace) throw new Error('结果行没有渲染');
    expect(title.textContent).toBe('紧急救治指南');
    expect(title.querySelectorAll('mark')).toHaveLength(0);
    expect(namespace.textContent).toBe('（主） · 使用紧急救治手段。');
    const marks = namespace.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe('紧急救治');
    expect(callbacks.saveHighlightPreferences).not.toHaveBeenCalled();
  });

  it('applies toggles, persists preferences, and re-renders marks', async () => {
    const { callbacks, root, mode, input } = mount({
      searchContent: vi.fn(() => [contentResult]),
    });

    input.value = '紧急救治';
    mode.value = 'content';
    mode.dispatchEvent(new Event('change'));
    await nextTick();

    const titleToggle = root.querySelector<HTMLInputElement>(
      '.title-highlight-toggle',
    );
    const contentToggle = root.querySelector<HTMLInputElement>(
      '.content-highlight-toggle',
    );
    if (!titleToggle || !contentToggle) throw new Error('缺少高亮开关');

    titleToggle.checked = true;
    titleToggle.dispatchEvent(new Event('change'));
    await nextTick();
    expect(callbacks.saveHighlightPreferences).toHaveBeenLastCalledWith({
      titleEnabled: true,
      contentEnabled: true,
      titleColor: '#aee2ff',
      contentColor: '#fff3a3',
    });
    const title = root.querySelector<HTMLElement>('.result-title');
    expect(title?.querySelectorAll('mark')).toHaveLength(1);
    expect(title?.querySelector('mark')?.textContent).toBe('紧急救治');

    contentToggle.checked = false;
    contentToggle.dispatchEvent(new Event('change'));
    await nextTick();
    expect(callbacks.saveHighlightPreferences).toHaveBeenLastCalledWith({
      titleEnabled: true,
      contentEnabled: false,
      titleColor: '#aee2ff',
      contentColor: '#fff3a3',
    });
    const namespace = root.querySelector<HTMLElement>('.result-namespace');
    expect(namespace?.querySelectorAll('mark')).toHaveLength(0);
    expect(namespace?.textContent).toBe('（主） · 使用紧急救治手段。');
  });

  it('applies colors as CSS custom properties and persists on change only', async () => {
    const { callbacks, panel, root, mode, host, input } = mount({
      searchContent: vi.fn(() => [contentResult]),
    });

    panel.setHighlightPreferences({
      titleEnabled: true,
      contentEnabled: true,
      titleColor: '#aee2ff',
      contentColor: '#fff3a3',
    });
    await nextTick();
    expect(host.style.getPropertyValue('--cu-title-highlight')).toBe('#aee2ff');
    expect(host.style.getPropertyValue('--cu-content-highlight')).toBe(
      '#fff3a3',
    );

    mode.value = 'content';
    mode.dispatchEvent(new Event('change'));
    await nextTick();
    input.value = '紧急救治';
    panel.refreshResults();
    await nextTick();
    const result = root.querySelector<HTMLElement>('.result');
    const titleMark = root.querySelector<HTMLElement>('.result-title mark');
    const contentMark = root.querySelector<HTMLElement>(
      '.result-namespace mark',
    );
    const titleColor = root.querySelector<HTMLInputElement>(
      '.title-highlight-color',
    );
    const contentColor = root.querySelector<HTMLInputElement>(
      '.content-highlight-color',
    );
    if (!result || !titleMark || !contentMark || !titleColor || !contentColor) {
      throw new Error('高亮结果或颜色选择器没有挂载');
    }

    titleColor.value = '#c0ffec';
    titleColor.dispatchEvent(new Event('input'));
    await nextTick();
    expect(host.style.getPropertyValue('--cu-title-highlight')).toBe('#c0ffec');
    expect(callbacks.saveHighlightPreferences).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLElement>('.result')).toBe(result);
    expect(root.querySelector<HTMLElement>('.result-title mark')).toBe(
      titleMark,
    );
    expect(root.querySelector<HTMLElement>('.result-namespace mark')).toBe(
      contentMark,
    );

    titleColor.dispatchEvent(new Event('change'));
    await nextTick();
    expect(callbacks.saveHighlightPreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ titleColor: '#c0ffec' }),
    );

    contentColor.value = '#ff8800';
    contentColor.dispatchEvent(new Event('input'));
    await nextTick();
    expect(host.style.getPropertyValue('--cu-content-highlight')).toBe(
      '#ff8800',
    );
    expect(callbacks.saveHighlightPreferences).toHaveBeenCalledTimes(1);
    expect(root.querySelector<HTMLElement>('.result')).toBe(result);
    expect(root.querySelector<HTMLElement>('.result-title mark')).toBe(
      titleMark,
    );
    expect(root.querySelector<HTMLElement>('.result-namespace mark')).toBe(
      contentMark,
    );

    contentColor.dispatchEvent(new Event('change'));
    await nextTick();
    expect(callbacks.saveHighlightPreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ contentColor: '#ff8800' }),
    );
  });

  it('reflects injected preferences in controls and rendering', async () => {
    const { panel, root, mode, input, host } = mount({
      searchContent: vi.fn(() => [contentResult]),
    });

    panel.setHighlightPreferences({
      titleEnabled: true,
      contentEnabled: false,
      titleColor: '#c0ffec',
      contentColor: '#ffd6a5',
    });
    await nextTick();
    expect(
      root.querySelector<HTMLInputElement>('.title-highlight-toggle')?.checked,
    ).toBe(true);
    expect(
      root.querySelector<HTMLInputElement>('.content-highlight-toggle')
        ?.checked,
    ).toBe(false);
    expect(host.style.getPropertyValue('--cu-title-highlight')).toBe('#c0ffec');
    expect(host.style.getPropertyValue('--cu-content-highlight')).toBe(
      '#ffd6a5',
    );

    input.value = '紧急救治';
    mode.value = 'content';
    mode.dispatchEvent(new Event('change'));
    await nextTick();
    expect(
      root
        .querySelector<HTMLElement>('.result-title')
        ?.querySelectorAll('mark'),
    ).toHaveLength(1);
    expect(
      root
        .querySelector<HTMLElement>('.result-namespace')
        ?.querySelectorAll('mark'),
    ).toHaveLength(0);
  });

  it('renders results without highlight data as plain text', async () => {
    const plain: ContentSearchResult = {
      kind: 'content',
      id: 9,
      title: '普通页面',
      namespace: 0,
      namespaceName: '（主）',
      snippet: '普通正文内容。',
      score: 1,
    };
    const { root, mode, input } = mount({
      searchContent: vi.fn(() => [plain]),
    });

    input.value = '普通';
    mode.value = 'content';
    mode.dispatchEvent(new Event('change'));
    await nextTick();

    expect(root.querySelectorAll('.result-title mark')).toHaveLength(0);
    expect(root.querySelectorAll('.result-namespace mark')).toHaveLength(0);
    expect(root.querySelector<HTMLElement>('.result-title')?.textContent).toBe(
      '普通页面',
    );
    expect(
      root.querySelector<HTMLElement>('.result-namespace')?.textContent,
    ).toBe('（主） · 普通正文内容。');
  });
});

describe('SearchPanel layout contract', () => {
  it('keeps settings, maintenance, results, and details in one body scroller', async () => {
    const { root } = mountLayoutPanel();
    const body = root.querySelector<HTMLElement>('.panel-body');
    const header = root.querySelector<HTMLElement>('.header');
    const controls = root.querySelector<HTMLElement>('.controls');
    const footer = root.querySelector<HTMLElement>('.footer');
    if (!body || !header || !controls || !footer)
      throw new Error('面板布局没有挂载');

    for (const selector of [
      '.settings',
      '.maintenance',
      '.results',
      '.status-details',
    ]) {
      const element = root.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`缺少 ${selector}`);
      expect(body.contains(element)).toBe(true);
    }
    expect(body.contains(header)).toBe(false);
    expect(body.contains(controls)).toBe(false);
    expect(body.contains(footer)).toBe(false);
    expect(root.querySelectorAll('.panel-body')).toHaveLength(1);
  });

  it('mirrors long status text and expands it only after measured overflow', async () => {
    const { panel, root } = mountLayoutPanel();
    const panelElement = root.querySelector<HTMLElement>('.panel');
    const status = root.querySelector<HTMLElement>('.status');
    const details = root.querySelector<HTMLElement>('.status-details');
    const detailsToggle = root.querySelector<HTMLButtonElement>(
      '.status-details-toggle',
    );
    if (!panelElement || !status || !details || !detailsToggle) {
      throw new Error('状态控件没有挂载');
    }
    Object.defineProperties(status, {
      clientHeight: { configurable: true, value: 28 },
      scrollHeight: { configurable: true, value: 84 },
      clientWidth: { configurable: true, value: 280 },
      scrollWidth: { configurable: true, value: 280 },
    });

    panel.open();
    await nextTick();
    const longStatus = '第一行诊断\n第二行诊断\n第三行诊断：正文队列仍在处理';
    panel.setStatus(longStatus, 'error');
    await nextTick();
    await vi.waitFor(() => expect(detailsToggle.hidden).toBe(false));

    expect(status.textContent).toBe(longStatus);
    expect(details.textContent).toBe(longStatus);
    expect(details.hidden).toBe(true);
    expect(detailsToggle.textContent).toBe('查看完整状态');

    detailsToggle.click();
    await nextTick();
    expect(details.hidden).toBe(false);
    expect(details.textContent).toBe(longStatus);
    expect(detailsToggle.textContent).toBe('收起完整状态');
    expect(detailsToggle.getAttribute('aria-expanded')).toBe('true');

    panel.setStatus('后续状态已同步');
    await nextTick();
    expect(status.textContent).toBe('后续状态已同步');
    expect(details.textContent).toBe('后续状态已同步');

    detailsToggle.click();
    await nextTick();
    expect(details.hidden).toBe(true);
    expect(detailsToggle.getAttribute('aria-expanded')).toBe('false');
    expect(panelElement.hidden).toBe(false);
  });

  it('clamps drag and keyboard movement, cancels to origin, resets, and preserves reopen position', async () => {
    const restoreViewport = setLayoutViewport(1200, 800);
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) =>
        ({
          matches: query.includes('pointer: fine'),
          media: query,
          onchange: null,
          addListener: () => undefined,
          removeListener: () => undefined,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          dispatchEvent: () => false,
        }) as MediaQueryList,
    });

    try {
      const { panel, root } = mountLayoutPanel();
      const panelElement = root.querySelector<HTMLElement>('.panel');
      const handle = root.querySelector<HTMLElement>('.drag-handle');
      const close = root.querySelector<HTMLButtonElement>('.close');
      const reset = root.querySelector<HTMLButtonElement>('.reset-position');
      if (!panelElement || !handle || !close || !reset) {
        throw new Error('拖动控件没有挂载');
      }

      const pointerCapture = { active: false };
      Object.defineProperties(handle, {
        setPointerCapture: {
          configurable: true,
          value: vi.fn(() => {
            pointerCapture.active = true;
          }),
        },
        hasPointerCapture: {
          configurable: true,
          value: vi.fn(() => pointerCapture.active),
        },
        releasePointerCapture: {
          configurable: true,
          value: vi.fn(() => {
            pointerCapture.active = false;
          }),
        },
      });

      const width = 480;
      const height = 300;
      vi.spyOn(panelElement, 'getBoundingClientRect').mockImplementation(() => {
        const left = Number.parseFloat(panelElement.style.left) || 100;
        const top = Number.parseFloat(panelElement.style.top) || 120;
        return makeLayoutRect(left, top, width, height);
      });

      panel.open();
      await nextTick();
      const position = () => {
        const rect = panelElement.getBoundingClientRect();
        return { left: rect.left, top: rect.top };
      };
      const origin = position();

      handle.focus();
      await nextTick();
      handle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
      await nextTick();
      expect(position().left).toBe(origin.left + 10);
      handle.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          shiftKey: true,
          bubbles: true,
        }),
      );
      await nextTick();
      expect(position().left).toBe(origin.left + 11);

      reset.click();
      await nextTick();
      expect(panelElement.style.left).toBe('');
      expect(panelElement.style.top).toBe('');

      dispatchLayoutPointer(handle, 'pointerdown', {
        pointerId: 1,
        clientX: origin.left,
        clientY: origin.top,
      });
      dispatchLayoutPointer(handle, 'pointermove', {
        pointerId: 1,
        clientX: 2_000,
        clientY: 2_000,
      });
      expect(position().left).toBe(1200 - width - 12);
      expect(position().top).toBe(800 - height - 12);

      handle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await nextTick();
      expect(panelElement.hidden).toBe(false);
      expect(position()).toEqual(origin);

      dispatchLayoutPointer(handle, 'pointerdown', {
        pointerId: 2,
        clientX: origin.left,
        clientY: origin.top,
      });
      dispatchLayoutPointer(handle, 'pointermove', {
        pointerId: 2,
        clientX: origin.left + 90,
        clientY: origin.top + 70,
      });
      dispatchLayoutPointer(handle, 'pointercancel', {
        pointerId: 2,
        clientX: origin.left + 90,
        clientY: origin.top + 70,
      });
      expect(position()).toEqual(origin);

      dispatchLayoutPointer(handle, 'pointerdown', {
        pointerId: 3,
        clientX: origin.left,
        clientY: origin.top,
      });
      dispatchLayoutPointer(handle, 'pointermove', {
        pointerId: 3,
        clientX: origin.left + 90,
        clientY: origin.top + 70,
      });
      dispatchLayoutPointer(handle, 'pointerup', {
        pointerId: 3,
        clientX: origin.left + 90,
        clientY: origin.top + 70,
      });
      const committed = position();
      expect(committed).toEqual({
        left: origin.left + 90,
        top: origin.top + 70,
      });

      close.click();
      await nextTick();
      expect(panelElement.hidden).toBe(true);
      panel.open();
      await nextTick();
      expect(position()).toEqual(committed);

      reset.click();
      await nextTick();
      expect(panelElement.style.left).toBe('');
      expect(panelElement.style.top).toBe('');
      expect(panelElement.style.right).toBe('');
      expect(panelElement.style.bottom).toBe('');
    } finally {
      restoreViewport();
      if (originalMatchMedia) {
        Object.defineProperty(window, 'matchMedia', {
          configurable: true,
          value: originalMatchMedia,
        });
      } else {
        Reflect.deleteProperty(window, 'matchMedia');
      }
    }
  });

  it('retains highlight backgrounds and derives readable foreground colors', async () => {
    const { panel, host } = mountLayoutPanel();
    panel.setHighlightPreferences({
      titleEnabled: true,
      contentEnabled: true,
      titleColor: '#000000',
      contentColor: '#ffffff',
    });
    await nextTick();

    expect(host.style.getPropertyValue('--cu-title-highlight')).toBe('#000000');
    expect(host.style.getPropertyValue('--cu-title-highlight-color')).toBe(
      '#fff',
    );
    expect(host.style.getPropertyValue('--cu-content-highlight')).toBe(
      '#ffffff',
    );
    expect(host.style.getPropertyValue('--cu-content-highlight-color')).toBe(
      '#000',
    );

    panel.setHighlightPreferences({
      titleEnabled: true,
      contentEnabled: true,
      titleColor: '#ffffff',
      contentColor: '#000000',
    });
    await nextTick();
    expect(host.style.getPropertyValue('--cu-title-highlight-color')).toBe(
      '#000',
    );
    expect(host.style.getPropertyValue('--cu-content-highlight-color')).toBe(
      '#fff',
    );
  });
});

function maintenanceCallbacks(
  overrides: Partial<ConstructorParameters<typeof SearchPanel>[0]> = {},
): ConstructorParameters<typeof SearchPanel>[0] {
  return {
    prepareSearch: vi.fn(),
    prepareFiles: vi.fn(),
    search: vi.fn(() => []),
    searchFiles: vi.fn(() => []),
    searchLua: vi.fn(() => []),
    searchCss: vi.fn(() => []),
    searchContent: vi.fn(() => []),
    searchCodes: vi.fn(() => []),
    insert: vi.fn(),
    copyTitle: vi.fn(),
    copy: vi.fn(),
    copyCode: vi.fn(),
    open: vi.fn(),
    openCode: vi.fn(),
    refresh: vi.fn(),
    refreshFiles: vi.fn(),
    saveDataCodeRules: vi.fn(async () => undefined),
    saveHighlightPreferences: vi.fn(),
    loadMaintenance: vi.fn(async () => ({
      counts: {
        pages: 0,
        files: 0,
        dataCodes: 0,
        contentSources: 0,
        luaSources: 0,
      },
      jobs: { done: 0, pending: 0, running: 0, failed: 0 },
      snapshots: [],
      storage: {},
    })),
    rebuildSearchIndexes: vi.fn(async () => undefined),
    rebuildContentQueue: vi.fn(async () => undefined),
    reconcileNow: vi.fn(async () => undefined),
    clearSnapshots: vi.fn(async () => undefined),
    requestPersistence: vi.fn(async () => ({ status: 'unsupported' as const })),
    resetLocalMirror: vi.fn(async () => undefined),
    ...overrides,
  };
}

function mountLayoutPanel(
  overrides: Partial<ConstructorParameters<typeof SearchPanel>[0]> = {},
): { panel: SearchPanel; root: ShadowRoot; host: HTMLDivElement } {
  const panel = new SearchPanel(maintenanceCallbacks(overrides));
  const host = [
    ...document.querySelectorAll<HTMLDivElement>('#cu-wiki-search-host'),
  ].at(-1);
  const root = host?.shadowRoot;
  if (!host || !root) throw new Error('搜索面板没有挂载');
  return { panel, root, host };
}

function setLayoutViewport(width: number, height: number): () => void {
  const previousWidth = window.innerWidth;
  const previousHeight = window.innerHeight;
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: height,
  });
  return () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: previousWidth,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: previousHeight,
    });
  };
}

function makeLayoutRect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function dispatchLayoutPointer(
  target: EventTarget,
  type: string,
  values: { pointerId: number; clientX: number; clientY: number },
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({
    ...values,
    button: 0,
    pointerType: 'mouse',
  })) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  target.dispatchEvent(event);
}

describe('SearchPanel Vue lifecycle', () => {
  it('unmounts removed hosts and cancels queued focus, searches, layout and shortcuts', async () => {
    vi.useFakeTimers();
    try {
      const { panel, host, root } = mountLayoutPanel();
      const input = root.querySelector<HTMLInputElement>('.query')!;
      const focus = vi.spyOn(input, 'focus');
      const prepare = vi.fn();
      const search = vi.fn(() => []);
      const other = mountLayoutPanel({ prepareSearch: prepare, search });
      panel.open();
      other.panel.open();
      const otherInput = other.root.querySelector<HTMLInputElement>('.query')!;
      otherInput.value = 'pending';
      otherInput.dispatchEvent(new Event('input'));
      host.remove();
      other.host.remove();
      await nextTick();
      await nextTick();
      prepare.mockClear();
      search.mockClear();
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', altKey: true }),
      );
      await vi.runAllTimersAsync();
      expect(focus).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(search).not.toHaveBeenCalled();
      expect(root.querySelector('.panel')).toBeNull();
      expect(other.root.querySelector('.panel')).toBeNull();
      panel.destroy();
      other.panel.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not steal editor focus when opened and closed before Vue flushes', async () => {
    const { panel, root } = mountLayoutPanel();
    const editor = document.createElement('textarea');
    editor.id = 'editor-focus-target';
    document.body.append(editor);
    editor.focus();
    panel.open(editor);
    panel.close();
    await nextTick();
    expect(document.activeElement).toBe(editor);
    expect(root.querySelector<HTMLElement>('.panel')!.hidden).toBe(true);
  });

  it('keeps Wiki markup as text and preserves the result node across external color updates', async () => {
    const title = '<img src=x onerror=alert(1)> & 标题';
    const snippet = '<script>bad()</script>正文';
    const result: ContentSearchResult = {
      kind: 'content',
      id: 1,
      namespace: 0,
      namespaceName: '',
      title,
      snippet,
      score: 1,
      titleHighlights: [
        { start: -5, end: 4 },
        { start: 2, end: 9 },
        { start: 10, end: 999 },
      ],
      highlights: [{ start: 0, end: snippet.length }],
    };
    const { panel, root } = mountLayoutPanel({ searchContent: () => [result] });
    panel.open();
    await nextTick();
    const mode = root.querySelector<HTMLSelectElement>('.mode')!;
    const input = root.querySelector<HTMLInputElement>('.query')!;
    input.value = '正文';
    mode.value = 'content';
    mode.dispatchEvent(new Event('change'));
    panel.setHighlightPreferences({
      titleEnabled: true,
      contentEnabled: true,
      titleColor: '#aee2ff',
      contentColor: '#fff3a3',
    });
    await nextTick();
    const primary = root.querySelector<HTMLButtonElement>('.result-primary')!;
    const mark = root.querySelector('.result-title mark');
    primary.focus();
    panel.setHighlightPreferences({
      titleEnabled: true,
      contentEnabled: true,
      titleColor: '#ffffff',
      contentColor: '#000000',
    });
    await nextTick();
    expect(root.querySelector('.result-title')!.textContent).toBe(title);
    expect(root.querySelector('.result-namespace')!.textContent).toBe(
      `主命名空间 · ${snippet}`,
    );
    expect(root.querySelectorAll('img, script')).toHaveLength(0);
    expect(root.querySelector('.result-title mark')).toBe(mark);
    expect(root.activeElement).toBe(primary);
  });

  it('keeps invalid Data rules editable and returns focus to configuration after saving', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('无效路径'))
      .mockResolvedValue(undefined);
    const { panel, root } = mountLayoutPanel({ saveDataCodeRules: save });
    panel.setDataCodeRules('default', 'default');
    panel.open();
    await nextTick();
    const mode = root.querySelector<HTMLSelectElement>('.mode')!;
    mode.value = 'data-code';
    mode.dispatchEvent(new Event('change'));
    await nextTick();
    const configure = root.querySelector<HTMLButtonElement>('.configure')!;
    configure.click();
    await nextTick();
    const rules = root.querySelector<HTMLTextAreaElement>('.data-rules')!;
    expect(root.activeElement).toBe(rules);
    rules.value = 'bad';
    rules.dispatchEvent(new Event('input'));
    root.querySelector<HTMLButtonElement>('.save-rules')!.click();
    await vi.waitFor(() =>
      expect(root.querySelector('.status')!.textContent).toContain('无效路径'),
    );
    expect(root.querySelector<HTMLElement>('.settings')!.hidden).toBe(false);
    expect(rules.value).toBe('bad');
    root.querySelector<HTMLButtonElement>('.reset-rules')!.click();
    await vi.waitFor(() =>
      expect(root.querySelector<HTMLElement>('.settings')!.hidden).toBe(true),
    );
    expect(save).toHaveBeenLastCalledWith('default');
    expect(root.activeElement).toBe(configure);
  });
});

it('returns focus to the query when insertion support removes the focused action', async () => {
  const result: TitleSearchResult = {
    id: 1,
    title: '页面',
    namespace: 0,
    namespaceName: '',
    score: 1,
  };
  const { panel, root } = mountLayoutPanel({ search: () => [result] });
  panel.open();
  await nextTick();
  const input = root.querySelector<HTMLInputElement>('.query')!;
  input.value = '页面';
  panel.refreshResults();
  await nextTick();
  root.querySelector<HTMLButtonElement>('.insert-result')!.focus();
  panel.setInsertMode(false);
  await nextTick();
  expect(root.querySelector('.insert-result')).toBeNull();
  expect(root.activeElement).toBe(input);
});

describe('redirect links and CSS source results', () => {
  it('renders an independent native redirect link without changing source actions', async () => {
    const result: TitleSearchResult = {
      id: 42,
      title: '别名',
      namespace: 0,
      namespaceName: '（主）',
      score: 10,
      isRedirect: true,
      redirectResolved: true,
      redirectTarget: { title: '长标题'.repeat(80), fragment: '章节#1' },
    };
    const callbacks = maintenanceCallbacks({
      search: () => [result],
      redirectUrl: () => 'https://example.org/wiki/Target#section',
    });
    const panel = new SearchPanel(callbacks);
    panel.open();
    await nextTick();
    const root = document.querySelector('#cu-wiki-search-host')!.shadowRoot!;
    const input = root.querySelector<HTMLInputElement>('.query')!;
    input.value = '别名';
    panel.refreshResults();
    await nextTick();
    const link = root.querySelector<HTMLAnchorElement>('.redirect-target')!;
    expect(link.closest('button')).toBeNull();
    expect(link.href).toBe('https://example.org/wiki/Target#section');
    expect(link.target).toBe('_blank');
    expect(link.textContent).toContain('#章节#1');
    link.click();
    expect(callbacks.copyTitle).not.toHaveBeenCalled();
    expect(callbacks.insert).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('.result-primary')!.click();
    expect(callbacks.copyTitle).toHaveBeenCalledWith(result);
    root.querySelector<HTMLButtonElement>('.open-result')!.click();
    expect(callbacks.open).toHaveBeenCalledWith(result);
    expect(root.querySelector('.panel')?.hasAttribute('hidden')).toBe(false);
    panel.destroy();
  });

  it('shows pending and unresolved redirects without constructing a false target', async () => {
    const result: TitleSearchResult = {
      id: 1,
      title: '别名',
      namespace: 0,
      namespaceName: '（主）',
      score: 1,
      isRedirect: true,
    };
    const panel = new SearchPanel(
      maintenanceCallbacks({ search: () => [result] }),
    );
    panel.open();
    const root = document.querySelector('#cu-wiki-search-host')!.shadowRoot!;
    root.querySelector<HTMLInputElement>('.query')!.value = '别名';
    panel.refreshResults();
    await nextTick();
    expect(root.querySelector('.results')?.textContent).toContain('目标待同步');
    result.redirectResolved = true;
    panel.refreshResults();
    await nextTick();
    expect(root.querySelector('.results')?.textContent).toContain('未取得目标');
    expect(root.querySelector('.redirect-target')).toBeNull();
    panel.destroy();
  });

  it('searches CSS, shows safe highlighted source with line numbers, and blocks insertion', async () => {
    const result = {
      kind: 'css' as const,
      id: 1,
      title: 'MediaWiki:Gadget-test.css',
      namespace: 8,
      namespaceName: 'MediaWiki',
      matches: [
        {
          line: 12,
          text: '.card { content: "<script>"; }',
          highlights: [{ start: 0, end: 5 }],
        },
      ],
    };
    const callbacks = maintenanceCallbacks({
      searchCss: vi.fn(() => [result]),
    });
    const panel = new SearchPanel(callbacks);
    panel.open();
    await nextTick();
    const root = document.querySelector('#cu-wiki-search-host')!.shadowRoot!;
    const mode = root.querySelector<HTMLSelectElement>('.mode')!;
    const input = root.querySelector<HTMLInputElement>('.query')!;
    input.value = '.card';
    mode.value = 'css';
    mode.dispatchEvent(new Event('change'));
    await nextTick();
    expect(callbacks.prepareSearch).toHaveBeenCalledWith('css');
    expect(callbacks.searchCss).toHaveBeenCalledWith('.card');
    expect(root.querySelector('.css-line')?.textContent).toContain('12');
    expect(root.querySelector('.css-match mark')?.textContent).toBe('.card');
    expect(root.querySelector('.css-match script')).toBeNull();
    expect(root.querySelector('.insert-result')).toBeNull();
    expect(root.querySelector('.copy-result')).toBeNull();
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(callbacks.insert).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>('.result-primary')!.click();
    expect(callbacks.copyTitle).toHaveBeenCalledWith(result);
    root.querySelector<HTMLButtonElement>('.open-result')!.click();
    expect(callbacks.open).toHaveBeenCalledWith(result);
    panel.destroy();
  });
});

describe('SearchPanel six-mode contract', () => {
  const page = {
    id: 1,
    title: '页面',
    namespace: 0,
    namespaceName: '',
    score: 1,
  };
  const scenarios = [
    {
      mode: 'title',
      search: 'search',
      preparation: 'title',
      namespace: true,
      insertable: true,
      result: page,
    },
    {
      mode: 'content',
      search: 'searchContent',
      preparation: 'content',
      namespace: true,
      insertable: true,
      result: { ...page, kind: 'content', snippet: '正文' },
    },
    {
      mode: 'data-code',
      search: 'searchCodes',
      preparation: undefined,
      namespace: false,
      insertable: false,
      result: {
        kind: 'data-code',
        code: 'example',
        chineseName: '例子',
        dataType: 'item',
        source: 'Data:example',
        score: 1,
      },
    },
    {
      mode: 'lua',
      search: 'searchLua',
      preparation: 'lua',
      namespace: false,
      insertable: false,
      result: { ...page, kind: 'lua', matches: [] },
    },
    {
      mode: 'css',
      search: 'searchCss',
      preparation: 'css',
      namespace: false,
      insertable: false,
      result: { ...page, kind: 'css', matches: [] },
    },
    {
      mode: 'files',
      search: 'searchFiles',
      preparation: undefined,
      namespace: false,
      insertable: true,
      result: page,
    },
  ] as const;

  it.each(scenarios)(
    'routes $mode and agrees on button, keyboard and copy-link eligibility',
    async (scenario) => {
      const search = vi.fn(() => [scenario.result]);
      const callbacks = maintenanceCallbacks({ [scenario.search]: search });
      const panel = new SearchPanel(callbacks);
      const root = document.querySelector('#cu-wiki-search-host')!.shadowRoot!;
      const mode = root.querySelector<HTMLSelectElement>('.mode')!;
      const input = root.querySelector<HTMLInputElement>('.query')!;
      panel.open();
      await nextTick();
      vi.mocked(callbacks.prepareSearch).mockClear();
      for (const entry of scenarios)
        vi.mocked(callbacks[entry.search]).mockClear();
      input.value = 'query';
      mode.value = scenario.mode;
      mode.dispatchEvent(new Event('change'));
      await nextTick();

      expect(search).toHaveBeenCalledExactlyOnceWith(
        ...(scenario.namespace ? ['query', undefined] : ['query']),
      );
      for (const other of scenarios) {
        if (other.search !== scenario.search)
          expect(callbacks[other.search]).not.toHaveBeenCalled();
      }
      if (scenario.preparation)
        expect(callbacks.prepareSearch).toHaveBeenCalledExactlyOnceWith(
          scenario.preparation,
        );
      else expect(callbacks.prepareSearch).not.toHaveBeenCalled();
      expect(callbacks.prepareFiles).toHaveBeenCalledTimes(
        scenario.mode === 'files' ? 1 : 0,
      );
      expect(root.querySelector<HTMLElement>('.namespace')!.hidden).toBe(
        !scenario.namespace,
      );
      expect(
        root.querySelectorAll('.copy-result, .insert-result'),
      ).toHaveLength(scenario.insertable ? 2 : 0);
      panel.actions.copyLink(panel.state.results[0]!);
      expect(callbacks.copy).toHaveBeenCalledTimes(scenario.insertable ? 1 : 0);
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
        }),
      );
      expect(callbacks.insert).toHaveBeenCalledTimes(
        scenario.insertable ? 1 : 0,
      );
      panel.destroy();
    },
  );
});

describe('SearchPanel result invalidation scheduling', () => {
  afterEach(() => vi.useRealTimers());

  async function mount() {
    vi.useFakeTimers();
    const callbacks = maintenanceCallbacks();
    const panel = new SearchPanel(callbacks);
    const root = document.querySelector('#cu-wiki-search-host')!.shadowRoot!;
    const input = root.querySelector<HTMLInputElement>('.query')!;
    input.value = 'query';
    panel.open();
    await nextTick();
    for (const callback of [
      callbacks.search,
      callbacks.searchContent,
      callbacks.searchCodes,
      callbacks.searchFiles,
    ])
      vi.mocked(callback).mockClear();
    return { panel, root, input, callbacks };
  }

  it('coalesces relevant invalidations and ignores unrelated modes or pure state changes', async () => {
    const { panel, callbacks } = await mount();
    panel.invalidateResults(['files', 'data-code', 'content', 'lua', 'css']);
    panel.setStatus('diagnostics');
    panel.setNamespaces([{ id: 0, name: '（主）' }]);
    const namespaces = panel.state.namespaces;
    panel.setNamespaces([{ id: 0, name: '（主）' }]);
    expect(panel.state.namespaces).toBe(namespaces);
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.search).not.toHaveBeenCalled();
    panel.invalidateResults(['title']);
    panel.invalidateResults(['title']);
    panel.invalidateResults(['title']);
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.search).toHaveBeenCalledExactlyOnceWith(
      'query',
      undefined,
    );
    panel.destroy();
  });

  it('merges external updates into input debounce without advancing or repeating it', async () => {
    const { panel, input, callbacks } = await mount();
    input.value = 'latest';
    input.dispatchEvent(new Event('input'));
    panel.invalidateResults(['title']);
    await vi.advanceTimersByTimeAsync(119);
    expect(callbacks.search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks.search).toHaveBeenCalledExactlyOnceWith(
      'latest',
      undefined,
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(callbacks.search).toHaveBeenCalledOnce();
    panel.destroy();
  });

  it('does no hidden work and consumes dirty data or changed conditions when reopening', async () => {
    const { panel, input, callbacks } = await mount();
    input.value = 'pending';
    input.dispatchEvent(new Event('input'));
    panel.close();
    panel.invalidateResults(['title']);
    panel.refreshResults();
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.search).not.toHaveBeenCalled();
    panel.open();
    await nextTick();
    expect(callbacks.search).toHaveBeenCalledExactlyOnceWith(
      'pending',
      undefined,
    );
    vi.mocked(callbacks.search).mockClear();
    panel.close();
    panel.open();
    await nextTick();
    expect(callbacks.search).not.toHaveBeenCalled();
    panel.close();
    input.value = 'changed while hidden';
    panel.open();
    await nextTick();
    expect(callbacks.search).toHaveBeenCalledExactlyOnceWith(
      'changed while hidden',
      undefined,
    );
    panel.destroy();
  });

  it.each(['.query', '.data-rules'])(
    'waits throughout composition in %s and resumes once',
    async (selector) => {
      const { panel, root, input, callbacks } = await mount();
      input.value = 'pending';
      input.dispatchEvent(new Event('input'));
      const control = root.querySelector(selector)!;
      control.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true }),
      );
      panel.invalidateResults(['title']);
      panel.refreshResults();
      await vi.advanceTimersByTimeAsync(200);
      expect(callbacks.search).not.toHaveBeenCalled();
      control.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(callbacks.search).toHaveBeenCalledExactlyOnceWith(
        'pending',
        undefined,
      );
      await vi.advanceTimersByTimeAsync(200);
      expect(callbacks.search).toHaveBeenCalledOnce();
      panel.destroy();
    },
  );

  it('consumes old timers on mode, namespace and explicit refresh and destroys all queued work', async () => {
    const { panel, input, callbacks } = await mount();
    input.value = 'next';
    input.dispatchEvent(new Event('input'));
    panel.state.mode = 'content';
    panel.actions.mode();
    expect(callbacks.searchContent).toHaveBeenCalledExactlyOnceWith(
      'next',
      undefined,
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(callbacks.search).not.toHaveBeenCalled();
    expect(callbacks.searchContent).toHaveBeenCalledOnce();
    input.dispatchEvent(new Event('input'));
    panel.state.namespace = '828';
    panel.actions.search();
    expect(callbacks.searchContent).toHaveBeenLastCalledWith('next', 828);
    await vi.advanceTimersByTimeAsync(150);
    expect(callbacks.searchContent).toHaveBeenCalledTimes(2);
    panel.invalidateResults(['content']);
    panel.refreshResults();
    await vi.advanceTimersByTimeAsync(150);
    expect(callbacks.searchContent).toHaveBeenCalledTimes(3);
    panel.invalidateResults(['content']);
    panel.destroy();
    await vi.advanceTimersByTimeAsync(150);
    expect(callbacks.searchContent).toHaveBeenCalledTimes(3);
  });

  it('invalidates namespace filtering when the selected namespace disappears', async () => {
    const { panel, callbacks } = await mount();
    panel.setNamespaces([
      { id: 0, name: '（主）' },
      { id: 828, name: '模块' },
    ]);
    panel.state.namespace = '828';
    panel.actions.search();
    vi.mocked(callbacks.search).mockClear();
    panel.setNamespaces([{ id: 0, name: '（主）' }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.state.namespace).toBe('');
    expect(callbacks.search).toHaveBeenCalledExactlyOnceWith(
      'query',
      undefined,
    );
    panel.destroy();
  });

  it('preserves selected identity and native result/link focus through background updates', async () => {
    const { panel, root, callbacks, input } = await mount();
    callbacks.redirectUrl = () => 'https://example.org/wiki/Target';
    const first = {
      id: 1,
      title: '第一页',
      namespace: 0,
      namespaceName: '',
      score: 2,
    };
    const second = {
      ...first,
      id: 2,
      title: '别名',
      isRedirect: true,
      redirectResolved: true,
      redirectTarget: { title: '目标' },
    };
    vi.mocked(callbacks.search).mockReturnValue([first, second]);
    panel.refreshResults();
    await nextTick();
    const link = root.querySelector<HTMLAnchorElement>('.redirect-target')!;
    link.focus();
    await nextTick();
    vi.mocked(callbacks.search).mockReturnValue([
      { ...second, title: '改名后别名' },
      first,
    ]);
    panel.invalidateResults(['title']);
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.state.selectedIndex).toBe(0);
    expect(root.activeElement).toBe(link);
    expect(root.querySelector('.redirect-target')).toBe(link);
    const button = root.querySelector<HTMLButtonElement>('.result-primary')!;
    button.focus();
    vi.mocked(callbacks.search).mockReturnValue([first]);
    panel.invalidateResults(['title']);
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.state.selectedIndex).toBe(0);
    expect(root.activeElement).toBe(input);
    vi.mocked(callbacks.search).mockReturnValue([first, second]);
    panel.refreshResults();
    await nextTick();
    panel.actions.select(1);
    input.value = 'different';
    panel.refreshResults();
    expect(panel.state.selectedIndex).toBe(0);
    panel.destroy();
  });

  it('does not repair lost result focus after the user has focused another control', async () => {
    const { panel, root, callbacks } = await mount();
    vi.mocked(callbacks.search).mockReturnValue([
      { id: 1, title: '页面', namespace: 0, namespaceName: '', score: 1 },
    ]);
    panel.refreshResults();
    await nextTick();
    root.querySelector<HTMLButtonElement>('.result-primary')!.focus();
    vi.mocked(callbacks.search).mockReturnValue([]);
    panel.refreshResults();
    const mode = root.querySelector<HTMLSelectElement>('.mode')!;
    mode.focus();
    await nextTick();
    expect(root.activeElement).toBe(mode);
    expect(panel.state.selectedIndex).toBe(-1);
    panel.destroy();
  });

  it('preserves Data selection by source and code when rows reorder', async () => {
    const { panel, callbacks } = await mount();
    const first = {
      kind: 'data-code' as const,
      source: 'Data:A',
      code: 'same',
      chineseName: '甲',
      dataType: 'item',
      score: 1,
    };
    const second = { ...first, source: 'Data:B', chineseName: '乙' };
    vi.mocked(callbacks.searchCodes).mockReturnValue([first, second]);
    panel.state.mode = 'data-code';
    panel.actions.mode();
    panel.actions.select(1);
    vi.mocked(callbacks.searchCodes).mockReturnValue([second, first]);
    panel.invalidateResults(['data-code']);
    await vi.advanceTimersByTimeAsync(0);
    expect(panel.state.selectedIndex).toBe(0);
    expect(panel.state.results[0]).toBe(second);
    panel.destroy();
  });
});

it('reveals the A4 launcher before synchronously returning focus to it', async () => {
  const { panel, root } = mountLayoutPanel();
  const toggle = root.querySelector<HTMLButtonElement>('.toggle')!;
  toggle.focus();
  toggle.click();
  await nextTick();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  const focus = vi.spyOn(toggle, 'focus').mockImplementation(() => {
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
  panel.close();
  expect(focus).toHaveBeenCalledOnce();
  await nextTick();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  focus.mockRestore();
  panel.destroy();
});
