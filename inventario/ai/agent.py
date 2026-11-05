from __future__ import annotations

import json
import time

from inventario.ai.client import get_llm_endpoints
from inventario.ai.tools import OPENAI_TOOLS, dump_tool_result, run_tool

SYSTEM_PROMPT = """Eres el asistente de inventario de oficina (español de México).
Eres trabajador y proactivo: das contexto útil y ofreces siguientes pasos claros,
como un buen asistente (estilo Google Gemini), sin inventar datos.

Respondes SOLO con datos reales de las herramientas. NUNCA inventes totales ni redondees a 1000.

Ortografía: el usuario puede escribir mal (ej. "generla", "inventaro", "codigos").
Interpreta la intención más cercana y actúa igual que si estuviera bien escrito.

Consultas:
- "cuántos" / total del inventario → contar_total (una sola tool).
- "cuántos registros tiene [persona]" / "qué tiene [persona]" → UNA sola
  contar_por_campo campo=persona valor="[nombre]" (devuelve total + items
  para el visor). NO llames resumen_inventario ni varias búsquedas.
- Área (ej. Biblioteca) → contar_por_campo campo=area.
- Persona (listar) → buscar_inventario o contar_por_campo campo=persona.
- Listar equipos → buscar_inventario.
- Etiqueta concreta → obtener_por_etiqueta.
- "último registro", "los de hoy", "más recientes" → listar_recientes
  (el último: limit=1; hoy: solo_hoy=true).
- "dame un QR", "código QR de …" → generar_qr (etiqueta, id o ultimo=true).
- Varios QR / códigos de un área/persona
  ("dame 5 QR de Biblioteca", "dame 5 códigos de Biblioteca", "7 de Sistemas")
  → UNA sola generar_qr con query="Biblioteca" (o el texto) y limit=N (máx. 7).
  NO uses solo buscar_inventario ni inventes tablas: sin generar_qr no hay códigos
  en el visor derecho.
- Varios QR ya conocidos ("esos 7", lista de etiquetas/ids) → UNA generar_qr
  con etiquetas=[...] o ids=[...] (máx. 7). NUNCA digas que solo puedes uno.
  En el mensaje di inventario/origen y un resumen claro; el detalle y los QR
  salen en el visor derecho.

Importación Excel/CSV:
- El usuario puede adjuntar el archivo en el chat (lo procesa la app).
- Si preguntan si pueden pasar Excel: dilo claro — que usen el clip 📎
  "Subir archivos" o el botón CSV/Excel en Nuevo artículo.
- En saludos y cierres, ofrece importar Excel/CSV como una opción.

Cambios (actualizar / crear):
- Si piden cambiar datos: primero busca el registro y PROPÓN el cambio.
- NUNCA llames actualizar_campo ni crear_articulo hasta que el usuario confirme
  con sí / confirma / adelante / ok / dale.
- Tras confirmar, aplica UNA tool de escritura y explica el resultado con detalle útil.
- No borres registros.

Estilo de respuesta (importante):
- NO des respuestas telegráficas de una sola línea. Sé claro, amable y con sustancia.
- Explica un poco el resultado (qué significa, qué sigue) y cierra con opciones.
- Preferible una tool útil por ronda (salvo varios QR en una sola generar_qr).
- Detalle tabular / QR / listados largos → visor derecho. En el chat: texto + opciones.
- Para resumen / inventario general / áreas / registros recientes:
  * En el chat: párrafo con los números clave + 2–4 líneas de contexto.
  * Luego ofrece siguientes pasos en viñetas (qué puede hacer ahora).
  * NO pongas tablas markdown ni listados largos de artículos en el chat.

Saludos ("hola", "buenas", etc.) y cuando el usuario no pide un dato concreto:
- Saluda y explica en 1–2 frases qué puedes hacer.
- Ofrece caminos concretos en viñetas, por ejemplo:
  * Consultar inventario general, por área o por persona
  * Ver últimos registros o generar códigos QR
  * Dar de alta / registrar un artículo nuevo (botón "+ Nuevo artículo")
  * Importar un Excel o CSV (clip 📎 o "Subir archivos")
  * Buscar por etiqueta, artículo o estado
- Termina invitando a elegir un camino ("Dime qué prefieres y lo hacemos").

Después de una consulta útil, si cabe, añade 1–3 preguntas/opciones de seguimiento
relacionadas (filtrar, QR, alta, importar), sin sonar repetitivo.
No hables de temas ajenos al inventario.
"""

