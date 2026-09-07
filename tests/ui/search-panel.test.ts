// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom

import type { ContentSearchResult } from '../../src/search/content-index';
import type { DataCodeSearchResult } from '../../src/search/data-code-index';
import type { LuaModuleSearchResult } from '../../src/search/lua-module-index';
import type { TitleSearchResult } from '../../src/search/title-index';
import { SearchPanel } from '../../src/ui/search-panel';

afterEach(() => {
  document.querySelectorAll('#cu-wiki-search-host').forEach((host) => host.remove());
  document.querySelector('#editor-focus-target')?.remove();
});

describe('SearchPanel file resource mode', () => {
  it('uses an isolated file search entry and prepares it only when selected', () => {
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
    new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('.query');
    const mode = root?.querySelector<HTMLSelectElement>('.mode');
    if (!root || !input || !mode) throw new Error('搜索面板没有挂载');

    input.value = 'morphine';
    mode.value = 'files';
    mode.dispatchEvent(new Event('change'));

    expect(callbacks.prepareFiles).toHaveBeenCalledOnce();
    expect(callbacks.searchFiles).toHaveBeenCalledWith('morphine');
    expect(callbacks.search).not.toHaveBeenCalled();
    expect(root.querySelector('.heading')?.textContent).toBe('查找文件资源');
    expect(root.querySelector<HTMLElement>('.namespace')?.hidden).toBe(true);
    expect(root.querySelector('.results')?.textContent).toContain('文件:Item morphine.png');
  });
});

describe('SearchPanel Lua module mode', () => {
  it('routes only to structured Lua search, copies the primary title, and only offers source opening', () => {
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
    new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('.query');
    const mode = root?.querySelector<HTMLSelectElement>('.mode');
    if (!root || !input || !mode) throw new Error('搜索面板没有挂载');

    input.value = 'main';
    mode.value = 'lua';
    mode.dispatchEvent(new Event('change'));

    expect(callbacks.prepareSearch).toHaveBeenCalledOnce();
    expect(callbacks.prepareSearch).toHaveBeenCalledWith('lua');
    expect(callbacks.searchLua).toHaveBeenCalledWith('main');
    expect(callbacks.searchContent).not.toHaveBeenCalled();
    expect(root.querySelector('.heading')?.textContent).toBe('查找 Lua 模块');
    expect(root.querySelector<HTMLElement>('.namespace')?.hidden).toBe(true);
    expect(root.querySelector('.results')?.textContent).toContain('函数 · p.main');

    root.querySelector<HTMLButtonElement>('.result-primary')?.click();
    expect(callbacks.copyTitle).toHaveBeenCalledWith(luaResult);
    expect(callbacks.insert).not.toHaveBeenCalled();
    expect(root.querySelectorAll('.copy-result, .insert-result')).toHaveLength(0);
    root.querySelector<HTMLButtonElement>('.open-result')?.click();
    expect(callbacks.open).toHaveBeenCalledWith(luaResult);
  });
});

