import type { InventarioRow } from "@/lib/supabase";
import { expandSearchTokens } from "@/lib/inventario-synonyms";

function textOf(val: unknown) {
  return String(val ?? "").trim();
}

/** Comparación tipo Excel (sin acentos, minúsculas, puntuación ni espacios de más). */
export function normalizeSearch(value: unknown): string {
  return textOf(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
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
  if (field.includes(prepared.q)) return true;
  const fieldTokens = field.split(" ").filter(Boolean);
  const queryTokens = prepared.q.split(" ").filter(Boolean);
  if (queryTokens.length > 1 && queryTokens.every((tok) => fieldTokens.includes(tok))) {
    return true;
  }
  // Sinónimos: "pc" también encuentra "laptop" / "computadora".
  if (queryTokens.length) {
    const expanded = expandSearchTokens(queryTokens);
    if (expanded.some((tok) => tok !== prepared.q && field.includes(tok))) {
      return true;
    }
    if (
      expanded.length > 1 &&
      queryTokens.every((tok) => {
        const alts = expandSearchTokens([tok]);
        return alts.some((alt) => fieldTokens.includes(alt) || field.includes(alt));
      })
    ) {
      return true;
    }
  }
  return false;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > 4) return 99;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cur = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = cur;
    }
  }
  return row[b.length];
}

function spellingVariants(token: string): string[] {
  const out = new Set<string>([token]);
  const push = (s: string) => {
    if (s) out.add(s);
  };
  push(token.replace(/v/g, "b"));
  push(token.replace(/b/g, "v"));
  push(token.replace(/z/g, "s"));
  push(token.replace(/h/g, ""));
  push(token.replace(/(.)\1+/g, "$1"));
  return [...out];
}

/**
 * Si la búsqueda no dio hits, sugiere área/persona/artículo cercano.
 * "¿quisiste decir…?"
 */
export function suggestDidYouMean(
  rawQuery: string,
  catalog: InventarioRow[],
  limit = 3,
): string[] {
  const prepared = prepareSearch(rawQuery);
  if (!prepared) return [];
  const q = prepared.q;
  if (q.length < 3) return [];

  const candidates = new Set<string>();
  for (const row of catalog) {
    for (const key of ["area", "persona", "articulo", "marca"] as const) {
      const val = textOf(row[key]);
      if (!val) continue;
      const n = normalizeSearch(val);
      if (!n || n.length < 3) continue;
      candidates.add(val.trim());
      for (const part of n.split(" ")) {
        if (part.length >= 3) candidates.add(part);
      }
    }
  }

  const queryVariants = spellingVariants(q);
  const scored: Array<{ label: string; score: number }> = [];
  for (const label of candidates) {
    const n = normalizeSearch(label);
    if (!n) continue;
    if (n === q) continue;
    let score = levenshtein(q, n);
    for (const v of queryVariants) {
      score = Math.min(score, levenshtein(v, n));
      if (n.startsWith(v) && v.length >= 3) score = Math.min(score, 1);
    }
    if (n.includes(q) || q.includes(n)) score = Math.min(score, 1);
    const maxLen = Math.max(q.length, n.length);
    if (score > 4 || score / maxLen > 0.5) continue;
    scored.push({ label, score });
  }
  scored.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label, "es"));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of scored) {
    const key = normalizeSearch(item.label);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item.label);
    if (out.length >= limit) break;
  }
  return out;
}

export function formatDidYouMeanReply(query: string, suggestions: string[]): string {
  if (!suggestions.length) {
    return `No encontré coincidencias para “${query.trim()}”. Prueba con otra palabra o un área/persona concreta.`;
  }
  if (suggestions.length === 1) {
    return (
      `No encontré “${query.trim()}”. ¿Te referías a **${suggestions[0]}**? ` +
      `Responde **sí** o escribe el nombre correcto.`
    );
  }
  const list = suggestions
    .map((s, i) => `**${i + 1}. ${s}**`)
    .join(", ");
  return (
    `No encontré “${query.trim()}”. ¿Quisiste decir ${list}? ` +
    `Dime el número, el nombre, o reformula la búsqueda.`
  );
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
