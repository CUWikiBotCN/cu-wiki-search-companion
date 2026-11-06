// SPDX-License-Identifier: MPL-2.0
import type { Analyzer } from '../analyzer/analyzer';
import { parseSections, type ParsedSection } from '../content/parse-sections';
import {
  browserTaskScheduler,
  type CooperativeTaskScheduler,
} from '../runtime/cooperative-task-scheduler';
import type { WikiSearchDatabase } from '../storage/database';
import { readLocalSequence } from '../storage/sync-state';
import type { PageRecord } from '../types';
import { parseSectionQuery } from './section-query';

export interface SectionPageMetadata {
  id: number;
  title: string;
  namespace: number;
  namespaceName: string;
  revisionId?: number;
  sourceSequence?: number;
}
export interface SectionPage extends SectionPageMetadata {
  covered: boolean;
  sections: ParsedSection[];
  reasons: string[];
}
export interface SectionSearchResult {
  kind: 'section';
  id: number;
  title: string;
  namespace: number;
  namespaceName: string;
  sectionId: string;
  revisionId: number;
  sourceSequence?: number;
  sectionTitle: string;
  sectionPath: string[];
  occurrence?: number;
  fragment?: string;
  needsResolution: boolean;
  headingStart: number;
  level: number;
}
export interface SectionCoverage {
  known: number;
  covered: number;
  missingPages: SectionPageMetadata[];
  uncertainPages: number;
}
interface IndexedSection {
  parsed: ParsedSection;
  compactTitle: string;
  path: string[];
  occurrence?: number;
}
interface IndexedPage extends SectionPage {
  compactTitle: string;
  indexedSections: IndexedSection[];
}

export class SectionTitleIndex {
  private pages = new Map<number, IndexedPage>();
  private readonly coverageCache = new Map<string, SectionCoverage>();
  private throughLocalSeq = -1;
  private generation = 0;
  private refreshing?: Promise<boolean>;

  constructor(
    private readonly analyzer: Analyzer,
    private readonly scheduler: Pick<
      CooperativeTaskScheduler,
      'yield'
    > = browserTaskScheduler,
  ) {}

  invalidate(): void {
    this.generation += 1;
    this.pages = new Map();
    this.coverageCache.clear();
    this.throughLocalSeq = -1;
  }

  refresh(database: WikiSearchDatabase, force = false): Promise<boolean> {
    if (this.refreshing) {
      const generation = this.generation;
      return this.refreshing.then(() =>
        generation === this.generation ? this.refresh(database, force) : false,
      );
    }
    const attempt = this.readChanges(database, force);
    const tracked = attempt.finally(() => {
      if (this.refreshing === tracked) this.refreshing = undefined;
    });
    this.refreshing = tracked;
    return tracked;
  }

