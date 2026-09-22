<template>
  <div class="composer-wrap" :class="{ centered }">
    <!-- pending uploads: real File objects already in the VFS at
         /mnt/upload (read-only to the agent); the title shows the real
         final VFS path -->
    <div v-if="store.attachments.length" class="attach-row">
      <span v-for="(a, i) in store.attachments" :key="i" class="attach-chip" :title="a.path">
        <span v-if="a.image" class="attach-kind">Image</span>
        <span class="attach-name">{{ a.name }}</span>
        <button type="button" class="attach-x" :aria-label="'Remove ' + a.name" @click="removeAttachment(i)">×</button>
      </span>
    </div>

    <div class="composer" :class="{ busy: store.busy }">
      <textarea
        ref="ta"
        v-model="draft"
        class="composer-input"
        :placeholder="placeholder"
        rows="1"
        @keydown="onKeydown"
        @input="autogrow"
      ></textarea>

      <div class="composer-bar">
        <div class="composer-left">
          <button class="icon-btn plus-btn" type="button" title="Add context" aria-label="Add context" @click.stop="togglePlusMenu">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M8 3v10M3 8h10"/>
            </svg>
          </button>

          <button class="ws-chip" type="button" :title="store.workspaceName ? 'Change folder' : 'Mount folder'" @click="mountFolder">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3">
              <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 2h6.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7.5Z"/>
            </svg>
            {{ store.workspaceName || 'Mount folder' }}
          </button>
        </div>

        <div class="composer-right">
          <span class="model-label" :title="'Model — change in Settings'">{{ store.settings.model }}</span>
          <button
            v-if="store.busy"
            class="send-btn cancel-btn"
            type="button"
            :disabled="store.cancelling"
            @click="cancelTask"
          >{{ store.cancelling ? 'Cancelling…' : 'Cancel' }}</button>
          <button
            v-else
            class="send-btn"
            type="button"
            :disabled="!draft.trim() || store.pendingApproval"
            title="Send (Enter)"
            aria-label="Send"
            @click="send"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M8 12.5v-9M3.5 8 8 3.5 12.5 8"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- "+" context menu -->
      <div v-if="store.plusMenuOpen" class="plus-backdrop" @click="store.plusMenuOpen = false"></div>
      <div v-if="store.plusMenuOpen" class="plus-menu" @click.stop>
        <div class="plus-menu-title">Add context</div>
        <button class="plus-item" type="button" @click="uploadFiles">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4">
            <path d="M8 10.5v-7M5 6l3-3 3 3M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/>
          </svg>
          <span>Upload files</span>
        </button>
        <button class="plus-item" type="button" @click="mountFolder">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3">
            <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 2h6.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7.5Z"/>
          </svg>
          <span>Mount folder</span>
        </button>
        <button class="plus-item" type="button" @click="openTerminal">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4">
            <path d="M3 4.5 7 8l-4 3.5M8.5 11.5H13"/>
          </svg>
          <span>Open terminal</span>
          <em class="plus-note">reserved</em>
        </button>
      </div>
    </div>
    <div class="composer-caption">Files and Python run locally in your browser. Model requests and explicit network calls may leave this machine.</div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import {
  store, submit, cancelTask, togglePlusMenu,
  uploadFiles, removeAttachment, mountFolder, openTerminal,
} from '../ui/store.js';

defineProps({ centered: { type: Boolean, default: false } });

const draft = ref('');
const ta = ref(null);

const placeholder = computed(() => {
  if (store.pendingApproval) return 'Waiting for approval…';
  return store.busy ? 'Working… (Esc to cancel)' : 'Describe a task for your workspace…';
});

function send() {
  const text = draft.value;
  // A pending approval suspends the running task — it must never be
  // bypassed (or double-tracked) by submitting over it.
  if (!text.trim() || store.busy || store.pendingApproval) return;
  draft.value = '';
  autogrow();
  submit(text);
}

function onKeydown(e) {
  // Enter submits, Shift+Enter inserts a newline.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

function autogrow() {
  const el = ta.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 180) + 'px';
}
</script>