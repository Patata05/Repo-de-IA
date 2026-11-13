"use server";

import {
  createInventario,
  createInventarioMany,
  updateInventario,
  updateInventarioMany,
  deleteInventario,
  deleteInventarioMany,
  restoreInventarioMany,
  NewInventarioItem,
  InventarioRow,
} from "@/lib/supabase";
import { revalidatePath } from "next/cache";

export async function addInventarioAction(
  item: NewInventarioItem
): Promise<{ success: boolean; data?: InventarioRow; error?: string }> {
  if (!item.etiqueta?.trim()) {
    return { success: false, error: "La etiqueta es obligatoria." };
  }
  if (!item.articulo?.trim()) {
    return { success: false, error: "El nombre del artículo es obligatorio." };
  }
  if (!item.area?.trim()) {
    return { success: false, error: "El área es obligatoria." };
  }

  const { data, error } = await createInventario(item);

  if (error || !data) {
    return {
      success: false,
      error: error || "No se pudo registrar el artículo en la base de datos.",
    };
  }

  revalidatePath("/");
  return { success: true, data };
}

export async function addInventarioBulkAction(
  items: NewInventarioItem[]
): Promise<{ success: boolean; data?: InventarioRow[]; error?: string }> {
  if (!items.length) {
    return { success: false, error: "No hay registros para importar." };
  }

  const normalized = items.map((item) => ({
    ...item,
    etiqueta: item.etiqueta?.trim() || "",
    articulo: item.articulo?.trim() || "",
    area: item.area?.trim() || "Sin asignar",
  }));

  const invalid = normalized.find((item) => !item.etiqueta || !item.articulo);
  if (invalid) {
    return {
      success: false,
      error: "Hay filas sin Etiqueta o Articulo. Completa esas columnas e inténtalo de nuevo.",
    };
  }

  try {
    const { data, error } = await createInventarioMany(normalized);

    if (error || !data?.length) {
      return {
        success: false,
        error: error || "No se pudieron importar los artículos.",
      };
    }

    revalidatePath("/");
    return { success: true, data };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const lower = message.toLowerCase();
    if (lower.includes("fetch failed") || lower.includes("network")) {
      return {
        success: false,
        error:
          "No se pudo conectar a Supabase al importar. Revisa internet, el proyecto en Supabase y Frontend-ia/.env.local; reinicia npm run dev.",
      };
    }
    return {
      success: false,
      error: message || "Error inesperado al importar.",
    };
  }
}

export async function updateInventarioAction(
  id: number,
  item: Partial<NewInventarioItem>
): Promise<{ success: boolean; data?: InventarioRow; error?: string }> {
  if (item.etiqueta !== undefined && !item.etiqueta.trim()) {
    return { success: false, error: "La etiqueta no puede estar vacía." };
  }
  if (item.articulo !== undefined && !item.articulo.trim()) {
    return { success: false, error: "El nombre del artículo no puede estar vacío." };
  }
  if (item.area !== undefined && !item.area.trim()) {
    return { success: false, error: "El área no puede estar vacía." };
  }

  const { data, error } = await updateInventario(id, item);

  if (error || !data) {
    return {
      success: false,
      error: error || "No se pudo actualizar el artículo en la base de datos.",
    };
  }

  revalidatePath("/");
  return { success: true, data };
}

export async function updateInventarioManyAction(
  ids: number[],
  item: Partial<NewInventarioItem>,
): Promise<{ success: boolean; data?: InventarioRow[]; error?: string }> {
  if (!ids.length) {
    return { success: false, error: "No hay registros para actualizar." };
  }
  if (item.etiqueta !== undefined && !item.etiqueta.trim()) {
    return { success: false, error: "La etiqueta no puede estar vacía." };
  }
  if (item.articulo !== undefined && !item.articulo.trim()) {
    return { success: false, error: "El nombre del artículo no puede estar vacío." };
  }
  if (item.area !== undefined && !item.area.trim()) {
    return { success: false, error: "El área no puede estar vacía." };
  }

  const { data, error } = await updateInventarioMany(ids, item);

  if (error || !data.length) {
    return {
      success: false,
      error: error || "No se pudieron actualizar los artículos.",
    };
  }

  revalidatePath("/");
  return { success: true, data };
}

export async function deleteInventarioAction(
  id: number
): Promise<{ success: boolean; error?: string }> {
  const result = await deleteInventario(id);

  if (!result.success) {
    return {
      success: false,
      error: result.error || "No se pudo eliminar el artículo.",
    };
  }

  revalidatePath("/");
  return { success: true };
}

export async function deleteInventarioManyAction(
  ids: number[]
): Promise<{ success: boolean; deletedIds?: number[]; error?: string }> {
  const result = await deleteInventarioMany(ids);

  if (!result.success) {
    return {
      success: false,
      error: result.error || "No se pudieron eliminar los artículos.",
    };
  }

  revalidatePath("/");
  return { success: true, deletedIds: result.deletedIds };
}

export async function restoreInventarioManyAction(
  rows: InventarioRow[]
): Promise<{ success: boolean; data?: InventarioRow[]; error?: string }> {
  const result = await restoreInventarioMany(rows);

  if (!result.success || !result.data.length) {
    return {
      success: false,
      error: result.error || "No se pudieron restaurar los artículos.",
    };
  }

  revalidatePath("/");
  return { success: true, data: result.data };
}
