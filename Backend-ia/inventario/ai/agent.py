from __future__ import annotations

"""
Entrada del chat: siempre PydanticAI (tool_agent) + historial de sesión.
Sin atajos por palabras clave ni respuestas hardcodeadas.
"""

from inventario.ai.client import get_llm_endpoints
from inventario.ai.tools import dump_tool_result, run_tool  # noqa: F401 — reexport / compat
from inventario.ai.usage import empty_usage

MAX_SIDE_ITEMS = 2000
MAX_MEMORY_CHARS = 2500


def run_chat_agent(
    message: str,
    history: list[dict] | None = None,
    memory: str | None = None,
    preferred_model: str | None = None,
    session_id: str | None = None,
    contexto_vista: dict | None = None,
    message_history: list | None = None,
) -> tuple[str, str | None, str | None, list[dict], bool, list[dict], dict, dict | None]:
    """
    reply, error, used_model, items, mutated, qr_list, usage, viewer

    Todo el mensaje (y el hilo) va al agente PydanticAI. No hay detectores
    locales ni strings fijos según intención.
    """
    from inventario.ai.tool_agent import run_tool_agent
    from inventario.ai.vista_contexto import normalize_contexto_vista

    memory_text = (memory or "").strip()
    if len(memory_text) > MAX_MEMORY_CHARS:
        memory_text = memory_text[: MAX_MEMORY_CHARS - 1] + "…"

    ctx = normalize_contexto_vista(contexto_vista)

    endpoints = get_llm_endpoints()
    if not endpoints:
        # Error de configuración (no es respuesta por intención del usuario).
        return (
            "No hay proveedores de IA listos. Configura OPENAI_API_KEY.",
            "missing_key",
            None,
            [],
            False,
            [],
            empty_usage(),
            None,
        )

    try:
        reply, error, used, items, mutated, qr_list, usage, viewer = run_tool_agent(
            message,
            history,
            memory_text,
            preferred_model=preferred_model,
            session_id=session_id,
            contexto_vista=ctx,
            message_history=message_history,
        )
        return (
            reply,
            error,
            used,
            (items or [])[:MAX_SIDE_ITEMS],
            mutated,
            qr_list or [],
            usage,
            viewer,
        )
    except Exception as exc:  # noqa: BLE001
        return (
            f"Error al consultar la IA: {exc}",
            str(exc),
            None,
            [],
            False,
            [],
            empty_usage(),
            None,
        )
