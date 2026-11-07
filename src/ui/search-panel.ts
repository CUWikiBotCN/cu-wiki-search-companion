// SPDX-License-Identifier: MPL-2.0
import { parseSectionQuery } from '../search/section-query';
import type { SectionSearchResult } from '../search/section-title-index';
import type {
  SectionSearchIntent,
  SectionSearchRuntime,
} from '../runtime/section-search-runtime';
import { createApp, nextTick, reactive, shallowReactive, type App } from 'vue';
import SearchPanelView from './SearchPanelView.vue';
import styles from './search-panel.css?inline';
import { PanelGeometry } from './panel-geometry';
import { focusEditorElement, captureEditorSelection } from '../editor';
import type { CssSearchResult } from '../search/css-source-index';
import type { NamespaceInfo, RedirectTarget } from '../types';
import type { ContentSearchResult } from '../search/content-index';
import type { DataCodeSearchResult } from '../search/data-code-index';
import type { LuaModuleSearchResult } from '../search/lua-module-index';
import type { TitleSearchResult } from '../search/title-index';
import type { HighlightPreferences } from '../storage/highlight-preference';
import { DEFAULT_HIGHLIGHT_PREFERENCES } from '../storage/highlight-preference';
import type {
  LocalDataDiagnostics,
  PersistenceRequestResult,
} from '../maintenance/local-data-maintenance';

import {
  SEARCH_MODES,
  canInsertResult,
  isDataCodeResult,
  isSectionResult,
  searchResultIdentity,
  type SearchMode,
  type SearchPanelResult,
  type SearchPreparationKind,
  type WikiPageSearchResult,
} from './search-panel-model';
export type {
  SearchMode,
  SearchPanelResult,
  SearchPreparationKind,
} from './search-panel-model';

export interface MaintenanceActionFeedback {
  message: string;
  tone?: 'normal' | 'error' | 'success';
}

export interface SearchPanelCallbacks {
  prepareSearch(kind: SearchPreparationKind): void;
  prepareFiles(): void;
  search(query: string, namespace?: number): TitleSearchResult[];
  sectionIntent?(intent: SectionSearchIntent): void;
  searchSections?(
    query: string,
    namespace?: number,
    pageId?: number,
  ): SectionSearchResult[];
  sectionInfo?(
    query: string,
    namespace?: number,
    pageId?: number,
  ): ReturnType<SectionSearchRuntime['describe']> | undefined;
  fetchSectionPage?(pageId?: number): Promise<void>;
  resolveSection?(
    result: SectionSearchResult,
  ): Promise<SectionSearchResult | void>;
  prefetchSectionLinks?(
    results: SectionSearchResult[],
    preferred?: SectionSearchResult,
  ): void;
  sectionCurrent?(result: SectionSearchResult): boolean;
  openSectionPage?(result: SectionSearchResult): void;
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

type SectionAction = 'copyTitle' | 'copyLink' | 'open' | 'insert';

export class SearchPanel {
  private static shortcutOwner?: WeakRef<SearchPanel>;
  private static shortcutWindow?: Window;
  private static readonly globalShortcutKeydown = (
    event: KeyboardEvent,
  ): void => {
    const owner = SearchPanel.shortcutOwner?.deref();
    if (!owner?.host.isConnected) {
      SearchPanel.shortcutOwner = undefined;
      return;
    }
    owner.handleGlobalShortcut(event);
    if (owner.state.visible && event.composedPath().includes(owner.panel))
      owner.handleKeydown(event);
  };

