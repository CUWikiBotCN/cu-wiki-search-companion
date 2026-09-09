<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { computed } from 'vue';
import HighlightedText from './HighlightedText.vue';
import type { SearchPanel, SearchPanelResult } from './search-panel';
import type { HighlightPreferences } from '../storage/highlight-preference';
import type { DataCodeSearchResult } from '../search/data-code-index';
import type { ContentSearchResult } from '../search/content-index';
import type { LuaModuleSearchResult, LuaSymbolKind } from '../search/lua-module-index';
const props = defineProps<{
  results: SearchPanelResult[];
  query: string;
  mode: string;
  selectedIndex: number;
  insertMode: boolean;
  highlights: HighlightPreferences;
  actions: SearchPanel['actions'];
}>();
const messages: Record<string, [string, string]> = {
  title: ['输入标题关键词开始搜索', '没有找到匹配标题'],
  content: ['输入正文关键词开始搜索', '没有找到匹配正文'],
  files: ['输入文件名、片段或扩展名开始搜索', '没有找到匹配文件'],
  lua: ['输入函数名、返回键、字符串或依赖目标', '没有找到匹配 Lua 模块'],
  'data-code': ['输入中文名、英文代码片段或已配置字段值查找代码', '没有找到对应代码名'],
};
const message = computed(() => (messages[props.mode] ?? messages.title!)[props.query.trim() ? 1 : 0]);
const luaLabels: Record<LuaSymbolKind, string> = { function: '函数', 'return-key': '返回键', dependency: '依赖', string: '字符串' };
function isCode(result: SearchPanelResult): result is DataCodeSearchResult {
  return 'kind' in result && result.kind === 'data-code';
}
function isContent(result: SearchPanelResult): result is ContentSearchResult {
  return 'kind' in result && result.kind === 'content';
}
function isLua(result: SearchPanelResult): result is LuaModuleSearchResult {
  return 'kind' in result && result.kind === 'lua';
}
function label(result: SearchPanelResult): string {
  return isCode(result) ? `复制代码名：${result.code}（Enter）`
    : isLua(result) ? `复制模块标题：${result.title}（Enter）` : `复制页面标题：${result.title}（Enter）`;
}
</script>

<template>
  <ul class="results">
    <li v-if="!query.trim() || !results.length" class="message">{{ message }}</li>
    <template v-else>
      <li v-for="(result, index) in results" :key="isCode(result) ? JSON.stringify([result.source, result.code]) : `${mode}:${result.id}`"
        class="result" :data-selected="String(index === selectedIndex)" @mouseenter="actions.select(index)" @focusin="actions.select(index)">
        <button class="insert result-primary" type="button" :data-index="index" :title="label(result)" :aria-label="label(result)" @click="actions.copy(result)">
          <span class="result-title"><template v-if="isCode(result)">{{ result.chineseName }}</template><HighlightedText v-else-if="isContent(result)" :text="result.title" :highlights="highlights.titleEnabled ? result.titleHighlights : undefined" /><template v-else>{{ result.title }}</template></span>
          <span class="result-namespace"><template v-if="isCode(result)">{{ result.code }} · {{ result.dataType }}</template><template v-else-if="isLua(result)">{{ result.matches.map(match => `${luaLabels[match.kind]} · ${match.value}`).join(' · ') }}</template><template v-else>{{ result.namespaceName || '主命名空间' }}<template v-if="isContent(result)"> · <HighlightedText :text="result.snippet" :highlights="highlights.contentEnabled ? result.highlights : undefined" /></template></template></span>
        </button>
        <span class="actions">
          <button class="action open-result" type="button" :title="isCode(result) ? '在新标签页打开 Data 来源' : isLua(result) ? '在新标签页打开模块' : '在新标签页打开'" @click.stop="actions.open(result)">{{ isCode(result) ? '打开来源' : '打开' }}</button>
          <template v-if="!isCode(result) && !isLua(result)">
            <button class="action copy-result" type="button" title="复制包含 [[ ]] 的维基链接" @click.stop="actions.copyLink(result)">复制插入内容</button>
            <button v-if="insertMode" class="action insert-result" type="button" title="插入维基链接并返回编辑器" @click.stop="actions.insert(result)">插入</button>
          </template>
        </span>
      </li>
    </template>
  </ul>
</template>
