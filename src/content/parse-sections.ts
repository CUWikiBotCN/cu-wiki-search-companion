// SPDX-License-Identifier: MPL-2.0

/** All offsets are UTF-16 indices into the original, unmodified source. */
export interface ParsedSection {
  localId: string;
  level: number;
  parentId?: string;
  displayTitle: string;
  headingStart: number;
  headingEnd: number;
  directBodyEnd: number;
  subtreeEnd: number;
  anchorCandidate?: string;
  needsResolution: boolean;
}

export interface ParsedSections {
  sections: ParsedSection[];
  reasons: string[];
}

/** Scan direct source headings without expanding templates or changing source coordinates. */
export function parseSections(source: string): ParsedSections {
  const reasons = new Set<string>();
  const mask = source.split('');
  const hide = (start: number, end: number): void => {
    for (let i = start; i < end; i += 1) {
      if (source[i] !== '\r' && source[i] !== '\n') mask[i] = ' ';
    }
  };
  // Track opaque nesting so a closing tag inside another opaque element cannot
  // expose its contents as source headings. Nowiki and code-like elements do
  // not interpret nested tags; references can contain them.
  const opaque =
    /<!--|-->|<\s*(\/?)\s*(ref|nowiki|pre|syntaxhighlight|source|script|style|gallery|math)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  const opaqueStack: string[] = [];
  let opaqueStart = -1;
  let match: RegExpExecArray | null;
  while ((match = opaque.exec(source))) {
    const top = opaqueStack[opaqueStack.length - 1];
    const token = match[0];
    if (top === 'comment') {
      if (token === '-->') opaqueStack.pop();
    } else if (top && top !== 'ref') {
      if (match[1] === '/' && match[2]?.toLowerCase() === top)
        opaqueStack.pop();
    } else if (token === '<!--') {
      if (!opaqueStack.length) opaqueStart = match.index;
      opaqueStack.push('comment');
    } else if (match[2]) {
      const tag = match[2].toLowerCase();
      if (match[1] === '/') {
        if (tag === top) opaqueStack.pop();
      } else if (!/\/\s*>$/.test(token)) {
        if (!opaqueStack.length) opaqueStart = match.index;
        opaqueStack.push(tag);
      } else if (!opaqueStack.length) {
        hide(match.index, opaque.lastIndex);
      }
    }
    if (opaqueStart >= 0 && !opaqueStack.length) {
      hide(opaqueStart, opaque.lastIndex);
      opaqueStart = -1;
    }
  }
  if (opaqueStart >= 0) {
    hide(opaqueStart, source.length);
    reasons.add(
      opaqueStack.includes('comment')
        ? 'unclosed-comment'
        : 'unclosed-opaque-tag',
    );
  }
  // Mask nested templates as a unit; template-generated headings are not source headings.
  const visible = mask.join('');
  const stack: number[] = [];
  for (let i = 0; i < visible.length - 1; i += 1) {
    const pair = visible.slice(i, i + 2);
    if (pair === '{{') {
      if (!stack.length) reasons.add('unexpanded-template');
      stack.push(i);
      i += 1;
    } else if (pair === '}}' && stack.length) {
      const start = stack.pop()!;
      i += 1;
      if (!stack.length) hide(start, i + 1);
    }
  }
  if (stack.length) {
    hide(stack[0]!, source.length);
    reasons.add('unclosed-template');
  }
  const masked = mask.join('');
  if (/<\s*\/?\s*h[1-6]\b/i.test(masked)) reasons.add('html-heading');
  if (/<[^>]+\bid\s*=/i.test(masked)) reasons.add('custom-id');
  const sections: ParsedSection[] = [];
  const parents: Array<{ level: number; section?: ParsedSection }> = [];
  let lastDirect: ParsedSection | undefined;
  let simplePage =
    !source.includes('<') && !source.includes('{{') && !source.includes('{|');
  const lines = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  for (const line of masked.matchAll(lines)) {
    if (!line[0]) continue;
    const content = line[0].replace(/(?:\r\n|\r|\n)$/, '');
    const heading = /^(={1,6})(?![=])(.+?)\1\s*$/.exec(content);
    if (!heading) {
      if (/^=/.test(content)) simplePage = false;
      continue;
    }
    if (
      !/^[ A-Za-z0-9_\-\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/.test(
        heading[2]!,
      )
    )
      simplePage = false;
    const start = line.index;
    const end = start + content.length;
    const level = heading[1]!.length;
    if (lastDirect) lastDirect.directBodyEnd = start;
    lastDirect = undefined;
    while (parents.length && parents[parents.length - 1]!.level >= level) {
      const previous = parents.pop()!.section;
      if (previous) previous.subtreeEnd = start;
    }
    const unresolvedParent = parents.some((parent) => !parent.section);
    const originalHeading = source.slice(start, end);
    // Expanding part of a heading could change its display title. Do not
    // publish a partial label or treat a template name as rendered text.
    if (
      originalHeading.includes('{{') ||
      /<\s*(?:nowiki|pre|syntaxhighlight|source|script|style|gallery|math)\b/i.test(
        originalHeading,
      )
    ) {
      reasons.add('unresolved-heading');
      parents.push({ level });
      continue;
    }
    const cleaned = cleanTitle(heading[2]!);
    if (!cleaned.title || unresolvedParent) {
      reasons.add(
        unresolvedParent ? 'unresolved-ancestry' : 'unresolved-heading',
      );
      parents.push({ level });
      continue;
    }
    if (cleaned.complex) reasons.add('complex-heading');
    const parent = parents[parents.length - 1]?.section;
    const section: ParsedSection = {
      localId: String(start),
      level,
      ...(parent ? { parentId: parent.localId } : {}),
      displayTitle: cleaned.title,
      headingStart: start,
      headingEnd: end,
      directBodyEnd: source.length,
      subtreeEnd: source.length,
      needsResolution: true,
    };
    sections.push(section);
    parents.push({ level, section });
    lastDirect = section;
  }
  // Only the small source-only subset checked against the target wiki is
  // eligible. An unsupported heading or structure affects the entire page's
  // anchor allocation, including headings that happen to look simple.
  if (simplePage && reasons.size === 0) {
    const used = new Set<string>();
    for (const section of sections) {
      const base = section.displayTitle.trim().replace(/ +/g, '_');
      let anchor = base;
      let suffix = 2;
      while (used.has(anchor)) anchor = `${base}_${suffix++}`;
      used.add(anchor);
      section.anchorCandidate = anchor;
      section.needsResolution = false;
    }
  }
  return { sections, reasons: [...reasons] };
}

function cleanTitle(value: string): { title: string; complex: boolean } {
  let complex = false;
  let title = value.replace(/\[\[([^\][]+)\]\]/g, (_whole, link: string) => {
    const parts = link.split('|');
    return parts[parts.length - 1] || parts[0] || '';
  });
  title = title.replace(/'{2,5}/g, '');
  title = title.replace(/<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi, () => {
    complex = true;
    return '';
  });
  title = title.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (entity, name: string) => {
      const known: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: '\u00a0',
      };
      if (name[0] !== '#') return known[name.toLowerCase()] ?? entity;
      const code =
        name[1]?.toLowerCase() === 'x'
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10);
      if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        complex = true;
        return entity;
      }
      return String.fromCodePoint(code);
    },
  );
  if (/[<>\][{}]|&(?:#\w+|\w+);/.test(title)) complex = true;
  return { title: title.replace(/\s+/g, ' ').trim(), complex };
}
