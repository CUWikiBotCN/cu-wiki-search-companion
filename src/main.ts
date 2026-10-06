// SPDX-License-Identifier: MPL-2.0
import { Analyzer, createBootstrapSegmenter } from './analyzer/analyzer';
import { loadAnalyzer, type AnalyzerLoadResult } from './analyzer/load-jieba';
import { DEFAULT_DATA_CODE_RULES } from './data/data-field-rules';
import { insertAtEditorSelection, wikiLink } from './editor';
import { LocalDataMaintenance } from './maintenance/local-data-maintenance';
import { changeBroadcastEffect } from './runtime/change-broadcast';
import { browserTaskScheduler } from './runtime/cooperative-task-scheduler';
import {
  DataCodeRuntime,
  type DataCodeCommit,
} from './runtime/data-code-runtime';
import { FileSearchRuntime } from './runtime/file-search-runtime';
import { InitialBackgroundRefreshCoordinator } from './runtime/initial-background-refresh';
import {
  MirrorSyncOrchestrator,
  type MirrorSyncEvent,
  type MirrorSyncOutcome,
  type SyncAttemptResult,
} from './runtime/mirror-sync-orchestrator';
import { CommittedRecentChangeRefresh } from './runtime/recent-change-commit-refresh';
import { CommittedReconciliationRefresh } from './runtime/reconciliation-commit-refresh';
import {
  PageSearchRuntime,
  type PageSearchRuntimeState,
} from './runtime/page-search-runtime';
import {
  RuntimeLifecycleCoordinator,
  type StorageInvalidation,
  type StorageInvalidationRequest,
} from './runtime/runtime-lifecycle-coordinator';
import type { CssSearchResult } from './search/css-source-index';
import type { ContentSearchResult } from './search/content-index';
import type { DataCodeSearchResult } from './search/data-code-index';
import type { LuaModuleSearchResult } from './search/lua-module-index';
import {
  type SnapshotInspection,
  VersionedSearchIndexCache,
} from './search/versioned-search-index-cache';
import type { TitleSearchResult } from './search/title-index';
import { WikiSearchDatabase } from './storage/database';
import { dataRulesPreference } from './storage/data-rules-preference';
import { highlightPreference } from './storage/highlight-preference';
import {
  FactWriteCompatibilityError,
  inspectVersionContract,
} from './storage/version-contract';
import { syncContent } from './sync/content-sync';
import { IncrementalSyncCoordinator } from './sync/incremental-sync-coordinator';
import {
  readRecentChangeSyncState,
  syncRecentChanges,
} from './sync/recent-change-sync';
import {
  readReconciliationSyncState,
  reconcileWikiMirror,
} from './sync/reconciliation-sync';
import { syncTitles } from './sync/title-sync';
import { syncRedirectTargets } from './sync/redirect-target-sync';
import { pageUrl as buildPageUrl } from './page-url';
import { WikiApi } from './sync/wiki-api';
import type { TitleSyncProgress } from './types';
import { SearchPanel, type MaintenanceActionFeedback } from './ui/search-panel';

declare const __CU_WIKI_BUILD_ID__: string;

interface MediaWikiWindow extends Window {
  mw?: {
    config?: { get(key: string): unknown };
    util?: {
      getUrl(title: string): string;
      escapeIdForLink?(fragment: string): string;
    };
  };
  __CU_WIKI_SEARCH__?: DebugApi;
}

interface DebugApi {
  ready: boolean;
  scriptVersion: string;
  buildId: string;
  engine?: AnalyzerLoadResult['engine'];
  indexedPages: number;
  indexedFiles: number;
  indexedDataCodes: number;
  indexedContentPages: number;
  indexedLuaModules: number;
  indexedCssSources: number;
  startupMs?: number;
  jiebaReadyMs?: number;
  contentIndexReadyMs?: number;
  luaIndexReadyMs?: number;
  contentReadyMs?: number;
  contentModel?: string;
  incrementalStatus: IncrementalRuntimeStatus;
  incrementalThrough?: string;
  reconciliationStatus: ReconciliationRuntimeStatus;
  reconciliationCompletedAt?: number;
  snapshots: SnapshotInspection[];
  search(query: string, namespace?: number): TitleSearchResult[];
  searchFiles(query: string): TitleSearchResult[];
  searchCodes(query: string): DataCodeSearchResult[];
  searchContent(query: string, namespace?: number): ContentSearchResult[];
  searchLua(query: string): LuaModuleSearchResult[];
  searchCss(query: string): CssSearchResult[];
  forceSync(): Promise<void>;
  forceFileSync(): Promise<void>;
  forceDataCodeSync(): Promise<void>;
  forceContentSync(): Promise<void>;
  requestIncrementalSync(): Promise<void>;
}

