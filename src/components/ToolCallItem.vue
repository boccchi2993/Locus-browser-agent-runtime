<template>
  <div class="item item-tool" :data-state="item.state">
    <button class="disclosure tool-head" type="button" @click="open = !open">
      <span class="chev" :class="{ open }">›</span>
      <span class="tool-icon">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4">
          <path d="M3 4.5 7 8l-4 3.5M8.5 11.5H13"/>
        </svg>
      </span>
      <span class="tool-name">{{ item.tool }}</span>
      <span v-if="item.state === 'running'" class="tool-state">running…</span>
      <span v-else-if="item.state === 'failed'" class="tool-state failed">failed</span>
    </button>
    <div v-if="open" class="tool-body">
      <div class="tool-section-label">Input</div>
      <pre class="tool-io">{{ item.input }}</pre>
      <ToolResultItem v-if="item.result" :item="item" />
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import ToolResultItem from './ToolResultItem.vue';

const props = defineProps({ item: { type: Object, required: true } });
// Long inputs start collapsed — Cowork-style: execution visible but quiet.
const open = ref((props.item.input || '').length <= 160);
</script>