MAX_TOOL_ROUNDS = 6
MAX_SIDE_ITEMS = 12
MAX_RETRIES_PER_MODEL = 1
RETRY_SLEEP_SEC = (0.4,)


def _collect_items(bucket: list[dict], result: dict) -> None:
    if not isinstance(result, dict) or not result.get("ok"):
        return
    seen = {str(item.get("id")) for item in bucket if item.get("id") is not None}
    raw_items = result.get("items")
    if isinstance(raw_items, list):
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            item_id = item.get("id")
            key = str(item_id) if item_id is not None else None
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            bucket.append(item)
            if len(bucket) >= MAX_SIDE_ITEMS:
                return
    single = result.get("item")
    if isinstance(single, dict):
        item_id = single.get("id")
        key = str(item_id) if item_id is not None else None
        if key and key in seen:
            return
        bucket.append(single)


def _is_retryable(exc: Exception) -> bool:
    text = str(exc).upper()
    return any(
        token in text
        for token in (
            "503",
            "429",
            "UNAVAILABLE",
            "RATE LIMIT",
            "TIMEOUT",
            "TIMED OUT",
            "CONNECTION",
            "CONNECT",
            "GETADDRINFO",
            "NAME OR SERVICE NOT KNOWN",
            "TEMPORARILY",
            "OVERLOADED",
            "REFUSED",
            "10061",
        )
    )


def _is_model_missing(exc: Exception) -> bool:
    text = str(exc).upper()
    return (
        "404" in text
        or "NOT FOUND" in text
        or "DOES NOT EXIST" in text
        or "NOT_FOUND" in text
        or ("MODEL" in text and "INVALID" in text)
    )


def _chat_with_failover(messages: list[dict]):
    endpoints = get_llm_endpoints()
    if not endpoints:
        raise RuntimeError("missing_providers")

    last_error: Exception | None = None
    saw_overload = False

    for endpoint in endpoints:
        for model in endpoint.models:
            for attempt in range(MAX_RETRIES_PER_MODEL):
                try:
                    completion = endpoint.client.chat.completions.create(
                        model=model,
                        messages=messages,
                        tools=OPENAI_TOOLS,
                        tool_choice="auto",
                        temperature=0.2,
                    )
                    label = f"{endpoint.provider}:{model}"
                    return completion, label
                except Exception as exc:  # noqa: BLE001
                    last_error = exc
                    if _is_model_missing(exc):
                        break
                    if _is_retryable(exc):
                        saw_overload = True
                        if attempt < MAX_RETRIES_PER_MODEL - 1:
                            time.sleep(
                                RETRY_SLEEP_SEC[min(attempt, len(RETRY_SLEEP_SEC) - 1)]
                            )
                            continue
                        break
                    break

    assert last_error is not None
    if saw_overload:
        raise RuntimeError(f"llm_unavailable:{last_error}") from last_error
    raise last_error


def _side_items_for_reply(collected: list[dict], qr_payloads: list[dict]) -> list[dict]:
    """Si hay QR, el visor debe listar exactamente esos artículos (no el buscado completo)."""
    if not qr_payloads:
        return collected[:MAX_SIDE_ITEMS]
    by_id = {
        str(item.get("id")): item
        for item in collected
        if item.get("id") is not None
    }
    by_tag = {
        str(item.get("etiqueta") or "").strip().lower(): item
        for item in collected
        if str(item.get("etiqueta") or "").strip()
    }
    out: list[dict] = []
    for qr in qr_payloads:
        key = str(qr.get("id")) if qr.get("id") is not None else None
        tag = str(qr.get("etiqueta") or "").strip().lower()
        item = (by_id.get(key) if key else None) or (by_tag.get(tag) if tag else None)
        if item:
            out.append(item)
        else:
            out.append(
                {
                    "id": qr.get("id"),
                    "etiqueta": qr.get("etiqueta"),
                    "articulo": qr.get("articulo"),
                    "persona": qr.get("persona"),
                    "area": qr.get("area"),
                    "origen": qr.get("origen"),
                }
            )
        if len(out) >= MAX_SIDE_ITEMS:
            break
    return out


