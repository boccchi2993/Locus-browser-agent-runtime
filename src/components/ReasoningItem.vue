<template>
  <div class="item item-reasoning">
    <button class="disclosure" type="button" @click="open = !open">
      <span class="chev" :class="{ open }">›</span>
      {{ title }}
    </button>
    <!-- Content is stored complete by the projector; only display is
         collapsible. Nothing here is ever truncated by the runtime. -->
    <div v-if="open" class="reasoning-body">{{ item.content }}</div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

const props = defineProps({ item: { type: Object, required: true } });
// Long reasoning starts collapsed; short notes can stay visible.
const open = ref((props.item.content || '').length <= 240);
const title = computed(() =>
  props.item.presentation === 'summary' ? 'Reasoning summary' : 'Reasoning');
</script>
