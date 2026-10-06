// SPDX-License-Identifier: MPL-2.0
import type { ContentSearchResult } from '../search/content-index';
import type { CssSearchResult } from '../search/css-source-index';
import type { DataCodeSearchResult } from '../search/data-code-index';
import type { LuaModuleSearchResult } from '../search/lua-module-index';
import type { TitleSearchResult } from '../search/title-index';

export type SearchMode =
  'title' | 'content' | 'data-code' | 'lua' | 'css' | 'files';
export type SearchPreparationKind = Extract<
  SearchMode,
  'title' | 'content' | 'lua' | 'css'
>;

interface SearchModePresentation {
  option: string;
  heading: string;
  label: string;
  placeholder: string;
  empty: string;
  noResults: string;
  namespace: boolean;
}

export const SEARCH_MODES = {
  title: {
    option: '页面标题',
    heading: '搜索页面标题',
    label: '搜索页面标题',
    placeholder: '标题、片段或英文中缀',
    empty: '输入标题关键词开始搜索',
    noResults: '没有找到匹配标题',
    namespace: true,
  },
  content: {
    option: '页面正文',
    heading: '搜索页面正文',
    label: '搜索页面正文',
    placeholder: '输入正文关键词',
    empty: '输入正文关键词开始搜索',
    noResults: '没有找到匹配正文',
    namespace: true,
  },
  'data-code': {
    option: 'Data 代码',
    heading: '查找 Data 代码名',
    label: '搜索 Data 代码',
    placeholder: '中文名、英文代码片段或已配置字段值',
    empty: '输入中文名、英文代码片段或已配置字段值查找代码',
    noResults: '没有找到对应代码名',
    namespace: false,
  },
  lua: {
    option: 'Lua 模块',
    heading: '查找 Lua 模块',
    label: '搜索 Lua 模块',
    placeholder: '函数名、返回键、字符串或 require 目标',
    empty: '输入函数名、返回键、字符串或依赖目标',
    noResults: '没有找到匹配 Lua 模块',
    namespace: false,
  },
  css: {
    option: 'CSS 样式',
    heading: '查找 CSS 样式',
    label: '搜索 CSS 源码',
    placeholder: 'class、选择器或源码片段（区分大小写）',
    empty: '输入 class、选择器或源码片段',
    noResults: '没有找到匹配 CSS 源码',
    namespace: false,
  },
  files: {
    option: '文件资源',
    heading: '查找文件资源',
    label: '搜索文件资源',
    placeholder: '文件名、片段或扩展名',
    empty: '输入文件名、片段或扩展名开始搜索',
    noResults: '没有找到匹配文件',
    namespace: false,
  },
} satisfies Record<SearchMode, SearchModePresentation>;

export type WikiPageSearchResult =
  | TitleSearchResult
  | ContentSearchResult
  | LuaModuleSearchResult
  | CssSearchResult;
export type SearchPanelResult = WikiPageSearchResult | DataCodeSearchResult;

/** Both Wiki-link copying and insertion are limited to title/file/content results. */
export function canInsertResult(
  result: SearchPanelResult,
): result is TitleSearchResult | ContentSearchResult {
  return !('kind' in result) || result.kind === 'content';
}

export function isDataCodeResult(
  result: SearchPanelResult,
): result is DataCodeSearchResult {
  return 'kind' in result && result.kind === 'data-code';
}
