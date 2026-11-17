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

  // Cadenas: "excel 1 y 2", "excel 1, 2 y 3"
  for (const m of n.matchAll(
    /\b(excel|csv|xls|xlsx)\s*((?:\d+\s*(?:y|,|e|and)\s*)*\d+)\b/g,
  )) {
    for (const num of m[2].matchAll(/\d+/g)) {
      add(`excel ${Number(num[0])}`);
    }
  }
  // Explícitos: "excel 1 y excel 2"
  for (const m of n.matchAll(/\b(excel|csv|xls|xlsx)\s*(\d+)\b/g)) {
    add(`excel ${Number(m[2])}`);
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

/** “elimina todos los inventarios / vacía todos los orígenes”. */
export function looksLikeWipeAllInventariosAsk(text: string): boolean {
  const n = fold(text);
  if (!n) return false;
  const verb =
    /\b(elimina|eliminar|elimine|elimines|borra|borrar|borre|quita|quitar|vacia|vaciar|limpia|limpiar|suprimir)\b/.test(
      n,
    );
  if (!verb) return false;
  return (
    /\b(todos|todas)\s+(los\s+|las\s+)?inventarios?\b/.test(n) ||
    /\b(todos|todas)\s+(los\s+|las\s+)?origenes?\b/.test(n) ||
    /\binventarios?\s+(completos?|enteros?|todos)\b/.test(n)
  );
}

export function looksLikeDeleteInventoryAsk(text: string): boolean {
  const n = fold(text);
  if (!n) return false;
  if (/\b(chat|busqueda|conversacion|mensaje|historial)\b/.test(n)) {
    return false;
  }
  if (looksLikeWipeAllInventariosAsk(text)) return true;
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
  if (!looksLikeDeleteInventoryAsk(text)) return null;
  const n = fold(text);
  const existing = existingOrigens.length
    ? existingOrigens
    : listExistingOrigens([]);

  // “elimina todos los inventarios” ≠ la etiqueta del panel.
  if (looksLikeWipeAllInventariosAsk(text)) {
    return {
      mode: "whole_all_origens",
      origen: undefined,
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
  const origenes = extractDeleteOrigens(text, existing);
  const origen = origenes[0];

  const namedWholeCue =
    origenes.length > 0 &&
    etiquetas.length === 0 &&
    !includeScopedList &&
    (/\b(todo|toda|todos|todas|completo|completa|entero|entera)\b/.test(n) ||
      /\b(vacia|vaciar|limpia|limpiar)\b/.test(n) ||
      /\b(el|la)\s+inventari/.test(n) ||
      /\b(el|la)\s+(excel|csv|xls|xlsx)\b/.test(n) ||
      /\b(excel|csv|xls|xlsx)\s*\d+\b/.test(n) ||
      /\binventari\w*\s*\d+\b/.test(n) ||
      origenes.length >= 2);

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
export function formatDeleteSoftConfirm(plan: ChatDeletePlan): string {
  const n = plan.rows.length;
  const origenes = planDeleteOrigens(plan);
  const sample = plan.rows
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
    plan.wipeAllOrigens || plan.mode === "whole_all_origens"
      ? "wipe_all=true"
      : null,
    plan.wholeOrigen ? "whole_origen=true" : null,
    `mode=${plan.mode}`,
    sample ? `sample=${sample}` : null,
    "accion=pedir_confirmacion_borrado_si_no",
  ]
    .filter(Boolean)
    .join("; ");
}

export function formatDeleteModalPrompt(plan: ChatDeletePlan): string {
  const n = plan.rows.length;
  const origenes = planDeleteOrigens(plan);
  const origenLabel = formatOrigensListEs(origenes);
  const dest = origenLabel ? ` en **${origenLabel}**` : "";
  if (n === 1) {
    const et = String(plan.rows[0]?.etiqueta ?? "").trim() || "el registro";
    return `Perfecto. Abro el aviso para eliminar **${et}**${dest}. Confirma con **Borrar** o **Cancelar**.`;
  }
  if (plan.wholeOrigen && origenLabel) {
    return `De acuerdo. Abro el aviso para eliminar **todo ${origenLabel}** (${n.toLocaleString("es-MX")} registros). Confirma con **Borrar** o **Cancelar**.`;
  }
  return `De acuerdo. Abro el aviso para eliminar **${n.toLocaleString("es-MX")}** registros${dest}. Confirma con **Borrar** o **Cancelar**.`;
}

export function formatDeleteDoneFallback(plan: {
  rows: InventarioRow[];
  origen?: string;
  origenes?: string[];
  wholeOrigen?: boolean;
  deletedCount: number;
}): string {
  const n = plan.deletedCount;
  const origenes = planDeleteOrigens(plan);
  const origenLabel = formatOrigensListEs(origenes);
  const dest = origenLabel ? ` de **${origenLabel}**` : " del inventario";
  const qty = countWordsEs(n);
  if (plan.wholeOrigen && origenLabel) {
    const variants = [
      `Listo: eliminé todos los registros${dest} (${n.toLocaleString("es-MX")}). ¿Quieres revisar otro inventario o importar de nuevo?`,
      `Hecho: **${origenLabel}** quedó vacío (${n.toLocaleString("es-MX")} borrados). ¿Seguimos con otra consulta?`,
      `Confirmado: se eliminaron ${qty}${dest}. ¿Te ayudo con algo más?`,
    ];
    return variants[n % variants.length];
  }
  if (n === 1) {
    const et = String(plan.rows[0]?.etiqueta ?? "").trim() || "el registro";
    const art = String(plan.rows[0]?.articulo ?? "").trim();
    return `Listo: eliminé **${et}**${art ? ` — ${art}` : ""}${dest}.`;
  }
  const sample = plan.rows
    .slice(0, 2)
    .map((r) => `**${String(r.etiqueta ?? "").trim() || r.id}**`)
    .join(", ");
  const variants = [
    `Listo: eliminé ${qty}${dest}. Entre ellas ${sample}. ¿Otra acción?`,
    `Hecho: se borraron **${n.toLocaleString("es-MX")}** registros${dest}. ¿Quieres ver el inventario actualizado o exportar Excel?`,
    `Confirmado: ${qty} ya no están${dest}. ¿Seguimos con otra consulta?`,
  ];
  return variants[n % variants.length];
}
