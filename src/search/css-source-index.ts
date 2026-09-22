// SPDX-License-Identifier: MPL-2.0
import { browserTaskScheduler, type CooperativeTaskScheduler } from '../runtime/cooperative-task-scheduler';
import type { WikiSearchDatabase } from '../storage/database';
import { readLocalSequence } from '../storage/sync-state';
import { isCssContentModel } from '../sync/content-job-policy';
import type { PageRecord } from '../types';
import type { SearchTextHighlight } from './content-index';

export interface CssSourceMatch {
  line: number;
  text: string;
  highlights: SearchTextHighlight[];
}

export interface CssSearchResult {
  kind: 'css';
  id: number;
  title: string;
  namespace: number;
  namespaceName: string;
  matches: CssSourceMatch[];
}

interface CssSource extends Omit<CssSearchResult, 'kind' | 'matches'> {
  source: string;
  lineStarts: number[];
}

/** Literal source search; neither a selector parser nor an index of active styles. */
export class CssSourceIndex {
  private sources = new Map<number, CssSource>();
  private throughLocalSeq = -1;
  private refreshing?: Promise<void>;

  constructor(private readonly scheduler: Pick<CooperativeTaskScheduler, 'yield'> = browserTaskScheduler) {}

  refresh(database: WikiSearchDatabase, force = false): Promise<void> {
    if (this.refreshing) return this.refreshing.then(() => this.refresh(database, force));
    const attempt = this.readChanges(database, force);
    const tracked = attempt.finally(() => { if (this.refreshing === tracked) this.refreshing = undefined; });
    this.refreshing = tracked;
    return tracked;
  }

  private async readChanges(database: WikiSearchDatabase, force: boolean): Promise<void> {
    const { sequence, changes } = await database.transaction('r', database.pages, database.fileResources, database.syncState, async () => {
      const sequence = await readLocalSequence(database);
      const changes: Array<PageRecord | { id: number }> = [];
      const rows = force || this.throughLocalSeq < 0
        ? database.pages.toCollection()
        : database.pages.where('localSeq').above(this.throughLocalSeq);
      await rows.each((page) => {
        if (eligible(page)) changes.push(page);
        else if (this.sources.has(page.id)) changes.push({ id: page.id });
      });
      return { sequence, changes };
    });
    const next = force ? new Map<number, CssSource>() : new Map(this.sources);
    for (let offset = 0; offset < changes.length; offset += 20) {
      for (const page of changes.slice(offset, offset + 20)) {
        if (!('content' in page) || typeof page.content !== 'string') { next.delete(page.id); continue; }
        const source = page.content;
        const lineStarts = [0];
        for (const match of source.matchAll(/\r\n|\r|\n/g)) lineStarts.push(match.index + match[0].length);
        next.set(page.id, { id: page.id, title: page.title, namespace: page.namespace,
          namespaceName: page.namespaceName, source, lineStarts });
      }
      await this.scheduler.yield();
    }
    this.sources = next;
    this.throughLocalSeq = sequence;
  }

  search(query: string, limit = 20): CssSearchResult[] {
    if (!query.trim()) return [];
    const results: CssSearchResult[] = [];
    // Linear literal scan is intentional: CSS stays independent of natural-language tokenization.
    for (const page of this.sources.values()) {
      const matches: CssSourceMatch[] = [];
      let position = page.source.indexOf(query);
      while (position >= 0 && matches.length < 3) {
        const lineIndex = sourceLine(page.lineStarts, position);
        const start = Math.max(page.lineStarts[lineIndex]!, position - 60);
        const end = Math.min(page.source.length, start + 240, Math.max(position + query.length, page.lineStarts[lineIndex + 2] ?? page.source.length));
        matches.push({ line: lineIndex + 1, text: page.source.slice(start, end),
          highlights: [{ start: position - start, end: Math.min(end, position + query.length) - start }] });
        position = page.source.indexOf(query, position + query.length);
      }
      if (matches.length) results.push({ kind: 'css', id: page.id, title: page.title,
        namespace: page.namespace, namespaceName: page.namespaceName, matches });
    }
    return results.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : a.id - b.id)).slice(0, limit);
  }

  get size(): number { return this.sources.size; }
}

function eligible(page: PageRecord): boolean {
  return !page.deleted && !page.isRedirect && isCssContentModel(page.contentModel) &&
    typeof page.content === 'string' && page.contentRevisionId === page.revisionId;
}

function sourceLine(starts: number[], position: number): number {
  let lower = 0;
  let upper = starts.length;
  while (lower + 1 < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (starts[middle]! <= position) lower = middle;
    else upper = middle;
  }
  return lower;
}
