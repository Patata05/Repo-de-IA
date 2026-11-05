import type { InventarioRow } from "@/lib/supabase";

function textOf(val: unknown) {
  return String(val ?? "").trim();
}

/** Comparación tipo Excel (sin acentos, minúsculas, espacios colapsados). */
export function normalizeSearch(value: unknown): string {
  return textOf(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type PreparedSearch = {
  raw: string;
  q: string;
  /** Solo si el usuario escribió espacio al final (como Excel "biblioteca "). */
  requireTrailingSpace: boolean;
};

/** Índice liviano: campos ya normalizados (una vez por carga). */
export type RowSearchIndex = {
  row: InventarioRow;
  fields: string[];
};

const SEARCH_KEYS = [
  "etiqueta",
  "articulo",
  "marca",
  "modelo",
  "serie",
  "area",
  "persona",
  "observaciones",
] as const;

export function buildSearchIndex(rows: InventarioRow[]): RowSearchIndex[] {
  return rows.map((row) => ({
    row,
    fields: SEARCH_KEYS.map((key) => normalizeSearch(row[key as keyof InventarioRow])).filter(
      Boolean,
    ),
  }));
}

/**
 * Mín. 3 caracteres. Filtra en TODOS los campos.
 * "biblioteca" → 102 (contiene).
 * "biblioteca " (espacio escrito) → 97 (como Excel).
 */
export function prepareSearch(rawQuery: string): PreparedSearch | null {
  const requireTrailingSpace = /\s$/.test(rawQuery);
  const raw = rawQuery.trim();
  if (raw.length < 3) return null;
  const q = normalizeSearch(raw);
  if (!q) return null;
  return { raw, q, requireTrailingSpace };
}

function fieldMatches(field: string, prepared: PreparedSearch): boolean {
  if (!field) return false;
  if (prepared.requireTrailingSpace) {
    return field.includes(`${prepared.q} `);
  }
  return field.includes(prepared.q);
}

export function indexMatchesPrepared(entry: RowSearchIndex, prepared: PreparedSearch): boolean {
  return entry.fields.some((field) => fieldMatches(field, prepared));
}

export function rowMatchesPrepared(row: InventarioRow, prepared: PreparedSearch): boolean {
  for (const key of SEARCH_KEYS) {
    if (fieldMatches(normalizeSearch(row[key as keyof InventarioRow]), prepared)) return true;
  }
  return false;
}

export function rowMatchesSmartSearch(
  row: InventarioRow,
  rawQuery: string,
  _catalog: InventarioRow[] = [],
): boolean {
  const prepared = prepareSearch(rawQuery);
  if (!prepared) return true;
  return rowMatchesPrepared(row, prepared);
}

export function rowMatchesQuickSearch(row: InventarioRow, rawQuery: string): boolean {
  return rowMatchesSmartSearch(row, rawQuery);
}

export function rowMatchesAreaSearch(row: InventarioRow, rawQuery: string): boolean {
  const prepared = prepareSearch(rawQuery);
  if (!prepared) return true;
  return fieldMatches(normalizeSearch(row.area), prepared);
}

export function rowMatchesPersonaSearch(row: InventarioRow, rawQuery: string): boolean {
  const prepared = prepareSearch(rawQuery);
  if (!prepared) return true;
  return fieldMatches(normalizeSearch(row.persona), {
    ...prepared,
    requireTrailingSpace: false,
  });
}
