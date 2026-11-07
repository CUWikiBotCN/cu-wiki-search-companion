// SPDX-License-Identifier: MPL-2.0
import type { Analyzer } from '../analyzer/analyzer';
import {
  SectionTitleIndex,
  type SectionSearchResult,
} from '../search/section-title-index';
import { parseSectionQuery } from '../search/section-query';
import type { WikiSearchDatabase } from '../storage/database';
import { SectionLinkPreparation } from './section-link-preparation';

export interface SectionSearchIntent {
  active: boolean;
  query: string;
  namespace?: number;
  pageId?: number;
}

export interface SectionLinkLookup {
  resolve(result: SectionSearchResult): Promise<ReadonlyMap<string, string>>;
  getFragment(result: SectionSearchResult): string | undefined;
  needsRefresh?(result: SectionSearchResult): boolean;
  invalidate(): void;
}

export interface SectionSearchRuntimeOptions {
  database: WikiSearchDatabase;
  analyzer: Analyzer;
  links?: SectionLinkLookup;
  synchronize(
    pageIds?: readonly number[],
    shouldRun?: () => boolean,
    onStarted?: () => void,
  ): Promise<void>;
  titleBaselineReady(): boolean;
  changed(): void;
}

/** Owns optional local sections and explicit page intent; matching remains synchronous. */
export class SectionSearchRuntime {
  private index?: SectionTitleIndex;
  private preparing?: Promise<void>;
  private prepared = false;
  private actionsValid = true;
  private refreshGeneration = 0;
  private intent: SectionSearchIntent = { active: false, query: '' };
  private intentKey = '';
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private autoAttempts = new Set<string>();
  private activeAutomatic = false;
  private pendingAutomatic = false;
  private destroyed = false;
  private message = '';
  private messageVersion = 0;
  private readonly linkPreparation?: SectionLinkPreparation;

  constructor(private readonly options: SectionSearchRuntimeOptions) {
    if (options.links)
      this.linkPreparation = new SectionLinkPreparation({
        links: options.links,
        current: (result) => this.sourceCurrent(result),
        needed: (result) =>
          Boolean(
            this.index
              ?.getPage(result.id)
              ?.sections.find((section) => section.localId === result.sectionId)
              ?.needsResolution,
          ) &&
          (options.links!.needsRefresh?.(result) ??
            !options.links!.getFragment(result)),
        changed: () => {
          if (!this.destroyed) options.changed();
        },
      });
  }

  prefetch(
    results: SectionSearchResult[],
    preferred?: SectionSearchResult,
  ): void {
    if (this.destroyed || !this.intent.active) return;
    const parsed = parseSectionQuery(this.intent.query);
    const exact =
      this.intent.pageId !== undefined ||
      (parsed.hasSeparator &&
        this.options.titleBaselineReady() &&
        Boolean(
          this.index?.findExactPage(parsed.pageQuery, this.intent.namespace),
        ));
    this.linkPreparation?.update(results, preferred, exact);
  }

  prepare(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (this.preparing) return this.preparing;
    if (this.prepared && this.actionsValid) return Promise.resolve();
    this.index ??= new SectionTitleIndex(this.options.analyzer);
    const index = this.index;
    const generation = this.refreshGeneration;
    const attempt = index.refresh(this.options.database).then(() => {
      if (this.destroyed) return;
      this.prepared = true;
      if (generation === this.refreshGeneration) this.actionsValid = true;
      this.options.changed();
    });
    const tracked = attempt.finally(() => {
      if (this.preparing === tracked) this.preparing = undefined;
    });
    this.preparing = tracked;
    return tracked;
  }

  invalidateActions(): void {
    if (!this.index) return;
    this.actionsValid = false;
    this.refreshGeneration += 1;
    this.linkPreparation?.clear();
  }

  async refresh(force = false): Promise<void> {
    if (!this.index || this.destroyed) return;
    this.invalidateActions();
    const generation = this.refreshGeneration;
    if (force) this.options.links?.invalidate();
    await this.index.refresh(this.options.database, force);
    if (this.destroyed) return;
    if (generation === this.refreshGeneration) this.actionsValid = true;
    this.options.changed();
    this.scheduleAutomatic();
  }

  search(
    query: string,
    namespace?: number,
    pageId?: number,
  ): SectionSearchResult[] {
    return (this.index?.search(query, namespace, 20, pageId) ?? []).map(
      (result) => {
        const fragment =
          this.options.links?.getFragment(result) ?? result.fragment;
        return fragment
          ? { ...result, fragment, needsResolution: false }
          : result;
      },
    );
  }

  describe(query: string, namespace?: number, pageId?: number) {
    const parsed = parseSectionQuery(query);
    const coverage = this.index?.coverage(
      namespace,
      parsed.hasSeparator ? parsed.pageQuery : '',
      pageId,
    );
    return {
      ready: this.prepared && !this.preparing,
      message: this.message,
      known: coverage?.known ?? 0,
      covered: coverage?.covered ?? 0,
      missingPages: coverage?.missingPages ?? [],
      uncertainPages: coverage?.uncertainPages ?? 0,
      baselineReady: this.options.titleBaselineReady(),
    };
  }

