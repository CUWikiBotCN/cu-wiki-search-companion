// SPDX-License-Identifier: MPL-2.0
import { cut, cut_for_search } from 'jieba-wasm/node';
import FullOpenCC from 'opencc-js';
import NarrowOpenCC from 'opencc-js/t2cn';

import {
  Analyzer,
  bigrams,
  latinParts,
  latinRuns,
} from '../../src/analyzer/analyzer';

const analyzer = new Analyzer({ cut, cutForSearch: cut_for_search });

describe('Analyzer', () => {
  it('keeps the full entry conversion dictionaries and normalization samples', () => {
    expect(NarrowOpenCC.Locale.to.cn).toEqual(FullOpenCC.Locale.to.cn);
    expect(NarrowOpenCC.Locale.configs.t2s).toEqual(
      FullOpenCC.Locale.configs.t2s,
    );
    const convert = FullOpenCC.Converter({ from: 't', to: 'cn' });
    for (const sample of [
      ' ＭＯＤ　安裝教學 ',
      'L.R.D. 血清',
      '醫用級興奮劑',
      '鹿',
      '鹿x',
      'getId',
      'sleepQuality 高品質睡眠可以恢復健康。',
      '睡眠 健康',
      '模組:Foo.bar-test',
      '乾燥 頭髮 發展 裝備 藥物 治療',
    ]) {
      const expected = convert(sample.normalize('NFKC'))
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
      expect(analyzer.normalize(sample)).toBe(expected);
    }
  });

  it('normalizes width, case and traditional Chinese', () => {
    expect(analyzer.normalize(' ＭＯＤ　安裝教學 ')).toBe('mod 安装教学');
    expect(analyzer.compact('L.R.D. 血清')).toBe('lrd血清');
  });

  it('adds CJK bigrams and jieba search tokens to documents', () => {
    const tokens = analyzer.documentTokens('医用级兴奋剂');
    expect(tokens).toEqual(
      expect.arrayContaining(['医', '用', '医用', '兴奋', '奋剂']),
    );
  });

  it('only creates CJK bigrams inside contiguous CJK runs', () => {
    expect(analyzer.documentTokens('医疗 救治')).not.toContain('疗救');
    expect(analyzer.documentTokens('医疗ABC救治')).not.toContain('疗救');
    expect(analyzer.documentTokens('医疗-救治')).not.toContain('疗救');
    expect(analyzer.queryTokens('医疗 救治')).not.toContain('疗救');
    expect(analyzer.queryTokens('医疗ABC救治')).not.toContain('疗救');
    expect(analyzer.queryTokens('医疗-救治')).not.toContain('疗救');
  });

  it('keeps a lone CJK character as the only query token', () => {
    expect(analyzer.queryTokens('鹿')).toEqual(['鹿']);
  });

  it('keeps short mixed-script and camelCase terms searchable', () => {
    expect(analyzer.queryTokens('x')).toContain('x');
    expect(analyzer.queryTokens('鹿x')).toEqual(
      expect.arrayContaining(['鹿', 'x']),
    );
    expect(analyzer.documentTokens('getId')).toContain('id');
    expect(analyzer.queryTokens('id')).toContain('id');
  });

  it('supports latin infix matching with 3-grams', () => {
    expect(latinParts('Popups')).toContain('opu');
    expect(latinRuns('模块:Foo.bar-test')).toEqual(['Foo.bar', 'test']);
  });

  it('creates Unicode-safe CJK bigrams', () => {
    expect(bigrams('鹿弹')).toEqual(['鹿弹']);
  });
});
