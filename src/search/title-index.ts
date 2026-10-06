// SPDX-License-Identifier: MPL-2.0
import MiniSearch, {
  type AsPlainObject,
  type Options,
  type SearchResult,
} from 'minisearch';

import type { Analyzer } from '../analyzer/analyzer';
import {
  browserTaskScheduler,
  type CooperativeTaskScheduler,
} from '../runtime/cooperative-task-scheduler';
import type { NamespaceInfo, PageRecord, RedirectTarget } from '../types';
import { currentRedirectResolution } from '../redirect';
import { ConcurrentRebuildLifecycle } from './rebuild-lifecycle';

interface IndexedTitle extends RedirectSearchMetadata {
  id: number;
  title: string;
  normalizedTitle: string;
  namespace: number;
  namespaceName: string;
  tokens: string;
}

interface TitleIndexState {
  miniSearch: MiniSearch<IndexedTitle>;
  compactTitleById: Map<number, string>;
}

interface RedirectSearchMetadata {
  isRedirect?: boolean;
  redirectResolved?: boolean;
  redirectTarget?: RedirectTarget;
}

export interface TitleSearchResult extends RedirectSearchMetadata {
  id: number;
  title: string;
  namespace: number;
  namespaceName: string;
  score: number;
}

export interface TitleSearchBackend {
  search(
    query: string,
    namespace?: number,
    limit?: number,
  ): TitleSearchResult[];
  readonly size: number;
}

interface LinearTitle extends RedirectSearchMetadata {
  id: number;
  title: string;
  namespace: number;
  namespaceName: string;
  localSeq: number;
  compactTitle: string;
}

/**
 * Small synchronous fallback used while the richer MiniSearch/jieba index is
 * built during an idle period. The title corpus is only a few thousand rows,
 * so a linear substring scan is both faster to initialise and still cheap per
 * keystroke.
 */
export class LinearTitleIndex implements TitleSearchBackend {
  private readonly titles = new Map<number, LinearTitle>();

  constructor(
    private readonly analyzer: Analyzer,
    pages: PageRecord[],
  ) {
    this.update(pages);
  }

  update(pages: PageRecord[]): void {
    for (const page of pages) {
      if (page.deleted) {
        this.titles.delete(page.id);
        continue;
      }
      this.titles.set(page.id, {
        id: page.id,
        title: page.title,
        namespace: page.namespace,
        namespaceName: page.namespaceName,
        localSeq: page.localSeq,
        compactTitle: this.analyzer.compactNormalized(page.normalizedTitle),
        ...redirectSearchMetadata(page),
      });
    }
  }

  namespaceSummary(): NamespaceInfo[] {
    const latestByNamespace = new Map<number, LinearTitle>();
    for (const title of this.titles.values()) {
      const previous = latestByNamespace.get(title.namespace);
      if (
        !previous ||
        title.localSeq > previous.localSeq ||
        (title.localSeq === previous.localSeq && title.id > previous.id)
      ) {
        latestByNamespace.set(title.namespace, title);
      }
    }
    return [...latestByNamespace.values()]
      .map(({ namespace: id, namespaceName }) => ({
        id,
        name: namespaceName || '（主）',
      }))
      .sort((left, right) => left.id - right.id);
  }

  search(query: string, namespace?: number, limit = 20): TitleSearchResult[] {
    const normalizedQuery = this.analyzer.normalize(query);
    if (!normalizedQuery) return [];
    const compactQuery = this.analyzer.compactNormalized(normalizedQuery);
    if (!compactQuery) return [];

    const matches: TitleSearchResult[] = [];
    for (const {
      id,
      title,
      namespace: pageNamespace,
      namespaceName,
      localSeq: _localSeq,
      compactTitle,
      ...redirect
    } of this.titles.values()) {
      if (namespace !== undefined && pageNamespace !== namespace) continue;
      const position = compactTitle.indexOf(compactQuery);
      if (position < 0) continue;

      let score = 10_000 - position * 10 - compactTitle.length;
      if (compactTitle === compactQuery) score += 1_000_000;
      else if (position === 0) score += 100_000;
      matches.push({
        id,
        title,
        namespace: pageNamespace,
        namespaceName,
        score,
        ...redirect,
      });
    }
    return matches
      .sort((left, right) => right.score - left.score || left.id - right.id)
      .slice(0, limit);
  }

  get size(): number {
    return this.titles.size;
  }
}

export class CombinedTitleIndex implements TitleSearchBackend {
  constructor(
    private readonly primary: TitleSearchBackend,
    private readonly fallback: TitleSearchBackend,
  ) {}

  search(query: string, namespace?: number, limit = 20): TitleSearchResult[] {
    const merged = new Map<number, TitleSearchResult>();
    for (const result of [
      ...this.primary.search(query, namespace, limit),
      ...this.fallback.search(query, namespace, limit),
    ]) {
      const previous = merged.get(result.id);
      if (!previous || result.score > previous.score)
        merged.set(result.id, result);
    }
    return [...merged.values()]
      .sort((left, right) => right.score - left.score || left.id - right.id)
      .slice(0, limit);
  }

  get size(): number {
    return this.primary.size;
  }
}

export class TitleIndex implements TitleSearchBackend {
  private readonly lifecycle = new ConcurrentRebuildLifecycle<
    TitleIndexState,
    PageRecord[]
  >(
    this.createState(),
    (state, pages) => this.applyPages(state, pages),
    (pages) => pages.map((page) => ({ ...page })),
  );

  constructor(
    private readonly analyzer: Analyzer,
    private readonly taskScheduler: Pick<
      CooperativeTaskScheduler,
      'yield'
    > = browserTaskScheduler,
  ) {}

