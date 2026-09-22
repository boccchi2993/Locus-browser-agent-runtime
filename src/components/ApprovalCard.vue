<template>
  <div
    v-if="pending"
    ref="cardEl"
    class="approval-card"
    tabindex="-1"
    role="group"
    :aria-label="cardText.title + ': ' + (pending.action.summary || '')"
    data-testid="approval-card"
  >
    <div class="approval-title">{{ cardText.title }}</div>
    <p class="approval-lead">{{ cardText.lead }}</p>
    <!-- Vertical containment (docs/APPROVALS.md): the card is height-capped
         and this body is its only scrollable region, so no summary/detail
         length can push the action row (or the composer's Cancel task)
         out of the viewport. tabindex="0" keeps the scroll region
         keyboard-reachable. All request content is plain text ({{ }}
         interpolation escapes it); buttons/labels come from the fixed
         per-kind set below, never from the request payload. -->
    <div class="approval-body" tabindex="0">
      <div class="approval-summary">{{ pending.action.summary }}</div>
      <div v-if="pending.action.detail" class="approval-detail">{{ pending.action.detail }}</div>
      <div v-if="resourceLine" class="approval-resource">{{ resourceLine }}</div>
      <div v-if="fromTitle" class="approval-context">Request from running task: {{ fromTitle }}</div>
    </div>
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
    <div v-if="probeNote" class="approval-note">{{ probeNote }}</div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { store, resolveApproval, cancelApproval } from '../ui/store.js';

const pending = computed(() => store.pendingApproval);
const cardEl = ref(null);

// Fixed per-kind copy + choice sets. The card never renders
// caller/model-supplied buttons, labels or HTML. capability (Image
// Feedback v1, docs/IMAGE-INPUT.md) is a KNOWLEDGE question about the
// model, not a permission: its outcomes are confirm/decline/unsure, it
// has no session grants, and Escape cancels the decision instead of
// answering "No" (docs/APPROVALS.md). confirmation (mutable skill
// instances) is a BEHAVIOR-MUTATION gate: Confirm/Cancel only, no
// session grant, and the harness — never the model — supplied the
// summary, diff and resource identity.
const KIND_TEXT = {
  permission: { title: 'Approval required', lead: 'Locus wants permission to:' },
  capability: {
    title: 'Image capability',
    lead: 'Locus does not know whether the current model supports image input. Is this an image-capable model?',
  },
  confirmation: {
    title: 'Behavior change',
    lead: 'Locus wants to change future capability guidance:',
  },
};
const KIND_BUTTONS = {
  permission: [
    { label: 'Deny', style: 'deny', decision: { outcome: 'deny', scope: 'once' } },
    { label: 'Allow once', style: 'primary', decision: { outcome: 'allow', scope: 'once' } },
    { label: 'Allow for this session', style: 'secondary', decision: { outcome: 'allow', scope: 'session' } },
  ],
  capability: [
    { label: 'No', style: 'deny', decision: { outcome: 'decline' } },
    { label: 'Yes', style: 'primary', decision: { outcome: 'confirm' } },
    { label: "I don't know", style: 'secondary', decision: { outcome: 'unsure' } },
  ],
  confirmation: [
    { label: 'Cancel', style: 'deny', cancel: true },
    { label: 'Confirm', style: 'primary', decision: { outcome: 'confirm', scope: 'once' } },
  ],
};
const FALLBACK_BUTTONS = [{ label: 'Dismiss', style: 'secondary', cancel: true }];
const buttons = computed(() => KIND_BUTTONS[pending.value.kind] || FALLBACK_BUTTONS);
const cardText = computed(() => KIND_TEXT[pending.value.kind] || { title: 'Approval required', lead: 'Locus wants your input:' });
// Small probe disclosure on the unsure path — no "Recommended", no
// preselection: every choice is equal until the user picks one.
const probeNote = computed(() => pending.value.kind === 'capability'
  ? "Choosing \"I don't know\" runs a small visual check with a generated test image."
  : null);

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
// NEVER the Yes/Allow button, so muscle-memory Enter can never approve
// or answer. Tab walks the buttons in DOM order; on close, focus returns
// to the composer instead of dropping to <body>.
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
