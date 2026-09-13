<template>
  <div class="app-shell">
    <Sidebar />
    <MainWorkspace />
    <ContextRail v-if="!store.rightRailCollapsed" />
    <button
      v-if="store.rightRailCollapsed"
      class="rail-reopen"
      type="button"
      title="Show context panel"
      @click="store.rightRailCollapsed = false"
    >‹</button>
    <SettingsPanel v-if="store.settingsOpen" />
    <TerminalPanel v-if="store.terminalOpen" />
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount } from 'vue';
import { store, cancelTask } from './ui/store.js';
import Sidebar from './components/Sidebar.vue';
import MainWorkspace from './components/MainWorkspace.vue';
import ContextRail from './components/ContextRail.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import TerminalPanel from './components/TerminalPanel.vue';

// Escape cancels the running task — reachable even while the composer
// textarea has focus mid-task.
function onKeydown(e) {
  if (e.key === 'Escape' && store.busy) {
    e.preventDefault();
    cancelTask();
  } else if (e.key === 'Escape' && store.plusMenuOpen) {
    store.plusMenuOpen = false;
  }
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>