  rebuild(pages: PageRecord[]): void {
    const nextState = this.createState();
    this.applyPages(nextState, pages);
    this.lifecycle.rebuild(nextState);
  }

  async rebuildAsync(pages: PageRecord[], batchSize = 5): Promise<void> {
    await this.lifecycle.rebuildAsync(async () => {
      const nextState = this.createState();
      const activePages = pages.filter((page) => !page.deleted);
      for (let offset = 0; offset < activePages.length; offset += batchSize) {
        this.applyPages(
          nextState,
          activePages.slice(offset, offset + batchSize),
        );
        await this.taskScheduler.yield();
      }
      return nextState;
    });
  }

  update(pages: PageRecord[]): void {
    this.lifecycle.update(pages);
  }

  private applyPages(state: TitleIndexState, pages: PageRecord[]): void {
    const index = state.miniSearch;
    for (const page of pages) {
      state.compactTitleById.delete(page.id);
      if (page.deleted) {
        if (index.has(page.id)) index.discard(page.id);
        continue;
      }
      const document = this.toDocument(page);
      if (index.has(page.id)) index.replace(document);
      else index.add(document);
    }
  }

  async updateAsync(pages: PageRecord[], batchSize = 5): Promise<void> {
    for (let offset = 0; offset < pages.length; offset += batchSize) {
      this.update(pages.slice(offset, offset + batchSize));
      await this.taskScheduler.yield();
    }
  }

  exportSnapshot(): unknown {
    return { miniSearch: this.lifecycle.current.miniSearch.toJSON() };
  }

  async importSnapshot(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== 'object' || !('miniSearch' in payload)) {
      throw new Error('标题快照 payload 结构无效');
    }
    await this.lifecycle.rebuildAsync(async () =>
      this.createState(
        await MiniSearch.loadJSAsync<IndexedTitle>(
          payload.miniSearch as AsPlainObject,
          this.indexOptions(),
        ),
      ),
    );
  }

  search(query: string, namespace?: number, limit = 20): TitleSearchResult[] {
    const normalizedQuery = this.analyzer.normalize(query);
    if (!normalizedQuery) return [];
    const terms = this.analyzer.queryTokens(normalizedQuery);
    if (!terms.length) return [];
    const queryCjk = this.analyzer.cjkOf(normalizedQuery);
    const shortCjkOnly =
      queryCjk.length > 0 &&
      queryCjk.length <= 2 &&
      this.analyzer.compactNormalized(normalizedQuery) === queryCjk;

    const options = {
      prefix: true,
      fuzzy: (term: string): number => {
        const cjk = this.analyzer.cjkOf(term);
        return cjk ? (cjk.length >= 3 ? 1 : 0) : term.length >= 4 ? 1 : 0;
      },
      combineWith: 'AND' as const,
      tokenize: (value: string): string[] => this.analyzer.queryTokens(value),
      processTerm: (term: string): string => term,
      filter: (result: SearchResult): boolean =>
        namespace === undefined || result.namespace === namespace,
    };
    const state = this.lifecycle.current;
    let results = state.miniSearch.search(normalizedQuery, options);
    if (!results.length && terms.length > 1 && !shortCjkOnly) {
      results = state.miniSearch.search(normalizedQuery, {
        ...options,
        combineWith: 'OR',
      });
    }

    const compactQuery = this.analyzer.compact(normalizedQuery);
    return results
      .map((result) => {
        const id = Number(result.id);
        const title = String(result.title);
        let compactTitle = state.compactTitleById.get(id);
        if (compactTitle === undefined) {
          compactTitle = this.analyzer.compact(title);
          state.compactTitleById.set(id, compactTitle);
        }
        let boost = 1;
        if (compactTitle === compactQuery) boost = 100;
        else if (compactTitle.startsWith(compactQuery)) boost = 10;
        else if (compactTitle.includes(compactQuery)) boost = 3;
        return {
          id,
          title,
          namespace: Number(result.namespace),
          namespaceName: String(result.namespaceName),
          score: result.score * boost,
          ...(result.isRedirect
            ? {
                isRedirect: true,
                redirectResolved: Boolean(result.redirectResolved),
                redirectTarget: result.redirectTarget as
                  RedirectTarget | undefined,
              }
            : {}),
        };
      })
      .sort((left, right) => right.score - left.score || left.id - right.id)
      .slice(0, limit);
  }

  get size(): number {
    return this.lifecycle.current.miniSearch.documentCount;
  }

  private createState(
    miniSearch = new MiniSearch<IndexedTitle>(this.indexOptions()),
  ): TitleIndexState {
    return { miniSearch, compactTitleById: new Map() };
  }

  private indexOptions(): Options<IndexedTitle> {
    return {
      idField: 'id',
      fields: ['tokens'],
      storeFields: [
        'title',
        'normalizedTitle',
        'namespace',
        'namespaceName',
        'isRedirect',
        'redirectResolved',
        'redirectTarget',
      ],
      tokenize: (value) => value.split(/\s+/),
      processTerm: (term) => term,
    };
  }

  private toDocument(page: PageRecord): IndexedTitle {
    return {
      id: page.id,
      title: page.title,
      normalizedTitle: page.normalizedTitle,
      namespace: page.namespace,
      namespaceName: page.namespaceName,
      // Re-normalising the source title is deliberate. Besides accepting old
      // database rows, this is the browser-tested path for the WASM segmenter.
      tokens: this.analyzer.documentTokens(page.title).join(' '),
      ...redirectSearchMetadata(page),
    };
  }
}

function redirectSearchMetadata(page: PageRecord): RedirectSearchMetadata {
  if (!page.isRedirect) return {};
  const resolution = currentRedirectResolution(page);
  return {
    isRedirect: true,
    redirectResolved: Boolean(resolution),
    redirectTarget: resolution?.target,
  };
}