  private async readChanges(
    database: WikiSearchDatabase,
    force: boolean,
  ): Promise<boolean> {
    const generation = this.generation;
    const { sequence, changes } = await database.transaction(
      'r',
      database.pages,
      database.fileResources,
      database.syncState,
      async () => {
        const sequence = await readLocalSequence(database);
        const changes: PageRecord[] = [];
        const rows =
          force || this.throughLocalSeq < 0
            ? database.pages.toCollection()
            : database.pages.where('localSeq').above(this.throughLocalSeq);
        await rows.each((page) => {
          changes.push(page);
        });
        return { sequence, changes };
      },
    );
    if (generation !== this.generation) return false;
    if (!force && !changes.length) {
      this.throughLocalSeq = sequence;
      return false;
    }
    const next = force ? new Map<number, IndexedPage>() : new Map(this.pages);
    for (let offset = 0; offset < changes.length; offset += 20) {
      for (const page of changes.slice(offset, offset + 20)) {
        if (!eligiblePage(page)) {
          next.delete(page.id);
          continue;
        }
        const covered =
          typeof page.content === 'string' &&
          validRevision(page.revisionId) &&
          page.contentRevisionId === page.revisionId;
        const parsed = covered
          ? parseSections(page.content!)
          : { sections: [], reasons: [] };
        const byId = new Map(
          parsed.sections.map((section) => [section.localId, section]),
        );
        const totals = new Map<string, number>();
        const occurrences = new Map<string, number>();
        for (const section of parsed.sections)
          totals.set(
            section.displayTitle,
            (totals.get(section.displayTitle) ?? 0) + 1,
          );
        const indexedSections = parsed.sections.map(
          (section): IndexedSection => {
            const path: string[] = [];
            let parentId = section.parentId;
            while (parentId) {
              const parent = byId.get(parentId);
              if (!parent) break;
              path.unshift(parent.displayTitle);
              parentId = parent.parentId;
            }
            const occurrence = (occurrences.get(section.displayTitle) ?? 0) + 1;
            occurrences.set(section.displayTitle, occurrence);
            return {
              parsed: section,
              compactTitle: this.analyzer.compact(section.displayTitle),
              path,
              ...((totals.get(section.displayTitle) ?? 0) > 1
                ? { occurrence }
                : {}),
            };
          },
        );
        next.set(page.id, {
          id: page.id,
          title: page.title,
          namespace: page.namespace,
          namespaceName: page.namespaceName,
          revisionId: page.revisionId,
          sourceSequence: page.localSeq,
          covered,
          sections: parsed.sections,
          reasons: parsed.reasons,
          compactTitle: this.analyzer.compact(page.title),
          indexedSections,
        });
      }
      await this.scheduler.yield();
      if (generation !== this.generation) return false;
    }
    if (generation !== this.generation) return false;
    this.pages = next;
    this.coverageCache.clear();
    this.throughLocalSeq = sequence;
    return true;
  }

  search(
    query: string,
    namespace?: number,
    limit = 20,
    boundPageId?: number,
  ): SectionSearchResult[] {
    const parts = parseSectionQuery(query);
    if (!parts.pageQuery && !parts.sectionQuery) return [];
    const pageQuery = this.analyzer.compact(parts.pageQuery);
    const sectionQuery = this.analyzer.compact(parts.sectionQuery);
    if (
      (parts.pageQuery && !pageQuery) ||
      (parts.sectionQuery && !sectionQuery)
    )
      return [];
    const rows: Array<{
      result: SectionSearchResult;
      pageRank: number;
      sectionRank: number;
    }> = [];
    for (const page of this.pages.values()) {
      if (
        !page.covered ||
        (namespace !== undefined && page.namespace !== namespace) ||
        (boundPageId !== undefined && page.id !== boundPageId)
      )
        continue;
      const pageRank = rank(page.compactTitle, pageQuery);
      if (pageRank < 0) continue;
      for (const item of page.indexedSections) {
        const sectionRank = rank(item.compactTitle, sectionQuery);
        if (sectionRank < 0) continue;
        const section = item.parsed;
        rows.push({
          pageRank,
          sectionRank,
          result: {
            kind: 'section',
            id: page.id,
            title: page.title,
            namespace: page.namespace,
            namespaceName: page.namespaceName,
            sectionId: section.localId,
            revisionId: page.revisionId!,
            sourceSequence: page.sourceSequence,
            sectionTitle: section.displayTitle,
            sectionPath: [...item.path],
            ...(item.occurrence === undefined
              ? {}
              : { occurrence: item.occurrence }),
            headingStart: section.headingStart,
            level: section.level,
            needsResolution: section.needsResolution,
            ...(section.anchorCandidate === undefined
              ? {}
              : { fragment: section.anchorCandidate }),
          },
        });
      }
    }
    return rows
      .sort(
        (a, b) =>
          a.pageRank - b.pageRank ||
          a.sectionRank - b.sectionRank ||
          compare(a.result.title, b.result.title) ||
          a.result.id - b.result.id ||
          a.result.headingStart - b.result.headingStart,
      )
      .slice(0, Math.max(0, limit))
      .map(({ result }) => result);
  }

