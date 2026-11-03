import type { Metadata } from "next";
import "./dashboard.css";

export const metadata: Metadata = {
  title: "Inventario de oficina",
  description: "Consulta artículos, asignaciones y áreas del inventario de oficina.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es" className="theme-dark">
      <body>{children}</body>
    </html>
  );
}
