// SPDX-License-Identifier: MPL-2.0
import type { MirrorSyncOutcome } from '../../src/runtime/mirror-sync-orchestrator';
import {
  mirrorSyncOutcomeError,
  presentMirrorSyncEvent,
  presentMirrorSyncOutcome,
  type MirrorSyncState,
} from '../../src/runtime/mirror-sync-presentation';
import type {
  RecentChangeSyncResult,
  ReconciliationSyncResult,
  ReconciliationSyncState,
} from '../../src/types';

const idle: MirrorSyncState = Object.freeze({
  incrementalStatus: 'idle',
  reconciliationStatus: 'idle',
  incrementalThrough: 'previous cursor',
});
const reconciliation: Extract<
  ReconciliationSyncResult,
  { status: 'complete' }
> = {
  status: 'complete',
  reason: 'manual',
  serverStartedAt: '2026-10-06T00:00:00Z',
  pagesFetched: 5,
  pagesChanged: 2,
  filesChanged: true,
  dataCodesInvalidated: false,
  throughLocalSeq: 3,
};
const recentChanges: Extract<RecentChangeSyncResult, { status: 'complete' }> = {
  status: 'complete',
  startedAt: '2026-10-06T00:00:00Z',
  through: '2026-10-06T00:00:01Z',
  eventsSeen: 0,
  candidates: 0,
  changedPages: [],
  deferredContentPageIds: [],
  filesChanged: false,
  dataCodesInvalidated: false,
  throughLocalSeq: 3,
};
function outcome(
  overrides: Partial<MirrorSyncOutcome> = {},
): MirrorSyncOutcome {
  return {
    request: 'scheduled',
    status: 'complete',
    coordination: 'ran',
    ...overrides,
  };
}

