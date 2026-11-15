
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],

  manifest: {
    name: 'Access OS',
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    // clicking it opens the side panel
    action: {
      default_title: 'Access OS',
      default_icon: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    },
    host_permissions: [
      'http://127.0.0.1:3001/*',
      // lets the agent read the tab's url
      'http://*/*',
      'https://*/*',
    ],
  },
});
