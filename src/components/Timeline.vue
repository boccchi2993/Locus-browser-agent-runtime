<template>
  <div class="timeline">
    <template v-for="item in conversation.items" :key="item.id">
      <!-- user message: quiet warm bubble, right of the content column.
           Image attachments render as a count chip only — pixels never
           enter the presentation timeline. -->
      <div v-if="item.kind === 'user'" class="item item-user">
        <div class="user-bubble">
          <span v-if="item.imageCount" class="user-image-chip" title="Image attachment sent with this message">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <rect x="2" y="3" width="12" height="10" rx="1.5"/>
              <path d="m2 11 3.5-3.5 2.5 2.5L11 7l3 3"/>
              <circle cx="6" cy="6.2" r="1"/>
            </svg>
            {{ item.imageCount }} {{ item.imageCount === 1 ? 'image' : 'images' }}
          </span>
          <span class="user-text">{{ item.content }}</span>
        </div>
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
