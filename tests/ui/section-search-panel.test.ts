// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import { nextTick } from 'vue';
import type { SectionSearchResult } from '../../src/search/section-title-index';
import { SearchPanel } from '../../src/ui/search-panel';

const page = {
  id: 7,
  title: '地形扫描仪',
  namespace: 0,
  namespaceName: '',
  score: 1,
};
const first: SectionSearchResult = {
  kind: 'section',
  id: 7,
  title: page.title,
  namespace: 0,
  namespaceName: '',
  sectionId: '10',
  revisionId: 11,
  sectionTitle: '你知道吗',
  sectionPath: ['介绍'],
  headingStart: 10,
  level: 3,
  needsResolution: true,
};
const second: SectionSearchResult = {
  ...first,
  sectionId: '20',
  headingStart: 20,
};

function mount() {
  const callbacks = {
    prepareSearch: vi.fn(),
    prepareFiles: vi.fn(),
    search: vi.fn(() => [page]),
    sectionIntent: vi.fn(),
    searchSections: vi.fn(() => [first, second]),
    resolveSection: vi.fn(async (_result: SectionSearchResult) => undefined),
    sectionCurrent: vi.fn((_result: SectionSearchResult) => true),
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
  };
  const panel = new SearchPanel(callbacks);
  panel.open();
  const root = document.querySelector<HTMLDivElement>(
    '#cu-wiki-search-host',
  )!.shadowRoot!;
  const input = root.querySelector<HTMLInputElement>('.query')!;
  return { panel, callbacks, root, input };
}

async function type(input: HTMLInputElement, text: string) {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(120);
  await nextTick();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  document
    .querySelectorAll('#cu-wiki-search-host')
    .forEach((host) => host.remove());
  vi.useRealTimers();
});

it('defaults to pages, and # temporarily enables sections without overwriting the manual choice', async () => {
  const { panel, callbacks, input } = mount();
  await type(input, '地形');
  expect(panel.state.includeSections).toBe(false);
  expect(callbacks.searchSections).not.toHaveBeenCalled();
  await type(input, '地形#你知');
  expect(panel.state.includeSections).toBe(true);
  expect(panel.state.manualIncludeSections).toBe(false);
  expect(panel.state.results).toEqual([first, second]);
  expect(callbacks.searchSections).toHaveBeenLastCalledWith(
    '地形#你知',
    undefined,
    undefined,
  );
  await type(input, '地形');
  expect(panel.state.includeSections).toBe(false);
  expect(panel.state.results).toEqual([page]);
  panel.actions.toggleSections();
  await type(input, '地形#你知');
  await type(input, '地形');
  expect(panel.state.manualIncludeSections).toBe(true);
  expect(panel.state.includeSections).toBe(true);
  expect(panel.state.results).toEqual([page, first, second]);
  panel.destroy();
});

it('turning off the active scope exits # and keeps only its left side', async () => {
  const { panel, input } = mount();
  await type(input, '地形 #你知');
  panel.actions.toggleSections();
  expect(input.value).toBe('地形');
  expect(panel.state.includeSections).toBe(false);
  expect(panel.state.manualIncludeSections).toBe(false);
  expect(panel.state.results).toEqual([page]);
  panel.destroy();
});

it('binds a page explicitly, retains the binding when editing the right side and clears it when editing the left', async () => {
  const { panel, callbacks, input } = mount();
  await type(input, '地形');
  panel.actions.showSections(page);
  expect(input.value).toBe('地形扫描仪#');
  expect(callbacks.searchSections).toHaveBeenLastCalledWith(
    '地形扫描仪#',
    undefined,
    7,
  );
  await type(input, '地形扫描仪#你知');
  expect(callbacks.searchSections).toHaveBeenLastCalledWith(
    '地形扫描仪#你知',
    undefined,
    7,
  );
  await type(input, '地形#你知');
  expect(callbacks.searchSections).toHaveBeenLastCalledWith(
    '地形#你知',
    undefined,
    undefined,
  );
  panel.destroy();
});

it('keeps same-page sections distinct through background refresh and invalidates selection on a new revision', async () => {
  const { panel, callbacks, input } = mount();
  await type(input, '#你知');
  panel.actions.select(1);
  callbacks.searchSections.mockReturnValue([second, first]);
  panel.refreshResults();
  expect(panel.state.results[panel.state.selectedIndex]).toEqual(second);
  callbacks.searchSections.mockReturnValue([
    first,
    { ...second, revisionId: 12 },
  ]);
  panel.refreshResults();
  expect(panel.state.selectedIndex).toBe(0);
  panel.destroy();
});

