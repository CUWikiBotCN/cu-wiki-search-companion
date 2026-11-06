// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';
import { parseSections } from '../../src/content/parse-sections';
import type { SectionSearchResult } from '../../src/search/section-title-index';
import { WikiSearchDatabase } from '../../src/storage/database';
import { SectionLinkResolver } from '../../src/sync/section-links';
import { WikiApi } from '../../src/sync/wiki-api';
import type { PageRecord } from '../../src/types';

let database: WikiSearchDatabase;
beforeEach(async () => {
  database = new WikiSearchDatabase(`sections-${crypto.randomUUID()}`);
  await database.open();
});
afterEach(async () => {
  vi.useRealTimers();
  database.close();
  await database.delete();
});
function page(
  source = '前文😀\n== A &amp; B ==\n== 重复 ==\n== 重复_2 ==\n== 重复 ==\n== %20 #问? ==\n',
): PageRecord {
  return {
    id: 1,
    title: '页面',
    normalizedTitle: '页面',
    namespace: 0,
    namespaceName: '',
    isRedirect: false,
    localSeq: 1,
    revisionId: 10,
    contentRevisionId: 10,
    contentModel: 'wikitext',
    content: source,
  };
}
function result(p: PageRecord, i = 0): SectionSearchResult {
  const s = parseSections(p.content!).sections[i]!;
  return {
    kind: 'section',
    id: p.id,
    title: p.title,
    namespace: 0,
    namespaceName: '',
    sectionId: s.localId,
    revisionId: 10,
    sectionTitle: s.displayTitle,
    sectionPath: [],
    needsResolution: true,
    headingStart: s.headingStart,
    level: s.level,
  };
}
// Observed Huiji fields from the unsaved 2026-11-07 Unicode/collision probe.
function payload() {
  return {
    parse: {
      pageid: 1,
      title: '页面',
      revid: 10,
      sections: [
        [4, 'A_&_B'],
        [20, '重复'],
        [29, '重复_2'],
        [40, '重复_3'],
        [49, '%20_#问?'],
      ].map(([byteoffset, anchor], i) => ({
        byteoffset,
        anchor,
        level: '2',
        index: String(i + 1),
        fromtitle: '页面',
      })),
    },
  };
}
function apiWith(get: () => unknown | Promise<unknown>) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const params = new URL(String(input), 'https://example.test').searchParams;
    expect(params.get('action')).toBe('parse');
    expect(params.get('oldid')).toBe('10');
    expect(params.get('prop')).toBe('sections|revid');
    return new Response(JSON.stringify(await get()));
  });
  return { api: new WikiApi({ retries: 0, fetcher }), fetcher };
}

