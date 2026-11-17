/**
 * Planificador de multipeticiones en un solo mensaje.
 * Ej.: “mete todo Inventario 2 a Inventario 3 y si ya existe omítela”.
 *
 * No depende del LLM: descompone en pasos locales ejecutables.
 */
import {
  detectBulkCopyBetweenInventariosAsk,
  detectMultiSourceCopyToInventarioAsk,
} from "@/lib/inventario-origen";
import { looksLikeTransferVerb, normalizeChatSpelling } from "@/lib/chat-spell";

export type ChatPlanStep =
  | {
      kind: "bulk_copy";
      source: string;
      dest: string;
      /** Saltar las que ya están en destino (siempre true en este flujo). */
      skipExisting: boolean;
      /** Etiquetas concretas a omitir además. */
      excludeEtiquetas: string[];
    }
  | { kind: "unknown"; raw: string };

export type ChatMultiPlan = {
  steps: ChatPlanStep[];
  /** Texto efectivo para el primer paso bulk. */
  primaryText: string;
};

function fold(raw: string): string {
  return normalizeChatSpelling(raw);
}

function hasSkipExisting(n: string): boolean {
  return (
    /\b(omite|omitas|omitir|omitala|excluye|excluyas|excluir|salta|saltes|saltar|excepto)\b/.test(
      n,
    ) ||
    /\bsi\s+hay\b/.test(n) ||
    /\bya\s+existe/.test(n) ||
    /\betiqueta\w*\s+del\s+\d+\s+en\s+(el\s+)?\d+\b/.test(n) ||
    /\bfaltantes?\b/.test(n)
  );
}

/**
 * ¿Es una multipetición de copiar entre inventarios (con o sin omitir)?
 */
