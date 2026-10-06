<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import type { SearchPanel } from './search-panel';
defineProps<{ state: SearchPanel['state']; actions: SearchPanel['actions'] }>();
</script>

<template>
  <section
    class="maintenance"
    :hidden="!state.maintenanceOpen"
    aria-label="本地数据与维护"
  >
    <h2 class="maintenance-title">本地数据与维护</h2>
    <pre class="maintenance-output">{{ state.maintenanceOutput }}</pre>
    <div class="maintenance-actions">
      <button
        :disabled="state.maintenanceBusy"
        class="maintenance-action rebuild-indexes"
        type="button"
        @click="actions.rebuildIndexes"
        >重建搜索索引</button
      >
      <button
        :disabled="state.maintenanceBusy"
        class="maintenance-action rebuild-content-queue"
        type="button"
        @click="actions.rebuildQueue"
        >重建正文队列</button
      >
      <button
        :disabled="state.maintenanceBusy"
        class="maintenance-action reconcile-now"
        type="button"
        @click="actions.reconcile"
        >立即全量对账 <span class="network-note">（需要联网）</span></button
      >
      <button
        :disabled="state.maintenanceBusy"
        class="maintenance-action clear-snapshots"
        type="button"
        @click="actions.clearSnapshots"
        >清除索引快照</button
      >
      <button
        :disabled="state.maintenanceBusy"
        class="maintenance-action request-persistence"
        type="button"
        @click="actions.persistence"
        >申请持久保存</button
      >
    </div>
    <div class="danger-zone">
      <button
        :disabled="state.maintenanceBusy"
        class="maintenance-action danger reveal-danger"
        @click="state.dangerOpen = true"
        type="button"
        >高级危险操作</button
      >
      <div class="danger-confirmation" :hidden="!state.dangerOpen">
        <span class="danger-copy"
          >清空页面、正文、文件、Data 缓存、队列、同步游标和快照；不会修改 wiki
          页面。下次搜索需要重新联网同步。</span
        >
        <label class="reset-rules-option"
          ><input
            class="reset-data-rules"
            v-model="state.resetDataRules"
            type="checkbox"
          />
          同时恢复默认 Data 字段规则</label
        >
        <button
          :disabled="state.maintenanceBusy"
          class="maintenance-action danger reset-local"
          type="button"
          @click="actions.resetLocal"
          >确认清空本地镜像</button
        >
      </div>
    </div>
  </section>
</template>
