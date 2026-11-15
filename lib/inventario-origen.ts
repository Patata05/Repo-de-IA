import type { InventarioRow, NewInventarioItem } from "@/lib/supabase";

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

/** Alta manual sin archivo ni conteo. */
export const ORIGEN_NUEVO_REGISTRO = "nuevo registro";

export type FileOrigenKind = "xlsx" | "xls" | "csv";

/** Extensión del archivo → kind de origen (xlsx / xls / csv). */
export function detectFileOrigenKind(fileName: string): FileOrigenKind | null {
  const ext = String(fileName || "")
    .trim()
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "csv") return "csv";
  if (ext === "xls") return "xls";
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  return null;
}

function fileOrigenNumber(name: string, kind: FileOrigenKind): number | null {
  const n = foldOrigenText(name);
  const m = n.match(new RegExp(`^${kind}\\s*(\\d+)$`));
  if (!m) return null;
  const num = Number(m[1]);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/** Siguiente origen de archivo: csv 1, xlsx 2, … */
export function nextFileOrigenName(
  kind: FileOrigenKind,
  existing: string[] = [],
): string {
  let max = 0;
  for (const name of existing) {
    const num = fileOrigenNumber(name, kind);
    if (num != null && num > max) max = num;
  }
  return `${kind} ${max + 1}`;
}

/** Origen por defecto al importar un Excel/CSV (no S/O). */
export function nextFileOrigenFromFileName(
  fileName: string,
  existing: string[] = [],
): string {
  const kind = detectFileOrigenKind(fileName) || "xlsx";
  return nextFileOrigenName(kind, existing);
}

/**
 * Ranking de “más actual” (mayor = más reciente / prioritario):
 * Inventario N > xlsx/xls/csv N > nuevo registro > S/O.
 */
export function origenCurrencyRank(origen: string): number {
  const raw = String(origen ?? "").trim();
  const fold = foldOrigenText(raw);
  if (!fold || fold === "s o" || fold === "so" || fold === "sin origen") return 0;
  if (fold === "nuevo registro" || fold === "nuevo") return 10_000;
  const inv = inventarioNumber(raw);
  if (inv != null) return 1_000_000 + inv;
  for (const kind of ["xlsx", "xls", "csv"] as FileOrigenKind[]) {
    const num = fileOrigenNumber(raw, kind);
    if (num != null) return 100_000 + num;
  }
  return 1_000;
}

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

/** Normaliza un valor de origen de celda/hoja/archivo. */
export function normalizeOrigenLabel(
  raw: string,
  existing: string[] = [],
): string | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  const n = foldOrigenText(trimmed);
  if (!n) return null;
  if (/^(s o|so|s\/o|sin origen|sinorigen)$/.test(n)) {
    return ORIGEN_SIN_ORIGEN;
  }
  const inv = n.match(/\binventarios?\s*(\d+)\b/);
  if (inv) {
    const num = Number(inv[1]);
    if (Number.isFinite(num) && num > 0) {
      const hit = existing.find((origen) => inventarioNumber(origen) === num);
      return hit || `Inventario ${num}`;
    }
  }
  for (const origen of existing) {
    if (foldOrigenText(origen) === n) return origen;
  }
  // Conservar etiqueta libre (p. ej. “Biblioteca”) si viene en columna.
  return trimmed;
}

/**
 * Destino desde nombre de archivo/hoja solo si apunta a un Inventario N.
 * Si no, el import usará csv/xlsx N (no devolver el nombre libre del archivo).
 */
export function matchOrigenFromFileName(
  fileName: string,
  existing: string[] = [],
): string | undefined {
  const base = String(fileName || "")
    .replace(/\.[^.]+$/i, "")
    .trim();
  if (!base) return undefined;
  const n = foldOrigenText(base);

  // “inventario 1” / “inventarios 2”
  const direct = n.match(/\binventarios?\s*(\d+)\b/);
  if (direct) {
    const num = Number(direct[1]);
    if (Number.isFinite(num) && num > 0) {
      const hit = existing.find((origen) => inventarioNumber(origen) === num);
      return hit || `Inventario ${num}`;
    }
  }

  // “inventario_oficina_1-v3” → primer número tras “inventario” (ignora v3)
  const afterInv = n.match(/\binventario(?:s)?\b(.+)$/);
  if (afterInv) {
    const rest = afterInv[1].replace(/\bv\s*\d+\b/g, " ");
    const numMatch = rest.match(/\b(\d+)\b/);
    if (numMatch) {
      const num = Number(numMatch[1]);
      if (Number.isFinite(num) && num > 0) {
        const hit = existing.find((origen) => inventarioNumber(origen) === num);
        return hit || `Inventario ${num}`;
      }
    }
  }

  // Ya es un origen de archivo tipado (csv 1, xlsx 2…)
  for (const kind of ["xlsx", "xls", "csv"] as FileOrigenKind[]) {
    const num = fileOrigenNumber(base, kind);
    if (num != null) {
      const label = `${kind} ${num}`;
      const hit = existing.find(
        (e) => foldOrigenText(e) === foldOrigenText(label),
      );
      return hit || label;
    }
  }

  return undefined;
}

export type ImportOrigenPlan =
  | {
      kind: "uniform";
      origen: string;
      source: "prompt" | "column" | "sheet" | "file" | "filter" | "default";
      alreadyExists: boolean;
    }
  | {
      kind: "mixed";
      /** Conteos por origen detectado en columna (≥1 origen distinto y con filas). */
      counts: Array<{ origen: string; count: number }>;
    };

/**
 * Decide destino de importación:
 * columna uniforme → prompt → hoja/archivo Inventario N → csv/xlsx N → filtro.
 * Ya no cae en S/O si hay archivo: usa xlsx 1 / csv 1…
 */
