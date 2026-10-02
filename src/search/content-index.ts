// SPDX-License-Identifier: MPL-2.0
import MiniSearch, {
  type AsPlainObject,
  type Options,
  type SearchResult,
} from 'minisearch';

import type { Analyzer } from '../analyzer/analyzer';
import { extractContent } from '../content/extract-content';
import {
  browserTaskScheduler,
  type CooperativeTaskScheduler,
} from '../runtime/cooperative-task-scheduler';
import type { PageRecord } from '../types';
import { ConcurrentRebuildLifecycle } from './rebuild-lifecycle';

interface IndexedContent {
  id: number;
  title: string;
  normalizedTitle: string;
  namespace: number;
  namespaceName: string;
  tokens: string;
}

export interface SearchTextHighlight {
  start: number;
  end: number;
}

export interface ContentSearchResult {
  kind: 'content';
  id: number;
  title: string;
  namespace: number;
  namespaceName: string;
  snippet: string;
  score: number;
  /** Hit ranges inside `snippet`, sharing its coordinate space. */
  highlights?: readonly SearchTextHighlight[];
  /** Hit ranges inside `title`, only produced when the whole query is locatable in the original title. */
  titleHighlights?: readonly SearchTextHighlight[];
}

interface ContentIndexState {
  index: MiniSearch<IndexedContent>;
  extractedById: Map<number, string>;
  normalizedById: Map<number, string>;
  /** UTF-16 text payload estimate; excludes Map and other object overhead. */
  normalizedTextBytes: number;
}

const MAX_NORMALIZED_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_NORMALIZED_TEXT_ENTRIES = 128;

export class ContentIndex {
  private readonly lifecycle = new ConcurrentRebuildLifecycle<
    ContentIndexState,
    PageRecord[]
  >(
    this.createState(),
    (state, pages) => this.applyPages(state, pages),
    (pages) => pages.map((page) => ({ ...page })),
  );

  constructor(
    private readonly analyzer: Analyzer,
    private readonly taskScheduler: Pick<CooperativeTaskScheduler, 'yield'> =
      browserTaskScheduler,
  ) {}

  rebuild(pages: PageRecord[]): void {
    const nextState = this.createState();
    this.applyPages(nextState, pages);
    this.lifecycle.rebuild(nextState);
  }

  async rebuildAsync(pages: PageRecord[], batchSize = 2): Promise<void> {
    await this.lifecycle.rebuildAsync(async () => {
      const nextState = this.createState();
      for (let offset = 0; offset < pages.length; offset += batchSize) {
        this.applyPages(nextState, pages.slice(offset, offset + batchSize));
        await this.taskScheduler.yield();
      }
      return nextState;
    });
  }

  update(pages: PageRecord[]): void {
    this.lifecycle.update(pages);
  }

  private applyPages(
    state: ContentIndexState,
    pages: PageRecord[],
  ): void {
    const { index, extractedById } = state;
    for (const page of pages) {
      this.removeNormalizedText(state, page.id);
      const document = this.toDocument(page, extractedById);
      if (!document) {
        if (index.has(page.id)) index.discard(page.id);
        extractedById.delete(page.id);
      } else if (index.has(page.id)) {
        index.replace(document);
      } else {
        index.add(document);
      }
    }
  }

  async updateAsync(pages: PageRecord[], batchSize = 2): Promise<void> {
    for (let offset = 0; offset < pages.length; offset += batchSize) {
      this.update(pages.slice(offset, offset + batchSize));
      await this.taskScheduler.yield();
    }
  }

  exportSnapshot(): unknown {
    const { index, extractedById } = this.lifecycle.current;
    return {
      miniSearch: index.toJSON(),
      extractedById: [...extractedById],
    };
  }

