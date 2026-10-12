// Ejecuta el wrapper de Gradle del proyecto Android en cualquier sistema operativo.
// Uso: node scripts/gradle.mjs assembleDebug
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const androidDir = fileURLToPath(new URL('../android/', import.meta.url));
const win = process.platform === 'win32';
// Ruta absoluta: algunos entornos (npm en Windows) no buscan ejecutables en la carpeta actual.
const cmd = win ? `"${join(androidDir, 'gradlew.bat')}"` : join(androidDir, 'gradlew');
const res = spawnSync(cmd, process.argv.slice(2), { cwd: androidDir, stdio: 'inherit', shell: win });
if (res.status === 0 && process.argv.includes('assembleDebug')) {
  console.log('\nAPK lista: apps/client/android/app/build/outputs/apk/debug/app-debug.apk');
}
process.exit(res.status ?? 1);
