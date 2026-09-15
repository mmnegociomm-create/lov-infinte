import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    action: {},
    host_permissions: ['http://127.0.0.1:4096/*'],
  },
});
