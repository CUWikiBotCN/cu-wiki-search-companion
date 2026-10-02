// SPDX-License-Identifier: MPL-2.0
import { createApp, nextTick, reactive, shallowReactive, type App } from 'vue';
import SearchPanelView from './SearchPanelView.vue';
import styles from './search-panel.css?inline';
import { PanelGeometry } from './panel-geometry';
import { focusEditorElement } from '../editor';
import type { CssSearchResult } from '../search/css-source-index';
import type { NamespaceInfo, RedirectTarget } from '../types';
import type {
  ContentSearchResult,
} from '../search/content-index';
import type { DataCodeSearchResult } from '../search/data-code-index';
import type {
  LuaModuleSearchResult,
} from '../search/lua-module-index';
import type { TitleSearchResult } from '../search/title-index';
import type {
  HighlightPreferences,
} from '../storage/highlight-preference';
import { DEFAULT_HIGHLIGHT_PREFERENCES } from '../storage/highlight-preference';
import type {
  LocalDataDiagnostics,
  PersistenceRequestResult,
} from '../maintenance/local-data-maintenance';

import {
  canInsertResult,
  isDataCodeResult,
  type SearchMode,
  type SearchPanelResult,
  type SearchPreparationKind,
  type WikiPageSearchResult,
} from './search-panel-model';
export type { SearchMode, SearchPanelResult, SearchPreparationKind } from './search-panel-model';

export interface MaintenanceActionFeedback {
  message: string;
  tone?: 'normal' | 'error' | 'success';
}

export interface SearchPanelCallbacks {
  prepareSearch(kind: SearchPreparationKind): void;
  prepareFiles(): void;
  search(query: string, namespace?: number): TitleSearchResult[];
  searchFiles(query: string): TitleSearchResult[];
  searchLua(query: string): LuaModuleSearchResult[];
  searchCss(query: string): CssSearchResult[];
  searchContent(query: string, namespace?: number): ContentSearchResult[];
  searchCodes(query: string): DataCodeSearchResult[];
  insert(result: WikiPageSearchResult, query: string): void;
  copyTitle(result: WikiPageSearchResult): void;
  copy(result: WikiPageSearchResult, query: string): void;
  copyCode(result: DataCodeSearchResult): void;
  open(result: WikiPageSearchResult): void;
  openCode(result: DataCodeSearchResult): void;
  redirectUrl?(target: RedirectTarget): string;
  refresh(): void;
  refreshFiles(): void;
  saveDataCodeRules(source: string): Promise<void>;
  saveHighlightPreferences(preferences: HighlightPreferences): void;
  loadMaintenance?(): Promise<LocalDataDiagnostics>;
  rebuildSearchIndexes?(): Promise<void | MaintenanceActionFeedback>;
  rebuildContentQueue?(): Promise<void>;
  reconcileNow?(): Promise<void>;
  clearSnapshots?(): Promise<void>;
  requestPersistence?(): Promise<PersistenceRequestResult>;
  resetLocalMirror?(resetDataRules: boolean): Promise<void>;
}

export class SearchPanel {
  private static shortcutOwner?: WeakRef<SearchPanel>;
  private static shortcutWindow?: Window;
  private static readonly globalShortcutKeydown = (event: KeyboardEvent): void => {
    const owner = SearchPanel.shortcutOwner?.deref();
    if (!owner?.host.isConnected) {
      SearchPanel.shortcutOwner = undefined;
      return;
    }
    owner.handleGlobalShortcut(event);
  };

