
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],

  manifest: {
    name: 'Access OS',
    // the toolbar button; clicking it opens the side panel (see background.ts)
    action: { default_title: 'Access OS' },
    host_permissions: [
      'http://127.0.0.1:3001/*',
      // same sites the content script already runs on. needed so the agent
      // can read the tab's URL for its same-site and page-change checks
      'http://*/*',
      'https://*/*',
    ],
  },
});
