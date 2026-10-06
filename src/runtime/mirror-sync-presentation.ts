// SPDX-License-Identifier: MPL-2.0
import type {
  MirrorSyncEvent,
  MirrorSyncOutcome,
} from './mirror-sync-orchestrator';

export type IncrementalRuntimeStatus =
  | 'idle'
  | 'running'
  | 'complete'
  | 'no-baseline'
  | 'login-required'
  | 'lock-unavailable'
  | 'error';

export type ReconciliationRuntimeStatus =
  | 'idle'
  | 'running'
  | 'complete'
  | 'not-due'
  | 'no-baseline'
  | 'login-required'
  | 'lock-unavailable'
  | 'error';

export interface MirrorSyncState {
  incrementalStatus: IncrementalRuntimeStatus;
  reconciliationStatus: ReconciliationRuntimeStatus;
  incrementalThrough?: string;
}

export interface MirrorSyncPresentation {
  state: MirrorSyncState;
  feedback?: { message: string; tone: 'normal' | 'success' | 'error' };
}

function copyState(current: MirrorSyncState): MirrorSyncState {
  return {
    incrementalStatus: current.incrementalStatus,
    reconciliationStatus: current.reconciliationStatus,
    incrementalThrough: current.incrementalThrough,
  };
}

export function presentMirrorSyncEvent(
  current: MirrorSyncState,
  event: MirrorSyncEvent,
): MirrorSyncPresentation {
  const state = copyState(current);
  if (event.type === 'started') {
    if (event.request === 'scheduled') state.incrementalStatus = 'running';
    else state.reconciliationStatus = 'running';
  } else {
    state.reconciliationStatus = 'running';
    if (event.type === 'reconciliation-progress')
      return {
        state,
        feedback: {
          message: `全量对账 ${event.state.pagesFetched} 页 · ${Math.min(event.state.namespaceIndex + 1, event.state.namespaceIds.length)}/${event.state.namespaceIds.length}`,
          tone: 'normal',
        },
      };
  }
  return { state };
}

export function presentMirrorSyncOutcome(
  current: MirrorSyncState,
  outcome: MirrorSyncOutcome,
): MirrorSyncPresentation {
  const state = copyState(current);
  const status = runtimeStatus(outcome.status);
  const reconciliation = outcome.reconciliation;
  if (reconciliation) {
    state.reconciliationStatus = reconciliation.status;
  }
  // A later derived-index failure does not undo a completed fact-sync phase.
  const recentChanges = outcome.recentChanges;
  if (recentChanges?.status === 'complete') {
    state.incrementalStatus = 'complete';
    state.incrementalThrough = recentChanges.through;
  } else if (recentChanges) {
    state.incrementalStatus = recentChanges.status;
  } else if (outcome.request === 'scheduled') {
    state.incrementalStatus = status === 'not-due' ? 'idle' : status;
  } else if (outcome.status === 'catch-up-error') {
    state.incrementalStatus = 'error';
  }
  if (!reconciliation && outcome.request === 'manual') {
    state.reconciliationStatus = status;
  } else if (
    !reconciliation &&
    outcome.errors?.synchronization &&
    state.reconciliationStatus === 'running'
  ) {
    state.reconciliationStatus = 'error';
  }
  if (outcome.errors?.committedRefresh) {
    if (outcome.request === 'scheduled') state.incrementalStatus = 'error';
    else state.reconciliationStatus = 'error';
  }

  function presentation(
    message: string,
    tone: 'success' | 'error',
  ): MirrorSyncPresentation {
    return { state, feedback: { message, tone } };
  }
  if (outcome.status === 'complete') {
    if (outcome.request === 'manual' && reconciliation?.status === 'complete') {
      return presentation(
        `全量对账完成 · ${reconciliation.pagesFetched} 页 · ${reconciliation.pagesChanged} 个页面变化` +
          (reconciliation.filesChanged ? ' · 文件资源已更新' : ''),
        'success',
      );
    } else if (
      recentChanges?.status === 'complete' &&
      (recentChanges.changedPages.length || recentChanges.filesChanged)
    ) {
      return presentation(
        `增量同步完成 · ${recentChanges.changedPages.length} 个页面` +
          (recentChanges.filesChanged ? ' · 文件资源已更新' : ''),
        'success',
      );
    }
    return { state };
  }
  if (outcome.status === 'not-due') return { state };
  const message = mirrorSyncOutcomeError(outcome).message;
  const prefix = outcome.request === 'manual' ? '全量对账' : '增量同步';
  return presentation(
    `${prefix}暂停，本地已有内容仍可搜索：${message}`,
    'error',
  );
}

export function mirrorSyncOutcomeError(outcome: MirrorSyncOutcome): Error {
  const cause =
    outcome.errors?.synchronization ??
    outcome.errors?.catchUp ??
    outcome.errors?.data ??
    outcome.errors?.content ??
    outcome.errors?.committedRefresh;
  if (cause instanceof Error) return cause;
  if (cause !== undefined) return new Error(String(cause));
  if (outcome.status === 'login-required') return new Error('请先登录灰机账号');
  if (outcome.status === 'lock-unavailable') {
    return new Error('无法取得跨标签写入锁，请确认浏览器支持 Web Locks 后重试');
  }
  if (outcome.status === 'no-baseline') {
    return new Error('尚无完整标题基线，请先重试标题同步');
  }
  if (outcome.status === 'not-due') return new Error('全量对账尚未到期');
  return new Error('同步未完成，请稍后重试');
}

function runtimeStatus(
  status: MirrorSyncOutcome['status'],
): ReconciliationRuntimeStatus {
  switch (status) {
    case 'catch-up-error':
    case 'data-error':
    case 'content-error':
      return 'error';
    default:
      return status;
  }
}