it('blocks unresolved actions and does not perform an action after explicit resolution', async () => {
  const { panel, callbacks, input } = mount();
  await type(input, '#你知');
  for (const options of [{}, { ctrlKey: true }, { shiftKey: true }]) {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...options }),
    );
  }
  panel.actions.copyLink(first);
  expect(callbacks.copyTitle).not.toHaveBeenCalled();
  expect(callbacks.open).not.toHaveBeenCalled();
  expect(callbacks.insert).not.toHaveBeenCalled();
  expect(callbacks.copy).not.toHaveBeenCalled();
  panel.actions.resolveSection(first);
  await Promise.resolve();
  await nextTick();
  expect(callbacks.resolveSection).toHaveBeenCalledOnce();
  expect(callbacks.copyTitle).not.toHaveBeenCalled();
  expect(callbacks.open).not.toHaveBeenCalled();
  expect(callbacks.insert).not.toHaveBeenCalled();
  panel.destroy();
});

it('only toggles with the title-mode shortcut, ignoring repeat, IME and AltGraph', async () => {
  const { panel, input } = mount();
  const key = (extra: KeyboardEventInit = {}) =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        ctrlKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
        ...extra,
      }),
    );
  key({ repeat: true });
  key({ isComposing: true });
  const altGraph = new KeyboardEvent('keydown', {
    key: 's',
    ctrlKey: true,
    altKey: true,
    bubbles: true,
  });
  Object.defineProperty(altGraph, 'getModifierState', {
    value: (name: string) => name === 'AltGraph',
  });
  input.dispatchEvent(altGraph);
  expect(panel.state.includeSections).toBe(false);
  key();
  expect(panel.state.includeSections).toBe(true);
  input.dispatchEvent(
    new CompositionEvent('compositionstart', { bubbles: true }),
  );
  key();
  expect(panel.state.includeSections).toBe(true);
  input.dispatchEvent(
    new CompositionEvent('compositionend', { bubbles: true }),
  );
  panel.state.mode = 'content';
  panel.actions.mode();
  key();
  expect(panel.state.manualIncludeSections).toBe(true);
  expect(panel.state.includeSections).toBe(false);
  panel.destroy();
});

it('renders independently counted page and section groups and binds the clicked page', async () => {
  const { panel, root, input, callbacks } = mount();
  await type(input, '地形');
  const checkbox = root.querySelector<HTMLInputElement>('.include-sections')!;
  expect(checkbox.checked).toBe(false);
  checkbox.click();
  await nextTick();
  expect(checkbox.checked).toBe(true);
  expect(root.querySelectorAll('.result')).toHaveLength(3);
  expect(root.querySelector('.results')?.textContent).toContain('页面 · 1');
  expect(root.querySelector('.results')?.textContent).toContain('小节 · 2');
  expect(root.querySelectorAll('.resolve-section')).toHaveLength(2);
  root.querySelector<HTMLButtonElement>('.view-sections')!.click();
  await nextTick();
  expect(input.value).toBe('地形扫描仪#');
  expect(root.querySelector('.section-coverage')?.textContent).toContain(
    '仅此页：地形扫描仪',
  );
  expect(callbacks.searchSections).toHaveBeenLastCalledWith(
    '地形扫描仪#',
    undefined,
    7,
  );
  await type(input, '地形扫描仪#你知');
  expect(root.querySelectorAll('.result')).toHaveLength(2);
  expect(root.querySelector('.results')?.textContent).not.toContain('页面 · 1');
  expect(root.querySelector('.results')?.textContent).toContain('地形扫描仪');
  expect(root.querySelector('.results')?.textContent).toContain('介绍');
  panel.destroy();
});

it('exposes explicit resolution and leaves unresolved target actions unavailable', async () => {
  const { panel, root, input, callbacks } = mount();
  await type(input, '#你知');
  expect(root.querySelectorAll('.resolve-section')).toHaveLength(2);
  expect(root.querySelectorAll('.open-section-page')).toHaveLength(2);
  expect(
    root.querySelectorAll('.open-result, .copy-result, .insert-result'),
  ).toHaveLength(0);
  root.querySelector<HTMLButtonElement>('.resolve-section')!.click();
  await Promise.resolve();
  await nextTick();
  expect(callbacks.resolveSection).toHaveBeenCalledWith(first);
  expect(callbacks.copyTitle).not.toHaveBeenCalled();
  expect(callbacks.open).not.toHaveBeenCalled();
  expect(callbacks.insert).not.toHaveBeenCalled();
  panel.destroy();
});

it('requires a separate user action after resolution before copying the resolved section', async () => {
  const { panel, root, input, callbacks } = mount();
  const resolved = { ...first, needsResolution: false, fragment: '你知道吗' };
  callbacks.resolveSection.mockImplementation(async () => {
    callbacks.searchSections.mockReturnValue([resolved, second]);
  });
  await type(input, '#你知');
  root.querySelector<HTMLButtonElement>('.resolve-section')!.click();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  await nextTick();
  expect(callbacks.copyTitle).not.toHaveBeenCalled();
  expect(callbacks.open).not.toHaveBeenCalled();
  expect(callbacks.insert).not.toHaveBeenCalled();
  const primary = root.querySelector<HTMLButtonElement>('.result-primary')!;
  primary.click();
  expect(callbacks.copyTitle).toHaveBeenCalledWith(resolved);
  panel.destroy();
});

