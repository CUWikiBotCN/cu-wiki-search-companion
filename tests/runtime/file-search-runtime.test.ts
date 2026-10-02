// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';
import { Analyzer, createBootstrapSegmenter } from '../../src/analyzer/analyzer';
import { FileSearchRuntime } from '../../src/runtime/file-search-runtime';
import { WikiSearchDatabase } from '../../src/storage/database';
import { IncrementalSyncCoordinator } from '../../src/sync/incremental-sync-coordinator';
import { WikiApi } from '../../src/sync/wiki-api';

const databases: WikiSearchDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) await database.delete();
});

it('waits for startup, shares concurrent preparation, and does not read files on unused-mode invalidation', async () => {
  let release!: () => void;
  const startup = new Promise<void>((resolve) => { release = resolve; });
  const { runtime, database, fetcher } = await harness({ startup });
  const reads = vi.spyOn(database.fileResources, 'filter');
  await runtime.refresh(10, true);
  expect(reads).not.toHaveBeenCalled();
  const first = runtime.prepare();
  expect(runtime.prepare(true)).toBe(first);
  expect(runtime.state.loaded).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
  release();
  await first;
  expect(runtime.search('绷带').map(({ title }) => title)).toEqual(['文件:绷带.png']);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('coalesces forced refreshes after initial preparation settles', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const fetcher = vi.fn<typeof fetch>(async () => {
    if (++calls === 2) await held;
    return response();
  });
  const { runtime } = await harness({ fetcher });
  await runtime.prepare();
  const first = runtime.prepare(true);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  const second = runtime.prepare(true);
  release();
  await Promise.all([first, second]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(runtime.search('绷带')).toHaveLength(1);
});

it('keeps restored files searchable after failure and retries the failed preparation', async () => {
  const failure = new Error('offline');
  const fetcher = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue(response());
  const { runtime } = await harness({ fetcher });
  await expect(runtime.prepare()).rejects.toBe(failure);
  expect(runtime.search('旧图')).toHaveLength(1);
  await runtime.prepare();
  expect(runtime.search('绷带')).toHaveLength(1);
  expect(runtime.search('旧图')).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('restores cached files with no Web Locks but never fetches or announces a commit', async () => {
  const { runtime, fetcher, onCommitted } = await harness({ noLocks: true });
  await expect(runtime.prepare()).rejects.toThrow('Web Locks');
  expect(runtime.search('旧图')).toHaveLength(1);
  expect(fetcher).not.toHaveBeenCalled();
  expect(onCommitted).not.toHaveBeenCalled();
});

it('reloads active files on newer sequence or explicit invalidation and ignores duplicate sequences', async () => {
  const { runtime, database } = await harness();
  await runtime.prepare();
  await runtime.refresh(10);
  await database.fileResources.update(2, { title: '文件:纱布.png', normalizedTitle: '文件:纱布.png' });
  await runtime.refresh(10);
  expect(runtime.search('纱布')).toEqual([]);
  await runtime.refresh(11);
  expect(runtime.search('纱布')).toHaveLength(1);
  await database.fileResources.delete(2);
  await runtime.refresh(11, true);
  expect(runtime.state.indexedFiles).toBe(0);
});

it('keeps cached preparation available when writes are disabled', async () => {
  const { runtime, fetcher } = await harness({ canWrite: false });
  await runtime.prepare();
  expect(runtime.search('旧图')).toHaveLength(1);
  expect(fetcher).not.toHaveBeenCalled();
});

async function harness(options: {
  startup?: Promise<void>;
  fetcher?: typeof fetch;
  noLocks?: boolean;
  canWrite?: boolean;
} = {}) {
  const database = new WikiSearchDatabase(`file-runtime-${crypto.randomUUID()}`);
  databases.push(database);
  await database.fileResources.put({ id: 1, title: '文件:旧图.png', normalizedTitle: '文件:旧图.png',
    namespace: 6, namespaceName: '文件', isRedirect: false, localSeq: 1 });
  const fetcher = options.fetcher ?? vi.fn<typeof fetch>(async () => response());
  const coordinator = new IncrementalSyncCoordinator(database, {
    lockManager: options.noLocks ? null : {
      request: async (_name, _options, callback) => callback({ name: 'test', mode: 'exclusive' }),
    },
  });
  const onCommitted = vi.fn(async () => { await runtime.refresh(0, true); });
  const runtime = new FileSearchRuntime({
    database,
    api: new WikiApi({ fetcher, retries: 0 }),
    analyzer: new Analyzer(createBootstrapSegmenter(), 'bootstrap'),
    waitUntilReady: () => options.startup ?? Promise.resolve(),
    canWrite: () => options.canWrite ?? true,
    runExclusive: (task) => coordinator.runExclusive(task),
    onStateChange: vi.fn(),
    onRestored: vi.fn(),
    onProgress: vi.fn(),
    onCommitted,
  });
  return { runtime, database, fetcher, onCommitted };
}

function response(): Response {
  return new Response(JSON.stringify({ query: { pages: [
    { pageid: 2, ns: 6, title: '文件:绷带.png', lastrevid: 1, contentmodel: 'wikitext' },
  ] } }));
}
