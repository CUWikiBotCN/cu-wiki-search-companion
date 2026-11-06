// SPDX-License-Identifier: MPL-2.0
import { cut, cut_for_search } from 'jieba-wasm/node';

import {
  Analyzer,
  createBootstrapSegmenter,
} from '../../src/analyzer/analyzer';
import { ContentIndex } from '../../src/search/content-index';
import { LuaModuleIndex } from '../../src/search/lua-module-index';
import { TitleIndex } from '../../src/search/title-index';
import type { PageRecord } from '../../src/types';

describe.each(['jieba', 'bootstrap'] as const)('%s query tokens', (engine) => {
  it.each(['title', 'content', 'lua'] as const)(
    'tokenizes each %s query once, including OR fallback and successive queries',
    (kind) => {
      const analyzer = new Analyzer(
        engine === 'jieba'
          ? { cut, cutForSearch: cut_for_search }
          : createBootstrapSegmenter(),
        engine,
      );
      const pages: PageRecord[] = ['alpha beta', 'gamma delta'].map(
        (text, offset) => ({
          id: offset + 1,
          title: text,
          normalizedTitle: text,
          namespace: 0,
          namespaceName: '',
          localSeq: 1,
          isRedirect: false,
          contentModel: kind === 'lua' ? 'Scribunto' : 'wikitext',
          content: kind === 'lua' ? `return { label = '${text}' }` : text,
        }),
      );
      const Index = {
        title: TitleIndex,
        content: ContentIndex,
        lua: LuaModuleIndex,
      }[kind];
      const index = new Index(analyzer);
      index.rebuild(pages);
      const tokenize = vi.spyOn(analyzer, 'queryTokens');

      for (const [query, expected] of [
        ['alpha', [1]],
        ['alpha beta', [1]],
        ['alpha absentneedle', [1]],
        ['gamma delta', [2]],
        ['ＡＬＰＨＡ beta', [1]],
      ] as const) {
        tokenize.mockClear();
        expect(index.search(query).map(({ id }) => id)).toEqual(expected);
        expect(tokenize).toHaveBeenCalledExactlyOnceWith(
          analyzer.normalize(query),
        );
      }
      tokenize.mockClear();
      expect(index.search(' \t\n ')).toEqual([]);
      expect(tokenize).not.toHaveBeenCalled();
      expect(index.search('!')).toEqual([]);
      expect(tokenize).toHaveBeenCalledExactlyOnceWith('!');
    },
  );
});