  readonly state = shallowReactive({
    visible: false,
    mode: 'title' as SearchMode,
    query: '',
    includeSections: false,
    sectionPageId: undefined as number | undefined,
    sectionPageTitle: '',
    sectionPageNamespace: undefined as number | undefined,
    sectionInfo: undefined as
      ReturnType<SectionSearchRuntime['describe']> | undefined,
    resolvingSections: [] as string[],
    failedSections: [] as string[],
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
  private readonly dirtyModes = new Set<SearchMode>(
    Object.keys(SEARCH_MODES) as SearchMode[],
  );
  private lastSearch?: {
    query: string;
    mode: SearchMode;
    namespace: string;
    includeSections: boolean;
    pageId?: number;
  };
  private returnFocus?: HTMLElement;
  private disconnectObserver?: MutationObserver;
  private pendingAction?: {
    key: string;
    action: SectionAction;
    cancel(): void;
  };
  private readonly failedActions = new Map<string, SectionAction>();

  constructor(private readonly callbacks: SearchPanelCallbacks) {
    this.host = document.createElement('div');
    this.host.id = 'cu-wiki-search-host';
    this.root = this.host.attachShadow({ mode: 'open' });
    document.documentElement.append(this.host);
    this.app = createApp(SearchPanelView, {
      state: this.state,
      actions: this.actions,
    });
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
      this.host,
      this.panel,
      this.toggle,
      this.requireElement('.panel-body'),
      this.requireElement('.drag-handle'),
      () => this.syncStatusPresentation(),
    );
    if (typeof MutationObserver === 'function') {
      this.disconnectObserver = new MutationObserver(() => {
        if (!this.host.isConnected) this.destroy();
      });
      this.disconnectObserver.observe(document.documentElement, {
        childList: true,
      });
    }
    this.applyHighlightColors();
  }

  setStatus(
    message: string,
    tone: 'normal' | 'error' | 'success' = 'normal',
  ): void {
    if (this.destroyed) return;
    this.state.status = message;
    this.state.tone = tone;
    this.geometry.scheduleLayoutUpdate();
  }

  setNamespaces(namespaces: NamespaceInfo[]): void {
    if (this.destroyed) return;
    const sorted = [...namespaces].sort((left, right) => left.id - right.id);
    if (
      !sorted.every(
        (namespace, index) =>
          namespace.id === this.state.namespaces[index]?.id &&
          namespace.name === this.state.namespaces[index]?.name,
      ) ||
      sorted.length !== this.state.namespaces.length
    )
      this.state.namespaces = sorted;
    if (
      this.state.namespace &&
      !namespaces.some(
        (namespace) => String(namespace.id) === this.state.namespace,
      )
    ) {
      this.state.namespace = '';
      if (this.state.mode === 'title' || this.state.mode === 'content')
        this.invalidateResults([this.state.mode]);
    }
  }

  setInsertMode(enabled: boolean): void {
    if (!enabled && this.root.activeElement?.matches('.insert-result'))
      this.input.focus();
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
    this.setStatus(
      `本地搜索启动失败：${message}。可重新加载页面重试。`,
      'error',
    );
    this.state.reload = reload;
  }

  open(returnFocus?: HTMLElement): void {
    if (this.destroyed) return;
    if (!this.state.visible)
      this.returnFocus = returnFocus ?? this.currentReturnFocus();
    this.state.visible = true;
    this.syncSectionScope();
    if (!this.startupFailed) this.prepareCurrentMode();
    if (this.dirtyModes.has(this.state.mode) || !this.sameSearchConditions())
      this.performSearch();
    this.geometry.scheduleLayoutUpdate();
    // Vue batches visibility updates; focus only after the dialog is actually shown.
    void nextTick(() => {
      if (!this.host.isConnected || !this.state.visible) return;
      this.input.focus();
      this.input.select();
    });
  }

  close(): void {
    this.cancelSectionAction();
    this.cancelSearch();
    if (!this.state.visible) return;
    this.geometry.finishDrag(false);
    this.state.visible = false;
    this.callbacks.sectionIntent?.({ active: false, query: this.state.query });
    // Reveal the expanded-state-hidden launcher before synchronous focus return.
    this.toggle.setAttribute('aria-expanded', 'false');
    const returnFocus = this.returnFocus;
    this.returnFocus = undefined;
    if (returnFocus?.isConnected && !returnFocus.matches(':disabled')) {
      focusEditorElement(returnFocus);
    } else {
      this.toggle.focus();
    }
  }

  refreshResults(): void {
    if (this.destroyed) return;
    this.dirtyModes.add(this.state.mode);
    this.performSearch();
  }

  invalidateResults(modes: readonly SearchMode[]): void {
    if (this.destroyed) return;
    for (const mode of modes) this.dirtyModes.add(mode);
    if (
      this.dirtyModes.has(this.state.mode) &&
      this.state.visible &&
      !this.composing &&
      this.searchTimer === undefined
    ) {
      this.scheduleSearch(0);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.close();
    this.destroyed = true;
    this.cancelSearch();
    this.disconnectObserver?.disconnect();
    this.geometry.destroy();
    if (SearchPanel.shortcutOwner?.deref() === this) {
      SearchPanel.shortcutWindow?.removeEventListener(
        'keydown',
        SearchPanel.globalShortcutKeydown,
        true,
      );
      SearchPanel.shortcutOwner = undefined;
      SearchPanel.shortcutWindow = undefined;
    }
    this.app.unmount();
    this.host.remove();
  }

  readonly actions = {
    toggle: () => (this.state.visible ? this.close() : this.open(this.toggle)),
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
        this.geometry.scheduleBodyScroll(
          this.requireElement('.maintenance'),
          'start',
        );
        void this.loadMaintenance();
      }
    },
    details: () => {
      this.state.detailsOpen = !this.state.detailsOpen;
      if (this.state.detailsOpen)
        this.geometry.scheduleBodyScroll(
          this.requireElement('.status-details'),
          'nearest',
        );
    },
    resetPosition: () => this.geometry.resetPosition(),
    saveRules: () => this.saveDataRules(this.state.dataRules),
    resetRules: () => {
      this.state.dataRules = this.defaultDataRules;
      return this.saveDataRules(this.defaultDataRules);
    },
    highlights: () => this.persistHighlightPreferences(),
    colors: () => this.applyHighlightColors(),
    rebuildIndexes: () =>
      this.runMaintenanceAction('正在从本地页面重建搜索索引…', () =>
        this.callbacks.rebuildSearchIndexes?.(),
      ),
    rebuildQueue: () =>
      this.runMaintenanceAction('正在修复正文队列…', () =>
        this.callbacks.rebuildContentQueue?.(),
      ),
    reconcile: () =>
      this.runMaintenanceAction('正在进行联网全量对账…', () =>
        this.callbacks.reconcileNow?.(),
      ),
    clearSnapshots: () =>
      this.runMaintenanceAction('正在清除索引快照…', () =>
        this.callbacks.clearSnapshots?.(),
      ),
    persistence: () =>
      this.runMaintenanceAction(
        '正在申请浏览器持久保存…',
        async () => {
          const request = this.callbacks.requestPersistence?.();
          if (!request) throw new Error('持久保存操作当前不可用');
          await this.finishPersistenceRequest(request);
        },
        false,
      ),
    resetLocal: () =>
      this.runMaintenanceAction('正在清空本地镜像…', () =>
        this.callbacks.resetLocalMirror?.(this.state.resetDataRules),
      ),
    compositionStart: () => {
      this.cancelSectionAction();
      this.composing = true;
      this.cancelSearch();
    },
    compositionEnd: (event: CompositionEvent) => {
      this.composing = false;
      if (
        event.target === this.input ||
        this.dirtyModes.has(this.state.mode) ||
        !this.sameSearchConditions()
      )
        this.scheduleSearch(0);
    },
    input: () => {
      this.cancelSectionAction();
      if (!this.composing) this.syncSectionScope();
      this.dirtyModes.add(this.state.mode);
      if (!this.composing) this.scheduleSearch(120);
    },
    search: () => {
      this.cancelSectionAction();
      this.refreshResults();
    },
    showSections: (result: SearchPanelResult) => {
      this.cancelSectionAction();
      if (this.state.mode !== 'title') return;
      if ('kind' in result) {
        if (result.kind !== 'section') return;
      } else if (result.isRedirect) return;
      this.state.sectionPageId = result.id;
      this.state.sectionPageNamespace = result.namespace;
      this.state.sectionPageTitle = result.title;
      this.state.query = `${result.title}#`;
      this.input.value = this.state.query;
      this.refreshResults();
      this.input.focus();
      this.input.setSelectionRange(
        this.input.value.length,
        this.input.value.length,
      );
    },
    fetchSectionPage: (pageId?: number) => {
      void this.callbacks.fetchSectionPage?.(pageId);
    },
    retrySection: (result: SectionSearchResult) => {
      this.runResultAction(
        result,
        this.failedActions.get(searchResultIdentity('title', result)) ??
          'copyTitle',
      );
    },
    openSectionPage: (result: SectionSearchResult) => {
      this.cancelSectionAction();
      this.callbacks.openSectionPage?.(result);
    },
    mode: () => {
      this.cancelSectionAction();
      if (!this.startupFailed) this.prepareCurrentMode();
      if (this.state.mode !== 'data-code') this.state.settingsOpen = false;
      this.refreshResults();
    },
    keydown: (event: KeyboardEvent) => this.handleKeydown(event),
    select: (index: number) => {
      if (index !== this.state.selectedIndex) this.cancelSectionAction();
      this.state.selectedIndex = index;
      this.updateSelection();
    },
    copy: (result: SearchPanelResult) => this.copyResult(result),
    redirectUrl: (target: RedirectTarget) =>
      this.callbacks.redirectUrl?.(target),
    open: (result: SearchPanelResult) => this.openResult(result),
    copyLink: (result: SearchPanelResult) => {
      if (canInsertResult(result)) this.runResultAction(result, 'copyLink');
    },
    insert: (result: SearchPanelResult) => this.insert(result),
  };

