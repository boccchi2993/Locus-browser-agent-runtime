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
      aria-label="Show context panel"
      @click="store.rightRailCollapsed = false"
    >‹</button>
    <SettingsPanel v-if="store.settingsOpen" />
    <TerminalPanel v-if="store.terminalOpen" />
  </div>
</template>

<script setup>
import { onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { store, cancelTask, closeDrawers, denyApproval } from './ui/store.js';
import Sidebar from './components/Sidebar.vue';
import MainWorkspace from './components/MainWorkspace.vue';
import ContextRail from './components/ContextRail.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import TerminalPanel from './components/TerminalPanel.vue';

const DRAWER_FOCUSABLE = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function activeDrawer() {
  if (store.sidebarDrawerOpen) return document.querySelector('.sidebar');
  if (store.contextDrawerOpen) return document.querySelector('.context-rail');
  return null;
}

function trapDrawerFocus(e) {
  const drawer = activeDrawer();
  if (!drawer) return;
  const focusable = Array.from(drawer.querySelectorAll(DRAWER_FOCUSABLE)).filter((el) => {
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  });
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (!drawer.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  }
}

// Keyboard priority: Tab is trapped inside the active modal drawer.
// Escape resolves the most specific surface first — a pending approval is
// DENIED (deny ≠ cancel task), then drawers close, then the composer "+"
// menu, then a running task is cancelled only when no presentation layer
// owns the key.
function onKeydown(e) {
  if (e.key === 'Tab' && (store.sidebarDrawerOpen || store.contextDrawerOpen)) {
    trapDrawerFocus(e);
    return;
  }
  if (e.key !== 'Escape') return;
  if (store.pendingApproval) {
    e.preventDefault();
    denyApproval();
  } else if (store.sidebarDrawerOpen || store.contextDrawerOpen) {
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
    // When one drawer closes because the other opens, do not bounce focus
    // back behind the newly opened overlay. Otherwise return focus to the
    // trigger that launched the drawer.
    if (!open && (store.sidebarDrawerOpen || store.contextDrawerOpen)) return;
    const target = document.querySelector(open ? drawerSel : triggerSel);
    if (target && typeof target.focus === 'function') target.focus();
  });
}
watchDrawer('sidebarDrawerOpen', '.sidebar .drawer-close', '.nav-toggle');
watchDrawer('contextDrawerOpen', '.context-rail .drawer-close', '.rail-toggle');

onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>
