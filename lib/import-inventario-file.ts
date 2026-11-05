import * as XLSX from "xlsx";
import type { NewInventarioItem } from "@/lib/supabase";
import { normalizeEstado } from "@/lib/supabase";

type ColKey =
  | "etiqueta"
  | "articulo"
  | "marca"
  | "modelo"
  | "serie"
  | "estado"
  | "area"
  | "persona"
  | "cantidad"
  | "observaciones";

const HEADER_ALIASES: Record<ColKey, string[]> = {
  etiqueta: ["etiqueta", "etiquetas", "tag", "codigo", "folio"],
  articulo: ["articulo", "producto"],
  marca: ["marca", "brand", "fabricante"],
  modelo: ["modelo", "model"],
  serie: ["serie", "serial", "nserie", "n serie", "numero de serie"],
  estado: ["estado", "status", "estatus"],
  area: [
    "area",
    "areas",
    "ubicacion",
    "localizacion",
    "localidad",
    "edificio",
    "departamento",
    "site",
    "location",
  ],
  persona: [
    "persona",
    "persona asignada",
    "persona asign",
    "responsable",
    "asignado a",
    "asignado",
    "empleado",
    "encargado",
    "resguardante",
  ],
  cantidad: ["cantidad", "cant", "qty", "piezas"],
  observaciones: ["observaciones", "observacion", "notas", "comentarios"],
};

/** Alineado con Database/widen-inventario-text.sql (códigos largos / QR) */
const FIELD_LIMITS = {
  etiqueta: 255,
  articulo: 500,
  marca: 255,
  modelo: 255,
  serie: 255,
  area: 255,
  persona: 255,
} as const;

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function matchCol(header: string): ColKey | null {
  const h = normalizeHeader(header);
  if (!h) return null;
  let best: { key: ColKey; score: number } | null = null;
  for (const key of Object.keys(HEADER_ALIASES) as ColKey[]) {
    const score = headerScore(h, key);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { key, score };
  }
  return best?.key ?? null;
}

/** Mayor = mejor. Exacto > alias; evita cruces área ↔ persona. */
function headerScore(header: string, key: ColKey): number {
  const h = normalizeHeader(header);
  if (!h) return 0;
  const aliases = HEADER_ALIASES[key];
  const keyNorm = normalizeHeader(key);
  if (h === keyNorm || h === `${keyNorm}s`) return 100;

  // No tratar "asignado a" como área ni "ubicacion" como persona
  if (key === "area" && /(persona|responsable|asignado|encargado|empleado)/.test(h)) {
    return 0;
  }
  if (key === "persona" && /(area|ubicacion|localizacion|edificio|departamento)/.test(h)) {
    return 0;
  }

  let best = 0;
  for (let idx = 0; idx < aliases.length; idx++) {
    const alias = normalizeHeader(aliases[idx]);
    if (!alias) continue;
    if (h === alias) {
      best = Math.max(best, 90 - idx);
      continue;
    }
    // Solo contains si el alias tiene suficiente longitud (evita "cant" ruidoso)
    if (alias.length >= 4 && (h.includes(alias) || alias.includes(h))) {
      best = Math.max(best, 70 - idx);
    }
  }
  return best;
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max).trim();
}

function normalizeSerie(raw: string): string | null {
  const value = clip(raw, FIELD_LIMITS.serie).trim();
  if (!value) return null;
  const key = value.toLowerCase().replace(/\s+/g, "");
  if (
    key === "-" ||
    key === "—" ||
    key === "n/a" ||
    key === "na" ||
    key === "s/n" ||
    key === "sn" ||
    key === "null" ||
    key === "none" ||
    key === "sinserie" ||
    key === "noserie"
  ) {
    return null;
  }
  return value;
}

function dedupeItems(items: NewInventarioItem[]): {
  items: NewInventarioItem[];
  skippedDupEtiqueta: number;
} {
  const byEtiqueta = new Set<string>();
  const out: NewInventarioItem[] = [];
  let skippedDupEtiqueta = 0;

  for (const item of items) {
    const etiquetaKey = `${item.origen}::${item.etiqueta.trim().toLowerCase()}`;
    if (byEtiqueta.has(etiquetaKey)) {
      skippedDupEtiqueta += 1;
      continue;
    }
    byEtiqueta.add(etiquetaKey);
    out.push({
      ...item,
      serie: item.serie?.trim() || null,
    });
  }

  return { items: out, skippedDupEtiqueta };
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    // Evitar notación científica y perder ceros (códigos largos de Excel)
    if (Number.isInteger(value) && Math.abs(value) >= 1e15) {
      return value.toLocaleString("fullwide", { useGrouping: false });
    }
    return Number.isInteger(value) ? String(value) : String(value);
  }
  return String(value).trim();
}

