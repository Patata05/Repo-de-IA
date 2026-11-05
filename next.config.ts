import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  // Evita el warning al abrir desde el celular en la red local
  allowedDevOrigins: ["192.168.0.14", "127.0.0.1", "localhost"],
};

export default nextConfig;
