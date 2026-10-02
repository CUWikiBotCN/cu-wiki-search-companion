// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';
import { Analyzer, createBootstrapSegmenter } from '../../src/analyzer/analyzer';
import { DEFAULT_DATA_CODE_RULES } from '../../src/data/data-field-rules';
import { DataCodeRuntime } from '../../src/runtime/data-code-runtime';
import { WikiSearchDatabase } from '../../src/storage/database';
import { readDataCodeSyncState } from '../../src/sync/data-code-sync';
import { IncrementalSyncCoordinator } from '../../src/sync/incremental-sync-coordinator';

const databases: WikiSearchDatabase[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) await database.delete();
});

it('rejects startup-time writes and invalid rules before contacting storage or the network', async () => {
  const { runtime, fetcher, preference, writes } = await harness();
  expect(await runtime.refresh(true)).toMatchObject({ status: 'error' });
  await expect(runtime.save('* = .id')).rejects.toThrow('尚未就绪');
  await runtime.initialize();
  await expect(runtime.save('invalid')).rejects.toThrow('配置');
  expect(writes).toEqual([]);
  expect(preference.set).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

it('restores cached records and falls back from invalid preference to durable rules', async () => {
  const { runtime, onInvalidRules, fetcher } = await harness({ preference: 'invalid' });
  await runtime.initialize();
  expect(runtime.state.rulesSource).toBe(DEFAULT_DATA_CODE_RULES);
  expect(runtime.search('旧绷带')).toHaveLength(1);
  expect(onInvalidRules).toHaveBeenCalledWith('GM preference', expect.any(Error));
  expect(fetcher).not.toHaveBeenCalled();
});

it('serializes a queued save after a blocked refresh, coalesces refreshes and keeps preference with its cache under the lock', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const fetcher = vi.fn<typeof fetch>(async () => {
    if (++calls === 1) await held;
    return response(calls === 1 ? '新绷带' : '纱布');
  });
  const { runtime, preference, onCommitted, database, writes } = await harness({ fetcher });
  await runtime.initialize();
  const refresh = runtime.refresh(true);
  expect(runtime.refresh(false)).toBe(refresh);
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  const source = '* = .locales["zh-CN"].name';
  const saving = runtime.save(source);
  expect(preference.set).not.toHaveBeenCalled();
  expect(runtime.search('旧绷带')).toHaveLength(1);
  release();
  await Promise.all([refresh, saving]);
  expect(runtime.state.rulesSource).toBe(source);
  expect(runtime.search('纱布')).toHaveLength(1);
  expect(runtime.search('新绷带')).toEqual([]);
  expect((await readDataCodeSyncState(database))?.rulesSource).toBe(source);
  expect(preference.set).toHaveBeenCalledWith(source);
  expect(writes).toEqual(['data-refresh', 'data-save']);
  expect(onCommitted.mock.calls.map(([commit]) => commit.origin)).toEqual(['refresh', 'save']);
});

it('preserves cache and rules after a failed refresh and accepts a later retry', async () => {
  // A valid HTTP response with invalid Data shape fails without network backoff.
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}'))
    .mockImplementation(async () => response('新绷带'));
  const { runtime, onCommitted } = await harness({ fetcher });
  await runtime.initialize();
  expect((await runtime.refresh(true)).status).toBe('error');
  expect(runtime.search('旧绷带')).toHaveLength(1);
  expect(onCommitted).not.toHaveBeenCalled();
  expect((await runtime.refresh(true)).status).toBe('complete');
  expect(runtime.search('新绷带')).toHaveLength(1);
});

it('does not write preference or fetch without a Web Lock', async () => {
  const { runtime, fetcher, preference } = await harness({ noLocks: true });
  await runtime.initialize();
  expect(await runtime.refresh(true)).toMatchObject({ status: 'error' });
  await expect(runtime.save('* = .id')).rejects.toThrow('Web Locks');
  expect(preference.set).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  expect(runtime.search('旧绷带')).toHaveLength(1);
});