export function planImportOrigen(input: {
  promptText?: string;
  fileName?: string;
  sheetName?: string;
  columnOrigens?: string[];
  selectedFilter?: string | null;
  existing: string[];
}): ImportOrigenPlan {
  const existing = input.existing || [];
  const asked = matchOrigenFromPrompt(input.promptText || "", existing);
  const sheet = input.sheetName
    ? matchOrigenFromFileName(input.sheetName, existing)
    : undefined;
  const file = input.fileName
    ? matchOrigenFromFileName(input.fileName, existing)
    : undefined;
  const fileSequential = input.fileName
    ? nextFileOrigenFromFileName(input.fileName, existing)
    : null;

  const colNorm = (input.columnOrigens || [])
    .map((v) => normalizeOrigenLabel(v, existing))
    .filter((v): v is string => Boolean(v));

  if (colNorm.length > 0) {
    const countsMap = new Map<string, number>();
    for (const o of colNorm) {
      countsMap.set(o, (countsMap.get(o) || 0) + 1);
    }
    const counts = [...countsMap.entries()]
      .map(([origen, count]) => ({ origen, count }))
      .sort((a, b) => b.count - a.count);
    if (counts.length >= 2 && colNorm.length >= 2) {
      return { kind: "mixed", counts };
    }
    if (counts.length === 1) {
      const origen = counts[0].origen;
      return {
        kind: "uniform",
        origen,
        source: "column",
        alreadyExists: existing.some(
          (e) => foldOrigenText(e) === foldOrigenText(origen),
        ),
      };
    }
  }

  const filter =
    input.selectedFilter &&
    input.selectedFilter !== "ALL" &&
    String(input.selectedFilter).trim()
      ? String(input.selectedFilter).trim()
      : undefined;

  const picked =
    (asked
      ? { origen: asked, source: "prompt" as const }
      : null) ||
    (sheet ? { origen: sheet, source: "sheet" as const } : null) ||
    (file ? { origen: file, source: "file" as const } : null) ||
    (fileSequential
      ? { origen: fileSequential, source: "file" as const }
      : null) ||
    (filter ? { origen: filter, source: "filter" as const } : null) || {
      origen: ORIGEN_NUEVO_REGISTRO,
      source: "default" as const,
    };

  return {
    kind: "uniform",
    origen: picked.origen,
    source: picked.source,
    alreadyExists: existing.some(
      (e) => foldOrigenText(e) === foldOrigenText(picked.origen),
    ),
  };
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

  // Fuente: distinto al destino; Inventario N > csv/xlsx N > nuevo registro.
  const sourceCandidates = matches.filter((row) => {
    const origen = origenOf(row);
    if (!destino) return true;
    if (foldOrigenText(origen) === foldOrigenText(destino)) return false;
    const n = inventarioNumber(origen);
    if (targetNum != null && n != null && n >= targetNum) return false;
    return true;
  });

  if (!sourceCandidates.length) return null;

  sourceCandidates.sort((a, b) => {
    const d = origenCurrencyRank(origenOf(b)) - origenCurrencyRank(origenOf(a));
    if (d !== 0) return d;
    return rowTimestamp(b) - rowTimestamp(a);
  });
  const best = sourceCandidates[0];
  return best
    ? { row: best, foundIn: origenOf(best), inDestino: false }
    : null;
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
  leftCount: number;
  rightCount: number;
  /** Misma etiqueta en ambos y campos iguales. */
  same: InventarioRow[];
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

function diffEtiquetaMaps(
  leftLabel: string,
  rightLabel: string,
  leftMap: Map<string, InventarioRow>,
  rightMap: Map<string, InventarioRow>,
): InventarioDiffResult {
  const onlyLeft: InventarioRow[] = [];
  const onlyRight: InventarioRow[] = [];
  const same: InventarioRow[] = [];
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
    let fieldChanges = 0;
    for (const field of DIFF_FIELDS) {
      const from = fieldText(leftRow, field);
      const to = fieldText(rightRow, field);
      if (from.localeCompare(to, "es", { sensitivity: "base" }) === 0) continue;
      fieldChanges += 1;
      changed.push({
        etiqueta: String(leftRow.etiqueta ?? rightRow.etiqueta ?? etq),
        field,
        from: from || "(vacío)",
        to: to || "(vacío)",
        leftId: leftRow.id,
        rightId: rightRow.id,
      });
    }
    if (!fieldChanges) same.push(rightRow);
  }

  return {
    left: leftLabel,
    right: rightLabel,
    leftCount: leftMap.size,
    rightCount: rightMap.size,
    same,
    onlyLeft,
    onlyRight,
    changed,
  };
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

  return diffEtiquetaMaps(left, right, leftMap, rightMap);
}

/**
 * Compara un listado concreto (p. ej. últimos 10 del chat) contra un Inventario N.
 * “Faltan” = están en el listado y no en el destino; “sobran” no aplica al destino completo
 * (solo etiquetas del listado que también están en destino con cambios / iguales).
 */
export function diffRowsAgainstInventario(
  sourceRows: InventarioRow[],
  destOrigen: string,
  catalog: InventarioRow[],
  leftLabel = "este listado",
): InventarioDiffResult {
  const right = destOrigen.trim() || ORIGEN_SIN_ORIGEN;
  const leftMap = new Map<string, InventarioRow>();
  for (const row of sourceRows) {
    const etq = String(row.etiqueta ?? "").trim().toLowerCase();
    if (!etq) continue;
    const prev = leftMap.get(etq);
    if (!prev || rowTimestamp(row) >= rowTimestamp(prev)) leftMap.set(etq, row);
  }
  const rightMap = new Map<string, InventarioRow>();
  for (const row of catalog) {
    if (origenOf(row) !== right) continue;
    const etq = String(row.etiqueta ?? "").trim().toLowerCase();
    if (!etq || !leftMap.has(etq)) continue;
    const prev = rightMap.get(etq);
    if (!prev || rowTimestamp(row) >= rowTimestamp(prev)) rightMap.set(etq, row);
  }
  // Solo etiquetas del listado: no reportar “sobran” todo el inventario destino.
  const onlyLeft: InventarioRow[] = [];
  const same: InventarioRow[] = [];
  const changed: InventarioFieldDiff[] = [];
  for (const [etq, leftRow] of leftMap) {
    const rightRow = rightMap.get(etq);
    if (!rightRow) {
      onlyLeft.push(leftRow);
      continue;
    }
    let fieldChanges = 0;
    for (const field of DIFF_FIELDS) {
      const from = fieldText(leftRow, field);
      const to = fieldText(rightRow, field);
      if (from.localeCompare(to, "es", { sensitivity: "base" }) === 0) continue;
      fieldChanges += 1;
      changed.push({
        etiqueta: String(leftRow.etiqueta ?? rightRow.etiqueta ?? etq),
        field,
        from: from || "(vacío)",
        to: to || "(vacío)",
        leftId: leftRow.id,
        rightId: rightRow.id,
      });
    }
    if (!fieldChanges) same.push(rightRow);
  }
  return {
    left: leftLabel,
    right,
    leftCount: leftMap.size,
    rightCount: rightMap.size,
    same,
    onlyLeft,
    onlyRight: [],
    changed,
  };
}

