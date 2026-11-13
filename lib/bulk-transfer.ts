export type BulkTransferField = "persona" | "area";

export type BulkTransferAsk = {
  fromRaw: string | null;
  toRaw: string;
  /** “estos / esa consulta” sin origen explícito. */
  fromContext: boolean;
};

export type PendingBulkTransfer = {
  ids: number[];
  field: BulkTransferField;
  fromLabel: string;
  toValue: string;
  sampleEtiquetas: string[];
};

function fold(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanEndpoint(raw: string): string {
  return String(raw || "")
    .replace(/[?!.,;:]+$/g, "")
    .replace(/^["'«»]+|["'«»]+$/g, "")
    .trim();
}

/**
 * Detecta “mueve todo de Juan a María”, “pasa estos a Biblioteca”, etc.
 * No resuelve catálogo: solo extrae origen/destino crudos.
 */
export function detectBulkTransferAsk(userText: string): BulkTransferAsk | null {
  const raw = String(userText || "").trim();
  if (!raw) return null;
  const n = fold(raw);

  // Import/export de archivos no es traspaso de inventario.
  if (/\b(excel|xlsx|xls|csv|archivo|hoja de calculo)\b/.test(n)) return null;
  if (
    !/\b(mueve|mover|pasa|pasar|traslada|trasladar|transfiere|transferir|reasigna|reasignar)\b/.test(
      n,
    )
  ) {
    return null;
  }

  const fromContext = /\b(estos|estas|esos|esas|este listado|esta consulta|los de arriba|anteriores?)\b/.test(
    n,
  );

  // “… de <origen> a <destino>”
  const deA = raw.match(
    /\bde\s+(.+?)\s+a\s+(.+)$/i,
  );
  if (deA) {
    let fromRaw = cleanEndpoint(deA[1]);
    const toRaw = cleanEndpoint(deA[2]);
    // Quitar “todo/todos/estos” del origen si vinieron pegados.
    fromRaw = fromRaw
      .replace(/^(todo(?:s|as)?|toda|estos|estas|esos|esas)\s+/i, "")
      .trim();
    if (!toRaw) return null;
    return {
      fromRaw: fromRaw || null,
      toRaw,
      fromContext: fromContext || !fromRaw,
    };
  }

  // “… estos/todo a <destino>”
  const aOnly = raw.match(
    /\b(?:estos|estas|esos|esas|todo|todos|todas|toda)\s+a\s+(.+)$/i,
  );
  if (aOnly) {
    const toRaw = cleanEndpoint(aOnly[1]);
    if (!toRaw) return null;
    return { fromRaw: null, toRaw, fromContext: true };
  }

  // Verbo + a <destino> con anáfora (pasa a María / reasigna a …)
  if (fromContext) {
    const tail = raw.match(/\ba\s+(.+)$/i);
    const toRaw = cleanEndpoint(tail?.[1] || "");
    if (!toRaw) return null;
    return { fromRaw: null, toRaw, fromContext: true };
  }

  return null;
}

export function buildBulkTransferConfirmReply(input: {
  field: BulkTransferField;
  fromLabel: string;
  toValue: string;
  count: number;
  sampleEtiquetas: string[];
}): string {
  const fieldLabel = input.field === "persona" ? "persona" : "área";
  const sample =
    input.sampleEtiquetas.length > 0
      ? ` (ej. ${input.sampleEtiquetas.join(", ")}${
          input.count > input.sampleEtiquetas.length ? ", …" : ""
        })`
      : "";
  return (
    `Voy a cambiar **${fieldLabel}** de **${input.fromLabel}** → **${input.toValue}** ` +
    `en **${input.count.toLocaleString("es-MX")}** registro` +
    `${input.count === 1 ? "" : "s"}${sample}.\n\n` +
    `¿Confirmas? Responde **sí** para aplicarlos o **no** para cancelar.`
  );
}

export function buildBulkTransferDoneReply(input: {
  field: BulkTransferField;
  fromLabel: string;
  toValue: string;
  count: number;
}): string {
  const fieldLabel = input.field === "persona" ? "persona" : "área";
  return (
    `Listo: actualicé **${fieldLabel}** de **${input.fromLabel}** → **${input.toValue}** ` +
    `en **${input.count.toLocaleString("es-MX")}** registro` +
    `${input.count === 1 ? "" : "s"}.`
  );
}

export function isNegativeChat(value: string): boolean {
  return /^(no|nop|nah|nel|cancel|cancela|cancelar|mejor no|no gracias)\b/i.test(
    String(value || "").trim(),
  );
}
