
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],

  manifest: {
    name: 'Access OS',
    // clicking it opens the side panel
    action: { default_title: 'Access OS' },
    host_permissions: [
      'http://127.0.0.1:3001/*',
      // lets the agent read the tab's url
      'http://*/*',
      'https://*/*',
    ],
  },
});
