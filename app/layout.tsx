import type { Metadata } from "next";
import "./dashboard.css";

export const metadata: Metadata = {
  title: "Inventario de oficina",
  description: "Consulta artículos, asignaciones y áreas del inventario de oficina.",
};

const themeInitScript = `try{var t=localStorage.getItem("inventario-tema");if(t==="claro"){document.documentElement.classList.remove("theme-dark");}else{document.documentElement.classList.add("theme-dark");}var a=localStorage.getItem("inventario-apartado");if(a){document.documentElement.dataset.apartado=a;}}catch(e){document.documentElement.classList.add("theme-dark");}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es" className="theme-dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
