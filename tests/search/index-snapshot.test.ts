// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { cut, cut_for_search } from 'jieba-wasm/node';

import { Analyzer } from '../../src/analyzer/analyzer';
import {
  snapshotKey,
  VersionedSearchIndexCache,
} from '../../src/search/versioned-search-index-cache';
import { WikiSearchDatabase } from '../../src/storage/database';
import type { IndexSnapshotRecord, PageRecord } from '../../src/types';

const analyzer = new Analyzer(
  { cut, cutForSearch: cut_for_search },
  'jieba-wasm',
);

describe('VersionedSearchIndexCache', () => {
  it('returns detached last-observed metadata without IO and refreshes it only through explicit observation', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    try {
      await database.pages.put(page(1, '轻量状态', '正文', 'wikitext', 1));
      await database.syncState.put({ key: 'local-sequence', value: 1 });
      expect(
        cache
          .getObservedStatus(1)
          .every(({ status }) => status === 'not-started'),
      ).toBe(true);
      await cache.publish(await cache.restoreOrRebuild('title', analyzer));
      const reads = vi.spyOn(database.indexSnapshots, 'toArray');
      const get = vi.spyOn(database.indexSnapshots, 'get');
      const digest = vi.spyOn(crypto.subtle, 'digest');
      const observed = cache.getObservedStatus(1);
      expect(observed[0]).toMatchObject({
        kind: 'title',
        status: 'available',
        throughLocalSeq: 1,
      });
      expect(observed[0]).not.toHaveProperty('json');
      observed[0]!.status = 'corrupt';
      expect(cache.getObservedStatus(2)[0]?.status).toBe('replay-required');
      expect(cache.getObservedStatus(1)[0]?.status).toBe('available');
      expect(cache.getObservedStatus(0)[0]?.status).toBe('available');
      expect(reads).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(digest).not.toHaveBeenCalled();
      reads.mockRestore();
      get.mockRestore();
      digest.mockRestore();

      // Another writer changes the payload without changing its metadata.
      await database.indexSnapshots.update(snapshotKey('title'), {
        json: '{broken',
      });
      expect(cache.getObservedStatus(1)[0]?.status).toBe('available');
      expect((await cache.inspect())[0]?.status).toBe('corrupt');
      expect(cache.getObservedStatus(1)[0]?.status).toBe('corrupt');
      await cache.clear();
      expect(
        cache.getObservedStatus(1).every(({ status }) => status === 'missing'),
      ).toBe(true);
    } finally {
      vi.restoreAllMocks();
      database.close();
      await database.delete();
    }
  });

  it('does not let an in-flight inspection overwrite a later clear observation', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await database.pages.put(page(1, '清理竞态', '正文', 'wikitext', 1));
      await database.syncState.put({ key: 'local-sequence', value: 1 });
      await cache.publish(await cache.restoreOrRebuild('title', analyzer));
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const hashing = vi
        .spyOn(crypto.subtle, 'digest')
        .mockImplementation(async (algorithm, data) => {
          await held;
          return digest(algorithm, data);
        });
      const inspection = cache.inspect();
      await vi.waitFor(() => expect(hashing).toHaveBeenCalled());
      await cache.clear();
      release();
      await inspection;
      expect(
        cache.getObservedStatus(1).every(({ status }) => status === 'missing'),
      ).toBe(true);
    } finally {
      release();
      vi.restoreAllMocks();
      database.close();
      await database.delete();
    }
  });

  it('registers a restored snapshot when a diagnostic finishes before its first restoration', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const publisher = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    const reader = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await database.pages.put(page(1, '诊断恢复竞态', '正文', 'wikitext', 1));
      await database.syncState.put({ key: 'local-sequence', value: 1 });
      await publisher.publish(
        await publisher.restoreOrRebuild('title', analyzer),
      );
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const hashing = vi
        .spyOn(crypto.subtle, 'digest')
        .mockImplementationOnce(async (algorithm, data) => {
          await held;
          return digest(algorithm, data);
        });
      const restoring = reader.restoreOrRebuild('title', analyzer);
      await vi.waitFor(() => expect(hashing).toHaveBeenCalled());
      expect((await reader.inspect())[0]?.status).toBe('not-started');
      release();
      const handle = await restoring;

      expect(handle.index.search('诊断恢复竞态')[0]?.title).toBe(
        '诊断恢复竞态',
      );
      expect(reader.getObservedStatus(1)[0]?.status).toBe('available');
      expect(await reader.publish(handle)).toEqual({
        status: 'skipped',
        reason: 'not-newer',
      });
      expect((await reader.inspect())[0]?.status).toBe('available');
    } finally {
      release();
      vi.restoreAllMocks();
      database.close();
      await database.delete();
    }
  });

  it('keeps a later clear authoritative when a snapshot restoration finishes afterwards', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const publisher = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    const reader = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await database.pages.put(page(1, '恢复竞态', '正文', 'wikitext', 1));
      await database.syncState.put({ key: 'local-sequence', value: 2 });
      await publisher.publish(
        await publisher.restoreOrRebuild('title', analyzer),
      );
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const hashing = vi
        .spyOn(crypto.subtle, 'digest')
        .mockImplementation(async (algorithm, data) => {
          await held;
          return digest(algorithm, data);
        });
      const restoring = reader.restoreOrRebuild('title', analyzer);
      await vi.waitFor(() => expect(hashing).toHaveBeenCalled());
      await reader.clear();
      release();
      const handle = await restoring;
      expect(handle.index.search('恢复竞态')[0]?.title).toBe('恢复竞态');
      expect(reader.getObservedStatus(1)[0]?.status).toBe('missing');
      expect((await reader.inspect())[0]?.status).toBe('missing');
      expect(await reader.publish(handle)).toEqual({
        status: 'skipped',
        reason: 'cleared-this-session',
      });
    } finally {
      release();
      vi.restoreAllMocks();
      database.close();
      await database.delete();
    }
  });

  it('rebuilds a missing title snapshot without bulk-loading page bodies', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(
      page(1, '轻量标题', '不应随标题数组保留的长正文', 'wikitext', 1),
    );
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const bulkRead = vi
      .spyOn(database.pages, 'toArray')
      .mockRejectedValue(new Error('禁止批量物化完整页面记录'));
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });

    const rebuilt = await cache.restoreOrRebuild('title', analyzer);

    expect(rebuilt.source).toBe('rebuild');
    expect(rebuilt.snapshotGeneration).toBe(0);
    expect(rebuilt.index.search('轻量标题')[0]?.title).toBe('轻量标题');
    expect(bulkRead).not.toHaveBeenCalled();
    bulkRead.mockRestore();
    database.close();
    await database.delete();
  });

  it('streams title deltas as headers while content and Lua handles independently replay full facts', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    try {
      await database.pages.bulkPut([
        page(1, '初始标题', '完整正文', 'wikitext', 1),
        page(
          2,
          'Module:oldModule',
          'function oldFunction() end',
          'Scribunto',
          2,
        ),
      ]);
      await database.syncState.put({ key: 'local-sequence', value: 2 });
      const title = await cache.restoreOrRebuild('title', analyzer);
      const content = await cache.restoreOrRebuild('content', analyzer);
      const lua = await cache.restoreOrRebuild('lua', analyzer);
      const titleUpdates = vi.spyOn(title.index, 'updateAsync');
      const contentUpdates = vi.spyOn(content.index, 'updateAsync');
      const luaUpdates = vi.spyOn(lua.index, 'updateAsync');
      await database.pages.put({
        ...page(1, 'Template:更新标题', '新完整正文', 'wikitext', 3),
        namespace: 10,
        namespaceName: '模板',
      });
      await database.syncState.put({ key: 'local-sequence', value: 3 });
      expect(await cache.refresh(title)).toBe(1);
      await database.pages.put({
        ...page(
          2,
          'Module:oldModule',
          'function oldFunction() end',
          'Scribunto',
          4,
        ),
        deleted: true,
      });
      await database.syncState.put({ key: 'local-sequence', value: 4 });
      expect(await cache.refresh(title)).toBe(1);
      expect(await cache.refresh(content)).toBe(2);
      expect(await cache.refresh(lua)).toBe(2);

      const titleDeltas = titleUpdates.mock.calls.flatMap(([pages]) => pages);
      expect(titleDeltas).toMatchObject([
        {
          id: 1,
          title: 'Template:更新标题',
          namespace: 10,
          namespaceName: '模板',
          localSeq: 3,
        },
        { id: 2, deleted: true, localSeq: 4 },
      ]);
      for (const delta of titleDeltas) {
        expect(delta).not.toHaveProperty('content');
        expect(delta).not.toHaveProperty('contentModel');
      }
      expect(contentUpdates.mock.calls[0]?.[0][0]?.content).toBe('新完整正文');
      expect(luaUpdates.mock.calls[0]?.[0][0]?.content).toBe('新完整正文');
      expect(title.index.search('更新标题', 10)[0]?.id).toBe(1);
      expect(title.index.search('oldModule')).toEqual([]);
      expect(
        [title, content, lua].map(({ throughLocalSeq }) => throughLocalSeq),
      ).toEqual([4, 4, 4]);

      await database.fileResources.put({
        ...page(9, 'File:new.png', '', 'wikitext', 999),
        writerSeq: 5,
      });
      await database.syncState.put({ key: 'local-sequence', value: 5 });
      expect(await cache.refresh(title)).toBe(0);
      expect(title.throughLocalSeq).toBe(5);
      expect(titleUpdates).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
      database.close();
      await database.delete();
    }
  });

  it('publishes the snapshot format for the corrected analyzer and extractors', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '新版格式', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    const result = await cache.publish(
      await cache.restoreOrRebuild('title', analyzer),
    );

    expect(result).toMatchObject({
      status: 'published',
      record: { snapshotFormatVersion: 2 },
    });

    database.close();
    await database.delete();
  });

  it('encodes a serialized snapshot once for both byte length and SHA-256', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '单次编码', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    const handle = await cache.restoreOrRebuild('title', analyzer);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');

    const result = await cache.publish(handle);

    expect(result.status).toBe('published');
    expect(encode).toHaveBeenCalledTimes(1);
    encode.mockRestore();
    database.close();
    await database.delete();
  });

  it('recovers a missing local sequence from page facts for restore, publish, and inspect', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '页面序列恢复', '正文', 'wikitext', 7));
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });

    const handle = await cache.restoreOrRebuild('title', analyzer);
    const published = await cache.publish(handle);
    const inspection = (await cache.inspect()).find(
      ({ kind }) => kind === 'title',
    );

    expect(handle.throughLocalSeq).toBe(7);
    expect(published).toMatchObject({
      status: 'published',
      record: { throughLocalSeq: 7 },
    });
    expect(inspection).toMatchObject({
      status: 'available',
      throughLocalSeq: 7,
    });

    database.close();
    await database.delete();
  });

  it('recovers a missing local sequence from file writerSeq and ignores legacy file localSeq', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.fileResources.put({
      ...page(9, 'File:writer-sequence.png', '', 'wikitext', 999),
      writerSeq: 9,
    });
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });

    const handle = await cache.restoreOrRebuild('title', analyzer);
    const published = await cache.publish(handle);

    expect(handle.throughLocalSeq).toBe(9);
    expect(published).toMatchObject({
      status: 'published',
      record: { throughLocalSeq: 9 },
    });
    expect(
      (await cache.inspect()).find(({ kind }) => kind === 'title'),
    ).toMatchObject({
      status: 'available',
      throughLocalSeq: 9,
    });

    database.close();
    await database.delete();
  });

  it.each([
    ['string', '7'],
    ['NaN', Number.NaN],
    ['negative number', -1],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a %s local sequence as corrupt state', async (_label, value) => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '坏状态拒绝', '正文', 'wikitext', 7));
    await database.syncState.put({ key: 'local-sequence', value });
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });

    await expect(cache.restoreOrRebuild('title', analyzer)).rejects.toThrow(
      '同步状态 "local-sequence" 已损坏',
    );

    database.close();
    await database.delete();
  });

  it('rejects corrupt local sequence state from direct publish and inspect', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '坏状态边界', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    const handle = await cache.restoreOrRebuild('title', analyzer);
    await database.syncState.put({ key: 'local-sequence', value: 'corrupt' });

    await expect(cache.publish(handle)).rejects.toThrow(
      '同步状态 "local-sequence" 已损坏',
    );
    await expect(cache.inspect()).rejects.toThrow(
      '同步状态 "local-sequence" 已损坏',
    );

    database.close();
    await database.delete();
  });

  it('rejects a corrupt persisted snapshot generation instead of treating it as zero', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.syncState.put({
      key: 'search-index-generation',
      value: 'corrupt',
    });
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });

    await expect(cache.restoreOrRebuild('title', analyzer)).rejects.toThrow(
      '同步状态 "search-index-generation" 已损坏',
    );

    database.close();
    await database.delete();
  });

  it('clears a rejected snapshot message after the rebuilt snapshot is published', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '诊断恢复', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const firstCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    await firstCache.publish(
      await firstCache.restoreOrRebuild('title', analyzer),
    );
    const oldSnapshot = await database.indexSnapshots.get(snapshotKey('title'));
    if (!oldSnapshot) throw new Error('测试快照未发布');
    oldSnapshot.snapshotFormatVersion = 1;
    await database.indexSnapshots.put(oldSnapshot);

    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    const rebuilt = await cache.restoreOrRebuild('title', analyzer);
    expect(rebuilt.source).toBe('rebuild');
    await cache.publish(rebuilt);

    expect(
      (await cache.inspect()).find(({ kind }) => kind === 'title'),
    ).toMatchObject({
      status: 'available',
      message: undefined,
    });

    database.close();
    await database.delete();
  });

  it('rebuilds a corrupt title snapshot without bulk-loading page bodies', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(
      page(1, '损坏后轻量重建', '不应保留的正文', 'wikitext', 1),
    );
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const firstCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    await firstCache.publish(
      await firstCache.restoreOrRebuild('title', analyzer),
    );
    const corrupt = await database.indexSnapshots.get(snapshotKey('title'));
    if (!corrupt) throw new Error('测试快照未发布');
    corrupt.json = '{invalid';
    corrupt.payloadBytes = new TextEncoder().encode(corrupt.json).byteLength;
    corrupt.sha256 = await digest(corrupt.json);
    await database.indexSnapshots.put(corrupt);
    const bulkRead = vi
      .spyOn(database.pages, 'toArray')
      .mockRejectedValue(new Error('禁止批量物化完整页面记录'));

    const rebuilt = await new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    }).restoreOrRebuild('title', analyzer);

    expect(rebuilt.source).toBe('rebuild');
    expect(rebuilt.index.search('损坏后轻量重建')[0]?.title).toBe(
      '损坏后轻量重建',
    );
    expect(bulkRead).not.toHaveBeenCalled();
    bulkRead.mockRestore();
    database.close();
    await database.delete();
  });

  it('restores title, content snippets, and structured Lua matches identically', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.bulkPut([
      page(1, '医疗指导', '使用医用级兴奋剂进行紧急救治。', 'wikitext', 1),
      page(
        2,
        '模块:About',
        `local p = {}; function p.sleepQuality() return { _meta = '睡眠质量' } end; return p`,
        'Scribunto',
        2,
      ),
    ]);
    await database.syncState.put({ key: 'local-sequence', value: 2 });
    const firstCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    const firstTitle = await firstCache.restoreOrRebuild('title', analyzer);
    const firstContent = await firstCache.restoreOrRebuild('content', analyzer);
    const firstLua = await firstCache.restoreOrRebuild('lua', analyzer);
    const expected = {
      title: firstTitle.index.search('医疗'),
      content: firstContent.index.search('紧急救治'),
      lua: firstLua.index.search('_meta'),
    };

    expect(firstTitle.source).toBe('rebuild');
    await firstCache.publish(firstTitle);
    await firstCache.publish(firstContent);
    await firstCache.publish(firstLua);

    const restoredCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    const restoredTitle = await restoredCache.restoreOrRebuild(
      'title',
      analyzer,
    );
    const restoredContent = await restoredCache.restoreOrRebuild(
      'content',
      analyzer,
    );
    const restoredLua = await restoredCache.restoreOrRebuild('lua', analyzer);

    expect(restoredTitle.source).toBe('snapshot');
    expect(restoredContent.source).toBe('snapshot');
    expect(restoredLua.source).toBe('snapshot');
    expect(restoredTitle.index.search('医疗')).toEqual(expected.title);
    expect(restoredContent.index.search('紧急救治')).toEqual(expected.content);
    expect(restoredLua.index.search('_meta')).toEqual(expected.lua);

    database.close();
    await database.delete();
  });

  it('parses a complete content snapshot payload only once during restore', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(
      page(1, '单次解析正文', '使用医用级兴奋剂进行紧急救治。', 'wikitext', 1),
    );
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const publishingCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    await publishingCache.publish(
      await publishingCache.restoreOrRebuild('content', analyzer),
    );
    const parse = vi.spyOn(JSON, 'parse');

    const restored = await new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    }).restoreOrRebuild('content', analyzer);

    expect(restored.source).toBe('snapshot');
    expect(restored.index.search('紧急救治')[0]?.title).toBe('单次解析正文');
    expect(parse).toHaveBeenCalledTimes(1);

    parse.mockRestore();
    database.close();
    await database.delete();
  });

  it('skips only JSON parsing for a warm metadata fingerprint', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '单次解析', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const publishingCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    await publishingCache.publish(
      await publishingCache.restoreOrRebuild('title', analyzer),
    );
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    const parse = vi.spyOn(JSON, 'parse');

    const restored = await cache.restoreOrRebuild('title', analyzer);

    expect(restored.source).toBe('snapshot');
    expect(parse).toHaveBeenCalledTimes(1);
    const sha = vi.spyOn(crypto.subtle, 'digest');
    parse.mockClear();
    expect(
      (await cache.inspect()).find(({ kind }) => kind === 'title'),
    ).toMatchObject({
      status: 'available',
    });
    expect(sha).toHaveBeenCalledTimes(1);
    expect(parse).not.toHaveBeenCalled();

    const replacement = await database.indexSnapshots.get(snapshotKey('title'));
    if (!replacement) throw new Error('测试快照未发布');
    replacement.json = '{runtime-must-not-retain-this-payload';
    await database.indexSnapshots.put(replacement);
    sha.mockClear();
    parse.mockClear();
    expect(
      (await cache.inspect()).find(({ kind }) => kind === 'title'),
    ).toMatchObject({
      status: 'corrupt',
    });
    expect(sha).toHaveBeenCalledTimes(1);
    expect(parse).not.toHaveBeenCalled();

    sha.mockRestore();
    parse.mockRestore();
    database.close();
    await database.delete();
  });

  it('parses and rejects corrupt JSON during a cold inspection', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '冷检查损坏', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const publishingCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    await publishingCache.publish(
      await publishingCache.restoreOrRebuild('title', analyzer),
    );
    const corrupt = await database.indexSnapshots.get(snapshotKey('title'));
    if (!corrupt) throw new Error('测试快照未发布');
    corrupt.json = '{invalid';
    corrupt.payloadBytes = new TextEncoder().encode(corrupt.json).byteLength;
    corrupt.sha256 = await digest(corrupt.json);
    await database.indexSnapshots.put(corrupt);
    const parse = vi.spyOn(JSON, 'parse');

    const inspection = await new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    }).inspect();

    expect(inspection.find(({ kind }) => kind === 'title')).toMatchObject({
      status: 'corrupt',
    });
    expect(parse).toHaveBeenCalledTimes(1);

    parse.mockRestore();
    database.close();
    await database.delete();
  });

  it('replays added, renamed, content-changed, and tombstoned pages across sequence gaps', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.bulkPut([
      page(1, '废弃手册', '旧的治疗正文', 'wikitext', 1),
      page(2, '模块:旧模块', `return { oldKey = '旧值' }`, 'Scribunto', 2),
    ]);
    await database.syncState.put({ key: 'local-sequence', value: 2 });
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    await cache.publish(await cache.restoreOrRebuild('title', analyzer));
    await cache.publish(await cache.restoreOrRebuild('content', analyzer));
    await cache.publish(await cache.restoreOrRebuild('lua', analyzer));

    await database.pages.bulkPut([
      page(1, '新医疗标题', '更新后的深度治疗正文', 'wikitext', 4),
      { ...page(2, '模块:旧模块', '', 'Scribunto', 5), deleted: true },
      page(3, '新增页面', '全新内容', 'wikitext', 6),
    ]);
    // 3 由 fileResources 写入占用；pages 的 localSeq 不要求连续。
    await database.syncState.put({ key: 'local-sequence', value: 6 });

    const restoredCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    const title = await restoredCache.restoreOrRebuild('title', analyzer);
    const content = await restoredCache.restoreOrRebuild('content', analyzer);
    const lua = await restoredCache.restoreOrRebuild('lua', analyzer);

    expect(title).toMatchObject({
      source: 'snapshot',
      replayedPages: 3,
      throughLocalSeq: 6,
    });
    expect(content).toMatchObject({ source: 'snapshot', replayedPages: 3 });
    expect(lua).toMatchObject({ source: 'snapshot', replayedPages: 3 });
    expect(title.index.search('废弃手册')).toEqual([]);
    expect(title.index.search('新医疗')[0]?.title).toBe('新医疗标题');
    expect(title.index.search('新增')[0]?.title).toBe('新增页面');
    expect(content.index.search('深度治疗')[0]?.title).toBe('新医疗标题');
    expect(lua.index.search('oldKey')).toEqual([]);

    database.close();
    await database.delete();
  });

  it.each([
    [
      'invalid JSON',
      async (record: IndexSnapshotRecord) => {
        record.json = '{invalid';
        record.payloadBytes = new TextEncoder().encode(record.json).byteLength;
        record.sha256 = await digest(record.json);
      },
    ],
    [
      'wrong SHA',
      async (record: IndexSnapshotRecord) => {
        record.sha256 = '0'.repeat(64);
      },
    ],
    [
      'wrong document count',
      async (record: IndexSnapshotRecord) => {
        record.documentCount += 1;
      },
    ],
    [
      'future sequence',
      async (record: IndexSnapshotRecord) => {
        record.throughLocalSeq += 100;
      },
    ],
  ])('falls back to local pages for %s corruption', async (_label, mutate) => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(
      page(1, '损坏回退', '仍可本地搜索', 'wikitext', 1),
    );
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const first = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    await first.publish(await first.restoreOrRebuild('title', analyzer));
    const record = await database.indexSnapshots.get(snapshotKey('title'));
    if (!record) throw new Error('测试快照未发布');
    await mutate(record);
    await database.indexSnapshots.put(record);

    const restored = await new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    }).restoreOrRebuild('title', analyzer);

    expect(restored.source).toBe('rebuild');
    expect(restored.index.search('损坏回退')[0]?.title).toBe('损坏回退');
    expect(
      await database.indexSnapshots.get(snapshotKey('title')),
    ).toBeUndefined();

    database.close();
    await database.delete();
  });

  it('keeps a newer snapshot published while an older corrupt restore is failing', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const restoringDatabase = new WikiSearchDatabase(name);
    const publishingDatabase = new WikiSearchDatabase(name);
    await restoringDatabase.open();
    await publishingDatabase.open();
    await restoringDatabase.pages.put(page(1, '第一版', '正文', 'wikitext', 1));
    await restoringDatabase.syncState.put({ key: 'local-sequence', value: 1 });
    const publishingCache = new VersionedSearchIndexCache(publishingDatabase, {
      storage: unlimitedStorage(),
    });
    const publishingHandle = await publishingCache.restoreOrRebuild(
      'title',
      analyzer,
    );
    await publishingCache.publish(publishingHandle);
    const corrupt = await restoringDatabase.indexSnapshots.get(
      snapshotKey('title'),
    );
    if (!corrupt) throw new Error('测试快照未发布');
    corrupt.json = '{invalid';
    corrupt.payloadBytes = new TextEncoder().encode(corrupt.json).byteLength;
    corrupt.sha256 = await digest(corrupt.json);
    await restoringDatabase.indexSnapshots.put(corrupt);

    let releaseValidation!: () => void;
    const validationBlocked = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    let validationStarted!: () => void;
    const validationCalled = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digestSpy = vi
      .spyOn(crypto.subtle, 'digest')
      .mockImplementation(async (...args) => {
        validationStarted();
        await validationBlocked;
        return originalDigest(...args);
      });
    const restoringCache = new VersionedSearchIndexCache(restoringDatabase, {
      storage: unlimitedStorage(),
    });
    const restoring = restoringCache.restoreOrRebuild('title', analyzer);
    await validationCalled;
    digestSpy.mockRestore();

    await publishingDatabase.pages.put(
      page(1, '第二版', '正文', 'wikitext', 2),
    );
    await publishingDatabase.syncState.put({ key: 'local-sequence', value: 2 });
    await publishingCache.refresh(publishingHandle);
    expect((await publishingCache.publish(publishingHandle)).status).toBe(
      'published',
    );
    releaseValidation();
    await restoring;

    const verifier = await new VersionedSearchIndexCache(publishingDatabase, {
      storage: unlimitedStorage(),
    }).restoreOrRebuild('title', analyzer);
    expect(verifier.source).toBe('snapshot');
    expect(verifier.throughLocalSeq).toBe(2);
    expect(verifier.index.search('第二版')[0]?.title).toBe('第二版');

    restoringDatabase.close();
    publishingDatabase.close();
    await restoringDatabase.delete();
  });

  it('does not let an older handle overwrite a higher-sequence snapshot', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const firstDatabase = new WikiSearchDatabase(name);
    const secondDatabase = new WikiSearchDatabase(name);
    await firstDatabase.open();
    await secondDatabase.open();
    await firstDatabase.pages.put(page(1, '第一版', '正文', 'wikitext', 1));
    await firstDatabase.syncState.put({ key: 'local-sequence', value: 1 });
    const firstCache = new VersionedSearchIndexCache(firstDatabase, {
      storage: unlimitedStorage(),
    });
    const secondCache = new VersionedSearchIndexCache(secondDatabase, {
      storage: unlimitedStorage(),
    });
    const olderHandle = await firstCache.restoreOrRebuild('title', analyzer);
    const newerHandle = await secondCache.restoreOrRebuild('title', analyzer);
    await firstDatabase.pages.put(page(1, '第二版', '正文', 'wikitext', 2));
    await firstDatabase.syncState.put({ key: 'local-sequence', value: 2 });
    await secondCache.refresh(newerHandle);

    expect((await secondCache.publish(newerHandle)).status).toBe('published');
    expect(await firstCache.publish(olderHandle)).toEqual({
      status: 'skipped',
      reason: 'sequence-changed',
    });
    expect(
      (await firstDatabase.indexSnapshots.get(snapshotKey('title')))
        ?.throughLocalSeq,
    ).toBe(2);

    firstDatabase.close();
    secondDatabase.close();
    await firstDatabase.delete();
  });

  it('refreshes and retries a debounced publish after its handle falls behind', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '第一版标题', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
      publishDelayMs: 1,
    });
    const handle = await cache.restoreOrRebuild('title', analyzer);

    await database.pages.put(page(1, '第二版标题', '正文', 'wikitext', 2));
    await database.syncState.put({ key: 'local-sequence', value: 2 });
    cache.schedulePublish(handle);

    await vi.waitFor(async () => {
      expect(
        await database.indexSnapshots.get(snapshotKey('title')),
      ).toMatchObject({
        throughLocalSeq: 2,
      });
    });
    expect(handle.throughLocalSeq).toBe(2);
    expect(handle.index.search('第二版')[0]?.title).toBe('第二版标题');

    database.close();
    await database.delete();
  });

  it('consumes delayed publishing when the same handle is explicitly published', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    try {
      await database.pages.put(page(1, '显式发布去重', '正文', 'wikitext', 1));
      await database.syncState.put({ key: 'local-sequence', value: 1 });
      const handle = await cache.restoreOrRebuild('title', analyzer);
      const reads = vi.spyOn(database.indexSnapshots, 'get');
      const serializations = vi.spyOn(handle.index, 'exportSnapshot');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      cache.schedulePublish(handle);
      expect((await cache.publish(handle)).status).toBe('published');
      const readsAfterPublish = reads.mock.calls.length;
      expect(readsAfterPublish).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(5_001);

      expect(reads).toHaveBeenCalledTimes(readsAfterPublish);
      expect(serializations).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await cache.clear();
      database.close();
      await database.delete();
    }
  });

  it('consumes an expired automatic request still waiting behind another publish', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let estimates = 0;
    const cache = new VersionedSearchIndexCache(database, {
      storage: {
        estimate: async () => {
          if (++estimates === 1) {
            started();
            await held;
          }
          return { usage: 1_000, quota: 1024 * 1024 * 1024 };
        },
      },
    });
    try {
      await database.pages.put(page(1, '排队去重', '正文', 'wikitext', 1));
      await database.syncState.put({ key: 'local-sequence', value: 1 });
      const content = await cache.restoreOrRebuild('content', analyzer);
      const title = await cache.restoreOrRebuild('title', analyzer);
      const serializations = vi.spyOn(title.index, 'exportSnapshot');
      const reads = vi.spyOn(database.indexSnapshots, 'get');
      const publishingContent = cache.publish(content);
      await firstStarted;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      cache.schedulePublish(title);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(serializations).not.toHaveBeenCalled();
      const publishingTitle = cache.publish(title);
      release();
      expect((await publishingContent).status).toBe('published');
      expect((await publishingTitle).status).toBe('published');

      expect(
        reads.mock.calls.filter(([key]) =>
          Object.is(key, snapshotKey('title')),
        ),
      ).toHaveLength(2);
      expect(serializations).toHaveBeenCalledTimes(1);
      expect(estimates).toBe(2);
    } finally {
      release();
      vi.useRealTimers();
      vi.restoreAllMocks();
      await cache.clear();
      database.close();
      await database.delete();
    }
  });

  it('does not let an explicit old handle consume a new handle delayed request', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    try {
      await database.pages.put(page(1, '旧标题', '正文', 'wikitext', 1));
      await database.syncState.put({ key: 'local-sequence', value: 1 });
      const oldHandle = await cache.restoreOrRebuild('title', analyzer);
      await database.pages.put(page(1, '新标题', '正文', 'wikitext', 2));
      await database.syncState.put({ key: 'local-sequence', value: 2 });
      const newHandle = await cache.restoreOrRebuild('title', analyzer);
      const serializations = vi.spyOn(newHandle.index, 'exportSnapshot');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      cache.schedulePublish(newHandle);
      expect(await cache.publish(oldHandle)).toEqual({
        status: 'skipped',
        reason: 'sequence-changed',
      });
      await vi.advanceTimersByTimeAsync(5_001);
      vi.useRealTimers();
      await vi.waitFor(async () => {
        expect(
          await database.indexSnapshots.get(snapshotKey('title')),
        ).toMatchObject({ throughLocalSeq: 2 });
      });
      expect(serializations).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await cache.clear();
      database.close();
      await database.delete();
    }
  });

  it('discards a replaced expired request without deleting the newer handle timer', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let estimates = 0;
    const cache = new VersionedSearchIndexCache(database, {
      storage: {
        estimate: async () => {
          if (++estimates === 1) {
            started();
            await held;
          }
          return { usage: 1_000, quota: 1024 * 1024 * 1024 };
        },
      },
    });
    try {
      await database.pages.put(page(1, '替换前标题', '正文', 'wikitext', 1));
      await database.syncState.put({ key: 'local-sequence', value: 1 });
      const content = await cache.restoreOrRebuild('content', analyzer);
      const oldTitle = await cache.restoreOrRebuild('title', analyzer);
      const oldSerializations = vi.spyOn(oldTitle.index, 'exportSnapshot');
      const contentPublish = cache.publish(content);
      await firstStarted;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      cache.schedulePublish(oldTitle);
      await vi.advanceTimersByTimeAsync(5_001);
      await database.pages.put(page(1, '替换后标题', '正文', 'wikitext', 2));
      await database.syncState.put({ key: 'local-sequence', value: 2 });
      const newTitle = await cache.restoreOrRebuild('title', analyzer);
      cache.schedulePublish(newTitle);
      release();
      expect(await contentPublish).toEqual({
        status: 'skipped',
        reason: 'sequence-changed',
      });
      // An explicit old handle is a queue barrier and cannot consume newTitle.
      expect(await cache.publish(oldTitle)).toEqual({
        status: 'skipped',
        reason: 'sequence-changed',
      });
      expect(oldSerializations).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(5_001);
      vi.useRealTimers();
      await vi.waitFor(async () => {
        expect(
          await database.indexSnapshots.get(snapshotKey('title')),
        ).toMatchObject({ throughLocalSeq: 2 });
      });
    } finally {
      release();
      vi.useRealTimers();
      vi.restoreAllMocks();
      await cache.clear();
      database.close();
      await database.delete();
    }
  });

  it('consumes a sequence retry scheduled while the explicit publication waits in the queue', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let estimates = 0;
    const cache = new VersionedSearchIndexCache(database, {
      storage: {
        estimate: async () => {
          if (++estimates === 1) {
            started();
            await held;
          }
          return { usage: 1_000, quota: 1024 * 1024 * 1024 };
        },
      },
    });
    try {
      await database.pages.put(page(1, '重试前标题', '正文', 'wikitext', 1));
      await database.syncState.put({ key: 'local-sequence', value: 1 });
      const handle = await cache.restoreOrRebuild('title', analyzer);
      const reads = vi.spyOn(database.indexSnapshots, 'get');
      const serializations = vi.spyOn(handle.index, 'exportSnapshot');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      cache.schedulePublish(handle);
      await vi.advanceTimersByTimeAsync(5_001);
      await firstStarted;
      await database.pages.put(page(1, '重试后标题', '新正文', 'wikitext', 2));
      await database.syncState.put({ key: 'local-sequence', value: 2 });
      const publishing = cache.publish(handle);
      release();
      expect(await publishing).toMatchObject({
        status: 'published',
        record: { throughLocalSeq: 2 },
      });
      const readsAfterPublish = reads.mock.calls.length;

      await vi.advanceTimersByTimeAsync(5_001);

      expect(reads).toHaveBeenCalledTimes(readsAfterPublish);
      expect(serializations).toHaveBeenCalledTimes(2);
      expect(estimates).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release();
      vi.useRealTimers();
      vi.restoreAllMocks();
      await cache.clear();
      database.close();
      await database.delete();
    }
  });

  it.each(['automatic', 'explicit'] as const)(
    'retains the next automatic request when pages change during an active %s publish',
    async (origin) => {
      const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
      await database.open();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let estimates = 0;
      const cache = new VersionedSearchIndexCache(database, {
        storage: {
          estimate: async () => {
            if (++estimates === 1) {
              started();
              await held;
            }
            return { usage: 1_000, quota: 1024 * 1024 * 1024 };
          },
        },
      });
      try {
        await database.pages.put(
          page(1, '发布期间旧内容', '正文', 'wikitext', 1),
        );
        await database.syncState.put({ key: 'local-sequence', value: 1 });
        const handle = await cache.restoreOrRebuild('title', analyzer);
        const serializations = vi.spyOn(handle.index, 'exportSnapshot');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let explicitPublishing: ReturnType<typeof cache.publish> | undefined;
        if (origin === 'automatic') cache.schedulePublish(handle);
        else explicitPublishing = cache.publish(handle);
        await vi.advanceTimersByTimeAsync(5_001);
        await firstStarted;
        await database.pages.put(
          page(1, '发布期间新内容', '新正文', 'wikitext', 2),
        );
        await database.syncState.put({ key: 'local-sequence', value: 2 });
        expect(await cache.refresh(handle)).toBe(1);
        cache.schedulePublish(handle);
        await vi.advanceTimersByTimeAsync(5_001);
        expect(serializations).toHaveBeenCalledTimes(1);
        release();
        if (explicitPublishing)
          expect(await explicitPublishing).toEqual({
            status: 'skipped',
            reason: 'sequence-changed',
          });
        vi.useRealTimers();
        await vi.waitFor(async () => {
          expect(
            await database.indexSnapshots.get(snapshotKey('title')),
          ).toMatchObject({ throughLocalSeq: 2 });
        });
        expect(serializations).toHaveBeenCalledTimes(2);
        expect(handle.index.search('新内容')[0]?.title).toBe('发布期间新内容');
        expect(estimates).toBe(2);
      } finally {
        release();
        vi.useRealTimers();
        vi.restoreAllMocks();
        await cache.clear();
        database.close();
        await database.delete();
      }
    },
  );

  it('does not let a failed explicit publish poison later kinds or the next attempt', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    try {
      await database.pages.put(page(1, '失败后重试', '正文', 'wikitext', 1));
      await database.syncState.put({ key: 'local-sequence', value: 1 });
      const title = await cache.restoreOrRebuild('title', analyzer);
      const content = await cache.restoreOrRebuild('content', analyzer);
      const failure = new Error('synthetic serialization failure');
      const serializations = vi
        .spyOn(title.index, 'exportSnapshot')
        .mockImplementationOnce(() => {
          throw failure;
        });
      const rejected = expect(cache.publish(title)).rejects.toBe(failure);
      const contentPublish = cache.publish(content);
      const titleRetry = cache.publish(title);

      await rejected;
      expect((await contentPublish).status).toBe('published');
      expect((await titleRetry).status).toBe('published');
      expect(serializations).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
      database.close();
      await database.delete();
    }
  });

  it('reports an automatic publish failure and continues the shared publishing queue', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    try {
      await database.pages.put(
        page(1, '自动失败后重试', '正文', 'wikitext', 1),
      );
      await database.syncState.put({ key: 'local-sequence', value: 1 });
      const title = await cache.restoreOrRebuild('title', analyzer);
      const content = await cache.restoreOrRebuild('content', analyzer);
      const failure = new Error('synthetic automatic failure');
      vi.spyOn(title.index, 'exportSnapshot').mockImplementationOnce(() => {
        throw failure;
      });
      const warning = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      cache.schedulePublish(title);
      cache.schedulePublish(content);
      await vi.advanceTimersByTimeAsync(5_001);
      vi.useRealTimers();
      await vi.waitFor(async () => {
        expect(
          await database.indexSnapshots.get(snapshotKey('content')),
        ).toMatchObject({ throughLocalSeq: 1 });
      });

      expect(warning).toHaveBeenCalledWith(
        '[CU Wiki Search] index snapshot publish failed',
        failure,
      );
      expect((await cache.publish(title)).status).toBe('published');
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await cache.clear();
      database.close();
      await database.delete();
    }
  });

  it('invalidates queued automatic and explicit work on clear even if publishing is allowed again', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let estimates = 0;
    const cache = new VersionedSearchIndexCache(database, {
      storage: {
        estimate: async () => {
          if (++estimates === 1) {
            started();
            await held;
          }
          return { usage: 1_000, quota: 1024 * 1024 * 1024 };
        },
      },
    });
    try {
      await database.pages.put(page(1, '清理排队发布', '正文', 'wikitext', 1));
      await database.syncState.put({ key: 'local-sequence', value: 1 });
      const content = await cache.restoreOrRebuild('content', analyzer);
      const oldTitle = await cache.restoreOrRebuild('title', analyzer);
      const oldLua = await cache.restoreOrRebuild('lua', analyzer);
      const oldTitleSerializations = vi.spyOn(oldTitle.index, 'exportSnapshot');
      const contentPublish = cache.publish(content);
      await firstStarted;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      cache.schedulePublish(oldTitle);
      await vi.advanceTimersByTimeAsync(5_001);
      const luaPublish = cache.publish(oldLua);
      await cache.clear();
      cache.allowPublishing();
      const newTitle = await cache.restoreOrRebuild('title', analyzer);
      const newTitlePublish = cache.publish(newTitle);
      release();

      expect(await contentPublish).toEqual({
        status: 'skipped',
        reason: 'cleared-this-session',
      });
      expect(await luaPublish).toEqual({
        status: 'skipped',
        reason: 'cleared-this-session',
      });
      expect((await newTitlePublish).status).toBe('published');
      expect(oldTitleSerializations).not.toHaveBeenCalled();
      expect(await database.indexSnapshots.toArray()).toMatchObject([
        { kind: 'title', throughLocalSeq: 1 },
      ]);
      expect(estimates).toBe(2);
    } finally {
      release();
      vi.useRealTimers();
      vi.restoreAllMocks();
      await cache.clear();
      database.close();
      await database.delete();
    }
  });

  it('refreshes through a file-only writer sequence before retrying a debounced publish', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '文件序列前', '正文', 'wikitext', 7));
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
      publishDelayMs: 1,
    });
    const handle = await cache.restoreOrRebuild('title', analyzer);
    await database.fileResources.put({
      ...page(9, 'File:writer-sequence.png', '', 'wikitext', 999),
      writerSeq: 9,
    });

    cache.schedulePublish(handle);

    await vi.waitFor(async () => {
      expect(
        await database.indexSnapshots.get(snapshotKey('title')),
      ).toMatchObject({
        throughLocalSeq: 9,
      });
    });
    expect(handle.throughLocalSeq).toBe(9);

    database.close();
    await database.delete();
  });

  it('stops debounced retries when refresh cannot advance a stale handle', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '不可倒退', '正文', 'wikitext', 7));
    await database.syncState.put({ key: 'local-sequence', value: 7 });
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
      publishDelayMs: 1,
    });
    const handle = await cache.restoreOrRebuild('title', analyzer);
    await database.syncState.put({ key: 'local-sequence', value: 6 });
    const refresh = vi.spyOn(cache, 'refresh');

    cache.schedulePublish(handle);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(handle.throughLocalSeq).toBe(7);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      await database.indexSnapshots.get(snapshotKey('title')),
    ).toBeUndefined();

    await cache.clear();
    database.close();
    await database.delete();
  });

  it('serializes concurrent refreshes of one handle so its version cannot move backward', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, 'initialPage', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    const handle = await cache.restoreOrRebuild('title', analyzer);
    const updateAsync = handle.index.updateAsync.bind(handle.index);
    let updateCall = 0;
    let firstUpdateStarted!: () => void;
    const firstUpdateCalled = new Promise<void>((resolve) => {
      firstUpdateStarted = resolve;
    });
    let releaseFirstUpdate!: () => void;
    const firstUpdateBlocked = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    handle.index.updateAsync = async (pages, batchSize) => {
      updateCall += 1;
      if (updateCall === 1) {
        firstUpdateStarted();
        await firstUpdateBlocked;
      }
      await updateAsync(pages, batchSize);
    };

    await database.pages.put(page(1, 'obsoletePayload', '正文', 'wikitext', 2));
    await database.syncState.put({ key: 'local-sequence', value: 2 });
    const olderRefresh = cache.refresh(handle);
    await firstUpdateCalled;
    await database.pages.put(page(1, 'currentSignal', '正文', 'wikitext', 3));
    await database.syncState.put({ key: 'local-sequence', value: 3 });
    const newerRefresh = cache.refresh(handle);
    setTimeout(releaseFirstUpdate, 25);

    await Promise.all([olderRefresh, newerRefresh]);

    expect(handle.throughLocalSeq).toBe(3);
    expect(handle.index.search('currentSignal')[0]?.title).toBe(
      'currentSignal',
    );
    expect(handle.index.search('obsoletePayload')).toEqual([]);

    database.close();
    await database.delete();
  });

  it('keeps a serialized candidate tied to the sequence it actually contains', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '序列化前', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    let releaseEstimate!: () => void;
    const estimateBlocked = new Promise<void>((resolve) => {
      releaseEstimate = resolve;
    });
    let estimateStarted!: () => void;
    const estimateCalled = new Promise<void>((resolve) => {
      estimateStarted = resolve;
    });
    const cache = new VersionedSearchIndexCache(database, {
      storage: {
        estimate: async () => {
          estimateStarted();
          await estimateBlocked;
          return { usage: 1_000, quota: 1024 * 1024 * 1024 };
        },
      },
    });
    const handle = await cache.restoreOrRebuild('title', analyzer);

    const publishing = cache.publish(handle);
    await estimateCalled;
    await database.pages.put(page(1, '序列化后', '正文', 'wikitext', 2));
    await database.syncState.put({ key: 'local-sequence', value: 2 });
    await cache.refresh(handle);
    releaseEstimate();

    expect(await publishing).toEqual({
      status: 'skipped',
      reason: 'sequence-changed',
    });
    expect(
      await database.indexSnapshots.get(snapshotKey('title')),
    ).toBeUndefined();

    database.close();
    await database.delete();
  });

  it('clears only snapshots and suppresses an immediate republish in the same session', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '保留事实', '正文', 'wikitext', 1));
    await database.syncState.bulkPut([
      { key: 'local-sequence', value: 1 },
      {
        key: 'recent-changes-sync',
        value: { through: 'keep-me', completedAt: 10 },
      },
    ]);
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    const handle = await cache.restoreOrRebuild('title', analyzer);
    await cache.publish(handle);

    await cache.clear();

    expect(await database.indexSnapshots.count()).toBe(0);
    expect(await database.pages.count()).toBe(1);
    expect(
      (await database.syncState.get('recent-changes-sync'))?.value,
    ).toMatchObject({
      through: 'keep-me',
    });
    expect(await cache.publish(handle)).toEqual({
      status: 'skipped',
      reason: 'cleared-this-session',
    });

    database.close();
    await database.delete();
  });

  it('does not let an already-started publish recreate a snapshot after clear returns', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '清除后仍可搜索', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const initialCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    await initialCache.publish(
      await initialCache.restoreOrRebuild('title', analyzer),
    );
    let releaseEstimate!: () => void;
    const estimateBlocked = new Promise<void>((resolve) => {
      releaseEstimate = resolve;
    });
    let estimateStarted!: () => void;
    const estimateCalled = new Promise<void>((resolve) => {
      estimateStarted = resolve;
    });
    const cache = new VersionedSearchIndexCache(database, {
      storage: {
        estimate: async () => {
          estimateStarted();
          await estimateBlocked;
          return { usage: 1_000, quota: 1024 * 1024 * 1024 };
        },
      },
    });
    const handle = await cache.restoreOrRebuild('title', analyzer);
    expect(handle.source).toBe('snapshot');
    await database.pages.put(
      page(1, '清除后仍可搜索', '更新正文', 'wikitext', 2),
    );
    await database.syncState.put({ key: 'local-sequence', value: 2 });
    await cache.refresh(handle);

    const publishing = cache.publish(handle);
    await estimateCalled;
    await cache.clear();
    releaseEstimate();

    expect(await publishing).toEqual({
      status: 'skipped',
      reason: 'cleared-this-session',
    });
    expect(
      await database.indexSnapshots.get(snapshotKey('title')),
    ).toBeUndefined();
    expect(
      (await cache.inspect()).map(({ kind, status }) => ({ kind, status })),
    ).toEqual([
      { kind: 'title', status: 'missing' },
      { kind: 'content', status: 'missing' },
      { kind: 'lua', status: 'missing' },
    ]);
    expect(handle.index.search('清除后仍可搜索')[0]?.title).toBe(
      '清除后仍可搜索',
    );

    database.close();
    await database.delete();
  });

  it('fences an already-started publish from another cache instance after clear', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const clearingDatabase = new WikiSearchDatabase(name);
    const publishingDatabase = new WikiSearchDatabase(name);
    await clearingDatabase.open();
    await publishingDatabase.open();
    await clearingDatabase.pages.put(
      page(1, '跨标签清理', '正文', 'wikitext', 1),
    );
    await clearingDatabase.syncState.put({ key: 'local-sequence', value: 1 });
    let releaseEstimate!: () => void;
    const estimateBlocked = new Promise<void>((resolve) => {
      releaseEstimate = resolve;
    });
    let estimateStarted!: () => void;
    const estimateCalled = new Promise<void>((resolve) => {
      estimateStarted = resolve;
    });
    const clearingCache = new VersionedSearchIndexCache(clearingDatabase, {
      storage: unlimitedStorage(),
    });
    const publishingCache = new VersionedSearchIndexCache(publishingDatabase, {
      storage: {
        estimate: async () => {
          estimateStarted();
          await estimateBlocked;
          return { usage: 1_000, quota: 1024 * 1024 * 1024 };
        },
      },
    });
    const staleHandle = await publishingCache.restoreOrRebuild(
      'title',
      analyzer,
    );

    const publishing = publishingCache.publish(staleHandle);
    await estimateCalled;
    await clearingCache.clear();
    releaseEstimate();

    expect(await publishing).toEqual({
      status: 'skipped',
      reason: 'cleared-this-session',
    });
    expect(await clearingDatabase.indexSnapshots.count()).toBe(0);

    clearingDatabase.close();
    publishingDatabase.close();
    await clearingDatabase.delete();
  });

  it('lets rebuilt handles publish after clear while rejecting old handles at the same sequence', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const rebuildingDatabase = new WikiSearchDatabase(name);
    const staleDatabase = new WikiSearchDatabase(name);
    await rebuildingDatabase.open();
    await staleDatabase.open();
    await rebuildingDatabase.pages.put(
      page(1, '代际重建', '正文', 'wikitext', 1),
    );
    await rebuildingDatabase.syncState.put({ key: 'local-sequence', value: 1 });
    const rebuildingCache = new VersionedSearchIndexCache(rebuildingDatabase, {
      storage: unlimitedStorage(),
      now: () => 222,
    });
    const staleCache = new VersionedSearchIndexCache(staleDatabase, {
      storage: unlimitedStorage(),
      now: () => 111,
    });
    const staleHandle = await staleCache.restoreOrRebuild('title', analyzer);

    await rebuildingCache.clear();
    rebuildingCache.allowPublishing();
    const rebuiltHandle = await rebuildingCache.restoreOrRebuild(
      'title',
      analyzer,
    );

    expect(await staleCache.publish(staleHandle)).toEqual({
      status: 'skipped',
      reason: 'cleared-this-session',
    });
    expect(await rebuildingCache.publish(rebuiltHandle)).toMatchObject({
      status: 'published',
      record: { createdAt: 222 },
    });
    expect(
      await rebuildingDatabase.indexSnapshots.get(snapshotKey('title')),
    ).toMatchObject({
      createdAt: 222,
    });

    rebuildingDatabase.close();
    staleDatabase.close();
    await rebuildingDatabase.delete();
  });

  it('returns not-newer before checking quota for an already-current snapshot', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '无需重写', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const initialCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    await initialCache.publish(
      await initialCache.restoreOrRebuild('title', analyzer),
    );
    const estimate = vi.fn(async () => ({ usage: 1_000, quota: 1_000 }));
    const restoredCache = new VersionedSearchIndexCache(database, {
      storage: { estimate },
    });
    const restored = await restoredCache.restoreOrRebuild('title', analyzer);

    expect(await restoredCache.publish(restored)).toEqual({
      status: 'skipped',
      reason: 'not-newer',
    });
    expect(estimate).not.toHaveBeenCalled();

    database.close();
    await database.delete();
  });

  it('rebuilds locally for an analyzer-engine change and skips publishing without quota', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '兼容键页面', '本地正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const first = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    await first.publish(await first.restoreOrRebuild('title', analyzer));
    const changedAnalyzer = new Analyzer(
      { cut, cutForSearch: cut_for_search },
      'different-engine',
    );
    const noQuota = new VersionedSearchIndexCache(database, {
      storage: { estimate: async () => ({ usage: 1_000, quota: 1_000 }) },
    });

    const rebuilt = await noQuota.restoreOrRebuild('title', changedAnalyzer);

    expect(rebuilt.source).toBe('rebuild');
    expect(rebuilt.index.search('兼容键')[0]?.title).toBe('兼容键页面');
    expect(await noQuota.publish(rebuilt)).toEqual({
      status: 'skipped',
      reason: 'quota',
    });

    database.close();
    await database.delete();
  });

  it('publishes with a diagnostic warning when the quota estimate rejects', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '配额未知页面', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const warning = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const failingCache = new VersionedSearchIndexCache(database, {
      storage: {
        estimate: async () => {
          throw new Error('estimate unavailable');
        },
      },
    });
    const handle = await failingCache.restoreOrRebuild('title', analyzer);

    expect(await failingCache.publish(handle)).toMatchObject({
      status: 'published',
    });
    expect(warning).toHaveBeenCalledWith(
      '[CU Wiki Search] storage quota estimate failed; assuming snapshots may be saved',
      expect.any(Error),
    );

    warning.mockRestore();
    database.close();
    await database.delete();
  });
});

function page(
  id: number,
  title: string,
  content: string,
  contentModel: string,
  localSeq: number,
): PageRecord {
  return {
    id,
    title,
    normalizedTitle: analyzer.normalize(title),
    namespace: contentModel === 'Scribunto' ? 828 : 0,
    namespaceName: contentModel === 'Scribunto' ? '模块' : '（主）',
    isRedirect: false,
    localSeq,
    seenInTitleSync: 1,
    revisionId: id * 10,
    contentRevisionId: id * 10,
    contentModel,
    content,
  };
}

function unlimitedStorage(): Pick<StorageManager, 'estimate'> {
  return {
    estimate: vi.fn(async () => ({ usage: 1_000, quota: 1024 * 1024 * 1024 })),
  };
}

async function digest(value: string): Promise<string> {
  const result = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(result)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
