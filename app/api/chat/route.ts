import { NextResponse } from "next/server";

export const runtime = "nodejs";

function backendBase() {
  return (
    process.env.CHAT_BACKEND_URL ||
    process.env.NEXT_PUBLIC_CHAT_API_URL ||
    "http://127.0.0.1:8000"
  ).replace(/\/$/, "");
}

/** Proxy al Backend-ia (DeepSeek/Groq/Ollama) para evitar CORS en el navegador. */
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
