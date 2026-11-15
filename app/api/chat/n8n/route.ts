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

/** Proxy opt-in → Backend-ia /api/chat/n8n/ (no afecta /api/chat/). */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  const url = `${backendBase()}/api/chat/n8n/`;
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
        reply: "No pude contactar el backend n8n.",
        error: `backend_unreachable:${detail}`,
        acciones: [],
      },
      { status: 502 },
    );
  }
}
