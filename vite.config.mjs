import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The production build gets a strict Content-Security-Policy. It is left out
// in development because the React refresh runtime injects an inline script.
const csp = {
  name: 'inject-csp',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        // Video thumbnails come from YouTube's image servers.
        content: "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.ytimg.com",
      },
      injectTo: 'head-prepend',
    },
  ],
};

export default defineConfig({
  base: './',
  plugins: [react(), csp],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
