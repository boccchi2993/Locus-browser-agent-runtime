<template>
  <div
    v-if="pending"
    ref="cardEl"
    class="approval-card"
    tabindex="-1"
    role="group"
    :aria-label="'Approval required: ' + (pending.action.summary || '')"
    data-testid="approval-card"
  >
    <div class="approval-title">Approval required</div>
    <p class="approval-lead">Locus wants permission to:</p>
    <!-- All request content is plain text ({{ }} interpolation escapes it);
         buttons/labels come from the fixed per-kind set below, never from
         the request payload. -->
    <div class="approval-summary">{{ pending.action.summary }}</div>
    <div v-if="pending.action.detail" class="approval-detail">{{ pending.action.detail }}</div>
    <div v-if="resourceLine" class="approval-resource">{{ resourceLine }}</div>
    <div v-if="fromTitle" class="approval-context">Request from running task: {{ fromTitle }}</div>
    <div class="approval-actions">
      <button
        v-for="b in buttons"
        :key="b.label"
        type="button"
        class="approval-btn"
        :class="b.style"
        @click="choose(b)"
      >{{ b.label }}</button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { store, resolveApproval, cancelApproval } from '../ui/store.js';

const pending = computed(() => store.pendingApproval);
const cardEl = ref(null);

// Fixed choice sets per approval kind. The card never renders
// caller/model-supplied buttons, labels or HTML. Kinds without a v1 UI
// (capability / confirmation) fall back to a single dismiss that resolves
// the request as 'cancelled' — they have no production consumer yet.
const KIND_BUTTONS = {
  permission: [
    { label: 'Deny', style: 'deny', decision: { outcome: 'deny', scope: 'once' } },
    { label: 'Allow once', style: 'primary', decision: { outcome: 'allow', scope: 'once' } },
    { label: 'Allow for this session', style: 'secondary', decision: { outcome: 'allow', scope: 'session' } },
  ],
};
const FALLBACK_BUTTONS = [{ label: 'Dismiss', style: 'secondary', cancel: true }];
const buttons = computed(() => KIND_BUTTONS[pending.value.kind] || FALLBACK_BUTTONS);

const resourceLine = computed(() => {
  const r = pending.value.resource;
  return r ? (r.label || r.key || r.type || null) : null;
});

// The approval belongs to the RUNNING task. When the user is browsing a
// different conversation, say so instead of hiding the card.
const fromTitle = computed(() => {
  const id = pending.value.conversationId;
  if (!id || id === store.activeConversationId) return null;
  const conv = store.conversations.find((c) => c.id === id);
  return conv ? (conv.title || 'running task') : null;
});

function choose(b) {
  const p = store.pendingApproval;
  if (!p) return;
  if (b.cancel) cancelApproval(p.id);
  else resolveApproval(p.id, b.decision);
}

// Focus discipline (docs/APPROVALS.md): the card container gets focus —
// NEVER an Allow button, so muscle-memory Enter can never approve. Tab
// walks Deny → Allow once → Allow for this session in DOM order; on close,
// focus returns to the composer instead of dropping to <body>.
function focusCard() {
  nextTick(() => {
    const el = cardEl.value || document.querySelector('.approval-card');
    if (el && typeof el.focus === 'function') el.focus({ preventScroll: true });
  });
}
watch(pending, (p, prev) => {
  if (p) focusCard();
  else if (prev) {
    nextTick(() => {
      const ta = document.querySelector('.composer-input');
      if (ta && typeof ta.focus === 'function') ta.focus({ preventScroll: true });
    });
  }
});
onMounted(() => { if (store.pendingApproval) focusCard(); });
</script>
