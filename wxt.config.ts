
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],

  manifest: {
    host_permissions: [
      'http://127.0.0.1:3001/*',
    ],
  },
});