function parseCsvText(text: string): unknown[][] {
  const cleaned = text.replace(/^\uFEFF/, "");
  const firstLine = cleaned.split(/\r?\n/).find((line) => line.trim()) || "";
  const delimiter =
    (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    const next = cleaned[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (ch === "\r") continue;
    field += ch;
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function sheetToMatrix(sheet: XLSX.WorkSheet): unknown[][] {
  // raw:false = texto formateado de Excel (conserva ceros y códigos largos)
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  });
}

function findHeader(matrix: unknown[][]): {
  index: number;
  map: Partial<Record<ColKey, number>>;
} | null {
  const limit = Math.min(matrix.length, 40);
  for (let r = 0; r < limit; r++) {
    const row = matrix[r] || [];
    const map: Partial<Record<ColKey, number>> = {};
    const scores: Partial<Record<ColKey, number>> = {};
    row.forEach((cell, c) => {
      const label = cellText(cell);
      const key = matchCol(label);
      if (!key) return;
      const score = headerScore(label, key);
      if (score <= 0) return;
      if (scores[key] === undefined || score > (scores[key] ?? 0)) {
        scores[key] = score;
        map[key] = c;
      }
    });
    if (map.etiqueta !== undefined && map.articulo !== undefined) {
      return { index: r, map };
    }
  }
  return null;
}

function rowsFromMatrix(
  matrix: unknown[][],
  origen: string
): {
  items: NewInventarioItem[];
  skipped: number;
  skippedDupEtiqueta: number;
} {
  const header = findHeader(matrix);
  if (!header) {
    throw new Error(
      "No se encontraron las columnas Etiqueta y Articulo. Revisa que el archivo tenga esos encabezados."
    );
  }

  const rawItems: NewInventarioItem[] = [];
  let skipped = 0;

  for (let r = header.index + 1; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const get = (key: ColKey) => {
      const idx = header.map[key];
      return idx === undefined ? "" : cellText(row[idx]);
    };

    const etiqueta = get("etiqueta");
    const articulo = get("articulo");
    if (!etiqueta && !articulo) {
      skipped += 1;
      continue;
    }
    if (!etiqueta || !articulo) {
      skipped += 1;
      continue;
    }

    const cantidadRaw = get("cantidad");
    const cantidadParsed = Number.parseInt(cantidadRaw.replace(/[^\d-]/g, ""), 10);

    rawItems.push({
      etiqueta: clip(etiqueta, FIELD_LIMITS.etiqueta),
      articulo: clip(articulo, FIELD_LIMITS.articulo),
      marca: clip(get("marca"), FIELD_LIMITS.marca) || null,
      modelo: clip(get("modelo"), FIELD_LIMITS.modelo) || null,
      serie: normalizeSerie(get("serie")),
      area: clip(get("area") || "Sin asignar", FIELD_LIMITS.area),
      persona: clip(get("persona"), FIELD_LIMITS.persona) || null,
      cantidad: Number.isFinite(cantidadParsed) && cantidadParsed > 0 ? cantidadParsed : 1,
      observaciones: get("observaciones") || null,
      estado: normalizeEstado(get("estado") || "Activo"),
      origen,
    });
  }

  const deduped = dedupeItems(rawItems);
  return {
    items: deduped.items,
    skipped,
    skippedDupEtiqueta: deduped.skippedDupEtiqueta,
  };
}

export type ImportInventarioResult = {
  items: NewInventarioItem[];
  skipped: number;
  skippedDupEtiqueta: number;
  sheetName?: string;
};

export async function parseInventarioImportFile(
  file: File,
  origen: string
): Promise<ImportInventarioResult> {
  const name = file.name.toLowerCase();
  const buffer = await file.arrayBuffer();

  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    const text = new TextDecoder("utf-8").decode(buffer);
    const matrix = parseCsvText(text);
    return rowsFromMatrix(matrix, origen);
  }

  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const workbook = XLSX.read(buffer, { type: "array" });
    const preferred =
      workbook.SheetNames.find((n) => normalizeHeader(n).includes("lectura")) ||
      workbook.SheetNames[0];
    if (!preferred) throw new Error("El archivo de Excel no tiene hojas.");
    const sheet = workbook.Sheets[preferred];
    const matrix = sheetToMatrix(sheet);
    const parsed = rowsFromMatrix(matrix, origen);
    return { ...parsed, sheetName: preferred };
  }

  throw new Error("Formato no soportado. Usa CSV o Excel (.xlsx / .xls).");
}
