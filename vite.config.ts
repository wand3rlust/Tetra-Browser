import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const base = (process.env.BASE_PATH ?? '').replace(/\/?$/, '/');

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