  coverage(
    namespace?: number,
    pageQuery = '',
    boundPageId?: number,
  ): SectionCoverage {
    const query = this.analyzer.compact(pageQuery.trim());
    const invalid = Boolean(pageQuery.trim()) && !query;
    const key = JSON.stringify([
      namespace ?? null,
      query,
      invalid,
      boundPageId ?? null,
    ]);
    const cached = this.coverageCache.get(key);
    if (cached) {
      // Bound memory even as users type many distinct fragments.
      this.coverageCache.delete(key);
      this.coverageCache.set(key, cached);
      return copyCoverage(cached);
    }
    const missingPages: SectionPageMetadata[] = [];
    let known = 0,
      covered = 0,
      uncertainPages = 0;
    for (const page of this.pages.values()) {
      if (
        invalid ||
        (namespace !== undefined && page.namespace !== namespace) ||
        (boundPageId !== undefined && page.id !== boundPageId) ||
        rank(page.compactTitle, query) < 0
      )
        continue;
      known += 1;
      if (page.covered) {
        covered += 1;
        if (
          page.reasons.length ||
          page.sections.some((section) => section.needsResolution)
        )
          uncertainPages += 1;
      } else missingPages.push(metadata(page));
    }
    missingPages.sort((a, b) => compare(a.title, b.title) || a.id - b.id);
    const result = { known, covered, missingPages, uncertainPages };
    if (this.coverageCache.size >= 64) {
      const oldest = this.coverageCache.keys().next().value;
      if (oldest !== undefined) this.coverageCache.delete(oldest);
    }
    this.coverageCache.set(key, result);
    return copyCoverage(result);
  }

  getPage(id: number): SectionPage | undefined {
    const page = this.pages.get(id);
    return (
      page && {
        ...metadata(page),
        covered: page.covered,
        sections: page.sections.map((section) => ({ ...section })),
        reasons: [...page.reasons],
      }
    );
  }

  findExactPage(
    title: string,
    namespace?: number,
  ): SectionPageMetadata | undefined {
    const key = canonicalTitle(title);
    if (!key) return undefined;
    let match: IndexedPage | undefined;
    for (const page of this.pages.values()) {
      if (
        (namespace !== undefined && page.namespace !== namespace) ||
        canonicalTitle(page.title) !== key
      )
        continue;
      if (match) return undefined;
      match = page;
    }
    return match ? metadata(match) : undefined;
  }

  get size(): number {
    return [...this.pages.values()].reduce(
      (count, page) => count + page.sections.length,
      0,
    );
  }
}

function validRevision(revision: number | undefined): revision is number {
  return Number.isSafeInteger(revision) && revision! > 0;
}
function eligiblePage(page: PageRecord): boolean {
  return (
    !page.deleted &&
    !page.isRedirect &&
    page.contentModel?.toLowerCase() === 'wikitext'
  );
}
function rank(text: string, query: string): number {
  if (!query) return 0;
  if (text === query) return 0;
  if (text.startsWith(query)) return 1;
  return text.includes(query) ? 2 : -1;
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function metadata(page: SectionPageMetadata): SectionPageMetadata {
  return {
    id: page.id,
    title: page.title,
    namespace: page.namespace,
    namespaceName: page.namespaceName,
    revisionId: page.revisionId,
    sourceSequence: page.sourceSequence,
  };
}
function copyCoverage(coverage: SectionCoverage): SectionCoverage {
  return {
    ...coverage,
    missingPages: coverage.missingPages.map((page) => ({ ...page })),
  };
}
function canonicalTitle(title: string): string {
  const clean = title.replace(/[_\s]+/g, ' ').trim();
  return clean ? clean[0]!.toUpperCase() + clean.slice(1) : '';
}
