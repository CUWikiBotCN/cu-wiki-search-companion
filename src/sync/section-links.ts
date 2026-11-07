// SPDX-License-Identifier: MPL-2.0
import { parseSections } from '../content/parse-sections';
import type { SectionSearchResult } from '../search/section-title-index';
import type { WikiSearchDatabase } from '../storage/database';
import type { PageRecord } from '../types';
import type { WikiApi } from './wiki-api';

interface SectionMetadata {
  level?: unknown;
  index?: unknown;
  fromtitle?: unknown;
  byteoffset?: unknown;
  anchor?: unknown;
}
interface SectionResponse {
  parse?: {
    title?: unknown;
    pageid?: unknown;
    revid?: unknown;
    sections?: SectionMetadata[];
  };
}
interface CachedLinks {
  title: string;
  revision: number;
  localSeq: number;
  expires: number;
  refreshAfter: number;
  links: ReadonlyMap<string, string>;
}

/** Revision-bound confirmations with a short stale-while-revalidate window. */
export class SectionLinkResolver {
  private readonly cache = new Map<number, CachedLinks>();
  private readonly pending = new Map<
    string,
    Promise<ReadonlyMap<string, string>>
  >();
  private generation = 0;

  constructor(
    private readonly database: WikiSearchDatabase,
    private readonly api: WikiApi,
  ) {}

  getFragment(result: SectionSearchResult): string | undefined {
    const entry = this.cache.get(result.id);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.cache.delete(result.id);
      return undefined;
    }
    return entry.revision === result.revisionId &&
      entry.title === result.title &&
      (result.sourceSequence === undefined ||
        entry.localSeq === result.sourceSequence)
      ? entry.links.get(result.sectionId)
      : undefined;
  }

  needsRefresh(result: SectionSearchResult): boolean {
    const entry = this.cache.get(result.id);
    return (
      !entry ||
      entry.refreshAfter <= Date.now() ||
      entry.revision !== result.revisionId ||
      entry.title !== result.title ||
      (result.sourceSequence !== undefined &&
        entry.localSeq !== result.sourceSequence)
    );
  }

  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
    this.pending.clear();
  }

  resolve(result: SectionSearchResult): Promise<ReadonlyMap<string, string>> {
    const key = JSON.stringify([
      result.id,
      result.revisionId,
      result.sourceSequence,
      result.title,
    ]);
    const existing = this.pending.get(key);
    if (existing) return this.forSection(existing, result.sectionId);
    const generation = this.generation;
    const task = this.resolvePage(result, generation).finally(() => {
      if (this.pending.get(key) === task) this.pending.delete(key);
    });
    this.pending.set(key, task);
    return this.forSection(task, result.sectionId);
  }

  private forSection(
    task: Promise<ReadonlyMap<string, string>>,
    sectionId: string,
  ): Promise<ReadonlyMap<string, string>> {
    return task.then((links) => {
      if (!links.has(sectionId))
        throw new Error('无法将章节响应唯一对应到此小节，仍可打开所属页面');
      return links;
    });
  }

  private async resolvePage(
    result: SectionSearchResult,
    generation: number,
  ): Promise<ReadonlyMap<string, string>> {
    const page = await this.database.pages.get(result.id);
    if (!isCurrent(page, result) || generation !== this.generation) {
      throw new Error('页面源码已变化，请重新搜索后核对链接');
    }
    const cached = this.cache.get(result.id);
    if (
      cached?.revision === result.revisionId &&
      cached.title === result.title &&
      cached.localSeq === page.localSeq &&
      cached.refreshAfter > Date.now()
    ) {
      return cached.links;
    }
    const response = await this.api.query<SectionResponse>({
      action: 'parse',
      oldid: result.revisionId,
      prop: 'sections|revid',
    });
    // A completed response supersedes old evidence, including when it reveals
    // ambiguity. Only transport failure may keep a confirmation in its grace period.
    if (this.cache.get(result.id) === cached) this.cache.delete(result.id);
    const parsed = response.parse;
    if (
      parsed?.pageid !== result.id ||
      parsed.title !== result.title ||
      parsed.revid !== result.revisionId ||
      !Array.isArray(parsed.sections)
    ) {
      throw new Error('章节响应的页面或修订不匹配，未生成链接');
    }
    const links = mapSections(page.content!, page.title, parsed.sections);
    const current = await this.database.pages.get(result.id);
    if (
      generation !== this.generation ||
      !isCurrent(current, result) ||
      current.content !== page.content
    ) {
      throw new Error('核对期间页面源码已变化，请重新核对');
    }
    this.cache.delete(result.id);
    this.cache.set(result.id, {
      title: result.title,
      revision: result.revisionId,
      localSeq: page.localSeq,
      refreshAfter: Date.now() + 5 * 60_000,
      expires: Date.now() + 15 * 60_000,
      links,
    });
    while (this.cache.size > 64)
      this.cache.delete(this.cache.keys().next().value!);
    return links;
  }
}

