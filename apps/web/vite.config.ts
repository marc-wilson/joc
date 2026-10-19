import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // In dev the API runs separately; in production the server serves this app itself.
    proxy: { '/api': 'http://localhost:3000' },
  },
});
