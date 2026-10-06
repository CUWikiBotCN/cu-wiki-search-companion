// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';

import {
  Analyzer,
  createBootstrapSegmenter,
} from '../../src/analyzer/analyzer';
import type { PageRecord } from '../../src/types';
import {
  CombinedTitleIndex,
  LinearTitleIndex,
  type TitleSearchBackend,
} from '../../src/search/title-index';

const analyzer = new Analyzer(createBootstrapSegmenter());
const pages: PageRecord[] = [
  page(1, '12号鹿弹', 0, ''),
  page(2, '模板:PopupNotice', 10, '模板'),
  page(3, '鹿弹', 0, ''),
  { ...page(4, '已删除标题', 0, ''), deleted: true },
];

describe('LinearTitleIndex', () => {
  it('is immediately searchable by Chinese substring and ranks exact titles first', () => {
    const index = new LinearTitleIndex(analyzer, pages);

    expect(index.search('鹿彈').map((result) => result.title)).toEqual([
      '鹿弹',
      '12号鹿弹',
    ]);
  });

  it('supports Latin infixes and namespace filtering', () => {
    const index = new LinearTitleIndex(analyzer, pages);

    expect(index.search('opu', 10).map((result) => result.title)).toEqual([
      '模板:PopupNotice',
    ]);
    expect(index.search('opu', 0)).toEqual([]);
  });

  it('keeps direct fallback matches when the enhanced index misses', () => {
    const emptyPrimary: TitleSearchBackend = {
      size: pages.length,
      search: () => [],
    };
    const index = new CombinedTitleIndex(
      emptyPrimary,
      new LinearTitleIndex(analyzer, pages),
    );

    expect(index.search('鹿弹')[0]?.title).toBe('鹿弹');
  });

  it('copies only stable title fields instead of retaining mutable page facts', () => {
    const source = {
      ...page(5, '医疗指南', 0, ''),
      content: '不应被轻量标题索引保留的长正文',
    };
    const index = new LinearTitleIndex(analyzer, [source]);

    source.title = '已被外部修改';
    source.namespaceName = '已被外部修改';

    expect(index.search('医疗')[0]).toMatchObject({
      id: 5,
      title: '医疗指南',
      namespaceName: '',
    });
  });

  it('applies added, renamed, and deleted title rows incrementally', () => {
    const index = new LinearTitleIndex(analyzer, [
      page(6, '文件:旧名称.png', 6, '文件'),
      page(7, '文件:待删除.png', 6, '文件'),
    ]);

    index.update([
      page(6, '文件:新名称.png', 6, '文件'),
      page(8, '文件:新增.png', 6, '文件'),
      { ...page(7, '文件:待删除.png', 6, '文件'), deleted: true },
    ]);

    expect(index.search('旧名称')).toEqual([]);
    expect(index.search('新名称')[0]?.id).toBe(6);
    expect(index.search('新增')[0]?.id).toBe(8);
    expect(index.search('待删除')).toEqual([]);
    expect(index.size).toBe(2);
  });

  it('summarizes namespaces from active lightweight entries and drops the last deleted page', () => {
    const index = new LinearTitleIndex(analyzer, pages);

    expect(index.namespaceSummary()).toEqual([
      { id: 0, name: '（主）' },
      { id: 10, name: '模板' },
    ]);
    index.update([
      { ...page(2, '模板:PopupNotice', 10, '模板'), deleted: true },
    ]);
    expect(index.namespaceSummary()).toEqual([{ id: 0, name: '（主）' }]);
    index.update([
      { ...page(1, '12号鹿弹', 0, ''), deleted: true },
      { ...page(3, '鹿弹', 0, ''), deleted: true },
    ]);
    expect(index.namespaceSummary()).toEqual([]);
  });

  it('updates namespace moves and picks the latest name regardless of insertion order', () => {
    const older = { ...page(9, '模板:旧页', 10, '旧模板名'), localSeq: 1 };
    const newer = { ...page(1, '模板:新页', 10, '新模板名'), localSeq: 3 };
    const index = new LinearTitleIndex(analyzer, [newer, older]);

    expect(index.namespaceSummary()).toEqual([{ id: 10, name: '新模板名' }]);
    index.update([{ ...older, namespaceName: '更新模板名', localSeq: 4 }]);
    expect(index.namespaceSummary()).toEqual([{ id: 10, name: '更新模板名' }]);
    index.update([{ ...page(9, '模块:移动页', 828, '模块'), localSeq: 5 }]);
    expect(index.namespaceSummary()).toEqual([
      { id: 10, name: '新模板名' },
      { id: 828, name: '模块' },
    ]);
    index.update([{ ...page(1, '模块:移动新页', 828, '模块'), localSeq: 6 }]);
    expect(index.namespaceSummary()).toEqual([{ id: 828, name: '模块' }]);
    expect(
      index.search('移动').every((result) => !('localSeq' in result)),
    ).toBe(true);
  });

  it('uses a stable page-id tie-breaker for equal-sequence namespace names', () => {
    const sameSequence = [
      { ...page(1, '模板:一', 10, '旧模板名'), localSeq: 5 },
      { ...page(2, '模板:二', 10, '新模板名'), localSeq: 5 },
    ];
    const forward = new LinearTitleIndex(analyzer, sameSequence);
    const reverse = new LinearTitleIndex(analyzer, [...sameSequence].reverse());

    expect(forward.namespaceSummary()).toEqual([{ id: 10, name: '新模板名' }]);
    expect(reverse.namespaceSummary()).toEqual(forward.namespaceSummary());
  });
});

function page(
  id: number,
  title: string,
  namespace: number,
  namespaceName: string,
): PageRecord {
  return {
    id,
    title,
    normalizedTitle: analyzer.normalize(title),
    namespace,
    namespaceName,
    isRedirect: false,
    localSeq: id,
    seenInTitleSync: 1,
  };
}