it('reloads broadcast cache and valid rules without fetching or saving preference', async () => {
  const { runtime, database, fetcher, preference, onInvalidRules, onRulesChange } = await harness();
  await runtime.initialize();
  await database.dataCodes.update('Data:Item/bandage', { chineseName: '纱布', normalizedName: '纱布' });
  const state = (await readDataCodeSyncState(database))!;
  await database.syncState.put({ key: 'data-code-sync', value: { ...state, rulesSource: '* = .id' } });
  await runtime.reloadFromStorage();
  expect(runtime.search('纱布')).toHaveLength(1);
  expect(runtime.state.rulesSource).toBe('* = .id');
  await database.syncState.put({ key: 'data-code-sync', value: { ...state, rulesSource: 'invalid' } });
  await runtime.reloadFromStorage();
  expect(runtime.state.rulesSource).toBe('* = .id');
  expect(onInvalidRules).toHaveBeenCalledWith('broadcast', expect.any(Error));
  await database.syncState.put({ key: 'data-code-sync', value: { ...state, rulesSource: undefined } });
  await runtime.reloadFromStorage();
  expect(runtime.state.rulesSource).toBe('* = .id');
  expect(onRulesChange.mock.calls).toEqual([[DEFAULT_DATA_CODE_RULES], ['* = .id']]);
  expect(preference.set).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

async function harness(options: { preference?: string; fetcher?: typeof fetch; noLocks?: boolean } = {}) {
  const database = new WikiSearchDatabase(`data-runtime-${crypto.randomUUID()}`);
  databases.push(database);
  await database.dataCodes.put({ source: 'Data:Item/bandage', code: 'bandage', chineseName: '旧绷带',
    normalizedName: '旧绷带', dataType: 'Item', syncedAt: Date.now() });
  await database.syncState.put({ key: 'data-code-sync', value: {
    count: 1, syncedAt: Date.now(), indexVersion: 2, rulesSource: DEFAULT_DATA_CODE_RULES,
  } });
  let inWriter = false;
  let preferred = options.preference ?? DEFAULT_DATA_CODE_RULES;
  const preference = {
    get: async () => preferred,
    set: vi.fn(async (source: string) => {
      expect(inWriter).toBe(true);
      expect((await readDataCodeSyncState(database))?.rulesSource).toBe(source);
      preferred = source;
    }),
  };
  const fetcher = options.fetcher ?? vi.fn<typeof fetch>(async () => response('新绷带'));
  vi.stubGlobal('fetch', fetcher);
  const coordinator = new IncrementalSyncCoordinator(database, {
    lockManager: options.noLocks ? null : {
      request: async (_name, _options, callback) => callback({ name: 'test', mode: 'exclusive' }),
    },
  });
  const writes: string[] = [];
  const onCommitted = vi.fn();
  const onInvalidRules = vi.fn();
  const onRulesChange = vi.fn();
  const runtime = new DataCodeRuntime({
    database,
    analyzer: new Analyzer(createBootstrapSegmenter(), 'bootstrap'),
    preference,
    runWriter: async (key, task) => {
      writes.push(key);
      const result = await coordinator.runExclusive(async () => {
        inWriter = true;
        try { await task(); } finally { inWriter = false; }
      });
      if (result === 'lock-unavailable') throw new Error('Web Locks unavailable');
    },
    onStateChange: vi.fn(), onRulesChange, onCommitted, onInvalidRules,
  });
  return { runtime, database, preference, fetcher, onCommitted, onInvalidRules, onRulesChange, writes };
}

function response(name: string): Response {
  return new Response(JSON.stringify({ _returned: 1, _embedded: [
    { _id: 'Data:Item/bandage', id: 'bandage', locales: { 'zh-CN': { name } } },
  ] }));
}
