// SPDX-License-Identifier: MPL-2.0
import type { SectionSearchResult } from '../search/section-title-index';
import type { SectionLinkLookup } from './section-search-runtime';
import { WikiApiError } from '../sync/wiki-api';

export class SectionPreparationCancelled extends Error {
  constructor() {
    super('小节准备已取消');
  }
}

interface Task {
  result: SectionSearchResult;
  action: boolean;
  started: boolean;
  promise: Promise<void>;
  finish(error?: unknown): void;
}

/** Bounded page-level work, shared by speculative preparation and explicit actions. */
export class SectionLinkPreparation {
  private tasks = new Map<string, Task>();
  private cooldown = new Map<string, number>();
  private candidates: SectionSearchResult[] = [];
  private signature = '';
  private timer?: ReturnType<typeof setTimeout>;
  private running = 0;
  private destroyed = false;

  constructor(
    private readonly options: {
      links: SectionLinkLookup;
      current(result: SectionSearchResult): boolean;
      needed(result: SectionSearchResult): boolean;
      changed(): void;
    },
  ) {}

  update(
    results: SectionSearchResult[],
    preferred?: SectionSearchResult,
    immediate = false,
  ): void {
    const pages = new Map<number, SectionSearchResult>();
    for (const result of results) {
      if (!pages.has(result.id)) pages.set(result.id, result);
      if (pages.size === 3) break;
    }
    const candidates = [...pages.values()];
    if (preferred) {
      const at = candidates.findIndex((value) => value.id === preferred.id);
      if (at >= 0) candidates.splice(at, 1);
      candidates.unshift(preferred);
    }
    const signature = JSON.stringify(
      candidates.map((result) => [keyOf(result), this.options.needed(result)]),
    );
    if (signature === this.signature) return;
    this.signature = signature;
    this.candidates = candidates;
    clearTimeout(this.timer);
    const wanted = new Set(candidates.map(keyOf));
    for (const [key, task] of this.tasks) {
      if (!task.started && !task.action && !wanted.has(key)) {
        this.tasks.delete(key);
        task.finish(new SectionPreparationCancelled());
      }
    }
    this.timer = setTimeout(
      () => {
        for (const result of this.candidates) {
          if (
            !this.options.current(result) ||
            !this.options.needed(result) ||
            (this.cooldown.get(keyOf(result)) ?? 0) > Date.now()
          )
            continue;
          // The worker logs one failure per page request; no UI warning for speculation.
          void this.enqueue(result, false).catch(() => {});
        }
        this.pump();
      },
      immediate ? 0 : preferred ? 150 : 300,
    );
  }

  async request(result: SectionSearchResult): Promise<void> {
    if (this.destroyed) throw new SectionPreparationCancelled();
    let failure: unknown;
    const task = this.enqueue(result, true);
    this.pump();
    try {
      await task;
    } catch (error) {
      failure = error;
    }
    // A page response may map one section but not another. Check each caller,
    // even when the representative section of the shared task was ambiguous.
    if (this.options.current(result) && this.options.links.getFragment(result))
      return;
    if (!this.options.current(result))
      throw new Error('小节已更新，请重新选择');
    throw failure ?? new Error('无法确定此小节链接，可重试或打开所属页面');
  }

  clear(): void {
    clearTimeout(this.timer);
    this.signature = '';
    this.candidates = [];
    for (const [key, task] of this.tasks) {
      if (!task.started) {
        this.tasks.delete(key);
        task.finish(new SectionPreparationCancelled());
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.clear();
  }

  private enqueue(result: SectionSearchResult, action: boolean): Promise<void> {
    const key = keyOf(result);
    const existing = this.tasks.get(key);
    if (existing) {
      existing.action ||= action;
      return existing.promise;
    }
    let finish!: Task['finish'];
    const promise = new Promise<void>((resolve, reject) => {
      finish = (error) => (error === undefined ? resolve() : reject(error));
    });
    this.tasks.set(key, { result, action, started: false, promise, finish });
    return promise;
  }

  private pump(): void {
    if (this.destroyed) return;
    while (this.running < 2) {
      const queued = [...this.tasks.values()].filter((task) => !task.started);
      const task =
        queued.find((task) => task.action) ??
        this.candidates
          .map((result) =>
            queued.find((task) => keyOf(task.result) === keyOf(result)),
          )
          .find(Boolean) ??
        queued[0];
      if (!task) return;
      task.started = true;
      this.running += 1;
      void this.run(task);
    }
  }

  private async run(task: Task): Promise<void> {
    const key = keyOf(task.result);
    const started = performance.now();
    try {
      if (this.destroyed || !this.options.current(task.result))
        throw new SectionPreparationCancelled();
      await this.options.links.resolve(task.result);
      this.cooldown.delete(key);
      task.finish();
    } catch (error) {
      if (
        !(error instanceof SectionPreparationCancelled) &&
        !this.destroyed &&
        this.options.current(task.result)
      ) {
        this.cooldown.delete(key);
        this.cooldown.set(key, Date.now() + 30_000);
        while (this.cooldown.size > 64)
          this.cooldown.delete(this.cooldown.keys().next().value!);
        console.warn('[CU Wiki Search] section link preparation failed', {
          pageId: task.result.id,
          revisionId: task.result.revisionId,
          sourceSequence: task.result.sourceSequence,
          trigger: task.action ? 'action' : 'prefetch',
          elapsedMs: Math.round(performance.now() - started),
          code:
            error instanceof WikiApiError ? error.code : 'section-unresolved',
          status: error instanceof WikiApiError ? error.status : undefined,
          message:
            error instanceof WikiApiError
              ? error.name
              : error instanceof Error
                ? error.message.slice(0, 180)
                : 'Unknown error',
        });
      }
      task.finish(error);
    } finally {
      this.tasks.delete(key);
      this.running -= 1;
      if (!this.destroyed) this.options.changed();
      this.pump();
    }
  }
}

function keyOf(result: SectionSearchResult): string {
  return JSON.stringify([
    result.id,
    result.revisionId,
    result.sourceSequence,
    result.title,
  ]);
}
