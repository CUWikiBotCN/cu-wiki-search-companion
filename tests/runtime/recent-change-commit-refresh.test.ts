// SPDX-License-Identifier: MPL-2.0
import { CommittedRecentChangeRefresh } from '../../src/runtime/recent-change-commit-refresh';

describe('CommittedRecentChangeRefresh', () => {
  it.each(['refresh', 'broadcast', 'both'])(
    'preserves committed invalidation when %s fails',
    async (failure) => {
      const refreshError = new Error('index refresh failed');
      const broadcastError = new Error('broadcast failed');
      const broadcast = vi.fn(() => {
        if (failure !== 'refresh') throw broadcastError;
      });
      const refresh = new CommittedRecentChangeRefresh({
        refresh: async () => {
          if (failure !== 'broadcast') throw refreshError;
        },
        broadcast,
      });
      const committed = {
        throughLocalSeq: 13,
        filesChanged: true,
        dataCodesInvalidated: true,
      };
      await expect(refresh.apply(committed)).resolves.toEqual({
        dataCodesInvalidated: true,
        refreshError: failure === 'broadcast' ? broadcastError : refreshError,
      });
      expect(broadcast).toHaveBeenCalledExactlyOnceWith({
        type: 'committed',
        ...committed,
      });
    },
  );

  it('applies and broadcasts the durable RC sequence for every caller', async () => {
    const refreshed: unknown[] = [];
    const broadcasts: unknown[] = [];
    const refresh = new CommittedRecentChangeRefresh({
      refresh: async (invalidation) => {
        refreshed.push(invalidation);
      },
      broadcast: (message) => {
        broadcasts.push(message);
      },
    });

    await expect(
      refresh.apply({
        throughLocalSeq: 13,
        filesChanged: true,
        dataCodesInvalidated: true,
      }),
    ).resolves.toEqual({ dataCodesInvalidated: true });
    expect(refreshed).toEqual([{ pages: true, files: true }]);
    expect(broadcasts).toEqual([
      {
        type: 'committed',
        throughLocalSeq: 13,
        filesChanged: true,
        dataCodesInvalidated: true,
      },
    ]);
  });
});
