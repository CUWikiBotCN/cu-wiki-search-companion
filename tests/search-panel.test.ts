// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom

import type { ContentSearchResult } from '../src/search/content-index';
import type { LuaModuleSearchResult } from '../src/search/lua-module-index';
import type { TitleSearchResult } from '../src/search/title-index';
import { SearchPanel } from '../src/ui/search-panel';

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
      selectCode: vi.fn(),
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
  it('routes only to structured Lua search and opens the selected module in a new tab', () => {
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
      selectCode: vi.fn(),
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

    root.querySelector<HTMLButtonElement>('.insert')?.click();
    expect(callbacks.open).toHaveBeenCalledWith(luaResult);
    expect(callbacks.insert).not.toHaveBeenCalled();
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
      selectCode: vi.fn(),
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

  it('keeps result arrows and Enter scoped to the query input', () => {
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
    for (const item of root.querySelectorAll<HTMLElement>('.result')) {
      item.scrollIntoView = vi.fn();
    }

    mode.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(callbacks.insert).not.toHaveBeenCalled();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(callbacks.insert).toHaveBeenCalledWith(second, '页面');
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

  it('keeps editor focus established by a mouse result action', () => {
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
    root.querySelector<HTMLButtonElement>('.insert')?.click();

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
    selectCode: vi.fn(),
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
