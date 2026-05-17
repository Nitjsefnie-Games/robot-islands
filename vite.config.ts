import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Allow the public hostname when proxied through nginx; the leading dot
    // covers any subdomain so we don't have to update this for future hosts.
    allowedHosts: ['.nitjsefni.eu'],
    // Subagent-driven-development creates transient git-worktree shadows
    // under .claude/worktrees/<agent-id>/ that include their own index.html
    // + src/. Without this ignore, Vite watches those files and full-reloads
    // the live tab every time a subagent writes inside its worktree.
    watch: {
      ignored: ['**/.claude/**', '**/dist/**'],
    },
  },
});
