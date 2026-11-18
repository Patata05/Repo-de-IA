export type ChatApiHistoryItem = {
  role: "user" | "assistant";
  content: string;
};

export type ChatApiItem = {
  id?: number | null;
  etiqueta?: string | null;
  articulo?: string | null;
  marca?: string | null;
  modelo?: string | null;
  serie?: string | null;
  area?: string | null;
  persona?: string | null;
  cantidad?: number | null;
  estado?: string | null;
  origen?: string | null;
  observaciones?: string | null;
};

export type ChatQrPayload = {
  text: string;
  etiqueta?: string | null;
  articulo?: string | null;
  id?: number | null;
  persona?: string | null;
  area?: string | null;
  origen?: string | null;
};

export type ChatTokenUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  token_budget: number;
  limite_contexto?: number;
  provider: string;
  proveedor?: string;
  model: string;
  modelo?: string;
  key_fingerprint: string;
  costo_usd?: number;
  acumulado_sesion?: number;
  rounds?: number;
};

export type ChatModelOption = {
  id: string;
  label: string;
  badge: string;
  provider: string;
  provider_label: string;
  key_fingerprint: string;
  token_budget: number;
  recommended?: boolean;
};

export type ChatHealthLlmInfo = {
  configured?: boolean;
  active_provider?: string;
  active_provider_label?: string;
  active_model?: string;
  default_model?: string;
  preferred_model?: string;
  key_fingerprint?: string;
  token_budget?: number;
  available_models?: ChatModelOption[];
  providers?: Array<{
    name: string;
    label?: string;
    models: string[];
    key_fingerprint?: string;
    token_budget?: number;
  }>;
};

export type ChatAccionSugerida = {
  etiqueta: string;
  prompt_accion: string;
};

/** Métricas del visor de comparación de inventarios. */
export type ChatComparacionVista = {
  titulo?: string;
  general?: boolean;
  origenes?: string[];
  inventarios?: Array<{
    nombre?: string;
    total_articulos?: number;
    activos?: number;
    inactivos?: number;
    total_personas?: number;
    etiquetas_unicas?: number;
    color?: string;
    /** Alias retrocompatibles */
    origen?: string;
    registros?: number;
    personas?: number;
    etiquetas?: number;
  }>;
  comparativa_areas?: Array<{
    area?: string;
    valores?: Record<string, number>;
    totales?: Record<string, number>;
    suma?: number;
  }>;
  resumen_cruces?: {
    etiquetas_compartidas?: number;
    exclusivas_por_inventario?: Record<string, number>;
  };
  cruces?: {
    compartidas?: number;
    solo_en?: Record<string, number>;
  };
  por_area?: Array<{
    area?: string;
    valores?: Record<string, number>;
    totales?: Record<string, number>;
    suma?: number;
  }>;
};

/** Panel derecho activo que ve el usuario (para «de aquí»). */
export type ChatContextoVista = {
  tipo:
    | "persona"
    | "personas"
    | "area"
    | "origen"
    | "areas"
    | "areas_general"
    | "comparacion"
    | "etiquetas"
    | "registros";
  valor: string;
  /** Origen/inventario acotado cuando el filtro es combinado (área ∩ Inventario N). */
  origen?: string;
  ranking?: Array<{
    area?: string;
    articulos?: number;
    personas?: number;
  }>;
  comparacion?: ChatComparacionVista;
  /** true = mostrar solo los items del turno (ej. “dame 8”), sin expandir. */
  lista_limitada?: boolean;
  metricas?: {
    registros?: number;
    personas?: number;
    areas?: number;
    activos?: number;
  };
};

/** Señal BE → abrir modal visual de borrado (preparar_eliminacion_origen). */
export type ChatEliminacionPendiente = {
  origen: string;
  count?: number;
  kind?: string;
  ids?: number[];
};

export type ChatApiResponse = {
  reply?: string;
  error?: string | null;
  used?: string | null;
  items?: ChatApiItem[];
  mutated?: boolean;
  qr?: ChatQrPayload[];
  usage?: ChatTokenUsage | null;
  /** Chips contextuales {etiqueta, prompt_accion} generados en el backend. */
  acciones_sugeridas?: ChatAccionSugerida[];
  /**
   * Sync del panel derecho por turno.
   * null → no tocar el panel (charla).
   * objeto → renderizar esa vista de inmediato.
   */
  contexto_vista?: ChatContextoVista | null;
  /** Alias retrocompatible de contexto_vista. */
  viewer?: ChatContextoVista | null;
  /** true solo tras confirmar_exportacion_excel → FE genera la tarjeta .xlsx. */
  exportar_excel?: boolean;
  /** Si viene, abrir modal de confirmación de borrado (origen + ids). */
  eliminacion_pendiente?: ChatEliminacionPendiente | null;
};