type IncrementalRuntimeStatus =
  | 'idle'
  | 'running'
  | 'complete'
  | 'no-baseline'
  | 'login-required'
  | 'lock-unavailable'
  | 'error';

type ReconciliationRuntimeStatus =
  | 'idle'
  | 'running'
  | 'complete'
  | 'not-due'
  | 'no-baseline'
  | 'login-required'
  | 'lock-unavailable'
  | 'error';

const pageWindow = unsafeWindow as unknown as MediaWikiWindow;
const bootStartedAt = performance.now();
const LEGACY_DATA_EXTRACTION_RULES_KEY = 'data-extraction-rules';
let startupPanel: SearchPanel | undefined;
let rejectStartup: ((error: unknown) => void) | undefined;

if (shouldActivate()) {
  void start().catch((error: unknown) => {
    rejectStartup?.(error);
    startupPanel?.setStartupFailure(errorMessage(error), () =>
      pageWindow.location.reload(),
    );
    console.error('[CU Wiki Search] startup failed', error);
  });
}

function shouldActivate(): boolean {
  const configuredAction = pageWindow.mw?.config?.get('wgAction');
  const urlAction = new URL(location.href).searchParams.get('action');
  return (
    configuredAction === 'edit' ||
    configuredAction === 'submit' ||
    urlAction === 'edit' ||
    urlAction === 'submit'
  );
}

