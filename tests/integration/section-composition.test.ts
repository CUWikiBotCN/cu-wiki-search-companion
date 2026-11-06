// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { DEFAULT_DATA_CODE_RULES } from '../../src/data/data-field-rules';
import { CURRENT_VERSION_CONTRACT } from '../../src/storage/version-contract';

it('composes real section search, actions, resolver and selected content synchronization through main', async () => {
  vi.resetModules();
  const { WikiSearchDatabase } = await import('../../src/storage/database');
  const { ContentSyncSession } =
    await import('../../src/runtime/content-sync-session');
  const content = await import('../../src/sync/content-sync');
  const { webcrypto } = await import('node:crypto');
  const database = new WikiSearchDatabase();
  const listeners: Array<
    [EventTarget, string, EventListenerOrEventListenerObject, boolean]
  > = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const originalTimeout = globalThis.setTimeout;
  const clipboard = vi.fn();
  const openTab = vi.fn();
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const params = new URL(String(input), 'https://example.org').searchParams;
    if (params.get('action') === 'parse') {
      return new Response(
        JSON.stringify({
          parse: {
            pageid: 2,
            title: '复杂页面',
            revid: 22,
            sections: [
              {
                level: '2',
                index: '1',
                fromtitle: '复杂页面',
                byteoffset: 6,
                anchor: '待核对',
              },
            ],
          },
        }),
      );
    }
    if (params.get('prop') === 'revisions' && params.get('pageids') === '3') {
      return new Response(
        JSON.stringify({
          query: {
            pages: [
              {
                pageid: 3,
                revisions: [
                  {
                    revid: 33,
                    slots: {
                      main: {
                        contentmodel: 'wikitext',
                        content: '== 获取成功 ==',
                      },
                    },
                  },
                ],
              },
            ],
          },
        }),
      );
    }
    throw new Error(`Unexpected request: ${params.toString()}`);
  });
  class TestChannel extends EventTarget {
    postMessage(): void {}
    close(): void {}
  }
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('GM_info', { script: { version: 'test' } });
  vi.stubGlobal('__CU_WIKI_BUILD_ID__', 'test-section-composition');
  vi.stubGlobal('GM_getValue', () => DEFAULT_DATA_CODE_RULES);
  vi.stubGlobal('GM_setValue', vi.fn());
  vi.stubGlobal('GM_getResourceURL', () => {
    throw new Error('use fallback');
  });
  vi.stubGlobal('GM_setClipboard', clipboard);
  vi.stubGlobal('GM_openInTab', openTab);
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('BroadcastChannel', TestChannel);
  vi.stubGlobal('scheduler', { yield: async () => undefined });
  vi.stubGlobal(
    'unsafeWindow',
    Object.assign(window, {
      mw: {
        config: {
          get: (key: string) => (key === 'wgAction' ? 'edit' : 'wikitext'),
        },
      },
    }),
  );
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
  let lockGate: Promise<void> | undefined;
  let lockReached: (() => void) | undefined;
  let lockFinished: (() => void) | undefined;
  let releaseGate: (() => void) | undefined;
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: LockOptions,
        callback: LockGrantedCallback<unknown>,
      ) => {
        if (!lockGate) return callback({ name: 'test', mode: 'exclusive' });
        lockReached?.();
        await lockGate;
        try {
          return await callback({ name: 'test', mode: 'exclusive' });
        } finally {
          lockFinished?.();
        }
      },
    },
  });
  vi.spyOn(window, 'setInterval').mockImplementation(vi.fn());
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(
    (handler, timeout, ...args) => {
      const timer = originalTimeout(handler, timeout, ...args);
      timers.push(timer);
      return timer;
    },
  );
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation(
      (type, listener, options) => {
        if (listener)
          listeners.push([
            target,
            type,
            listener,
            typeof options === 'boolean'
              ? options
              : (options?.capture ?? false),
          ]);
        add(type, listener, options);
      },
    );
  }
  const originalRun = ContentSyncSession.prototype.run;
  const requested = vi.fn();
  const checked = vi.fn();
  const started = vi.fn();
  vi.spyOn(ContentSyncSession.prototype, 'run').mockImplementation(function (
    this: InstanceType<typeof ContentSyncSession>,
    force,
    ids,
    shouldRun,
    onStarted,
  ) {
    if (ids) requested(force, ids, shouldRun, onStarted);
    return originalRun.call(
      this,
      force,
      ids,
      shouldRun &&
        (() => {
          checked();
          return shouldRun();
        }),
      onStarted &&
        (() => {
          started();
          onStarted();
        }),
    );
  });
  const syncSpy = vi.spyOn(content, 'syncContent');
  const editor = document.createElement('textarea');
  editor.id = 'wpTextbox1';
  document.body.append(editor);
  try {
    await database.open();
    const base = {
      namespace: 0,
      namespaceName: '主',
      isRedirect: false,
      contentModel: 'wikitext',
    };
    await database.pages.bulkPut([
      {
        ...base,
        id: 1,
        title: '简单页面',
        normalizedTitle: '简单页面',
        localSeq: 1,
        revisionId: 11,
        contentRevisionId: 11,
        content: '== 标题 ==',
      },
      {
        ...base,
        id: 2,
        title: '复杂页面',
        normalizedTitle: '复杂页面',
        localSeq: 2,
        revisionId: 22,
        contentRevisionId: 22,
        content: '{{X}}\n== 待核对 ==',
      },
      {
        ...base,
        id: 3,
        title: '缺失页面',
        normalizedTitle: '缺失页面',
        localSeq: 3,
        revisionId: 33,
      },
      {
        ...base,
        id: 4,
        title: '其他缺失',
        normalizedTitle: '其他缺失',
        localSeq: 4,
        revisionId: 44,
      },
      {
        ...base,
        id: 5,
        title: 'MediaWiki:Common.css',
        normalizedTitle: 'mediawiki:common.css',
        namespace: 8,
        namespaceName: 'MediaWiki',
        contentModel: 'css',
        localSeq: 5,
        revisionId: 55,
        contentRevisionId: 55,
        content: '.x {}',
      },
    ]);
    await database.syncState.bulkPut([
      { key: 'cache-version-contract', value: CURRENT_VERSION_CONTRACT },
      { key: 'local-sequence', value: 5 },
      {
        key: 'title-sync',
        value: {
          status: 'complete',
          generation: 1,
          namespaceIds: [0, 8],
          namespaceNames: { 0: '主', 8: 'MediaWiki' },
          namespaceIndex: 2,
          pagesFetched: 5,
          startedAt: 1,
          completedAt: 2,
        },
      },
      {
        key: 'incremental-sync-schedule',
        value: {
          lastSuccessAt: Date.now(),
          nextDueAt: Number.MAX_SAFE_INTEGER,
        },
      },
      {
        key: 'data-code-sync',
        value: {
          count: 0,
          syncedAt: Date.now(),
          indexVersion: 2,
          rulesSource: DEFAULT_DATA_CODE_RULES,
        },
      },
    ]);
    await import('../../src/main');
    const debug = () =>
      (
        window as unknown as {
          __CU_WIKI_SEARCH__?: { ready: boolean; indexedCssSources: number };
        }
      ).__CU_WIKI_SEARCH__;
    await vi.waitFor(() => expect(debug()?.ready).toBe(true));
    const root = document.querySelector('#cu-wiki-search-host')!.shadowRoot!;
    root.querySelector<HTMLButtonElement>('.toggle')!.click();
    const input = root.querySelector<HTMLInputElement>('.query')!;
    const mode = root.querySelector<HTMLSelectElement>('.mode')!;
    mode.value = 'css';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(debug()?.indexedCssSources).toBe(1));
    mode.value = 'title';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    const query = (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    query('简单页面#标题');
    await vi.waitFor(() =>
      expect(root.querySelector('.result-title')?.textContent).toContain(
        '标题',
      ),
    );
    root.querySelector<HTMLButtonElement>('.result-primary')!.click();
    expect(clipboard).toHaveBeenLastCalledWith('简单页面#标题', 'text');
    root.querySelector<HTMLButtonElement>('.open-result')!.click();
    expect(openTab).toHaveBeenLastCalledWith(
      expect.stringContaining('#%E6%A0%87%E9%A2%98'),
      { active: true },
    );
    root.querySelector<HTMLButtonElement>('.copy-result')!.click();
    expect(clipboard).toHaveBeenLastCalledWith(
      '[[简单页面#标题|标题]]',
      'text',
    );
    root.querySelector<HTMLButtonElement>('.insert-result')!.click();
    expect(editor.value).toBe('[[简单页面#标题|标题]]');
    root.querySelector<HTMLButtonElement>('.toggle')!.click();
    query('复杂页面#待核对');
    await vi.waitFor(() =>
      expect(root.querySelector('.resolve-section')).not.toBeNull(),
    );
    root.querySelector<HTMLButtonElement>('.resolve-section')!.click();
    await vi.waitFor(() =>
      expect(root.querySelector('.resolve-section')).toBeNull(),
    );
    root.querySelector<HTMLButtonElement>('.result-primary')!.click();
    expect(clipboard).toHaveBeenLastCalledWith('复杂页面#待核对', 'text');
    expect(
      fetcher.mock.calls.some(
        ([url]) =>
          new URL(String(url), 'https://example.org').searchParams.get(
            'action',
          ) === 'parse',
      ),
    ).toBe(true);
    query('缺失页面#获取');
    await vi.waitFor(
      () =>
        expect(root.querySelector('.result-title')?.textContent).toContain(
          '获取成功',
        ),
      { timeout: 5000 },
    );
    expect(requested).toHaveBeenCalledWith(
      false,
      [3],
      expect.any(Function),
      expect.any(Function),
    );
    expect(checked).toHaveBeenCalled();
    expect(started).toHaveBeenCalledOnce();
    expect(syncSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ scope: 'content', pageIds: [3] }),
    );
    expect((await database.pages.get(3))?.content).toBe('== 获取成功 ==');
    expect((await database.pages.get(4))?.content).toBeUndefined();
    const revisions = fetcher.mock.calls
      .map(([url]) => new URL(String(url), 'https://example.org').searchParams)
      .filter((params) => params.get('prop') === 'revisions');
    expect(revisions.map((params) => params.get('pageids'))).toEqual(['3']);
    lockGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      lockReached = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      lockFinished = resolve;
    });
    query('其他缺失#');
    await vi.waitFor(
      () =>
        expect(requested).toHaveBeenCalledWith(
          false,
          [4],
          expect.any(Function),
          expect.any(Function),
        ),
      { timeout: 5000 },
    );
    await reached;
    query('#你');
    releaseGate?.();
    await finished;
    expect(started).toHaveBeenCalledOnce();
    expect((await database.pages.get(4))?.content).toBeUndefined();
    expect(
      fetcher.mock.calls.map(([url]) =>
        new URL(String(url), 'https://example.org').searchParams.get('pageids'),
      ),
    ).not.toContain('4');
  } finally {
    releaseGate?.();
    window.dispatchEvent(new Event('pagehide'));
    for (const timer of timers) clearTimeout(timer);
    for (const [target, type, listener, capture] of listeners)
      target.removeEventListener(type, listener, capture);
    document.querySelector('#cu-wiki-search-host')?.remove();
    editor.remove();
    database.close();
    await database.delete();
    Reflect.deleteProperty(window, '__CU_WIKI_SEARCH__');
    Reflect.deleteProperty(window, 'mw');
    Reflect.deleteProperty(navigator, 'locks');
    Reflect.deleteProperty(document, 'visibilityState');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}, 15_000);
