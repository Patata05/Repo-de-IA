/**
 * Plan de eliminación (1, N, listado, inventario entero o multi-consulta).
 * El front confirma en 2 pasos: “¿seguro?” → modal → deleteInventarioMany.
 */
import type { InventarioRow } from "@/lib/supabase";
import {
  canonicalizeOrigenLabel,
  countWordsEs,
  inventarioNumber,
  listExistingOrigens,
  matchOrigenFromPrompt,
  origensMatch,
} from "@/lib/inventario-origen";
import { normalizeChatSpelling } from "@/lib/chat-spell";

export type ChatDeleteMode =
  | "scoped_list"
  | "etiquetas"
  | "whole_origen"
  | "whole_all_origens"
  | "mixed";

export type ChatDeletePlan = {
  mode: ChatDeleteMode;
  /** Origen destino del borrado (Inventario N / excel N), si aplica. */
  origen?: string;
  /** Varios orígenes a vaciar (ej. excel 1 y excel 2). */
  origenes?: string[];
  /** Etiquetas pedidas explícitas (además del listado). */
  etiquetas: string[];
  /** Incluir el listado reciente del chat. */
  includeScopedList: boolean;
  /** Borrar todo el origen (o todos los de origenes). */
  wholeOrigen: boolean;
  /** Vaciar todos los Inventario N / orígenes. */
  wipeAllOrigens?: boolean;
  /** Soft confirm vs modal abierto. */
  phase: "await_yes" | "modal";
  /** Filas resueltas (ids únicos). */
  rows: InventarioRow[];
  askedAt: number;
};

/** Lista canónica de orígenes del plan (1 o N). */
export function planDeleteOrigens(plan: {
  origen?: string;
  origenes?: string[];
}): string[] {
  if (Array.isArray(plan.origenes) && plan.origenes.length) {
    return [
      ...new Set(
        plan.origenes
          .map((o) => canonicalizeOrigenLabel(String(o || "").trim()))
          .filter(Boolean),
      ),
    ];
  }
  const one = String(plan.origen || "").trim();
  return one ? [canonicalizeOrigenLabel(one)] : [];
}

/** “excel 1 y excel 2” / “excel 1 y 2” / “Inventario 1 y 2”. */
export function extractDeleteOrigens(
  text: string,
  existingOrigens: string[] = [],
): string[] {
  const n = fold(text);
  if (!n) return [];
  const existing = existingOrigens.length
    ? existingOrigens
    : listExistingOrigens([]);
  const found: string[] = [];
  const add = (raw: string) => {
    const c = canonicalizeOrigenLabel(String(raw || "").trim());
    if (!c) return;
    if (!found.some((o) => origensMatch(o, c))) found.push(c);
  };
  /** “excel N”: legado si existe; si no → Inventario N. */
  const addFileOrInv = (num: number) => {
    if (!Number.isFinite(num) || num <= 0) return;
    const wantExcel = `excel ${num}`;
    const legacy = existing.find((o) => origensMatch(o, wantExcel));
    if (legacy) {
      add(legacy);
      return;
    }
    add(resolveOrigenName(num, existing));
  };

  // Cadenas: "excel 1 y 2", "excel 1, 2 y 3"
  for (const m of n.matchAll(
    /\b(excel|csv|xls|xlsx)\s*((?:\d+\s*(?:y|,|e|and)\s*)*\d+)\b/g,
  )) {
    for (const num of m[2].matchAll(/\d+/g)) {
      addFileOrInv(Number(num[0]));
    }
  }
  // Explícitos: "excel 1 y excel 2"
  for (const m of n.matchAll(/\b(excel|csv|xls|xlsx)\s*(\d+)\b/g)) {
    addFileOrInv(Number(m[2]));
  }

  // "inventario 1 y 2" / "Inventario 1 y Inventario 2"
  for (const m of n.matchAll(
    /\binventari\w*\s*((?:\d+\s*(?:y|,|e|and)\s*)*\d+)\b/g,
  )) {
    for (const num of m[1].matchAll(/\d+/g)) {
      const value = Number(num[0]);
      if (!Number.isFinite(value) || value <= 0) continue;
      add(resolveOrigenName(value, existing));
    }
  }
  for (const m of n.matchAll(/\binventari\w*\s*(\d+)\b/g)) {
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    add(resolveOrigenName(value, existing));
  }

  // Fallback: un solo origen nombrado por matchOrigenFromPrompt
  if (!found.length) {
    const one = matchOrigenFromPrompt(text, existing);
    if (one) add(one);
  }

  return found;
}

