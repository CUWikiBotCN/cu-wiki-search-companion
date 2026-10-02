// SPDX-License-Identifier: MPL-2.0
import type { Analyzer } from '../analyzer/analyzer';
import type { AnalyzerLoadResult } from '../analyzer/load-jieba';
import type {
  SearchIndexRebuildResult,
  SearchIndexRebuildWarning,
} from '../maintenance/local-data-maintenance';
import { CssSourceIndex, type CssSearchResult } from '../search/css-source-index';
import type { ContentSyncScope } from '../sync/content-job-policy';
import type { ContentSearchResult } from '../search/content-index';
import type { LuaModuleSearchResult } from '../search/lua-module-index';
import {
  type SearchIndexHandle,
  type SnapshotInspection,
  type SnapshotPublishResult,
  VersionedSearchIndexCache,
} from '../search/versioned-search-index-cache';
import {
  CombinedTitleIndex,
  LinearTitleIndex,
  type TitleSearchBackend,
  type TitleSearchResult,
} from '../search/title-index';
import {
  readActivePageHeaders,
  readPageHeadersAfter,
  type WikiSearchDatabase,
} from '../storage/database';
import { readLocalSequence } from '../storage/sync-state';
import type { ContentSyncProgress, NamespaceInfo, PageRecord } from '../types';
import { AnalyzerPreparationCoordinator } from './analyzer-preparation';
import { ContentSyncSession } from './content-sync-session';
import { StagedPreparationCoordinator } from './staged-preparation';

export type PageSearchKind = 'title' | 'content' | 'lua' | 'css';
export type PageSearchReadiness = 'not-started' | 'local' | 'ready';
type PageSearchHandle =
  | SearchIndexHandle<'title'>
  | SearchIndexHandle<'content'>
  | SearchIndexHandle<'lua'>;

export interface PageSearchRuntimeState {
  initialized: boolean;
  engine: AnalyzerLoadResult['engine'];
  analyzerWarning?: string;
  readiness: Readonly<Record<PageSearchKind, PageSearchReadiness>>;
  indexedPages: number;
  indexedContentPages: number;
  indexedLuaModules: number;
  indexedCssSources: number;
  namespaces: readonly NamespaceInfo[];
  throughLocalSeq: number;
  snapshots: readonly SnapshotInspection[];
  jiebaReadyMs?: number;
  contentIndexReadyMs?: number;
  luaIndexReadyMs?: number;
  contentReadyMs?: number;
}

export interface PageSearchRuntimeStatus {
  message: string;
  tone?: 'normal' | 'success' | 'error';
}

export interface PageSearchRuntimeOptions {
  database: WikiSearchDatabase;
  indexCache: VersionedSearchIndexCache;
  bootstrapAnalyzer: Analyzer;
  loadAnalyzer(): Promise<AnalyzerLoadResult>;
  waitUntilVisible(): Promise<void>;
  synchronizeTitles(
    force: boolean,
    analyzer: Analyzer,
    onBatch: (pages: PageRecord[]) => void,
  ): Promise<void>;
  synchronizeContent(force: boolean, scope?: ContentSyncScope): Promise<ContentSyncProgress>;
  rebuildIndexes(analyzer: Analyzer): Promise<SearchIndexRebuildResult>;
  onStateChange?(state: PageSearchRuntimeState): void;
  onResultsChanged?(kinds: readonly PageSearchKind[]): void;
  onStatus?(status: PageSearchRuntimeStatus): void;
  clock?(): number;
  startedAt?: number;
}

