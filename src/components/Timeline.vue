<template>
  <div class="timeline">
    <template v-for="item in conversation.items" :key="item.id">
      <!-- user message: quiet warm bubble, right of the content column -->
      <div v-if="item.kind === 'user'" class="item item-user">
        <div class="user-bubble">{{ item.content }}</div>
      </div>

      <ReasoningItem v-else-if="item.kind === 'reasoning'" :item="item" />
      <ToolCallItem v-else-if="item.kind === 'tool'" :item="item" />
      <ToolResultItem v-else-if="item.kind === 'tool_result'" :item="item" :standalone="true" />

      <!-- assistant final text: blends into the page, no card.
           markdown-lite rendering; input is fully escaped before
           inline formatting, so model output cannot inject markup. -->
      <div v-else-if="item.kind === 'assistant'" class="item item-assistant">
        <div class="assistant-text" v-html="renderMd(item.content)"></div>
      </div>

      <div v-else-if="item.kind === 'warning'" class="item item-warning">
        <span class="state-glyph">!</span>{{ item.message }}
      </div>
      <div v-else-if="item.kind === 'error'" class="item item-error">
        <span class="state-glyph">×</span>{{ item.message }}
      </div>
    </template>

    <div v-if="conversation.status === 'running'" class="item item-working">
      <span class="working-dot"></span>Working…
    </div>
  </div>
</template>

<script setup>
import ReasoningItem from './ReasoningItem.vue';
import ToolCallItem from './ToolCallItem.vue';
import ToolResultItem from './ToolResultItem.vue';

/* global LocusMarkdown */

defineProps({ conversation: { type: Object, required: true } });

const renderMd = (text) => LocusMarkdown.render(text);
</script>
