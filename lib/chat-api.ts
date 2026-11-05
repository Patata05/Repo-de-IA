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

export type ChatApiResponse = {
  reply?: string;
  error?: string | null;
  used?: string | null;
  items?: ChatApiItem[];
  mutated?: boolean;
  qr?: ChatQrPayload[];
};

/** Vacío = mismo origen (Next proxy → Backend-ia). */
export function getChatApiBaseUrl() {
  const raw = (process.env.NEXT_PUBLIC_CHAT_API_URL || "").trim();
  // Si apunta al Django directo, preferimos el proxy de Next para evitar CORS.
  if (!raw || /^https?:\/\/(127\.0\.0\.1|localhost):8000\/?$/i.test(raw)) {
    return "";
  }
  return raw.replace(/\/$/, "");
}

export async function askInventoryChat(
  message: string,
  history: ChatApiHistoryItem[] = [],
): Promise<ChatApiResponse> {
  const base = getChatApiBaseUrl();
  // Next proxy: /api/chat | Django directo: .../api/chat/
  const url = base ? `${base}/api/chat/` : "/api/chat";
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    });
  } catch (error) {
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
    };
  }

  return {
    reply: data.reply || "Sin respuesta del asistente.",
    error: data.error ?? null,
    used: data.used,
    items: Array.isArray(data.items) ? data.items : [],
    mutated: Boolean(data.mutated),
    qr: Array.isArray(data.qr) ? data.qr.filter((q) => q?.text) : [],
  };
}
