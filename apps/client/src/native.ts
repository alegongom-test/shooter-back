import { isNative } from './config';

/** En la app nativa: horizontal fija, sin barra de estado y sin que se apague la pantalla. */
export async function setupNative(): Promise<void> {
  if (!isNative) return;
  try {
    const { ScreenOrientation } = await import('@capacitor/screen-orientation');
    await ScreenOrientation.lock({ orientation: 'landscape' });
  } catch (e) {
    console.warn('No se pudo bloquear la orientación', e);
  }
  try {
    const { StatusBar } = await import('@capacitor/status-bar');
    await StatusBar.hide();
  } catch (e) {
    console.warn('No se pudo ocultar la barra de estado', e);
  }
  try {
    const { KeepAwake } = await import('@capacitor-community/keep-awake');
    await KeepAwake.keepAwake();
  } catch (e) {
    console.warn('No se pudo mantener la pantalla encendida', e);
  }
}

let triedFullscreen = false;

/** En el navegador del móvil: pantalla completa + horizontal al primer toque (necesita gesto del usuario). */
export function tryWebFullscreen(): void {
  if (isNative || triedFullscreen) return;
  triedFullscreen = true;
  const el = document.documentElement;
  if (!el.requestFullscreen) return;
  el.requestFullscreen()
    .then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
    .catch(() => {});
}