/** “compara estos / esta consulta / el listado con Inventario N”. */
export function detectCompareScopedListAsk(
  text: string,
  existing: string[] = [],
): { dest: string } | undefined {
  const n = foldOrigenText(text);
  if (!n) return undefined;
  const wants =
    /\bcompara\w*\b/.test(n) ||
    /\b(diff|diferencia|diferencias)\b/.test(n) ||
    /\bvs\b/.test(n);
  if (!wants) return undefined;
  const scoped =
    /\b(est[oa]s?|esos|esas|esta\s+consulta|esta\s+lista|este\s+listado|lo\s+de\s+arriba|los\s+de\s+arriba|el\s+listado|mis\s+registros|la\s+consulta)\b/.test(
      n,
    ) ||
    /\b(ultimos?|recientes?)\s+\d+\s+registros?\b/.test(n) ||
    /\best[oa]s?\s+(ultimos?|recientes?)\b/.test(n) ||
    /\b(registros?|etiquetas?|resultados?)\s+(con|vs|contra|y)\s+(el\s+)?inventario/.test(
      n,
    ) ||
    /\b(con|vs|contra)\s+(lo\s+que\s+es\s+)?(el\s+)?inventario\s*\d+\b/.test(n);
  if (!scoped) return undefined;
  const nums = collectInventarioNumsFromText(n);
  if (!nums.length) return undefined;
  const destNum = nums[nums.length - 1];
  const dest =
    existing.find((o) => inventarioNumber(o) === destNum) ||
    `Inventario ${destNum}`;
  return { dest };
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
    ) ||
    /\bvs\b/.test(n) ||
    /^comparar\s+inventarios?$/.test(n);
  if (!wants) return undefined;

  // “estos registros con Inv N” lo maneja detectCompareScopedListAsk.
  if (detectCompareScopedListAsk(text, existing)) {
    return undefined;
  }

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
    // Evitar que “comparar inventarios” meta todos los orígenes por substring débil.
    if (on === "inventario" || /^inventario\s+\d+$/.test(on)) {
      if (!numbered.length && !/\binventario\s*\d+\b/.test(n)) continue;
    }
    if (n.includes(on) && !found.includes(origen)) found.push(origen);
  }

  if (found.length >= 2) {
    const a = found[0];
    const b = found[1];
    if (a === ORIGEN_SIN_ORIGEN) return { left: a, right: b };
    if (b === ORIGEN_SIN_ORIGEN) return { left: b, right: a };
    const na = inventarioNumber(a);
    const nb = inventarioNumber(b);
    if (na != null && nb != null && na !== nb) {
      return na < nb ? { left: a, right: b } : { left: b, right: a };
    }
    return { left: a, right: b };
  }
  // Un solo Inventario N sin “estos…”: pedir el otro, no inventar pareja.
  if (found.length === 1) {
    return undefined;
  }

  // “comparar inventarios” sin nombres → dos más recientes (o último vs S/O).
  const named = sortInventariosNewestFirst(
    existing.filter((o) => o !== ORIGEN_SIN_ORIGEN),
  );
  if (named.length >= 2) {
    return { left: named[1], right: named[0] };
  }
  if (named.length === 1 && existing.includes(ORIGEN_SIN_ORIGEN)) {
    return { left: ORIGEN_SIN_ORIGEN, right: named[0] };
  }
  if (named.length === 1) {
    return { left: ORIGEN_SIN_ORIGEN, right: named[0] };
  }
  return undefined;
}

/** Cantidad en palabras (1–20) o dígitos; para prosa clara. */
export function countWordsEs(n: number, noun: "etiqueta" | "registro" = "etiqueta"): string {
  const words = [
    "",
    "una",
    "dos",
    "tres",
    "cuatro",
    "cinco",
    "seis",
    "siete",
    "ocho",
    "nueve",
    "diez",
    "once",
    "doce",
    "trece",
    "catorce",
    "quince",
    "dieciséis",
    "diecisiete",
    "dieciocho",
    "diecinueve",
    "veinte",
  ];
  const abs = Math.max(0, Math.floor(n));
  const num =
    abs >= 1 && abs <= 20 ? words[abs] : abs.toLocaleString("es-MX");
  const plural = abs === 1 ? noun : noun === "etiqueta" ? "etiquetas" : "registros";
  if (abs === 1 && noun === "etiqueta") return `la etiqueta`;
  if (abs === 1) return `el registro`;
  if (abs >= 1 && abs <= 20) return `las ${num} ${plural}`;
  return `las ${num} ${plural}`;
}

function pickDiffVariant(variants: string[], salt: string): string {
  if (!variants.length) return "";
  let h = 17;
  for (let i = 0; i < salt.length; i += 1) {
    h = (h + salt.charCodeAt(i) * (i + 3)) % 997;
  }
  return variants[Math.abs(h) % variants.length];
}

function briefDiffRows(
  rows: Array<{ etiqueta?: string | null; articulo?: string | null }>,
  max = 3,
): string {
  return rows
    .slice(0, max)
    .map((r) => {
      const et = String(r.etiqueta ?? "").trim() || "S/E";
      const art = String(r.articulo ?? "").trim() || "—";
      return `**${et}** (${art})`;
    })
    .join(", ");
}

/**
 * Respuesta clara de comparación (prosa). No menciona ceros ni “esta consulta (N)”.
 */
