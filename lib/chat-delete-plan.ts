/**
 * Plan de eliminación (1, N, listado, inventario entero o multi-consulta).
 * El front confirma en 2 pasos: “¿seguro?” → modal → deleteInventarioMany.
 */
import type { InventarioRow } from "@/lib/supabase";
import {
  countWordsEs,
  inventarioNumber,
  listExistingOrigens,
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
  /** Origen destino del borrado (Inventario N), si aplica. */
  origen?: string;
  /** Etiquetas pedidas explícitas (además del listado). */
  etiquetas: string[];
  /** Incluir el listado reciente del chat. */
  includeScopedList: boolean;
  /** Borrar todo el origen. */
  wholeOrigen: boolean;
  /** Vaciar todos los Inventario N / orígenes. */
  wipeAllOrigens?: boolean;
  /** Soft confirm vs modal abierto. */
  phase: "await_yes" | "modal";
  /** Filas resueltas (ids únicos). */
  rows: InventarioRow[];
  askedAt: number;
};

function fold(raw: string): string {
  return normalizeChatSpelling(raw);
}

/** “elimina todos los inventarios / vacía todos los orígenes”. */
export function looksLikeWipeAllInventariosAsk(text: string): boolean {
  const n = fold(text);
  if (!n) return false;
  const verb =
    /\b(elimina|eliminar|elimine|borra|borrar|borre|quita|quitar|vacia|vaciar|limpia|limpiar|suprimir)\b/.test(
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
    /\b(elimina|eliminar|elimine|eliminaras|borra|borrar|borre|quita|quitar|suprimir)\b/.test(
      n,
    );
  if (!verb) return false;
  return (
    /\b(registro|registros|etiqueta|etiquetas|articulo|articulos|equipo|equipos|este|esta|ese|esa|estos|estas|esos|esas|todo|toda|todos|todas|uno|un)\b/.test(
      n,
    ) ||
    /\binventari\w*\s*\d+\b/.test(n) ||
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
  const a = String(row.origen ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  const b = origen
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  if (a === b) return true;
  const na = inventarioNumber(String(row.origen ?? ""));
  const nb = inventarioNumber(origen);
  return na != null && nb != null && na === nb;
}

/** Extrae etiquetas (códigos ≥3 dígitos) pedidas en el texto. */
export function extractDeleteEtiquetas(text: string): string[] {
  const n = fold(text);
  const out: string[] = [];
  const seen = new Set<string>();
  // Evitar el N de “inventario 4” y el de “últimos 10” / “estos 10”.
  const stripped = n
    .replace(/\binventari\w*\s*\d+\b/g, " ")
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

  const nums = [
    ...n.matchAll(/\binventari\w*\s*(\d+)\b/g),
  ].map((m) => Number(m[1]));
  const origenNum = nums.length ? nums[nums.length - 1] : null;
  const origen =
    origenNum != null ? resolveOrigenName(origenNum, existing) : undefined;

  const wholeOrigen =
    Boolean(origen) &&
    (/\b(todo|toda|todos|todas)\s+(el\s+|la\s+)?inventari/.test(n) ||
      /\binventari\w*\s*\d+\s+(completo|entera|entero|completo)\b/.test(n) ||
      /\b(vacia|vaciar|limpia|limpiar)\s+(el\s+)?inventari/.test(n));

  const includeScopedList =
    !wholeOrigen &&
    (/\b(est[oa]s?|esos|esas|este\s+listado|esta\s+consulta|los\s+de\s+arriba|lo\s+de\s+arriba)\b/.test(
      n,
    ) ||
      // Tras ortografía “esos”→“eso”: “eso 10 registros”
      /\beso\s+\d+\s+registros?\b/.test(n) ||
      /\b(ultimos?|recientes?)\s+\d+\b/.test(n) ||
      /\b(est[oa]s?|esos|esas)\s+\d+\s+registros?\b/.test(n));

  const etiquetas = wholeOrigen ? [] : extractDeleteEtiquetas(text);

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
    origen,
    etiquetas,
    includeScopedList,
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

  if (intent.wholeOrigen && intent.origen) {
    for (const row of inventory) {
      if (sameOrigen(row, intent.origen)) add(row);
    }
    return [...byId.values()];
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

export function formatDeleteSoftConfirm(plan: ChatDeletePlan): string {
  const n = plan.rows.length;
  const dest = plan.origen ? ` de **${plan.origen}**` : "";
  const sample = plan.rows
    .slice(0, 3)
    .map((r) => {
      const et = String(r.etiqueta ?? "").trim() || `ID ${r.id}`;
      const art = String(r.articulo ?? "").trim();
      return art ? `**${et}** (${art})` : `**${et}**`;
    })
    .join(", ");
  const qty = countWordsEs(n);

  if (plan.wipeAllOrigens || plan.mode === "whole_all_origens") {
    const origens = [
      ...new Set(
        plan.rows
          .map((r) => String(r.origen ?? "").trim() || "Sin origen")
          .filter(Boolean),
      ),
    ];
    const origenLine =
      origens.length <= 6
        ? origens.map((o) => `**${o}**`).join(", ")
        : `${origens
            .slice(0, 5)
            .map((o) => `**${o}**`)
            .join(", ")} y ${origens.length - 5} más`;
    return (
      `Voy a vaciar **todos los inventarios** (${origenLine}): son **${n.toLocaleString("es-MX")}** registros en total. ` +
      `Ejemplo: ${sample}. ¿Estás seguro? Di **sí** para abrir el aviso de borrado, o **no** para cancelar. ` +
      `Si solo querías uno: «elimina todo el Inventario 5».`
    );
  }

  if (plan.wholeOrigen && plan.origen) {
    const variants = [
      `Voy a eliminar **todo ${plan.origen}**: son ${qty}. Por ejemplo ${sample}. ¿Estás seguro? Responde **sí** para abrir el aviso de borrado, o **no** para cancelar.`,
      `Pediste vaciar **${plan.origen}** (${n.toLocaleString("es-MX")} registros). ¿Seguro? Di **sí** y te muestro el cuadro de confirmación.`,
      `Esto borra ${qty} de **${plan.origen}**. ¿Confirmas? Con **sí** abro el aviso; con **no** lo dejo igual.`,
    ];
    return variants[n % variants.length];
  }

  if (n === 1) {
    return (
      `Voy a eliminar ${sample}${dest}. ¿Estás seguro? Di **sí** para abrir el aviso de borrado, o **no** para cancelar.`
    );
  }

  const variants = [
    `Voy a eliminar ${qty}${dest}. Empiezan con ${sample}. ¿Estás seguro? Responde **sí** para abrir el aviso, o **no** para dejarlas.`,
    `Serían ${qty}${dest} (ej. ${sample}). ¿Confirmas el borrado? Di **sí** y te muestro el cuadro, o **no** para cancelar.`,
    `Entendí borrar ${qty}${dest}. ¿Seguro? Con **sí** abro la confirmación; con **no** no toco nada.`,
  ];
  return variants[(n + (plan.etiquetas.length || 0)) % variants.length];
}

export function formatDeleteModalPrompt(plan: ChatDeletePlan): string {
  const n = plan.rows.length;
  const dest = plan.origen ? ` en **${plan.origen}**` : "";
  if (n === 1) {
    const et = String(plan.rows[0]?.etiqueta ?? "").trim() || "el registro";
    return `Perfecto. Abro el aviso para eliminar **${et}**${dest}. Confirma con **Borrar** o **Cancelar**.`;
  }
  if (plan.wholeOrigen && plan.origen) {
    return `De acuerdo. Abro el aviso para eliminar **todo ${plan.origen}** (${n.toLocaleString("es-MX")} registros). Confirma con **Borrar** o **Cancelar**.`;
  }
  return `De acuerdo. Abro el aviso para eliminar **${n.toLocaleString("es-MX")}** registros${dest}. Confirma con **Borrar** o **Cancelar**.`;
}

export function formatDeleteDoneFallback(plan: {
  rows: InventarioRow[];
  origen?: string;
  wholeOrigen?: boolean;
  deletedCount: number;
}): string {
  const n = plan.deletedCount;
  const dest = plan.origen ? ` de **${plan.origen}**` : " del inventario";
  const qty = countWordsEs(n);
  if (plan.wholeOrigen && plan.origen) {
    const variants = [
      `Listo: eliminé todos los registros${dest} (${n.toLocaleString("es-MX")}). ¿Quieres revisar otro inventario o importar de nuevo?`,
      `Hecho: **${plan.origen}** quedó vacío (${n.toLocaleString("es-MX")} borrados). ¿Seguimos con otra consulta?`,
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
