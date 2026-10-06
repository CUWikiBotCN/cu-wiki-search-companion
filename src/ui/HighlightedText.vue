<!-- SPDX-License-Identifier: MPL-2.0 -->
<script setup lang="ts">
import { computed } from 'vue';
import type { SearchTextHighlight } from '../search/content-index';
const props = defineProps<{
  text: string;
  highlights?: readonly SearchTextHighlight[];
}>();
const parts = computed(() => {
  const ranges = (props.highlights ?? [])
    .map((range) => ({
      start: Math.max(0, Math.min(range.start, props.text.length)),
      end: Math.min(range.end, props.text.length),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start);
  const result: { text: string; marked: boolean }[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor)
      result.push({
        text: props.text.slice(cursor, range.start),
        marked: false,
      });
    result.push({
      text: props.text.slice(range.start, range.end),
      marked: true,
    });
    cursor = range.end;
  }
  if (cursor < props.text.length)
    result.push({ text: props.text.slice(cursor), marked: false });
  return result;
});
</script>

<template>
  <template v-for="(part, index) in parts" :key="index"
    ><mark v-if="part.marked">{{ part.text }}</mark
    ><template v-else>{{ part.text }}</template></template
  >
</template>
