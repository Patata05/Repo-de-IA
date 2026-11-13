import type { InventarioRow } from "@/lib/supabase";

/**
 * Clasificador de turno del chat de inventario.
 * Separa: muletillas ≠ entidades ≠ acciones.
 * Evita que “perdón”, “por”, etc. disparen personas/áreas.
 */

export type ChatEntityKind = "etiqueta" | "persona" | "area" | "origen";

export type ChatActionKind =
  | "affirm"
  | "deny"
  | "revert"
  | "mutate"
  | "delete"
  | "query_etiqueta"
  | "query_person"
  | "query_area"
  | "query_overview"
  | "query_recent"
  | "qr"
  | "import"
  | "export"
  | "help"
  | "unknown";

export type ChatEntityHit = {
  kind: ChatEntityKind;
  value: string;
  score: number;
  start?: number;
  end?: number;
};

export type ChatTurnAnalysis = {
  raw: string;
  normalized: string;
  discourseOnly: boolean;
  actions: Array<{ kind: ChatActionKind; score: number }>;
  primaryAction: ChatActionKind;
  entities: ChatEntityHit[];
  etiquetas: string[];
  etiquetaPrefix?: string;
  personas: string[];
  areas: string[];
  /** True si el turno es escritura/corrección (no debe abrir rankings). */
  isWriteTurn: boolean;
  /** True si parece consulta de catálogo (persona/área/overview). */
  isCatalogQuery: boolean;
  patches: Array<{ field: string; value: string }>;
};

const DISCOURSE = new Set([
  "perdon",
  "perdona",
  "perdoname",
  "disculpa",
  "disculpe",
  "gracias",
  "ok",
  "okay",
  "vale",
  "bueno",
  "bien",
  "claro",
  "listo",
  "ahora",
  "entonces",
  "osea",
  "o",
  "sea",
  "pues",
  "mira",
  "este",
  "esta",
  "ese",
  "esa",
  "hola",
  "hey",
  "por",
  "favor",
  "favot",
  "te",
  "me",
  "lo",
  "la",
  "le",
  "de",
  "que",
  "dije",
  "dicho",
  "antes",
]);

const MUTATE_CUES =
  /\b(cambia|cambiar|cambialo|cmabialo|actualiza|actualizar|corrige|corregir|crrigelo|modifica|modificar|edita|editar|aplica|aplicar|arregla|arreglar|pon|poner|ponlo|ponla|activa|activar|reactivar)\b/;

const REVERT_CUES =
  /\b(deja|dejar|dejalo|dejala|eja|restaura|restaurar|revierte|revertir|deshaz|deshacer|vuelve|volver|regresa|como\s+antes|como\s+estaba|valor\s+anterior)\b/;

const DELETE_CUES = /\b(elimina|eliminar|borra|borrar|quita|quitar)\b/;
const QR_CUES = /\b(qr|codigo\s+qr|codigos\s+qr)\b/;
const RECENT_CUES =
  /\b(ultimo|ultimos|reciente|recientes|recien|acabo\s+de|se\s+metio)\b/;
const OVERVIEW_CUES =
  /\b(totales?|resumen|dashboard|panorama|ranking|desglose|salud\s+del\s+inventario)\b/;
const PERSON_QUERY_CUES =
  /\b(personas?|quien|quienes|asignad[oa]s?)\b/;
const AREA_QUERY_CUES = /\b(areas?|edificios?|edif)\b/;
const AFFIRM_CUES =
  /^(si|sí|yes|ok|okay|vale|dale|claro|listo|de acuerdo|confirma|confirmo|adelante|hazlo)\b/;
const DENY_CUES = /^(no|nop|nel|cancel[ae]|mejor\s+no)\b/;

function stripDiacritics(s: string) {
  return s.normalize("NFD").replace(/\p{M}/gu, "");
}

