// SPDX-License-Identifier: MPL-2.0
import type { Analyzer } from '../analyzer/analyzer';
import {
  DEFAULT_DATA_CODE_RULES,
  parseDataFieldRules,
  upgradeDefaultDataCodeRules,
} from '../data/data-field-rules';
import {
  DataCodeIndex,
  type DataCodeSearchResult,
} from '../search/data-code-index';
import type { WikiSearchDatabase } from '../storage/database';
import type { DataRulesPreferenceStore } from '../storage/data-rules-preference';
import {
  readDataCodeSyncState,
  syncDataCodes,
  type DataCodeSyncResult,
} from '../sync/data-code-sync';
import {
  DataCodeSyncSession,
  type DataCodeSessionResult,
} from './data-code-sync-session';

export interface DataCodeCommit {
  origin: 'refresh' | 'save';
  rulesSource: string;
  result: DataCodeSyncResult;
}

export interface DataCodeRuntimeState {
  indexedDataCodes: number;
  rulesSource: string;
}

interface DataCodeRuntimeOptions {
  database: WikiSearchDatabase;
  analyzer: Analyzer;
  preference: Pick<DataRulesPreferenceStore, 'get' | 'set'>;
  runWriter(key: string, task: () => Promise<void>): Promise<void>;
  onStateChange(state: DataCodeRuntimeState): void;
  onResultsChanged?(): void;
  onRulesChange(source: string): void;
  onCommitted(commit: DataCodeCommit): void;
  onInvalidRules(origin: string, error: unknown): void;
}

/** Owns Data rules, cached search and the refresh/save operation FIFO. */
export class DataCodeRuntime {
  private index: DataCodeIndex | undefined;
  private rulesSource = DEFAULT_DATA_CODE_RULES;
  private session: DataCodeSyncSession<DataCodeCommit> | undefined;

  constructor(private readonly options: DataCodeRuntimeOptions) {}

  get state(): DataCodeRuntimeState {
    return {
      indexedDataCodes: this.index?.size ?? 0,
      rulesSource: this.rulesSource,
    };
  }

  search(query: string): DataCodeSearchResult[] {
    return this.index?.search(query) ?? [];
  }

  async initialize(): Promise<void> {
    const { database, preference } = this.options;
    const [records, stored] = await Promise.all([
      database.dataCodes.toArray(),
      readDataCodeSyncState(database),
    ]);
    const preferred = await preference.get();
    for (const [source, origin] of [
      [upgradeDefaultDataCodeRules(preferred), 'GM preference'],
      [upgradeDefaultDataCodeRules(stored?.rulesSource), 'data-code-sync'],
    ] as const) {
      if (typeof source !== 'string') continue;
      try {
        parseDataFieldRules(source);
        this.rulesSource = source;
        if (
          (origin === 'GM preference' && source !== preferred) ||
          (origin === 'data-code-sync' && preferred === undefined)
        )
          await preference.set(source);
        break;
      } catch (error) {
        this.options.onInvalidRules(origin, error);
      }
    }
    this.index = new DataCodeIndex(this.options.analyzer, records);
    this.session = new DataCodeSyncSession({
      refresh: (force) => this.performRefresh(force),
      save: (source) => this.performSave(source),
      apply: (commit) => {
        this.index = new DataCodeIndex(
          this.options.analyzer,
          commit.result.records,
        );
        this.rulesSource = commit.rulesSource;
        this.options.onRulesChange(this.rulesSource);
        this.options.onStateChange(this.state);
        this.options.onResultsChanged?.();
        this.options.onCommitted(commit);
      },
    });
    this.options.onRulesChange(this.rulesSource);
    this.options.onStateChange(this.state);
    this.options.onResultsChanged?.();
  }

  refresh(force: boolean): Promise<DataCodeSessionResult<DataCodeCommit>> {
    return (
      this.session?.refresh(force) ??
      Promise.resolve({
        status: 'error',
        error: new Error('Data 代码同步尚未就绪'),
      })
    );
  }

  async save(source: string): Promise<void> {
    parseDataFieldRules(source);
    if (!this.session) throw new Error('Data 代码同步尚未就绪');
    const outcome = await this.session.save(source);
    if (outcome.status === 'error') throw outcome.error;
  }

  async reloadFromStorage(): Promise<void> {
    if (!this.index) return;
    const stored = await readDataCodeSyncState(this.options.database);
    const records = await this.options.database.dataCodes.toArray();
    this.index = new DataCodeIndex(this.options.analyzer, records);
    if (typeof stored?.rulesSource === 'string') {
      try {
        const source =
          upgradeDefaultDataCodeRules(stored.rulesSource) ?? stored.rulesSource;
        parseDataFieldRules(source);
        this.rulesSource = source;
        this.options.onRulesChange(source);
      } catch (error) {
        this.options.onInvalidRules('broadcast', error);
      }
    }
    this.options.onStateChange(this.state);
    this.options.onResultsChanged?.();
  }

  private async performRefresh(force: boolean): Promise<DataCodeCommit> {
    let result: DataCodeSyncResult | undefined;
    let rulesSource = this.rulesSource;
    await this.options.runWriter('data-refresh', async () => {
      rulesSource = await this.readCanonicalRules();
      result = await syncDataCodes(
        this.options.database,
        this.options.analyzer,
        {
          force,
          rulesSource,
        },
      );
    });
    if (!result) throw new Error('Data 代码同步未返回结果');
    return { origin: 'refresh', rulesSource, result };
  }

  private async performSave(source: string): Promise<DataCodeCommit> {
    let result: DataCodeSyncResult | undefined;
    await this.options.runWriter('data-save', async () => {
      result = await syncDataCodes(
        this.options.database,
        this.options.analyzer,
        {
          force: true,
          rulesSource: source,
        },
      );
      // The preference and matching cache commit share the same writer lock.
      await this.options.preference.set(source);
    });
    if (!result) throw new Error('Data 代码规则保存未返回结果');
    return { origin: 'save', rulesSource: source, result };
  }

  private async readCanonicalRules(): Promise<string> {
    const preferred = await this.options.preference.get();
    const stored = await readDataCodeSyncState(this.options.database);
    for (const source of [
      upgradeDefaultDataCodeRules(preferred),
      upgradeDefaultDataCodeRules(stored?.rulesSource),
      upgradeDefaultDataCodeRules(this.rulesSource),
    ]) {
      if (typeof source !== 'string') continue;
      try {
        parseDataFieldRules(source);
        return source;
      } catch {
        // Continue to the next durable/local source.
      }
    }
    return DEFAULT_DATA_CODE_RULES;
  }
}
