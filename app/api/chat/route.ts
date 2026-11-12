import { NextResponse } from "next/server";

export const runtime = "nodejs";

function backendBase() {
  const candidates = [
    process.env.CHAT_BACKEND_URL,
    process.env.NEXT_PUBLIC_CHAT_API_URL,
  ];
  for (const raw of candidates) {
    const trimmed = (raw || "").trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed.replace(/\/$/, "");
    }
  }
  return "http://127.0.0.1:8000";
}

/** GET /api/chat → Estado del proveedor LLM activo, modelo, fingerprint de API key y presupuesto de tokens */
export async function GET() {
  const url = `${backendBase()}/api/health/`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const text = await response.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { ok: false };
    }
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Error de red";
    return NextResponse.json(
      { ok: false, error: `backend_unreachable:${detail}` },
      { status: 502 },
    );
  }
}

/** Proxy al Backend-ia (NVIDIA/Muse/DeepSeek/Groq/Ollama/Gemini) para evitar CORS en el navegador. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  const url = `${backendBase()}/api/chat/`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });

    const text = await response.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text || "Respuesta inválida del backend." };
    }

    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Error de red";
    return NextResponse.json(
      {
        reply:
          "No pude contactar el backend del chat. Arranca Backend-ia (`python manage.py runserver 8000`).",
        error: `backend_unreachable:${detail}`,
        items: [],
        qr: [],
        mutated: false,
      },
      { status: 502 },
    );
  }
}