export function formatInventarioDiffReply(diff: InventarioDiffResult): string {
  const faltan = diff.onlyLeft.length;
  const sobran = diff.onlyRight.length;
  const iguales = diff.same.length;
  const cambiaron = new Set(diff.changed.map((c) => c.etiqueta.toLowerCase())).size;
  const totalLeft = diff.leftCount || iguales + faltan + cambiaron;
  const dest = diff.right;
  const salt = `${diff.left}|${dest}|${iguales}|${faltan}|${sobran}|${cambiaron}`;

  if (!diff.leftCount && !diff.rightCount) {
    return pickDiffVariant(
      [
        `Revisé **${diff.left}** y **${dest}**, pero ninguno tiene etiquetas para comparar. Importa un Excel o elige otros inventarios y lo volvemos a hacer.`,
        `No hay etiquetas en **${diff.left}** ni en **${dest}** todavía. Cuando cargues algo, lo comparamos otra vez.`,
      ],
      salt,
    );
  }

  const scoped =
    /^esta consulta/i.test(diff.left) ||
    /^este listado/i.test(diff.left) ||
    /^listado/i.test(diff.left);

  // Todo coincide
  if (totalLeft > 0 && !faltan && !sobran && !cambiaron) {
    const qty = countWordsEs(totalLeft || iguales);
    if (scoped) {
      return pickDiffVariant(
        [
          `${qty.charAt(0).toUpperCase()}${qty.slice(1)} del listado ya coinciden en **${dest}**. ¿Te gustaría hacer otra consulta?`,
          `${qty.charAt(0).toUpperCase()}${qty.slice(1)} ya están correctas en **${dest}**. ¿Las quieres ver en el panel de la derecha?`,
          `${qty.charAt(0).toUpperCase()}${qty.slice(1)} ya están en **${dest}**. ¿Gustas que te exporte un Excel de ese inventario?`,
          `Todo el listado (${totalLeft}) ya está alineado con **${dest}**: mismas etiquetas y mismos datos. ¿Seguimos con otra acción?`,
        ],
        salt,
      );
    }
    return pickDiffVariant(
      [
        `**${diff.left}** y **${dest}** coinciden: ${qty} iguales, sin faltantes ni cambios. ¿Quieres ver el detalle en el panel o exportar un Excel?`,
        `Entre **${diff.left}** y **${dest}** no hay diferencias: ${qty} coinciden. ¿Te ayudo con otra consulta?`,
        `Comparación lista: **${diff.left}** y **${dest}** están alineados (${qty}). ¿Las ves en el panel o exportamos Excel?`,
      ],
      salt,
    );
  }

  const parts: string[] = [];

  if (scoped) {
    const qty = countWordsEs(totalLeft || iguales + faltan);
    if (faltan && !cambiaron && iguales === 0) {
      parts.push(
        `De ${qty} del listado, ninguna está aún en **${dest}**. Por ejemplo: ${briefDiffRows(diff.onlyLeft)}.`,
      );
    } else if (faltan && !cambiaron) {
      parts.push(
        `De ${qty} del listado, **${iguales.toLocaleString("es-MX")}** ya coinciden en **${dest}** y **${faltan.toLocaleString("es-MX")}** todavía no están ahí` +
          (faltan ? ` (por ejemplo ${briefDiffRows(diff.onlyLeft)})` : "") +
          `.`,
      );
    } else if (!faltan && cambiaron) {
      parts.push(
        `${qty.charAt(0).toUpperCase()}${qty.slice(1)} del listado sí están en **${dest}**, pero **${cambiaron.toLocaleString("es-MX")}** tienen datos distintos` +
          (diff.changed.length
            ? ` (ej. ${diff.changed
                .slice(0, 2)
                .map((c) => `**${c.etiqueta}**: ${c.field} “${c.from}” → “${c.to}”`)
                .join("; ")})`
            : "") +
          `.`,
      );
    } else {
      parts.push(
        `Comparé el listado (${totalLeft} etiquetas) con **${dest}**: ` +
          [
            iguales ? `**${iguales.toLocaleString("es-MX")}** ya coinciden` : "",
            faltan
              ? `**${faltan.toLocaleString("es-MX")}** no están en ese inventario`
              : "",
            cambiaron
              ? `**${cambiaron.toLocaleString("es-MX")}** con campos distintos`
              : "",
          ]
            .filter(Boolean)
            .join(", ") +
          `.`,
      );
      if (faltan) {
        parts.push(`Las que faltan incluyen ${briefDiffRows(diff.onlyLeft)}.`);
      }
    }
  } else {
    // Inventario vs inventario: solo mencionar lo que importa (nunca ceros).
    const lead = pickDiffVariant(
      [
        `Al comparar **${diff.left}** con **${dest}**:`,
        `Esto salió al revisar **${diff.left}** frente a **${dest}**:`,
        `Entre **${diff.left}** y **${dest}**:`,
      ],
      salt,
    );
    const chunks: string[] = [];
    if (iguales) {
      chunks.push(
        `**${iguales.toLocaleString("es-MX")}** etiquetas coinciden`,
      );
    }
    if (faltan) {
      chunks.push(
        `**${faltan.toLocaleString("es-MX")}** de **${diff.left}** no están en **${dest}**`,
      );
    }
    if (sobran) {
      chunks.push(
        `**${sobran.toLocaleString("es-MX")}** solo aparecen en **${dest}**`,
      );
    }
    if (cambiaron) {
      chunks.push(
        `**${cambiaron.toLocaleString("es-MX")}** con datos distintos`,
      );
    }
    parts.push(`${lead} ${chunks.join("; ")}.`);
    if (faltan) {
      parts.push(
        `Ejemplos que faltan en **${dest}**: ${briefDiffRows(diff.onlyLeft)}.`,
      );
    }
    if (sobran) {
      parts.push(
        `Ejemplos solo en **${dest}**: ${briefDiffRows(diff.onlyRight)}.`,
      );
    }
    if (diff.changed.length) {
      const sample = diff.changed
        .slice(0, 3)
        .map((c) => `**${c.etiqueta}** (${c.field}: “${c.from}” → “${c.to}”)`)
        .join(", ");
      parts.push(`Cambios, por ejemplo: ${sample}.`);
    }
  }

  const close = faltan
    ? pickDiffVariant(
        [
          `¿Quieres que te muestre solo las que faltan en el panel, o las pasamos a **${dest}**?`,
          `¿Las ves en el panel derecho o prefieres un Excel con las que faltan?`,
          `¿Seguimos con las faltantes o con otra consulta?`,
        ],
        salt,
      )
    : cambiaron
      ? pickDiffVariant(
          [
            `¿Revisamos esos cambios en el panel o exportamos un Excel?`,
            `¿Quieres ver el detalle en la derecha o hacer otra comparación?`,
          ],
          salt,
        )
      : sobran
        ? pickDiffVariant(
            [
              `¿Te muestro las que sobran en el panel o hacemos otra consulta?`,
              `¿Las ves a la derecha o exportamos Excel de **${dest}**?`,
            ],
            salt,
          )
        : pickDiffVariant(
            [
              `¿Te gustaría otra acción?`,
              `¿Las quieres ver en el panel o exportamos Excel?`,
              `¿Seguimos con otra consulta?`,
            ],
            salt,
          );

  return [...parts, close].filter(Boolean).join(" ");
}

export type PendingNewInventario = {
  name: string;
  askedAt: number;
  /** Si el usuario ya pidió dejarlo vacío. */
  emptyOk?: boolean;
};

export type CreateInventarioAsk = {
  name: string;
  alreadyExists: boolean;
};

export type FillNewInventarioPlan =
  | { kind: "empty" }
  | { kind: "copy_origen"; source: string }
  | { kind: "copy_etiquetas"; etiquetas: string[] }
  | { kind: "unclear" };

/** “inventario 1”, “inventari 1”, “alnventario 3”, “inventario tres”. */
const INV_TOKEN = "(?:al)?inventari[oa]?s?|alnventario";
const INV_WORD_NUM: Record<string, number> = {
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
};

function parseInventarioNumToken(raw: string): number | undefined {
  const t = String(raw || "").trim().toLowerCase();
  if (!t) return undefined;
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return INV_WORD_NUM[t];
}

function collectInventarioNumsFromText(n: string): number[] {
  const out: number[] = [];
  const re = new RegExp(
    `\\b(?:${INV_TOKEN})\\s*(\\d+|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\\b`,
    "g",
  );
  for (const m of n.matchAll(re)) {
    const num = parseInventarioNumToken(m[1]);
    if (num != null) out.push(num);
  }
  return out;
}

/** “omite/excluye esa etiqueta” (+ códigos en texto o del hilo). */
export function detectExcludedEtiquetasAsk(
  text: string,
  contextEtiquetas: string[] = [],
): string[] {
  const n = foldOrigenText(text);
  if (!n) return [];
  const wantsOmit =
    /\b(omite\w*|omitir\w*|excluye\w*|excluir\w*|salta\w*|saltar\w*|excepto|menos)\b/.test(
      n,
    ) ||
    /\bsi\s+hay\b/.test(n) ||
    /\bya\s+existe/.test(n) ||
    /\bno\s+(copies|copie|importes|importe|pases|pase|agregues|agregue)\b/.test(n);
  if (!wantsOmit) return [];

  const fromText = [
    ...new Set(
      [...text.matchAll(/\b([A-Za-z]{1,10}[-_/]?[A-Za-z0-9]*\d{2,10}|\d{4,12})\b/g)].map(
        (m) => m[1],
      ),
    ),
  ].filter((et) => {
    const low = et.toLowerCase();
    return !/^inventario\d*$/i.test(low) && !/^\d{1,3}$/.test(low);
  });

  if (fromText.length) return fromText.slice(0, 20);
  // “omite esa” → etiqueta del mensaje de arriba
  if (
    /\b(esa|ese|eso|esta|este|esa etiqueta|la etiqueta)\b/.test(n) &&
    contextEtiquetas.length
  ) {
    return [contextEtiquetas[0]];
  }
  // “si hay alguna en el 3 omítela” = saltar duplicados en destino (no lista fija).
  return [];
}

