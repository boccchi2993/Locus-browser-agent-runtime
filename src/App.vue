<template>
  <div
    class="app-shell"
    :class="{
      'sidebar-drawer-open': store.sidebarDrawerOpen,
      'context-drawer-open': store.contextDrawerOpen,
    }"
  >
    <Sidebar />
    <MainWorkspace />
    <ContextRail v-if="!store.rightRailCollapsed" />
    <div
      v-if="store.sidebarDrawerOpen || store.contextDrawerOpen"
      class="drawer-backdrop"
      @click="closeDrawers"
    ></div>
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
import { onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { store, cancelTask, closeDrawers } from './ui/store.js';
import Sidebar from './components/Sidebar.vue';
import MainWorkspace from './components/MainWorkspace.vue';
import ContextRail from './components/ContextRail.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import TerminalPanel from './components/TerminalPanel.vue';

// Escape priority: an open drawer eats the first Escape, then the composer
// "+" menu, and only with nothing presentation-level open does Escape keep
// its original meaning — cancel the running task.
function onKeydown(e) {
  if (e.key !== 'Escape') return;
  if (store.sidebarDrawerOpen || store.contextDrawerOpen) {
    e.preventDefault();
    closeDrawers();
  } else if (store.plusMenuOpen) {
    store.plusMenuOpen = false;
  } else if (store.busy) {
    e.preventDefault();
    cancelTask();
  }
}

// Drawer focus management: focus lands on the drawer's close button when it
// opens and returns to the top-bar trigger when it closes. Closed drawers
// are visibility:hidden, so their controls never stay in the tab order.
function watchDrawer(flag, drawerSel, triggerSel) {
  watch(() => store[flag], async (open) => {
    await nextTick();
    const target = document.querySelector(open ? drawerSel : triggerSel);
    if (target && typeof target.focus === 'function') target.focus();
  });
}
watchDrawer('sidebarDrawerOpen', '.sidebar .drawer-close', '.nav-toggle');
watchDrawer('contextDrawerOpen', '.context-rail .drawer-close', '.rail-toggle');

onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>