  async importSnapshot(payload: unknown): Promise<void> {
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('miniSearch' in payload) ||
      !('extractedById' in payload) ||
      !isStringMapEntries(payload.extractedById)
    ) {
      throw new Error('正文快照 payload 结构无效');
    }
    const extractedEntries = payload.extractedById;
    await this.lifecycle.rebuildAsync(async () => {
      const restoredExtractedById = new Map<number, string>();
      for (const [id, extracted] of extractedEntries) {
        restoredExtractedById.set(id, extracted);
      }
      const restored = await MiniSearch.loadJSAsync<IndexedContent>(
        payload.miniSearch as AsPlainObject,
        this.indexOptions(),
      );
      if (restoredExtractedById.size !== restored.documentCount) {
        throw new Error('正文快照摘要数量不一致');
      }
      return {
        index: restored,
        extractedById: restoredExtractedById,
        normalizedById: new Map<number, string>(),
        normalizedTextBytes: 0,
      };
    });
  }

  search(query: string, namespace?: number, limit = 20): ContentSearchResult[] {
    const normalizedQuery = this.analyzer.normalize(query);
    if (!normalizedQuery) return [];
    const terms = this.analyzer.queryTokens(normalizedQuery);
    if (!terms.length) return [];
    const options = {
      prefix: true,
      combineWith: 'AND' as const,
      tokenize: (value: string): string[] => this.analyzer.queryTokens(value),
      processTerm: (term: string): string => term,
      filter: (result: SearchResult): boolean =>
        namespace === undefined || result.namespace === namespace,
    };
    const state = this.lifecycle.current;
    const { index, extractedById } = state;
    let results = index.search(normalizedQuery, options);
    if (!results.length && terms.length > 1) {
      results = index.search(normalizedQuery, { ...options, combineWith: 'OR' });
    }

    const compactQuery = this.analyzer.compactNormalized(normalizedQuery);
    return results
      .map((result) => {
        const title = String(result.title);
        const compactTitle = this.analyzer.compactNormalized(
          String(result.normalizedTitle),
        );
        const titleBoost = compactTitle.includes(compactQuery) ? 3 : 1;
        return {
          kind: 'content' as const,
          id: Number(result.id),
          title,
          namespace: Number(result.namespace),
          namespaceName: String(result.namespaceName),
          score: result.score * titleBoost,
        };
      })
      .sort((left, right) => right.score - left.score || left.id - right.id)
      .slice(0, limit)
      .map((result) => {
        const snippet = makeSnippet(
          extractedById.get(result.id) ?? '',
          normalizedQuery,
          (text) => this.normalizedTextFor(state, result.id, text),
          terms,
        );
        return {
          ...result,
          snippet: snippet.text,
          highlights: snippet.highlights,
          titleHighlights: titleHighlights(result.title, normalizedQuery),
        };
      });
  }

  get size(): number {
    return this.lifecycle.current.index.documentCount;
  }

  private createState(): ContentIndexState {
    return {
      index: this.createIndex(),
      extractedById: new Map<number, string>(),
      normalizedById: new Map<number, string>(),
      normalizedTextBytes: 0,
    };
  }

  private normalizedTextFor(
    state: ContentIndexState,
    id: number,
    text: string,
  ): string {
    if (state.normalizedById.has(id)) {
      const normalized = state.normalizedById.get(id)!;
      state.normalizedById.delete(id);
      state.normalizedById.set(id, normalized);
      return normalized;
    }

    const normalized = this.analyzer.normalize(text);
    const bytes = normalized.length * 2;
    if (bytes > MAX_NORMALIZED_TEXT_BYTES) return normalized;

    while (
      state.normalizedById.size >= MAX_NORMALIZED_TEXT_ENTRIES ||
      state.normalizedTextBytes + bytes > MAX_NORMALIZED_TEXT_BYTES
    ) {
      this.removeNormalizedText(state, state.normalizedById.keys().next().value!);
    }
    state.normalizedById.set(id, normalized);
    state.normalizedTextBytes += bytes;
    return normalized;
  }

  private removeNormalizedText(state: ContentIndexState, id: number): void {
    const previous = state.normalizedById.get(id);
    if (previous === undefined) return;
    state.normalizedById.delete(id);
    state.normalizedTextBytes -= previous.length * 2;
  }

  private createIndex(): MiniSearch<IndexedContent> {
    return new MiniSearch<IndexedContent>(this.indexOptions());
  }

  private indexOptions(): Options<IndexedContent> {
    return {
      idField: 'id',
      fields: ['tokens'],
      storeFields: ['title', 'normalizedTitle', 'namespace', 'namespaceName'],
      tokenize: (value) => value.split(/\s+/),
      processTerm: (term) => term,
    };
  }

  private toDocument(
    page: PageRecord,
    extractedById: Map<number, string>,
  ): IndexedContent | undefined {
    if (
      page.deleted ||
      page.isRedirect ||
      typeof page.content !== 'string'
    ) {
      return undefined;
    }
    const extracted = extractContent(page.contentModel, page.content);
    if (!extracted) return undefined;
    extractedById.set(page.id, extracted);
    return {
      id: page.id,
      title: page.title,
      normalizedTitle: page.normalizedTitle,
      namespace: page.namespace,
      namespaceName: page.namespaceName,
      tokens: this.analyzer.documentTokens(extracted).join(' '),
    };
  }
}