export function formatOrigensListEs(origenes: string[]): string {
  const list = origenes
    .map((o) => canonicalizeOrigenLabel(o))
    .filter(Boolean);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} y ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} y ${list[list.length - 1]}`;
}

function fold(raw: string): string {
  return normalizeChatSpelling(raw);
}

/** “elimina todos los inventarios / todo el inventario / borra todo”. */
export function looksLikeWipeAllInventariosAsk(text: string): boolean {
  const n = fold(text);
  if (!n) return false;
  const verb =
    /\b(elimina|eliminar|elimine|elimines|borra|borrar|borre|quita|quitar|vacia|vaciar|limpia|limpiar|suprimir)\b/.test(
      n,
    );
  if (!verb) return false;
  // “todo Inventario 2” / “todo excel 1” → whole_origen, no wipe global.
  if (
    /\binventari\w*\s*\d+\b/.test(n) ||
    /\b(excel|csv|xls|xlsx)\s*\d+\b/.test(n)
  ) {
    return false;
  }
  return (
    /\b(todos|todas)\s+(los\s+|las\s+)?inventarios?\b/.test(n) ||
    /\b(todos|todas)\s+(los\s+|las\s+)?origenes?\b/.test(n) ||
    /\binventarios?\s+(completos?|enteros?|todos)\b/.test(n) ||
    /\btodo\s+(el\s+)?inventario\b/.test(n) ||
    /\b(elimina|eliminar|borra|borrar|quita|quitar|vacia|vaciar|limpia|limpiar)\s+todo\b/.test(
      n,
    )
  );
}

/**
 * Agradecimiento / cierre casual: NUNCA es intención de borrado ni
 * debe reactivar un plan (p. ej. “gracias” tras borrar una etiqueta).
 */
export function isCasualThanksOrClosingAck(text: string): boolean {
  const n = fold(text);
  if (!n) return true;
  // Si trae verbo de borrado / confirmar borrado → no es solo cortesía.
  if (
    /\b(elimina|eliminar|elimine|borra|borrar|borre|quita|quitar|suprimir|confirmar?\s+(el\s+)?borrado)\b/.test(
      n,
    )
  ) {
    return false;
  }
  if (
    /^(gracias|thanks|thank you|ty|thx|de nada|muchas gracias|mil gracias)([.!\s]*)$/.test(
      n,
    )
  ) {
    return true;
  }
  // “ok gracias”, “listo gracias”, “perfecto muchas gracias”, …
  const toks = n.split(/\s+/).filter(Boolean);
  if (
    toks.length <= 6 &&
    /\b(gracias|thanks|thank you|thx|ty|de nada)\b/.test(n) &&
    !/\b(inventari\w*|excel|csv|xls|xlsx|etiqueta|etiquetas|registro|registros|origen|archivo)\b/.test(
      n,
    )
  ) {
    return true;
  }
  return false;
}

/** “elimina ambos / los dos exceles”. */
export function looksLikeDeleteAmbosAsk(text: string): boolean {
  const n = fold(text);
  if (!n) return false;
  if (isCasualThanksOrClosingAck(text)) return false;
  const verb =
    /\b(elimina|eliminar|elimine|elimines|eliminaras|borra|borrar|borre|quita|quitar|suprimir)\b/.test(
      n,
    );
  if (!verb) return false;
  return /\b(ambos|ambas|los\s+dos|las\s+dos|los\s+2|las\s+2)\b/.test(n);
}

/** “elimínala / bórralo / quítalas” → deixis a etiqueta(s), no al excel entero. */
export function looksLikeDeleteDeixisSingular(text: string): boolean {
  const n = fold(text);
  if (!n) return false;
  return (
    /\b(elimina|borrar?|quita|suprimir)(la|lo|las|los)\b/.test(n) ||
    /\b(elimina|borra|quita)\s+(esta|este|esa|ese|la|lo)\b/.test(n) ||
    /\b(elimina|borra|quita)\s+(esta|este|esa|ese)\s+(etiqueta|registro|articulo|equipo|ficha)\b/.test(
      n,
    )
  );
}

export function looksLikeDeleteInventoryAsk(text: string): boolean {
  const n = fold(text);
  if (!n) return false;
  if (isCasualThanksOrClosingAck(text)) return false;
  if (/\b(chat|busqueda|conversacion|mensaje|historial)\b/.test(n)) {
    return false;
  }
  if (looksLikeWipeAllInventariosAsk(text)) return true;
  if (looksLikeDeleteAmbosAsk(text)) return true;
  if (looksLikeDeleteDeixisSingular(text)) return true;
  const verb =
    /\b(elimina|eliminar|elimine|elimines|eliminaras|borra|borrar|borre|quita|quitar|suprimir)\b/.test(
      n,
    );
  if (!verb) return false;
  return (
    /\b(registro|registros|etiqueta|etiquetas|articulo|articulos|equipo|equipos|este|esta|ese|esa|estos|estas|esos|esas|todo|toda|todos|todas|uno|un)\b/.test(
      n,
    ) ||
    /\binventari\w*\s*\d+\b/.test(n) ||
    /\b(excel|csv|xls|xlsx)\s*\d+\b/.test(n) ||
    /\b\d{3,}\b/.test(n)
  );
}

/** excel/csv N existentes, ordenados por número. */
function listExcelLikeOrigens(existing: string[]): string[] {
  const found: string[] = [];
  for (const o of existing) {
    const c = canonicalizeOrigenLabel(String(o || "").trim());
    if (!c || !/^(?:excel|csv|xls|xlsx)\s*\d+$/i.test(c)) continue;
    if (!found.some((x) => origensMatch(x, c))) found.push(c);
  }
  return found.sort((a, b) => {
    const na = Number(a.match(/\d+/)?.[0] || 0);
    const nb = Number(b.match(/\d+/)?.[0] || 0);
    return na - nb;
  });
}

function resolveOrigenName(
  num: number,
  existing: string[],
): string {
  return (
    existing.find((o) => inventarioNumber(o) === num) || `Inventario ${num}`
  );
}

function sameOrigen(row: InventarioRow, origen: string): boolean {
  return origensMatch(String(row.origen ?? ""), origen);
}

/** Extrae etiquetas (códigos ≥3 dígitos) pedidas en el texto. */
export function extractDeleteEtiquetas(text: string): string[] {
  const n = fold(text);
  const out: string[] = [];
  const seen = new Set<string>();
  // Evitar el N de “inventario 4”, “excel 1” y el de “últimos 10” / “estos 10”.
  const stripped = n
    .replace(/\binventari\w*\s*\d+\b/g, " ")
    .replace(/\b(excel|csv|xls|xlsx)\s*\d+\b/g, " ")
    .replace(/\b(ultimos?|recientes?|estos?|esas?|esos?)\s+\d+\b/g, " ");
  for (const m of stripped.matchAll(/\b(\d{3,12})\b/g)) {
    const et = m[1];
    if (seen.has(et)) continue;
    seen.add(et);
    out.push(et);
  }
  // Formatos alfanuméricos: OF-0026, CF-15, etc.
  for (const m of String(text).matchAll(
    /\b([A-Za-z]{1,6}[-_]?\d{2,8})\b/g,
  )) {
    const et = m[1].trim();
    const key = et.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(et);
  }
  return out;
}

/**
 * Detecta intención de borrado (sin resolver filas aún).
 */
export function detectChatDeleteIntent(
  text: string,
  existingOrigens: string[] = [],
): Omit<ChatDeletePlan, "rows" | "phase" | "askedAt"> | null {
  if (isCasualThanksOrClosingAck(text)) return null;
  if (!looksLikeDeleteInventoryAsk(text)) return null;
  const n = fold(text);
  const existing = existingOrigens.length
    ? existingOrigens
    : listExistingOrigens([]);

  // “elimina todo el inventario / borra todo” ≠ etiqueta previa del panel.
  if (looksLikeWipeAllInventariosAsk(text)) {
    const allOrigens = existing
      .map((o) => canonicalizeOrigenLabel(String(o || "").trim()))
      .filter(Boolean);
    return {
      mode: "whole_all_origens",
      origen: undefined,
      origenes: allOrigens.length ? allOrigens : undefined,
      etiquetas: [],
      includeScopedList: false,
      wholeOrigen: true,
      wipeAllOrigens: true,
    };
  }

  // “esta etiqueta 281405” / “ese registro …” ≠ borrar el listado del panel.
  const deixisSingularItem = /\b(esta|ese|esa|este)\s+(etiqueta|registro|articulo|equipo|codigo|ficha)\b/.test(
    n,
  );

  const includeScopedList =
    !deixisSingularItem &&
    (/\b(est[oa]s?|esos|esas|este\s+listado|esta\s+consulta|los\s+de\s+arriba|lo\s+de\s+arriba)\b/.test(
      n,
    ) ||
      // Tras ortografía “esos”→“eso”: “eso 10 registros”
      /\beso\s+\d+\s+registros?\b/.test(n) ||
      /\b(ultimos?|recientes?)\s+\d+\b/.test(n) ||
      /\b(est[oa]s?|esos|esas)\s+\d+\s+registros?\b/.test(n));

  const etiquetas = extractDeleteEtiquetas(text);

  // Uno o varios: “excel 1 y 2”, “Inventario 1 y Inventario 2”.
  let origenes = extractDeleteOrigens(text, existing);
  // “elimina ambos” → los 2 exceles presentes (o los 2 de menor N).
  if (looksLikeDeleteAmbosAsk(text) && origenes.length < 2) {
    const files = listExcelLikeOrigens(existing);
    if (files.length >= 2) origenes = files.slice(0, 2);
  }
  const origen = origenes[0];

  // “elimínala (del excel 1)” / “borra esa” → NUNCA vaciar el origen entero.
  const deixisSingular =
    looksLikeDeleteDeixisSingular(text) || deixisSingularItem;

  const namedWholeCue =
    origenes.length > 0 &&
    etiquetas.length === 0 &&
    !includeScopedList &&
    !deixisSingular &&
    (/\b(todo|toda|todos|todas|completo|completa|entero|entera)\b/.test(n) ||
      /\b(vacia|vaciar|limpia|limpiar)\b/.test(n) ||
      /\b(el|la)\s+inventari/.test(n) ||
      /\b(el|la)\s+(excel|csv|xls|xlsx)\b/.test(n) ||
      // Solo “excel N” / “inventario N” CON verbo de vaciar el contenedor,
      // no por mencionar el origen junto a “elimínala”.
      (/\b(excel|csv|xls|xlsx|inventari\w*)\s*\d+\b/.test(n) &&
        /\b(todo|toda|completo|completa|entero|entera|vacia|vaciar|limpia|limpiar|archivo|origen)\b/.test(
          n,
        )) ||
      origenes.length >= 2 ||
      looksLikeDeleteAmbosAsk(text));

  const wholeOrigen = namedWholeCue;

  if (!wholeOrigen && !includeScopedList && !etiquetas.length) {
    // “elimina un registro” sin dato → aún así intentamos (caller pide etiqueta)
    if (!/\b(registro|etiqueta|articulo|equipo)\b/.test(n)) return null;
  }

  let mode: ChatDeleteMode = "etiquetas";
  if (wholeOrigen) mode = "whole_origen";
  else if (includeScopedList && etiquetas.length) mode = "mixed";
  else if (includeScopedList) mode = "scoped_list";
  else mode = "etiquetas";

  return {
    mode,
    origen: origen ? canonicalizeOrigenLabel(origen) : origen,
    origenes: wholeOrigen && origenes.length ? origenes : undefined,
    etiquetas: wholeOrigen ? [] : etiquetas,
    includeScopedList: wholeOrigen ? false : includeScopedList,
    wholeOrigen,
    wipeAllOrigens: false,
  };
}

export function resolveChatDeleteRows(opts: {
  intent: Omit<ChatDeletePlan, "rows" | "phase" | "askedAt">;
  inventory: InventarioRow[];
  contextRows: InventarioRow[];
}): InventarioRow[] {
  const { intent, inventory, contextRows } = opts;
  const byId = new Map<number, InventarioRow>();
  const add = (row: InventarioRow | undefined | null) => {
    if (!row?.id || !Number.isFinite(Number(row.id))) return;
    byId.set(Number(row.id), row);
  };

  if (intent.wipeAllOrigens || intent.mode === "whole_all_origens") {
    for (const row of inventory) add(row);
    return [...byId.values()];
  }

  if (intent.wholeOrigen) {
    const targets = planDeleteOrigens(intent);
    if (targets.length) {
      for (const row of inventory) {
        if (targets.some((o) => sameOrigen(row, o))) add(row);
      }
      return [...byId.values()];
    }
  }

  if (intent.includeScopedList) {
    for (const ctx of contextRows) {
      const et = String(ctx.etiqueta ?? "").trim().toLowerCase();
      if (!et) continue;
      if (intent.origen) {
        // Preferir la copia en ese inventario
        const inOrigen = inventory.find(
          (r) =>
            String(r.etiqueta ?? "").trim().toLowerCase() === et &&
            sameOrigen(r, intent.origen!),
        );
        if (inOrigen) {
          add(inOrigen);
          continue;
        }
        // Si el del contexto ya es de ese origen
        if (sameOrigen(ctx, intent.origen)) add(ctx);
      } else {
        // Sin origen: borrar la fila del contexto (o la más reciente por etiqueta)
        const hit =
          inventory.find((r) => Number(r.id) === Number(ctx.id)) ||
          inventory.find(
            (r) => String(r.etiqueta ?? "").trim().toLowerCase() === et,
          ) ||
          ctx;
        add(hit);
      }
    }
  }

  for (const rawEt of intent.etiquetas) {
    const needle = rawEt.trim().toLowerCase();
    if (!needle) continue;
    const candidates = inventory.filter(
      (r) => String(r.etiqueta ?? "").trim().toLowerCase() === needle,
    );
    if (intent.origen) {
      const hit = candidates.find((r) => sameOrigen(r, intent.origen!));
      if (hit) add(hit);
    } else if (candidates.length === 1) {
      add(candidates[0]);
    } else if (candidates.length > 1) {
      // Varias copias: sin origen, no adivinar — skip (caller avisa)
      // Preferir no borrar todas a ciegas; solo si hay una.
    } else {
      // no encontrada
    }
  }

  return [...byId.values()];
}

/** Hechos crudos para compose (la prosa la redacta OpenAI). */
/**
 * Si el agente ya pidió “confirma con sí” para borrar excel/Inventario N,
 * recupera un plan FE para abrir el modal (sin llamar confirmar_eliminacion_origen).
 */
export function recoverDeletePlanFromBotConfirm(
  botText: string,
  inventory: InventarioRow[],
  userText?: string,
): ChatDeletePlan | null {
  // Cortesía del usuario (“gracias”) → nunca reconstruir plan viejo.
  if (userText != null && isCasualThanksOrClosingAck(userText)) return null;
  const raw = String(botText || "").trim();
  if (!raw) return null;
  const n = fold(raw);
  // Éxito / cancelación ya consumidos → no reabrir fantasma.
  if (
    /\b(elimin[eé]|eliminaron|borr[eé]|borraron|cancel[eé]|cancele|cancele\s+el\s+borrado|listo:\s*elimin|se\s+ha\s+realizado|se\s+han\s+realizado|exito|éxito|con\s+exito|con\s+éxito|ya\s+se\s+(elimino|borro)|no\s+toque\s+ningun)\b/.test(
      n,
    )
  ) {
    return null;
  }
  if (
    !/\b(elimina|eliminar|borrado|borrar|eliminacion|eliminaran|eliminaranse)\b/.test(
      n,
    )
  ) {
    return null;
  }
  // Pedido activo de confirmación (sí/no), no “cancela” suelto.
  if (
    !/\b(confirm[aeo]|confirmar|responde?\s+con\s+['\"]?s[ií]|responde?\s+s[ií]|con\s+['\"]?s[ií]|borra\s+o\s+cancelar|borrar\s+o\s+cancelar)\b/.test(
      n,
    )
  ) {
    return null;
  }
  const existing = listExistingOrigens(inventory);
  // Soft-confirm de wipe global (“todo el inventario”).
  // No confundir con “todo Inventario 2”.
  if (
    !/\binventari\w*\s*\d+\b/.test(n) &&
    !/\b(excel|csv|xls|xlsx)\s*\d+\b/.test(n) &&
    (/\bwipe_all\b/.test(n) ||
      /\btodo\s+(el\s+)?inventario\b/.test(n) ||
      /\b(todos|todas)\s+(los\s+|las\s+)?inventarios?\b/.test(n) ||
      /\beliminar?\s+todo\b/.test(n))
  ) {
    if (!inventory.length) return null;
    const allOrigens = existing
      .map((o) => canonicalizeOrigenLabel(String(o || "").trim()))
      .filter(Boolean);
    return {
      mode: "whole_all_origens",
      origen: undefined,
      origenes: allOrigens.length ? allOrigens : undefined,
      etiquetas: [],
      includeScopedList: false,
      wholeOrigen: true,
      wipeAllOrigens: true,
      phase: "await_yes",
      rows: [...inventory],
      askedAt: Date.now(),
    };
  }
  let origenes = extractDeleteOrigens(raw, existing);
  if (origenes.length < 1) {
    // “'excel 1'” / «Inventario 2» en prosa del agente
    for (const m of raw.matchAll(
      /['"«»]?\b((?:excel|csv|xls|xlsx|inventario)\s*\d+)\b['"»]?/gi,
    )) {
      const c = canonicalizeOrigenLabel(m[1]);
      if (c && !origenes.some((o) => origensMatch(o, c))) origenes.push(c);
    }
  }
  if (!origenes.length) return null;
  const rows = inventory.filter((row) =>
    origenes.some((o) => sameOrigen(row, o)),
  );
  if (!rows.length) return null;
  return {
    mode: "whole_origen",
    origen: origenes[0],
    origenes,
    etiquetas: [],
    includeScopedList: false,
    wholeOrigen: true,
    wipeAllOrigens: false,
    phase: "await_yes",
    rows,
    askedAt: Date.now(),
  };
}

export function formatDeleteSoftConfirm(plan: ChatDeletePlan): string {
  const n = plan.rows.length;
  const origenes = planDeleteOrigens(plan);
  const wipeAll =
    Boolean(plan.wipeAllOrigens) || plan.mode === "whole_all_origens";
  const sample = wipeAll
    ? ""
    : plan.rows
        .slice(0, 3)
        .map((r) => {
          const et = String(r.etiqueta ?? "").trim() || `ID ${r.id}`;
          const art = String(r.articulo ?? "").trim();
          return art ? `${et} (${art})` : et;
        })
        .join(", ");
  return [
    `count=${n}`,
    origenes.length ? `origenes=${origenes.join("|")}` : null,
    wipeAll ? "wipe_all=true" : null,
    plan.wholeOrigen ? "whole_origen=true" : null,
    `mode=${plan.mode}`,
    sample ? `sample=${sample}` : null,
    "accion=pedir_confirmacion_borrado_si_no",
    "estilo=prosa_desarrollada_3_a_5_oraciones",
    "explicar=que_se_borra_impacto_y_pedir_si_no",
  ]
    .filter(Boolean)
    .join("; ");
}

export function formatDeleteModalPrompt(plan: ChatDeletePlan): string {
  const n = plan.rows.length;
  const origenes = planDeleteOrigens(plan);
  const origenLabel = formatOrigensListEs(origenes);
  const dest = origenLabel ? ` en **${origenLabel}**` : "";
  if (plan.wipeAllOrigens || plan.mode === "whole_all_origens") {
    return (
      `Perfecto, abrí el aviso final para eliminar **todo el inventario** ` +
      `(**${n.toLocaleString("es-MX")}** registros` +
      `${origenLabel ? ` en ${origenLabel}` : ""}). ` +
      `Si confirmas con **Borrar**, se vaciarán todos los orígenes y el contador quedará en 0; ` +
      `si prefieres no hacerlo, pulsa **Cancelar** y no tocaré nada.`
    );
  }
  if (n === 1) {
    const et = String(plan.rows[0]?.etiqueta ?? "").trim() || "el registro";
    const art = String(plan.rows[0]?.articulo ?? "").trim();
    return (
      `Listo: abrí el aviso para eliminar **${et}**` +
      `${art ? ` (${art})` : ""}${dest}. ` +
      `Revisa el detalle y confirma con **Borrar** si quieres sacarlo del inventario, ` +
      `o **Cancelar** si mejor lo dejamos como está.`
    );
  }
  if (plan.wholeOrigen && origenLabel) {
    return (
      `De acuerdo: abrí el aviso para vaciar **todo ${origenLabel}** ` +
      `(**${n.toLocaleString("es-MX")}** registros). ` +
      `Al confirmar con **Borrar**, esos artículos salen de ese origen; ` +
      `con **Cancelar** dejo todo igual.`
    );
  }
  return (
    `De acuerdo: abrí el aviso para eliminar **${n.toLocaleString("es-MX")}** registros${dest}. ` +
    `Confirma con **Borrar** para aplicar el borrado o **Cancelar** si quieres detenerlo.`
  );
}

export function formatDeleteDoneFallback(plan: {
  rows: InventarioRow[];
  origen?: string;
  origenes?: string[];
  wholeOrigen?: boolean;
  wipeAllOrigens?: boolean;
  mode?: ChatDeleteMode;
  deletedCount: number;
}): string {
  const n = plan.deletedCount;
  const origenes = planDeleteOrigens(plan);
  const origenLabel = formatOrigensListEs(origenes);
  const dest = origenLabel ? ` de **${origenLabel}**` : " del inventario";
  const qty = countWordsEs(n);
  if (plan.wipeAllOrigens || plan.mode === "whole_all_origens") {
    const variants = [
      `Listo: eliminé todo el inventario (**${n.toLocaleString("es-MX")}** registros). Ya no queda ningún artículo en Supabase y el contador está en 0. Si quieres, podemos importar un Excel nuevo o empezar a armar inventarios desde cero.`,
      `Hecho: se borraron todos los inventarios (**${n.toLocaleString("es-MX")}**). La base quedó vacía y limpia. ¿Importamos de nuevo o prefieres crear un Inventario vacío?`,
      `Confirmado: inventario vacío (${qty} eliminados). Todo quedó en cero. Dime si seguimos con una importación o con otra consulta.`,
    ];
    return variants[n % variants.length];
  }
  if (plan.wholeOrigen && origenLabel) {
    const variants = [
      `Listo: eliminé todos los registros${dest} (**${n.toLocaleString("es-MX")}**). Ese origen quedó vacío y el resto del inventario sigue intacto. ¿Revisamos otro inventario o importamos de nuevo?`,
      `Hecho: **${origenLabel}** quedó vacío (**${n.toLocaleString("es-MX")}** borrados). Si quieres, seguimos con otra consulta o con una carga de Excel.`,
      `Confirmado: se eliminaron ${qty}${dest}. ¿Te ayudo a revisar lo que quedó o a crear un inventario nuevo?`,
    ];
    return variants[n % variants.length];
  }
  if (n === 1) {
    const et = String(plan.rows[0]?.etiqueta ?? "").trim() || "el registro";
    const art = String(plan.rows[0]?.articulo ?? "").trim();
    return (
      `Listo: eliminé **${et}**${art ? ` — ${art}` : ""}${dest}. ` +
      `Ya no aparece en el inventario. ¿Quieres revisar otra etiqueta o seguir con otra consulta?`
    );
  }
  const sample = plan.rows
    .slice(0, 2)
    .map((r) => `**${String(r.etiqueta ?? "").trim() || r.id}**`)
    .join(", ");
  const variants = [
    `Listo: eliminé ${qty}${dest}. Entre ellas ${sample}. El inventario ya refleja esos cambios. ¿Otra acción?`,
    `Hecho: se borraron **${n.toLocaleString("es-MX")}** registros${dest}. Si quieres, vemos el inventario actualizado o exportamos un Excel.`,
    `Confirmado: ${qty} ya no están${dest}. ¿Seguimos con otra consulta?`,
  ];
  return variants[n % variants.length];
}
