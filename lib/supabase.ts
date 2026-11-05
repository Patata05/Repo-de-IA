import { createClient } from "@supabase/supabase-js";

export type InventarioRow = {
  id?: number | null;
  etiqueta?: string | null;
  articulo?: string | null;
  marca?: string | null;
  modelo?: string | null;
  serie?: string | null;
  area?: string | null;
  persona?: string | null;
  cantidad?: number | null;
  observaciones?: string | null;
  estado?: string | null;
  origen?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type NewInventarioItem = {
  etiqueta: string;
  articulo: string;
  marca?: string | null;
  modelo?: string | null;
  serie?: string | null;
  area: string;
  persona?: string | null;
  cantidad?: number | null;
  observaciones?: string | null;
  estado?: string | null;
  origen?: string | null;
};

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

export const supabase =
  supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

export function normalizeEstado(value?: string | null): "Activo" | "Inactivo" {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (v === "inactivo" || v === "baja" || v === "no" || v === "inactive") return "Inactivo";
  return "Activo";
}

function isMissingEstadoColumn(message: string) {
  const msg = message.toLowerCase();
  return msg.includes("estado") && (msg.includes("schema cache") || msg.includes("column"));
}

const ESTADO_COLUMN_HINT =
  "Falta la columna estado en Supabase. Ejecuta Database/add-estado-universidad.sql en el SQL Editor y vuelve a intentar.";

export async function readInventario(): Promise<{ rows: InventarioRow[] }> {
  if (!supabase) {
    return { rows: [] };
  }

  // PostgREST/Supabase limita a 1000 filas por request; hay que paginar.
  const PAGE = 1000;

  try {
    const rows: InventarioRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const to = from + PAGE - 1;
      const { data, error } = await supabase
        .from("inventario")
        .select("*")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to);

      if (error) {
        console.error("Error al leer inventario de Supabase:", error);
        return { rows };
      }

      const chunk = (data as InventarioRow[]) || [];
      rows.push(...chunk);
      if (chunk.length < PAGE) break;
    }

    return { rows };
  } catch (err) {
    console.error("Error en readInventario:", err);
    return { rows: [] };
  }
}

export async function createInventario(
  item: NewInventarioItem
): Promise<{ data: InventarioRow | null; error: string | null }> {
  if (!supabase) {
    return { data: null, error: "El cliente de Supabase no está configurado." };
  }

  try {
    const payload = {
      etiqueta: item.etiqueta.trim(),
      articulo: item.articulo.trim(),
      marca: item.marca?.trim() || null,
      modelo: item.modelo?.trim() || null,
      serie: item.serie?.trim() || null,
      area: item.area.trim(),
      persona: item.persona?.trim() || null,
      cantidad: typeof item.cantidad === "number" && !isNaN(item.cantidad) ? item.cantidad : 1,
      observaciones: item.observaciones?.trim() || null,
      estado: normalizeEstado(item.estado),
      origen: item.origen || "S/O",
    };

    const { data, error } = await supabase
      .from("inventario")
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error("Error al insertar producto en Supabase:", error);
      const msg = error.message || "";
      if (isMissingEstadoColumn(msg)) {
        return { data: null, error: ESTADO_COLUMN_HINT };
      }
      if (msg.includes("inventario_etiqueta_key") || msg.includes("inventario_etiqueta_origen_key")) {
        return {
          data: null,
          error:
            msg.includes("inventario_etiqueta_key")
              ? "La base aún tiene etiqueta única global. Ejecuta Database/allow-serie-duplicates-so.sql en Supabase."
              : `Ya existe la etiqueta "${payload.etiqueta}" en ${payload.origen}. En otro inventario sí se permite.`,
        };
      }
      if (msg.includes("inventario_serie_key") || msg.includes("inventario_serie_origen_key")) {
        return {
          data: null,
          error:
            "La base aún no permite series duplicadas. Ejecuta Database/allow-serie-duplicates-so.sql en Supabase.",
        };
      }
      return { data: null, error: error.message };
    }

    return { data: data as InventarioRow, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error inesperado al guardar.";
    console.error("Error en createInventario:", err);
    return { data: null, error: message };
  }
}

function toInventarioPayload(item: NewInventarioItem) {
  const serieRaw = item.serie?.trim() || "";
  return {
    etiqueta: item.etiqueta.trim(),
    articulo: item.articulo.trim(),
    marca: item.marca?.trim() || null,
    modelo: item.modelo?.trim() || null,
    serie: serieRaw ? serieRaw : null,
    area: item.area.trim() || "Sin asignar",
    persona: item.persona?.trim() || null,
    cantidad:
      typeof item.cantidad === "number" && !isNaN(item.cantidad) ? item.cantidad : 1,
    observaciones: item.observaciones?.trim() || null,
    estado: normalizeEstado(item.estado),
    origen: item.origen || "S/O",
  };
}

