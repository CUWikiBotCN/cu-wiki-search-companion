// SPDX-License-Identifier: MPL-2.0
import { SectionLinkPreparation } from '../../src/runtime/section-link-preparation';
import type { SectionSearchResult } from '../../src/search/section-title-index';

function row(id: number, sectionId = '10'): SectionSearchResult {
  return {
    kind: 'section',
    id,
    title: `页面${id}`,
    revisionId: 10,
    sourceSequence: 1,
    namespace: 0,
    namespaceName: '',
    sectionId,
    sectionTitle: '标题',
    sectionPath: [],
    headingStart: 10,
    level: 2,
    needsResolution: true,
  };
}
function harness() {
  const fragments = new Map<string, string>();
  const releases = new Map<number, { success(): void; fail(): void }>();
  const resolve = vi.fn(
    (result: SectionSearchResult) =>
      new Promise<ReadonlyMap<string, string>>((done, reject) => {
        releases.set(result.id, {
          success: () => {
            fragments.set(`${result.id}:${result.sectionId}`, '标题');
            done(new Map([[result.sectionId, '标题']]));
          },
          fail: () => reject(new Error('offline')),
        });
      }),
  );
  const getFragment = (result: SectionSearchResult) =>
    fragments.get(`${result.id}:${result.sectionId}`);
  const current = vi.fn(() => true);
  const needed = vi.fn((result: SectionSearchResult) => !getFragment(result));
  const changed = vi.fn();
  const queue = new SectionLinkPreparation({
    links: { resolve, getFragment, invalidate: vi.fn() },
    current,
    needed,
    changed,
  });
  return { queue, resolve, releases, fragments, current, needed, changed };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('debounces three distinct pages and caps speculative concurrency at two', async () => {
  const { queue, resolve, releases } = harness();
  queue.update([row(1), row(1, '20'), row(2), row(3), row(4)]);
  await vi.advanceTimersByTimeAsync(299);
  expect(resolve).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(resolve.mock.calls.map(([r]) => r.id)).toEqual([1, 2]);
  releases.get(1)!.success();
  await vi.advanceTimersByTimeAsync(0);
  expect(resolve.mock.calls.map(([r]) => r.id)).toEqual([1, 2, 3]);
  queue.destroy();
  releases.get(2)!.success();
  releases.get(3)!.success();
});

it('merges an action into an active request and prioritizes actions over queued background work', async () => {
  const { queue, resolve, releases } = harness();
  queue.update([row(1), row(2), row(3)]);
  await vi.advanceTimersByTimeAsync(300);
  const same = queue.request(row(1));
  const action = queue.request(row(4));
  expect(resolve).toHaveBeenCalledTimes(2);
  releases.get(1)!.success();
  await same;
  expect(resolve.mock.calls.map(([r]) => r.id)).toEqual([1, 2, 4]);
  releases.get(4)!.success();
  await action;
  queue.destroy();
  releases.get(2)!.success();
  releases.get(3)?.success();
});

it('prepares a preferred fourth page first and removes obsolete queued pages', async () => {
  const { queue, resolve, releases } = harness();
  queue.update([row(1), row(2), row(3), row(4)], row(4));
  await vi.advanceTimersByTimeAsync(150);
  expect(resolve.mock.calls.map(([r]) => r.id)).toEqual([4, 1]);
  queue.update([row(5)]);
  releases.get(4)!.success();
  releases.get(1)!.success();
  await vi.advanceTimersByTimeAsync(300);
  expect(resolve.mock.calls.map(([r]) => r.id)).toEqual([4, 1, 5]);
  queue.destroy();
  releases.get(5)!.success();
});

it('clears queued work on intent changes and suppresses late UI notifications after destruction', async () => {
  const { queue, resolve, releases, changed } = harness();
  queue.update([row(1), row(2), row(3)], undefined, true);
  await vi.advanceTimersByTimeAsync(0);
  const action = queue.request(row(4));
  const rejected = expect(action).rejects.toThrow('取消');
  queue.clear();
  await rejected;
  queue.destroy();
  releases.get(1)!.success();
  releases.get(2)!.success();
  await vi.advanceTimersByTimeAsync(500);
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(changed).not.toHaveBeenCalled();
});

it('logs a failed page once, cools automatic attempts, and lets a user retry immediately', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { queue, resolve, releases } = harness();
  queue.update([row(1)], undefined, true);
  await vi.advanceTimersByTimeAsync(0);
  releases.get(1)!.fail();
  await vi.advanceTimersByTimeAsync(0);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning.mock.calls[0]![1]).toMatchObject({
    pageId: 1,
    revisionId: 10,
    trigger: 'prefetch',
  });
  expect(JSON.stringify(warning.mock.calls)).not.toContain('页面1');
  queue.clear();
  queue.update([row(1)]);
  await vi.advanceTimersByTimeAsync(300);
  expect(resolve).toHaveBeenCalledTimes(1);
  const action = queue.request(row(1));
  expect(resolve).toHaveBeenCalledTimes(2);
  releases.get(1)!.success();
  await action;
  expect(warning).toHaveBeenCalledTimes(1);
  queue.destroy();
});

it('allows another mapped section to use a shared response whose representative could not be mapped', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { queue, fragments, releases, resolve } = harness();
  const missing = queue.request(row(1));
  const rejection = expect(missing).rejects.toThrow('offline');
  const mapped = queue.request(row(1, '20'));
  fragments.set('1:20', '别的标题');
  releases.get(1)!.fail();
  await rejection;
  await mapped;
  expect(resolve).toHaveBeenCalledOnce();
  queue.destroy();
});

it('skips fresh cache and schedules a refresh when evidence becomes stale without changing targets', async () => {
  const { queue, resolve, needed, releases } = harness();
  needed.mockReturnValue(false);
  queue.update([row(1)]);
  await vi.advanceTimersByTimeAsync(300);
  expect(resolve).not.toHaveBeenCalled();
  needed.mockReturnValue(true);
  queue.update([row(1)]);
  await vi.advanceTimersByTimeAsync(300);
  expect(resolve).toHaveBeenCalledOnce();
  queue.destroy();
  releases.get(1)!.success();
});

it('does not log source invalidation as a network failure', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { queue, releases, current } = harness();
  queue.update([row(1)], undefined, true);
  await vi.advanceTimersByTimeAsync(0);
  current.mockReturnValue(false);
  releases.get(1)!.fail();
  await vi.advanceTimersByTimeAsync(0);
  expect(warning).not.toHaveBeenCalled();
  queue.destroy();
});

it('moves a newly selected page ahead of already queued speculation', async () => {
  const { queue, resolve, releases } = harness();
  queue.update([row(1), row(2), row(3), row(4)]);
  await vi.advanceTimersByTimeAsync(300);
  queue.update([row(1), row(2), row(3), row(4)], row(4));
  await vi.advanceTimersByTimeAsync(150);
  releases.get(1)!.success();
  await vi.advanceTimersByTimeAsync(0);
  expect(resolve.mock.calls.map(([result]) => result.id)).toEqual([1, 2, 4]);
  queue.destroy();
  releases.get(2)!.success();
  releases.get(4)!.success();
});
