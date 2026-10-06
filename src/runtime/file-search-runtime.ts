// SPDX-License-Identifier: MPL-2.0
import type { Analyzer } from '../analyzer/analyzer';
import {
  LinearTitleIndex,
  type TitleSearchResult,
} from '../search/title-index';
import type { WikiSearchDatabase } from '../storage/database';
import { syncFileResources } from '../sync/file-resource-sync';
import type { ExclusiveSyncResult } from '../sync/incremental-sync-coordinator';
import type { WikiApi } from '../sync/wiki-api';
import type { TitleSyncProgress, TitleSyncState } from '../types';

interface FileSearchRuntimeOptions {
  database: WikiSearchDatabase;
  api: WikiApi;
  analyzer: Analyzer;
  waitUntilReady(): Promise<void>;
  canWrite(): boolean;
  runExclusive(task: () => Promise<void>): Promise<ExclusiveSyncResult>;
  onStateChange(state: FileSearchRuntimeState): void;
  onResultsChanged?(): void;
  onRestored(count: number): void;
  onProgress(progress: TitleSyncProgress): void;
  onCommitted(state: TitleSyncState): Promise<void>;
}

export interface FileSearchRuntimeState {
  loaded: boolean;
  indexedFiles: number;
}

/** Owns lazy file loading and one retryable synchronization attempt per tab. */
export class FileSearchRuntime {
  private index: LinearTitleIndex | undefined;
  private ready: Promise<void> | undefined;
  private readySettled = false;
  private syncPromise: Promise<void> | undefined;
  private lastAppliedChangeSeq = 0;

  constructor(private readonly options: FileSearchRuntimeOptions) {}

  get state(): FileSearchRuntimeState {
    return {
      loaded: this.index !== undefined,
      indexedFiles: this.index?.size ?? 0,
    };
  }

  search(query: string): TitleSearchResult[] {
    return this.index?.search(query) ?? [];
  }

  prepare(force = false): Promise<void> {
    if (!this.ready) {
      this.readySettled = false;
      this.ready = (async () => {
        await this.options.waitUntilReady();
        await this.loadIndex();
        this.options.onRestored(this.state.indexedFiles);
        await this.synchronize(force);
      })()
        .then(() => {
          this.readySettled = true;
        })
        .catch((error: unknown) => {
          this.ready = undefined;
          this.readySettled = false;
          throw error;
        });
      return this.ready;
    }
    return force && this.readySettled ? this.synchronize(true) : this.ready;
  }

  async refresh(changeSeq: number, force = false): Promise<void> {
    if (!force && changeSeq <= this.lastAppliedChangeSeq) return;
    // A storage notification must never activate the unused file mode.
    if (this.index) await this.loadIndex();
    this.lastAppliedChangeSeq = changeSeq;
  }

  private async loadIndex(): Promise<void> {
    const files = await this.options.database.fileResources
      .filter((file) => !file.deleted)
      .toArray();
    this.index = new LinearTitleIndex(this.options.analyzer, files);
    this.options.onStateChange(this.state);
    this.options.onResultsChanged?.();
  }

  private async synchronize(force: boolean): Promise<void> {
    if (!this.options.canWrite()) return;
    if (this.syncPromise) return this.syncPromise;
    const task = (async () => {
      let finalState: TitleSyncState | undefined;
      const coordinated = await this.options.runExclusive(async () => {
        finalState = await syncFileResources(
          this.options.database,
          this.options.api,
          this.options.analyzer,
          {
            force,
            onBatch: (batch) => {
              this.index?.update(batch);
              this.options.onStateChange(this.state);
              if (batch.length && this.index) this.options.onResultsChanged?.();
            },
            onProgress: this.options.onProgress,
          },
        );
      });
      if (coordinated === 'lock-unavailable') {
        throw new Error(
          '无法取得跨标签写入锁，请确认浏览器支持 Web Locks 后重试',
        );
      }
      if (!finalState) throw new Error('文件资源同步未返回结果');
      await this.options.onCommitted(finalState);
    })();
    this.syncPromise = task;
    try {
      await task;
    } finally {
      if (this.syncPromise === task) this.syncPromise = undefined;
    }
  }
}
