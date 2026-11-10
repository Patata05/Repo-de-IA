import type { InventarioRow, NewInventarioItem } from "@/lib/supabase";

/** Opciones QR: corrección L = diseño menos denso/robusto. */
export const INVENTARIO_QR_RENDER = {
  width: 168,
  margin: 1,
  errorCorrectionLevel: "L" as const,
  color: { dark: "#0b1220", light: "#ffffff" },
};

function field(label: string, value: unknown): string | null {
  const v = String(value ?? "").trim();
  if (!v || v === "—" || v.toLowerCase() === "null") return null;
  return `${label}: ${v}`;
}

/**
 * Ficha legible para el QR (al escanear queda completa en portapapeles).
 * Solo incluye campos con valor → menos densidad. Diseño visual: EC nivel L.
 * La app sigue parseando este formato clave: valor.
 */
export function formatInventarioQrText(
  item: Partial<InventarioRow | NewInventarioItem>,
): string {
  const etiqueta = String(item.etiqueta ?? "").trim();
  if (!etiqueta) return "";

  const lines = [
    "INVENTARIO",
    field("Etiqueta", etiqueta),
    field("Artículo", item.articulo),
    field("Marca", item.marca),
    field("Modelo", item.modelo),
    field("Serie", item.serie),
    field("Área", item.area),
    field("Persona", item.persona),
    field(
      "Cantidad",
      item.cantidad != null && item.cantidad !== ""
        ? String(item.cantidad)
        : null,
    ),
    field("Origen", item.origen || "S/O"),
    field("Estado", item.estado),
    field(
      "Observaciones",
      (() => {
        const obs = String(item.observaciones ?? "").trim();
        if (!obs) return null;
        return obs.length > 80 ? `${obs.slice(0, 77)}…` : obs;
      })(),
    ),
  ].filter(Boolean);

  return lines.join("\n");
}

/** Referencia corta (solo etiqueta|origen) si se necesita un payload mínimo. */
export function formatInventarioQrCompact(
  item: Partial<InventarioRow | NewInventarioItem>,
): string {
  const etiqueta = String(item.etiqueta ?? "")
    .trim()
    .replace(/\|/g, "/");
  const origen = String(item.origen ?? "")
    .trim()
    .replace(/\|/g, "/");
  if (!etiqueta) return "";
  return origen ? `INV:${etiqueta}|${origen}` : `INV:${etiqueta}`;
}

type QrFields = Partial<NewInventarioItem>;

function pick(dict: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const val = dict[key];
    if (val != null && String(val).trim()) return String(val).trim();
  }
  return "";
}

/** Acepta INV:…, formato legible viejo y JSON legacy. */
export function parseInventarioQrText(rawText: string): QrFields {
  const trimmed = rawText.trim();
  if (!trimmed) return {};

  // 0) Formato compacto actual: INV:etiqueta|origen
  const compact = trimmed.match(/^INV\s*:\s*([^|\n\r]+)(?:\|([^\n\r]*))?$/i);
  if (compact) {
    return {
      etiqueta: compact[1].trim(),
      origen: (compact[2] || "").trim() || null,
    };
  }

  // 1) JSON legacy (QR antiguos)
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>;
      const cantidadRaw = json.cantidad ?? json.qty;
      return {
        etiqueta: String(
          json.etiqueta || json.tag || json.label || json.code || json.id || "",
        ).trim(),
        articulo: String(
          json.articulo || json.name || json.item || json.producto || "",
        ).trim(),
        marca: String(json.marca || json.brand || "").trim() || null,
        modelo: String(json.modelo || json.model || "").trim() || null,
        serie: String(json.serie || json.serial || json.sn || "").trim() || null,
        area: String(
          json.area || json.departamento || json.ubicacion || "",
        ).trim(),
        persona: String(
          json.persona || json.asignado || json.user || json.owner || "",
        ).trim() || null,
        cantidad:
          typeof cantidadRaw === "number"
            ? cantidadRaw
            : cantidadRaw
              ? parseInt(String(cantidadRaw), 10) || 1
              : 1,
        observaciones: String(
          json.observaciones || json.notes || json.desc || "",
        ).trim() || null,
        estado: String(json.estado || "").trim() || null,
        origen: String(json.origen || "").trim() || null,
      };
    } catch {
      // seguir con formato línea a línea
    }
  }

  // 2) Clave: valor (formato largo anterior)
  const dict: Record<string, string> = {};
  for (const line of trimmed.split(/\r?\n/)) {
    const cleaned = line.replace(/^\uFEFF/, "").trim();
    if (!cleaned || /^inventario$/i.test(cleaned)) continue;
    const separatorIdx = cleaned.search(/[:：]/);
    if (separatorIdx === -1) continue;
    const key = cleaned
      .slice(0, separatorIdx)
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    const val = cleaned.slice(separatorIdx + 1).trim();
    if (key && val) dict[key] = val;
  }

  if (Object.keys(dict).length > 0) {
    const cantidadStr = pick(dict, "cantidad", "qty", "quantity");
    return {
      etiqueta: pick(dict, "etiqueta", "tag", "codigo", "code", "id", "label"),
      articulo: pick(
        dict,
        "articulo",
        "producto",
        "nombre",
        "item",
        "name",
      ),
      marca: pick(dict, "marca", "brand") || null,
      modelo: pick(dict, "modelo", "model") || null,
      serie: pick(dict, "serie", "serial", "sn") || null,
      area: pick(dict, "area", "departamento", "ubicacion") || "",
      persona: pick(dict, "persona", "asignado", "user", "owner") || null,
      cantidad: cantidadStr ? parseInt(cantidadStr, 10) || 1 : 1,
      observaciones: pick(dict, "observaciones", "notas", "notes", "desc") || null,
      estado: pick(dict, "estado", "status") || null,
      origen: pick(dict, "origen", "inventario", "source") || null,
    };
  }

  // 3) Solo número / etiqueta corta
  if (trimmed.length <= 50 && !/\s/.test(trimmed)) {
    return { etiqueta: trimmed };
  }
  return { observaciones: `QR: ${trimmed}` };
}