  readonly state = shallowReactive({
    visible: false,
    mode: 'title' as SearchMode,
    query: '',
    namespace: '',
    namespaces: [] as NamespaceInfo[],
    results: [] as SearchPanelResult[],
    selectedIndex: -1,
    insertMode: true,
    settingsOpen: false,
    dataRules: '',
    maintenanceOpen: false,
    maintenanceBusy: false,
    maintenanceOutput: '尚未读取诊断',
    dangerOpen: false,
    resetDataRules: false,
    status: '正在启动…',
    tone: 'normal' as 'normal' | 'error' | 'success',
    statusClipped: false,
    detailsOpen: false,
    reload: undefined as (() => void) | undefined,
    highlights: reactive({ ...DEFAULT_HIGHLIGHT_PREFERENCES }),
  });
  private readonly app: App;
  private readonly host: HTMLDivElement;
  private readonly root: ShadowRoot;
  private readonly panel: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly resultList: HTMLUListElement;
  private readonly toggle: HTMLButtonElement;
  private readonly geometry: PanelGeometry;
  private defaultDataRules = '';
  private composing = false;
  private startupFailed = false;
  private destroyed = false;
  private searchTimer?: number;
  private returnFocus?: HTMLElement;
  private disconnectObserver?: MutationObserver;

  constructor(private readonly callbacks: SearchPanelCallbacks) {
    this.host = document.createElement('div');
    this.host.id = 'cu-wiki-search-host';
    this.root = this.host.attachShadow({ mode: 'open' });
    document.documentElement.append(this.host);
    this.app = createApp(SearchPanelView, { state: this.state, actions: this.actions });
    this.app.mount(this.root);
    const style = document.createElement('style');
    style.textContent = styles;
    this.root.prepend(style);
    this.panel = this.requireElement('.panel');
    this.input = this.requireElement('.query');
    this.resultList = this.requireElement('.results');
    this.toggle = this.requireElement('.toggle');
    SearchPanel.claimGlobalShortcut(this);
    this.geometry = new PanelGeometry(
      this.host, this.panel, this.requireElement('.panel-body'),
      this.requireElement('.drag-handle'), () => this.syncStatusPresentation(),
    );
    if (typeof MutationObserver === 'function') {
      this.disconnectObserver = new MutationObserver(() => {
        if (!this.host.isConnected) this.destroy();
      });
      this.disconnectObserver.observe(document.documentElement, { childList: true });
    }
    this.applyHighlightColors();
  }

  setStatus(message: string, tone: 'normal' | 'error' | 'success' = 'normal'): void {
    if (this.destroyed) return;
    this.state.status = message;
    this.state.tone = tone;
    this.geometry.scheduleLayoutUpdate();
  }

  setNamespaces(namespaces: NamespaceInfo[]): void {
    this.state.namespaces = [...namespaces].sort((left, right) => left.id - right.id);
    if (!namespaces.some((namespace) => String(namespace.id) === this.state.namespace)) {
      this.state.namespace = '';
    }
  }

  setInsertMode(enabled: boolean): void {
    if (!enabled && this.root.activeElement?.matches('.insert-result')) this.input.focus();
    this.state.insertMode = enabled;
  }

  setDataCodeRules(source: string, defaultSource: string): void {
    this.state.dataRules = source;
    this.defaultDataRules = defaultSource;
  }

  setHighlightPreferences(preferences: HighlightPreferences): void {
    Object.assign(this.state.highlights, preferences);
    this.applyHighlightColors();
  }

  setStartupFailure(message: string, reload: () => void): void {
    this.startupFailed = true;
    this.setStatus(`本地搜索启动失败：${message}。可重新加载页面重试。`, 'error');
    this.state.reload = reload;
  }

  open(returnFocus?: HTMLElement): void {
    if (this.destroyed) return;
    if (!this.state.visible) this.returnFocus = returnFocus ?? this.currentReturnFocus();
    if (!this.startupFailed) this.prepareCurrentMode();
    this.state.visible = true;
    this.geometry.scheduleLayoutUpdate();
    // Vue batches visibility updates; focus only after the dialog is actually shown.
    void nextTick(() => {
      if (!this.host.isConnected || !this.state.visible) return;
      this.input.focus();
      this.input.select();
    });
  }

  close(): void {
    if (!this.state.visible) return;
    this.geometry.finishDrag(false);
    this.state.visible = false;
    const returnFocus = this.returnFocus;
    this.returnFocus = undefined;
    if (returnFocus?.isConnected && !returnFocus.matches(':disabled')) {
      focusEditorElement(returnFocus);
    } else {
      this.toggle.focus();
    }
  }

