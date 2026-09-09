<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { computed } from 'vue';
import type { SearchPanel } from './search-panel';
import PanelResults from './PanelResults.vue';
import PanelMaintenance from './PanelMaintenance.vue';
const MIRROR_REFRESH_HELP =
  '重新同步本地数据（需要联网）：执行全量页面对账，刷新 Data 代码缓存，并修复或续传正文与 Lua 队列；不会清空本地镜像，也不会修改 wiki 页面。';
const FILE_REFRESH_HELP =
  '重新同步文件资源（需要联网）：重新枚举文件命名空间并更新本地文件缓存与索引；不会影响普通页面、正文、Data 代码或 Lua，也不会修改 wiki 页面。';

const props = defineProps<{ state: SearchPanel['state']; actions: SearchPanel['actions'] }>();
const presentations: Record<string, { heading: string; label: string; placeholder: string }> = {
  title: { heading: '搜索页面标题', label: '搜索页面标题', placeholder: '标题、片段或英文中缀' },
  content: { heading: '搜索页面正文', label: '搜索页面正文', placeholder: '输入正文关键词' },
  'data-code': { heading: '查找 Data 代码名', label: '搜索 Data 代码', placeholder: '中文名、英文代码片段或已配置字段值' },
  files: { heading: '查找文件资源', label: '搜索文件资源', placeholder: '文件名、片段或扩展名' },
  lua: { heading: '查找 Lua 模块', label: '搜索 Lua 模块', placeholder: '函数名、返回键、字符串或 require 目标' },
};
const presentation = computed(() => presentations[props.state.mode] ?? presentations.title!);
const refreshHelp = computed(() => props.state.mode === 'files' ? FILE_REFRESH_HELP : MIRROR_REFRESH_HELP);
</script>

<template>
  <button class="toggle" type="button" :aria-expanded="state.visible" @click="actions.toggle">本地搜索</button>
  <section class="panel" role="dialog" :hidden="!state.visible" @keydown="actions.keydown" @compositionstart="actions.compositionStart" @compositionend="actions.compositionEnd" aria-label="未知伤亡维基本地搜索">
    <header class="header">
      <span class="heading drag-handle" role="button" tabindex="0" title="拖动搜索面板；方向键移动，Shift 加方向键微调" @keydown="actions.dragKeydown" @pointerdown="actions.dragStart" @pointermove="actions.dragMove" @pointerup="actions.dragEnd" @pointercancel="actions.dragEnd">{{ presentation.heading }}</span>
      <button class="icon reload-startup" type="button" title="重新加载页面" :hidden="!state.reload" @click="state.reload?.()">重新加载</button>
      <button class="icon configure" type="button" title="配置 Data 代码检索字段" :hidden="state.mode !== 'data-code'" @click="actions.configure">⚙</button>
      <button class="icon maintenance-toggle" type="button" title="本地数据与维护" :aria-expanded="state.maintenanceOpen" @click="actions.maintenance">▤</button>
      <button class="icon refresh" type="button" :title="refreshHelp" :aria-label="refreshHelp" @click="actions.refresh">↻</button>
      <button class="icon reset-position" type="button" title="恢复默认位置" @click="actions.resetPosition">恢复默认位置</button>
      <button class="icon close" type="button" title="关闭" @click="actions.close">✕</button>
    </header>
    <div class="controls">
      <input class="query" type="search" autocomplete="off" :placeholder="presentation.placeholder" :aria-label="presentation.label" v-model="state.query" @input="actions.input" aria-describedby="cu-keyboard-hint">
      <select class="mode" v-model="state.mode" @change="actions.mode" aria-label="搜索类型">
        <option value="title">页面标题</option>
        <option value="content">页面正文</option>
        <option value="data-code">Data 代码</option>
        <option value="lua">Lua 模块</option>
        <option value="files">文件资源</option>
      </select>
      <select class="namespace" v-model="state.namespace" :hidden="!['title', 'content'].includes(state.mode)" @change="actions.search" aria-label="筛选命名空间"><option value="">全部命名空间</option><option v-for="namespace in state.namespaces" :key="namespace.id" :value="String(namespace.id)">{{ namespace.name || '（主）' }}</option></select>
    </div>
    <div class="panel-body">
    <section class="highlight-settings" :hidden="state.mode !== 'content'" aria-label="命中高亮设置">
      <label class="highlight-option"><input class="title-highlight-toggle" type="checkbox" v-model="state.highlights.titleEnabled" @change="actions.highlights">标题命中高亮</label>
      <input class="highlight-color title-highlight-color" type="color" v-model="state.highlights.titleColor" @input="actions.colors" @change="actions.highlights" aria-label="标题高亮颜色" title="标题命中高亮颜色">
      <label class="highlight-option"><input class="content-highlight-toggle" type="checkbox" v-model="state.highlights.contentEnabled" @change="actions.highlights">正文命中高亮</label>
      <input class="highlight-color content-highlight-color" type="color" v-model="state.highlights.contentColor" @input="actions.colors" @change="actions.highlights" aria-label="正文高亮颜色" title="正文命中高亮颜色">
      <span class="settings-help">命中的字词按上述颜色标注；仅作用于“页面正文”模式。</span>
    </section>
    <section class="settings" :hidden="!state.settingsOpen">
      <label class="settings-label" for="cu-data-rules">Data 代码检索字段</label>
      <textarea class="data-rules" v-model="state.dataRules" id="cu-data-rules" spellcheck="false" aria-label="Data 代码检索字段"></textarea>
      <span class="settings-help">每行“类型 = 路径”；所选路径的标量值用于查找顶层 id 代码名，英文 id 本身始终可搜索。支持 []、*、**；保存后刷新 Data 代码缓存，不影响页面正文。</span>
      <div class="settings-actions">
        <button class="settings-action reset-rules" type="button" @click="actions.resetRules">恢复默认</button>
        <button class="settings-action save-rules" type="button" @click="actions.saveRules">保存并刷新</button>
      </div>
    </section>
    <PanelMaintenance :state="state" :actions="actions" />
    <PanelResults :results="state.results" :query="state.query" :mode="state.mode" :selected-index="state.selectedIndex" :insert-mode="state.insertMode" :highlights="state.highlights" :actions="actions" />
    <pre class="status-details" id="cu-status-details" tabindex="0" :hidden="!state.detailsOpen" :data-tone="state.tone">{{ state.status }}</pre>
    </div>
    <footer class="footer">
      <span class="status" role="status" :data-tone="state.tone">{{ state.status }}</span>
      <button class="status-details-toggle" type="button" :aria-expanded="state.detailsOpen" aria-controls="cu-status-details" :hidden="!state.statusClipped" @click="actions.details">{{ state.detailsOpen ? '收起完整状态' : '查看完整状态' }}</button>
      <span class="keyboard-hint" id="cu-keyboard-hint">
        <span><kbd>Alt+K</kbd> 开关</span><span><kbd>Enter</kbd> 复制</span>
        <span><kbd>Ctrl/Cmd+Enter</kbd> 打开</span><span><kbd>Shift+Enter</kbd> 插入</span>
        <span><kbd>Tab</kbd> 切换焦点</span><span><kbd>Esc</kbd> 关闭</span>
      </span>
    </footer>
  </section>
</template>