describe('SearchPanel result actions', () => {
  it('copies page titles from the primary action and orders the available secondary actions', () => {
    const result: TitleSearchResult = {
      id: 12,
      title: '12号鹿弹',
      namespace: 0,
      namespaceName: '',
      score: 100,
    };
    const callbacks = maintenanceCallbacks({ search: vi.fn(() => [result]) });
    const panel = new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    const panelElement = root?.querySelector<HTMLElement>('.panel');
    const input = root?.querySelector<HTMLInputElement>('.query');
    if (!root || !panelElement || !input) throw new Error('搜索面板没有挂载');

    panel.open();
    input.value = '鹿弹';
    panel.refreshResults();
    expect(
      [...root.querySelectorAll<HTMLElement>('.result .action')].map(
        (action) => action.textContent,
      ),
    ).toEqual(['打开', '复制插入内容', '插入']);

    const primary = root.querySelector<HTMLButtonElement>('.insert.result-primary');
    if (!primary) throw new Error('结果主按钮没有挂载');
    primary.click();
    expect(callbacks.copyTitle).toHaveBeenCalledWith(result);
    expect(panelElement.hidden).toBe(false);

    root.querySelector<HTMLButtonElement>('.open-result')?.click();
    expect(callbacks.open).toHaveBeenCalledWith(result);
    root.querySelector<HTMLButtonElement>('.copy-result')?.click();
    expect(callbacks.copy).toHaveBeenCalledWith(result, '鹿弹');
    root.querySelector<HTMLButtonElement>('.insert-result')?.click();
    expect(callbacks.insert).toHaveBeenCalledWith(result, '鹿弹');
    expect(panelElement.hidden).toBe(true);
    panel.open();
    panel.setInsertMode(false);
    panel.refreshResults();
    expect(root.querySelector('.insert-result')).toBeNull();
  });

  it('copies Data codes from the primary action and only offers opening the source', () => {
    const result: DataCodeSearchResult = {
      kind: 'data-code',
      source: 'Data:Item.json',
      chineseName: '鹿弹代码',
      code: 'buckshot_12',
      dataType: 'item',
      score: 100,
    };
    const callbacks = maintenanceCallbacks({ searchCodes: vi.fn(() => [result]) });
    const panel = new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('.query');
    const mode = root?.querySelector<HTMLSelectElement>('.mode');
    if (!root || !input || !mode) throw new Error('搜索面板没有挂载');

    panel.open();
    input.value = 'buckshot';
    mode.value = 'data-code';
    mode.dispatchEvent(new Event('change'));

    root.querySelector<HTMLButtonElement>('.result-primary')?.click();
    expect(callbacks.copyCode).toHaveBeenCalledWith(result);
    expect(callbacks.copyTitle).not.toHaveBeenCalled();
    expect(
      [...root.querySelectorAll<HTMLElement>('.result .action')].map(
        (action) => action.textContent,
      ),
    ).toEqual(['打开来源']);
    root.querySelector<HTMLButtonElement>('.open-result')?.click();
    expect(callbacks.openCode).toHaveBeenCalledWith(result);
  });
});

