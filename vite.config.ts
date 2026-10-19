import { defineConfig } from 'vite';

export default defineConfig({
  // relative base so `dist/` can be served from any sub-path
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 4096,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