/** Normalización ligera: NO “corrige” muletillas a entidades de dominio. */
export function normalizeTurnText(raw: string): string {
  return stripDiacritics(String(raw || "").toLowerCase())
    .replace(/[^a-z0-9\s"“”'«»/_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(n: string): string[] {
  return n.split(/\s+/).filter(Boolean);
}

function isDiscourseToken(tok: string) {
  return DISCOURSE.has(tok);
}

export function extractQuotedValues(raw: string): string[] {
  const out: string[] = [];
  for (const m of String(raw || "").matchAll(/["“«]([^"”»]{3,200})["”»]/g)) {
    out.push(m[1].trim());
  }
  for (const m of String(raw || "").matchAll(/'([^']{3,200})'/g)) {
    out.push(m[1].trim());
  }
  return out;
}

export function extractEtiquetaPrefix(raw: string, n: string): string | undefined {
  // Importante: no capturar “de” en “código de CF” (el grupo debe ser CF).
  const m =
    raw.match(/\b(?:codigo|código|etiqueta|tag|folio)\s+de\s+([A-Za-z]{1,6})\b/i) ||
    raw.match(/\b(?:codigo|código|etiqueta|tag|folio)\s+([A-Za-z]{2,6})\b/i) ||
    n.match(
      /\b(?:empieza(?:n)?\s+con|comienza(?:n)?\s+con|que\s+empieza?\s+con|empiece\s+con)\s+([a-z]{1,6})\b/,
    ) ||
    raw.match(/\b([A-Za-z]{2,4})\s+o\s+que\s+empieza/i) ||
    raw.match(/\bempieza(?:n)?\s+con\s+([A-Za-z]{1,6})\b/i);
  const p = String(m?.[1] || "")
    .trim()
    .toLowerCase();
  if (
    !p ||
    p.length > 6 ||
    DISCOURSE.has(p) ||
    /^(id|area|activo|codigo|etiqueta|folio|tag|de)$/.test(p)
  ) {
    return undefined;
  }
  return p;
}

export function extractEtiquetaCandidates(raw: string): string[] {
  const found = new Set<string>();
  for (const m of String(raw || "").matchAll(
    /\b([A-Za-z]{1,10}[-_/]?[A-Za-z0-9]*\d{2,8}|\d{4,10})\b/g,
  )) {
    found.add(m[1]);
  }
  for (const m of String(raw || "").matchAll(
    /(?:etiqueta|tag|folio|codigo)\s*[:=]?\s*\*{0,2}([A-Za-z0-9/_-]{2,})\*{0,2}/gi,
  )) {
    found.add(m[1]);
  }
  return [...found];
}

function scoreAction(kind: ChatActionKind, score: number) {
  return { kind, score };
}

function inferPatches(raw: string, n: string): Array<{ field: string; value: string }> {
  const patches: Array<{ field: string; value: string }> = [];
  const quoted = extractQuotedValues(raw);
  if (quoted[0]) {
    patches.push({ field: "observaciones", value: quoted[0] });
  }

  if (/\b(inactivo|inactiva|dar\s+de\s+baja|dado\s+de\s+baja)\b/.test(n)) {
    patches.push({ field: "estado", value: "Inactivo" });
  } else if (
    /\b(activo|activa|reactivar|activar)\b/.test(n) &&
    !/\b(cuantos|cuantas|totales?|salud|porcentaje|ranking)\b/.test(n)
  ) {
    patches.push({ field: "estado", value: "Activo" });
  }

  if (
    !quoted[0] &&
    /\b(arreglad|reparad|ya\s+funciona|funciona\s+correct|equipo\s+reparad)\b/.test(n)
  ) {
    patches.push({
      field: "observaciones",
      value: "Equipo reparado, ya funciona correctamente",
    });
  }

  const persona = raw.match(
    /(?:\bpersona\s*[:=]\s*|\basignar(?:lo|la)?\s+a\s+)([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ .]{2,40})/i,
  )?.[1];
  if (persona && !isDiscourseToken(normalizeTurnText(persona).split(" ")[0] || "")) {
    patches.push({ field: "persona", value: persona.trim() });
  }

  const area = raw.match(
    /(?:\barea|\bárea)\s*[:=]\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9][^\n,]{1,40})/i,
  )?.[1];
  if (area) patches.push({ field: "area", value: area.trim() });

  return patches;
}