function isCurrent(
  page: PageRecord | undefined,
  result: SectionSearchResult,
): page is PageRecord {
  return Boolean(
    page &&
    !page.deleted &&
    !page.isRedirect &&
    page.contentModel === 'wikitext' &&
    typeof page.content === 'string' &&
    Number.isSafeInteger(result.revisionId) &&
    result.revisionId > 0 &&
    (result.sourceSequence === undefined ||
      page.localSeq === result.sourceSequence) &&
    page.title === result.title &&
    page.revisionId === result.revisionId &&
    page.contentRevisionId === result.revisionId,
  );
}

function mapSections(
  source: string,
  title: string,
  metadata: SectionMetadata[],
): ReadonlyMap<string, string> {
  // Huiji's observed `byteoffset` counts Unicode code points, not bytes or UTF-16.
  // Preserve CRLF and reject positions which do not identify a local source heading.
  const utf16Positions = [0];
  let offset = 0;
  for (const character of source) {
    offset += character.length;
    utf16Positions.push(offset);
  }
  const byOffset = new Map<number, SectionMetadata[]>();
  const anchorCounts = new Map<string, number>();
  for (const section of metadata) {
    if (!section || typeof section !== 'object') continue;
    if (typeof section.anchor === 'string') {
      anchorCounts.set(
        section.anchor,
        (anchorCounts.get(section.anchor) ?? 0) + 1,
      );
    }
    if (
      typeof section.index !== 'string' ||
      !/^[1-9]\d*$/.test(section.index) ||
      typeof section.fromtitle !== 'string' ||
      section.fromtitle.replace(/_/g, ' ') !== title.replace(/_/g, ' ') ||
      typeof section.byteoffset !== 'number' ||
      !Number.isSafeInteger(section.byteoffset) ||
      section.byteoffset < 0
    )
      continue;
    const position = utf16Positions[section.byteoffset];
    if (position === undefined) continue;
    const matches = byOffset.get(position) ?? [];
    matches.push(section);
    byOffset.set(position, matches);
  }
  const links = new Map<string, string>();
  // The section API does not disambiguate manually assigned HTML IDs.
  const explicitIds = readExplicitIds(source);
  if (!explicitIds) return links;
  for (const section of parseSections(source).sections) {
    const matches = byOffset.get(section.headingStart);
    if (matches?.length !== 1) continue;
    const match = matches[0]!;
    if (
      Number(match.level) !== section.level ||
      typeof match.anchor !== 'string' ||
      !match.anchor ||
      explicitIds.has(match.anchor) ||
      [...match.anchor].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) ||
      anchorCounts.get(match.anchor) !== 1
    )
      continue;
    // `anchor` is raw (including literal %/#); URL escaping belongs to page-url.
    links.set(section.localId, match.anchor);
  }
  return links;
}

function readExplicitIds(source: string): Set<string> | undefined {
  const ids = new Set<string>();
  // Quoted attribute values can contain > or apparent attributes of their own.
  const tags = /<[A-Za-z][\w:-]*((?:[^"'<>]|"[^"]*"|'[^']*')*)>/g;
  const attribute =
    /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
  for (const tag of source.matchAll(tags)) {
    const text = tag[1]!;
    attribute.lastIndex = 0;
    let consumed = 0;
    let match: RegExpExecArray | null;
    while ((match = attribute.exec(text))) {
      consumed = attribute.lastIndex;
      if (match[1]!.toLowerCase() !== 'id') continue;
      const raw = match[2] ?? match[3] ?? match[4] ?? '';
      if (/[{}]/.test(raw)) return undefined;
      const decoded = decodeIdEntities(raw);
      if (decoded === undefined) return undefined;
      ids.add(decoded);
    }
    if (!/^\s*\/?\s*$/.test(text.slice(consumed))) return undefined;
  }
  return ids;
}

/** Decode attribute entities only: whitespace and apostrophes remain literal. */
function decodeIdEntities(value: string): string | undefined {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
  };
  let unsupported = false;
  const decoded = value.replace(/&([^\s&;]+);/g, (entity, name: string) => {
    if (Object.hasOwn(named, name)) return named[name]!;
    const numeric = /^#(?:x([\da-f]+)|(\d+))$/i.exec(name);
    const code = numeric
      ? parseInt(numeric[1] ?? numeric[2]!, numeric[1] ? 16 : 10)
      : NaN;
    if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff))
      return String.fromCodePoint(code);
    unsupported = true;
    return entity;
  });
  return unsupported ? undefined : decoded;
}
