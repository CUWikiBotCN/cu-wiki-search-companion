<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { computed } from 'vue';
import HighlightedText from './HighlightedText.vue';
import type { SearchPanel } from './search-panel';
import { SEARCH_MODES, canInsertResult, type SearchMode, type SearchPanelResult } from './search-panel-model';
import type { HighlightPreferences } from '../storage/highlight-preference';
import type { DataCodeSearchResult } from '../search/data-code-index';
import type { CssSearchResult } from '../search/css-source-index';
import type { TitleSearchResult } from '../search/title-index';
import type { ContentSearchResult } from '../search/content-index';
import type { LuaModuleSearchResult, LuaSymbolKind } from '../search/lua-module-index';
const props = defineProps<{
  results: SearchPanelResult[];
  query: string;
  mode: SearchMode;
  selectedIndex: number;
  insertMode: boolean;
  highlights: HighlightPreferences;
  actions: SearchPanel['actions'];
}>();
const message = computed(() => SEARCH_MODES[props.mode][props.query.trim() ? 'noResults' : 'empty']);
const luaLabels: Record<LuaSymbolKind, string> = { function: '函数', 'return-key': '返回键', dependency: '依赖', string: '字符串' };
function isCode(result: SearchPanelResult): result is DataCodeSearchResult {
  return 'kind' in result && result.kind === 'data-code';
}
function isContent(result: SearchPanelResult): result is ContentSearchResult {
  return 'kind' in result && result.kind === 'content';
}
function isCss(result: SearchPanelResult): result is CssSearchResult {
  return 'kind' in result && result.kind === 'css';
}
function isLua(result: SearchPanelResult): result is LuaModuleSearchResult {
  return 'kind' in result && result.kind === 'lua';
}
function redirect(result: SearchPanelResult): TitleSearchResult | undefined {
  return props.mode === 'title' && !('kind' in result) && result.isRedirect ? result : undefined;
}
const rows = computed(() => props.results.map((result, index) => ({ result, index, redirectInfo: redirect(result) })));
function label(result: SearchPanelResult): string {
  return isCode(result) ? `复制代码名：${result.code}（Enter）`
    : isLua(result) ? `复制模块标题：${result.title}（Enter）` : `复制页面标题：${result.title}（Enter）`;
}
</script>

<template>
  <ul class="results">
    <li v-if="!query.trim() || !results.length" class="message">{{ message }}</li>
    <template v-else>
      <li v-for="{ result, index, redirectInfo } in rows" :key="isCode(result) ? JSON.stringify([result.source, result.code]) : `${mode}:${result.id}`"
        class="result" :data-selected="String(index === selectedIndex)" @mouseenter="actions.select(index)" @focusin="actions.select(index)">
        <div class="result-body">
        <button class="insert result-primary" type="button" :data-index="index" :title="label(result)" :aria-label="label(result)" @click="actions.copy(result)">
          <span class="result-title"><template v-if="isCode(result)">{{ result.chineseName }}</template><HighlightedText v-else-if="isContent(result)" :text="result.title" :highlights="highlights.titleEnabled ? result.titleHighlights : undefined" /><template v-else>{{ result.title }}</template></span>
          <span v-if="!redirectInfo" class="result-namespace"><template v-if="isCode(result)">{{ result.code }} · {{ result.dataType }}</template><template v-else-if="isCss(result)">{{ result.namespaceName }}</template><template v-else-if="isLua(result)">{{ result.matches.map(match => `${luaLabels[match.kind]} · ${match.value}`).join(' · ') }}</template><template v-else>{{ result.namespaceName || '主命名空间' }}<template v-if="isContent(result)"> · <HighlightedText :text="result.snippet" :highlights="highlights.contentEnabled ? result.highlights : undefined" /></template></template></span>
        </button>
        <div v-if="isCss(result)" class="css-matches">
          <div v-for="(match, hitIndex) in result.matches" :key="hitIndex" class="css-match">
            <span class="css-line">第 {{ match.line }} 行</span>
            <code><HighlightedText :text="match.text" :highlights="match.highlights" /></code>
          </div>
        </div>
        <span v-if="redirectInfo" class="result-namespace redirect-description">
          {{ !isCode(result) ? result.namespaceName || '主命名空间' : '' }} ·
          <template v-if="redirectInfo?.redirectTarget">
            重定向到：<a class="redirect-target" :href="actions.redirectUrl(redirectInfo.redirectTarget!)" target="_blank" rel="noopener noreferrer"
              :title="redirectInfo.redirectTarget!.title + (redirectInfo.redirectTarget!.fragment ? '#' + redirectInfo.redirectTarget!.fragment : '')"
              @click.stop>{{ redirectInfo.redirectTarget!.title }}<template v-if="redirectInfo.redirectTarget!.fragment">#{{ redirectInfo.redirectTarget!.fragment }}</template></a>
          </template>
          <template v-else>重定向 · {{ redirectInfo?.redirectResolved ? '未取得目标' : '目标待同步' }}</template>
        </span>
        </div>
        <span class="actions">
          <button class="action open-result" type="button" :title="isCode(result) ? '在新标签页打开 Data 来源' : isCss(result) ? '在新标签页打开 CSS 来源' : isLua(result) ? '在新标签页打开模块' : '在新标签页打开'" @click.stop="actions.open(result)">{{ isCode(result) || isCss(result) ? '打开来源' : '打开' }}</button>
          <template v-if="canInsertResult(result)">
            <button class="action copy-result" type="button" title="复制包含 [[ ]] 的维基链接" @click.stop="actions.copyLink(result)">复制插入内容</button>
            <button v-if="insertMode" class="action insert-result" type="button" title="插入维基链接并返回编辑器" @click.stop="actions.insert(result)">插入</button>
          </template>
        </span>
      </li>
    </template>
  </ul>
</template>
