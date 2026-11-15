/** Cliente opt-in hacia n8n vía Backend-ia (`/api/chat/n8n`). No reemplaza el chat DeepSeek. */

export type Accion = {
  tipo: "exportar_excel" | "refrescar" | "mostrar_panel" | string;
  origen?: string;
  persona?: string;
  area?: string;
  overview?: string;
  focus?: string;
  limit?: number;
  filtros?: Record<string, string>;
};

export type N8nThreadFocus = {
  persona?: string | null;
  area?: string | null;
  origen?: string | null;
  overview?: string | null;
  focus?: string | null;
};

export type N8nChatContext = {
  threadFocus?: N8nThreadFocus | null;
  lastUser?: string | null;
  threadSummary?: string | null;
};

export type Respuesta = {
  reply: string;
  acciones: Accion[];
  error?: string | null;
};

export async function enviarMensajeN8n(
  message: string,
  conversationId: string,
  options?: { signal?: AbortSignal; context?: N8nChatContext },
): Promise<Respuesta> {
  let r: Response;
  const ctx = options?.context;
  try {
    r = await fetch("/api/chat/n8n", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        conversationId,
        sessionId: conversationId,
        threadFocus: ctx?.threadFocus || null,
        lastUser: ctx?.lastUser || null,
        threadSummary: ctx?.threadSummary || null,
      }),
      cache: "no-store",
      signal: options?.signal,
    });
  } catch (error) {
    if (
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    throw error;
  }
  const data = (await r.json().catch(() => ({}))) as Respuesta & {
    error?: string;
    detail?: string;
  };
  if (!r.ok) {
    throw new Error(
      String(data.error || data.reply || "Error del asistente n8n"),
    );
  }
  return {
    reply: String(data.reply || "").trim(),
    acciones: Array.isArray(data.acciones) ? data.acciones : [],
    error: data.error ?? null,
  };
}

/** Ejecuta acciones declaradas por n8n sin tocar el pipeline DeepSeek. */
export function ejecutarAccion(a: Accion) {
  if (!a || typeof a !== "object") return;
  if (a.tipo === "refrescar") {
    window.dispatchEvent(
      new CustomEvent("inventario:refrescar", { detail: a.origen || null }),
    );
    return;
  }
  if (a.tipo === "exportar_excel") {
    window.dispatchEvent(
      new CustomEvent("inventario:exportar", {
        detail: { origen: a.origen, filtros: a.filtros || {} },
      }),
    );
    return;
  }
  if (a.tipo === "mostrar_panel") {
    window.dispatchEvent(
      new CustomEvent("inventario:mostrar_panel", { detail: a }),
    );
  }
}

export function ejecutarAcciones(acciones?: Accion[] | null) {
  if (!Array.isArray(acciones)) return;
  for (const a of acciones) ejecutarAccion(a);
}

/** Primera acción mostrar_panel (si existe). */
export function pickMostrarPanelAccion(
  acciones?: Accion[] | null,
): Accion | null {
  if (!Array.isArray(acciones)) return null;
  return (
    acciones.find(
      (a) => a && typeof a === "object" && a.tipo === "mostrar_panel",
    ) || null
  );
}