  setIntent(intent: SectionSearchIntent): void {
    if (this.destroyed) return;
    const key = JSON.stringify(intent);
    if (key === this.intentKey) return;
    const previous = parseSectionQuery(this.intent.query);
    const next = parseSectionQuery(intent.query);
    const sameTarget =
      intent.active &&
      this.intent.active &&
      intent.namespace === this.intent.namespace &&
      intent.pageId === this.intent.pageId &&
      previous.hasSeparator === next.hasSeparator &&
      previous.pageQuery === next.pageQuery;
    this.intentKey = key;
    this.linkPreparation?.clear();
    this.intent = { ...intent };
    this.generation += 1;
    clearTimeout(this.timer);
    if (!sameTarget) {
      this.message = '';
      this.messageVersion += 1;
    }
    if (!intent.active) return;
    void this.prepare()
      .then(() => this.scheduleAutomatic())
      .catch((error) => {
        if (key !== this.intentKey || this.destroyed) return;
        this.message = `小节准备失败：${errorText(error)}`;
        this.options.changed();
      });
  }

  titleBaselineChanged(): void {
    if (!this.intent.active || this.destroyed) return;
    this.options.changed();
    this.scheduleAutomatic();
  }

  private scheduleAutomatic(): void {
    clearTimeout(this.timer);
    if (this.destroyed || !this.intent.active) return;
    this.timer = setTimeout(() => {
      void this.fetchAutomatic();
    }, 500);
  }

  private automaticTarget() {
    if (!this.intent.active || !this.index) return undefined;
    const parsed = parseSectionQuery(this.intent.query);
    if (!parsed.hasSeparator) return undefined;
    const page =
      this.intent.pageId !== undefined
        ? this.index.getPage(this.intent.pageId)
        : this.options.titleBaselineReady() && parsed.pageQuery
          ? this.index.findExactPage(parsed.pageQuery, this.intent.namespace)
          : undefined;
    if (
      !page ||
      (this.intent.namespace !== undefined &&
        page.namespace !== this.intent.namespace)
    )
      return undefined;
    const missing = this.index.coverage(
      this.intent.namespace,
      '',
      page.id,
    ).missingPages;
    return missing.some((value) => value.id === page.id) ? page : undefined;
  }

  private async fetchAutomatic(): Promise<void> {
    if (this.activeAutomatic) {
      this.pendingAutomatic = true;
      return;
    }
    const page = this.automaticTarget();
    if (!page || this.destroyed) return;
    const key = `${page.id}:${page.revisionId}`;
    if (this.autoAttempts.has(key) || this.autoAttempts.size >= 64) return;
    const generation = this.generation;
    const valid = () => {
      const current = this.automaticTarget();
      return (
        !this.destroyed &&
        generation === this.generation &&
        current?.id === page.id &&
        current.revisionId === page.revisionId
      );
    };
    this.activeAutomatic = true;
    const messageVersion = ++this.messageVersion;
    this.message = `正在获取《${page.title}》的小节…`;
    this.options.changed();
    try {
      await this.options.synchronize([page.id], valid, () => {
        this.autoAttempts.add(key);
      });
      await this.refresh();
      if (messageVersion === this.messageVersion) this.message = '';
    } catch (error) {
      if (valid()) this.autoAttempts.add(key);
      if (messageVersion === this.messageVersion)
        this.message = `获取失败，可手动重试：${errorText(error)}`;
    } finally {
      this.activeAutomatic = false;
      if (!this.destroyed) this.options.changed();
      if (this.pendingAutomatic) {
        this.pendingAutomatic = false;
        this.scheduleAutomatic();
      }
    }
  }

  async fetchPage(pageId?: number): Promise<void> {
    if (this.destroyed) return;
    const messageVersion = ++this.messageVersion;
    this.message =
      pageId === undefined ? '正在更新共享正文缓存…' : '正在获取此页正文…';
    this.options.changed();
    try {
      await this.options.synchronize(
        pageId === undefined ? undefined : [pageId],
      );
      await this.refresh();
      if (messageVersion === this.messageVersion) this.message = '';
    } catch (error) {
      if (messageVersion === this.messageVersion)
        this.message = `获取失败，可重试：${errorText(error)}`;
    } finally {
      if (!this.destroyed) this.options.changed();
    }
  }

  async resolve(result: SectionSearchResult): Promise<SectionSearchResult> {
    if (!this.sourceCurrent(result)) throw new Error('小节已更新，请重新选择');
    if (!this.options.links || !this.linkPreparation)
      throw new Error('小节链接准备暂不可用');
    if (!this.options.links.getFragment(result))
      await this.linkPreparation.request(result);
    if (!this.sourceCurrent(result)) throw new Error('小节已更新，请重新选择');
    const fragment = this.options.links.getFragment(result);
    if (!fragment) throw new Error('无法确定此小节链接，可重试或打开所属页面');
    return { ...result, fragment, needsResolution: false };
  }

  private sourceCurrent(result: SectionSearchResult): boolean {
    return this.current({ ...result, fragment: undefined });
  }

  current(result: SectionSearchResult): boolean {
    const page = this.index?.getPage(result.id);
    if (
      this.destroyed ||
      !this.actionsValid ||
      !page?.covered ||
      page.title !== result.title ||
      page.namespace !== result.namespace ||
      (result.sourceSequence !== undefined &&
        page.sourceSequence !== result.sourceSequence) ||
      page.revisionId !== result.revisionId
    )
      return false;
    const section = page.sections.find(
      (value) => value.localId === result.sectionId,
    );
    if (!section) return false;
    if (result.fragment !== undefined) {
      return (
        (!section.needsResolution &&
          section.anchorCandidate === result.fragment) ||
        this.options.links?.getFragment(result) === result.fragment
      );
    }
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.linkPreparation?.destroy();
    this.generation += 1;
    clearTimeout(this.timer);
    this.index?.invalidate();
    this.options.links?.invalidate();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