function isStringMapEntries(value: unknown): value is Array<[number, string]> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'number' &&
        typeof entry[1] === 'string',
    )
  );
}

interface Snippet {
  text: string;
  highlights: SearchTextHighlight[];
}

const SNIPPET_CONTEXT_BEFORE = 36;
const SNIPPET_CONTEXT_AFTER = 64;
const MAX_HIGHLIGHT_RANGES = 6;

function makeSnippet(
  text: string,
  normalizedQuery: string,
  normalizeText: (text: string) => string,
  matchedTerms: readonly string[],
): Snippet {
  const compactText = text.replace(/\s+/g, ' ').trim();
  if (!compactText) return { text: '', highlights: [] };
  const directPosition = compactText.indexOf(normalizedQuery);
  const insensitiveMatch =
    directPosition < 0
      ? new RegExp(escapeRegExp(normalizedQuery), 'iu').exec(compactText)
      : undefined;
  const originalPosition =
    directPosition >= 0 ? directPosition : (insensitiveMatch?.index ?? -1);
  if (originalPosition >= 0) {
    const matchLength =
      directPosition >= 0 ? normalizedQuery.length : insensitiveMatch![0].length;
    const start = Math.max(0, originalPosition - SNIPPET_CONTEXT_BEFORE);
    const end = Math.min(
      compactText.length,
      originalPosition + matchLength + SNIPPET_CONTEXT_AFTER,
    );
    const prefix = start > 0 ? '…' : '';
    const matchStart = prefix.length + (originalPosition - start);
    return {
      text: `${prefix}${compactText.slice(start, end)}${end < compactText.length ? '…' : ''}`,
      highlights: [{ start: matchStart, end: matchStart + matchLength }],
    };
  }
  const normalizedText = normalizeText(compactText);
  const displayText = normalizedText || compactText;
  const position = normalizedText.indexOf(normalizedQuery);
  let anchor =
    position >= 0
      ? { start: position, end: position + normalizedQuery.length }
      : undefined;
  if (!anchor) {
    for (const term of matchedTerms) {
      if (!term) continue;
      const at = displayText.indexOf(term);
      if (
        at >= 0 &&
        (!anchor || at < anchor.start || (at === anchor.start && term.length > anchor.end - anchor.start))
      ) {
        anchor = { start: at, end: at + term.length };
      }
    }
  }
  const start = Math.max(0, (anchor?.start ?? 0) - SNIPPET_CONTEXT_BEFORE);
  const end = Math.min(
    displayText.length,
    (anchor?.end ?? 0) + SNIPPET_CONTEXT_AFTER,
  );
  const prefixLength = start > 0 ? 1 : 0;
  const highlights =
    position >= 0
      ? [{ start: prefixLength + position - start, end: prefixLength + position - start + normalizedQuery.length }]
      : collectTermHighlights(displayText.slice(start, end), matchedTerms).map(
          (range) => ({
            start: range.start + prefixLength,
            end: range.end + prefixLength,
          }),
        );
  return {
    text: `${start > 0 ? '…' : ''}${displayText.slice(start, end)}${end < displayText.length ? '…' : ''}`,
    highlights,
  };
}

function titleHighlights(title: string, normalizedQuery: string): SearchTextHighlight[] {
  // Titles must keep their original text, and normalization (NFKC/OpenCC) is not
  // an invertible mapping — so only a direct case-insensitive hit is highlighted.
  const match = new RegExp(escapeRegExp(normalizedQuery), 'iu').exec(title);
  if (!match) return [];
  return [{ start: match.index, end: match.index + match[0].length }];
}

function collectTermHighlights(
  text: string,
  terms: readonly string[],
): SearchTextHighlight[] {
  const ranges: SearchTextHighlight[] = [];
  for (const term of terms) {
    if (!term) continue;
    let cursor = 0;
    while (true) {
      const at = text.indexOf(term, cursor);
      if (at < 0) break;
      ranges.push({ start: at, end: at + term.length });
      cursor = at + 1;
    }
  }
  return mergeRanges(ranges).slice(0, MAX_HIGHLIGHT_RANGES);
}

function mergeRanges(ranges: SearchTextHighlight[]): SearchTextHighlight[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: SearchTextHighlight[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
