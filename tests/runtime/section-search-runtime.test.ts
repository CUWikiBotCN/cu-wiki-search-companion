// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import {
  Analyzer,
  createBootstrapSegmenter,
} from '../../src/analyzer/analyzer';
import {
  SectionSearchRuntime,
  type SectionLinkLookup,
} from '../../src/runtime/section-search-runtime';
import { SectionTitleIndex } from '../../src/search/section-title-index';
import { WikiSearchDatabase } from '../../src/storage/database';
import type { PageRecord } from '../../src/types';

const databases: WikiSearchDatabase[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

function page(id: number, title: string, content?: string): PageRecord {
  return {
    id,
    title,
    normalizedTitle: title,
    namespace: 0,
    namespaceName: '',
    isRedirect: false,
    localSeq: id,
    revisionId: 1,
    contentModel: 'wikitext',
    ...(content === undefined ? {} : { content, contentRevisionId: 1 }),
  };
}

async function harness(
  pages: PageRecord[],
  extra: {
    ready?: boolean;
    synchronize?: (
      ids?: readonly number[],
      shouldRun?: () => boolean,
      onStarted?: () => void,
    ) => Promise<void>;
    links?: SectionLinkLookup;
  } = {},
) {
  const database = new WikiSearchDatabase(
    `section-runtime-${crypto.randomUUID()}`,
  );
  databases.push(database);
  await database.open();
  await database.pages.bulkPut(pages);
  await database.syncState.put({ key: 'local-sequence', value: pages.length });
  const synchronize = vi.fn(extra.synchronize ?? (async () => undefined));
  const changed = vi.fn();
  const runtime = new SectionSearchRuntime({
    database,
    analyzer: new Analyzer(createBootstrapSegmenter(), 'bootstrap'),
    synchronize,
    links: extra.links,
    titleBaselineReady: () => extra.ready ?? true,
    changed,
  });
  return { database, runtime, synchronize, changed };
}

describe('SectionSearchRuntime', () => {
  it('does not read content or synchronize while disabled and shares preparation', async () => {
    const { database, runtime, synchronize } = await harness([
      page(1, '医疗', '== 治疗 =='),
    ]);
    const collection = vi.spyOn(database.pages, 'toCollection');
    const refresh = vi.spyOn(SectionTitleIndex.prototype, 'refresh');
    runtime.setIntent({ active: false, query: '医疗#' });
    expect(runtime.search('医疗#')).toEqual([]);
    expect(collection).not.toHaveBeenCalled();
    expect(synchronize).not.toHaveBeenCalled();
    await Promise.all([runtime.prepare(), runtime.prepare()]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      runtime.search('医疗#').map((result) => result.sectionTitle),
    ).toEqual(['治疗']);
    runtime.destroy();
  });

  it('keeps preparation unready after failure and retries successfully', async () => {
    const { runtime } = await harness([page(1, '医疗', '== 治疗 ==')]);
    vi.spyOn(SectionTitleIndex.prototype, 'refresh').mockRejectedValueOnce(
      new Error('storage failure'),
    );
    await expect(runtime.prepare()).rejects.toThrow('storage failure');
    expect(runtime.describe('医疗#').ready).toBe(false);
    await runtime.prepare();
    expect(runtime.describe('医疗#').ready).toBe(true);
    expect(runtime.search('医疗#').map((row) => row.sectionTitle)).toEqual([
      '治疗',
    ]);
    runtime.destroy();
  });

  it('automatically fetches only an exact title or explicit page binding', async () => {
    const { runtime, synchronize } = await harness([
      page(1, '医疗指南'),
      page(2, '武器指南'),
    ]);
    await runtime.prepare();
    vi.useFakeTimers();
    runtime.setIntent({ active: true, query: '医疗#' });
    await vi.advanceTimersByTimeAsync(600);
    expect(synchronize).not.toHaveBeenCalled();
    runtime.setIntent({ active: true, query: '#治疗' });
    await vi.advanceTimersByTimeAsync(600);
    expect(synchronize).not.toHaveBeenCalled();
    runtime.setIntent({ active: true, query: '医疗指南#治疗' });
    await vi.advanceTimersByTimeAsync(600);
    expect(synchronize).toHaveBeenCalledTimes(1);
    expect(synchronize.mock.calls[0]?.[0]).toEqual([1]);
    runtime.setIntent({ active: true, query: '#', pageId: 2 });
    await vi.advanceTimersByTimeAsync(600);
    expect(synchronize.mock.calls[1]?.[0]).toEqual([2]);
    runtime.destroy();
  });

  it('requires a ready title baseline for typed automatic fetch but permits an explicit binding', async () => {
    const { runtime, synchronize } = await harness([page(1, '医疗指南')], {
      ready: false,
    });
    await runtime.prepare();
    vi.useFakeTimers();
    runtime.setIntent({ active: true, query: '医疗指南#' });
    await vi.advanceTimersByTimeAsync(600);
    expect(synchronize).not.toHaveBeenCalled();
    runtime.setIntent({ active: true, query: '#', pageId: 1 });
    await vi.advanceTimersByTimeAsync(600);
    expect(synchronize.mock.calls[0]?.[0]).toEqual([1]);
    runtime.destroy();
  });

  it('deduplicates failed automatic attempts but permits an explicit manual retry', async () => {
    const { runtime, synchronize } = await harness([page(1, '医疗指南')], {
      synchronize: async () => {
        throw new Error('offline');
      },
    });
    await runtime.prepare();
    vi.useFakeTimers();
    runtime.setIntent({ active: true, query: '医疗指南#治疗' });
    await vi.advanceTimersByTimeAsync(600);
    expect(runtime.describe('医疗指南#治疗').message).toContain('offline');
    runtime.setIntent({ active: true, query: '医疗指南#急救' });
    await vi.advanceTimersByTimeAsync(600);
    expect(synchronize).toHaveBeenCalledTimes(1);
    await runtime.fetchPage(1);
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(synchronize.mock.calls[1]).toEqual([[1]]);
    runtime.destroy();
  });

  it('invalidates an automatic intent on target change while leaving manual work active', async () => {
    let automaticCheck: (() => boolean) | undefined;
    let finishAutomatic!: () => void;
    let finishManual!: () => void;
    const { runtime, synchronize } = await harness(
      [page(1, '医疗指南'), page(2, '武器指南')],
      {
        synchronize: async (_ids, check) => {
          if (check) {
            automaticCheck = check;
            await new Promise<void>((resolve) => {
              finishAutomatic = resolve;
            });
          } else {
            await new Promise<void>((resolve) => {
              finishManual = resolve;
            });
          }
        },
      },
    );
    await runtime.prepare();
    vi.useFakeTimers();
    runtime.setIntent({ active: true, query: '医疗指南#' });
    await vi.advanceTimersByTimeAsync(600);
    expect(automaticCheck?.()).toBe(true);
    const manual = runtime.fetchPage(2);
    expect(synchronize.mock.calls[1]).toEqual([[2]]);
    runtime.setIntent({ active: false, query: '' });
    expect(automaticCheck?.()).toBe(false);
    vi.useRealTimers();
    finishAutomatic();
    finishManual();
    await manual;
    runtime.destroy();
  });

  it('limits automatic targets to 64 without preventing an explicit fetch', async () => {
    const pages = Array.from({ length: 65 }, (_, index) =>
      page(index + 1, `页面${index + 1}`),
    );
    const { runtime, synchronize } = await harness(pages, {
      synchronize: async () => {
        throw new Error('offline');
      },
    });
    await runtime.prepare();
    vi.useFakeTimers();
    for (let id = 1; id <= 65; id += 1) {
      runtime.setIntent({ active: true, query: '#', pageId: id });
      await vi.advanceTimersByTimeAsync(600);
    }
    expect(synchronize).toHaveBeenCalledTimes(64);
    await runtime.fetchPage(65);
    expect(synchronize).toHaveBeenCalledTimes(65);
    runtime.destroy();
  });

  it('does not consume the automatic attempt when the request is cancelled before the lock', async () => {
    let release!: () => void;
    const { runtime, synchronize } = await harness([page(1, '医疗指南')], {
      synchronize: async (_ids, check) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        if (!check?.()) return;
      },
    });
    await runtime.prepare();
    vi.useFakeTimers();
    runtime.setIntent({ active: true, query: '医疗指南#' });
    await vi.advanceTimersByTimeAsync(600);
    runtime.setIntent({ active: false, query: '' });
    release();
    await vi.advanceTimersByTimeAsync(20);
    runtime.setIntent({ active: true, query: '医疗指南#' });
    await vi.advanceTimersByTimeAsync(600);
    expect(synchronize).toHaveBeenCalledTimes(2);
    runtime.destroy();
    release();
  });

  it('retains the attempt after dispatch even if the user changes the intent', async () => {
    let reject!: (error: Error) => void;
    const { runtime, synchronize } = await harness([page(1, '医疗指南')], {
      synchronize: async (_ids, _check, started) => {
        started?.();
        await new Promise<void>((_resolve, fail) => {
          reject = fail;
        });
      },
    });
    await runtime.prepare();
    vi.useFakeTimers();
    runtime.setIntent({ active: true, query: '医疗指南#' });
    await vi.advanceTimersByTimeAsync(600);
    runtime.setIntent({ active: false, query: '' });
    reject(new Error('offline'));
    await vi.advanceTimersByTimeAsync(20);
    runtime.setIntent({ active: true, query: '医疗指南#' });
    await vi.advanceTimersByTimeAsync(600);
    expect(synchronize).toHaveBeenCalledTimes(1);
    runtime.destroy();
  });

  it('replays changed page content and rejects a late link resolution', async () => {
    let release!: () => void;
    const links: SectionLinkLookup = {
      resolve: vi.fn(
        () =>
          new Promise<ReadonlyMap<string, string>>((resolve) => {
            release = () => resolve(new Map());
          }),
      ),
      getFragment: () => undefined,
      invalidate: vi.fn(),
    };
    const { database, runtime } = await harness(
      [page(1, '医疗', '== 原标题 ==')],
      { links },
    );
    await runtime.prepare();
    const result = runtime.search('医疗#')[0]!;
    const resolving = runtime.resolve(result);
    const rejected = expect(resolving).rejects.toThrow('小节已更新');
    await database.pages.update(1, {
      content: '== 新标题 ==',
      revisionId: 2,
      contentRevisionId: 2,
      localSeq: 2,
    });
    await database.syncState.put({ key: 'local-sequence', value: 2 });
    await runtime.refresh();
    expect(runtime.search('医疗#').map((row) => row.sectionTitle)).toEqual([
      '新标题',
    ]);
    release();
    await rejected;
    runtime.destroy();
    expect(links.invalidate).toHaveBeenCalledOnce();
  });

  it('rejects a stale verified fragment or renamed page even at the same revision', async () => {
    let fragment: string | undefined = '已核对';
    const links: SectionLinkLookup = {
      resolve: vi.fn(async () => new Map()),
      getFragment: () => fragment,
      invalidate: vi.fn(),
    };
    const { database, runtime } = await harness(
      [page(1, '医疗', '== 标题 ==')],
      { links },
    );
    await runtime.prepare();
    const result = runtime.search('医疗#')[0]!;
    expect(result.fragment).toBe('已核对');
    expect(runtime.current(result)).toBe(true);
    fragment = undefined;
    expect(runtime.current(result)).toBe(false);
    fragment = '已核对';
    await database.pages.update(1, { title: '新医疗', localSeq: 2 });
    await database.syncState.put({ key: 'local-sequence', value: 2 });
    await runtime.refresh();
    expect(runtime.current(result)).toBe(false);
    runtime.destroy();
  });
});