/** Vacío = mismo origen (Next proxy → Backend-ia). */
export function getChatApiBaseUrl() {
  const raw = (process.env.NEXT_PUBLIC_CHAT_API_URL || "").trim();
  // Si apunta al Django directo o no es URL HTTP válida, preferimos el proxy de Next para evitar CORS.
  if (
    !raw ||
    !/^https?:\/\//i.test(raw) ||
    /^https?:\/\/(127\.0\.0\.1|localhost):8000\/?$/i.test(raw)
  ) {
    return "";
  }
  return raw.replace(/\/$/, "");
}

export async function fetchChatHealth(): Promise<ChatHealthLlmInfo | null> {
  const base = getChatApiBaseUrl();
  const url = base ? `${base}/api/health/` : "/api/chat";
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { llm?: ChatHealthLlmInfo };
    return data?.llm ?? null;
  } catch {
    return null;
  }
}

export async function askInventoryChat(
  message: string,
  history: ChatApiHistoryItem[] = [],
  options?: {
    signal?: AbortSignal;
    memory?: string | null;
    model?: string | null;
    /** Id del chat → memoria PydanticAI (messages_json en Supabase). */
    sessionId?: string | null;
    /** Filtro del panel derecho abierto (persona/área/origen). */
    contextoVista?: ChatContextoVista | null;
  },
): Promise<ChatApiResponse> {
  const base = getChatApiBaseUrl();
  // Next proxy: /api/chat | Django directo: .../api/chat/
  const url = base ? `${base}/api/chat/` : "/api/chat";
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        history,
        memory: options?.memory || undefined,
        model: options?.model || undefined,
        session_id: options?.sessionId || undefined,
        contexto_vista: options?.contextoVista || undefined,
      }),
      signal: options?.signal,
    });
  } catch (error) {
    if (
      (error instanceof DOMException && error.name === "AbortError") ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return {
        reply: "",
        error: "aborted",
        items: [],
        mutated: false,
        qr: [],
      };
    }
    const detail = error instanceof Error ? error.message : "red";
    return {
      reply:
        "No pude contactar el chat. Arranca Frontend (`npm run dev`) y Backend-ia (`python manage.py runserver 8000`).",
      error: `fetch_failed:${detail}`,
      items: [],
      mutated: false,
      qr: [],
    };
  }

  let data: ChatApiResponse = {};
  try {
    data = (await response.json()) as ChatApiResponse;
  } catch {
    data = {};
  }

  if (!response.ok) {
    return {
      reply:
        data.reply ||
        data.error ||
        `El servidor de chat respondió ${response.status}. ¿Está corriendo el backend en :8000?`,
      error: data.error || `http_${response.status}`,
      used: data.used,
      items: data.items || [],
      mutated: false,
      qr: [],
      usage: data.usage ?? null,
    };
  }

  const acciones_sugeridas = Array.isArray(data.acciones_sugeridas)
    ? data.acciones_sugeridas
        .map((a) => ({
          etiqueta: String(a?.etiqueta || "").trim(),
          prompt_accion: String(a?.prompt_accion || "").trim(),
        }))
        .filter((a) => a.etiqueta && a.prompt_accion)
        .slice(0, 3)
    : [];

  const parseContexto = (
    raw: ChatApiResponse["contexto_vista"] | ChatApiResponse["viewer"] | unknown,
  ): ChatContextoVista | null | undefined => {
    // undefined = campo ausente; null = charla explícita (no tocar panel).
    if (raw === null) return null;
    if (!raw || typeof raw !== "object") return undefined;
    const rec = raw as Record<string, unknown>;
    const tipo = String(rec.tipo || "").trim().toLowerCase();
    const valor = String(rec.valor || "").trim();
    if (
      !(
        tipo === "persona" ||
        tipo === "personas" ||
        tipo === "area" ||
        tipo === "origen" ||
        tipo === "areas" ||
        tipo === "areas_general" ||
        tipo === "comparacion" ||
        tipo === "etiquetas" ||
        tipo === "registros"
      )
    ) {
      return undefined;
    }
    if (
      (tipo === "persona" ||
        tipo === "personas" ||
        tipo === "area" ||
        tipo === "origen") &&
      !valor
    ) {
      return undefined;
    }
    const ranking = Array.isArray(rec.ranking)
      ? (rec.ranking as ChatContextoVista["ranking"])
      : undefined;
    const comparacion =
      tipo === "comparacion" &&
      rec.comparacion &&
      typeof rec.comparacion === "object"
        ? (rec.comparacion as ChatComparacionVista)
        : undefined;
    const origenExtra = String(rec.origen || "").trim();
    const metricas =
      rec.metricas && typeof rec.metricas === "object"
        ? (rec.metricas as ChatContextoVista["metricas"])
        : undefined;
    return {
      tipo: tipo as ChatContextoVista["tipo"],
      valor: valor || "general",
      origen: origenExtra || undefined,
      ranking,
      comparacion,
      metricas,
      lista_limitada: Boolean(rec.lista_limitada),
    };
  };

  // Preferir contexto_vista; viewer es alias.
  const hasContextoKey = Object.prototype.hasOwnProperty.call(
    data,
    "contexto_vista",
  );
  const contexto_vista = hasContextoKey
    ? parseContexto(data.contexto_vista) ?? null
    : parseContexto(data.viewer) ?? null;
  const viewer = contexto_vista;

  const epRaw = data.eliminacion_pendiente;
  const eliminacion_pendiente: ChatEliminacionPendiente | null =
    epRaw && typeof epRaw === "object" && String(epRaw.origen || "").trim()
      ? {
          origen: String(epRaw.origen || "").trim(),
          count: Number(epRaw.count) || undefined,
          kind: String(epRaw.kind || "").trim() || undefined,
          ids: Array.isArray(epRaw.ids)
            ? epRaw.ids
                .map((x) => Number(x))
                .filter((n) => Number.isFinite(n))
            : undefined,
        }
      : null;

  return {
    reply: data.reply || "Sin respuesta del asistente.",
    error: data.error ?? null,
    used: data.used,
    items: Array.isArray(data.items) ? data.items : [],
    mutated: Boolean(data.mutated),
    qr: Array.isArray(data.qr) ? data.qr.filter((q) => q?.text) : [],
    usage: data.usage ?? null,
    acciones_sugeridas,
    contexto_vista,
    viewer,
    exportar_excel: Boolean(
      (data as { exportar_excel?: boolean }).exportar_excel,
    ),
    eliminacion_pendiente,
  };
}

