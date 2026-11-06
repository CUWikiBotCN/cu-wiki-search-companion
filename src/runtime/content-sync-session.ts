// SPDX-License-Identifier: MPL-2.0

export interface ContentSyncSessionOptions {
  synchronize(
    force: boolean,
    pageIds?: readonly number[],
    shouldRun?: () => boolean,
    onStarted?: () => void,
  ): Promise<void>;
  reportFailure(error: unknown): void;
}

interface Attempt {
  force: boolean;
  pageIds: ReadonlySet<number> | undefined;
  started: boolean;
  dispatched: boolean;
  canNotifyStart: boolean;
  predicates: Array<(() => boolean) | undefined>;
  startedCallbacks: Array<() => void>;
  promise: Promise<void>;
}

/** Serializes different ranges and shares attempts that already cover a request. */
export class ContentSyncSession {
  private readonly attempts: Attempt[] = [];

  constructor(private readonly options: ContentSyncSessionOptions) {}

  run(
    force: boolean,
    pageIds?: readonly number[],
    shouldRun?: () => boolean,
    onStarted?: () => void,
  ): Promise<void> {
    const requested = pageIds === undefined ? undefined : new Set(pageIds);
    const covered = this.attempts.find(
      (attempt) =>
        (!force || attempt.force) &&
        (!onStarted || !attempt.started || attempt.canNotifyStart) &&
        ((attempt.pageIds === undefined &&
          (requested === undefined || !attempt.started)) ||
          (requested !== undefined &&
            [...requested].every((id) => attempt.pageIds?.has(id)))),
    );
    if (covered) {
      covered.predicates.push(shouldRun);
      if (onStarted) {
        if (covered.dispatched) onStarted();
        else covered.startedCallbacks.push(onStarted);
      }
      return covered.promise;
    }

    const previous = this.attempts.at(-1)?.promise;
    const attempt: Attempt = {
      force,
      pageIds: requested,
      started: false,
      dispatched: false,
      canNotifyStart: false,
      predicates: [shouldRun],
      startedCallbacks: onStarted ? [onStarted] : [],
      promise: Promise.resolve(),
    };
    const isWanted = () =>
      attempt.predicates.some((predicate) => !predicate || predicate());
    const execute = async () => {
      if (!isWanted()) return;
      attempt.started = true;
      const ids = requested === undefined ? undefined : [...requested];
      if (attempt.startedCallbacks.length) {
        attempt.canNotifyStart = true;
        await this.options.synchronize(force, ids, isWanted, () => {
          attempt.dispatched = true;
          for (const callback of attempt.startedCallbacks.splice(0)) callback();
        });
      } else if (shouldRun) {
        await this.options.synchronize(force, ids, isWanted);
      } else if (ids !== undefined) {
        await this.options.synchronize(force, ids);
      } else {
        await this.options.synchronize(force);
      }
    };
    const reported = (
      previous ? previous.catch(() => undefined) : Promise.resolve()
    )
      .then(execute)
      .catch((error: unknown) => {
        try {
          this.options.reportFailure(error);
        } catch {
          // Reporting must not replace the synchronization failure.
        }
        throw error;
      });
    attempt.promise = reported.finally(() => {
      const index = this.attempts.indexOf(attempt);
      if (index >= 0) this.attempts.splice(index, 1);
    });
    this.attempts.push(attempt);
    return attempt.promise;
  }
}
