// SPDX-License-Identifier: MPL-2.0
import type { NamespaceInfo } from '../types';
import type {
  ContentSearchResult,
  SearchTextHighlight,
} from '../search/content-index';
import type { DataCodeSearchResult } from '../search/data-code-index';
import type {
  LuaModuleSearchResult,
  LuaSymbolKind,
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

const MIRROR_REFRESH_HELP =
  '重新同步本地数据（需要联网）：执行全量页面对账，刷新 Data 代码缓存，并修复或续传正文与 Lua 队列；不会清空本地镜像，也不会修改 wiki 页面。';
const FILE_REFRESH_HELP =
  '重新同步文件资源（需要联网）：重新枚举文件命名空间并更新本地文件缓存与索引；不会影响普通页面、正文、Data 代码或 Lua，也不会修改 wiki 页面。';

export type SearchPreparationKind = 'title' | 'content' | 'lua';

export interface MaintenanceActionFeedback {
  message: string;
  tone?: 'normal' | 'error' | 'success';
}

type SearchPanelResult =
  | TitleSearchResult
  | DataCodeSearchResult
  | ContentSearchResult
  | LuaModuleSearchResult;
type WikiPageSearchResult = TitleSearchResult | ContentSearchResult | LuaModuleSearchResult;

export interface SearchPanelCallbacks {
  prepareSearch(kind: SearchPreparationKind): void;
  prepareFiles(): void;
  search(query: string, namespace?: number): TitleSearchResult[];
  searchFiles(query: string): TitleSearchResult[];
  searchLua(query: string): LuaModuleSearchResult[];
  searchContent(query: string, namespace?: number): ContentSearchResult[];
  searchCodes(query: string): DataCodeSearchResult[];
  insert(result: WikiPageSearchResult, query: string): void;
  selectCode(result: DataCodeSearchResult): void;
  copy(result: WikiPageSearchResult, query: string): void;
  copyCode(result: DataCodeSearchResult): void;
  open(result: WikiPageSearchResult): void;
  openCode(result: DataCodeSearchResult): void;
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
  private static layoutOwner?: WeakRef<SearchPanel>;
  private static readonly globalShortcutKeydown = (event: KeyboardEvent): void => {
    const owner = SearchPanel.shortcutOwner?.deref();
    if (!owner?.host.isConnected) {
      SearchPanel.shortcutOwner = undefined;
      return;
    }
    owner.handleGlobalShortcut(event);
  };

  private readonly host: HTMLDivElement;
  private readonly root: ShadowRoot;
  private readonly panel: HTMLElement;
  private readonly panelBody: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly modeSelect: HTMLSelectElement;
  private readonly namespaceSelect: HTMLSelectElement;
  private readonly resultList: HTMLUListElement;
  private readonly status: HTMLElement;
  private readonly statusDetails: HTMLElement;
  private readonly statusDetailsToggle: HTMLButtonElement;
  private readonly toggle: HTMLButtonElement;
  private readonly dragHandle: HTMLElement;
  private readonly configure: HTMLButtonElement;
  private readonly settings: HTMLElement;
  private readonly dataRules: HTMLTextAreaElement;
  private readonly highlightSettings: HTMLElement;
  private readonly titleHighlightToggle: HTMLInputElement;
  private readonly contentHighlightToggle: HTMLInputElement;
  private readonly titleHighlightColor: HTMLInputElement;
  private readonly contentHighlightColor: HTMLInputElement;
  private readonly maintenance: HTMLElement;
  private readonly maintenanceOutput: HTMLElement;
  private defaultDataRules = '';
  private highlightPreferences: HighlightPreferences = {
    ...DEFAULT_HIGHLIGHT_PREFERENCES,
  };
  private results: SearchPanelResult[] = [];
  private selectedIndex = -1;
  private insertMode = true;
  private composing = false;
  private maintenanceBusy = false;
  private startupFailed = false;
  private searchTimer?: number;
  private returnFocus?: HTMLElement;
  private positioned = false;
  private drag?: {
    pointerId: number;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
    wasPositioned: boolean;
  };
  private resizeObserver?: ResizeObserver;
  private disconnectObserver?: MutationObserver;
  private layoutFrame?: number;
  private readonly handleViewportResize = (): void => {
    this.syncViewportBounds();
    this.scheduleLayoutUpdate();
  };

  constructor(private readonly callbacks: SearchPanelCallbacks) {
    this.host = document.createElement('div');
    this.host.id = 'cu-wiki-search-host';
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.innerHTML = markup;
    document.documentElement.append(this.host);

    this.panel = this.requireElement<HTMLElement>('.panel');
    this.panelBody = this.requireElement<HTMLElement>('.panel-body');
    this.input = this.requireElement<HTMLInputElement>('.query');
    this.modeSelect = this.requireElement<HTMLSelectElement>('.mode');
    this.namespaceSelect = this.requireElement<HTMLSelectElement>('.namespace');
    this.resultList = this.requireElement<HTMLUListElement>('.results');
    this.status = this.requireElement<HTMLElement>('.status');
    this.statusDetails = this.requireElement<HTMLElement>('.status-details');
    this.statusDetailsToggle =
      this.requireElement<HTMLButtonElement>('.status-details-toggle');
    this.toggle = this.requireElement<HTMLButtonElement>('.toggle');
    this.dragHandle = this.requireElement<HTMLElement>('.drag-handle');
    this.configure = this.requireElement<HTMLButtonElement>('.configure');
    this.settings = this.requireElement<HTMLElement>('.settings');
    this.dataRules = this.requireElement<HTMLTextAreaElement>('.data-rules');
    this.highlightSettings = this.requireElement<HTMLElement>('.highlight-settings');
    this.titleHighlightToggle = this.requireElement<HTMLInputElement>('.title-highlight-toggle');
    this.contentHighlightToggle = this.requireElement<HTMLInputElement>('.content-highlight-toggle');
    this.titleHighlightColor = this.requireElement<HTMLInputElement>('.title-highlight-color');
    this.contentHighlightColor = this.requireElement<HTMLInputElement>('.content-highlight-color');
    this.maintenance = this.requireElement<HTMLElement>('.maintenance');
    this.maintenanceOutput = this.requireElement<HTMLElement>('.maintenance-output');
    this.bindEvents();
    this.bindLayout();
    this.updateModePresentation();
    this.syncHighlightControls();
    this.applyHighlightColors();
    this.statusDetails.textContent = this.status.textContent;
  }

  setStatus(message: string, tone: 'normal' | 'error' | 'success' = 'normal'): void {
    this.status.textContent = message;
    this.statusDetails.textContent = message;
    this.status.dataset.tone = tone;
    this.statusDetails.dataset.tone = tone;
    this.scheduleLayoutUpdate();
  }

  setNamespaces(namespaces: NamespaceInfo[]): void {
    const selected = this.namespaceSelect.value;
    this.namespaceSelect.replaceChildren(new Option('全部命名空间', ''));
    for (const namespace of namespaces.sort((left, right) => left.id - right.id)) {
      this.namespaceSelect.add(new Option(namespace.name || '（主）', String(namespace.id)));
    }
    if ([...this.namespaceSelect.options].some((option) => option.value === selected)) {
      this.namespaceSelect.value = selected;
    }
  }

  setInsertMode(enabled: boolean): void {
    this.insertMode = enabled;
    this.updateModePresentation();
  }

  setDataCodeRules(source: string, defaultSource: string): void {
    this.dataRules.value = source;
    this.defaultDataRules = defaultSource;
  }

  setHighlightPreferences(preferences: HighlightPreferences): void {
    this.highlightPreferences = { ...preferences };
    this.syncHighlightControls();
    this.applyHighlightColors();
    this.renderResults();
  }

  setStartupFailure(message: string, reload: () => void): void {
    this.startupFailed = true;
    this.setStatus(`本地搜索启动失败：${message}。可重新加载页面重试。`, 'error');
    const reloadButton = this.requireElement<HTMLButtonElement>('.reload-startup');
    reloadButton.hidden = false;
    reloadButton.onclick = reload;
  }

  open(returnFocus?: HTMLElement): void {
    if (this.panel.hidden) {
      this.returnFocus = returnFocus ?? this.currentReturnFocus();
    }
    if (!this.startupFailed) {
      this.prepareCurrentMode();
    }
    this.panel.hidden = false;
    this.toggle.setAttribute('aria-expanded', 'true');
    this.scheduleLayoutUpdate();
    this.input.focus();
    this.input.select();
  }

  close(): void {
    if (this.panel.hidden) return;
    this.finishDrag(false);
    this.panel.hidden = true;
    this.toggle.setAttribute('aria-expanded', 'false');
    const returnFocus = this.returnFocus;
    this.returnFocus = undefined;
    if (returnFocus?.isConnected && !returnFocus.matches(':disabled')) {
      returnFocus.focus();
    } else {
      this.toggle.focus();
    }
  }

  refreshResults(): void {
    this.performSearch();
  }

  private bindEvents(): void {
    this.toggle.addEventListener('click', () => {
      if (this.panel.hidden) this.open(this.toggle);
      else this.close();
    });
    this.requireElement<HTMLButtonElement>('.close').addEventListener('click', () => this.close());
    this.requireElement<HTMLButtonElement>('.refresh').addEventListener('click', () => {
      if (this.startupFailed) return;
      if (this.fileMode) this.callbacks.refreshFiles();
      else this.callbacks.refresh();
    });
    this.configure.addEventListener('click', () => {
      this.settings.hidden = !this.settings.hidden;
      if (!this.settings.hidden) this.dataRules.focus();
    });
    this.requireElement<HTMLButtonElement>('.maintenance-toggle').addEventListener(
      'click',
      (event) => {
        this.maintenance.hidden = !this.maintenance.hidden;
        this.settings.hidden = true;
        (event.currentTarget as HTMLButtonElement).setAttribute(
          'aria-expanded',
          String(!this.maintenance.hidden),
        );
        if (!this.maintenance.hidden) {
          this.scheduleBodyScroll(this.maintenance, 'start');
          void this.loadMaintenance();
        }
      },
    );
    this.statusDetailsToggle.addEventListener('click', () => {
      this.statusDetails.hidden = !this.statusDetails.hidden;
      const expanded = !this.statusDetails.hidden;
      this.statusDetailsToggle.textContent = expanded ? '收起完整状态' : '查看完整状态';
      this.statusDetailsToggle.setAttribute('aria-expanded', String(expanded));
      if (expanded) this.scheduleBodyScroll(this.statusDetails, 'nearest');
    });
    this.requireElement<HTMLButtonElement>('.reset-position').addEventListener(
      'click',
      () => this.resetPosition(),
    );
    this.requireElement<HTMLButtonElement>('.save-rules').addEventListener('click', () => {
      void this.saveDataRules(this.dataRules.value);
    });
    this.requireElement<HTMLButtonElement>('.reset-rules').addEventListener('click', () => {
      this.dataRules.value = this.defaultDataRules;
      void this.saveDataRules(this.defaultDataRules);
    });
    this.titleHighlightToggle.addEventListener('change', () => {
      this.highlightPreferences.titleEnabled = this.titleHighlightToggle.checked;
      this.applyHighlightPreferences();
    });
    this.contentHighlightToggle.addEventListener('change', () => {
      this.highlightPreferences.contentEnabled = this.contentHighlightToggle.checked;
      this.applyHighlightPreferences();
    });
    this.titleHighlightColor.addEventListener('input', () => {
      this.highlightPreferences.titleColor = this.titleHighlightColor.value;
      this.applyHighlightColors();
    });
    this.titleHighlightColor.addEventListener('change', () =>
      this.persistHighlightPreferences(),
    );
    this.contentHighlightColor.addEventListener('input', () => {
      this.highlightPreferences.contentColor = this.contentHighlightColor.value;
      this.applyHighlightColors();
    });
    this.contentHighlightColor.addEventListener('change', () =>
      this.persistHighlightPreferences(),
    );
    this.bindMaintenanceAction('.rebuild-indexes', '正在从本地页面重建搜索索引…', () =>
      this.callbacks.rebuildSearchIndexes?.(),
    );
    this.bindMaintenanceAction('.rebuild-content-queue', '正在修复正文队列…', () =>
      this.callbacks.rebuildContentQueue?.(),
    );
    this.bindMaintenanceAction('.reconcile-now', '正在进行联网全量对账…', () =>
      this.callbacks.reconcileNow?.(),
    );
    this.bindMaintenanceAction('.clear-snapshots', '正在清除索引快照…', () =>
      this.callbacks.clearSnapshots?.(),
    );
    this.requireElement<HTMLButtonElement>('.request-persistence').addEventListener(
      'click',
      () => {
        void this.runMaintenanceAction(
          '正在申请浏览器持久保存…',
          async () => {
            const request = this.callbacks.requestPersistence?.();
            if (!request) throw new Error('持久保存操作当前不可用');
            await this.finishPersistenceRequest(request);
          },
          false,
        );
      },
    );
    this.requireElement<HTMLButtonElement>('.reveal-danger').addEventListener('click', () => {
      this.requireElement<HTMLElement>('.danger-confirmation').hidden = false;
    });
    this.requireElement<HTMLButtonElement>('.reset-local').addEventListener('click', () => {
      const resetRules = this.requireElement<HTMLInputElement>('.reset-data-rules').checked;
      void this.runMaintenanceAction('正在清空本地镜像…', () =>
        this.callbacks.resetLocalMirror?.(resetRules),
      );
    });

    this.panel.addEventListener('compositionstart', () => {
      this.composing = true;
    });
    this.panel.addEventListener('compositionend', (event) => {
      this.composing = false;
      if (event.target === this.input) this.scheduleSearch(0);
    });
    this.input.addEventListener('input', () => {
      if (!this.composing) this.scheduleSearch(120);
    });
    this.namespaceSelect.addEventListener('change', () => this.performSearch());
    this.modeSelect.addEventListener('change', () => {
      if (!this.startupFailed) this.prepareCurrentMode();
      this.updateModePresentation();
      this.performSearch();
    });
    this.panel.addEventListener('keydown', (event) => this.handleKeydown(event));
    this.dragHandle.addEventListener('keydown', (event) =>
      this.handleDragHandleKeydown(event),
    );
    this.dragHandle.addEventListener('pointerdown', (event) =>
      this.startDrag(event),
    );
    this.dragHandle.addEventListener('pointermove', (event) => this.moveDrag(event));
    this.dragHandle.addEventListener('pointerup', (event) => {
      if (event.pointerId === this.drag?.pointerId) this.finishDrag(false);
    });
    this.dragHandle.addEventListener('pointercancel', (event) => {
      if (event.pointerId === this.drag?.pointerId) this.finishDrag(true);
    });
    SearchPanel.claimGlobalShortcut(this);
  }

  private bindLayout(): void {
    SearchPanel.layoutOwner?.deref()?.disconnectLayoutTracking();
    SearchPanel.layoutOwner = new WeakRef(this);
    this.syncViewportBounds();
    window.addEventListener('resize', this.handleViewportResize);
    window.visualViewport?.addEventListener('resize', this.handleViewportResize);
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.scheduleLayoutUpdate());
      this.resizeObserver.observe(this.panel);
    }
    if (typeof MutationObserver === 'function') {
      this.disconnectObserver = new MutationObserver(() => {
        if (!this.host.isConnected) this.disconnectLayoutTracking();
      });
      this.disconnectObserver.observe(document.documentElement, { childList: true });
    }
  }

  private disconnectLayoutTracking(): void {
    window.removeEventListener('resize', this.handleViewportResize);
    window.visualViewport?.removeEventListener('resize', this.handleViewportResize);
    this.resizeObserver?.disconnect();
    this.disconnectObserver?.disconnect();
    if (this.layoutFrame !== undefined) window.cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = undefined;
    this.finishDrag(false);
  }

  private scheduleLayoutUpdate(): void {
    if (this.layoutFrame !== undefined) window.cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = window.requestAnimationFrame(() => {
      this.layoutFrame = undefined;
      if (!this.host.isConnected) {
        this.disconnectLayoutTracking();
        return;
      }
      if (this.panel.hidden) return;
      this.reclampPosition();
      this.syncStatusPresentation();
    });
  }

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
    if (this.fileMode) this.callbacks.prepareFiles();
    else if (this.codeMode) return;
    else if (this.luaMode) this.callbacks.prepareSearch('lua');
    else if (this.contentMode) this.callbacks.prepareSearch('content');
    else this.callbacks.prepareSearch('title');
  }

  private performSearch(): void {
    if (this.fileMode) {
      this.results = this.callbacks.searchFiles(this.input.value);
    } else if (this.codeMode) {
      this.results = this.callbacks.searchCodes(this.input.value);
    } else if (this.luaMode) {
      this.results = this.callbacks.searchLua(this.input.value);
    } else {
      const namespaceValue = this.namespaceSelect.value;
      const namespace = namespaceValue ? Number(namespaceValue) : undefined;
      this.results = this.contentMode
        ? this.callbacks.searchContent(this.input.value, namespace)
        : this.callbacks.search(this.input.value, namespace);
    }
    this.selectedIndex = this.results.length ? 0 : -1;
    this.renderResults();
  }

  private renderResults(): void {
    this.resultList.replaceChildren();
    if (!this.input.value.trim()) {
      this.resultList.append(
        this.messageItem(
          this.codeMode
            ? '输入中文名、英文代码片段或已配置字段值查找代码'
            : this.fileMode
              ? '输入文件名、片段或扩展名开始搜索'
            : this.luaMode
              ? '输入函数名、返回键、字符串或依赖目标'
            : this.contentMode
              ? '输入正文关键词开始搜索'
              : '输入标题关键词开始搜索',
        ),
      );
      return;
    }
    if (!this.results.length) {
      this.resultList.append(
        this.messageItem(
          this.codeMode
            ? '没有找到对应代码名'
            : this.fileMode
              ? '没有找到匹配文件'
            : this.luaMode
              ? '没有找到匹配 Lua 模块'
            : this.contentMode
              ? '没有找到匹配正文'
              : '没有找到匹配标题',
        ),
      );
      return;
    }

    this.results.forEach((result, index) => {
      const item = document.createElement('li');
      item.className = 'result';
      item.dataset.selected = String(index === this.selectedIndex);

      const insertButton = document.createElement('button');
      insertButton.className = 'insert';
      insertButton.type = 'button';
      const title = document.createElement('span');
      title.className = 'result-title';
      const namespace = document.createElement('span');
      namespace.className = 'result-namespace';
      insertButton.append(title, namespace);
      insertButton.addEventListener('click', () => this.insert(result));

      const actions = document.createElement('span');
      actions.className = 'actions';
      if (isDataCodeResult(result)) {
        insertButton.title = '复制代码名';
        title.textContent = result.chineseName;
        namespace.textContent = `${result.code} · ${result.dataType}`;
        actions.append(
          this.actionButton('复制', '复制代码名', () => this.callbacks.copyCode(result)),
          this.actionButton('↗', '打开 Data 页面', () => this.callbacks.openCode(result)),
        );
      } else if (isLuaResult(result)) {
        insertButton.title = '在新标签页打开模块';
        title.textContent = result.title;
        namespace.textContent = result.matches
          .map((match) => `${luaKindLabel(match.kind)} · ${match.value}`)
          .join(' · ');
        actions.append(
          this.actionButton('↗', '在新标签页打开模块', () => this.callbacks.open(result)),
        );
      } else {
        insertButton.title = this.insertMode ? '插入维基链接' : '复制页面标题';
        if (isContentResult(result)) {
          this.appendResultText(
            title,
            result.title,
            this.highlightPreferences.titleEnabled ? result.titleHighlights : undefined,
          );
          namespace.append(
            document.createTextNode(`${result.namespaceName || '主命名空间'} · `),
          );
          this.appendResultText(
            namespace,
            result.snippet,
            this.highlightPreferences.contentEnabled ? result.highlights : undefined,
          );
        } else {
          title.textContent = result.title;
          namespace.textContent = result.namespaceName || '主命名空间';
        }
        actions.append(
          this.actionButton('复制', '复制维基链接', () =>
            this.callbacks.copy(result, this.input.value),
          ),
          this.actionButton('↗', '在新标签页打开', () => this.callbacks.open(result)),
        );
      }
      item.append(insertButton, actions);
      item.addEventListener('mouseenter', () => {
        this.selectedIndex = index;
        this.updateSelection();
      });
      this.resultList.append(item);
    });
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (this.composing || event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.drag) {
        this.finishDrag(true);
        return;
      }
      this.close();
      return;
    }
    if (event.target !== this.input) return;
    if (!this.results.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.selectedIndex = (this.selectedIndex + 1) % this.results.length;
      this.updateSelection();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.selectedIndex = (this.selectedIndex - 1 + this.results.length) % this.results.length;
      this.updateSelection();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const result = this.results[this.selectedIndex];
      if (result) this.insert(result);
    }
  }

  private handleGlobalShortcut(event: KeyboardEvent): void {
    if (
      this.composing ||
      event.isComposing ||
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.getModifierState('AltGraph') ||
      event.key.toLocaleLowerCase() !== 'k'
    ) {
      return;
    }
    event.preventDefault();
    if (this.panel.hidden) this.open();
    else this.close();
  }

  private insert(result: SearchPanelResult): void {
    this.close();
    if (isDataCodeResult(result)) this.callbacks.selectCode(result);
    else if (isLuaResult(result)) this.callbacks.open(result);
    else this.callbacks.insert(result, this.input.value);
  }

  private updateModePresentation(): void {
    const heading = this.requireElement<HTMLElement>('.heading');
    const refresh = this.requireElement<HTMLButtonElement>('.refresh');
    const refreshHelp = this.fileMode ? FILE_REFRESH_HELP : MIRROR_REFRESH_HELP;
    refresh.title = refreshHelp;
    refresh.setAttribute('aria-label', refreshHelp);
    if (this.codeMode) {
      heading.textContent = '查找 Data 代码名';
      this.input.placeholder = '中文名、英文代码片段或已配置字段值';
      this.input.setAttribute('aria-label', '搜索 Data 代码');
      this.namespaceSelect.hidden = true;
    } else if (this.fileMode) {
      heading.textContent = '查找文件资源';
      this.input.placeholder = '文件名、片段或扩展名';
      this.input.setAttribute('aria-label', '搜索文件资源');
      this.namespaceSelect.hidden = true;
    } else if (this.luaMode) {
      heading.textContent = '查找 Lua 模块';
      this.input.placeholder = '函数名、返回键、字符串或 require 目标';
      this.input.setAttribute('aria-label', '搜索 Lua 模块');
      this.namespaceSelect.hidden = true;
    } else if (this.contentMode) {
      heading.textContent = '搜索页面正文';
      this.input.placeholder = '输入正文关键词';
      this.input.setAttribute('aria-label', '搜索页面正文');
      this.namespaceSelect.hidden = false;
    } else {
      heading.textContent = this.insertMode ? '插入维基链接' : '搜索并复制标题';
      this.input.placeholder = '标题、片段或英文中缀';
      this.input.setAttribute('aria-label', '搜索页面标题');
      this.namespaceSelect.hidden = false;
    }
    this.configure.hidden = !this.codeMode;
    if (!this.codeMode) this.settings.hidden = true;
    this.highlightSettings.hidden = !this.contentMode;
  }

  private get codeMode(): boolean {
    return this.modeSelect.value === 'data-code';
  }

  private get contentMode(): boolean {
    return this.modeSelect.value === 'content';
  }

  private get fileMode(): boolean {
    return this.modeSelect.value === 'files';
  }

  private get luaMode(): boolean {
    return this.modeSelect.value === 'lua';
  }

  private updateSelection(): void {
    const items = [...this.resultList.querySelectorAll<HTMLElement>('.result')];
    items.forEach((item, index) => {
      item.dataset.selected = String(index === this.selectedIndex);
    });
    const selected = items[this.selectedIndex];
    if (selected) this.scrollBodyTo(selected, 'nearest');
  }

  private handleDragHandleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.drag) {
      event.preventDefault();
      event.stopPropagation();
      this.finishDrag(true);
      return;
    }
    if (this.viewportBounds().width <= 640 || !event.key.startsWith('Arrow')) return;
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    const rect = this.panel.getBoundingClientRect();
    const step = event.shiftKey ? 1 : 10;
    this.positionPanel(rect.left + direction[0] * step, rect.top + direction[1] * step);
  }

  private startDrag(event: PointerEvent): void {
    if (
      event.button !== 0 ||
      this.viewportBounds().width <= 640 ||
      typeof window.matchMedia !== 'function' ||
      !window.matchMedia('(pointer: fine)').matches
    ) {
      return;
    }
    event.preventDefault();
    const rect = this.panel.getBoundingClientRect();
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      wasPositioned: this.positioned,
    };
    this.panel.dataset.dragging = 'true';
    this.dragHandle.setPointerCapture(event.pointerId);
  }

  private moveDrag(event: PointerEvent): void {
    if (event.pointerId !== this.drag?.pointerId) return;
    event.preventDefault();
    this.positionPanel(
      this.drag.startLeft + event.clientX - this.drag.startX,
      this.drag.startTop + event.clientY - this.drag.startY,
    );
  }

  private finishDrag(cancel: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = undefined;
    delete this.panel.dataset.dragging;
    if (this.dragHandle.hasPointerCapture(drag.pointerId)) {
      this.dragHandle.releasePointerCapture(drag.pointerId);
    }
    if (cancel) {
      if (drag.wasPositioned) this.positionPanel(drag.startLeft, drag.startTop);
      else this.resetPosition();
    }
  }

  private positionPanel(left: number, top: number): void {
    const rect = this.panel.getBoundingClientRect();
    const viewport = this.viewportBounds();
    const margin = 12;
    const maxLeft = Math.max(margin, viewport.width - rect.width - margin);
    const maxTop = Math.max(margin, viewport.height - rect.height - margin);
    this.panel.style.left = `${Math.min(Math.max(left, margin), maxLeft)}px`;
    this.panel.style.top = `${Math.min(Math.max(top, margin), maxTop)}px`;
    this.panel.style.right = 'auto';
    this.panel.style.bottom = 'auto';
    this.panel.dataset.positioned = 'true';
    this.positioned = true;
  }

  private reclampPosition(): void {
    if (!this.positioned || this.viewportBounds().width <= 640) return;
    const rect = this.panel.getBoundingClientRect();
    this.positionPanel(rect.left, rect.top);
  }

  private viewportBounds(): { width: number; height: number } {
    const layoutWidth = document.documentElement.clientWidth || window.innerWidth;
    const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
    return {
      width: Math.min(layoutWidth, window.visualViewport?.width ?? layoutWidth),
      height: Math.min(layoutHeight, window.visualViewport?.height ?? layoutHeight),
    };
  }

  private syncViewportBounds(): void {
    const { width, height } = this.viewportBounds();
    this.host.style.setProperty('--cu-panel-fluid-width', `${width * 0.36}px`);
    this.host.style.setProperty('--cu-panel-max-width', `${Math.max(0, width - 24)}px`);
    this.host.style.setProperty('--cu-panel-max-height', `${Math.max(0, height - 84)}px`);
    this.host.style.setProperty('--cu-panel-mobile-max-height', `${Math.max(0, height - 80)}px`);
    this.host.toggleAttribute('data-narrow', width <= 640);
  }

  private resetPosition(): void {
    this.panel.style.removeProperty('left');
    this.panel.style.removeProperty('top');
    this.panel.style.removeProperty('right');
    this.panel.style.removeProperty('bottom');
    delete this.panel.dataset.positioned;
    this.positioned = false;
  }

  private scheduleBodyScroll(element: HTMLElement, block: 'nearest' | 'start'): void {
    window.requestAnimationFrame(() => {
      if (element.isConnected && !element.hidden) this.scrollBodyTo(element, block);
    });
  }

  private scrollBodyTo(element: HTMLElement, block: 'nearest' | 'start'): void {
    const bodyRect = this.panelBody.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    if (block === 'start' || elementRect.top < bodyRect.top) {
      this.panelBody.scrollTop += elementRect.top - bodyRect.top;
    } else if (elementRect.bottom > bodyRect.bottom) {
      this.panelBody.scrollTop += elementRect.bottom - bodyRect.bottom;
    }
  }

  private syncStatusPresentation(): void {
    const clipped =
      this.status.scrollHeight > this.status.clientHeight + 1 ||
      this.status.scrollWidth > this.status.clientWidth + 1;
    this.statusDetailsToggle.hidden = !clipped;
    if (!clipped) {
      this.statusDetails.hidden = true;
      this.statusDetailsToggle.textContent = '查看完整状态';
      this.statusDetailsToggle.setAttribute('aria-expanded', 'false');
    }
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

  private messageItem(message: string): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'message';
    item.textContent = message;
    return item;
  }

  private actionButton(label: string, title: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'action';
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      action();
    });
    return button;
  }

  private async saveDataRules(source: string): Promise<void> {
    try {
      this.setStatus('正在按配置刷新 Data 代码缓存…');
      await this.callbacks.saveDataCodeRules(source);
      this.settings.hidden = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(`Data 代码检索配置无效或刷新失败：${message}`, 'error');
    }
  }

  private applyHighlightPreferences(): void {
    this.syncHighlightControls();
    this.applyHighlightColors();
    this.persistHighlightPreferences();
    this.renderResults();
  }

  private syncHighlightControls(): void {
    this.titleHighlightToggle.checked = this.highlightPreferences.titleEnabled;
    this.contentHighlightToggle.checked = this.highlightPreferences.contentEnabled;
    this.titleHighlightColor.value = this.highlightPreferences.titleColor;
    this.contentHighlightColor.value = this.highlightPreferences.contentColor;
  }

  private applyHighlightColors(): void {
    this.host.style.setProperty('--cu-title-highlight', this.highlightPreferences.titleColor);
    this.host.style.setProperty(
      '--cu-title-highlight-color',
      contrastTextColor(this.highlightPreferences.titleColor),
    );
    this.host.style.setProperty(
      '--cu-content-highlight',
      this.highlightPreferences.contentColor,
    );
    this.host.style.setProperty(
      '--cu-content-highlight-color',
      contrastTextColor(this.highlightPreferences.contentColor),
    );
  }

  private persistHighlightPreferences(): void {
    this.callbacks.saveHighlightPreferences({ ...this.highlightPreferences });
  }

  private appendResultText(
    parent: HTMLElement,
    text: string,
    highlights?: readonly SearchTextHighlight[],
  ): void {
    const ranges = (highlights ?? [])
      .map((range) => ({
        start: Math.max(0, Math.min(range.start, text.length)),
        end: Math.min(range.end, text.length),
      }))
      .filter((range) => range.end > range.start)
      .sort((left, right) => left.start - right.start);
    let cursor = 0;
    for (const range of ranges) {
      if (range.start < cursor) continue;
      if (range.start > cursor) {
        parent.append(document.createTextNode(text.slice(cursor, range.start)));
      }
      const mark = document.createElement('mark');
      mark.textContent = text.slice(range.start, range.end);
      parent.append(mark);
      cursor = range.end;
    }
    if (cursor < text.length) {
      parent.append(document.createTextNode(text.slice(cursor)));
    }
  }

  private bindMaintenanceAction(
    selector: string,
    progressMessage: string,
    action: () => Promise<void | MaintenanceActionFeedback> | undefined,
  ): void {
    this.requireElement<HTMLButtonElement>(selector).addEventListener('click', () => {
      void this.runMaintenanceAction(progressMessage, action);
    });
  }

  private async runMaintenanceAction(
    progressMessage: string,
    action: () => Promise<void | MaintenanceActionFeedback> | undefined,
    announceCompletion = true,
  ): Promise<void> {
    if (this.maintenanceBusy) return;
    this.maintenanceBusy = true;
    this.setMaintenanceDisabled(true);
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
      this.maintenanceOutput.textContent = failure;
      this.setStatus(failure, 'error');
    } finally {
      this.maintenanceBusy = false;
      this.setMaintenanceDisabled(false);
    }
  }

  private setMaintenanceDisabled(disabled: boolean): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      '.maintenance-action',
    )) {
      button.disabled = disabled;
    }
  }

  private async loadMaintenance(): Promise<void> {
    if (!this.callbacks.loadMaintenance) {
      this.maintenanceOutput.textContent = '维护诊断尚未接入';
      return;
    }
    this.maintenanceOutput.textContent = '正在读取本地诊断…';
    try {
      const diagnostics = await this.callbacks.loadMaintenance();
      this.maintenanceOutput.textContent = formatDiagnostics(diagnostics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.maintenanceOutput.textContent = `诊断读取失败：${message}`;
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

function isDataCodeResult(result: SearchPanelResult): result is DataCodeSearchResult {
  return 'kind' in result && result.kind === 'data-code';
}

function isContentResult(result: SearchPanelResult): result is ContentSearchResult {
  return 'kind' in result && result.kind === 'content';
}

function isLuaResult(result: SearchPanelResult): result is LuaModuleSearchResult {
  return 'kind' in result && result.kind === 'lua';
}

function luaKindLabel(kind: LuaSymbolKind): string {
  switch (kind) {
    case 'function':
      return '函数';
    case 'return-key':
      return '返回键';
    case 'dependency':
      return '依赖';
    case 'string':
      return '字符串';
  }
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
    `正文源 ${diagnostics.counts.contentSources} · Lua 源 ${diagnostics.counts.luaSources}`,
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

const markup = `
  <style>
    :host { all: initial; color-scheme: dark; }
    * { box-sizing: border-box; }
    button, input, select, textarea { font: inherit; }
    button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible,
    [tabindex]:focus-visible {
      outline: 2px solid var(--brand-primary, #d6c484); outline-offset: 1px;
    }
    .toggle {
      position: fixed; right: 22px; bottom: 22px; z-index: 2147483646;
      border: 0; border-radius: 999px; padding: 10px 16px;
      background: var(--brand-primary, #d6c484); color: #141414;
      box-shadow: 0 8px 24px #0008; cursor: pointer;
      font: 600 14px/20px "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif;
    }
    .toggle:hover { filter: brightness(1.08); transform: translateY(-1px); }
    .panel {
      position: fixed; right: 22px; bottom: 72px; z-index: 2147483647;
      display: flex; flex-direction: column;
      width: min(clamp(420px, var(--cu-panel-fluid-width, 36vw), 960px), var(--cu-panel-max-width, calc(100vw - 24px)));
      max-height: var(--cu-panel-max-height, calc(100dvh - 84px)); overflow: hidden;
      border: 1px solid var(--cu-color-border-soft, #45484e); border-radius: 14px;
      background: var(--detail-bg, #141414); box-shadow: 0 18px 54px #000a;
      color: var(--detail-color, #babdc4);
      font: 14px/1.4 "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif;
    }
    .panel[hidden] { display: none; }
    .panel > *, .panel-body > *, .result > * { min-width: 0; }
    .header { flex: none; display: flex; align-items: center; padding: 12px 14px 8px; gap: 6px; }
    .heading {
      flex: 1; padding: 4px 2px; border-radius: 5px; overflow-wrap: anywhere;
      font-weight: 700; letter-spacing: .02em;
    }
    .icon {
      flex: none; border: 0; background: transparent; color: var(--detail-color, #babdc4);
      cursor: pointer; padding: 4px 7px; border-radius: 6px;
    }
    .icon:hover { background: var(--detail-inner-bg, #202020); color: var(--detail-a, #ffd96a); }
    .icon[hidden] { display: none; }
    .reset-position { font-size: 11px; }
    .controls {
      flex: none; display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 112px) minmax(0, 124px);
      gap: 8px; padding: 0 14px 10px;
    }
    .query, .mode, .namespace {
      min-width: 0; max-width: 100%; height: 38px;
      border: 1px solid var(--cu-color-border-soft, #45484e); border-radius: 8px;
      background: var(--detail-inner-bg, #202020); color: var(--detail-color, #babdc4);
    }
    .query { padding: 0 11px; }
    .mode, .namespace { padding: 0 7px; }
    .mode[hidden], .namespace[hidden] { display: none; }
    .panel-body { min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
    .settings {
      margin: 0 14px 10px; padding: 10px;
      border: 1px solid var(--cu-color-border-soft, #45484e); border-radius: 9px;
      background: var(--detail-inner-bg, #202020);
    }
    .settings[hidden] { display: none; }
    .settings-label { display: block; margin-bottom: 6px; font-weight: 650; }
    .settings-help { display: block; margin: 6px 0; color: var(--detail-color, #babdc4); font-size: 11px; overflow-wrap: anywhere; }
    .data-rules {
      width: 100%; min-height: 180px; resize: vertical;
      border: 1px solid var(--cu-color-border-soft, #45484e); border-radius: 7px;
      padding: 8px; background: var(--detail-bg, #141414); color: var(--detail-color, #babdc4);
      font: 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    .settings-actions { display: flex; justify-content: flex-end; gap: 7px; }
    .settings-action {
      border: 1px solid var(--cu-color-border-soft, #45484e); border-radius: 6px;
      padding: 5px 9px; background: var(--detail-bg, #141414);
      color: var(--detail-a, #ffd96a); cursor: pointer;
    }
    .save-rules { border-color: var(--brand-primary, #d6c484); background: var(--brand-primary, #d6c484); color: #141414; }
    .highlight-settings {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px;
      margin: 0 14px 10px; padding: 8px 10px;
      border: 1px solid var(--cu-color-border-soft, #45484e); border-radius: 9px;
      background: var(--detail-inner-bg, #202020);
    }
    .highlight-settings[hidden] { display: none; }
    .highlight-option { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--detail-color, #babdc4); }
    .highlight-color { width: 26px; height: 20px; padding: 0; border: 1px solid var(--cu-color-border-soft, #45484e); border-radius: 5px; background: var(--detail-bg, #141414); cursor: pointer; }
    .maintenance {
      margin: 0 14px 10px; padding: 10px;
      border: 1px solid var(--cu-color-border-soft, #45484e); border-radius: 9px;
      background: var(--detail-inner-bg, #202020); overflow-wrap: anywhere;
    }
    .maintenance[hidden], .danger-confirmation[hidden] { display: none; }
    .maintenance-title { margin: 0 0 7px; font-size: 13px; }
    .maintenance-output { margin: 0 0 9px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--detail-color, #babdc4); font: 11px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .maintenance-actions { display: grid; gap: 6px; }
    .maintenance-action { border: 1px solid var(--cu-color-border-soft, #45484e); border-radius: 7px; padding: 7px 9px; background: var(--detail-bg, #141414); color: var(--detail-a, #ffd96a); cursor: pointer; text-align: left; white-space: normal; overflow-wrap: anywhere; }
    .maintenance-action:disabled { opacity: .55; cursor: wait; }
    .network-note { color: var(--brand-primary, #d6c484); font-size: 11px; }
    .danger-zone { margin-top: 10px; padding-top: 9px; border-top: 1px solid #70443e; }
    .danger { border-color: #a85f55; color: #ff9b8e; }
    .danger-copy { display: block; margin: 7px 0; color: #f0aaa1; font-size: 11px; }
    .reset-rules-option { display: block; margin: 7px 0; font-size: 11px; }
    .results { list-style: none; padding: 0 8px; margin: 0; }
    .result { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; border-radius: 9px; }
    .result[data-selected="true"] { background: var(--detail-inner-bg, #202020); }
    mark { border-radius: 2px; padding: 0 1px; }
    .result-title mark { background: var(--cu-title-highlight, #aee2ff); }
    .result-title mark { color: var(--cu-title-highlight-color, #000); }
    .result-namespace mark { background: var(--cu-content-highlight, #fff3a3); color: var(--cu-content-highlight-color, #000); }
    .insert { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; border: 0; padding: 9px 8px; background: transparent; color: inherit; cursor: pointer; text-align: left; }
    .result-title { max-width: 100%; overflow-wrap: anywhere; font-weight: 600; }
    .result-namespace { max-width: 100%; overflow-wrap: anywhere; font-size: 11px; color: var(--detail-color, #babdc4); }
    .actions { display: flex; gap: 3px; padding-right: 6px; }
    .action { border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--detail-a, #ffd96a); cursor: pointer; padding: 4px 6px; font-size: 12px; }
    .action:hover { border-color: var(--cu-color-border-soft, #45484e); background: var(--detail-bg, #141414); }
    .message { padding: 28px 12px; color: var(--detail-color, #babdc4); text-align: center; overflow-wrap: anywhere; }
    .status-details { margin: 10px 14px; padding: 10px; border: 1px solid var(--cu-color-border-soft, #45484e); border-radius: 9px; background: var(--detail-inner-bg, #202020); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; font: 11px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .status-details[hidden] { display: none; }
    .footer { flex: none; display: flex; gap: 8px; align-items: flex-start; min-height: 36px; padding: 8px 14px 10px; border-top: 1px solid var(--cu-color-border-soft, #45484e); color: var(--detail-color, #babdc4); font-size: 11px; }
    .status { flex: 1; display: -webkit-box; max-height: 2.8em; overflow: hidden; overflow-wrap: anywhere; white-space: pre-wrap; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
    .status-details-toggle { flex: none; border: 0; padding: 1px 3px; background: transparent; color: var(--detail-a, #ffd96a); cursor: pointer; font-size: 11px; }
    .status-details-toggle[hidden] { display: none; }
    .status[data-tone="error"], .status-details[data-tone="error"] { color: #ff9b8e; }
    .status[data-tone="success"], .status-details[data-tone="success"] { color: #8fd6ab; }
    kbd { border: 1px solid var(--cu-color-border-soft, #45484e); border-bottom-width: 2px; border-radius: 4px; background: var(--detail-inner-bg, #202020); padding: 1px 4px; font: 10px/1.2 "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif; }
    @media (pointer: fine) {
      :host(:not([data-narrow])) .drag-handle { cursor: grab; user-select: none; touch-action: none; }
      :host(:not([data-narrow])) .panel[data-dragging="true"] .drag-handle { cursor: grabbing; }
    }
    :host([data-narrow]) .panel {
      left: auto !important; top: auto !important; right: 12px !important; bottom: 68px !important;
      width: var(--cu-panel-max-width, calc(100vw - 24px));
      max-height: var(--cu-panel-mobile-max-height, calc(100dvh - 80px));
    }
    :host([data-narrow]) .toggle { right: 12px; bottom: 12px; }
    :host([data-narrow]) .reset-position { display: none; }
    :host([data-narrow]) .controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    :host([data-narrow]) .query { grid-column: 1 / -1; }
  </style>
  <button class="toggle" type="button" aria-expanded="false">本地搜索</button>
  <section class="panel" hidden aria-label="未知伤亡维基本地搜索">
    <header class="header">
      <span class="heading drag-handle" role="button" tabindex="0" title="拖动搜索面板；方向键移动，Shift 加方向键微调">插入维基链接</span>
      <button class="icon reload-startup" type="button" title="重新加载页面" hidden>重新加载</button>
      <button class="icon configure" type="button" title="配置 Data 代码检索字段" hidden>⚙</button>
      <button class="icon maintenance-toggle" type="button" title="本地数据与维护" aria-expanded="false">▤</button>
      <button class="icon refresh" type="button" title="重新同步本地数据">↻</button>
      <button class="icon reset-position" type="button" title="恢复默认位置">恢复默认位置</button>
      <button class="icon close" type="button" title="关闭">✕</button>
    </header>
    <div class="controls">
      <input class="query" type="search" autocomplete="off" placeholder="标题、片段或英文中缀" aria-label="搜索页面标题">
      <select class="mode" aria-label="搜索类型">
        <option value="title">页面标题</option>
        <option value="content">页面正文</option>
        <option value="data-code">Data 代码</option>
        <option value="lua">Lua 模块</option>
        <option value="files">文件资源</option>
      </select>
      <select class="namespace" aria-label="筛选命名空间"><option value="">全部命名空间</option></select>
    </div>
    <div class="panel-body">
    <section class="highlight-settings" hidden aria-label="命中高亮设置">
      <label class="highlight-option"><input class="title-highlight-toggle" type="checkbox">标题命中高亮</label>
      <input class="highlight-color title-highlight-color" type="color" value="#aee2ff" aria-label="标题高亮颜色" title="标题命中高亮颜色">
      <label class="highlight-option"><input class="content-highlight-toggle" type="checkbox" checked>正文命中高亮</label>
      <input class="highlight-color content-highlight-color" type="color" value="#fff3a3" aria-label="正文高亮颜色" title="正文命中高亮颜色">
      <span class="settings-help">命中的字词按上述颜色标注；仅作用于“页面正文”模式。</span>
    </section>
    <section class="settings" hidden>
      <label class="settings-label" for="cu-data-rules">Data 代码检索字段</label>
      <textarea class="data-rules" id="cu-data-rules" spellcheck="false" aria-label="Data 代码检索字段"></textarea>
      <span class="settings-help">每行“类型 = 路径”；所选路径的标量值用于查找顶层 id 代码名，英文 id 本身始终可搜索。支持 []、*、**；保存后刷新 Data 代码缓存，不影响页面正文。</span>
      <div class="settings-actions">
        <button class="settings-action reset-rules" type="button">恢复默认</button>
        <button class="settings-action save-rules" type="button">保存并刷新</button>
      </div>
    </section>
    <section class="maintenance" hidden aria-label="本地数据与维护">
      <h2 class="maintenance-title">本地数据与维护</h2>
      <pre class="maintenance-output">尚未读取诊断</pre>
      <div class="maintenance-actions">
        <button class="maintenance-action rebuild-indexes" type="button">重建搜索索引</button>
        <button class="maintenance-action rebuild-content-queue" type="button">重建正文队列</button>
        <button class="maintenance-action reconcile-now" type="button">立即全量对账 <span class="network-note">（需要联网）</span></button>
        <button class="maintenance-action clear-snapshots" type="button">清除索引快照</button>
        <button class="maintenance-action request-persistence" type="button">申请持久保存</button>
      </div>
      <div class="danger-zone">
        <button class="maintenance-action danger reveal-danger" type="button">高级危险操作</button>
        <div class="danger-confirmation" hidden>
          <span class="danger-copy">清空页面、正文、文件、Data 缓存、队列、同步游标和快照；不会修改 wiki 页面。下次搜索需要重新联网同步。</span>
          <label class="reset-rules-option"><input class="reset-data-rules" type="checkbox"> 同时恢复默认 Data 字段规则</label>
          <button class="maintenance-action danger reset-local" type="button">确认清空本地镜像</button>
        </div>
      </div>
    </section>
    <ul class="results"><li class="message">输入标题关键词开始搜索</li></ul>
    <pre class="status-details" id="cu-status-details" tabindex="0" hidden>正在启动…</pre>
    </div>
    <footer class="footer"><span class="status">正在启动…</span><button class="status-details-toggle" type="button" aria-expanded="false" aria-controls="cu-status-details" hidden>查看完整状态</button><span><kbd>Alt</kbd> + <kbd>K</kbd></span></footer>
  </section>
`;