it('defers # interpretation during composition and restores manual scope after changing modes', async () => {
  const { panel, input } = mount();
  input.dispatchEvent(
    new CompositionEvent('compositionstart', { bubbles: true }),
  );
  input.value = '地形#你';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(200);
  expect(panel.state.includeSections).toBe(false);
  input.dispatchEvent(
    new CompositionEvent('compositionend', { bubbles: true }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(panel.state.includeSections).toBe(true);
  expect(panel.state.manualIncludeSections).toBe(false);
  panel.state.mode = 'content';
  panel.actions.mode();
  expect(panel.state.includeSections).toBe(false);
  panel.state.mode = 'title';
  panel.actions.mode();
  expect(panel.state.includeSections).toBe(true);
  await type(input, '地形');
  expect(panel.state.includeSections).toBe(false);
  panel.destroy();
});

it('restores active section intent on reopening with the same query and binding', async () => {
  const { panel, callbacks, input } = mount();
  await type(input, '地形');
  panel.actions.showSections(page);
  await type(input, '地形扫描仪#你知');
  callbacks.sectionIntent.mockClear();
  panel.close();
  expect(callbacks.sectionIntent).toHaveBeenLastCalledWith({
    active: false,
    query: '地形扫描仪#你知',
  });
  panel.open();
  expect(callbacks.sectionIntent).toHaveBeenLastCalledWith({
    active: true,
    query: '地形扫描仪#你知',
    namespace: undefined,
    pageId: 7,
  });
  expect(input.value).toBe('地形扫描仪#你知');
  panel.destroy();
});

it('retains a bound page within the selected namespace and releases it outside that namespace', async () => {
  const { panel, root, input, callbacks } = mount();
  panel.setNamespaces([
    { id: 0, name: '主' },
    { id: 828, name: '模块' },
  ]);
  await nextTick();
  await type(input, '地形');
  panel.actions.showSections(page);
  const namespace = root.querySelector<HTMLSelectElement>('.namespace')!;
  namespace.value = '0';
  namespace.dispatchEvent(new Event('change', { bubbles: true }));
  expect(callbacks.searchSections).toHaveBeenLastCalledWith(
    '地形扫描仪#',
    0,
    7,
  );
  namespace.value = '828';
  namespace.dispatchEvent(new Event('change', { bubbles: true }));
  expect(callbacks.searchSections).toHaveBeenLastCalledWith(
    '地形扫描仪#',
    828,
    undefined,
  );
  expect(panel.state.sectionPageId).toBeUndefined();
  panel.destroy();
});

it('renders the occurrence number for repeated section titles and omits it for unique titles', async () => {
  const { panel, callbacks, root, input } = mount();
  callbacks.searchSections.mockReturnValue([
    { ...first, occurrence: 1 },
    { ...second, occurrence: 2 },
    { ...first, sectionId: '30', sectionTitle: '其他', occurrence: undefined },
  ]);
  await type(input, '#你知');
  const titles = [...root.querySelectorAll('.result-title')].map(
    (element) => element.textContent,
  );
  expect(titles).toHaveLength(3);
  expect(titles[0]).toContain('第 1 处');
  expect(titles[1]).toContain('第 2 处');
  expect(titles[2]).not.toContain('第');
  panel.destroy();
});

it.each(['Shift+Enter', '复制插入内容', '打开', 'Enter'] as const)(
  'refuses %s when the resolved target has expired, refreshes the row and keeps the panel open',
  async (action) => {
    const { panel, callbacks, root, input } = mount();
    const resolved = {
      ...first,
      needsResolution: false,
      fragment: '你知道吗',
      sourceSequence: 5,
    };
    callbacks.searchSections.mockReturnValue([resolved]);
    await type(input, '#你知');
    expect(root.querySelector('.resolve-section')).toBeNull();
    callbacks.sectionCurrent.mockReturnValue(false);
    callbacks.searchSections.mockReturnValue([{ ...first, sourceSequence: 6 }]);
    if (action === 'Shift+Enter' || action === 'Enter') {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          shiftKey: action === 'Shift+Enter',
        }),
      );
    } else {
      root
        .querySelector<HTMLButtonElement>(
          action === '打开' ? '.open-result' : '.copy-result',
        )!
        .click();
    }
    await nextTick();
    expect(callbacks.sectionCurrent).toHaveBeenCalledWith(resolved);
    expect(callbacks.searchSections).toHaveBeenLastCalledWith(
      '#你知',
      undefined,
      undefined,
    );
    expect(callbacks.insert).not.toHaveBeenCalled();
    expect(callbacks.copy).not.toHaveBeenCalled();
    expect(callbacks.copyTitle).not.toHaveBeenCalled();
    expect(callbacks.open).not.toHaveBeenCalled();
    expect(panel.state.visible).toBe(true);
    expect(panel.state.status).toContain('过期');
    expect(root.querySelector('.resolve-section')).not.toBeNull();
    expect(root.querySelector('.result')?.textContent).toContain('链接待核对');
    panel.destroy();
  },
);
