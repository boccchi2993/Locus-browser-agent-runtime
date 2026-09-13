<template>
  <div class="tool-result" :class="{ standalone, failed: result && !result.success }">
    <div class="result-meta">
      <span v-if="result" class="result-mark" :class="result.success ? 'ok' : 'fail'">
        {{ result.success ? '✓' : '✗' }}
      </span>
      <!-- Backend badge comes ONLY from runtime event metadata. -->
      <span v-if="result && result.backend" class="backend-badge" :data-backend="result.backend">
        {{ result.backend }}
      </span>
      <span v-if="result && result.operation" class="result-op">{{ result.operation }}</span>
      <button
        v-if="isLong"
        class="linklike result-toggle"
        type="button"
        @click="open = !open"
      >{{ open ? 'collapse' : 'expand' }}</button>
    </div>
    <pre v-if="result && (open || !isLong)" class="tool-io result-output">{{ result.output }}</pre>
    <div v-else-if="result" class="result-preview">{{ preview }}</div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  item: { type: Object, required: true },
  standalone: { type: Boolean, default: false },
});

const result = computed(() => props.item.result);
const output = computed(() => (result.value && result.value.output) || '');
const isLong = computed(() => output.value.length > 600 || output.value.split('\n').length > 8);
const open = ref(false);
const preview = computed(() => {
  const lines = output.value.split('\n').slice(0, 3).join('\n');
  return lines.slice(0, 240) + (output.value.length > 240 ? ' …' : '');
});
</script>
