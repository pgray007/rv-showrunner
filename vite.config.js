import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dotenv from 'dotenv';
import { resolve } from 'path';

// Explicitly load .env from project root — loadEnv() alone isn't reliable
// when root is set to a subdirectory
dotenv.config({ path: resolve(process.cwd(), '.env') });

const API_PORT = process.env.PORT || 3030;
console.log(`[vite] API proxy → http://localhost:${API_PORT}`);

export default defineConfig({
  plugins: [react()],
  root: 'src/client',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api':     { target: `http://localhost:${API_PORT}`, changeOrigin: false },
      '/health':  { target: `http://localhost:${API_PORT}`, changeOrigin: false },
      '/version': { target: `http://localhost:${API_PORT}`, changeOrigin: false },
    },
  },
});