def _collect_qr(bucket: list[dict], result: dict) -> None:
    if not isinstance(result, dict) or not result.get("ok"):
        return
    raw_qrs = result.get("qrs")
    if isinstance(raw_qrs, list):
        for entry in raw_qrs:
            if not isinstance(entry, dict):
                continue
            text = entry.get("text") or entry.get("qr_text")
            if not text:
                continue
            item = entry.get("item") if isinstance(entry.get("item"), dict) else entry
            bucket.append(
                {
                    "text": str(text),
                    "etiqueta": item.get("etiqueta"),
                    "articulo": item.get("articulo"),
                    "id": item.get("id"),
                    "persona": item.get("persona"),
                    "area": item.get("area"),
                    "origen": item.get("origen"),
                }
            )
        if raw_qrs:
            return
    qr_text = result.get("qr_text")
    if not qr_text or not result.get("qr"):
        return
    item = result.get("item") if isinstance(result.get("item"), dict) else {}
    bucket.append(
        {
            "text": str(qr_text),
            "etiqueta": item.get("etiqueta"),
            "articulo": item.get("articulo"),
            "id": item.get("id"),
            "persona": item.get("persona"),
            "area": item.get("area"),
            "origen": item.get("origen"),
        }
    )


def run_chat_agent(
    message: str,
    history: list[dict] | None = None,
) -> tuple[str, str | None, str | None, list[dict], bool, list[dict]]:
    endpoints = get_llm_endpoints()
    if not endpoints:
        return (
            "No hay proveedores de IA listos. Configura GROQ_API_KEY y/o GEMINI_API_KEY "
            "y/o instala Ollama (http://127.0.0.1:11434).",
            "missing_key",
            None,
            [],
            False,
            [],
        )

    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for item in history or []:
        role = str(item.get("role") or "").strip().lower()
        text = str(item.get("content") or item.get("text") or "").strip()
        if not text:
            continue
        if role in ("assistant", "bot", "model"):
            messages.append({"role": "assistant", "content": text})
        elif role in ("user", "human"):
            messages.append({"role": "user", "content": text})
    messages.append({"role": "user", "content": message})

    collected: list[dict] = []
    qr_payloads: list[dict] = []
    used_label: str | None = None
    mutated = False

    try:
        for _ in range(MAX_TOOL_ROUNDS):
            completion, used_label = _chat_with_failover(messages)
            choice = completion.choices[0].message
            tool_calls = choice.tool_calls or []

            if not tool_calls:
                text = (choice.content or "").strip()
                side = _side_items_for_reply(collected, qr_payloads)
                if not text:
                    return (
                        "No pude formular una respuesta. Intenta de nuevo.",
                        "empty_text",
                        used_label,
                        side,
                        mutated,
                        qr_payloads,
                    )
                return (
                    text,
                    None,
                    used_label,
                    side,
                    mutated,
                    qr_payloads,
                )

            messages.append(
                {
                    "role": "assistant",
                    "content": choice.content or "",
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.function.name,
                                "arguments": tc.function.arguments or "{}",
                            },
                        }
                        for tc in tool_calls
                    ],
                }
            )

            for tc in tool_calls:
                name = tc.function.name
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                if not isinstance(args, dict):
                    args = {}
                result = run_tool(name, args)
                if isinstance(result, dict):
                    if result.get("mutated"):
                        mutated = True
                    _collect_items(collected, result)
                    _collect_qr(qr_payloads, result)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": dump_tool_result(result),
                    }
                )

        return (
            "La consulta requirió demasiados pasos. Reformula la pregunta de forma más concreta.",
            "max_tool_rounds",
            used_label,
            _side_items_for_reply(collected, qr_payloads),
            mutated,
            qr_payloads,
        )
    except Exception as exc:  # noqa: BLE001
        text = str(exc)
        if text.startswith("llm_unavailable:") or text == "missing_providers" or _is_retryable(exc):
            return (
                "Ningún proveedor de IA respondió (Groq/Ollama/Gemini). Reintento en unos segundos…",
                "llm_unavailable",
                used_label,
                _side_items_for_reply(collected, qr_payloads),
                mutated,
                qr_payloads,
            )
        return (
            f"Error al consultar la IA: {exc}",
            str(exc),
            used_label,
            _side_items_for_reply(collected, qr_payloads),
            mutated,
            qr_payloads,
        )
