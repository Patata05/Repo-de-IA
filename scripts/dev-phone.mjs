/**
 * Túnel HTTPS público (cloudflared) → http://127.0.0.1:3000
 * La cámara del celular funciona sin pelear con certificados locales.
 *
 * Uso:
 *   Terminal 1: npm run dev
 *   Terminal 2: npm run dev:phone
 * Abre en el celular la URL https://....trycloudflare.com que imprima.
 */
import { spawn } from "node:child_process";

console.log("");
console.log("========================================");
console.log("  Inventario · túnel para celular");
console.log("========================================");
console.log("  Asegúrate de tener corriendo: npm run dev");
console.log("  Luego abre en el celular la URL https://");
console.log("  que aparezca abajo (trycloudflare.com).");
console.log("========================================");
console.log("");

const child = spawn(
  "npx",
  ["--yes", "cloudflared", "tunnel", "--url", "http://127.0.0.1:3000"],
  {
    stdio: "inherit",
    shell: true,
    env: process.env,
  },
);

child.on("exit", (code) => process.exit(code ?? 0));