async function start(): Promise<void> {
  const database = new WikiSearchDatabase();
  const api = new WikiApi();
  const indexCache = new VersionedSearchIndexCache(database);
  let incrementalChannel: BroadcastChannel | undefined;
  const maintenance = new LocalDataMaintenance(database, indexCache, {
    broadcast: {
      postMessage: (message) => incrementalChannel?.postMessage(message),
    },
  });
  let pageSearchRuntime: PageSearchRuntime | undefined;
  let fileSearchRuntime: FileSearchRuntime | undefined;
  let dataCodeRuntime: DataCodeRuntime | undefined;
  let runtimeLifecycle: RuntimeLifecycleCoordinator | undefined;
  let mirrorSyncOrchestrator: MirrorSyncOrchestrator | undefined = undefined;
  let redirectFactsCommitted = false;
  let writesCompatible = true;
  let resolveInitialCacheReady!: () => void;
  let rejectInitialCacheReady!: (error: unknown) => void;
  const initialCacheReady = new Promise<void>((resolve, reject) => {
    resolveInitialCacheReady = resolve;
    rejectInitialCacheReady = reject;
  });
  void initialCacheReady.catch(() => undefined);
  let resolvePageSearchRuntimeReady!: (runtime: PageSearchRuntime) => void;
  let rejectPageSearchRuntimeReady!: (error: unknown) => void;
  const pageSearchRuntimeReady = new Promise<PageSearchRuntime>(
    (resolve, reject) => {
      resolvePageSearchRuntimeReady = resolve;
      rejectPageSearchRuntimeReady = reject;
    },
  );
  void pageSearchRuntimeReady.catch(() => undefined);
  rejectStartup = (error) => {
    rejectInitialCacheReady(error);
    rejectPageSearchRuntimeReady(error);
  };
  const contentModel = pageWindow.mw?.config?.get('wgPageContentModel');
  const canInsertWikiText =
    typeof contentModel !== 'string' || contentModel === 'wikitext';
  const initialBackgroundRefresh = new InitialBackgroundRefreshCoordinator({
    canRun: () => writesCompatible,
    isVisible: () => document.visibilityState === 'visible',
    syncIncremental: () => requestIncrementalSync(),
    syncData: async () =>
      (await requestDataCodeSync(false)).status === 'complete',
  });

  const panel = new SearchPanel({
    prepareSearch: (kind) => {
      const preparation = pageSearchRuntimeReady.then((runtime) =>
        runtime.prepare(kind),
      );
      observeRuntimeTask(
        preparation,
        'enhanced search startup',
        `${searchKindLabel(kind)}加载失败，已有本地搜索仍可用`,
      );
    },
    prepareFiles: () => {
      observeRuntimeTask(
        ensureFileSearchStarted(false),
        'file resource startup',
        '文件资源加载失败，本地缓存仍可用',
      );
    },
    search: (query, namespace) =>
      pageSearchRuntime?.searchTitles(query, namespace) ?? [],
    searchFiles: (query) => fileSearchRuntime?.search(query) ?? [],
    searchLua: (query) => pageSearchRuntime?.searchLua(query) ?? [],
    searchCss: (query) => pageSearchRuntime?.searchCss(query) ?? [],
    searchContent: (query, namespace) =>
      pageSearchRuntime?.searchContent(query, namespace) ?? [],
    searchCodes: (query) => dataCodeRuntime?.search(query) ?? [],
    insert: (result, query) => {
      if (!canInsertWikiText) {
        panel.setStatus(`当前为 ${contentModel}，不支持插入维基链接`, 'error');
        return;
      }
      const link = wikiLink(
        result.title,
        'kind' in result ? result.title : query,
        result.namespace,
      );
      const editor = insertAtEditorSelection(link);
      panel.setStatus(
        `已插入 ${link} · ${editor === 'codemirror' ? 'CodeMirror' : '文本框'}`,
        'success',
      );
    },
    copy: (result, query) => {
      const link = wikiLink(
        result.title,
        'kind' in result ? result.title : query,
        result.namespace,
      );
      GM_setClipboard(link, 'text');
      panel.setStatus(`已复制 ${link}`, 'success');
    },
    redirectUrl: (target) => pageUrl(target.title, target.fragment),
    open: (result) => {
      GM_openInTab(pageUrl(result.title), { active: true });
    },
    copyTitle: (result) => {
      GM_setClipboard(result.title, 'text');
      panel.setStatus(`已复制标题：${result.title}`, 'success');
    },
    copyCode: (result) => {
      GM_setClipboard(result.code, 'text');
      panel.setStatus(`已复制代码名：${result.code}`, 'success');
    },
    openCode: (result) => {
      GM_openInTab(pageUrl(result.source), { active: true });
    },
    refresh: () => {
      const lifecycle = runtimeLifecycle;
      if (!lifecycle) return;
      observeRuntimeTask(
        lifecycle.refreshMirror({
          syncTitles: () => requestSync(false),
          reconcile: () => requestManualReconciliation(),
          syncData: () => requestManualDataCodeSync(),
          syncContent: () => requestContentSync(false),
        }),
        'manual mirror refresh',
        '重新同步本地数据暂停',
      );
    },
    refreshFiles: () => {
      observeRuntimeTask(
        ensureFileSearchStarted(true),
        'manual file refresh',
        '文件资源同步暂停，本地缓存仍可搜索',
      );
    },
    saveDataCodeRules: (source) => saveDataCodeRules(source),
    saveHighlightPreferences: (preferences) => {
      void highlightPreference.set(preferences).catch((error: unknown) => {
        console.warn(
          '[CU Wiki Search] failed to save highlight preferences',
          error,
        );
      });
    },
    loadMaintenance: () => maintenance.inspect(),
    rebuildSearchIndexes: () => rebuildSearchIndexes(),
    rebuildContentQueue: async () => {
      assertWritesAllowed();
      await runCoordinatedWriter('maintenance-queue', () =>
        maintenance.rebuildContentQueue(),
      );
    },
    reconcileNow: () => requestManualReconciliation(),
    clearSnapshots: async () => {
      await maintenance.clearSnapshots();
      await pageSearchRuntime?.refreshSnapshotStatus();
    },
    requestPersistence: () => maintenance.requestPersistence(),
    resetLocalMirror: (resetDataRules) =>
      maintenance.resetLocalMirror({ resetDataRules }),
  });
  startupPanel = panel;
  panel.setInsertMode(canInsertWikiText);
  panel.setStatus('正在加载本地索引与分词引擎…');

  const debugApi: DebugApi = {
    ready: false,
    scriptVersion: GM_info.script.version,
    buildId: __CU_WIKI_BUILD_ID__,
    indexedPages: 0,
    indexedFiles: 0,
    indexedDataCodes: 0,
    indexedContentPages: 0,
    indexedLuaModules: 0,
    indexedCssSources: 0,
    contentModel: typeof contentModel === 'string' ? contentModel : undefined,
    incrementalStatus: 'idle',
    reconciliationStatus: 'idle',
    snapshots: [],
    search: (query, namespace) =>
      pageSearchRuntime?.searchTitles(query, namespace) ?? [],
    searchFiles: (query) => fileSearchRuntime?.search(query) ?? [],
    searchCodes: (query) => dataCodeRuntime?.search(query) ?? [],
    searchContent: (query, namespace) =>
      pageSearchRuntime?.searchContent(query, namespace) ?? [],
    searchLua: (query) => pageSearchRuntime?.searchLua(query) ?? [],
    searchCss: (query) => pageSearchRuntime?.searchCss(query) ?? [],
    forceSync: () => requestManualReconciliation(),
    forceFileSync: () => ensureFileSearchStarted(true),
    forceDataCodeSync: () => requestManualDataCodeSync(),
    forceContentSync: () => requestContentSync(true),
    requestIncrementalSync: () => requestIncrementalSync(),
  };
  pageWindow.__CU_WIKI_SEARCH__ = debugApi;

  await database.open();
  const versionState = await inspectVersionContract(database);
  writesCompatible = versionState.status === 'compatible';
  const fallbackAnalyzer = new Analyzer(
    createBootstrapSegmenter(),
    'bootstrap',
  );
  const incrementalCoordinator = new IncrementalSyncCoordinator(database);
  runtimeLifecycle = new RuntimeLifecycleCoordinator({
    applyStorageInvalidation: applyStorageInvalidation,
    writer: incrementalCoordinator,
  });
  pageSearchRuntime = new PageSearchRuntime({
    database,
    indexCache,
    bootstrapAnalyzer: fallbackAnalyzer,
    loadAnalyzer: async () => {
      await initialCacheReady;
      return loadAnalyzer();
    },
    waitUntilVisible: () => browserTaskScheduler.waitUntilVisible(),
    synchronizeTitles: async (force, analyzer, onBatch) => {
      let coordinated;
      try {
        coordinated = await incrementalCoordinator.runExclusive(async () => {
          const state = await syncTitles(database, api, analyzer, {
            force,
            onBatch,
            onProgress: (progress) =>
              panel.setStatus(progressMessage(progress)),
          });
          await syncRedirectTargets(database, api, {
            refreshSince: state.generation,
            onBatch: () => {
              redirectFactsCommitted = true;
            },
          });
        });
      } finally {
        await refreshRedirectFacts();
      }
      if (coordinated === 'lock-unavailable')
        throw writerLockUnavailableError();
    },
    synchronizeContent: async (force, scope = 'content') => {
      let progress: Awaited<ReturnType<typeof syncContent>> | undefined;
      const coordinated = await runtimeLifecycle!.runWriter(
        `content:${scope}`,
        async () => {
          progress = await syncContent(database, api, {
            force,
            scope,
            onBatch: () => {
              incrementalChannel?.postMessage({ type: 'content-committed' });
            },
            onProgress: (current) => {
              panel.setStatus(
                `同步${scope === 'css' ? 'CSS 源码' : '页面正文'} ${current.done}/${current.total}` +
                  (current.failed ? ` · ${current.failed} 失败` : ''),
              );
            },
          });
        },
      );
      if (coordinated === 'lock-unavailable')
        throw writerLockUnavailableError();
      if (!progress) throw new Error('正文同步未返回进度');
      return progress;
    },
    rebuildIndexes: (analyzer) => maintenance.rebuildSearchIndexes(analyzer),
    onStateChange: (state) => applyPageSearchState(state),
    onResultsChanged: (kinds) => panel.invalidateResults(kinds),
    onStatus: ({ message, tone }) => panel.setStatus(message, tone),
    startedAt: bootStartedAt,
  });
  resolvePageSearchRuntimeReady(pageSearchRuntime);
  await pageSearchRuntime.initialize();
  fileSearchRuntime = new FileSearchRuntime({
    database,
    api,
    analyzer: fallbackAnalyzer,
    waitUntilReady: () => initialCacheReady,
    canWrite: ensureWritesAllowed,
    runExclusive: (task) => incrementalCoordinator.runExclusive(task),
    onStateChange: (state) => {
      debugApi.indexedFiles = state.indexedFiles;
    },
    onResultsChanged: () => panel.invalidateResults(['files']),
    onRestored: (count) =>
      panel.setStatus(
        count ? `已恢复 ${count} 个文件资源` : '正在首次同步文件资源…',
        count ? 'success' : 'normal',
      ),
    onProgress: (progress) => {
      if (progress.status === 'running') {
        panel.setStatus(`同步文件资源 ${progress.pagesFetched} 页…`);
      }
    },
    onCommitted: async (state) => {
      await refreshIndexesFromStorage({ files: true });
      incrementalChannel?.postMessage({ type: 'files-committed' });
      panel.setStatus(
        `文件资源同步完成 · ${state.pagesFetched} 项可独立搜索`,
        'success',
      );
    },
  });
  dataCodeRuntime = new DataCodeRuntime({
    database,
    analyzer: fallbackAnalyzer,
    preference: dataRulesPreference,
    runWriter: runCoordinatedWriter,
    onStateChange: (state) => {
      debugApi.indexedDataCodes = state.indexedDataCodes;
    },
    onResultsChanged: () => panel.invalidateResults(['data-code']),
    onRulesChange: (source) =>
      panel.setDataCodeRules(source, DEFAULT_DATA_CODE_RULES),
    onCommitted: applyDataCodeCommit,
    onInvalidRules: (origin, error) => {
      console.warn(
        `[CU Wiki Search] ignored invalid ${origin} Data code rules`,
        error,
      );
    },
  });
  const [, recentChangeState, reconciliationState] = await Promise.all([
    dataCodeRuntime.initialize(),
    readRecentChangeSyncState(database),
    readReconciliationSyncState(database),
  ]);
  if (writesCompatible) {
    try {
      await incrementalCoordinator.runExclusiveIfAvailable(() =>
        database.syncState.delete(LEGACY_DATA_EXTRACTION_RULES_KEY),
      );
    } catch (error) {
      if (error instanceof FactWriteCompatibilityError)
        writesCompatible = false;
      else throw error;
    }
  }
  panel.setHighlightPreferences(await highlightPreference.get());
  const committedReconciliationRefresh = new CommittedReconciliationRefresh({
    readState: () => readReconciliationSyncState(database),
    lastAppliedSequence: () => pageSearchRuntime?.state.throughLocalSeq ?? 0,
    refresh: (invalidation) => refreshIndexesFromStorage(invalidation),
    broadcast: (message) => incrementalChannel?.postMessage(message),
  });
  const committedRecentChangeRefresh = new CommittedRecentChangeRefresh({
    refresh: (invalidation) => refreshIndexesFromStorage(invalidation),
    broadcast: (message) => incrementalChannel?.postMessage(message),
  });
  await fileSearchRuntime.refresh(recentChangeState?.fileChangeSeq ?? 0);
  debugApi.incrementalThrough = recentChangeState?.through;
  debugApi.reconciliationStatus =
    reconciliationState?.status === 'complete'
      ? 'complete'
      : reconciliationState?.status === 'running'
        ? 'running'
        : reconciliationState?.status === 'failed'
          ? 'error'
          : 'idle';
  debugApi.reconciliationCompletedAt = reconciliationState?.completedAt;
  mirrorSyncOrchestrator = new MirrorSyncOrchestrator({
    coordinator: incrementalCoordinator,
    facts: {
      reconcile: (force, onProgress) =>
        reconcileWikiMirror(database, api, fallbackAnalyzer, {
          force,
          onProgress,
        }),
      catchUp: () => syncRecentChanges(database, api, fallbackAnalyzer),
      resolveRedirects: async () => {
        const state = await readReconciliationSyncState(database);
        await syncRedirectTargets(database, api, {
          refreshSince:
            state?.status === 'complete' ? state.generation : undefined,
          onBatch: () => {
            redirectFactsCommitted = true;
          },
        });
      },
    },
    committed: {
      refreshStorage: () => refreshIndexesFromStorage(),
      refreshRedirects: () => refreshRedirectFacts(),
      refreshReconciliation: () => committedReconciliationRefresh.apply(),
      refreshRecentChanges: (result) =>
        committedRecentChangeRefresh.apply(result),
    },
    derived: {
      refreshData: () => requestDataCodeSync(false),
      hasLoadedContentIndex: () =>
        pageSearchRuntime?.hasLoadedContentIndex() ?? false,
      refreshContent: () => runContentSync(false),
    },
    onEvent: (event) => handleMirrorSyncEvent(event),
  });
  debugApi.ready = true;
  debugApi.engine = pageSearchRuntime.state.engine;
  debugApi.indexedPages = pageSearchRuntime.state.indexedPages;
  debugApi.indexedDataCodes = dataCodeRuntime.state.indexedDataCodes;
  debugApi.snapshots = [...pageSearchRuntime.state.snapshots];
  debugApi.startupMs = Math.round(performance.now() - bootStartedAt);
  panel.setStatus(
    writesCompatible
      ? `已恢复 ${pageSearchRuntime.state.indexedPages} 个标题 · ${dataCodeRuntime.state.indexedDataCodes} 个 Data 代码 · 各模式按需加载`
      : `本地数据版本不兼容，已停止后台写入；可搜索现有数据或执行完整重置`,
    writesCompatible ? 'success' : 'error',
  );
  resolveInitialCacheReady();
  rejectStartup = undefined;

  if (typeof BroadcastChannel === 'function') {
    incrementalChannel = new BroadcastChannel(
      'cu-wiki-local-search:changes:v1',
    );
    incrementalChannel.addEventListener('message', (event) => {
      const effect = changeBroadcastEffect(event.data);
      if (effect.type === 'reset') {
        database.close();
        location.reload();
        return;
      }
      if (effect.dataRefresh === 'pending')
        initialBackgroundRefresh.markPending();
      else if (effect.dataRefresh === 'complete')
        initialBackgroundRefresh.markComplete();
      if (document.visibilityState !== 'visible') {
        runtimeLifecycle?.deferStorageRefresh(effect.invalidation);
        return;
      }
      observeRuntimeTask(
        refreshIndexesFromStorage(effect.invalidation),
        'broadcast storage refresh',
        '本地索引刷新暂停，稍后将自动重试',
      );
      if (effect.dataRefresh === 'pending') {
        observeRuntimeTask(
          initialBackgroundRefresh.request(),
          'broadcast Data refresh',
        );
      }
    });
  }

  const requestVisibleIncrementalSync = (): void => {
    if (document.visibilityState !== 'visible') return;
    if (runtimeLifecycle) {
      observeRuntimeTask(
        runtimeLifecycle.resumeStorageRefresh(),
        'visible storage refresh',
        '本地索引刷新暂停，稍后将自动重试',
      );
    }
    observeRuntimeTask(
      initialBackgroundRefresh.request(),
      'visible Data refresh',
    );
    observeRuntimeTask(requestIncrementalSync(), 'visible incremental sync');
  };
  window.addEventListener('focus', requestVisibleIncrementalSync);
  document.addEventListener('visibilitychange', requestVisibleIncrementalSync);
  window.setInterval(requestVisibleIncrementalSync, 30_000);

  if (writesCompatible) {
    observeRuntimeTask(
      (async () => {
        await whenPageIdle();
        await initialBackgroundRefresh.request();
      })(),
      'initial background refresh',
      '后台首次刷新暂停，稍后将自动重试',
    );
  }

  async function ensureFileSearchStarted(force: boolean): Promise<void> {
    await initialCacheReady;
    return fileSearchRuntime!.prepare(force);
  }

  async function refreshRedirectFacts(): Promise<void> {
    if (!redirectFactsCommitted) return;
    redirectFactsCommitted = false;
    // Always notify other tabs, including when the writer's local refresh fails.
    try {
      await refreshIndexesFromStorage();
    } finally {
      incrementalChannel?.postMessage({ type: 'redirects-committed' });
    }
  }

  async function requestSync(force: boolean): Promise<void> {
    const runtime = pageSearchRuntime;
    if (!runtime) throw new Error('页面搜索运行态尚未就绪');
    await runtime.synchronizeTitles(force);
  }

  async function saveDataCodeRules(source: string): Promise<void> {
    assertWritesAllowed();
    if (!dataCodeRuntime) throw new Error('Data 代码同步尚未就绪');
    await dataCodeRuntime.save(source);
  }

  async function requestDataCodeSync(
    force: boolean,
  ): Promise<SyncAttemptResult> {
    if (!ensureWritesAllowed()) {
      initialBackgroundRefresh.markPending();
      return { status: 'error', error: new Error('本地数据版本不兼容') };
    }
    const runtime = dataCodeRuntime;
    if (!runtime) {
      return { status: 'error', error: new Error('Data 代码同步尚未就绪') };
    }
    const outcome = await runtime.refresh(force);
    if (outcome.status === 'complete') return { status: 'complete' };
    initialBackgroundRefresh.markPending();
    const message = errorMessage(outcome.error);
    panel.setStatus(
      `Data 代码更新失败，${dataCodeRuntime?.state.indexedDataCodes ? '继续使用本地缓存' : '标题搜索仍可用'}：${message}`,
      'error',
    );
    console.error('[CU Wiki Search] Data code sync failed', outcome.error);
    return outcome;
  }

  function applyDataCodeCommit(commit: DataCodeCommit): void {
    initialBackgroundRefresh.markComplete();
    if (commit.result.refreshed || commit.origin === 'save') {
      incrementalChannel?.postMessage({ type: 'data-committed' });
    }
    const count = dataCodeRuntime?.state.indexedDataCodes ?? 0;
    if (commit.origin === 'save') {
      panel.setStatus(`Data 代码检索字段已保存 · ${count} 条`, 'success');
    } else if (commit.result.refreshed) {
      panel.setStatus(`Data 代码更新完成 · ${count} 条`, 'success');
    }
  }

  async function requestManualDataCodeSync(): Promise<void> {
    const result = await requestDataCodeSync(true);
    if (result.status === 'error') throw result.error;
  }

  async function requestContentSync(force: boolean): Promise<void> {
    const runtime = pageSearchRuntime;
    if (!runtime) throw new Error('页面搜索运行态尚未就绪');
    await runtime.prepare('title');
    return runtime.synchronizeContent(force);
  }

  async function requestIncrementalSync(): Promise<void> {
    if (!ensureWritesAllowed()) return;
    const orchestrator = mirrorSyncOrchestrator;
    if (!orchestrator) return;
    try {
      const outcome = await orchestrator.runScheduled();
      await applyMirrorSyncOutcome(outcome);
    } catch (error) {
      debugApi.incrementalStatus = 'error';
      throw error;
    }
  }

  async function requestManualReconciliation(): Promise<void> {
    if (!ensureWritesAllowed()) throw new Error('本地数据版本不兼容');
    const orchestrator = mirrorSyncOrchestrator;
    if (!orchestrator) throw new Error('全量对账协调器尚未就绪');
    try {
      const outcome = await orchestrator.reconcileNow();
      await applyMirrorSyncOutcome(outcome);
      if (outcome.status !== 'complete') throw mirrorSyncOutcomeError(outcome);
    } catch (error) {
      debugApi.reconciliationStatus = 'error';
      throw error;
    }
  }

  function handleMirrorSyncEvent(event: MirrorSyncEvent): void {
    if (event.type === 'started') {
      if (event.request === 'scheduled') debugApi.incrementalStatus = 'running';
      else debugApi.reconciliationStatus = 'running';
      return;
    }
    debugApi.reconciliationStatus = 'running';
    if (event.type === 'reconciliation-started') return;
    panel.setStatus(
      `全量对账 ${event.state.pagesFetched} 页 · ${Math.min(event.state.namespaceIndex + 1, event.state.namespaceIds.length)}/${event.state.namespaceIds.length}`,
    );
  }

  async function applyMirrorSyncOutcome(
    outcome: MirrorSyncOutcome,
  ): Promise<void> {
    const reconciliation = outcome.reconciliation;
    if (reconciliation) {
      debugApi.reconciliationStatus =
        reconciliation.status === 'complete'
          ? 'complete'
          : reconciliation.status;
      if (reconciliation.status === 'complete') {
        debugApi.reconciliationCompletedAt = (
          await readReconciliationSyncState(database)
        )?.completedAt;
      }
    }
    const recentChanges = outcome.recentChanges;
    if (recentChanges?.status === 'complete') {
      debugApi.incrementalStatus = 'complete';
      debugApi.incrementalThrough = recentChanges.through;
    } else if (recentChanges) {
      debugApi.incrementalStatus = recentChanges.status;
    } else if (outcome.request === 'scheduled') {
      debugApi.incrementalStatus =
        outcome.status === 'not-due'
          ? 'idle'
          : outcome.status === 'catch-up-error' ||
              outcome.status === 'data-error' ||
              outcome.status === 'content-error'
            ? 'error'
            : outcome.status;
    } else if (outcome.status === 'catch-up-error') {
      debugApi.incrementalStatus = 'error';
    }
    if (!reconciliation && outcome.request === 'manual') {
      debugApi.reconciliationStatus =
        outcome.status === 'data-error' ||
        outcome.status === 'content-error' ||
        outcome.status === 'catch-up-error'
          ? 'error'
          : outcome.status;
    } else if (
      !reconciliation &&
      outcome.errors?.synchronization &&
      debugApi.reconciliationStatus === 'running'
    ) {
      debugApi.reconciliationStatus = 'error';
    }
    if (outcome.errors?.committedRefresh) {
      if (outcome.request === 'scheduled') debugApi.incrementalStatus = 'error';
      else debugApi.reconciliationStatus = 'error';
    }

    for (const [phase, error] of Object.entries(outcome.errors ?? {})) {
      console.error(`[CU Wiki Search] mirror sync ${phase} failed`, error);
    }
    if (outcome.status === 'complete') {
      if (
        outcome.request === 'manual' &&
        reconciliation?.status === 'complete'
      ) {
        panel.setStatus(
          `全量对账完成 · ${reconciliation.pagesFetched} 页 · ${reconciliation.pagesChanged} 个页面变化` +
            (reconciliation.filesChanged ? ' · 文件资源已更新' : ''),
          'success',
        );
      } else if (
        recentChanges?.status === 'complete' &&
        (recentChanges.changedPages.length || recentChanges.filesChanged)
      ) {
        panel.setStatus(
          `增量同步完成 · ${recentChanges.changedPages.length} 个页面` +
            (recentChanges.filesChanged ? ' · 文件资源已更新' : ''),
          'success',
        );
      }
      return;
    }
    if (outcome.status === 'not-due') return;
    const message = mirrorSyncOutcomeError(outcome).message;
    const prefix = outcome.request === 'manual' ? '全量对账' : '增量同步';
    panel.setStatus(`${prefix}暂停，本地已有内容仍可搜索：${message}`, 'error');
  }

  function mirrorSyncOutcomeError(outcome: MirrorSyncOutcome): Error {
    const cause =
      outcome.errors?.synchronization ??
      outcome.errors?.catchUp ??
      outcome.errors?.data ??
      outcome.errors?.content ??
      outcome.errors?.committedRefresh;
    if (cause instanceof Error) return cause;
    if (cause !== undefined) return new Error(String(cause));
    if (outcome.status === 'login-required')
      return new Error('请先登录灰机账号');
    if (outcome.status === 'lock-unavailable') {
      return new Error(
        '无法取得跨标签写入锁，请确认浏览器支持 Web Locks 后重试',
      );
    }
    if (outcome.status === 'no-baseline') {
      return new Error('尚无完整标题基线，请先重试标题同步');
    }
    if (outcome.status === 'not-due') return new Error('全量对账尚未到期');
    return new Error('同步未完成，请稍后重试');
  }

  async function refreshIndexesFromStorage(
    invalidation: StorageInvalidationRequest = { pages: true },
  ): Promise<void> {
    if (runtimeLifecycle) return runtimeLifecycle.refreshStorage(invalidation);
    return applyStorageInvalidation({
      pages: invalidation.pages === true,
      files: invalidation.files === true,
      data: invalidation.data === true,
    });
  }

  async function applyStorageInvalidation(
    invalidation: StorageInvalidation,
  ): Promise<void> {
    const incrementalState =
      invalidation.pages || invalidation.files
        ? await readRecentChangeSyncState(database)
        : undefined;
    if (invalidation.pages) await pageSearchRuntime?.refresh();
    await fileSearchRuntime?.refresh(
      incrementalState?.fileChangeSeq ?? 0,
      invalidation.files,
    );
    if (incrementalState)
      debugApi.incrementalThrough = incrementalState.through;
    if (invalidation.data) await dataCodeRuntime?.reloadFromStorage();
  }

  function runContentSync(force: boolean): Promise<void> {
    if (!ensureWritesAllowed()) return Promise.resolve();
    return pageSearchRuntime?.synchronizeContent(force) ?? Promise.resolve();
  }

  async function rebuildSearchIndexes(): Promise<
    MaintenanceActionFeedback | undefined
  > {
    const runtime = await pageSearchRuntimeReady;
    const warnings = await runtime.rebuildIndexes();
    if (warnings.length) {
      return {
        message: `索引已重建，某些快照未保存：${warnings.map(({ message }) => message).join('；')}；当前搜索可用`,
        tone: 'normal',
      };
    }
    return undefined;
  }

  function applyPageSearchState(state: PageSearchRuntimeState): void {
    debugApi.engine = state.engine;
    debugApi.indexedPages = state.indexedPages;
    debugApi.indexedContentPages = state.indexedContentPages;
    debugApi.indexedLuaModules = state.indexedLuaModules;
    debugApi.indexedCssSources = state.indexedCssSources;
    debugApi.jiebaReadyMs = state.jiebaReadyMs;
    debugApi.contentIndexReadyMs = state.contentIndexReadyMs;
    debugApi.luaIndexReadyMs = state.luaIndexReadyMs;
    debugApi.contentReadyMs = state.contentReadyMs;
    debugApi.snapshots = [...state.snapshots];
    panel.setNamespaces([...state.namespaces]);
  }

  function ensureWritesAllowed(): boolean {
    if (writesCompatible) return true;
    panel.setStatus(
      '本地数据版本不兼容，后台写入已停止；请更新脚本或检查本地状态',
      'error',
    );
    return false;
  }

  function assertWritesAllowed(): void {
    if (!ensureWritesAllowed())
      throw new Error('本地数据版本不兼容，后台写入已停止');
  }

  async function runCoordinatedWriter(
    key: string,
    task: () => Promise<void>,
  ): Promise<void> {
    await initialCacheReady;
    const coordinated = runtimeLifecycle
      ? await runtimeLifecycle.runWriter(key, task)
      : 'lock-unavailable';
    if (coordinated === 'lock-unavailable') {
      throw new Error(
        '无法取得跨标签写入锁，请确认浏览器支持 Web Locks 后重试',
      );
    }
  }

  function observeRuntimeTask(
    task: Promise<unknown>,
    context: string,
    userMessage?: string,
  ): void {
    void task.catch((error: unknown) => {
      if (error instanceof FactWriteCompatibilityError)
        writesCompatible = false;
      if (userMessage)
        panel.setStatus(`${userMessage}：${errorMessage(error)}`, 'error');
      console.error(`[CU Wiki Search] ${context} failed`, error);
    });
  }
}

function progressMessage(progress: TitleSyncProgress): string {
  if (progress.status === 'failed')
    return `标题同步失败：${progress.error ?? '未知错误'}`;
  if (progress.status === 'complete')
    return `标题同步完成 · ${progress.pagesFetched} 页`;
  return `同步标题 ${progress.pagesFetched} 页 · ${progress.namespaceName ?? '命名空间'} (${Math.min(progress.namespaceIndex + 1, progress.namespaceCount)}/${progress.namespaceCount})`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writerLockUnavailableError(): Error {
  return new Error('无法取得跨标签写入锁，请确认浏览器支持 Web Locks 后重试');
}

function searchKindLabel(kind: 'title' | 'content' | 'lua' | 'css'): string {
  if (kind === 'css') return 'CSS 搜索';
  if (kind === 'content') return '正文索引';
  if (kind === 'lua') return 'Lua 索引';
  return '标题索引';
}

function pageUrl(title: string, fragment?: string): string {
  return buildPageUrl(pageWindow, title, fragment);
}

function whenPageIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: 2_000 });
    } else {
      window.setTimeout(resolve, 0);
    }
  });
}
