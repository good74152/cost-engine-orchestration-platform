import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true,
    // Preserve the browser Host and Origin for the existing backend CSRF check.
    proxy: { '/demo': { target: process.env.DEMO_BACKEND_TARGET ?? 'http://127.0.0.1:3000', changeOrigin: false } } },
  test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], clearMocks: true,
    include: ['src/**/*.test.{ts,tsx}'] },
});
