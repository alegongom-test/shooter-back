import { Capacitor } from '@capacitor/core';
import { DEFAULT_PORT } from '@horda/shared';

export const params = new URLSearchParams(location.search);
export const isNative = Capacitor.isNativePlatform();

export function load(key: string): string | null {
  try {
    return localStorage.getItem(`horda.${key}`);
  } catch {
    return null;
  }
}

export function save(key: string, value: string): void {
  try {
    localStorage.setItem(`horda.${key}`, value);
  } catch {
    // almacenamiento no disponible (modo privado): no pasa nada
  }
}

/**
 * Acepta "192.168.1.5", "192.168.1.5:2567", "ws://…", "wss://…" o "https://xxxx.trycloudflare.com"
 * y devuelve una URL WebSocket completa.
 */
export function normalizeServerUrl(raw: string): string {
  let s = raw.trim();
  if (!s) return '';
  if (s.startsWith('https://')) s = 'wss://' + s.slice(8);
  else if (s.startsWith('http://')) s = 'ws://' + s.slice(7);
  else if (!/^wss?:\/\//.test(s)) s = 'ws://' + s;
  try {
    const u = new URL(s);
    if (!u.port && u.protocol === 'ws:') u.port = String(DEFAULT_PORT);
    return u.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

/** Dirección guardada; si no hay, el mismo host desde el que se cargó la página (útil en la red local). */
export function defaultServer(): string {
  const saved = load('server');
  if (saved) return saved;
  if (params.get('server')) return params.get('server')!;
  if (isNative || !location.hostname) return '';
  return `${location.hostname}:${DEFAULT_PORT}`;
}