  refreshResults(): void {
    if (!this.destroyed) this.performSearch();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.close();
    this.destroyed = true;
    if (this.searchTimer !== undefined) window.clearTimeout(this.searchTimer);
    this.disconnectObserver?.disconnect();
    this.geometry.destroy();
    if (SearchPanel.shortcutOwner?.deref() === this) {
      SearchPanel.shortcutWindow?.removeEventListener('keydown', SearchPanel.globalShortcutKeydown);
      SearchPanel.shortcutOwner = undefined;
      SearchPanel.shortcutWindow = undefined;
    }
    this.app.unmount();
    this.host.remove();
  }

  readonly actions = {
    toggle: () => this.state.visible ? this.close() : this.open(this.toggle),
    close: () => this.close(),
    refresh: () => {
      if (!this.startupFailed) {
        if (this.state.mode === 'files') this.callbacks.refreshFiles();
        else this.callbacks.refresh();
      }
    },
    configure: () => {
      this.state.settingsOpen = !this.state.settingsOpen;
      void nextTick(() => {
        if (this.state.settingsOpen && this.host.isConnected) {
          this.requireElement<HTMLTextAreaElement>('.data-rules').focus();
        }
      });
    },
    maintenance: () => {
      this.state.maintenanceOpen = !this.state.maintenanceOpen;
      this.state.settingsOpen = false;
      if (this.state.maintenanceOpen) {
        this.geometry.scheduleBodyScroll(this.requireElement('.maintenance'), 'start');
        void this.loadMaintenance();
      }
    },
    details: () => {
      this.state.detailsOpen = !this.state.detailsOpen;
      if (this.state.detailsOpen) this.geometry.scheduleBodyScroll(this.requireElement('.status-details'), 'nearest');
    },
    resetPosition: () => this.geometry.resetPosition(),
    saveRules: () => this.saveDataRules(this.state.dataRules),
    resetRules: () => {
      this.state.dataRules = this.defaultDataRules;
      return this.saveDataRules(this.defaultDataRules);
    },
    highlights: () => this.persistHighlightPreferences(),
    colors: () => this.applyHighlightColors(),
    rebuildIndexes: () => this.runMaintenanceAction('正在从本地页面重建搜索索引…', () => this.callbacks.rebuildSearchIndexes?.()),
    rebuildQueue: () => this.runMaintenanceAction('正在修复正文队列…', () => this.callbacks.rebuildContentQueue?.()),
    reconcile: () => this.runMaintenanceAction('正在进行联网全量对账…', () => this.callbacks.reconcileNow?.()),
    clearSnapshots: () => this.runMaintenanceAction('正在清除索引快照…', () => this.callbacks.clearSnapshots?.()),
    persistence: () => this.runMaintenanceAction('正在申请浏览器持久保存…', async () => {
      const request = this.callbacks.requestPersistence?.();
      if (!request) throw new Error('持久保存操作当前不可用');
      await this.finishPersistenceRequest(request);
    }, false),
    resetLocal: () => this.runMaintenanceAction('正在清空本地镜像…', () => this.callbacks.resetLocalMirror?.(this.state.resetDataRules)),
    compositionStart: () => { this.composing = true; },
    compositionEnd: (event: CompositionEvent) => {
      this.composing = false;
      if (event.target === this.input) this.scheduleSearch(0);
    },
    input: () => { if (!this.composing) this.scheduleSearch(120); },
    search: () => this.performSearch(),
    mode: () => {
      if (!this.startupFailed) this.prepareCurrentMode();
      if (this.state.mode !== 'data-code') this.state.settingsOpen = false;
      this.performSearch();
    },
    keydown: (event: KeyboardEvent) => this.handleKeydown(event),
    select: (index: number) => { this.state.selectedIndex = index; this.updateSelection(); },
    copy: (result: SearchPanelResult) => this.copyResult(result),
    redirectUrl: (target: RedirectTarget) => this.callbacks.redirectUrl?.(target),
    open: (result: SearchPanelResult) => this.openResult(result),
    copyLink: (result: SearchPanelResult) => {
      if (canInsertResult(result)) this.callbacks.copy(result, this.input.value);
    },
    insert: (result: SearchPanelResult) => this.insert(result),
  };