export function detectInventarioMultiPlan(
  text: string,
  existingOrigens: string[] = [],
): ChatMultiPlan | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const n = fold(raw);

  // Comparar / consultar ≠ copiar (evita “últimos 10 … inventario 4” → Inv10→Inv4).
  if (
    /\bcompara\w*\b/.test(n) ||
    /\b(diff|diferencia|diferencias|versus)\b/.test(n) ||
    /\bvs\b/.test(n)
  ) {
    return null;
  }

  const hasInv =
    /\binventari/.test(n) ||
    /\balnventario\b/.test(n) ||
    /\binvenatrio\b/.test(n);
  if (!hasInv) return null;

  const transfer =
    looksLikeTransferVerb(n) ||
    /\b(mete\w*|meter\w*|pasame|pasalo|pasala|pasalos|pasalas|pasar\w*|pasa|pase|pases|copia\w*|mueve\w*|importa\w*|traslad\w*|traspas\w*|continua\w*|llena\w*|intenta\w*|intentar|hazlo|adelante|prueba\w*|reintenta\w*|aver|otra\s+vez)\b/.test(
      n,
    ) ||
    // “inventario 1 al inventario 3” ya implica copia
    (/\binventari\w*\s*\d+/.test(n) &&
      /\b(a|al|hacia)\s+(?:el\s+)?inventari/.test(n));

  // “registros/etiquetas” solos NO bastan (chocan con comparar / últimos N).
  if (!transfer) return null;

  // Multi-fuente (Inv1+excel1 → Inv2) tiene prioridad.
  const multi = detectMultiSourceCopyToInventarioAsk(raw, existingOrigens);
  if (multi && multi.sources.length) {
    const skipExisting = hasSkipExisting(n) || true;
    const primaryText = `pasa ${multi.sources.join(" y ")} a ${multi.dest}${
      skipExisting ? " omitiendo las que ya existan" : ""
    }`;
    return {
      steps: multi.sources.map((source) => ({
        kind: "bulk_copy" as const,
        source,
        dest: multi.dest,
        skipExisting: Boolean(skipExisting),
        excludeEtiquetas: [] as string[],
      })),
      primaryText,
    };
  }

  // Necesita al menos 2 inventarios o “del 2 al 3”
  let bulk = detectBulkCopyBetweenInventariosAsk(raw, existingOrigens);
  if (!bulk) {
    // Reintentar con verbos normalizados (metieras → mete)
    const patched = n
      .replace(/\bmetieras?\b/g, "mete")
      .replace(/\bmetiendo\b/g, "mete")
      .replace(/\bcontin\w*\b/g, "pasa")
      .replace(/\bomitas?\b/g, "omite")
      .replace(/\bexcluyas?\b/g, "excluye");
    bulk = detectBulkCopyBetweenInventariosAsk(patched, existingOrigens);
  }
  if (!bulk) {
    // “del 2 al 3” / “inventario 2 … inventario 3”
    // Solo números ligados a “inventario N” (no el “10” de “últimos 10”).
    const nums = [
      ...n.matchAll(
        /\b(?:inventari\w*|invenatrio|invetario|alnventario)\s*(\d+)\b/g,
      ),
    ]
      .map((m) => Number(m[1]))
      .filter((x) => Number.isFinite(x) && x > 0);
    // también “del 2 … al 3”
    const delAl = n.match(/\bdel\s+(\d+)\b[\s\S]{0,40}\bal\s+(\d+)\b/);
    if (delAl) {
      nums.unshift(Number(delAl[1]), Number(delAl[2]));
    }
    const uniq = [...new Set(nums)];
    if (uniq.length >= 2) {
      const resolve = (num: number) =>
        existingOrigens.find((o) =>
          new RegExp(`\\binventario\\s*${num}\\b`, "i").test(o),
        ) || `Inventario ${num}`;
      // Con “a/al/hacia” el último es destino (evita invertir por “crea inv 2”).
      const destNum = /\b(?:a|al|hacia)\s+(?:el\s+)?inventari/.test(n)
        ? uniq[uniq.length - 1]
        : uniq[1];
      const srcNum = uniq.find((x) => x !== destNum) ?? uniq[0];
      bulk = {
        source: resolve(srcNum),
        dest: resolve(destNum),
        notifyExisting: true,
      };
    }
  }
  if (!bulk) return null;

  const skipExisting = hasSkipExisting(n) || true; // por defecto no duplicar
  const excludeEtiquetas = [
    ...new Set(
      [...raw.matchAll(/\b(\d{4,12})\b/g)].map((m) => m[1]),
    ),
  ].filter((et) => {
    // No tomar el “2” y “3” de inventarios
    const nEt = Number(et);
    return !(nEt >= 1 && nEt <= 20 && et.length <= 2);
  });

  const primaryText = `pasa todos los registros de ${bulk.source} a ${bulk.dest}${
    skipExisting ? " omitiendo las que ya existan" : ""
  }${
    excludeEtiquetas.length
      ? ` excepto ${excludeEtiquetas.join(", ")}`
      : ""
  }`;

  return {
    steps: [
      {
        kind: "bulk_copy",
        source: bulk.source,
        dest: bulk.dest,
        skipExisting: Boolean(skipExisting),
        excludeEtiquetas,
      },
    ],
    primaryText,
  };
}

/** True si el mensaje es multipetición de inventarios (no anáfora de listado). */
export function looksLikeInventarioMultiAsk(text: string): boolean {
  const n = fold(text);
  if (!n) return false;
  if (/\bcompara\w*\b/.test(n) || /\b(diff|diferencia|versus)\b/.test(n)) {
    return false;
  }
  if (!/\binventari|\binvenatrio|\balnventario/.test(n)) return false;
  // Exige dos “inventario N” (no el “10” de “últimos 10”).
  if (!/\binventari\w*\s*\d+[\s\S]{0,80}\binventari\w*\s*\d+/.test(n)) {
    if (!/\bdel\s+\d+[\s\S]*\bal\s+\d+\b/.test(n)) return false;
  }
  return (
    (/\b(mete\w*|pasa\w*|copia\w*|importa\w*|mueve\w*|continua\w*|intenta\w*|todo|faltantes?|omite\w*|excluy\w*|aver|hazlo)\b/.test(
      n,
    ) ||
      (/\binventari\w*\s*\d+/.test(n) &&
        /\b(a|al|hacia)\s+(?:el\s+)?inventari/.test(n))) &&
    /\b(a|al|hacia)\b/.test(n)
  );
}
