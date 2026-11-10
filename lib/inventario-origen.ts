import type { InventarioRow } from "@/lib/supabase";

/** Extrae el número de nombres tipo "Inventario 3". */
export function inventarioNumber(name: string): number | null {
  const match = String(name ?? "").trim().match(/inventario\s*(\d+)\s*$/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

/** Inventarios únicos, del más reciente al más antiguo (número mayor primero). */
export function sortInventariosNewestFirst(names: string[]): string[] {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  return unique.sort((a, b) => {
    const na = inventarioNumber(a);
    const nb = inventarioNumber(b);
    if (na !== null && nb !== null && na !== nb) return nb - na;
    if (na !== null && nb === null) return -1;
    if (na === null && nb !== null) return 1;
    return a.localeCompare(b, "es");
  });
}

export function listExistingOrigens(rows: InventarioRow[]): string[] {
  return sortInventariosNewestFirst(
    rows.map((row) => String(row.origen ?? "").trim()).filter(Boolean),
  );
}

/** Primera base de datos (sin origen previo). */
export const ORIGEN_SIN_ORIGEN = "S/O";

/** Siguiente inventario de conteo: Inventario N+1 (después de S/O arranca en Inventario 1). */
export function nextInventarioName(existing: string[]): string {
  let max = 0;
  for (const name of existing) {
    const n = inventarioNumber(name);
    if (n !== null && n > max) max = n;
  }
  return `Inventario ${max + 1}`;
}

export function latestInventarioName(existing: string[]): string {
  const sorted = sortInventariosNewestFirst(existing);
  return sorted[0] || ORIGEN_SIN_ORIGEN;
}

function foldOrigenText(raw: string) {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Destino de importación desde el chat: “Inventario 1”, “en vez de S/O”, etc.
 * Si pide un número que aún no existe, devuelve “Inventario N”.
 */
export function matchOrigenFromPrompt(
  text: string,
  existing: string[] = [],
): string | undefined {
  const n = foldOrigenText(text);
  if (!n) return undefined;

  const numbered = n.match(/\binventarios?\s*(\d+)\b/);
  if (numbered) {
    const num = Number(numbered[1]);
    if (Number.isFinite(num) && num > 0) {
      const hit = existing.find((origen) => inventarioNumber(origen) === num);
      return hit || `Inventario ${num}`;
    }
  }

  const rejectsDefault =
    /\b(en vez|enves|en lugar|envez|pero|no uses|no pongas|en vez de)\b/.test(n) &&
    /\b(s o|so|sin origen)\b/.test(n);

  let best: string | undefined;
  let bestLen = 0;
  for (const origen of existing) {
    const on = foldOrigenText(origen);
    if (on.length < 2) continue;
    if (rejectsDefault && (on === "s o" || on === "so")) continue;
    if (n.includes(on) && on.length > bestLen) {
      best = origen;
      bestLen = on.length;
    }
  }
  return best;
}

function rowTimestamp(row: InventarioRow): number {
  return (
    Date.parse(String(row.updated_at ?? "")) ||
    Date.parse(String(row.created_at ?? "")) ||
    0
  );
}

function sameEtiqueta(row: InventarioRow, needle: string): boolean {
  return String(row.etiqueta ?? "").trim().toLowerCase() === needle;
}

function origenOf(row: InventarioRow): string {
  return String(row.origen ?? "").trim();
}

/** Elige la fila más reciente (updated_at) entre coincidencias. */
function pickNewestRow(rows: InventarioRow[]): InventarioRow | null {
  if (!rows.length) return null;
  return [...rows].sort((a, b) => rowTimestamp(b) - rowTimestamp(a))[0] ?? null;
}

export type EtiquetaCascadeHit = {
  row: InventarioRow;
  foundIn: string;
  /** true si la etiqueta ya está en el inventario destino */
  inDestino: boolean;
};

/** ¿La etiqueta ya está registrada exactamente en ese inventario destino? */
export function existsInOrigen(
  rows: InventarioRow[],
  etiqueta: string,
  origen: string,
): InventarioRow | null {
  const needle = etiqueta.trim().toLowerCase();
  const target = origen.trim();
  if (!needle || !target) return null;
  const matches = rows.filter(
    (row) => sameEtiqueta(row, needle) && origenOf(row) === target,
  );
  return pickNewestRow(matches);
}

/**
 * Busca una etiqueta priorizando el inventario más reciente con datos actualizados.
 * - Si ya está en el destino → esa fila (para bloquear duplicado y mostrar info).
 * - Si no → la versión más reciente en inventarios anteriores al destino.
 */
export function findByEtiquetaCascade(
  rows: InventarioRow[],
  etiqueta: string,
  targetOrigen?: string,
): EtiquetaCascadeHit | null {
  const needle = etiqueta.trim().toLowerCase();
  if (!needle) return null;

  const matches = rows.filter((row) => sameEtiqueta(row, needle));
  if (!matches.length) return null;

  const destino = (targetOrigen ?? "").trim();
  const targetNum = destino ? inventarioNumber(destino) : null;

  // Duplicado solo si ya existe EN EL DESTINO elegido
  if (destino) {
    const alreadyThere = existsInOrigen(rows, etiqueta, destino);
    if (alreadyThere) {
      return { row: alreadyThere, foundIn: destino, inDestino: true };
    }
  }

  // Fuente: inventarios anteriores al destino (S/O = base, siempre anterior a Inventario N)
  const sourceCandidates = matches.filter((row) => {
    const origen = origenOf(row);
    if (!destino) return true;
    if (origen === destino) return false;
    const n = inventarioNumber(origen);
    // Destino sin número (p. ej. S/O): cualquier otro origen puede ser fuente
    if (targetNum === null) return origen !== destino;
    // Destino Inventario N: sirven Inventario 1..N-1 y S/O (sin número)
    if (n === null) return true;
    return n < targetNum;
  });

  if (!sourceCandidates.length) return null;

  // Primero el inventario con número más alto; dentro de él, el updated_at más reciente
  const byOrigen = new Map<string, InventarioRow[]>();
  for (const row of sourceCandidates) {
    const key = origenOf(row);
    const list = byOrigen.get(key) ?? [];
    list.push(row);
    byOrigen.set(key, list);
  }

  const origenOrder = sortInventariosNewestFirst([...byOrigen.keys()]);
  for (const origen of origenOrder) {
    const best = pickNewestRow(byOrigen.get(origen) ?? []);
    if (best) {
      return { row: best, foundIn: origen, inDestino: false };
    }
  }

  return null;
}

export function rowToFormFields(row: InventarioRow) {
  return {
    etiqueta: String(row.etiqueta ?? "").trim(),
    articulo: String(row.articulo ?? "").trim(),
    marca: row.marca?.toString().trim() || "",
    modelo: row.modelo?.toString().trim() || "",
    serie: row.serie?.toString().trim() || "",
    area: String(row.area ?? "").trim(),
    persona: row.persona?.toString().trim() || "",
    cantidad:
      typeof row.cantidad === "number" && !Number.isNaN(row.cantidad) ? row.cantidad : 1,
    observaciones: row.observaciones?.toString().trim() || "",
    estado: String(row.estado ?? "").trim().toLowerCase() === "inactivo" ? "Inactivo" : "Activo",
  };
}
