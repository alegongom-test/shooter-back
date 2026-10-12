import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.alex.horda',
  appName: 'Horda',
  webDir: 'dist',
  server: {
    // Desarrollo en red local: la app se sirve como http:// para poder abrir ws:// sin cifrar.
    // Para producción (wss://) se puede volver a 'https' y quitar cleartext.
    androidScheme: 'http',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