export class PageSearchRuntime {
  private readonly database: WikiSearchDatabase;
  private readonly indexCache: VersionedSearchIndexCache;
  private readonly bootstrapAnalyzer: Analyzer;
  private readonly clock: () => number;
  private readonly startedAt: number;
  private readonly analyzerPreparation: AnalyzerPreparationCoordinator<AnalyzerLoadResult>;
  private readonly titlePreparation: StagedPreparationCoordinator;
  private readonly contentPreparation: StagedPreparationCoordinator;
  private readonly luaPreparation: StagedPreparationCoordinator;
  private readonly contentSyncSession: ContentSyncSession;
  private readonly cssSyncSession: ContentSyncSession;
  private readonly cssPreparation: StagedPreparationCoordinator;
  private cssIndex?: CssSourceIndex;
  private initializePromise: Promise<void> | undefined;
  private titleSyncPromise: Promise<string | undefined> | undefined;
  private rebuildPromise: Promise<SearchIndexRebuildWarning[]> | undefined;
  private installGeneration = 0;
  private bootstrapThroughLocalSeq = 0;
  private refreshQueue: Promise<void> = Promise.resolve();
  private analyzerResult: AnalyzerLoadResult | undefined;
  private searchBackend: TitleSearchBackend | undefined;
  private bootstrapIndex: LinearTitleIndex | undefined;
  private titleHandle: SearchIndexHandle<'title'> | undefined;
  private contentHandle: SearchIndexHandle<'content'> | undefined;
  private luaHandle: SearchIndexHandle<'lua'> | undefined;
  private mutableState: PageSearchRuntimeState = {
    initialized: false,
    engine: 'bootstrap',
    readiness: { title: 'not-started', content: 'not-started', lua: 'not-started', css: 'not-started' },
    indexedPages: 0,
    indexedContentPages: 0,
    indexedLuaModules: 0,
    indexedCssSources: 0,
    namespaces: [],
    throughLocalSeq: 0,
    snapshots: (['title', 'content', 'lua'] as const).map((kind) => ({
      kind,
      status: 'not-started',
    })),
  };

  constructor(private readonly options: PageSearchRuntimeOptions) {
    this.database = options.database;
    this.indexCache = options.indexCache;
    this.bootstrapAnalyzer = options.bootstrapAnalyzer;
    this.clock = options.clock ?? (() => performance.now());
    this.startedAt = options.startedAt ?? this.clock();
    this.analyzerPreparation = new AnalyzerPreparationCoordinator(async () => {
      await this.initialize();
      await options.waitUntilVisible();
      const result = await options.loadAnalyzer();
      this.analyzerResult = result;
      this.patchState({
        engine: result.engine,
        analyzerWarning: result.warning,
        jiebaReadyMs: this.elapsedMs(),
      });
      return result;
    });
    this.titlePreparation = new StagedPreparationCoordinator({
      prepareLocal: () => this.prepareLocalTitle(),
      settle: () => this.settleTitle(),
    });
    this.contentPreparation = new StagedPreparationCoordinator({
      prepareLocal: () => this.prepareLocalDerived('content'),
      settle: () => this.settleDerived('content'),
    });
    this.luaPreparation = new StagedPreparationCoordinator({
      prepareLocal: () => this.prepareLocalDerived('lua'),
      settle: () => this.settleDerived('lua'),
    });
    this.cssPreparation = new StagedPreparationCoordinator({
      prepareLocal: async () => {
        await this.initialize();
        await this.options.waitUntilVisible();
        this.cssIndex ??= new CssSourceIndex();
        await this.cssIndex.refresh(this.database);
        this.setReadiness('css', 'local');
        this.updateCounts();
        this.resultsChanged(['css']);
      },
      settle: async () => {
        // CSS never needs a natural-language analyzer or a title snapshot.
        await this.options.synchronizeTitles(false, this.bootstrapAnalyzer, () => undefined);
        await this.refresh();
        await this.cssSyncSession.run(false);
        this.setReadiness('css', 'ready');
      },
    });
    this.cssSyncSession = new ContentSyncSession({
      synchronize: (force) => this.performCssSynchronization(force),
      reportFailure: (error) => this.status(`CSS 同步暂停，本地缓存仍可搜索：${errorMessage(error)}`, 'error'),
    });
    this.contentSyncSession = new ContentSyncSession({
      synchronize: (force) => this.performContentSynchronization(force),
      reportFailure: (error) => {
        this.status(`正文同步暂停，本地已有正文仍可搜索：${errorMessage(error)}`, 'error');
      },
    });
  }

  get state(): PageSearchRuntimeState {
    return {
      ...this.mutableState,
      readiness: { ...this.mutableState.readiness },
      namespaces: this.mutableState.namespaces.map((namespace) => ({ ...namespace })),
      snapshots: this.mutableState.snapshots.map((snapshot) => ({ ...snapshot })),
    };
  }

  initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    const attempt = (async () => {
      const { pages, sequence } = await this.readBootstrap();
      this.bootstrapIndex = new LinearTitleIndex(this.bootstrapAnalyzer, pages);
      this.bootstrapThroughLocalSeq = sequence;
      this.searchBackend = this.bootstrapIndex;
      this.patchState({
        initialized: true,
        indexedPages: this.searchBackend.size,
        namespaces: this.bootstrapIndex.namespaceSummary(),
        throughLocalSeq: sequence,
      });
      this.resultsChanged(['title']);
    })();
    const tracked = attempt.catch((error: unknown) => {
      if (this.initializePromise === tracked) this.initializePromise = undefined;
      throw error;
    });
    this.initializePromise = tracked;
    return tracked;
  }

  prepare(kind: PageSearchKind): Promise<void> {
    const rebuild = this.rebuildPromise;
    if (rebuild) {
      return settle(rebuild).then(() => this.prepare(kind));
    }
    if (kind === 'css') return this.cssPreparation.prepare();
    if (kind === 'title') return this.titlePreparation.prepare();
    return kind === 'content'
      ? this.contentPreparation.prepare()
      : this.luaPreparation.prepare();
  }

  async synchronizeTitles(force = false): Promise<void> {
    const rebuild = this.rebuildPromise;
    if (rebuild) await settle(rebuild);
    await this.titlePreparation.prepareLocal();
    try {
      await this.synchronizePreparedTitles(force);
    } catch (error) {
      this.titlePreparation.invalidateSettlement();
      throw error;
    }
  }

  async synchronizeContent(force = false): Promise<void> {
    await this.initialize();
    const attempts: Promise<void>[] = [];
    if (this.contentHandle || this.luaHandle || !this.cssIndex) attempts.push(this.contentSyncSession.run(force));
    if (this.cssIndex) attempts.push(this.cssSyncSession.run(force));
    const outcomes = await Promise.allSettled(attempts);
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  }

  refresh(): Promise<void> {
    return this.queueRefresh();
  }

  private queueRefresh(forceCss = false, rebuildContent = false): Promise<void> {
    const refreshing = this.refreshQueue.then(() => this.refreshOnce(forceCss, rebuildContent));
    this.refreshQueue = refreshing.catch(() => undefined);
    return refreshing;
  }

  private async refreshOnce(forceCss: boolean, rebuildContent: boolean): Promise<void> {
    await this.initialize();
    if (this.rebuildPromise) await settle(this.rebuildPromise);
    const generation = this.installGeneration;
    const changed = new Set<PageSearchKind>();
    const stale = (): boolean => generation !== this.installGeneration;
    try {
      if (rebuildContent && (this.contentHandle || this.luaHandle)) {
        const pages = await this.database.pages.toArray();
        if (stale()) return this.refreshOnce(forceCss, rebuildContent);
        for (const handle of [this.contentHandle, this.luaHandle]) {
          if (!handle) continue;
          await handle.index.rebuildAsync(pages);
          if (stale()) return this.refreshOnce(forceCss, rebuildContent);
          changed.add(handle.kind);
        }
      }
      while (true) {
        const { pages, sequence } = await this.readBootstrap(this.bootstrapThroughLocalSeq);
        if (stale()) return this.refreshOnce(forceCss, rebuildContent);
        const handles = this.handles();
        for (const handle of handles) {
          const replayed = await this.indexCache.refresh(handle);
          if (stale()) return this.refreshOnce(forceCss, rebuildContent);
          if (replayed) {
            changed.add(handle.kind);
            this.indexCache.schedulePublish(handle);
          }
        }
        if (await this.cssIndex?.refresh(this.database, forceCss)) changed.add('css');
        if (stale()) return this.refreshOnce(forceCss, rebuildContent);
        forceCss = false;
        if (pages.length) {
          this.bootstrapIndex!.update(pages);
          this.mutableState.namespaces = this.bootstrapIndex!.namespaceSummary();
          changed.add('title');
        }
        this.bootstrapThroughLocalSeq = sequence;
        this.mutableState.throughLocalSeq = Math.max(sequence, ...this.handles().map((handle) => handle.throughLocalSeq));
        const latest = await readLocalSequence(this.database);
        if (stale()) return this.refreshOnce(forceCss, rebuildContent);
        if (latest <= sequence && this.handles().every((handle) => handle.throughLocalSeq >= latest)) break;
      }
      this.updateCounts();
      await this.refreshSnapshotStatus();
      if (stale()) return this.refreshOnce(forceCss, rebuildContent);
      this.resultsChanged([...changed]);
    } catch (error) {
      // Earlier handles may already be current even when a later refresh fails.
      if (!stale()) {
        this.updateCounts();
        this.resultsChanged([...changed]);
      }
      throw error;
    }
  }

  private readBootstrap(after?: number): Promise<{ pages: PageRecord[]; sequence: number }> {
    return this.database.transaction('r', this.database.pages, this.database.fileResources, this.database.syncState, async () => ({
      sequence: await readLocalSequence(this.database),
      pages: after === undefined ? await readActivePageHeaders(this.database) : await readPageHeadersAfter(this.database, after),
    }));
  }

  rebuildIndexes(): Promise<SearchIndexRebuildWarning[]> {
    if (this.rebuildPromise) return this.rebuildPromise;
    const activeLocalPreparations = Promise.all([
      this.titlePreparation.waitForActiveLocal(),
      this.contentPreparation.waitForActiveLocal(),
      this.luaPreparation.waitForActiveLocal(),
      this.cssPreparation.waitForActiveLocal(),
    ]);
    this.installGeneration += 1;
    const attempt = (async () => {
      await this.initialize();
      await activeLocalPreparations;
      const loadedAnalyzer = await this.analyzerPreparation.prepare();
      const rebuilt = await this.options.rebuildIndexes(loadedAnalyzer.analyzer);
      const { pages, sequence } = await this.readBootstrap();
      const bootstrap = new LinearTitleIndex(this.bootstrapAnalyzer, pages);

      this.installGeneration += 1;
      this.titleHandle = rebuilt.title;
      this.contentHandle = rebuilt.content;
      this.luaHandle = rebuilt.lua;
      this.bootstrapIndex = bootstrap;
      this.bootstrapThroughLocalSeq = sequence;
      this.searchBackend = new CombinedTitleIndex(rebuilt.title.index, bootstrap);
      this.mutableState.readiness = {
        title: retainReady(this.mutableState.readiness.title),
        content: retainReady(this.mutableState.readiness.content),
        lua: retainReady(this.mutableState.readiness.lua),
        css: this.mutableState.readiness.css,
      };
      this.mutableState.namespaces = bootstrap.namespaceSummary();
      this.mutableState.throughLocalSeq = Math.max(
        rebuilt.title.throughLocalSeq,
        rebuilt.content.throughLocalSeq,
        rebuilt.lua.throughLocalSeq,
        sequence,
      );
      await this.cssIndex?.refresh(this.database, true);
      this.updateCounts();
      await this.refreshSnapshotStatus();
      this.resultsChanged(this.cssIndex ? ['title', 'content', 'lua', 'css'] : ['title', 'content', 'lua']);
      return rebuilt.warnings;
    })();
    const tracked = attempt.finally(() => {
      if (this.rebuildPromise === tracked) this.rebuildPromise = undefined;
    });
    this.rebuildPromise = tracked;
    return tracked;
  }

  async refreshSnapshotStatus(): Promise<void> {
    this.patchState({ snapshots: this.indexCache.getObservedStatus(this.mutableState.throughLocalSeq) });
  }

  searchTitles(query: string, namespace?: number): TitleSearchResult[] {
    return this.searchBackend?.search(query, namespace) ?? [];
  }

  searchContent(query: string, namespace?: number): ContentSearchResult[] {
    return this.contentHandle?.index.search(query, namespace) ?? [];
  }

  searchLua(query: string): LuaModuleSearchResult[] {
    return this.luaHandle?.index.search(query) ?? [];
  }

  searchCss(query: string): CssSearchResult[] {
    return this.cssIndex?.search(query) ?? [];
  }

  hasLoadedContentIndex(): boolean {
    return Boolean(this.contentHandle || this.luaHandle || this.cssIndex);
  }

  private async prepareLocalTitle(): Promise<void> {
    await this.initialize();
    const installGeneration = this.installGeneration;
    if (!this.titleHandle) {
      this.status('正在按需加载分词引擎与标题索引…');
      const loadedAnalyzer = await this.analyzerPreparation.prepare();
      const restored = await this.indexCache.restoreOrRebuild(
        'title',
        loadedAnalyzer.analyzer,
      );
      if (installGeneration === this.installGeneration || !this.titleHandle) {
        this.titleHandle = restored;
        this.searchBackend = new CombinedTitleIndex(
          restored.index,
          this.bootstrapIndex!,
        );
        this.resultsChanged(['title']);
      }
    }
    this.setReadiness('title', 'local');
    this.updateCounts();
    await this.refreshSnapshotStatus();
  }

  private async prepareLocalDerived(kind: 'content' | 'lua'): Promise<void> {
    await this.titlePreparation.prepareLocal();
    const installGeneration = this.installGeneration;
    await this.options.waitUntilVisible();
    const analyzer = this.analyzerResult?.analyzer;
    if (!analyzer || this.analyzerResult?.engine === 'bootstrap') {
      throw new Error('增强分词引擎尚未就绪');
    }
    if (kind === 'content' && !this.contentHandle) {
      this.status('正在按需恢复正文索引…');
      const restored = await this.indexCache.restoreOrRebuild('content', analyzer);
      if (installGeneration === this.installGeneration || !this.contentHandle) {
        this.contentHandle = restored;
        this.resultsChanged(['content']);
      }
    }
    if (kind === 'lua' && !this.luaHandle) {
      this.status('正在按需恢复 Lua 索引…');
      const restored = await this.indexCache.restoreOrRebuild('lua', analyzer);
      if (installGeneration === this.installGeneration || !this.luaHandle) {
        this.luaHandle = restored;
        this.resultsChanged(['lua']);
      }
    }
    this.setReadiness(kind, 'local');
    this.updateCounts();
    this.emitState();
  }

  private async settleTitle(): Promise<void> {
    this.status('正在同步标题…');
    const snapshotWarning = await this.synchronizePreparedTitles(false);
    this.setReadiness('title', 'ready');
    if (snapshotWarning) return;
    const count = this.mutableState.indexedPages;
    if (this.analyzerResult?.warning) {
      this.status(`jieba 加载失败，已用 Intl.Segmenter · ${count} 标题`, 'error');
    } else {
      this.status(`标题索引已就绪 · ${count} 标题 · 正文与 Lua 按模式加载`, 'success');
    }
  }

  private async settleDerived(kind: 'content' | 'lua'): Promise<void> {
    await this.titlePreparation.prepare();
    await this.synchronizeContent(false);
    this.setReadiness(kind, 'ready');
    const readyMs = this.elapsedMs();
    if (kind === 'content') this.mutableState.contentIndexReadyMs = readyMs;
    else this.mutableState.luaIndexReadyMs = readyMs;
    this.mutableState.contentReadyMs = Math.max(
      this.mutableState.contentIndexReadyMs ?? 0,
      this.mutableState.luaIndexReadyMs ?? 0,
    );
    await this.refreshSnapshotStatus();
  }

  private synchronizePreparedTitles(force: boolean): Promise<string | undefined> {
    if (this.titleSyncPromise) return this.titleSyncPromise;
    const handle = this.titleHandle;
    const analyzer = this.analyzerResult?.analyzer;
    if (!handle || !analyzer) return Promise.reject(new Error('增强标题索引尚未就绪'));

    const attempt = (async () => {
      let synchronizationError: unknown;
      try {
        await this.options.synchronizeTitles(force, analyzer, (pages) => {
          handle.index.update(pages);
          if (handle === this.titleHandle) {
            this.updateCounts();
            if (pages.length) this.resultsChanged(['title']);
          }
        });
      } catch (error) {
        synchronizationError = error;
      }
      try {
        await this.refresh();
      } catch (refreshError) {
        if (synchronizationError === undefined) throw refreshError;
      }
      if (synchronizationError !== undefined) throw synchronizationError;

      const current = this.titleHandle;
      let warning: string | undefined;
      if (current) {
        warning = snapshotPublishWarning(await this.indexCache.publish(current));
        if (warning) this.status(warning, 'error');
        else this.status(`标题同步完成 · ${this.mutableState.indexedPages} 页`, 'success');
      }
      await this.refreshSnapshotStatus();
      return warning;
    })();
    const tracked = attempt.finally(() => {
      if (this.titleSyncPromise === tracked) this.titleSyncPromise = undefined;
    });
    this.titleSyncPromise = tracked;
    return tracked;
  }

  private async performCssSynchronization(force: boolean): Promise<void> {
    let progress: ContentSyncProgress | undefined;
    let failure: unknown;
    try {
      progress = await this.options.synchronizeContent(force, 'css');
    } catch (error) { failure = error; }
    try {
      await this.queueRefresh(force);
    } catch (error) { failure ??= error; }
    if (failure) throw failure;
    this.updateCounts();
    this.status(`CSS 同步完成 · ${progress!.done}/${progress!.total} 页 · ${this.cssIndex?.size ?? 0} 份源码`, progress!.failed ? 'error' : 'success');
  }

  private async performContentSynchronization(force: boolean): Promise<void> {
    let progress: ContentSyncProgress | undefined;
    let synchronizationError: unknown;
    try {
      progress = await this.options.synchronizeContent(force);
    } catch (error) {
      synchronizationError = error;
    }

    try {
      await this.queueRefresh(false, synchronizationError === undefined && force);
    } catch (refreshError) {
      if (synchronizationError === undefined) throw refreshError;
    }
    if (synchronizationError !== undefined) throw synchronizationError;

    let warning: string | undefined;
    for (const handle of [this.contentHandle, this.luaHandle]) {
      if (!handle) continue;
      const replayed = await this.indexCache.refresh(handle);
      if (replayed && handle === (handle.kind === 'content' ? this.contentHandle : this.luaHandle)) this.resultsChanged([handle.kind]);
      warning ??= snapshotPublishWarning(await this.indexCache.publish(handle));
    }
    this.updateCounts();
    await this.refreshSnapshotStatus();
    const loaded = this.hasLoadedContentIndex()
      ? ` · ${this.mutableState.indexedContentPages} 正文 / ${this.mutableState.indexedLuaModules} Lua`
      : ' · 正文与 Lua 索引将在切换模式时按需恢复';
    this.status(
      warning ?? `正文同步完成 · ${progress!.done}/${progress!.total} 页${loaded}`,
      progress!.failed || warning ? 'error' : 'success',
    );
  }

  private handles(): PageSearchHandle[] {
    return [this.titleHandle, this.contentHandle, this.luaHandle].filter(
      (handle): handle is PageSearchHandle => handle !== undefined,
    );
  }

  private updateCounts(): void {
    this.mutableState.indexedPages = this.searchBackend?.size ?? 0;
    this.mutableState.indexedContentPages = this.contentHandle?.index.size ?? 0;
    this.mutableState.indexedLuaModules = this.luaHandle?.index.size ?? 0;
    this.mutableState.indexedCssSources = this.cssIndex?.size ?? 0;
    this.emitState();
  }

  private setReadiness(kind: PageSearchKind, readiness: PageSearchReadiness): void {
    this.mutableState.readiness = { ...this.mutableState.readiness, [kind]: readiness };
    this.emitState();
  }

  private patchState(patch: Partial<PageSearchRuntimeState>): void {
    this.mutableState = { ...this.mutableState, ...patch };
    this.emitState();
  }

  private emitState(): void {
    this.options.onStateChange?.(this.state);
  }

  private resultsChanged(kinds: readonly PageSearchKind[]): void {
    if (kinds.length) this.options.onResultsChanged?.(kinds);
  }

  private status(
    message: string,
    tone?: PageSearchRuntimeStatus['tone'],
  ): void {
    this.options.onStatus?.({ message, tone });
  }

  private elapsedMs(): number {
    return Math.max(0, Math.round(this.clock() - this.startedAt));
  }
}

function retainReady(readiness: PageSearchReadiness): PageSearchReadiness {
  return readiness === 'ready' ? 'ready' : 'local';
}

function snapshotPublishWarning(result: SnapshotPublishResult): string | undefined {
  if (result.status === 'published' || result.reason === 'not-newer') return undefined;
  if (result.reason === 'too-large') {
    return '索引快照超过 64 MiB，已跳过保存；当前搜索仍可正常使用';
  }
  if (result.reason === 'quota') {
    return '浏览器存储配额不足，索引快照未保存；当前搜索仍可正常使用';
  }
  if (result.reason === 'sequence-changed') {
    return '页面数据仍在更新，本次快照稍后重试；当前搜索仍可正常使用';
  }
  return '索引快照已被清理，本次不再保存；当前搜索仍可正常使用';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settle(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}