function mapImportError(msg: string): string {
  if (isMissingEstadoColumn(msg)) return ESTADO_COLUMN_HINT;
  if (msg.toLowerCase().includes("value too long") || msg.toLowerCase().includes("character varying")) {
    return "Algún texto supera el límite de la base. Ejecuta Database/widen-inventario-text.sql en Supabase y vuelve a importar.";
  }
  if (msg.includes("inventario_etiqueta_key") || msg.includes("inventario_etiqueta_origen_key")) {
    return "Hay etiquetas duplicadas en el mismo origen. La etiqueta solo puede repetirse en otro inventario.";
  }
  if (msg.includes("inventario_serie_key") || msg.includes("inventario_serie_origen_key")) {
    return "La base aún no permite series duplicadas. Ejecuta Database/allow-serie-duplicates-so.sql en Supabase.";
  }
  return msg;
}

export async function createInventarioMany(
  items: NewInventarioItem[]
): Promise<{ data: InventarioRow[]; error: string | null }> {
  if (!supabase) {
    return { data: [], error: "El cliente de Supabase no está configurado." };
  }
  if (!items.length) {
    return { data: [], error: "No hay filas para importar." };
  }

  try {
    const payloads = items.map(toInventarioPayload);
    const { data, error } = await supabase.from("inventario").insert(payloads).select();

    if (!error) {
      return { data: (data as InventarioRow[]) || [], error: null };
    }

    console.error("Error al importar inventario en Supabase:", error);
    const msg = error.message || "";
    const isUnique =
      msg.includes("inventario_etiqueta_key") ||
      msg.includes("inventario_etiqueta_origen_key") ||
      msg.includes("inventario_serie_key") ||
      msg.includes("inventario_serie_origen_key") ||
      msg.toLowerCase().includes("duplicate");

    // Si el lote choca por únicos, insertar uno a uno y quedarnos con los válidos
    if (isUnique) {
      const saved: InventarioRow[] = [];
      const failed: string[] = [];
      for (const payload of payloads) {
        const one = await supabase.from("inventario").insert([payload]).select().single();
        if (one.error || !one.data) {
          const detail = payload.serie
            ? `${payload.etiqueta} / serie ${payload.serie}`
            : payload.etiqueta;
          if (failed.length < 10) failed.push(detail);
          continue;
        }
        saved.push(one.data as InventarioRow);
      }

      if (saved.length) {
        return { data: saved, error: null };
      }

      return {
        data: [],
        error:
          failed.length > 0
            ? `No se pudo importar. Conflictos en: ${failed.join(", ")}`
            : mapImportError(msg),
      };
    }

    return { data: [], error: mapImportError(msg) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error inesperado al importar.";
    console.error("Error en createInventarioMany:", err);
    return { data: [], error: message };
  }
}

export async function updateInventario(
  id: number,
  item: Partial<NewInventarioItem>
): Promise<{ data: InventarioRow | null; error: string | null }> {
  if (!supabase) {
    return { data: null, error: "El cliente de Supabase no está configurado." };
  }

  try {
    const payload: Record<string, unknown> = {};
    if (item.etiqueta !== undefined) payload.etiqueta = item.etiqueta.trim();
    if (item.articulo !== undefined) payload.articulo = item.articulo.trim();
    if (item.marca !== undefined) payload.marca = item.marca?.trim() || null;
    if (item.modelo !== undefined) payload.modelo = item.modelo?.trim() || null;
    if (item.serie !== undefined) payload.serie = item.serie?.trim() || null;
    if (item.area !== undefined) payload.area = item.area.trim();
    if (item.persona !== undefined) payload.persona = item.persona?.trim() || null;
    if (item.cantidad !== undefined) {
      payload.cantidad = typeof item.cantidad === "number" && !isNaN(item.cantidad) ? item.cantidad : 1;
    }
    if (item.observaciones !== undefined) payload.observaciones = item.observaciones?.trim() || null;
    if (item.estado !== undefined) payload.estado = normalizeEstado(item.estado);
    if (item.origen !== undefined) payload.origen = item.origen || "S/O";

    const { data, error } = await supabase
      .from("inventario")
      .update(payload)
      .eq("id", id)
      .select()
      .maybeSingle();

    if (error) {
      console.error("Error al actualizar producto en Supabase:", error);
      return {
        data: null,
        error: isMissingEstadoColumn(error.message || "") ? ESTADO_COLUMN_HINT : error.message,
      };
    }

    if (!data) {
      return {
        data: null,
        error:
          "No se pudo actualizar el artículo. Falta permiso de escritura en Supabase (política RLS de UPDATE para anon).",
      };
    }

    return { data: data as InventarioRow, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error inesperado al actualizar.";
    console.error("Error en updateInventario:", err);
    return { data: null, error: message };
  }
}

export async function deleteInventario(
  id: number
): Promise<{ success: boolean; error: string | null }> {
  if (!supabase) {
    return { success: false, error: "El cliente de Supabase no está configurado." };
  }

  const numericId = Number(id);
  if (!Number.isFinite(numericId)) {
    return { success: false, error: "Identificador de artículo inválido." };
  }

  try {
    const { data, error } = await supabase
      .from("inventario")
      .delete()
      .eq("id", numericId)
      .select("id");

    if (error) {
      console.error("Error al eliminar producto en Supabase:", error);
      return { success: false, error: error.message };
    }

    if (!data?.length) {
      return {
        success: false,
        error:
          "No se pudo eliminar el artículo en la base de datos. Revisa las políticas RLS de DELETE.",
      };
    }

    // Confirmación extra: el registro ya no debe existir
    const { data: stillThere } = await supabase
      .from("inventario")
      .select("id")
      .eq("id", numericId)
      .maybeSingle();

    if (stillThere) {
      return {
        success: false,
        error: "El artículo sigue en la base de datos después de intentar eliminarlo.",
      };
    }

    return { success: true, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error inesperado al eliminar.";
    console.error("Error en deleteInventario:", err);
    return { success: false, error: message };
  }
}

export async function deleteInventarioMany(
  ids: number[]
): Promise<{ success: boolean; deletedIds: number[]; error: string | null }> {
  if (!supabase) {
    return { success: false, deletedIds: [], error: "El cliente de Supabase no está configurado." };
  }

  const uniqueIds = [...new Set(ids.map(Number).filter((id) => Number.isFinite(id)))];
  if (!uniqueIds.length) {
    return { success: false, deletedIds: [], error: "No hay artículos válidos para eliminar." };
  }

  try {
    const { data, error } = await supabase
      .from("inventario")
      .delete()
      .in("id", uniqueIds)
      .select("id");

    if (error) {
      console.error("Error al eliminar productos en Supabase:", error);
      return { success: false, deletedIds: [], error: error.message };
    }

    const deletedIds = (data ?? []).map((row) => Number(row.id)).filter(Number.isFinite);
    if (!deletedIds.length) {
      return {
        success: false,
        deletedIds: [],
        error:
          "No se pudo eliminar en la base de datos. Revisa las políticas RLS de DELETE.",
      };
    }

    return { success: true, deletedIds, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error inesperado al eliminar.";
    console.error("Error en deleteInventarioMany:", err);
    return { success: false, deletedIds: [], error: message };
  }
}

export async function restoreInventarioMany(
  rows: InventarioRow[]
): Promise<{ success: boolean; data: InventarioRow[]; error: string | null }> {
  if (!supabase) {
    return { success: false, data: [], error: "El cliente de Supabase no está configurado." };
  }

  if (!rows.length) {
    return { success: false, data: [], error: "No hay artículos para restaurar." };
  }

  const toPayload = (row: InventarioRow, withId: boolean) => {
    const base: Record<string, unknown> = {
      etiqueta: String(row.etiqueta ?? "").trim(),
      articulo: String(row.articulo ?? "").trim(),
      marca: row.marca?.toString().trim() || null,
      modelo: row.modelo?.toString().trim() || null,
      serie: row.serie?.toString().trim() || null,
      area: String(row.area ?? "").trim(),
      persona: row.persona?.toString().trim() || null,
      cantidad:
        typeof row.cantidad === "number" && !Number.isNaN(row.cantidad) ? row.cantidad : 1,
      observaciones: row.observaciones?.toString().trim() || null,
      estado: normalizeEstado(row.estado),
      origen: row.origen || "S/O",
    };
    const id = Number(row.id);
    if (withId && Number.isFinite(id)) base.id = id;
    return base;
  };

  try {
    const withIds = rows.map((row) => toPayload(row, true));
    const { data, error } = await supabase.from("inventario").insert(withIds).select();

    if (error) {
      const withoutIds = rows.map((row) => toPayload(row, false));
      const retry = await supabase.from("inventario").insert(withoutIds).select();
      if (retry.error || !retry.data?.length) {
        console.error("Error al restaurar productos en Supabase:", error, retry.error);
        return {
          data: [],
          success: false,
          error: retry.error?.message || error.message,
        };
      }
      return { success: true, data: retry.data as InventarioRow[], error: null };
    }

    return { success: true, data: (data as InventarioRow[]) || [], error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error inesperado al restaurar.";
    console.error("Error en restoreInventarioMany:", err);
    return { success: false, data: [], error: message };
  }
}
