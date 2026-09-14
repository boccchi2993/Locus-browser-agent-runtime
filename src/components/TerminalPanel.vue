<template>
  <div class="terminal-drawer">
    <div class="terminal-head">
      <span>Terminal</span>
      <button class="icon-btn" type="button" aria-label="Close terminal" @click="store.terminalOpen = false">×</button>
    </div>
    <div class="terminal-body">
      <p class="terminal-note">
        Terminal interface reserved — not wired.
      </p>
      <p class="terminal-sub">
        This drawer is the future entry point for a direct user shell over the same
        workspace authority and tool layer the agent uses. No separate shell runtime
        exists today, and this panel does not execute anything. The agent's own
        <code>bash</code> tool executions appear in the task timeline.
      </p>
    </div>
  </div>
</template>

<script setup>
import { store } from '../ui/store.js';
</script>