it('keeps a failed automatic page status when only its section filter changes', async () => {
  const { runtime, synchronize } = await harness([page(1, '医疗指南')], {
    synchronize: async () => {
      throw new Error('offline');
    },
  });
  await runtime.prepare();
  vi.useFakeTimers();
  runtime.setIntent({ active: true, query: '医疗指南#甲' });
  await vi.advanceTimersByTimeAsync(600);
  expect(runtime.describe('医疗指南#甲').message).toContain('offline');
  runtime.setIntent({ active: true, query: '医疗指南#乙' });
  await vi.advanceTimersByTimeAsync(600);
  expect(runtime.describe('医疗指南#乙').message).toContain('offline');
  expect(synchronize).toHaveBeenCalledTimes(1);
  runtime.destroy();
});

it('rejects actions while a known source change is awaiting replay', async () => {
  const { runtime } = await harness([page(1, '医疗', '== 标题 ==')]);
  await runtime.prepare();
  const result = runtime.search('医疗#')[0]!;
  expect(runtime.current(result)).toBe(true);
  runtime.invalidateActions();
  expect(runtime.current(result)).toBe(false);
  await runtime.refresh();
  expect(runtime.current(result)).toBe(true);
  runtime.destroy();
});

it('drops a confirmed anchor and result identity after a same-revision source repair', async () => {
  const { SectionLinkResolver } = await import('../../src/sync/section-links');
  const { WikiApi } = await import('../../src/sync/wiki-api');
  const { database } = await harness([page(1, '医疗', '{{X}}\n== Old ==')]);
  const api = new WikiApi({
    retries: 0,
    fetcher: async () =>
      new Response(
        JSON.stringify({
          parse: {
            pageid: 1,
            title: '医疗',
            revid: 1,
            sections: [
              {
                level: '2',
                index: '1',
                fromtitle: '医疗',
                byteoffset: 6,
                anchor: 'Old',
              },
            ],
          },
        }),
      ),
  });
  const runtime = new SectionSearchRuntime({
    database,
    analyzer: new Analyzer(createBootstrapSegmenter()),
    links: new SectionLinkResolver(database, api),
    synchronize: async () => undefined,
    titleBaselineReady: () => true,
    changed: () => undefined,
  });
  await runtime.prepare();
  await runtime.resolve(runtime.search('医疗#Old')[0]!);
  const old = runtime.search('医疗#Old')[0]!;
  expect(old.fragment).toBe('Old');
  await database.pages.update(1, { content: '{{X}}\n== New ==', localSeq: 2 });
  await database.syncState.put({ key: 'local-sequence', value: 2 });
  await runtime.refresh();
  const next = runtime.search('医疗#New')[0]!;
  expect(next.needsResolution).toBe(true);
  expect(next.fragment).toBeUndefined();
  expect(runtime.current(old)).toBe(false);
  runtime.destroy();
});