it('maps code-point offsets to UTF-16, distinct duplicate collisions and raw fragments', async () => {
  const p = page();
  await database.pages.put(p);
  const { api, fetcher } = apiWith(payload);
  const resolver = new SectionLinkResolver(database, api);
  const links = await resolver.resolve(result(p));
  expect([...links.values()]).toEqual([
    'A_&_B',
    '重复',
    '重复_2',
    '重复_3',
    '%20_#问?',
  ]);
  expect(links.get('5')).toBe('A_&_B');
  expect(resolver.getFragment(result(p, 4))).toBe('%20_#问?');
  await resolver.resolve(result(p, 4));
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it.each(['pageid', 'title', 'revid', 'sections'] as const)(
  'rejects mismatched or missing %s',
  async (key) => {
    const p = page();
    await database.pages.put(p);
    const data = payload();
    delete (data.parse as Record<string, unknown>)[key];
    const { api } = apiWith(() => data);
    await expect(
      new SectionLinkResolver(database, api).resolve(result(p)),
    ).rejects.toThrow('不匹配');
  },
);

it.each([
  'foreign',
  'template',
  'null-offset',
  'wrong-offset',
  'duplicate-offset',
  'duplicate-anchor',
  'wrong-level',
])('refuses ambiguous %s metadata', async (kind) => {
  const p = page();
  await database.pages.put(p);
  const data = payload();
  const s = data.parse.sections[0]!;
  if (kind === 'foreign') s.fromtitle = '模板:别页';
  if (kind === 'template') s.index = 'T-1';
  if (kind === 'null-offset') s.byteoffset = null as unknown as number;
  if (kind === 'wrong-offset') s.byteoffset = 5;
  if (kind === 'duplicate-offset') data.parse.sections.push({ ...s });
  if (kind === 'duplicate-anchor') data.parse.sections[1]!.anchor = s.anchor;
  if (kind === 'wrong-level') s.level = '3';
  const { api } = apiWith(() => data);
  await expect(
    new SectionLinkResolver(database, api).resolve(result(p)),
  ).rejects.toThrow('唯一');
});

it('coalesces same-page checks and invalidates late responses', async () => {
  const p = page();
  await database.pages.put(p);
  let release!: (data: unknown) => void;
  const response = new Promise((resolve) => {
    release = resolve;
  });
  const { api, fetcher } = apiWith(() => response);
  const resolver = new SectionLinkResolver(database, api);
  const first = resolver.resolve(result(p));
  const second = resolver.resolve(result(p, 1));
  const rejection = expect(second).rejects.toThrow('变化');
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  resolver.invalidate();
  release(payload());
  await expect(first).rejects.toThrow('变化');
  await rejection;
  expect(resolver.getFragment(result(p))).toBeUndefined();
});

it.each(['revision', 'source', 'delete', 'redirect'])(
  'rejects a %s change during request',
  async (kind) => {
    const p = page();
    await database.pages.put(p);
    const { api } = apiWith(async () => {
      if (kind === 'revision')
        await database.pages.update(1, { revisionId: 11 });
      if (kind === 'source')
        await database.pages.update(1, { content: '== 别的小节 ==' });
      if (kind === 'delete') await database.pages.update(1, { deleted: true });
      if (kind === 'redirect')
        await database.pages.update(1, { isRedirect: true });
      return payload();
    });
    await expect(
      new SectionLinkResolver(database, api).resolve(result(p)),
    ).rejects.toThrow('变化');
  },
);

it('expires confirmations after five minutes and permits retry after network failure', async () => {
  const p = page();
  await database.pages.put(p);
  let fail = true;
  const { api, fetcher } = apiWith(() => {
    if (fail) throw new TypeError('offline');
    return payload();
  });
  const resolver = new SectionLinkResolver(database, api);
  await expect(resolver.resolve(result(p))).rejects.toThrow();
  fail = false;
  await resolver.resolve(result(p));
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 300_001);
  expect(resolver.getFragment(result(p))).toBeUndefined();
  await resolver.resolve(result(p));
  expect(fetcher).toHaveBeenCalledTimes(3);
  vi.restoreAllMocks();
});

it('does not confirm custom HTML ID collisions using section metadata alone', async () => {
  const p = page('<span id="冲突"></span>\n== 冲突 ==');
  await database.pages.put(p);
  const { api } = apiWith(() => ({
    parse: {
      pageid: 1,
      title: '页面',
      revid: 10,
      sections: [
        {
          index: '1',
          fromtitle: '页面',
          byteoffset: 22,
          level: '2',
          anchor: '冲突',
        },
      ],
    },
  }));
  await expect(
    new SectionLinkResolver(database, api).resolve(result(p)),
  ).rejects.toThrow('唯一');
});

it('retains CRLF coordinates rather than normalizing the source', async () => {
  const p = page('前😀\r\n== 目标 ==\r\n');
  await database.pages.put(p);
  const { api } = apiWith(() => ({
    parse: {
      pageid: 1,
      title: '页面',
      revid: 10,
      sections: [
        {
          index: '1',
          fromtitle: '页面',
          byteoffset: 4,
          level: '2',
          anchor: '目标',
        },
      ],
    },
  }));
  const resolver = new SectionLinkResolver(database, api);
  await resolver.resolve(result(p));
  expect(resolver.getFragment(result(p))).toBe('目标');
});

it('keeps confirmations for at most 64 pages', async () => {
  const api = new WikiApi({
    retries: 0,
    fetcher: async (input) => {
      const id = Number(
        new URL(String(input), 'https://example.test').searchParams.get(
          'oldid',
        ),
      );
      return new Response(
        JSON.stringify({
          parse: {
            pageid: id,
            title: `页面${id}`,
            revid: id,
            sections: [
              {
                index: '1',
                fromtitle: `页面${id}`,
                byteoffset: 0,
                level: '2',
                anchor: '目标',
              },
            ],
          },
        }),
      );
    },
  });
  const resolver = new SectionLinkResolver(database, api);
  const results: SectionSearchResult[] = [];
  for (let id = 1; id <= 65; id++) {
    const p = {
      ...page('== 目标 =='),
      id,
      title: `页面${id}`,
      revisionId: id,
      contentRevisionId: id,
    };
    await database.pages.put(p);
    const r = { ...result(p), revisionId: id };
    results.push(r);
    await resolver.resolve(r);
  }
  expect(resolver.getFragment(results[0]!)).toBeUndefined();
  expect(resolver.getFragment(results[1]!)).toBe('目标');
  expect(resolver.getFragment(results[64]!)).toBe('目标');
});

it('rechecks the source sequence and refuses stale source before requesting', async () => {
  const p = page();
  await database.pages.put(p);
  const { api, fetcher } = apiWith(payload);
  const resolver = new SectionLinkResolver(database, api);
  await resolver.resolve(result(p));
  await database.pages.update(1, { localSeq: 2 });
  await resolver.resolve(result(p));
  expect(fetcher).toHaveBeenCalledTimes(2);
  await database.pages.update(1, { contentRevisionId: 9 });
  await expect(resolver.resolve(result(p))).rejects.toThrow('变化');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  'validates each caller independently when sharing a page response (invalid first: %s)',
  async (invalidFirst) => {
    const p = page();
    await database.pages.put(p);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { api, fetcher } = apiWith(async () => {
      await gate;
      const response = payload();
      response.parse.sections = response.parse.sections.slice(0, 1);
      return response;
    });
    const resolver = new SectionLinkResolver(database, api);
    const valid = result(p);
    const invalid = result(p, 1);
    const requests = invalidFirst ? [invalid, valid] : [valid, invalid];
    const done = Promise.allSettled(
      requests.map((value) => resolver.resolve(value)),
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    release();
    expect((await done).map((value) => value.status)).toEqual(
      invalidFirst ? ['rejected', 'fulfilled'] : ['fulfilled', 'rejected'],
    );
    expect(resolver.getFragment(valid)).toBe('A_&_B');
    expect(resolver.getFragment(invalid)).toBeUndefined();
  },
);

it.each([
  ['<span id="A>B"></span>', 'A&gt;B', 'A>B', true],
  ['<span title=" id=decoy" id="A&gt;B"></span>', 'A&gt;B', 'A>B', true],
  ['<span id="A&#62;B"></span>', 'A&gt;B', 'A>B', true],
  ['<span id="A&#x3e;B"></span>', 'A&gt;B', 'A>B', true],
  ["<span id=\"A'''B\"></span>", 'A&#39;&#39;&#39;B', "A'''B", true],
  ['<span id=" unrelated "></span>', '目标', '目标', false],
  ['<span data-id="目标"></span>', '目标', '目标', false],
  ['<span title=" id=目标"></span>', '目标', '目标', false],
  ['<span id="&unknown;"></span>', '目标', '目标', true],
  ['<span id="{{dynamic}}"></span>', '目标', '目标', true],
])(
  'checks literal explicit IDs without interpreting attribute markup: %s',
  async (tag, heading, anchor, blocked) => {
    const prefix = tag + '\n';
    const p = page(prefix + '== ' + heading + ' ==');
    await database.pages.put(p);
    const { api } = apiWith(() => ({
      parse: {
        pageid: 1,
        title: '页面',
        revid: 10,
        sections: [
          {
            index: '1',
            fromtitle: '页面',
            byteoffset: [...prefix].length,
            level: '2',
            anchor,
          },
        ],
      },
    }));
    const resolver = new SectionLinkResolver(database, api);
    if (blocked)
      await expect(resolver.resolve(result(p))).rejects.toThrow('唯一');
    else {
      await resolver.resolve(result(p));
      expect(resolver.getFragment(result(p))).toBe(anchor);
    }
  },
);

it('refuses malformed attribute syntax instead of skipping a later ID', async () => {
  const prefix = '<span/class="x" id="目标"></span>\n';
  const p = page(prefix + '== 目标 ==');
  await database.pages.put(p);
  const { api } = apiWith(() => ({
    parse: {
      pageid: 1,
      title: '页面',
      revid: 10,
      sections: [
        {
          index: '1',
          fromtitle: '页面',
          byteoffset: [...prefix].length,
          level: '2',
          anchor: '目标',
        },
      ],
    },
  }));
  await expect(
    new SectionLinkResolver(database, api).resolve(result(p)),
  ).rejects.toThrow('唯一');
});
