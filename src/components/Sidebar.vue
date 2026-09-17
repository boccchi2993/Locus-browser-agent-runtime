<template>
  <aside class="sidebar">
    <div class="sidebar-brand">
      <span class="brand-mark">L</span>
      <span class="brand-name">Locus</span>
      <span class="brand-ver">v0.4</span>
      <button
        class="icon-btn drawer-close"
        type="button"
        aria-label="Close navigation"
        @click="store.sidebarDrawerOpen = false"
      >×</button>
    </div>

    <button class="new-task-btn" type="button" @click="onNewTask">
      <span class="plus-glyph">+</span> New task
    </button>

    <div class="sidebar-search">
      <input
        v-model="store.sidebarSearch"
        type="text"
        placeholder="Search tasks"
        spellcheck="false"
      >
    </div>

    <div class="recents-label">Recents</div>
    <nav class="recents" aria-label="Recent tasks">
      <button
        v-for="conv in filteredRecents"
        :key="conv.id"
        class="recent-item"
        :class="{ active: conv.id === store.activeConversationId }"
        type="button"
        @click="onOpenConversation(conv.id)"
      >
        <span class="recent-title">{{ conv.title }}</span>
        <span class="recent-status" :data-status="conv.status">{{ statusLabel(conv.status) }}</span>
      </button>
      <div v-if="!filteredRecents.length" class="recents-empty">No tasks yet</div>
    </nav>
    <p class="recents-note">Tasks are stored locally in this browser profile; they are not synced to a cloud service.</p>

    <div class="sidebar-footer">
      <button class="footer-btn" type="button" @click="store.settingsOpen = true">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4">
          <circle cx="8" cy="8" r="2.2"/>
          <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"/>
        </svg>
        Settings
      </button>
      <div class="footer-status">
        <span class="dot" :class="store.workspaceName ? 'on' : 'off'"></span>
        {{ store.workspaceName ? store.workspaceName : 'No external folder mounted' }}
      </div>
    </div>
  </aside>
</template>

<script setup>
import { computed } from 'vue';
import { store, newTask, openConversation } from '../ui/store.js';

// Choosing a destination from the sidebar also closes the mobile drawer;
// on desktop the flag is meaningless (the sidebar is statically in flow).
function onNewTask() {
  newTask();
  store.sidebarDrawerOpen = false;
}

function onOpenConversation(id) {
  openConversation(id);
  store.sidebarDrawerOpen = false;
}

const filteredRecents = computed(() => {
  const q = store.sidebarSearch.trim().toLowerCase();
  // Untouched empty tasks add noise to history — only conversations that
  // actually ran are listed.
  const list = store.conversations.filter((c) => c.items.length > 0 || c.status !== 'idle');
  if (!q) return list;
  return list.filter((c) => c.title.toLowerCase().includes(q));
});

function statusLabel(status) {
  switch (status) {
    case 'running': return 'running';
    case 'completed': return 'done';
    case 'cancelled': return 'cancelled';
    case 'error':
    case 'iteration_limit': return 'error';
    case 'session_changed': return 'switched';
    case 'interrupted': return 'interrupted';
    default: return '';
  }
}
</script>