  private static claimGlobalShortcut(panel: SearchPanel): void {
    if (SearchPanel.shortcutWindow !== window) {
      SearchPanel.shortcutWindow?.removeEventListener(
        'keydown',
        SearchPanel.globalShortcutKeydown,
        true,
      );
      window.addEventListener(
        'keydown',
        SearchPanel.globalShortcutKeydown,
        true,
      );
      SearchPanel.shortcutWindow = window;
    }
    SearchPanel.shortcutOwner = new WeakRef(panel);
  }

  private scheduleSearch(delay: number): void {
    this.dirtyModes.add(this.state.mode);
    this.cancelSearch();
    if (this.destroyed || !this.state.visible || this.composing) return;
    this.searchTimer = window.setTimeout(() => {
      this.searchTimer = undefined;
      this.performSearch();
    }, delay);
  }

  private cancelSearch(): void {
    if (this.searchTimer !== undefined) window.clearTimeout(this.searchTimer);
    this.searchTimer = undefined;
  }

  private sameSearchConditions(): boolean {
    return (
      this.lastSearch?.query === this.input.value &&
      this.lastSearch.mode === this.state.mode &&
      this.lastSearch.namespace === this.searchNamespace() &&
      this.lastSearch.includeSections === this.state.includeSections &&
      this.lastSearch.pageId === this.state.sectionPageId
    );
  }