function matchPeopleAgainstCatalog(
  raw: string,
  n: string,
  peopleNames: string[],
): ChatEntityHit[] {
  const hits: ChatEntityHit[] = [];
  const nPlain = n;
  for (const name of peopleNames) {
    const nn = normalizeTurnText(name);
    if (nn.length < 4) continue;
    // Match solo si el nombre (o 2+ tokens significativos) aparece literal.
    if (nPlain.includes(nn)) {
      hits.push({ kind: "persona", value: name, score: 90 });
      continue;
    }
    const parts = nn.split(" ").filter((t) => t.length > 2 && !isDiscourseToken(t));
    if (parts.length >= 2 && parts.every((p) => nPlain.includes(p))) {
      hits.push({ kind: "persona", value: name, score: 80 });
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

function matchAreasAgainstCatalog(
  n: string,
  areaNames: string[],
): ChatEntityHit[] {
  const hits: ChatEntityHit[] = [];
  for (const name of areaNames) {
    const nn = normalizeTurnText(name);
    if (nn.length < 3) continue;
    if (n.includes(nn)) hits.push({ kind: "area", value: name, score: 85 });
  }
  return hits.sort((a, b) => b.score - a.score);
}

function matchEtiquetasAgainstInventory(
  raw: string,
  inventory: InventarioRow[],
): ChatEntityHit[] {
  const cand = extractEtiquetaCandidates(raw);
  const hits: ChatEntityHit[] = [];
  const byLower = new Map<string, string>();
  for (const row of inventory) {
    const et = String(row.etiqueta ?? "").trim();
    if (et) byLower.set(et.toLowerCase(), et);
  }
  for (const c of cand) {
    const exact = byLower.get(c.toLowerCase());
    if (exact) {
      hits.push({ kind: "etiqueta", value: exact, score: 100 });
      continue;
    }
    // Prefijo-letra + mismo número (CF-0026 vs OF-0026)
    const m = c.match(/^([A-Za-z]{1,6})([-_/]?)(\d{2,8})$/);
    if (m) {
      const suffix = m[3];
      const matches = [...byLower.values()].filter((et) => {
        const em = et.match(/^([A-Za-z]{1,6})([-_/]?)(\d{2,8})$/i);
        return Boolean(em && em[3] === suffix);
      });
      if (matches.length === 1) {
        hits.push({ kind: "etiqueta", value: matches[0], score: 88 });
        continue;
      }
    }
    hits.push({ kind: "etiqueta", value: c, score: 50 });
  }
  // Etiquetas del inventario que aparecen completas en el texto
  const lower = raw.toLowerCase();
  for (const [k, et] of byLower) {
    if (k.length >= 3 && lower.includes(k)) {
      if (!hits.some((h) => h.value.toLowerCase() === k)) {
        hits.push({ kind: "etiqueta", value: et, score: 95 });
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

export type AnalyzeChatTurnInput = {
  text: string;
  inventory: InventarioRow[];
  personNames?: string[];
  areaNames?: string[];
};

/**
 * Algoritmo principal: decide qué es el turno antes de abrir paneles.
 */
export function analyzeChatTurn(input: AnalyzeChatTurnInput): ChatTurnAnalysis {
  const raw = String(input.text || "");
  const normalized = normalizeTurnText(raw);
  const tokens = tokenize(normalized);
  const contentTokens = tokens.filter((t) => !isDiscourseToken(t) && t.length > 1);
  const discourseOnly =
    tokens.length > 0 && contentTokens.length === 0 && !/"|“|«|'/.test(raw);

  const patches = inferPatches(raw, normalized);
  const etiquetaPrefix = extractEtiquetaPrefix(raw, normalized);
  const etiquetaHits = matchEtiquetasAgainstInventory(raw, input.inventory || []);
  const personHits = matchPeopleAgainstCatalog(
    raw,
    normalized,
    input.personNames || [],
  );
  const areaHits = matchAreasAgainstCatalog(normalized, input.areaNames || []);

  const actions: Array<{ kind: ChatActionKind; score: number }> = [];

  if (AFFIRM_CUES.test(normalized)) actions.push(scoreAction("affirm", 95));
  if (DENY_CUES.test(normalized)) actions.push(scoreAction("deny", 95));
  if (REVERT_CUES.test(normalized)) actions.push(scoreAction("revert", 90));
  if (DELETE_CUES.test(normalized)) actions.push(scoreAction("delete", 92));
  if (QR_CUES.test(normalized)) actions.push(scoreAction("qr", 90));
  if (RECENT_CUES.test(normalized)) actions.push(scoreAction("query_recent", 80));
  if (/\b(import|excel|csv|xlsx|sube|cargar)\b/.test(normalized)) {
    actions.push(scoreAction("import", 70));
  }
  if (/\b(excel|exporta|descarga)\b/.test(normalized) && !/\bimport/.test(normalized)) {
    actions.push(scoreAction("export", 65));
  }
  if (
    /\b(ayuda|que puedes|como te uso|ideas?\s+(de\s+)?consultas?)\b/.test(
      normalized,
    )
  ) {
    actions.push(scoreAction("help", 60));
  }

  const mutateScore =
    (MUTATE_CUES.test(normalized) ? 70 : 0) +
    (patches.length ? 40 : 0) +
    (etiquetaHits.length || etiquetaPrefix ? 25 : 0) +
    (extractQuotedValues(raw).length ? 20 : 0);
  if (mutateScore >= 50) actions.push(scoreAction("mutate", mutateScore));

  // Consultas de catálogo: requieren señal explícita, NO muletillas.
  const wantsPersonQuery =
    PERSON_QUERY_CUES.test(normalized) &&
    !REVERT_CUES.test(normalized) &&
    !MUTATE_CUES.test(normalized) &&
    patches.length === 0 &&
    (/\b(dame|muestra|ver|lista|cuant[oa]s|ranking|todas|todos|quien|quienes|busqueda|buscar)\b/.test(
      normalized,
    ) ||
      /\bpor\s+personas?\b/.test(normalized) ||
      personHits.length > 0);
  if (wantsPersonQuery) actions.push(scoreAction("query_person", 75));

  const wantsAreaQuery =
    AREA_QUERY_CUES.test(normalized) &&
    !REVERT_CUES.test(normalized) &&
    !MUTATE_CUES.test(normalized) &&
    patches.length === 0 &&
    (/\b(dame|muestra|ver|lista|cuant[oa]s|ranking|todas|todos|por|equipos?|articulos?)\b/.test(
      normalized,
    ) ||
      /\bpor\s+areas?\b/.test(normalized) ||
      areaHits.length > 0);
  if (wantsAreaQuery) actions.push(scoreAction("query_area", 75));

  if (
    OVERVIEW_CUES.test(normalized) &&
    !REVERT_CUES.test(normalized) &&
    !MUTATE_CUES.test(normalized) &&
    patches.length === 0
  ) {
    actions.push(scoreAction("query_overview", 70));
  }

  if (
    etiquetaHits.length &&
    !MUTATE_CUES.test(normalized) &&
    !REVERT_CUES.test(normalized) &&
    patches.length === 0
  ) {
    actions.push(scoreAction("query_etiqueta", 60));
  }

  actions.sort((a, b) => b.score - a.score);
  let primaryAction: ChatActionKind = actions[0]?.kind || "unknown";

  // Escritura gana sobre catálogo si hay señales mixtas débiles.
  const isWriteTurn =
    primaryAction === "mutate" ||
    primaryAction === "revert" ||
    primaryAction === "delete" ||
    (Boolean(actions.find((a) => a.kind === "mutate" || a.kind === "revert")) &&
      patches.length + etiquetaHits.length > 0);

  if (isWriteTurn && (primaryAction === "query_person" || primaryAction === "query_area" || primaryAction === "query_overview")) {
    primaryAction =
      actions.find((a) => a.kind === "mutate" || a.kind === "revert")?.kind ||
      "mutate";
  }

  if (discourseOnly && primaryAction === "unknown") {
    primaryAction = "help";
  }

  const entities: ChatEntityHit[] = [
    ...etiquetaHits,
    ...personHits,
    ...areaHits,
  ].sort((a, b) => b.score - a.score);

  return {
    raw,
    normalized,
    discourseOnly,
    actions,
    primaryAction,
    entities,
    etiquetas: [...new Set(etiquetaHits.map((h) => h.value))],
    etiquetaPrefix,
    personas: [...new Set(personHits.map((h) => h.value))],
    areas: [...new Set(areaHits.map((h) => h.value))],
    isWriteTurn,
    isCatalogQuery:
      !isWriteTurn &&
      (primaryAction === "query_person" ||
        primaryAction === "query_area" ||
        primaryAction === "query_overview"),
    patches,
  };
}

/** Filas cuyo etiqueta empieza con el prefijo pedido. */
export function rowsByEtiquetaPrefix(
  prefix: string,
  inventory: InventarioRow[],
): InventarioRow[] {
  const p = String(prefix || "")
    .trim()
    .toLowerCase();
  if (!p) return [];
  return inventory.filter((row) =>
    String(row.etiqueta ?? "")
      .trim()
      .toLowerCase()
      .startsWith(p),
  );
}
