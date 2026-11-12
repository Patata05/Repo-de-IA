/** Sinónimos de artículos / equipo para búsqueda robusta. */
export const ARTICULO_SYNONYMS: Record<string, string[]> = {
  pc: ["laptop", "computadora", "ordenador", "aio", "all in one", "desktop", "cpu"],
  laptop: ["pc", "computadora", "portatil", "notebook"],
  portatil: ["laptop", "pc", "notebook", "computadora"],
  computadora: ["pc", "laptop", "ordenador", "aio", "all in one", "desktop"],
  ordenador: ["pc", "computadora", "laptop"],
  aio: ["all in one", "computadora", "pc"],
  desktop: ["pc", "cpu", "computadora", "escritorio"],
  cpu: ["desktop", "pc", "gabinete"],
  impresora: ["printer", "multifuncional", "plotter"],
  printer: ["impresora", "multifuncional"],
  multifuncional: ["impresora", "printer"],
  monitor: ["pantalla", "display"],
  pantalla: ["monitor", "display"],
  proyector: ["canon", "epson", "videoproyector"],
  silla: ["asiento", "sillon"],
  mesa: ["escritorio", "table"],
  escritorio: ["mesa", "desktop"],
  telefono: ["celular", "movil", "smartphone"],
  celular: ["telefono", "movil", "smartphone"],
  scanner: ["escaner", "digitalizador"],
  escaner: ["scanner", "digitalizador"],
  switch: ["conmutador", "switch de red"],
  router: ["enrutador", "modem"],
  ups: ["no break", "nobreak", "respaldo energia"],
  nobreak: ["ups", "no break"],
  pintarron: ["pizarron", "whiteboard", "pizarra"],
  pizarron: ["pintarron", "pizarra", "whiteboard"],
};

export function expandSearchTokens(tokens: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const t = token.trim().toLowerCase();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    const syns = ARTICULO_SYNONYMS[t];
    if (!syns) continue;
    for (const syn of syns) {
      const s = syn.toLowerCase();
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}