describe('SearchPanel lazy search preparation', () => {
  it('prepares only the selected heavy mode and leaves Data code mode lightweight', () => {
    const callbacks = maintenanceCallbacks();
    const panel = new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('.query');
    const mode = root?.querySelector<HTMLSelectElement>('.mode');
    if (!root || !input || !mode) throw new Error('搜索面板没有挂载');

    panel.open();
    expect(callbacks.prepareSearch).toHaveBeenLastCalledWith('title');

    mode.value = 'content';
    mode.dispatchEvent(new Event('change'));
    expect(callbacks.prepareSearch).toHaveBeenLastCalledWith('content');

    mode.value = 'data-code';
    mode.dispatchEvent(new Event('change'));
    expect(callbacks.prepareSearch).toHaveBeenCalledTimes(2);
    expect(input.placeholder).toBe('中文名、英文代码片段或已配置字段值');
    expect(input.getAttribute('aria-label')).toBe('搜索 Data 代码');
    expect(root.querySelector('.results')?.textContent).toContain(
      '输入中文名、英文代码片段或已配置字段值查找代码',
    );
    expect(root.querySelector('.settings .settings-help')?.textContent).toContain(
      '英文 id 本身始终可搜索',
    );

    mode.value = 'files';
    mode.dispatchEvent(new Event('change'));
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
        counts: { pages: 3, files: 1, dataCodes: 2, contentSources: 2, luaSources: 1 },
        jobs: { done: 2, pending: 1, running: 0, failed: 0 },
        snapshots: [
          { kind: 'title' as const, status: 'available' as const, throughLocalSeq: 3 },
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
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    if (!root) throw new Error('搜索面板没有挂载');

    root.querySelector<HTMLButtonElement>('.maintenance-toggle')?.click();
    await vi.waitFor(() => {
      expect(root.querySelector('.maintenance-output')?.textContent).toContain('页面 3');
    });
    expect(root.querySelector('.reconcile-now')?.textContent).toContain('需要联网');
    expect(root.querySelector<HTMLElement>('.danger-confirmation')?.hidden).toBe(true);

    root.querySelector<HTMLButtonElement>('.reveal-danger')?.click();
    expect(root.querySelector<HTMLElement>('.danger-confirmation')?.hidden).toBe(false);
    const checkbox = root.querySelector<HTMLInputElement>('.reset-data-rules');
    expect(checkbox?.checked).toBe(false);
    if (!checkbox) throw new Error('缺少重置规则复选框');
    checkbox.checked = true;
    root.querySelector<HTMLButtonElement>('.reset-local')?.click();
    expect(callbacks.resetLocalMirror).toHaveBeenCalledWith(true);

    await vi.waitFor(() => {
      expect(root.querySelector<HTMLButtonElement>('.reset-local')?.disabled).toBe(false);
    });

    root.querySelector<HTMLButtonElement>('.request-persistence')?.click();
    await vi.waitFor(() => {
      expect(root.querySelector('.status')?.textContent).toContain('未授予持久保存');
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
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    if (!root) throw new Error('搜索面板没有挂载');

    root.querySelector<HTMLButtonElement>('.reveal-danger')?.click();
    const resetButton = root.querySelector<HTMLButtonElement>('.reset-local');
    const rebuildButton = root.querySelector<HTMLButtonElement>('.rebuild-indexes');
    const reconcileButton = root.querySelector<HTMLButtonElement>('.reconcile-now');
    if (!resetButton || !rebuildButton || !reconcileButton) {
      throw new Error('维护按钮没有挂载');
    }

    resetButton.click();
    resetButton.click();
    rebuildButton.click();
    reconcileButton.click();

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
    expect(root.querySelector('.status')?.textContent).not.toContain('操作完成');
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
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    if (!root) throw new Error('搜索面板没有挂载');
    const rebuildButton = root.querySelector<HTMLButtonElement>('.rebuild-indexes');
    const queueButton = root.querySelector<HTMLButtonElement>('.rebuild-content-queue');
    const resetButton = root.querySelector<HTMLButtonElement>('.reset-local');
    if (!rebuildButton || !queueButton || !resetButton) throw new Error('维护按钮没有挂载');

    rebuildButton.click();

    expect([...root.querySelectorAll<HTMLButtonElement>('.maintenance-action')]).toSatisfy(
      (buttons: HTMLButtonElement[]) => buttons.every((button) => button.disabled),
    );
    queueButton.click();
    resetButton.click();
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
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    if (!root) throw new Error('搜索面板没有挂载');

    root.querySelector<HTMLButtonElement>('.rebuild-indexes')?.click();

    await vi.waitFor(() => {
      expect(root.querySelector('.status')?.textContent).toContain(
        '索引已重建，某些快照未保存',
      );
    });
    expect(root.querySelector<HTMLElement>('.status')?.dataset.tone).toBe('normal');
    expect(root.querySelector('.maintenance-output')?.textContent).not.toContain(
      '本地维护操作失败',
    );
  });
});

describe('SearchPanel startup recovery', () => {
  it('shows a reload recovery action instead of remaining in loading state', () => {
    const reload = vi.fn();
    const callbacks = maintenanceCallbacks();
    const panel = new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    if (!root) throw new Error('搜索面板没有挂载');

    panel.setStartupFailure('IndexedDB 无法打开', reload);
    panel.open();

    expect(root.querySelector('.status')?.textContent).toContain('IndexedDB 无法打开');
    expect(root.querySelector<HTMLElement>('.status')?.dataset.tone).toBe('error');
    expect(callbacks.prepareSearch).not.toHaveBeenCalled();
    const reloadButton = root.querySelector<HTMLButtonElement>('.reload-startup');
    expect(reloadButton?.hidden).toBe(false);
    reloadButton?.click();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('keeps mode and refresh controls from restarting work after startup failed', () => {
    const callbacks = maintenanceCallbacks();
    const panel = new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    if (!root) throw new Error('搜索面板没有挂载');
    const mode = root.querySelector<HTMLSelectElement>('.mode');
    const refresh = root.querySelector<HTMLButtonElement>('.refresh');
    if (!mode || !refresh) throw new Error('搜索控件没有挂载');

    panel.setStartupFailure('IndexedDB 无法打开', vi.fn());
    mode.value = 'files';
    mode.dispatchEvent(new Event('change'));
    refresh.click();

    expect(callbacks.prepareSearch).not.toHaveBeenCalled();
    expect(callbacks.prepareFiles).not.toHaveBeenCalled();
    expect(callbacks.refresh).not.toHaveBeenCalled();
    expect(callbacks.refreshFiles).not.toHaveBeenCalled();
    expect(root.querySelector('.status')?.textContent).toContain('IndexedDB 无法打开');
  });
});

describe('SearchPanel keyboard lifecycle', () => {
  it('accepts only plain Alt+K and gives the shortcut to the latest panel instance', () => {
    new SearchPanel(maintenanceCallbacks());
    new SearchPanel(maintenanceCallbacks());
    const panels = [...document.querySelectorAll<HTMLDivElement>('#cu-wiki-search-host')].map(
      (host) => host.shadowRoot?.querySelector<HTMLElement>('.panel'),
    );
    if (panels.some((panel) => !panel)) throw new Error('搜索面板没有挂载');
    const latest = panels[1]!;

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', altKey: true, ctrlKey: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', altKey: true, metaKey: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', altKey: true, shiftKey: true }),
    );
    const altGraph = new KeyboardEvent('keydown', { key: 'k', altKey: true });
    vi.spyOn(altGraph, 'getModifierState').mockImplementation(
      (key) => key === 'AltGraph',
    );
    window.dispatchEvent(altGraph);

    expect(panels.every((panel) => panel?.hidden)).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', altKey: true }));
    expect(panels[0]?.hidden).toBe(true);
    expect(latest.hidden).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', altKey: true }));
    expect(latest.hidden).toBe(true);
  });

  it.each(['.query', '.mode', '.data-rules', '.rebuild-indexes'])(
    'closes from %s when Escape bubbles through the open panel',
    (selector) => {
      const panel = new SearchPanel(maintenanceCallbacks());
      const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
      const panelElement = root?.querySelector<HTMLElement>('.panel');
      const control = root?.querySelector<HTMLElement>(selector);
      if (!root || !panelElement || !control) throw new Error('搜索面板没有挂载');
      panel.open();

      control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(panelElement.hidden).toBe(true);
    },
  );

  it('leaves Escape to IME composition outside the query input and honors isComposing', () => {
    const panel = new SearchPanel(maintenanceCallbacks());
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    const panelElement = root?.querySelector<HTMLElement>('.panel');
    const dataRules = root?.querySelector<HTMLTextAreaElement>('.data-rules');
    if (!root || !panelElement || !dataRules) throw new Error('搜索面板没有挂载');
    panel.open();

    dataRules.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    dataRules.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(panelElement.hidden).toBe(false);

    dataRules.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    dataRules.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        isComposing: true,
      }),
    );
    expect(panelElement.hidden).toBe(false);

    dataRules.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(panelElement.hidden).toBe(true);
  });

  it('preserves modified input arrows and dispatches only defined query shortcuts', () => {
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
    const callbacks = maintenanceCallbacks({ search: vi.fn(() => [first, second]) });
    const panel = new SearchPanel(callbacks);
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('.query');
    const mode = root?.querySelector<HTMLSelectElement>('.mode');
    if (!root || !input || !mode) throw new Error('搜索面板没有挂载');
    panel.open();
    input.value = '页面';
    panel.refreshResults();
    mode.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
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
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(callbacks.copyTitle).toHaveBeenLastCalledWith(first);
    expect(root.querySelector<HTMLElement>('.panel')?.hidden).toBe(false);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(callbacks.copyTitle).toHaveBeenLastCalledWith(second);

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    );
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
    );
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
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }),
    );
    expect(callbacks.copyTitle).toHaveBeenCalledTimes(2);
    expect(callbacks.open).toHaveBeenCalledTimes(2);
    expect(callbacks.insert).not.toHaveBeenCalled();

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
    );
    expect(callbacks.insert).toHaveBeenCalledWith(second, '页面');
    expect(root.querySelector<HTMLElement>('.panel')?.hidden).toBe(true);
  });

  it('uses the focused result for primary shortcuts and restores query focus before refresh removes it', () => {
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
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('.query');
    if (!root || !input) throw new Error('搜索面板没有挂载');
    panel.open();
    input.value = '页面';
    panel.refreshResults();
    const primaries = [...root.querySelectorAll<HTMLButtonElement>('.result-primary')];
    const items = [...root.querySelectorAll<HTMLElement>('.result')];
    if (primaries.length !== 2 || items.length !== 2) throw new Error('结果按钮没有挂载');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    primaries[0]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
    );
    expect(callbacks.open).toHaveBeenLastCalledWith(first);

    primaries[1]?.focus();
    expect(items[1]?.dataset.selected).toBe('true');
    primaries[0]?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
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
    results = [];
    panel.refreshResults();
    expect(root.activeElement).toBe(input);
  });

  it('cycles Tab inside the panel, skips unavailable controls, and stops site propagation', () => {
    const panel = new SearchPanel(maintenanceCallbacks());
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    const handle = root?.querySelector<HTMLElement>('.drag-handle');
    const input = root?.querySelector<HTMLInputElement>('.query');
    const mode = root?.querySelector<HTMLSelectElement>('.mode');
    const namespace = root?.querySelector<HTMLSelectElement>('.namespace');
    if (!root || !handle || !input || !mode || !namespace) {
      throw new Error('搜索面板没有挂载');
    }
    panel.open();
    namespace.disabled = true;
    for (const control of root.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, [tabindex]',
    )) {
      vi.spyOn(control, 'getClientRects').mockReturnValue(
        [makeLayoutRect(0, 0, 10, 10)] as unknown as DOMRectList,
      );
    }

    const siteKeydown = vi.fn();
    window.addEventListener('keydown', siteKeydown);
    try {
      input.focus();
      const internalTab = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      input.dispatchEvent(internalTab);
      expect(internalTab.defaultPrevented).toBe(false);
      expect(siteKeydown).not.toHaveBeenCalled();

      handle.focus();
      const backward = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      handle.dispatchEvent(backward);
      expect(backward.defaultPrevented).toBe(true);
      expect(root.activeElement).toBe(mode);

      const forward = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      mode.dispatchEvent(forward);
      expect(forward.defaultPrevented).toBe(true);
      expect(root.activeElement).toBe(handle);
      expect(siteKeydown).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', siteKeydown);
    }
  });

  it('leaves Escape to the active IME and restores the editor focus when closing later', () => {
    const editor = document.createElement('textarea');
    editor.id = 'editor-focus-target';
    document.body.append(editor);
    editor.focus();
    const panel = new SearchPanel(maintenanceCallbacks());
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('.query');
    const panelElement = root?.querySelector<HTMLElement>('.panel');
    if (!root || !input || !panelElement) throw new Error('搜索面板没有挂载');

    panel.open();
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(panelElement.hidden).toBe(false);

    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(panelElement.hidden).toBe(true);
    expect(document.activeElement).toBe(editor);
  });

  it('keeps editor focus established by the explicit insert action', () => {
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
    const root = document.querySelector<HTMLDivElement>('#cu-wiki-search-host')?.shadowRoot;
    const toggle = root?.querySelector<HTMLButtonElement>('.toggle');
    const input = root?.querySelector<HTMLInputElement>('.query');
    if (!root || !toggle || !input) throw new Error('搜索面板没有挂载');

    toggle.click();
    input.value = '鹿弹';
    panel.refreshResults();
    root.querySelector<HTMLButtonElement>('.insert-result')?.click();

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

  function mount(overrides: Partial<ConstructorParameters<typeof SearchPanel>[0]> = {}): {
    callbacks: ConstructorParameters<typeof SearchPanel>[0];
    panel: SearchPanel;
    root: ShadowRoot;
    mode: HTMLSelectElement;
    input: HTMLInputElement;
    host: HTMLDivElement;
  } {
    const callbacks = maintenanceCallbacks(overrides);
    const panel = new SearchPanel(callbacks);
    const host = document.querySelector<HTMLDivElement>('#cu-wiki-search-host');
    const root = host?.shadowRoot;
    const input = root?.querySelector<HTMLInputElement>('.query');
    const mode = root?.querySelector<HTMLSelectElement>('.mode');
    if (!host || !root || !input || !mode) throw new Error('搜索面板没有挂载');
    return { callbacks, panel, root, mode, input, host };
  }

  it('shows highlight settings only in content mode with correct defaults', () => {
    const { root, mode } = mount();
    const section = root.querySelector<HTMLElement>('.highlight-settings');
    if (!section) throw new Error('缺少高亮设置区');

    expect(section.hidden).toBe(true);
    mode.value = 'content';
    mode.dispatchEvent(new Event('change'));
    expect(section.hidden).toBe(false);
    expect(root.querySelector<HTMLInputElement>('.title-highlight-toggle')?.checked).toBe(false);
    expect(root.querySelector<HTMLInputElement>('.content-highlight-toggle')?.checked).toBe(true);
    expect(root.querySelector<HTMLInputElement>('.title-highlight-color')?.value).toBe('#aee2ff');
    expect(root.querySelector<HTMLInputElement>('.content-highlight-color')?.value).toBe('#fff3a3');

    mode.value = 'title';
    mode.dispatchEvent(new Event('change'));
    expect(section.hidden).toBe(true);
  });

  it('renders snippet marks by default and leaves the title plain', () => {
    const { callbacks, root, mode, input } = mount({
      searchContent: vi.fn(() => [contentResult]),
    });

    input.value = '紧急救治';
    mode.value = 'content';
    mode.dispatchEvent(new Event('change'));

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

  it('applies toggles, persists preferences, and re-renders marks', () => {
    const { callbacks, root, mode, input } = mount({
      searchContent: vi.fn(() => [contentResult]),
    });

    input.value = '紧急救治';
    mode.value = 'content';
    mode.dispatchEvent(new Event('change'));

    const titleToggle = root.querySelector<HTMLInputElement>('.title-highlight-toggle');
    const contentToggle = root.querySelector<HTMLInputElement>('.content-highlight-toggle');
    if (!titleToggle || !contentToggle) throw new Error('缺少高亮开关');

    titleToggle.checked = true;
    titleToggle.dispatchEvent(new Event('change'));
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

  it('applies colors as CSS custom properties and persists on change only', () => {
    const { callbacks, panel, root, mode, host, input } = mount({
      searchContent: vi.fn(() => [contentResult]),
    });

    panel.setHighlightPreferences({
      titleEnabled: true,
      contentEnabled: true,
      titleColor: '#aee2ff',
      contentColor: '#fff3a3',
    });
    expect(host.style.getPropertyValue('--cu-title-highlight')).toBe('#aee2ff');
    expect(host.style.getPropertyValue('--cu-content-highlight')).toBe('#fff3a3');

    mode.value = 'content';
    mode.dispatchEvent(new Event('change'));
    input.value = '紧急救治';
    panel.refreshResults();
    const result = root.querySelector<HTMLElement>('.result');
    const titleMark = root.querySelector<HTMLElement>('.result-title mark');
    const contentMark = root.querySelector<HTMLElement>('.result-namespace mark');
    const titleColor = root.querySelector<HTMLInputElement>('.title-highlight-color');
    const contentColor = root.querySelector<HTMLInputElement>('.content-highlight-color');
    if (!result || !titleMark || !contentMark || !titleColor || !contentColor) {
      throw new Error('高亮结果或颜色选择器没有挂载');
    }

    titleColor.value = '#c0ffec';
    titleColor.dispatchEvent(new Event('input'));
    expect(host.style.getPropertyValue('--cu-title-highlight')).toBe('#c0ffec');
    expect(callbacks.saveHighlightPreferences).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLElement>('.result')).toBe(result);
    expect(root.querySelector<HTMLElement>('.result-title mark')).toBe(titleMark);
    expect(root.querySelector<HTMLElement>('.result-namespace mark')).toBe(contentMark);

    titleColor.dispatchEvent(new Event('change'));
    expect(callbacks.saveHighlightPreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ titleColor: '#c0ffec' }),
    );

    contentColor.value = '#ff8800';
    contentColor.dispatchEvent(new Event('input'));
    expect(host.style.getPropertyValue('--cu-content-highlight')).toBe('#ff8800');
    expect(callbacks.saveHighlightPreferences).toHaveBeenCalledTimes(1);
    expect(root.querySelector<HTMLElement>('.result')).toBe(result);
    expect(root.querySelector<HTMLElement>('.result-title mark')).toBe(titleMark);
    expect(root.querySelector<HTMLElement>('.result-namespace mark')).toBe(contentMark);

    contentColor.dispatchEvent(new Event('change'));
    expect(callbacks.saveHighlightPreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ contentColor: '#ff8800' }),
    );
  });

  it('reflects injected preferences in controls and rendering', () => {
    const { panel, root, mode, input, host } = mount({
      searchContent: vi.fn(() => [contentResult]),
    });

    panel.setHighlightPreferences({
      titleEnabled: true,
      contentEnabled: false,
      titleColor: '#c0ffec',
      contentColor: '#ffd6a5',
    });
    expect(root.querySelector<HTMLInputElement>('.title-highlight-toggle')?.checked).toBe(true);
    expect(root.querySelector<HTMLInputElement>('.content-highlight-toggle')?.checked).toBe(false);
    expect(host.style.getPropertyValue('--cu-title-highlight')).toBe('#c0ffec');
    expect(host.style.getPropertyValue('--cu-content-highlight')).toBe('#ffd6a5');

    input.value = '紧急救治';
    mode.value = 'content';
    mode.dispatchEvent(new Event('change'));
    expect(root.querySelector<HTMLElement>('.result-title')?.querySelectorAll('mark')).toHaveLength(1);
    expect(root.querySelector<HTMLElement>('.result-namespace')?.querySelectorAll('mark')).toHaveLength(0);
  });

  it('renders results without highlight data as plain text', () => {
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

    expect(root.querySelectorAll('.result-title mark')).toHaveLength(0);
    expect(root.querySelectorAll('.result-namespace mark')).toHaveLength(0);
    expect(root.querySelector<HTMLElement>('.result-title')?.textContent).toBe('普通页面');
    expect(root.querySelector<HTMLElement>('.result-namespace')?.textContent).toBe(
      '（主） · 普通正文内容。',
    );
  });
});

