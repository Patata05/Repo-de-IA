import { networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cert = path.join(root, "certificates", "lan.pem");
const key = path.join(root, "certificates", "lan-key.pem");

function getLanIPv4() {
  const nets = networkInterfaces();
  const preferred = [];
  const others = [];

  for (const [name, entries] of Object.entries(nets)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const row = { name, address: entry.address };
      if (/wi-?fi|wlan|wireless/i.test(name) || entry.address.startsWith("192.168.")) {
        preferred.push(row);
      } else {
        others.push(row);
      }
    }
  }

  return (preferred[0] || others[0])?.address || "0.0.0.0";
}

const ip = getLanIPv4();

if (!existsSync(cert) || !existsSync(key)) {
  console.error("Faltan certificates/lan.pem y lan-key.pem.");
  console.error("Genera con mkcert: mkcert -cert-file certificates/lan.pem -key-file certificates/lan-key.pem TU_IP localhost 127.0.0.1");
  process.exit(1);
}

console.log("");
console.log("========================================");
console.log("  Inventario · HTTPS real en LAN");
console.log("========================================");
console.log(`  En el celular abre:`);
console.log(`  https://${ip}:3000`);
console.log("");
console.log("  Si Chrome dice 'no es privado':");
console.log("  Avanzado → Continuar a " + ip);
console.log("========================================");
console.log("");

const child = spawn(
  "npx",
  [
    "next",
    "dev",
    "--hostname",
    "0.0.0.0",
    "--port",
    "3000",
    "--experimental-https",
    "--experimental-https-key",
    key,
    "--experimental-https-cert",
    cert,
  ],
  {
    stdio: "inherit",
    shell: true,
    cwd: root,
    env: process.env,
  },
);

child.on("exit", (code) => process.exit(code ?? 0));