  private static claimGlobalShortcut(panel: SearchPanel): void {
    if (SearchPanel.shortcutWindow !== window) {
      SearchPanel.shortcutWindow?.removeEventListener(
        'keydown',
        SearchPanel.globalShortcutKeydown,
      );
      window.addEventListener('keydown', SearchPanel.globalShortcutKeydown);
      SearchPanel.shortcutWindow = window;
    }
    SearchPanel.shortcutOwner = new WeakRef(panel);
  }

  private scheduleSearch(delay: number): void {
    if (this.searchTimer !== undefined) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => this.performSearch(), delay);
  }

  private prepareCurrentMode(): void {
    const mode = this.state.mode;
    switch (mode) {
      case 'files': this.callbacks.prepareFiles(); return;
      case 'data-code': return;
      case 'title':
      case 'content':
      case 'lua':
      case 'css': this.callbacks.prepareSearch(mode); return;
      default: return unreachableMode(mode);
    }
  }

  private performSearch(): void {
    if (this.destroyed) return;
    if (this.resultList.contains(this.root.activeElement)) this.input.focus();
    const query = this.input.value;
    this.state.query = query;
    const namespace = this.state.namespace ? Number(this.state.namespace) : undefined;
    const mode = this.state.mode;
    switch (mode) {
      case 'title': this.state.results = this.callbacks.search(query, namespace); break;
      case 'content': this.state.results = this.callbacks.searchContent(query, namespace); break;
      case 'data-code': this.state.results = this.callbacks.searchCodes(query); break;
      case 'lua': this.state.results = this.callbacks.searchLua(query); break;
      case 'css': this.state.results = this.callbacks.searchCss(query); break;
      case 'files': this.state.results = this.callbacks.searchFiles(query); break;
      default: return unreachableMode(mode);
    }
    this.state.selectedIndex = this.state.results.length ? 0 : -1;
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (!this.state.visible || this.composing || event.isComposing) return;
    if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      this.cycleFocus(event);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (this.geometry.finishDrag(true)) return;
      this.close();
      return;
    }
    const primary = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>('.result-primary')
      : null;
    if (event.key === 'Enter' && (event.target === this.input || primary)) {
      event.preventDefault();
      event.stopPropagation();
      if (
        event.altKey || event.getModifierState('AltGraph') ||
        (event.ctrlKey && event.metaKey) ||
        (event.shiftKey && (event.ctrlKey || event.metaKey))
      ) return;
      const result = this.state.results[primary ? Number(primary.dataset.index) : this.state.selectedIndex];
      if (!result) return;
      if (event.ctrlKey || event.metaKey) this.openResult(result);
      else if (event.shiftKey) this.insert(result);
      else this.copyResult(result);
      return;
    }
    if (
      event.target !== this.input || event.altKey || event.ctrlKey ||
      event.metaKey || event.shiftKey
    ) return;
    if (!this.state.results.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      this.state.selectedIndex = (this.state.selectedIndex + 1) % this.state.results.length;
      this.updateSelection();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      this.state.selectedIndex = (this.state.selectedIndex - 1 + this.state.results.length) % this.state.results.length;
      this.updateSelection();
    }
  }

  private cycleFocus(event: KeyboardEvent): void {
    event.stopPropagation();
    const controls = [...this.panel.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [tabindex]',
    )].filter((element) =>
      element.tabIndex >= 0 && !element.matches(':disabled') &&
      !element.closest('[hidden], [inert]') && element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility === 'visible',
    );
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = this.root.activeElement;
    if (active === (event.shiftKey ? first : last) || !controls.some((element) => element === active)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  }

  private handleGlobalShortcut(event: KeyboardEvent): void {
    if (
      this.composing ||
      event.isComposing ||
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.getModifierState('AltGraph') ||
      event.key.toLocaleLowerCase() !== 'k'
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!this.state.visible) this.open();
    else this.close();
  }

  private copyResult(result: SearchPanelResult): void {
    if (isDataCodeResult(result)) this.callbacks.copyCode(result);
    else this.callbacks.copyTitle(result);
  }

  private openResult(result: SearchPanelResult): void {
    if (isDataCodeResult(result)) this.callbacks.openCode(result);
    else this.callbacks.open(result);
  }

  private insert(result: SearchPanelResult): void {
    if (!this.state.insertMode || !canInsertResult(result)) {
      this.setStatus('当前结果或编辑页不支持插入；可复制内容或打开来源。');
      return;
    }
    this.close();
    this.callbacks.insert(result, this.input.value);
  }

  private updateSelection(): void {
    void nextTick(() => {
      if (!this.host.isConnected || !this.state.visible) return;
      const selected = this.resultList.querySelector<HTMLElement>('[data-selected="true"]');
      if (selected) this.geometry.scrollBodyTo(selected, 'nearest');
    });
  }

  private syncStatusPresentation(): void {
    const status = this.requireElement<HTMLElement>('.status');
    const details = this.requireElement<HTMLElement>('.status-details');
    const clipped = status.scrollHeight > status.clientHeight + 1 || status.scrollWidth > status.clientWidth + 1;
    if (!clipped && (this.root.activeElement?.matches('.status-details-toggle') || details.contains(this.root.activeElement))) this.input.focus();
    this.state.statusClipped = clipped;
    if (!clipped) this.state.detailsOpen = false;
  }

  private currentReturnFocus(): HTMLElement {
    const active = this.root.activeElement ?? document.activeElement;
    if (
      active instanceof HTMLElement &&
      active !== document.body &&
      active !== document.documentElement &&
      !this.panel.contains(active)
    ) {
      return active;
    }
    return this.toggle;
  }

  private async saveDataRules(source: string): Promise<void> {
    try {
      this.setStatus('正在按配置刷新 Data 代码缓存…');
      await this.callbacks.saveDataCodeRules(source);
      if (this.destroyed) return;
      if (this.requireElement('.settings').contains(this.root.activeElement)) {
        this.requireElement<HTMLButtonElement>('.configure').focus();
      }
      this.state.settingsOpen = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(`Data 代码检索配置无效或刷新失败：${message}`, 'error');
    }
  }

  private applyHighlightColors(): void {
    this.host.style.setProperty('--cu-title-highlight', this.state.highlights.titleColor);
    this.host.style.setProperty(
      '--cu-title-highlight-color',
      contrastTextColor(this.state.highlights.titleColor),
    );
    this.host.style.setProperty(
      '--cu-content-highlight',
      this.state.highlights.contentColor,
    );
    this.host.style.setProperty(
      '--cu-content-highlight-color',
      contrastTextColor(this.state.highlights.contentColor),
    );
  }

  private persistHighlightPreferences(): void {
    this.callbacks.saveHighlightPreferences({ ...this.state.highlights });
  }

  private async runMaintenanceAction(
    progressMessage: string,
    action: () => Promise<void | MaintenanceActionFeedback> | undefined,
    announceCompletion = true,
  ): Promise<void> {
    if (this.state.maintenanceBusy) return;
    this.state.maintenanceBusy = true;
    if (this.root.activeElement?.matches('.maintenance-action')) {
      this.requireElement<HTMLButtonElement>('.maintenance-toggle').focus();
    }
    this.setStatus(progressMessage);
    try {
      const request = action();
      if (!request) throw new Error('维护操作当前不可用');
      const feedback = await request;
      if (announceCompletion) {
        this.setStatus(
          feedback?.message ?? '本地维护操作完成',
          feedback?.tone ?? 'success',
        );
      }
      await this.loadMaintenance();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = `本地维护操作失败：${message}`;
      this.state.maintenanceOutput = failure;
      this.setStatus(failure, 'error');
    } finally {
      this.state.maintenanceBusy = false;
    }
  }

  private async loadMaintenance(): Promise<void> {
    if (this.destroyed) return;
    if (!this.callbacks.loadMaintenance) {
      this.state.maintenanceOutput = '维护诊断尚未接入';
      return;
    }
    this.state.maintenanceOutput = '正在读取本地诊断…';
    try {
      const diagnostics = await this.callbacks.loadMaintenance();
      this.state.maintenanceOutput = formatDiagnostics(diagnostics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.maintenanceOutput = `诊断读取失败：${message}`;
    }
  }

  private async finishPersistenceRequest(
    request: Promise<PersistenceRequestResult>,
  ): Promise<void> {
    const result = await request;
    if (result.status === 'granted') {
      this.setStatus('浏览器已允许持久保存本地镜像', 'success');
    } else if (result.status === 'denied') {
      this.setStatus('浏览器未授予持久保存；搜索与维护仍可正常使用', 'error');
    } else if (result.status === 'unsupported') {
      this.setStatus('当前浏览器不支持申请持久保存；其余功能不受影响', 'error');
    } else {
      this.setStatus(`申请持久保存失败：${result.message}`, 'error');
    }
    await this.loadMaintenance();
  }

  private requireElement<T extends Element>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Search panel is missing ${selector}`);
    return element;
  }
}

function unreachableMode(mode: never): never {
  throw new Error(`Unknown search mode: ${mode}`);
}

function formatDiagnostics(diagnostics: LocalDataDiagnostics): string {
  const snapshotLabels = diagnostics.snapshots
    .map(
      (snapshot) =>
        `${snapshot.kind}: ${snapshot.status}` +
        (snapshot.payloadBytes === undefined
          ? ''
          : ` / ${formatBytes(snapshot.payloadBytes)} / seq ${snapshot.throughLocalSeq ?? 0}`) +
        (snapshot.restoreMs === undefined ? '' : ` / 恢复 ${Math.round(snapshot.restoreMs)}ms`),
    )
    .join('\n');
  const storage = diagnostics.storage;
  return [
    `页面 ${diagnostics.counts.pages} · 文件 ${diagnostics.counts.files} · Data 代码 ${diagnostics.counts.dataCodes}`,
    `正文源 ${diagnostics.counts.contentSources} · Lua 源 ${diagnostics.counts.luaSources} · CSS 源 ${diagnostics.counts.cssSources ?? 0}`,
    `CSS 队列 done ${diagnostics.cssJobs?.done ?? 0} / pending ${diagnostics.cssJobs?.pending ?? 0} / running ${diagnostics.cssJobs?.running ?? 0} / failed ${diagnostics.cssJobs?.failed ?? 0}`,
    `正文队列 done ${diagnostics.jobs.done} / pending ${diagnostics.jobs.pending} / running ${diagnostics.jobs.running} / failed ${diagnostics.jobs.failed}`,
    `RC ${diagnostics.recentChanges?.through ?? '未完成'} · 全量对账 ${diagnostics.reconciliation?.status ?? '未开始'}`,
    `事实版本 ${diagnostics.versionContract ? `schema ${diagnostics.versionContract.databaseSchema} / pages ${diagnostics.versionContract.pageFacts}` : '未登记'}`,
    snapshotLabels,
    `IndexedDB ${formatBytes(storage.usage)} / ${formatBytes(storage.quota)} · 持久化 ${storage.persisted === true ? '已授予' : storage.persisted === false ? '未授予' : '未知'}`,
  ].join('\n');
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) return '未知';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function contrastTextColor(hex: string): '#000' | '#fff' {
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  const luminance = rgb
    .map((value) => value / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
    .reduce(
      (sum, value, index) => sum + value * ([0.2126, 0.7152, 0.0722][index] ?? 0),
      0,
    );
  return luminance > 0.179 ? '#000' : '#fff';
}