describe('SearchPanel layout contract', () => {
  it('keeps settings, maintenance, results, and details in one body scroller', () => {
    const { root } = mountLayoutPanel();
    const body = root.querySelector<HTMLElement>('.panel-body');
    const header = root.querySelector<HTMLElement>('.header');
    const controls = root.querySelector<HTMLElement>('.controls');
    const footer = root.querySelector<HTMLElement>('.footer');
    if (!body || !header || !controls || !footer) throw new Error('面板布局没有挂载');

    for (const selector of ['.settings', '.maintenance', '.results', '.status-details']) {
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
    const detailsToggle = root.querySelector<HTMLButtonElement>('.status-details-toggle');
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
    const longStatus = '第一行诊断\n第二行诊断\n第三行诊断：正文队列仍在处理';
    panel.setStatus(longStatus, 'error');
    await vi.waitFor(() => expect(detailsToggle.hidden).toBe(false));

    expect(status.textContent).toBe(longStatus);
    expect(details.textContent).toBe(longStatus);
    expect(details.hidden).toBe(true);
    expect(detailsToggle.textContent).toBe('查看完整状态');

    detailsToggle.click();
    expect(details.hidden).toBe(false);
    expect(details.textContent).toBe(longStatus);
    expect(detailsToggle.textContent).toBe('收起完整状态');
    expect(detailsToggle.getAttribute('aria-expanded')).toBe('true');

    panel.setStatus('后续状态已同步');
    expect(status.textContent).toBe('后续状态已同步');
    expect(details.textContent).toBe('后续状态已同步');

    detailsToggle.click();
    expect(details.hidden).toBe(true);
    expect(detailsToggle.getAttribute('aria-expanded')).toBe('false');
    expect(panelElement.hidden).toBe(false);
  });

  it('clamps drag and keyboard movement, cancels to origin, resets, and preserves reopen position', () => {
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
      const position = () => {
        const rect = panelElement.getBoundingClientRect();
        return { left: rect.left, top: rect.top };
      };
      const origin = position();

      handle.focus();
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      expect(position().left).toBe(origin.left + 10);
      handle.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
      );
      expect(position().left).toBe(origin.left + 11);

      reset.click();
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

      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
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
      expect(committed).toEqual({ left: origin.left + 90, top: origin.top + 70 });

      close.click();
      expect(panelElement.hidden).toBe(true);
      panel.open();
      expect(position()).toEqual(committed);

      reset.click();
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

  it('retains highlight backgrounds and derives readable foreground colors', () => {
    const { panel, host } = mountLayoutPanel();
    panel.setHighlightPreferences({
      titleEnabled: true,
      contentEnabled: true,
      titleColor: '#000000',
      contentColor: '#ffffff',
    });

    expect(host.style.getPropertyValue('--cu-title-highlight')).toBe('#000000');
    expect(host.style.getPropertyValue('--cu-title-highlight-color')).toBe('#fff');
    expect(host.style.getPropertyValue('--cu-content-highlight')).toBe('#ffffff');
    expect(host.style.getPropertyValue('--cu-content-highlight-color')).toBe('#000');

    panel.setHighlightPreferences({
      titleEnabled: true,
      contentEnabled: true,
      titleColor: '#ffffff',
      contentColor: '#000000',
    });
    expect(host.style.getPropertyValue('--cu-title-highlight-color')).toBe('#000');
    expect(host.style.getPropertyValue('--cu-content-highlight-color')).toBe('#fff');
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
      counts: { pages: 0, files: 0, dataCodes: 0, contentSources: 0, luaSources: 0 },
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
  const host = document.querySelector<HTMLDivElement>('#cu-wiki-search-host');
  const root = host?.shadowRoot;
  if (!host || !root) throw new Error('搜索面板没有挂载');
  return { panel, root, host };
}

function setLayoutViewport(width: number, height: number): () => void {
  const previousWidth = window.innerWidth;
  const previousHeight = window.innerHeight;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  return () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: previousWidth });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: previousHeight });
  };
}

function makeLayoutRect(left: number, top: number, width: number, height: number): DOMRect {
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
