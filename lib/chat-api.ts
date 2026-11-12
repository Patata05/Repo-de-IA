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
  provider: string;
  model: string;
  key_fingerprint: string;
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

export type ChatApiResponse = {
  reply?: string;
  error?: string | null;
  used?: string | null;
  items?: ChatApiItem[];
  mutated?: boolean;
  qr?: ChatQrPayload[];
  usage?: ChatTokenUsage | null;
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
  options?: { signal?: AbortSignal; memory?: string | null; model?: string | null },
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

  return {
    reply: data.reply || "Sin respuesta del asistente.",
    error: data.error ?? null,
    used: data.used,
    items: Array.isArray(data.items) ? data.items : [],
    mutated: Boolean(data.mutated),
    qr: Array.isArray(data.qr) ? data.qr.filter((q) => q?.text) : [],
    usage: data.usage ?? null,
  };
}
