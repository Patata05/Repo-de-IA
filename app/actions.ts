"use server";

import {
  createInventario,
  updateInventario,
  deleteInventario,
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
      error: error || "No se pudo registrar el producto en la base de datos.",
    };
  }

  revalidatePath("/");
  return { success: true, data };
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
      error: error || "No se pudo actualizar el producto en la base de datos.",
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
      error: result.error || "No se pudo eliminar el producto.",
    };
  }

  revalidatePath("/");
  return { success: true };
}
