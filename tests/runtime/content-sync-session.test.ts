// SPDX-License-Identifier: MPL-2.0
import {
  ContentSyncSession,
  type ContentSyncSessionOptions,
} from '../../src/runtime/content-sync-session';
import { StagedPreparationCoordinator } from '../../src/runtime/staged-preparation';

describe('ContentSyncSession', () => {
  it('reports and preserves a failed settlement while keeping local preparation', async () => {
    const originalError = new Error('第二批正文请求失败');
    const synchronize = vi
      .fn<(force: boolean) => Promise<void>>()
      .mockRejectedValueOnce(originalError)
      .mockResolvedValue(undefined);
    const failures: unknown[] = [];
    const session = new ContentSyncSession({
      synchronize,
      reportFailure: (error) => {
        failures.push(error);
      },
    });
    const prepareLocal = vi.fn(async () => undefined);
    const preparation = new StagedPreparationCoordinator({
      prepareLocal,
      settle: () => session.run(false),
    });

    await expect(preparation.prepare()).rejects.toBe(originalError);
    await expect(preparation.prepare()).resolves.toBeUndefined();

    expect(prepareLocal).toHaveBeenCalledOnce();
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(failures).toEqual([originalError]);
  });

  it('shares covered requests and serializes different targets and forced work', async () => {
    const releases: Array<() => void> = [];
    const synchronize = vi.fn(
      () => new Promise<void>((resolve) => releases.push(resolve)),
    );
    const session = new ContentSyncSession({
      synchronize,
      reportFailure: vi.fn(),
    });
    const first = session.run(false, [1]);
    expect(session.run(false, [1])).toBe(first);
    const second = session.run(false, [2]);
    const global = session.run(false);
    expect(session.run(false, [3])).toBe(global);
    const forced = session.run(true, [1]);
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1));
    expect(synchronize).toHaveBeenNthCalledWith(1, false, [1]);
    releases[0]!();
    await first;
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(2));
    expect(synchronize).toHaveBeenNthCalledWith(2, false, [2]);
    releases[1]!();
    await second;
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(3));
    expect(synchronize).toHaveBeenNthCalledWith(3, false);
    releases[2]!();
    await global;
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(4));
    expect(synchronize).toHaveBeenNthCalledWith(4, true, [1]);
    releases[3]!();
    await forced;
  });

  it('skips stale queued intents and keeps a shared manual request valid inside the lock', async () => {
    let release!: () => void;
    let releaseLock!: () => void;
    let valid = true;
    let lockedCheck: (() => boolean) | undefined;
    const synchronize = vi.fn(
      async (
        _force: boolean,
        ids?: readonly number[],
        check?: () => boolean,
      ) => {
        if (ids?.[0] === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        } else {
          lockedCheck = check;
          await new Promise<void>((resolve) => {
            releaseLock = resolve;
          });
        }
      },
    );
    const session = new ContentSyncSession({
      synchronize,
      reportFailure: vi.fn(),
    });
    const first = session.run(false, [1]);
    const stale = session.run(false, [2], () => valid);
    valid = false;
    await vi.waitFor(() => expect(release).toBeDefined());
    release();
    await Promise.all([first, stale]);
    expect(synchronize).toHaveBeenCalledTimes(1);

    valid = true;
    const guarded = session.run(false, [3], () => valid);
    await vi.waitFor(() => expect(lockedCheck).toBeDefined());
    expect(session.run(false, [3])).toBe(guarded);
    valid = false;
    expect(lockedCheck!()).toBe(true);
    releaseLock();
    await guarded;
  });

  it('checks a page requested after a global sync started in a subsequent attempt', async () => {
    let release!: () => void;
    const synchronize = vi
      .fn<ContentSyncSessionOptions['synchronize']>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const session = new ContentSyncSession({
      synchronize,
      reportFailure: vi.fn(),
    });
    const global = session.run(false);
    await vi.waitFor(() => expect(release).toBeDefined());
    const page = session.run(false, [4]);
    expect(page).not.toBe(global);
    release();
    await Promise.all([global, page]);
    expect(synchronize).toHaveBeenNthCalledWith(2, false, [4]);
  });

  it('notifies all covered requests when the lock starts the shared work', async () => {
    let dispatch!: () => void;
    let finish!: () => void;
    const session = new ContentSyncSession({
      synchronize: async (_force, _ids, _check, onStarted) => {
        dispatch = onStarted!;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      reportFailure: vi.fn(),
    });
    const firstStart = vi.fn();
    const secondStart = vi.fn();
    const lateStart = vi.fn();
    const first = session.run(false, [1], () => true, firstStart);
    await vi.waitFor(() => expect(dispatch).toBeDefined());
    expect(session.run(false, [1], () => true, secondStart)).toBe(first);
    expect(firstStart).not.toHaveBeenCalled();
    dispatch();
    expect(firstStart).toHaveBeenCalledOnce();
    expect(secondStart).toHaveBeenCalledOnce();
    expect(session.run(false, [1], () => true, lateStart)).toBe(first);
    expect(lateStart).toHaveBeenCalledOnce();
    finish();
    await first;
  });
});