/**
 * “mete al Inventario 5 todos los registros de todos los demás inventarios”.
 */
export function detectBulkCopyAllOthersToInventarioAsk(
  text: string,
  existing: string[] = [],
): { dest: string; sources: string[] } | undefined {
  const n = foldOrigenText(text);
  if (!n) return undefined;
  if (
    /\bcompara\w*\b/.test(n) ||
    /\b(diff|diferencia|versus)\b/.test(n) ||
    /\bvs\b/.test(n)
  ) {
    return undefined;
  }
  const transferVerb =
    /\b(pasa\w*|copia\w*|mete\w*|mueve\w*|mover\w*|traslad\w*|traspas\w*|importa\w*|trae\w*|traer\w*|pon\w*|agrega\w*)\b/.test(
      n,
    );
  if (!transferVerb) return undefined;
  const allOthers =
    /\b(todos?\s+los\s+demas|todas?\s+las\s+demas|todos?\s+los\s+otros|todas?\s+las\s+otras|resto\s+de\s+(los\s+)?inventarios|demas\s+inventarios|otros\s+inventarios)\b/.test(
      n,
    ) ||
    (/\b(todos?|todas?)\b/.test(n) &&
      /\b(demas|otros|otras|resto)\b/.test(n) &&
      /\b(inventarios?|registros?|regsitros|etiquetas?)\b/.test(n));
  if (!allOthers) return undefined;
  const nums = collectInventarioNumsFromText(n);
  if (!nums.length) return undefined;
  const destNum = nums[nums.length - 1];
  if (!destNum) return undefined;
  const dest =
    existing.find((o) => inventarioNumber(o) === destNum) ||
    `Inventario ${destNum}`;
  const sources = sortInventariosNewestFirst(
    existing.filter((o) => {
      const num = inventarioNumber(o);
      if (num != null) return num !== destNum;
      return foldOrigenText(o) !== foldOrigenText(dest);
    }),
  );
  if (!sources.length) return undefined;
  return { dest, sources };
}

/**
 * “pasa todas las etiquetas de Inventario 1 al Inventario 3;
 *  si ya existe alguna, notifícame”.
 * También: “importa todos los registros de inventari 1 a inventario 3”.
 */
export function detectBulkCopyBetweenInventariosAsk(
  text: string,
  existing: string[] = [],
): { source: string; dest: string; notifyExisting: boolean } | undefined {
  const n = foldOrigenText(text);
  if (!n) return undefined;

  const transferVerb =
    /\b(pasa\w*|copia\w*|mete\w*|mueve\w*|mover\w*|traslad\w*|traspas\w*|llena\w*|echale\w*|importa\w*|trae\w*|traer\w*|continua\w*|contin\w*|pon\w*|agrega\w*)\b/.test(
      n,
    );
  if (!transferVerb) return undefined;

  const hasInvMention =
    collectInventarioNumsFromText(n).length > 0 ||
    new RegExp(`\\b(?:${INV_TOKEN})\\b`).test(n);
  if (
    !/\b(etiqueta|etiquetas|registro|registros|regsitros|todo|toda|todas|todos|todosa|completo|completa)\b/.test(
      n,
    ) &&
    !hasInvMention
  ) {
    // Aún puede ser “pasa inventario 1 a inventario 3”
    if (
      !new RegExp(`\\b(a|al|hacia|en)\\s+(?:el\\s+)?(?:${INV_TOKEN})`).test(n)
    ) {
      return undefined;
    }
  }

  const resolveNum = (num: number) =>
    existing.find((o) => inventarioNumber(o) === num) || `Inventario ${num}`;

  // Preferir “de/del/desde Inventario X” → source y “a/al/hacia Inventario Y” → dest
  const fromRe = new RegExp(
    `\\b(?:de|del|desde)\\s+(?:el\\s+)?(?:${INV_TOKEN})\\s*(\\d+|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\\b`,
  );
  const toRe = new RegExp(
    `\\b(?:a|al|hacia|en)\\s+(?:el\\s+)?(?:${INV_TOKEN})\\s*(\\d+|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\\b`,
  );
  const fromMatch = n.match(fromRe);
  const toMatch = n.match(toRe);

  let source: string | undefined;
  let dest: string | undefined;
  if (fromMatch && toMatch) {
    const fromNum = parseInventarioNumToken(fromMatch[1]);
    const toNum = parseInventarioNumToken(toMatch[1]);
    if (fromNum == null || toNum == null) return undefined;
    source = resolveNum(fromNum);
    dest = resolveNum(toNum);
  } else {
    const uniqueNums = [
      ...new Set(
        collectInventarioNumsFromText(n).filter(
          (x) => Number.isFinite(x) && x > 0,
        ),
      ),
    ];
    if (uniqueNums.length < 2) return undefined;
    source = resolveNum(uniqueNums[0]);
    dest = resolveNum(uniqueNums[1]);
  }

  if (!source || !dest || source === dest) return undefined;

  return { source, dest, notifyExisting: true };
}

/**
 * “pasa todos sus registros / su inventario a Inventario 4”
 * También: “estos registros de hector pasalos al inventario 4”
 * (persona del hilo o nombrada; no solo las etiquetas de ejemplo del chat).
 */
export function detectCopyPersonRecordsToInventarioAsk(
  text: string,
  existing: string[] = [],
): { dest: string } | undefined {
  const n = foldOrigenText(text);
  if (!n) return undefined;
  // Comparar listado ≠ pasar/copiar.
  if (
    /\bcompara\w*\b/.test(n) ||
    /\b(diff|diferencia|diferencias|versus)\b/.test(n) ||
    /\bvs\b/.test(n)
  ) {
    return undefined;
  }
  const transferVerb =
    /\b(pasa|pasar|pases|pase|pasame|pasalos|pasalas|copia|copiar|copialos|copialas|mete|meter|mueve|mover|traslada|traspasa|agrega|agregar|importa|importar)\b/.test(
      n,
    );
  if (!transferVerb) return undefined;
  const personBulk =
    /\b(sus?|tod[oa]s?\s+sus?)\s+(registros?|etiquetas?|equipos?|articulos?|cosas|inventario)\b/.test(
      n,
    ) ||
    /\b(todo|toda|todos|todas)\s+(su|sus)\s+(inventario|registros?|etiquetas?)\b/.test(
      n,
    ) ||
    /\bsu\s+inventario\b/.test(n) ||
    // Anáfora al panel de persona: “estos/esas registros/etiquetas” (sin “últimos N”)
    /\best[oa]s?\s+(registros?|etiquetas?|equipos?|articulos?)\b/.test(n) ||
    // “registros de hector” (no “de inventario”)
    /\b(registros?|etiquetas?|equipos?|articulos?)\s+de\s+(?!inventari)[a-z]/.test(
      n,
    ) ||
    /\blos\s+de\s+(?!inventari)[a-z]/.test(n);
  if (!personBulk) return undefined;
  // “todos los demás inventarios → Inv N” / bulk N→M tienen prioridad.
  if (detectBulkCopyAllOthersToInventarioAsk(text, existing)) {
    return undefined;
  }
  if (
    /\b(todo|toda|todas|todos)\b/.test(n) &&
    collectInventarioNumsFromText(n).length >= 2 &&
    !/\b(su|sus|est[oa]s?)\b/.test(n) &&
    !/\b(registros?|etiquetas?)\s+de\s+[a-z]/.test(n)
  ) {
    return undefined;
  }
  const nums = collectInventarioNumsFromText(n);
  if (!nums.length) return undefined;
  const destNum = nums[nums.length - 1];
  const dest =
    existing.find((o) => inventarioNumber(o) === destNum) ||
    `Inventario ${destNum}`;
  return { dest };
}

