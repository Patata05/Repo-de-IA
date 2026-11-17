"""Composición de respuestas dinámicas con PydanticAI + DeepSeek."""

from __future__ import annotations

import json
import logging
from typing import Any

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

COMPOSE_INSTRUCTIONS = """
Eres el asistente de inventario (español de México, tono profesional y cercano).
Redactas UNA respuesta en prosa conversacional a partir de HECHOS ya verificados.

Reglas:
- No inventes cifras, etiquetas, personas ni áreas que no estén en HECHOS.
- Sé claro y preciso: el usuario debe entender el resultado sin adivinar.
- Responde siempre en párrafos naturales, cálidos y conversacionales.
  Evita viñetas o respuestas robóticas salvo que el usuario pida un listado.
  Si el kind es saludo/ack, saluda con amabilidad y pregunta en qué puedes
  apoyar hoy con el inventario.
- Si facts.plantilla_sugerida existe, úsala como base y varía la redacción
  (misma verdad, otras palabras). No la copies literal siempre.
- Nunca digas “esta consulta (10)” ni “0 no aparecen / 0 faltan / 0 sobran”.
  Omite lo que sea cero. Prefiere “las diez etiquetas”, “tres faltan”, etc.
- Respeta el kind: compare / compare_scoped = solo comparación. NUNCA digas
  que vas a pasar, copiar o mover registros salvo que facts lo pida.
- Si veredicto=todas_coinciden: di que ya están / coinciden en el destino y
  ofrece otra acción (panel, Excel, otra consulta). Varía el cierre.
- Si hay faltantes: di cuántas coinciden y cuántas no; nombra 1–3 ejemplos.
- kind delete_done: confirma el borrado con claridad (cuántos, de qué inventario
  si aplica). Varía el cierre; no inventes etiquetas fuera de sample.
- Varía la redacción: no uses siempre la misma pregunta final.
- Si el usuario dice “¿recuerdas?”, “te pedí…”, reconoce el hilo.
- Prohibido slang (bronca, chido, órale, neta, late, wey).
- Sin viñetas ni listas largas: 1–2 frases o un párrafo corto.
- Cierra con UNA pregunta breve de seguimiento.
- follow_ups: máximo 3 frases cortas (botones). Varía según el resultado.
""".strip()


class DynamicChatReply(BaseModel):
    """Salida estructurada del redactor conversacional."""

    reply: str = Field(description="Respuesta en prosa al usuario (sin viñetas).")
    follow_ups: list[str] = Field(
        default_factory=list,
        description="Hasta 3 siguientes pasos cortos (texto de botón).",
    )


def _build_agent(api_key: str, model_name: str, base_url: str = ""):
    from pydantic_ai import Agent
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    provider = OpenAIProvider(
        api_key=api_key,
        base_url=(base_url or "https://api.openai.com/v1").rstrip("/"),
    )
    model = OpenAIChatModel(model_name, provider=provider)
    return Agent(
        model,
        output_type=DynamicChatReply,
        instructions=COMPOSE_INSTRUCTIONS,
    )


def compose_dynamic_reply(
    *,
    user_text: str,
    facts: dict[str, Any] | None = None,
    thread_hint: str = "",
    kind: str = "general",
    session_id: str | None = None,
    message_history: list | None = None,
) -> DynamicChatReply | None:
    """
    Reescribe hechos verificados en prosa dinámica.
    Usa message_history (PydanticAI) cuando hay sesión.
    """
    try:
        from inventario.ai.client import get_llm_endpoints
        from inventario.supabase_client import get_env
    except Exception:  # noqa: BLE001
        return None

    endpoints = get_llm_endpoints()
    if not endpoints:
        return None

    ep = endpoints[0]
    env = get_env()
    api_key = (ep.api_key or env.get("OPENAI_API_KEY") or "").strip()
    if not api_key:
        return None

    model_name = ep.models[0] if ep.models else "gpt-4o-mini"
    base_url = (ep.base_url or env.get("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip(
        "/"
    )

    history = list(message_history or [])
    if not history and session_id:
        try:
            from inventario.ai.session_memory import resolve_message_history, trim_model_messages

            history = trim_model_messages(
                resolve_message_history(session_id, None),
                max_n=12,
            )
        except Exception:  # noqa: BLE001
            history = []

    payload = {
        "kind": kind,
        "user_text": (user_text or "").strip()[:800],
        "thread_hint": (thread_hint or "").strip()[:500],
        "facts": facts or {},
    }
    prompt = (
        "Redacta la respuesta del asistente con estos datos JSON "
        "(no inventes fuera de facts; si hay historial, respeta el hilo):\n"
        f"{json.dumps(payload, ensure_ascii=False)[:3500]}"
    )

    try:
        agent = _build_agent(api_key, model_name, base_url)
        # message_history = ModelRequest/ModelResponse (no solo texto).
        result = (
            agent.run_sync(prompt, message_history=history)
            if history
            else agent.run_sync(prompt)
        )
        out = result.output
        if not isinstance(out, DynamicChatReply):
            return None
        reply = (out.reply or "").strip()
        if not reply:
            return None
        ups = [str(u).strip() for u in (out.follow_ups or []) if str(u).strip()]
        return DynamicChatReply(reply=reply, follow_ups=ups[:3])
    except Exception as exc:  # noqa: BLE001
        logger.warning("PydanticAI compose failed: %s", exc)
        return None