  private searchNamespace(): string {
    return this.state.mode === 'title' || this.state.mode === 'content'
      ? this.state.namespace
      : '';
  }

  private prepareCurrentMode(): void {
    const mode = this.state.mode;
    switch (mode) {
      case 'files':
        this.callbacks.prepareFiles();
        return;
      case 'data-code':
        return;
      case 'title':
      case 'content':
      case 'lua':
      case 'css':
        this.callbacks.prepareSearch(mode);
        return;
      default:
        return unreachableMode(mode);
    }
  }

  private performSearch(): void {
    this.cancelSearch();
    if (this.destroyed || !this.state.visible || this.composing) return;
    this.syncSectionScope();
    const selected = this.sameSearchConditions()
      ? this.state.results[this.state.selectedIndex]
      : undefined;
    const identity = selected
      ? searchResultIdentity(this.state.mode, selected)
      : undefined;
    const focused = this.root.activeElement;
    const query = this.input.value;
    this.state.query = query;
    const namespace = this.state.namespace
      ? Number(this.state.namespace)
      : undefined;
    const mode = this.state.mode;
    switch (mode) {
      case 'title': {
        const pages = this.state.includeSections
          ? []
          : this.callbacks.search(query, namespace);
        const sections = this.state.includeSections
          ? (this.callbacks.searchSections?.(
              query,
              namespace,
              this.state.sectionPageId,
            ) ?? [])
          : [];
        this.state.results = [...pages, ...sections];
        this.state.sectionInfo = this.state.includeSections
          ? this.callbacks.sectionInfo?.(
              query,
              namespace,
              this.state.sectionPageId,
            )
          : undefined;
        break;
      }
      case 'content':
        this.state.results = this.callbacks.searchContent(query, namespace);
        break;
      case 'data-code':
        this.state.results = this.callbacks.searchCodes(query);
        break;
      case 'lua':
        this.state.results = this.callbacks.searchLua(query);
        break;
      case 'css':
        this.state.results = this.callbacks.searchCss(query);
        break;
      case 'files':
        this.state.results = this.callbacks.searchFiles(query);
        break;
      default:
        return unreachableMode(mode);
    }
    const retained =
      identity === undefined
        ? -1
        : this.state.results.findIndex(
            (result) => searchResultIdentity(mode, result) === identity,
          );
    this.state.selectedIndex =
      retained >= 0 ? retained : this.state.results.length ? 0 : -1;
    this.lastSearch = {
      query,
      mode,
      namespace: this.searchNamespace(),
      includeSections: this.state.includeSections,
      pageId: this.state.sectionPageId,
    };
    this.dirtyModes.delete(mode);
    const liveKeys = new Set(
      this.state.results.map((result) => searchResultIdentity(mode, result)),
    );
    if (this.pendingAction && !liveKeys.has(this.pendingAction.key))
      this.cancelSectionAction();
    for (const key of this.failedActions.keys())
      if (!liveKeys.has(key)) this.failedActions.delete(key);
    for (const result of this.state.results) {
      if (
        isSectionResult(result) &&
        !result.needsResolution &&
        result.fragment &&
        (this.callbacks.sectionCurrent?.(result) ?? true)
      )
        this.failedActions.delete(searchResultIdentity(mode, result));
    }
    this.state.failedSections = [...this.failedActions.keys()];
    if (mode === 'title' && this.state.includeSections)
      this.callbacks.prefetchSectionLinks?.(
        this.state.results.filter(isSectionResult),
      );
    if (focused && this.resultList.contains(focused)) {
      let focusMoved = false;
      const observeFocus = (): void => {
        if (this.root.activeElement !== focused) focusMoved = true;
      };
      document.addEventListener('focusin', observeFocus, true);
      void nextTick(() => {
        document.removeEventListener('focusin', observeFocus, true);
        if (
          !this.destroyed &&
          this.state.visible &&
          !focused.isConnected &&
          !focusMoved &&
          !this.root.activeElement &&
          (!document.activeElement ||
            [document.body, document.documentElement, this.host].includes(
              document.activeElement as HTMLElement,
            ))
        ) {
          this.input.focus();
        }
      });
    }
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (!this.state.visible || this.composing || event.isComposing) return;
    // Window capture sees the shadow host as target; the composed path retains
    // the actual input/button. Local handling also supports non-composed events.
    const target = event.composedPath()[0] ?? event.target;
    const row =
      target instanceof Element ? target.closest<HTMLElement>('.result') : null;
    const focusedIndex =
      row?.querySelector<HTMLButtonElement>('.result-primary')?.dataset.index;

    if (
      event.key.toLowerCase() === 's' &&
      event.altKey &&
      event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.repeat &&
      !event.getModifierState('AltGraph') &&
      this.state.mode === 'title' &&
      (target === this.input || Boolean(row))
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!this.sameSearchConditions()) this.performSearch();
      const result =
        this.state.results[
          focusedIndex === undefined
            ? this.state.selectedIndex
            : Number(focusedIndex)
        ];
      if (result) this.actions.showSections(result);
      return;
    }
    if (
      event.key === 'Tab' &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      this.cycleFocus(event);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (this.geometry.finishDrag(true)) return;
      this.close();
      return;
    }
    const primary =
      target instanceof Element
        ? target.closest<HTMLButtonElement>('.result-primary')
        : null;
    if (event.key === 'Enter' && (target === this.input || primary)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (
        event.altKey ||
        event.getModifierState('AltGraph') ||
        (event.ctrlKey && event.metaKey) ||
        (event.shiftKey && (event.ctrlKey || event.metaKey))
      )
        return;
      if (target === this.input && !this.sameSearchConditions())
        this.performSearch();
      const result =
        this.state.results[
          primary ? Number(primary.dataset.index) : this.state.selectedIndex
        ];
      if (!result) return;
      if (event.ctrlKey || event.metaKey) this.openResult(result);
      else if (event.shiftKey) this.insert(result);
      else this.copyResult(result);
      return;
    }
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.getModifierState('AltGraph')
    )
      return;
    if (target !== this.input && !row) return;
    if (event.key === 'Enter' && row) {
      event.stopImmediatePropagation();
      return;
    }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && row) {
      const buttons = [
        ...row.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
      ];
      const at = buttons.indexOf(target as HTMLButtonElement);
      if (at < 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      buttons[
        Math.max(
          0,
          Math.min(
            buttons.length - 1,
            at + (event.key === 'ArrowRight' ? 1 : -1),
          ),
        )
      ]?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (target === this.input && !this.sameSearchConditions())
      this.performSearch();
    if (!this.state.results.length) return;
    const at =
      focusedIndex === undefined
        ? this.state.selectedIndex
        : Number(focusedIndex);
    this.state.selectedIndex =
      (at + (event.key === 'ArrowDown' ? 1 : -1) + this.state.results.length) %
      this.state.results.length;
    this.updateSelection();
    if (row) {
      const selector =
        target instanceof Element && target.matches('.action')
          ? [...target.classList].find((name) => name !== 'action')
          : 'result-primary';
      const nextRow = this.resultList
        .querySelector<HTMLButtonElement>(
          `.result-primary[data-index="${this.state.selectedIndex}"]`,
        )
        ?.closest('.result');
      (
        nextRow?.querySelector<HTMLButtonElement>(
          `.${selector}:not(:disabled)`,
        ) ?? nextRow?.querySelector<HTMLButtonElement>('.result-primary')
      )?.focus();
    }
  }

  private cycleFocus(event: KeyboardEvent): void {
    event.stopImmediatePropagation();
    const controls = [
      ...this.panel.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [tabindex]',
      ),
    ].filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.matches(':disabled') &&
        !element.closest('[hidden], [inert]') &&
        element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility === 'visible',
    );
    const first = controls[0];
    const last = controls[controls.length - 1];
    const active = this.root.activeElement;
    if (
      active === (event.shiftKey ? first : last) ||
      !controls.some((element) => element === active)
    ) {
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
    event.stopImmediatePropagation();
    if (!this.state.visible) this.open();
    else this.close();
  }

  private syncSectionScope(): void {
    const parsed = parseSectionQuery(this.input.value);
    if (
      this.state.sectionPageId !== undefined &&
      (parsed.pageQuery !== this.state.sectionPageTitle ||
        (this.state.namespace !== '' &&
          Number(this.state.namespace) !== this.state.sectionPageNamespace))
    ) {
      this.state.sectionPageId = undefined;
      this.state.sectionPageTitle = '';
    }
    this.state.includeSections =
      this.state.mode === 'title' && parsed.hasSeparator;
    this.callbacks.sectionIntent?.({
      active: this.state.visible && this.state.includeSections,
      query: this.input.value,
      namespace: this.state.namespace
        ? Number(this.state.namespace)
        : undefined,
      pageId: this.state.sectionPageId,
    });
  }

  private cancelSectionAction(): void {
    this.pendingAction?.cancel();
    this.pendingAction = undefined;
    this.state.resolvingSections = [];
  }

  private runResultAction(
    result: SearchPanelResult,
    action: SectionAction,
  ): void {
    if (!isSectionResult(result)) {
      this.cancelSectionAction();
      this.executeResultAction(result, action);
      return;
    }
    if (!this.sameSearchConditions()) {
      this.refreshResults();
      return;
    }
    const key = searchResultIdentity('title', result);
    if (this.pendingAction?.key === key && this.pendingAction.action === action)
      return;
    this.cancelSectionAction();
    this.callbacks.prefetchSectionLinks?.(
      this.state.results.filter(isSectionResult),
      result,
    );
    if (
      !result.needsResolution &&
      result.fragment &&
      (this.callbacks.sectionCurrent?.(result) ?? true)
    ) {
      this.failedActions.delete(key);
      this.state.failedSections = [...this.failedActions.keys()];
      this.executeResultAction(result, action);
      return;
    }
    void this.completeSectionAction(result, action, key);
  }

  private async completeSectionAction(
    result: SectionSearchResult,
    action: SectionAction,
    key: string,
  ): Promise<void> {
    const query = this.input.value;
    const namespace = this.state.namespace;
    const pageId = this.state.sectionPageId;
    const selected = this.state.results[this.state.selectedIndex];
    const selectedKey =
      selected && searchResultIdentity(this.state.mode, selected);
    const editor = action === 'insert' ? captureEditorSelection() : undefined;
    const token = {
      key,
      action,
      cancel: () => {
        editor?.dispose();
        document.removeEventListener('focusin', onFocus, true);
        document.removeEventListener('visibilitychange', onVisibility);
      },
    };
    const onFocus = (event: FocusEvent) => {
      if (
        event.target !== this.host &&
        event.target instanceof Node &&
        !this.root.contains(event.target)
      )
        this.cancelSectionAction();
    };
    const onVisibility = () => {
      if (document.hidden) this.cancelSectionAction();
    };
    document.addEventListener('focusin', onFocus, true);
    document.addEventListener('visibilitychange', onVisibility);
    this.pendingAction = token;
    this.state.resolvingSections = [key];
    this.failedActions.delete(key);
    this.state.failedSections = [...this.failedActions.keys()];
    const valid = () =>
      this.pendingAction === token &&
      !this.destroyed &&
      this.state.visible &&
      this.state.mode === 'title' &&
      this.state.includeSections &&
      this.input.value === query &&
      this.state.namespace === namespace &&
      this.state.sectionPageId === pageId &&
      (action !== 'insert' || this.state.insertMode) &&
      selectedKey ===
        (this.state.results[this.state.selectedIndex] &&
          searchResultIdentity(
            'title',
            this.state.results[this.state.selectedIndex]!,
          ));
    let executing = false;
    try {
      if (!this.callbacks.resolveSection) throw new Error('链接准备暂不可用');
      const resolved = await this.callbacks.resolveSection(result);
      if (!valid()) return;
      if (editor && !editor.current()) {
        this.setStatus(
          '编辑器内容或插入位置已变化，已取消插入；请重新选择插入位置。',
        );
        return;
      }
      if (
        !resolved ||
        resolved.needsResolution ||
        !resolved.fragment ||
        searchResultIdentity('title', resolved) !== key ||
        !(this.callbacks.sectionCurrent?.(resolved) ?? true)
      ) {
        throw new Error('小节目标已变化或暂时无法确定');
      }
      // Remove cancellation listeners before close() restores focus for insertion.
      this.cancelSectionAction();
      executing = true;
      this.executeResultAction(resolved, action);
      this.invalidateResults(['title']);
    } catch (error) {
      if (executing || valid()) {
        this.failedActions.set(key, action);
        this.state.failedSections = [...this.failedActions.keys()];
        this.setStatus(
          `链接准备失败，可重试或打开所属页面：${error instanceof Error ? error.message : '未知错误'}`,
        );
      }
    } finally {
      token.cancel();
      if (this.pendingAction === token) this.cancelSectionAction();
    }
  }

  private executeResultAction(
    result: SearchPanelResult,
    action: SectionAction,
  ): void {
    if (action === 'copyTitle') {
      if (isDataCodeResult(result)) this.callbacks.copyCode(result);
      else this.callbacks.copyTitle(result);
    } else if (action === 'open') {
      if (isDataCodeResult(result)) this.callbacks.openCode(result);
      else this.callbacks.open(result);
    } else if (action === 'copyLink') {
      if (canInsertResult(result))
        this.callbacks.copy(result, this.input.value);
    } else {
      this.close();
      if (canInsertResult(result))
        this.callbacks.insert(result, this.input.value);
    }
  }

  private copyResult(result: SearchPanelResult): void {
    this.runResultAction(result, 'copyTitle');
  }

  private openResult(result: SearchPanelResult): void {
    this.runResultAction(result, 'open');
  }

  private insert(result: SearchPanelResult): void {
    if (!this.state.insertMode || !canInsertResult(result)) {
      this.setStatus('当前结果或编辑页不支持插入；可复制内容或打开来源。');
      return;
    }
    this.runResultAction(result, 'insert');
  }

  private updateSelection(): void {
    const result = this.state.results[this.state.selectedIndex];
    if (
      this.pendingAction &&
      (!result ||
        searchResultIdentity(this.state.mode, result) !==
          this.pendingAction.key)
    )
      this.cancelSectionAction();
    if (result && isSectionResult(result))
      this.callbacks.prefetchSectionLinks?.(
        this.state.results.filter(isSectionResult),
        result,
      );
    void nextTick(() => {
      if (!this.host.isConnected || !this.state.visible) return;
      const selected = this.resultList.querySelector<HTMLElement>(
        '[data-selected="true"]',
      );
      if (selected) this.geometry.scrollBodyTo(selected, 'nearest');
    });
  }

  private syncStatusPresentation(): void {
    const status = this.requireElement<HTMLElement>('.status');
    const details = this.requireElement<HTMLElement>('.status-details');
    const clipped =
      status.scrollHeight > status.clientHeight + 1 ||
      status.scrollWidth > status.clientWidth + 1;
    if (
      !clipped &&
      (this.root.activeElement?.matches('.status-details-toggle') ||
        details.contains(this.root.activeElement))
    )
      this.input.focus();
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
    this.host.style.setProperty(
      '--cu-title-highlight',
      this.state.highlights.titleColor,
    );
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
        (snapshot.restoreMs === undefined
          ? ''
          : ` / 恢复 ${Math.round(snapshot.restoreMs)}ms`),
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
  const rgb = [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  );
  const luminance = rgb
    .map((value) => value / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    )
    .reduce(
      (sum, value, index) =>
        sum + value * ([0.2126, 0.7152, 0.0722][index] ?? 0),
      0,
    );
  return luminance > 0.179 ? '#000' : '#fff';
}