/**
 * “agrega etiqueta 283586 a Inventario 2” / “pasa esa a inventario 2”
 * (etiquetas pueden venir del hilo vía contextEtiquetas).
 */
export function detectCopyEtiquetasToInventarioAsk(
  text: string,
  existing: string[] = [],
  contextEtiquetas: string[] = [],
): { etiquetas: string[]; dest: string } | undefined {
  const n = foldOrigenText(text);
  if (!n) return undefined;

  // “todos los demás inventarios → Inv N” tiene prioridad.
  if (detectBulkCopyAllOthersToInventarioAsk(text, existing)) {
    return undefined;
  }
  // “todos sus registros → Inv N” lo maneja detectCopyPersonRecordsToInventarioAsk.
  if (detectCopyPersonRecordsToInventarioAsk(text, existing)) {
    return undefined;
  }

  const transferVerb =
    /\b(pasa|pasar|pases|pase|pasame|copia|copiar|mete|meter|mueve|mover|traslada|traspasa|agrega|agregar|agregala|agregalo|importa|importar|pon|poner|trae|traer)\b/.test(
      n,
    );
  if (!transferVerb) return undefined;

  const nums = collectInventarioNumsFromText(n);
  if (!nums.length) return undefined;
  // Destino = último Inventario N citado (“a inventario 2”).
  const destNum = nums[nums.length - 1];
  const dest =
    existing.find((o) => inventarioNumber(o) === destNum) ||
    `Inventario ${destNum}`;

  const fromText = [
    ...new Set(
      [...text.matchAll(/\b([A-Za-z]{1,10}[-_/]?[A-Za-z0-9]*\d{2,10}|\d{4,12})\b/g)].map(
        (m) => m[1],
      ),
    ),
  ].filter((et) => {
    const low = et.toLowerCase();
    return !/^inventario\d*$/i.test(low) && !/^\d{1,3}$/.test(low);
  });

  const etiquetas = fromText.length
    ? fromText
    : contextEtiquetas.map((e) => String(e).trim()).filter(Boolean);

  if (!etiquetas.length) return undefined;
  // Bulk “todo inventario 1 → 3” lo maneja otro detector.
  if (
    /\b(todo|toda|todas|todos|completo|completa)\b/.test(n) &&
    nums.length >= 2 &&
    !fromText.length
  ) {
    return undefined;
  }

  return { etiquetas: etiquetas.slice(0, 40), dest };
}

