<template>
  <main class="main-workspace">
    <header class="main-header">
      <div class="main-title">{{ conversation ? conversation.title : 'Locus' }}</div>
      <button
        class="rail-toggle"
        type="button"
        :title="store.rightRailCollapsed ? 'Show context panel' : 'Hide context panel'"
        @click="store.rightRailCollapsed = !store.rightRailCollapsed"
      >
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4">
          <rect x="1.5" y="2.5" width="13" height="11" rx="2"/>
          <path d="M10 2.5v11"/>
        </svg>
      </button>
    </header>

    <!-- Empty / new-task state: quiet, centered, Cowork-like -->
    <div v-if="isEmpty" class="empty-state">
      <div class="empty-inner">
        <div class="empty-brand">Locus</div>
        <p class="empty-tagline">Work with your local files.</p>
        <p v-if="!store.settings.apiKey" class="empty-hint">
          Set your model API key in
          <button class="linklike" type="button" @click="store.settingsOpen = true">Settings</button>
          to start a task.
        </p>
        <p v-else-if="!store.workspaceName" class="empty-hint">
          Use <span class="kbd-ish">+</span> below to mount a folder, or just ask something.
        </p>
        <Composer :centered="true" />
      </div>
    </div>

    <!-- Active conversation: structured timeline + bottom composer -->
    <template v-else>
      <div ref="scrollEl" class="timeline-scroll">
        <div class="timeline-column">
          <Timeline :conversation="conversation" />
        </div>
      </div>
      <div class="composer-dock">
        <div class="composer-column">
          <Composer />
        </div>
      </div>
    </template>
  </main>
</template>

<script setup>
import { computed, ref, watch, nextTick } from 'vue';
import { store, activeConversation } from '../ui/store.js';
import Timeline from './Timeline.vue';
import Composer from './Composer.vue';

const conversation = activeConversation;
const isEmpty = computed(() => !conversation.value || conversation.value.items.length === 0);

const scrollEl = ref(null);
watch(
  () => conversation.value && conversation.value.items.length,
  async () => {
    await nextTick();
    const el = scrollEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  }
);
</script>