it.each([false, true])(
  'settles manual fetch feedback despite changes to the section filter (failure: %s)',
  async (failure) => {
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const { runtime } = await harness([page(1, '医疗指南')], {
      synchronize: () =>
        new Promise<void>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    });
    await runtime.prepare();
    runtime.setIntent({ active: true, query: '医疗指南#甲' });
    const fetching = runtime.fetchPage(1);
    runtime.setIntent({ active: true, query: '医疗指南#乙' });
    if (failure) fail(new Error('manual offline'));
    else finish();
    await fetching;
    expect(runtime.describe('医疗指南#乙').message).toBe(
      failure ? '获取失败，可重试：manual offline' : '',
    );
    runtime.destroy();
  },
);

it('reconsiders an exact page when title preparation finishes after the first debounce', async () => {
  const { database } = await harness([page(1, '医疗指南')]);
  let ready = false;
  const synchronize = vi.fn(async () => undefined);
  const runtime = new SectionSearchRuntime({
    database,
    analyzer: new Analyzer(createBootstrapSegmenter()),
    synchronize,
    titleBaselineReady: () => ready,
    changed: () => undefined,
  });
  await runtime.prepare();
  vi.useFakeTimers();
  runtime.setIntent({ active: true, query: '医疗指南#获取' });
  await vi.advanceTimersByTimeAsync(600);
  expect(synchronize).not.toHaveBeenCalled();
  ready = true;
  runtime.titleBaselineChanged();
  await vi.advanceTimersByTimeAsync(600);
  expect(synchronize).toHaveBeenCalledTimes(1);
  runtime.destroy();
});
