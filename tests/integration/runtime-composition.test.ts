// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import 'fake-indexeddb/auto';

import { DEFAULT_DATA_CODE_RULES } from '../../src/data/data-field-rules';
import { CURRENT_VERSION_CONTRACT } from '../../src/storage/version-contract';

interface DebugSearch {
  forceSync(): Promise<void>;
  forceFileSync(): Promise<void>;
  ready: boolean;
  engine: string;
  indexedPages: number;
  indexedFiles: number;
  indexedContentPages: number;
  indexedLuaModules: number;
  contentIndexReadyMs?: number;
  luaIndexReadyMs?: number;
  searchFiles(query: string): Array<{ title: string }>;
  searchCodes(query: string): Array<{ chineseName: string }>;
  search(query: string): Array<{ title: string }>;
  searchContent(query: string): Array<{ title: string }>;
  searchLua(query: string): Array<{ title: string }>;
}

it.each([
  'normal',
  'early-click',
  'early-file',
  'no-locks',
  'failed-open',
  'redirect-refresh-failure',
])(
  'boots the real entrypoint and prepares cached modes (%s)',
  async (scenario) => {
    const failedOpen = scenario === 'failed-open';
    const startupFailure = new Error('fixture open failure');
    const earlyClick = scenario === 'early-click' || failedOpen;
    const earlyFile = scenario === 'early-file';
    const noLocks = scenario === 'no-locks';
    vi.resetModules();
    const { WikiSearchDatabase } = await import('../../src/storage/database');
    const cryptoModule = 'node:crypto';
    const { webcrypto } = (await import(cryptoModule)) as { webcrypto: Crypto };
    const database = new WikiSearchDatabase();
    const listeners: Array<
      [EventTarget, string, EventListenerOrEventListenerObject, boolean]
    > = [];
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const originalTimeout = globalThis.setTimeout;
    const resource = vi.fn(() => {
      throw new Error('Use the real Intl fallback in this test');
    });
    const fetcher = vi.fn(async () => {
      throw new Error('Unexpected remote request');
    });
    let releaseOpen: () => void = () => undefined;
    let changeChannel: EventTarget | undefined;
    const postMessage = vi.fn();
    class TestChannel extends EventTarget {
      constructor() {
        super();
        // Expose the actual channel instance so the test can dispatch peer messages.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        changeChannel = this;
      }
      postMessage = postMessage;
      close(): void {}
    }
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('GM_info', { script: { version: '0.3.5' } });
    vi.stubGlobal('__CU_WIKI_BUILD_ID__', 'test-composition');
    vi.stubGlobal('GM_getValue', () => DEFAULT_DATA_CODE_RULES);
    vi.stubGlobal('GM_setValue', vi.fn());
    vi.stubGlobal('GM_getResourceURL', resource);
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
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: noLocks
        ? undefined
        : {
            request: async (
              _name: string,
              _options: LockOptions,
              callback: LockGrantedCallback<unknown>,
            ) => callback({ name: 'composition-test', mode: 'exclusive' }),
          },
    });
    if (noLocks || failedOpen || scenario === 'redirect-refresh-failure')
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
    try {
      await database.open();
      await database.pages.bulkPut([
        {
          id: 1,
          title: '医疗指南',
          normalizedTitle: '医疗指南',
          namespace: 0,
          namespaceName: '（主）',
          isRedirect: false,
          localSeq: 1,
          revisionId: 1,
          contentRevisionId: 1,
          contentModel: 'wikitext',
          content: '使用医疗绷带',
          seenInTitleSync: 1,
        },
        {
          id: 2,
          title: '模块:Health',
          normalizedTitle: '模块:health',
          namespace: 828,
          namespaceName: '模块',
          isRedirect: false,
          localSeq: 2,
          revisionId: 1,
          contentRevisionId: 1,
          contentModel: 'Scribunto',
          content:
            'local p = {}\nfunction p.heal() return "bandage" end\nreturn p',
          seenInTitleSync: 1,
        },
      ]);
      await database.fileResources.put({
        id: 9,
        title: '文件:绷带.png',
        normalizedTitle: '文件:绷带.png',
        namespace: 6,
        namespaceName: '文件',
        isRedirect: false,
        localSeq: 1,
      });
      await database.dataCodes.put({
        source: 'Data:Item/bandage',
        code: 'bandage',
        chineseName: '绷带',
        normalizedName: '绷带',
        dataType: 'Item',
        syncedAt: Date.now(),
      });
      await database.syncState.bulkPut([
        { key: 'cache-version-contract', value: CURRENT_VERSION_CONTRACT },
        { key: 'local-sequence', value: 2 },
        {
          key: 'title-sync',
          value: {
            status: 'complete',
            generation: 1,
            namespaceIds: [0, 828],
            namespaceNames: { 0: '（主）', 828: '模块' },
            namespaceIndex: 2,
            pagesFetched: 2,
            startedAt: 1,
            completedAt: 2,
          },
        },
        {
          key: 'file-resource-sync',
          value: {
            status: 'complete',
            generation: 1,
            namespaceIds: [6],
            namespaceNames: { 6: '文件' },
            namespaceIndex: 1,
            pagesFetched: 1,
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
            count: 1,
            syncedAt: Date.now(),
            indexVersion: 2,
            rulesSource: DEFAULT_DATA_CODE_RULES,
          },
        },
      ]);
      if (earlyClick || earlyFile) {
        const gate = new Promise<void>((resolve) => {
          releaseOpen = resolve;
        });
        const open = WikiSearchDatabase.prototype.open;
        vi.spyOn(WikiSearchDatabase.prototype, 'open').mockImplementation(
          function (this: InstanceType<typeof WikiSearchDatabase>) {
            return open.call(this).then(async (value) => {
              await gate;
              if (failedOpen) throw startupFailure;
              return value;
            });
          },
        );
      }
      await import('../../src/main');
      const debug = () =>
        (window as unknown as { __CU_WIKI_SEARCH__?: DebugSearch })
          .__CU_WIKI_SEARCH__;
      const root = document.querySelector('#cu-wiki-search-host')!.shadowRoot!;
      const mode = root.querySelector<HTMLSelectElement>('.mode')!;
      if (earlyClick || earlyFile) {
        mode.value = earlyFile ? 'files' : 'content';
        mode.dispatchEvent(new Event('change'));
        expect(debug()?.ready).toBe(false);
        expect(resource).not.toHaveBeenCalled();
        if (failedOpen) {
          mode.value = 'files';
          mode.dispatchEvent(new Event('change'));
          const pendingFile = expect(debug()!.forceFileSync()).rejects.toBe(
            startupFailure,
          );
          releaseOpen();
          await pendingFile;
          await vi.waitFor(() => {
            expect(console.error).toHaveBeenCalledWith(
              '[CU Wiki Search] enhanced search startup failed',
              startupFailure,
            );
            expect(console.error).toHaveBeenCalledWith(
              '[CU Wiki Search] file resource startup failed',
              startupFailure,
            );
          });
          expect(debug()?.ready).toBe(false);
          expect(root.textContent).toContain(startupFailure.message);
          expect(fetcher).not.toHaveBeenCalled();
          return;
        }
        releaseOpen();
      }
      await vi.waitFor(() => expect(debug()?.ready).toBe(true));
      if (scenario === 'redirect-refresh-failure') {
        const reconciliation =
          await import('../../src/sync/reconciliation-sync');
        const recentChanges = await import('../../src/sync/recent-change-sync');
        const redirects = await import('../../src/sync/redirect-target-sync');
        const { PageSearchRuntime } =
          await import('../../src/runtime/page-search-runtime');
        vi.spyOn(reconciliation, 'reconcileWikiMirror').mockResolvedValue({
          status: 'complete',
          reason: 'manual',
          serverStartedAt: '2026-10-06T00:00:00Z',
          pagesFetched: 2,
          pagesChanged: 0,
          filesChanged: false,
          dataCodesInvalidated: false,
          throughLocalSeq: 2,
        });
        vi.spyOn(recentChanges, 'syncRecentChanges').mockResolvedValue({
          status: 'complete',
          startedAt: '2026-10-06T00:00:00Z',
          through: '2026-10-06T00:00:01Z',
          eventsSeen: 0,
          candidates: 0,
          changedPages: [],
          deferredContentPageIds: [],
          filesChanged: false,
          dataCodesInvalidated: false,
          throughLocalSeq: 2,
        });
        vi.spyOn(redirects, 'syncRedirectTargets').mockImplementation(
          async (storage, _api, options) => {
            await storage.transaction(
              'rw',
              storage.pages,
              storage.syncState,
              async () => {
                await storage.pages.update(1, { localSeq: 3 });
                await storage.syncState.put({
                  key: 'local-sequence',
                  value: 3,
                });
              },
            );
            const page = await storage.pages.get(1);
            if (!page) throw new Error('Missing fixture page');
            options?.onBatch?.([page]);
          },
        );
        const refreshFailure = new Error('fixture local index refresh failure');
        vi.spyOn(PageSearchRuntime.prototype, 'refresh').mockRejectedValue(
          refreshFailure,
        );
        await expect(debug()!.forceSync()).rejects.toBe(refreshFailure);
        expect(postMessage).toHaveBeenCalledWith({
          type: 'redirects-committed',
        });
        expect(await database.pages.get(1)).toMatchObject({ localSeq: 3 });
        expect(fetcher).not.toHaveBeenCalled();
        return;
      }
      expect(
        debug()
          ?.search('医疗')
          .map(({ title }) => title),
      ).toEqual(['医疗指南']);
      if (earlyFile)
        await vi.waitFor(() => expect(debug()?.indexedFiles).toBe(1));
      if (!earlyClick) {
        expect(debug()).toMatchObject({
          engine: 'bootstrap',
          indexedPages: 2,
          indexedFiles: earlyFile ? 1 : 0,
          indexedContentPages: 0,
          indexedLuaModules: 0,
        });
        expect(resource).not.toHaveBeenCalled();
        expect(await database.indexSnapshots.count()).toBe(0);
        mode.value = 'content';
        mode.dispatchEvent(new Event('change'));
      }
      if (noLocks) {
        await vi.waitFor(() => expect(debug()?.indexedContentPages).toBe(1));
        await vi.waitFor(() =>
          expect(root.querySelector('.status')?.textContent).toContain(
            'Web Locks',
          ),
        );
      } else {
        await vi.waitFor(() =>
          expect(debug()?.contentIndexReadyMs).toEqual(expect.any(Number)),
        );
      }
      expect(
        debug()
          ?.searchContent('绷带')
          .map(({ title }) => title),
      ).toEqual(['医疗指南']);
      expect(debug()?.indexedLuaModules).toBe(0);
      expect(
        await database.indexSnapshots.get('search-index:lua'),
      ).toBeUndefined();

      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      await database.transaction(
        'rw',
        database.pages,
        database.syncState,
        async () => {
          await database.pages.update(1, {
            content: '使用绷带与纱布',
            localSeq: 3,
          });
          await database.syncState.put({ key: 'local-sequence', value: 3 });
        },
      );
      await database.dataCodes.update('Data:Item/bandage', {
        chineseName: '急救绷带',
        normalizedName: '急救绷带',
      });
      await database.fileResources.update(9, {
        title: '文件:纱布.png',
        normalizedTitle: '文件:纱布.png',
      });
      changeChannel!.dispatchEvent(
        new MessageEvent('message', { data: { type: 'committed' } }),
      );
      changeChannel!.dispatchEvent(
        new MessageEvent('message', { data: { type: 'files-committed' } }),
      );
      changeChannel!.dispatchEvent(
        new MessageEvent('message', { data: { type: 'data-committed' } }),
      );
      expect(debug()?.searchCodes('急救')).toEqual([]);
      expect(debug()?.searchFiles('纱布')).toEqual([]);
      expect(debug()?.searchContent('纱布')).toEqual([]);
      expect(debug()?.indexedLuaModules).toBe(0);
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.waitFor(() =>
        expect(
          debug()
            ?.searchContent('纱布')
            .map(({ title }) => title),
        ).toEqual(['医疗指南']),
      );
      expect(debug()?.indexedLuaModules).toBe(0);
      await vi.waitFor(() =>
        expect(debug()?.searchCodes('急救')).toHaveLength(1),
      );
      expect(debug()?.indexedFiles).toBe(earlyFile ? 1 : 0);
      if (earlyFile) expect(debug()?.searchFiles('纱布')).toHaveLength(1);
      mode.value = 'files';
      mode.dispatchEvent(new Event('change'));
      await vi.waitFor(() =>
        expect(debug()?.searchFiles('纱布')).toHaveLength(1),
      );

      mode.value = 'lua';
      mode.dispatchEvent(new Event('change'));
      if (noLocks) {
        await vi.waitFor(() => expect(debug()?.indexedLuaModules).toBe(1));
      } else {
        await vi.waitFor(() =>
          expect(debug()?.luaIndexReadyMs).toEqual(expect.any(Number)),
        );
      }
      expect(
        debug()
          ?.searchLua('heal')
          .map(({ title }) => title),
      ).toEqual(['模块:Health']);
      expect(
        debug()
          ?.searchContent('绷带')
          .map(({ title }) => title),
      ).toEqual(['医疗指南']);
      expect(fetcher).not.toHaveBeenCalled();

      // The no-writer tab isolates broadcast application from automatic REST refresh.
      if (noLocks) {
        // A cache notification without usable rules must not replace the editor draft.
        mode.value = 'data-code';
        mode.dispatchEvent(new Event('change'));
        root.querySelector<HTMLButtonElement>('.configure')!.click();
        const rules = root.querySelector<HTMLTextAreaElement>('.data-rules')!;
        const draft = '* = .locales["zh-CN"].description';
        rules.value = draft;
        rules.dispatchEvent(new Event('input'));
        const warn = vi
          .spyOn(console, 'warn')
          .mockImplementation(() => undefined);
        for (const [rulesSource, name] of [
          [undefined, '草稿一'],
          ['invalid', '草稿二'],
        ] as const) {
          await database.syncState.put({
            key: 'data-code-sync',
            value: {
              count: 1,
              syncedAt: Date.now(),
              indexVersion: 2,
              rulesSource,
            },
          });
          await database.dataCodes.update('Data:Item/bandage', {
            chineseName: name,
            normalizedName: name,
          });
          changeChannel!.dispatchEvent(
            new MessageEvent('message', { data: { type: 'data-committed' } }),
          );
          await vi.waitFor(() =>
            expect(debug()?.searchCodes(name)).toHaveLength(1),
          );
          expect(rules.value).toBe(draft);
        }
        expect(warn).toHaveBeenCalledWith(
          '[CU Wiki Search] ignored invalid broadcast Data code rules',
          expect.any(Error),
        );
        expect(fetcher).not.toHaveBeenCalled();
      }
    } finally {
      releaseOpen();
      for (const timer of timers) clearTimeout(timer);
      for (const [target, type, listener, capture] of listeners)
        target.removeEventListener(type, listener, capture);
      document.querySelector('#cu-wiki-search-host')?.remove();
      database.close();
      await database.delete();
      Reflect.deleteProperty(window, '__CU_WIKI_SEARCH__');
      Reflect.deleteProperty(window, 'mw');
      Reflect.deleteProperty(navigator, 'locks');
      Reflect.deleteProperty(document, 'visibilityState');
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
    // This test dynamically transforms the full entrypoint and Vue graph on first use.
    // Allow parallel-suite startup contention without changing global test concurrency.
  },
  15_000,
);