/** “haz un nuevo inventario llamado Inventario 3” / “crea inventario 3”. */
export function detectCreateInventarioAsk(
  text: string,
  existing: string[] = [],
): CreateInventarioAsk | undefined {
  const n = foldOrigenText(text);
  if (!n) return undefined;
  if (/\b(compara|comparar|comparacion|diff|diferencia)\b/.test(n)) {
    return undefined;
  }
  // “mete/copia al nuevo inventario…” es relleno, no creación.
  if (
    /\b(mete|meter|pon|poner|pasa|pasar|copia|copiar|traslada|trasladar|agrega|agregar)\b/.test(
      n,
    ) &&
    !/\b(crea|crear|haz|hacer|has|abre|abrir|genera|generar)\b/.test(n)
  ) {
    return undefined;
  }

  // “dame el inventario de Héctor / panorama / totales” ≠ crear Inventario N.
  // “registro(s)” solo bloquea si NO hay verbo de crear (si no, “crear Inv 5 + un registro” falla).
  if (/\binventario\s+(general\s+)?de\b/.test(n)) {
    return undefined;
  }
  if (
    /\b(panorama|resumen|totales?)\b/.test(n) &&
    !/\b(crea|crear|haz|hacer|abre|abrir|genera|generar)\b/.test(n)
  ) {
    return undefined;
  }
  if (
    /\bregistros?\b/.test(n) &&
    !/\b(crea|crear|haz|hacer|abre|abrir|genera|generar|nuevo)\b/.test(n)
  ) {
    return undefined;
  }
  if (
    /\b(dame|muestra|mostrar|ver|lista|listar|cuant[oa]s?)\b/.test(n) &&
    !/\b(crea|crear|haz|hacer|abre|abrir|genera|generar|nuevo)\b/.test(n)
  ) {
    return undefined;
  }
  const createVerb =
    /\b(crea|crear|crealo|creala|creame|creanos|haz|hacer|abre|abrir|genera|generar|preparo|prepara|preparar)\b/.test(
      n,
    ) ||
    /\b(quiero|necesito)\s+(un\s+)?(nuevo\s+)?inventario\b/.test(n) ||
    /\b(quiero|necesito)\s+que\s+(me\s+)?(crees|creas|hagas)\b/.test(n);
  const nuevoInventario = /\bnuevo\s+inventario\b/.test(n);
  if (!createVerb && !(nuevoInventario && /\b(llamado|llamada|nombre)\b/.test(n))) {
    return undefined;
  }
  if (!/\binventarios?\b/.test(n)) return undefined;

  let name: string | undefined;
  const called = n.match(
    /\b(?:llamado|llamada|nombre|nombrado)\s+((?:inventario\s*)?\d+|[a-z0-9][a-z0-9 _-]{1,40})/,
  );
  if (called?.[1]) {
    const raw = called[1].trim();
    const num = raw.match(/(?:inventario\s*)?(\d+)\s*$/);
    name = num ? `Inventario ${Number(num[1])}` : raw.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (!name) {
    const numbered = n.match(/\binventarios?\s*(\d+)\b/);
    if (numbered) name = `Inventario ${Number(numbered[1])}`;
  }
  if (!name) {
    // “haz un nuevo inventario” sin número → siguiente libre.
    name = nextInventarioName(existing);
  }

  const alreadyExists = existing.some(
    (e) => foldOrigenText(e) === foldOrigenText(name!),
  );
  return { name, alreadyExists };
}

/** Consultas que NO son relleno del inventario pendiente. */
export function looksLikeNonFillInventarioAsk(text: string): boolean {
  const n = foldOrigenText(text);
  if (!n) return false;
  return /\b(duplicadas?|duplicados?|repetidas?|repetidos?|compara|comparar|diff|diferencia|checa|chequea|revisa|busca|cuant[oa]s|cuantos|lista|muestra|dame|ver|personas|areas?|estado|qr|excel|csv|xlsx)\b/.test(
    n,
  );
}

/** Follow-up tras pedir un inventario nuevo: vacío / etiquetas / copiar otro origen. */
export function detectFillNewInventarioAsk(
  text: string,
  pending: PendingNewInventario | null,
  existing: string[] = [],
): FillNewInventarioPlan | undefined {
  if (!pending?.name) return undefined;
  const n = foldOrigenText(text);
  if (!n) return undefined;
  // No hijackear “checa duplicados en Inventario 1”, comparaciones, etc.
  if (looksLikeNonFillInventarioAsk(text)) return undefined;

  if (
    /\b(vacio|vacia|nada|sin\s+nada|dejalo\s+vacio|dejala\s+vacia|solo\s+vacio)\b/.test(
      n,
    )
  ) {
    return { kind: "empty" };
  }

  const fillVerb =
    /\b(mete|meter|pon|poner|pasa|pasar|copia|copiar|agrega|agregar|traslada|trasladar|llevalo|echale)\b/.test(
      n,
    );

  const source = matchOrigenFromPrompt(text, existing);
  const wantsWhole =
    fillVerb &&
    /\b(todo|toda|completo|completa|entero|entera)\b/.test(n) &&
    /\binventario\s*\d+\b/.test(n);
  if (
    source &&
    foldOrigenText(source) !== foldOrigenText(pending.name) &&
    wantsWhole
  ) {
    return { kind: "copy_origen", source };
  }

  const etiquetas = [
    ...new Set(
      [...text.matchAll(/\b([A-Za-z]{1,10}[-_/]?[A-Za-z0-9]*\d{2,8}|\d{4,10})\b/g)].map(
        (m) => m[1],
      ),
    ),
  ].filter((et) => {
    const low = et.toLowerCase();
    return !/^inventario\d*$/i.test(low) && !/^\d{1,3}$/.test(low);
  });

  // Solo meter etiquetas si hay verbo de relleno o el mensaje es casi solo códigos.
  if (etiquetas.length && (fillVerb || /^\s*([a-z0-9/_-]+\s*,?\s*)+$/i.test(text.trim()))) {
    return { kind: "copy_etiquetas", etiquetas };
  }

  // Solo pedir aclaración con verbo de meter / respuesta al pending.
  if (fillVerb || /\bnuevo\s+inventario\b/.test(n)) {
    return { kind: "unclear" };
  }

  return undefined;
}

export type DuplicateEtiquetasAsk = {
  /** Si viene, busca duplicados solo dentro de ese origen. */
  origen?: string;
  /** Si hay dos orígenes, busca etiquetas compartidas entre ambos. */
  between?: [string, string];
};

/** “checa etiquetas duplicadas en Inventario 1” / “entre Inventario 1 e Inventario 3”. */
export function detectDuplicateEtiquetasAsk(
  text: string,
  existing: string[] = [],
): DuplicateEtiquetasAsk | undefined {
  const n = foldOrigenText(text);
  if (!n) return undefined;
  if (
    !/\b(duplicadas?|duplicados?|duplicada|duplicado|repetidas?|repetidos?|misma etiqueta|etiquetas iguales)\b/.test(
      n,
    )
  ) {
    return undefined;
  }

  const numbered = [...n.matchAll(/\binventarios?\s*(\d+)\b/g)].map((m) =>
    Number(m[1]),
  );
  const origens = numbered
    .map((num) => {
      const hit = existing.find((o) => inventarioNumber(o) === num);
      return hit || `Inventario ${num}`;
    })
    .filter(Boolean);

  if (origens.length >= 2) {
    return { between: [origens[0], origens[1]] };
  }
  if (origens.length === 1) {
    return { origen: origens[0] };
  }

  const fileHit = existing.find((o) => {
    const on = foldOrigenText(o);
    return (
      (/^(xlsx|xls|csv)\s*\d+$/.test(on) && n.includes(on)) ||
      (on.length >= 3 && n.includes(on) && !/^inventario/.test(on))
    );
  });
  if (fileHit) return { origen: fileHit };

  return {};
}

export type DuplicateEtiquetaGroup = {
  etiqueta: string;
  count: number;
  origens: string[];
  rows: InventarioRow[];
};

/** Duplicados de etiqueta dentro de un origen, o compartidas entre dos. */
export function findDuplicateEtiquetas(
  rows: InventarioRow[],
  ask: DuplicateEtiquetasAsk,
): DuplicateEtiquetaGroup[] {
  if (ask.between) {
    const [a, b] = ask.between;
    const setA = new Map<string, InventarioRow>();
    const setB = new Map<string, InventarioRow>();
    for (const row of rows) {
      const et = String(row.etiqueta ?? "").trim();
      if (!et) continue;
      const o = String(row.origen ?? "").trim();
      const key = et.toLowerCase();
      if (o === a) setA.set(key, row);
      if (o === b) setB.set(key, row);
    }
    const out: DuplicateEtiquetaGroup[] = [];
    for (const [key, rowA] of setA) {
      const rowB = setB.get(key);
      if (!rowB) continue;
      out.push({
        etiqueta: String(rowA.etiqueta ?? key),
        count: 2,
        origens: [a, b],
        rows: [rowA, rowB],
      });
    }
    out.sort((x, y) => x.etiqueta.localeCompare(y.etiqueta, "es"));
    return out;
  }

  const scoped = ask.origen
    ? rows.filter((r) => String(r.origen ?? "").trim() === ask.origen)
    : rows;
  const byEtq = new Map<string, InventarioRow[]>();
  for (const row of scoped) {
    const et = String(row.etiqueta ?? "").trim();
    if (!et) continue;
    const key = et.toLowerCase();
    const bucket = byEtq.get(key) || [];
    bucket.push(row);
    byEtq.set(key, bucket);
  }

  const out: DuplicateEtiquetaGroup[] = [];
  for (const [, group] of byEtq) {
    if (group.length < 2) continue;
    const etiqueta = String(group[0].etiqueta ?? "");
    const origens = [
      ...new Set(group.map((r) => String(r.origen ?? "").trim()).filter(Boolean)),
    ];
    out.push({ etiqueta, count: group.length, origens, rows: group });
  }
  out.sort((a, b) => b.count - a.count || a.etiqueta.localeCompare(b.etiqueta, "es"));
  return out;
}

export function formatDuplicateEtiquetasReply(
  ask: DuplicateEtiquetasAsk,
  groups: DuplicateEtiquetaGroup[],
): string {
  const scope = ask.between
    ? `entre **${ask.between[0]}** y **${ask.between[1]}**`
    : ask.origen
      ? `solo en **${ask.origen}**`
      : "en todo el inventario";

  if (!groups.length) {
    return (
      `No encontré etiquetas duplicadas ${scope}. ` +
      `Cada etiqueta aparece una sola vez` +
      (ask.origen ? ` dentro de ese origen` : "") +
      `. ` +
      (ask.origen
        ? `Nota: la misma etiqueta sí puede existir en otro inventario (es copia de conteo), y eso no cuenta como duplicado interno.`
        : "")
    );
  }

  const sample = groups.slice(0, 12).map((g) => {
    const where =
      g.origens.length > 1
        ? g.origens.map((o) => `**${o}**`).join(" + ")
        : `×${g.count}`;
    const art = String(g.rows[0]?.articulo ?? "").trim();
    return `• **${g.etiqueta}** ${art ? `(${art}) ` : ""}— ${where}`;
  });
  const more =
    groups.length > 12
      ? `\n…y **${groups.length - 12}** más.`
      : "";

  return (
    `Encontré **${groups.length.toLocaleString("es-MX")}** etiqueta` +
    `${groups.length === 1 ? "" : "s"} duplicada${groups.length === 1 ? "" : "s"} ${scope}:\n\n` +
    sample.join("\n") +
    more +
    `\n\nEl detalle está en el visor derecho.`
  );
}

export function rowToNewInventarioItem(
  row: InventarioRow,
  destOrigen: string,
): NewInventarioItem {
  const from = String(row.origen ?? "").trim();
  const prevObs = row.observaciones?.toString().trim() || "";
  const copyNote =
    from && foldOrigenText(from) !== foldOrigenText(destOrigen)
      ? `Copiado desde ${from}.`
      : "";
  const observaciones = copyNote
    ? prevObs && !/copiado desde/i.test(prevObs)
      ? `${prevObs}\n${copyNote}`
      : prevObs || copyNote
    : prevObs || null;
  return {
    etiqueta: String(row.etiqueta ?? "").trim(),
    articulo: String(row.articulo ?? "").trim(),
    marca: row.marca?.toString().trim() || null,
    modelo: row.modelo?.toString().trim() || null,
    serie: row.serie?.toString().trim() || null,
    area: String(row.area ?? "").trim() || "Sin asignar",
    persona: row.persona?.toString().trim() || null,
    cantidad:
      typeof row.cantidad === "number" && !Number.isNaN(row.cantidad)
        ? row.cantidad
        : 1,
    observaciones,
    estado: row.estado,
    origen: destOrigen,
  };
}

/**
 * Origen de datos (fuente) vs inventario del conteo.
 * Prioridad de nota “Copiado desde…”, si no el sibling más actual.
 */
export function resolveFuenteOrigen(
  product: InventarioRow,
  catalog: InventarioRow[] = [],
): string | null {
  const obs = String(product.observaciones ?? "");
  const fromObs = obs.match(/copiado desde\s+([^\n.]+)/i)?.[1]?.trim();
  if (fromObs) return fromObs;

  const etq = String(product.etiqueta ?? "").trim().toLowerCase();
  if (!etq || !catalog.length) return null;
  const current = String(product.origen ?? "").trim();
  const siblings = catalog.filter((row) => {
    if (String(row.etiqueta ?? "").trim().toLowerCase() !== etq) return false;
    if (product.id != null && row.id != null && Number(row.id) === Number(product.id)) {
      return false;
    }
    const o = String(row.origen ?? "").trim();
    return o && foldOrigenText(o) !== foldOrigenText(current);
  });
  if (!siblings.length) return null;
  siblings.sort((a, b) => {
    const d =
      origenCurrencyRank(String(b.origen ?? "")) -
      origenCurrencyRank(String(a.origen ?? ""));
    if (d !== 0) return d;
    return rowTimestamp(b) - rowTimestamp(a);
  });
  return String(siblings[0]?.origen ?? "").trim() || null;
}

/** Valor a mostrar en columna Origen (fuente de datos, no solo el conteo). */
export function displayOrigenLabel(
  product: InventarioRow,
  catalog: InventarioRow[] = [],
): string {
  const current = String(product.origen ?? "").trim();
  const fold = foldOrigenText(current);
  const fuente = resolveFuenteOrigen(product, catalog);
  if (fuente) return fuente;
  // Orígenes de archivo se muestran tal cual (csv 1, xlsx 2…).
  if (/^(xlsx|xls|csv)\s*\d+$/.test(fold)) return current;
  if (fold === "nuevo registro" || fold === "nuevo") return ORIGEN_NUEVO_REGISTRO;
  // Conteo Inventario N sin fuente → registro nuevo en ese conteo.
  if (inventarioNumber(current) != null) return ORIGEN_NUEVO_REGISTRO;
  return current || ORIGEN_NUEVO_REGISTRO;
}

/**
 * Elige la fila fuente más actual por etiqueta:
 * Inventario N (mayor) > xlsx/csv N (mayor) > nuevo registro.
 */
export function pickSourceRowsForEtiquetas(
  inventory: InventarioRow[],
  etiquetas: string[],
  destOrigen: string,
): { found: InventarioRow[]; missing: string[]; alreadyInDest: string[] } {
  const destFold = foldOrigenText(destOrigen);
  const byEtq = new Map<string, InventarioRow[]>();
  for (const row of inventory) {
    const et = String(row.etiqueta ?? "").trim().toLowerCase();
    if (!et) continue;
    const bucket = byEtq.get(et) || [];
    bucket.push(row);
    byEtq.set(et, bucket);
  }

  const found: InventarioRow[] = [];
  const missing: string[] = [];
  const alreadyInDest: string[] = [];

  for (const raw of etiquetas) {
    const key = raw.trim().toLowerCase();
    let rows = byEtq.get(key) || [];
    if (!rows.length && /^\d{4,10}$/.test(key)) {
      for (const [et, bucket] of byEtq) {
        const m = et.match(/(\d{4,10})$/);
        if (m && m[1] === key) rows = rows.concat(bucket);
      }
      if (rows.length > 1) {
        const uniq = new Map<string, InventarioRow>();
        for (const r of rows) {
          const id = r.id != null ? `id:${r.id}` : `e:${r.etiqueta}:${r.origen}`;
          uniq.set(id, r);
        }
        rows = [...uniq.values()];
      }
    }
    if (!rows.length) {
      missing.push(raw);
      continue;
    }
    const inDest = rows.filter(
      (r) => foldOrigenText(String(r.origen ?? "")) === destFold,
    );
    const sources = rows.filter(
      (r) => foldOrigenText(String(r.origen ?? "")) !== destFold,
    );
    if (!sources.length) {
      alreadyInDest.push(String(inDest[0]?.etiqueta ?? raw));
      continue;
    }
    sources.sort((a, b) => {
      const d =
        origenCurrencyRank(String(b.origen ?? "")) -
        origenCurrencyRank(String(a.origen ?? ""));
      if (d !== 0) return d;
      return rowTimestamp(b) - rowTimestamp(a);
    });
    found.push(sources[0]);
  }

  return { found, missing, alreadyInDest };
}

export function buildCreateInventarioAskReply(
  name: string,
  existing: string[],
): string {
  const others = existing
    .filter((o) => o !== ORIGEN_SIN_ORIGEN)
    .slice(0, 4)
    .map((o) => `**${o}**`)
    .join(", ");
  return (
    `De acuerdo: preparo **${name}**.\n\n` +
    `¿Qué meto en ese inventario?\n` +
    `• Una o varias **etiquetas** (ej. \`283586\` o \`OF-0026, 264162\`)\n` +
    `• **Todo** un inventario existente` +
    (others ? ` (${others})` : "") +
    `\n` +
    `• O dime **vacío** si solo quieres dejarlo creado sin registros`
  );
}
