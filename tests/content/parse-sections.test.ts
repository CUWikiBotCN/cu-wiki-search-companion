// SPDX-License-Identifier: MPL-2.0
import { parseSections } from '../../src/content/parse-sections';

it('retains original UTF-16 CRLF ranges and heading hierarchy', () => {
  const source =
    '😀 intro\r\n== 父 ==\r\nbody\r\n==== [[目標|子]] ====\r\nchild\r\n== 父 ==\r\nend';
  const { sections } = parseSections(source);
  expect(sections.map((s) => [s.level, s.displayTitle, s.parentId])).toEqual([
    [2, '父', undefined],
    [4, '子', String(source.indexOf('== 父 =='))],
    [2, '父', undefined],
  ]);
  const [parent, child, next] = sections;
  expect(source.slice(parent!.headingStart, parent!.headingEnd)).toBe(
    '== 父 ==',
  );
  expect(source.slice(child!.headingStart, child!.headingEnd)).toBe(
    '==== [[目標|子]] ====',
  );
  expect(parent!.directBodyEnd).toBe(child!.headingStart);
  expect(parent!.subtreeEnd).toBe(next!.headingStart);
  expect(child!.subtreeEnd).toBe(next!.headingStart);
  expect(next!.subtreeEnd).toBe(source.length);
  expect(sections.every((s) => s.needsResolution && !s.anchorCandidate)).toBe(
    true,
  );
});

it('skips opaque regions and template bodies without joining lines or exposing template names', () => {
  const source =
    '<!--\n== fake1 ==\n-->\n<ref>\n== fake2 ==\n</ref>\n<nowiki>\n== fake3 ==\n</nowiki>\n<pre>\n== fake4 ==\n</pre>\n<code>\n== fake5 ==\n</code>\n<syntaxhighlight>\n== fake6 ==\n</syntaxhighlight>\n<source>\n== fake7 ==\n</source>\n{{t|\n== fake8 ==\n}}\n== Real {{template|name}} ==\n== [[target|display]] ==';
  const result = parseSections(source);
  expect(result.sections.map((s) => s.displayTitle)).toEqual([
    'fake5',
    'display',
  ]);
  expect(result.reasons).toContain('unexpanded-template');
  expect(result.reasons).toContain('unresolved-heading');
  expect(result.sections[1]?.headingStart).toBe(source.indexOf('== [[target'));
});

it('cleans basic formatting and entities while reporting complex source', () => {
  const result = parseSections(
    "== '''A''' &amp; &#x1f600; ==\n<span id=\"A\"></span>\n<h2>Heading</h2>\n== <span>X</span> ==",
  );
  expect(result.sections.map((s) => s.displayTitle)).toEqual(['A & 😀', 'X']);
  expect(result.reasons).toEqual(
    expect.arrayContaining(['custom-id', 'html-heading', 'complex-heading']),
  );
});

it('uses unresolved headings as boundaries without assigning descendants to an earlier parent', () => {
  const source =
    '== A ==\nbody\n=== {{title}} ===\nbody\n==== child of unknown ====\n== B ==\n=== C ===';
  const { sections, reasons } = parseSections(source);
  expect(sections.map((section) => section.displayTitle)).toEqual([
    'A',
    'B',
    'C',
  ]);
  expect(sections[0]?.directBodyEnd).toBe(source.indexOf('=== {{title}}'));
  expect(sections[0]?.subtreeEnd).toBe(source.indexOf('== B =='));
  expect(sections[1]?.parentId).toBeUndefined();
  expect(sections[2]?.parentId).toBe(sections[1]?.localId);
  expect(reasons).toEqual(
    expect.arrayContaining(['unresolved-heading', 'unresolved-ancestry']),
  );
});

it('keeps nested hidden tags and comments opaque even when they contain a misleading closing tag', () => {
  const source =
    '<ref>\n<!-- </ref> -->\n<nowiki>\n</ref>\n== fake 1 ==\n</nowiki>\n<ref>\n== fake 2 ==\n</ref>\n== fake 3 ==\n</ref>\n== Real ==';
  const result = parseSections(source);
  expect(result.sections.map((section) => section.displayTitle)).toEqual([
    'Real',
  ]);
  expect(result.sections[0]?.headingStart).toBe(source.indexOf('== Real =='));
});

it('treats unclosed opaque tags conservatively and does not make partial nowiki titles', () => {
  const source =
    '== A ==\n=== x <nowiki>literal</nowiki> ===\n==== child ====\n== B ==\n<ref>\n== fake ==';
  const result = parseSections(source);
  expect(result.sections.map((section) => section.displayTitle)).toEqual([
    'A',
    'B',
  ]);
  expect(result.sections[0]?.directBodyEnd).toBe(source.indexOf('=== x'));
  expect(result.reasons).toEqual(
    expect.arrayContaining([
      'unresolved-heading',
      'unresolved-ancestry',
      'unclosed-opaque-tag',
    ]),
  );
});

it('ignores headings inside known opaque block tags and handles quoted tag attributes', () => {
  const source =
    '<ref name="x>y">\n== fake ref ==\n</ref>\n<gallery>\n== fake gallery ==\n</gallery>\n<math>\n== fake math ==\n</math>\n<style>\n== fake style ==\n</style>\n<script>\n== fake script ==\n</script>\n== visible ==';
  expect(
    parseSections(source).sections.map((section) => section.displayTitle),
  ).toEqual(['visible']);
});

it('provides locally verified plain anchors and accounts for collisions with explicit suffixes', () => {
  const { sections, reasons } = parseSections(
    '== 重复 ==\n== 重复_2 ==\n== 重复 ==\n=== Ab c-d ===',
  );
  expect(reasons).toEqual([]);
  expect(
    sections.map((section) => [
      section.anchorCandidate,
      section.needsResolution,
    ]),
  ).toEqual([
    ['重复', false],
    ['重复_2', false],
    ['重复_3', false],
    ['Ab_c-d', false],
  ]);
});

it.each([
  '== A ==\n== [[Target|B]] ==',
  '== A ==\n== B &amp; C ==',
  '== A ==\n== 😀 ==',
  '== A ==\n{{dynamic}}',
  '== A ==\n<span id="x"></span>',
  '== A ==\n{|\n== B ==\n|}',
])(
  'requires resolution across the entire page for unsupported source: %s',
  (source) => {
    const { sections } = parseSections(source);
    expect(sections.length).toBeGreaterThan(0);
    expect(
      sections.every(
        (section) =>
          section.needsResolution && section.anchorCandidate === undefined,
      ),
    ).toBe(true);
  },
);
