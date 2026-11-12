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

const DIFF_FIELDS = [
  "articulo",
  "marca",
  "modelo",
  "serie",
  "area",
  "persona",
  "cantidad",
  "estado",
  "observaciones",
] as const;

export type InventarioFieldDiff = {
  etiqueta: string;
  field: string;
  from: string;
  to: string;
  leftId?: number | null;
  rightId?: number | null;
};

export type InventarioDiffResult = {
  left: string;
  right: string;
  /** En left pero no en right → “faltan” en right. */
  onlyLeft: InventarioRow[];
  /** En right pero no en left → “sobran” en right. */
  onlyRight: InventarioRow[];
  changed: InventarioFieldDiff[];
};

function fieldText(row: InventarioRow, field: (typeof DIFF_FIELDS)[number]): string {
  const val = row[field as keyof InventarioRow];
  if (val == null) return "";
  return String(val).trim();
}

/**
 * Diff real entre dos orígenes (p. ej. Inventario 2 vs S/O).
 * Reporta faltan / sobran / cambiaron por etiqueta.
 */
export function diffInventarios(
  rows: InventarioRow[],
  leftOrigen: string,
  rightOrigen: string,
): InventarioDiffResult {
  const left = leftOrigen.trim() || ORIGEN_SIN_ORIGEN;
  const right = rightOrigen.trim() || ORIGEN_SIN_ORIGEN;
  const leftMap = new Map<string, InventarioRow>();
  const rightMap = new Map<string, InventarioRow>();

  for (const row of rows) {
    const origen = origenOf(row);
    const etq = String(row.etiqueta ?? "").trim().toLowerCase();
    if (!etq) continue;
    if (origen === left) {
      const prev = leftMap.get(etq);
      if (!prev || rowTimestamp(row) >= rowTimestamp(prev)) leftMap.set(etq, row);
    }
    if (origen === right) {
      const prev = rightMap.get(etq);
      if (!prev || rowTimestamp(row) >= rowTimestamp(prev)) rightMap.set(etq, row);
    }
  }

  const onlyLeft: InventarioRow[] = [];
  const onlyRight: InventarioRow[] = [];
  const changed: InventarioFieldDiff[] = [];

  for (const [etq, row] of leftMap) {
    if (!rightMap.has(etq)) onlyLeft.push(row);
  }
  for (const [etq, row] of rightMap) {
    if (!leftMap.has(etq)) onlyRight.push(row);
  }
  for (const [etq, leftRow] of leftMap) {
    const rightRow = rightMap.get(etq);
    if (!rightRow) continue;
    for (const field of DIFF_FIELDS) {
      const from = fieldText(leftRow, field);
      const to = fieldText(rightRow, field);
      if (from.localeCompare(to, "es", { sensitivity: "base" }) === 0) continue;
      changed.push({
        etiqueta: String(leftRow.etiqueta ?? rightRow.etiqueta ?? etq),
        field,
        from: from || "(vacío)",
        to: to || "(vacío)",
        leftId: leftRow.id,
        rightId: rightRow.id,
      });
    }
  }

  return { left, right, onlyLeft, onlyRight, changed };
}

/**
 * Detecta “compara Inventario 2 vs S/O”, “diff inventario 1 y 2”, etc.
 */
export function detectCompareInventariosAsk(
  text: string,
  existing: string[] = [],
): { left: string; right: string } | undefined {
  const n = foldOrigenText(text);
  if (!n) return undefined;
  const wants =
    /\b(compara|comparar|comparacion|diff|diferencia|diferencias|versus)\b/.test(
      n,
    ) || /\bvs\b/.test(n);
  if (!wants) return undefined;

  const found: string[] = [];
  const numbered = [...n.matchAll(/\binventarios?\s*(\d+)\b/g)];
  for (const match of numbered) {
    const num = Number(match[1]);
    if (!Number.isFinite(num) || num <= 0) continue;
    const hit =
      existing.find((origen) => inventarioNumber(origen) === num) ||
      `Inventario ${num}`;
    if (!found.includes(hit)) found.push(hit);
  }
  if (/\b(s o|so|sin origen)\b/.test(n) && !found.includes(ORIGEN_SIN_ORIGEN)) {
    found.push(ORIGEN_SIN_ORIGEN);
  }
  for (const origen of existing) {
    const on = foldOrigenText(origen);
    if (on.length < 2) continue;
    if (n.includes(on) && !found.includes(origen)) found.push(origen);
  }

  if (found.length >= 2) {
    const a = found[0];
    const b = found[1];
    // S/O como base (left) cuando se compara contra Inventario N.
    if (a === ORIGEN_SIN_ORIGEN) return { left: a, right: b };
    if (b === ORIGEN_SIN_ORIGEN) return { left: b, right: a };
    return { left: a, right: b };
  }
  if (found.length === 1 && found[0] !== ORIGEN_SIN_ORIGEN) {
    return { left: ORIGEN_SIN_ORIGEN, right: found[0] };
  }
  // “compara inventarios” sin nombres → último vs S/O
  const latest = latestInventarioName(
    existing.filter((o) => o !== ORIGEN_SIN_ORIGEN),
  );
  if (latest && latest !== ORIGEN_SIN_ORIGEN) {
    return { left: ORIGEN_SIN_ORIGEN, right: latest };
  }
  return undefined;
}

export function formatInventarioDiffReply(diff: InventarioDiffResult): string {
  const faltan = diff.onlyLeft.length;
  const sobran = diff.onlyRight.length;
  const cambiaron = new Set(diff.changed.map((c) => c.etiqueta.toLowerCase())).size;
  const lines: string[] = [
    `Comparé **${diff.left}** vs **${diff.right}**:`,
    "",
    `• **Faltan en ${diff.right}:** **${faltan.toLocaleString("es-MX")}** (están en ${diff.left})`,
    `• **Sobran en ${diff.right}:** **${sobran.toLocaleString("es-MX")}** (no están en ${diff.left})`,
    `• **Cambiaron:** **${cambiaron.toLocaleString("es-MX")}** etiqueta${cambiaron === 1 ? "" : "s"} con campos distintos`,
  ];
  if (diff.changed.length) {
    const sample = diff.changed.slice(0, 6).map(
      (c) =>
        `• **${c.etiqueta}** · **${c.field}** · “${c.from}” → “${c.to}”`,
    );
    lines.push("", "Ejemplos de cambios:", ...sample);
  }
  lines.push(
    "",
    "El detalle está en el visor derecho. ¿Quieres ver solo los que faltan, los que sobran o los que cambiaron?",
  );
  return lines.join("\n");
}