/** Borra memoria de sesión en Backend-ia (chat_agent_memory). */
export async function resetChatSession(
  sessionId: string,
): Promise<{ ok: boolean; error?: string }> {
  const sid = String(sessionId || "").trim();
  if (!sid) return { ok: false, error: "missing_session" };
  const base = getChatApiBaseUrl();
  const url = base ? `${base}/api/chat/reiniciar/` : "/api/chat/reiniciar";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sid }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (!response.ok) {
      return { ok: false, error: data.error || `http_${response.status}` };
    }
    return { ok: Boolean(data.ok ?? true), error: data.error };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "fetch_failed",
    };
  }
}

/** Pulgar arriba → guarda few-shot en ai_learned_examples (pgvector). */
export async function submitChatLearn(input: {
  vote: "up" | "down";
  preguntaUsuario: string;
  respuestaIdeal: string;
  intencionYFiltros?: string;
  sessionId?: string | null;
}): Promise<{ ok: boolean; saved?: boolean; error?: string }> {
  const base = getChatApiBaseUrl();
  const url = base ? `${base}/api/chat/learn/` : "/api/chat/learn";
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vote: input.vote,
        pregunta_usuario: input.preguntaUsuario,
        respuesta_ideal: input.respuestaIdeal,
        intencion_y_filtros: input.intencionYFiltros || "",
        session_id: input.sessionId || undefined,
      }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      saved?: boolean;
      error?: string;
    };
    if (!response.ok) {
      return { ok: false, error: data.error || `http_${response.status}` };
    }
    return {
      ok: Boolean(data.ok ?? true),
      saved: Boolean(data.saved),
      error: data.error,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "fetch_failed",
    };
  }
}
