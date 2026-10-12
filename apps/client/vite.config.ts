import { defineConfig } from 'vite';

export default defineConfig({
  // Rutas relativas: necesario para que la build funcione dentro de la app de Capacitor.
  base: './',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    chunkSizeWarningLimit: 2000,
  },
});
