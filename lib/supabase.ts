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
  origen?: string | null;
};

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

export const supabase =
  supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

export async function readInventario(): Promise<{ rows: InventarioRow[] }> {
  if (!supabase) {
    return { rows: [] };
  }

  try {
    const { data, error } = await supabase
      .from("inventario")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error al leer inventario de Supabase:", error);
      return { rows: [] };
    }

    return { rows: (data as InventarioRow[]) || [] };
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
      origen: item.origen || "Compra",
    };

    const { data, error } = await supabase
      .from("inventario")
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error("Error al insertar producto en Supabase:", error);
      return { data: null, error: error.message };
    }

    return { data: data as InventarioRow, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error inesperado al guardar.";
    console.error("Error en createInventario:", err);
    return { data: null, error: message };
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
    if (item.origen !== undefined) payload.origen = item.origen || "Compra";

    const { data, error } = await supabase
      .from("inventario")
      .update(payload)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("Error al actualizar producto en Supabase:", error);
      return { data: null, error: error.message };
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

  try {
    const { error } = await supabase
      .from("inventario")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("Error al eliminar producto en Supabase:", error);
      return { success: false, error: error.message };
    }

    return { success: true, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error inesperado al eliminar.";
    console.error("Error en deleteInventario:", err);
    return { success: false, error: message };
  }
}