describe('mirror sync presentation', () => {
  it.each([
    ['not-due', 'idle', 'not-due'],
    ['complete', 'complete', 'complete'],
    ['no-baseline', 'no-baseline', 'no-baseline'],
    ['login-required', 'login-required', 'login-required'],
    ['lock-unavailable', 'lock-unavailable', 'lock-unavailable'],
    ['catch-up-error', 'error', 'error'],
    ['data-error', 'error', 'error'],
    ['content-error', 'error', 'error'],
    ['error', 'error', 'error'],
  ] as const)(
    'maps %s without inventing phase results',
    (status, incremental, manual) => {
      const scheduled = presentMirrorSyncOutcome(idle, outcome({ status }));
      expect(scheduled.state).toEqual({
        ...idle,
        incrementalStatus: incremental,
      });
      const requested = presentMirrorSyncOutcome(
        idle,
        outcome({ status, request: 'manual' }),
      );
      expect(requested.state).toEqual({
        ...idle,
        reconciliationStatus: manual,
        incrementalStatus: status === 'catch-up-error' ? 'error' : 'idle',
      });
      if (status === 'not-due' || status === 'complete') {
        expect(scheduled.feedback).toBeUndefined();
        expect(requested.feedback).toBeUndefined();
      } else {
        expect(scheduled.feedback).toMatchObject({
          tone: 'error',
          message:
            expect.stringContaining('增量同步暂停，本地已有内容仍可搜索：'),
        });
        expect(requested.feedback).toMatchObject({
          tone: 'error',
          message:
            expect.stringContaining('全量对账暂停，本地已有内容仍可搜索：'),
        });
      }
    },
  );

  it.each(['scheduled', 'manual'] as const)(
    'starts only the requested status (%s)',
    (request) => {
      expect(
        presentMirrorSyncEvent(idle, { type: 'started', request }),
      ).toEqual({
        state: {
          ...idle,
          [request === 'scheduled'
            ? 'incrementalStatus'
            : 'reconciliationStatus']: 'running',
        },
      });
      expect(
        presentMirrorSyncEvent(idle, {
          type: 'reconciliation-started',
          request,
        }),
      ).toEqual({ state: { ...idle, reconciliationStatus: 'running' } });
    },
  );

  it('reports bounded reconciliation progress without changing the cursor', () => {
    const state: ReconciliationSyncState = {
      ...reconciliation,
      status: 'running',
      scanProtocol: 2,
      namespaceIds: [0, 828],
      namespaceNames: { 0: '', 828: '模块' },
      namespaceIndex: 2,
      generation: 1,
      startLocalSeq: 1,
      startedAt: 1,
    };
    expect(
      presentMirrorSyncEvent(idle, { type: 'reconciliation-progress', state }),
    ).toEqual({
      state: { ...idle, reconciliationStatus: 'running' },
      feedback: { tone: 'normal', message: '全量对账 5 页 · 2/2' },
    });
  });

  it.each(['data-error', 'content-error'] as const)(
    'retains committed phase success when %s occurs',
    (status) => {
      const result = presentMirrorSyncOutcome(
        idle,
        outcome({ status, reconciliation, recentChanges }),
      );
      expect(result.state).toEqual({
        incrementalStatus: 'complete',
        reconciliationStatus: 'complete',
        incrementalThrough: recentChanges.through,
      });
      expect(result.feedback?.tone).toBe('error');
    },
  );

  it.each(['scheduled', 'manual'] as const)(
    'committed refresh failure overrides only the requesting status (%s)',
    (request) => {
      const result = presentMirrorSyncOutcome(
        idle,
        outcome({
          request,
          status: 'error',
          reconciliation,
          recentChanges,
          errors: { committedRefresh: new Error('refresh failed') },
        }),
      );
      expect(result.state).toEqual({
        incrementalStatus: request === 'scheduled' ? 'error' : 'complete',
        reconciliationStatus: request === 'manual' ? 'error' : 'complete',
        incrementalThrough: recentChanges.through,
      });
      expect(result.feedback?.message).toContain('refresh failed');
    },
  );

  it.each(['idle', 'running', 'complete'] as const)(
    'clears only a running reconciliation after synchronization throws (%s)',
    (reconciliationStatus) => {
      expect(
        presentMirrorSyncOutcome(
          { ...idle, reconciliationStatus },
          outcome({
            status: 'error',
            errors: { synchronization: new Error('failed') },
          }),
        ).state.reconciliationStatus,
      ).toBe(
        reconciliationStatus === 'running' ? 'error' : reconciliationStatus,
      );
    },
  );

  it('preserves a partial reconciliation and last cursor when catch-up fails', () => {
    const result = presentMirrorSyncOutcome(
      idle,
      outcome({ request: 'manual', status: 'catch-up-error', reconciliation }),
    );
    expect(result.state).toEqual({
      ...idle,
      incrementalStatus: 'error',
      reconciliationStatus: 'complete',
    });
    expect(result.feedback?.tone).toBe('error');
  });

  it.each(['login-required', 'no-baseline'] as const)(
    'uses recent-change phase %s without advancing the cursor',
    (status) => {
      const inactive: RecentChangeSyncResult = {
        status,
        eventsSeen: 0,
        candidates: 0,
        changedPages: [],
        deferredContentPageIds: [],
        filesChanged: false,
        dataCodesInvalidated: false,
        throughLocalSeq: 3,
      };
      expect(
        presentMirrorSyncOutcome(
          idle,
          outcome({ status, reconciliation, recentChanges: inactive }),
        ).state,
      ).toEqual({
        ...idle,
        incrementalStatus: status,
        reconciliationStatus: 'complete',
      });
    },
  );

  it('keeps a partially committed login-required reconciliation visible', () => {
    const result = presentMirrorSyncOutcome(
      idle,
      outcome({
        status: 'login-required',
        reconciliation: { ...reconciliation, status: 'login-required' },
      }),
    );
    expect(result.state.reconciliationStatus).toBe('login-required');
    expect(result.feedback?.message).toContain('请先登录灰机账号');
  });

  it('reports manual reconciliation success and silent no-change incremental success', () => {
    expect(
      presentMirrorSyncOutcome(
        idle,
        outcome({ request: 'manual', reconciliation, recentChanges }),
      ).feedback,
    ).toEqual({
      tone: 'success',
      message: '全量对账完成 · 5 页 · 2 个页面变化 · 文件资源已更新',
    });
    expect(
      presentMirrorSyncOutcome(idle, outcome({ recentChanges })).feedback,
    ).toBeUndefined();
    expect(
      presentMirrorSyncOutcome(
        idle,
        outcome({ recentChanges: { ...recentChanges, filesChanged: true } }),
      ).feedback,
    ).toEqual({
      tone: 'success',
      message: '增量同步完成 · 0 个页面 · 文件资源已更新',
    });
  });

  it('preserves error identity and the established phase priority', () => {
    const errors = {
      synchronization: new Error('sync'),
      catchUp: new Error('catch-up'),
      data: new Error('data'),
      content: new Error('content'),
      committedRefresh: new Error('refresh'),
    };
    for (const phase of [
      'synchronization',
      'catchUp',
      'data',
      'content',
      'committedRefresh',
    ] as const) {
      expect(mirrorSyncOutcomeError(outcome({ status: 'error', errors }))).toBe(
        errors[phase],
      );
      delete (errors as Partial<typeof errors>)[phase];
    }
    expect(
      mirrorSyncOutcomeError(outcome({ errors: { data: 'plain cause' } }))
        .message,
    ).toBe('plain cause');
  });
});
