// Vite config for the Locus presentation layer.
//
// The runtime (src/agent.js, src/model.js, …) stays framework-independent
// plain scripts with file://-compatible globals — they are NOT bundled.
// index.html loads them as classic scripts; in dev the Vite server serves
// them in place, and the small plugin below copies them verbatim into the
// build output so `dist/` keeps the same layout.
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Classic-script runtime files referenced by index.html (and by the
// Node test suites, which eval these sources directly).
const RUNTIME_SCRIPTS = [
  'src/telemetry.js',
  'src/persistence.js',
  'src/model-adapters.js',
  'src/model.js',
  'src/workspace.js',
  'src/vfs.js',
  'src/conversation-history-workspace.js',
  'src/extensions.js',
  'src/capability-package.js',
  'src/attachments.js',
  'src/capabilities.js',
  'src/network.js',
  'src/shell.js',
  'src/tools.js',
  'src/approval.js',
  'src/agent.js',
  'src/mutation-policy.js',
  'src/ui/projector.js',
  'src/ui/markdown.js',
];

function copyRuntimeScripts() {
  return {
    name: 'locus-copy-runtime-scripts',
    apply: 'build',
    closeBundle() {
      for (const rel of RUNTIME_SCRIPTS) {
        const dest = join(this.environment?.config?.root || process.cwd(), 'dist', rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(rel, dest);
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [vue(), copyRuntimeScripts()],
  build: {
    target: 'es2020',
    outDir: 'dist',
    // M2a: the standalone runtime host (tests/runtime-host.html) is a REAL
    // build input so the gates run the packaged entry/worker-asset bundle,
    // not the dev-server sources.
    rollupOptions: {
      input: {
        main: 'index.html',
        runtimeHost: 'tests/runtime-host.html',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
