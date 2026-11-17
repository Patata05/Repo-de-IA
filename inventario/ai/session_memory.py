"""
Memoria de conversación PydanticAI ↔ Supabase (messages_json).

Guarda ModelRequest / ModelResponse (no solo texto) para que el agente
pueda reusar el hilo (p. ej. etiqueta 272949 del turno anterior).
"""

from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import quote

from inventario.supabase_client import _request_json, _supabase_base_and_keys, get_env

logger = logging.getLogger(__name__)

TABLE = "chat_agent_memory"
# Ventana deslizante: ~3 turnos (6 mensajes user+assistant).
MAX_MODEL_MESSAGES = 6


def _adapter():
    from pydantic_ai.messages import ModelMessagesTypeAdapter

    return ModelMessagesTypeAdapter


def messages_to_json(messages: list[Any]) -> str:
    """Serializa a JSON string que PydanticAI entiende."""
    raw = _adapter().dump_json(messages)
    if isinstance(raw, (bytes, bytearray)):
        return raw.decode("utf-8")
    return str(raw)


def messages_from_json(raw: str | bytes | list | dict | None) -> list[Any]:
    if raw is None or raw == "" or raw == []:
        return []
    try:
        if isinstance(raw, (list, dict)):
            return list(_adapter().validate_python(raw))
        if isinstance(raw, (bytes, bytearray)):
            return list(_adapter().validate_json(raw))
        return list(_adapter().validate_json(str(raw)))
    except Exception as exc:  # noqa: BLE001
        logger.warning("messages_from_json failed: %s", exc)
        return []


def _part_kind(part: Any) -> str:
    return str(getattr(part, "part_kind", "") or "")


def _is_user_prompt_request(msg: Any) -> bool:
    """True si el ModelRequest abre un turno de usuario (no solo tool-return)."""
    from pydantic_ai.messages import ModelRequest

    if not isinstance(msg, ModelRequest):
        return False
    for part in msg.parts:
        kind = _part_kind(part)
        name = part.__class__.__name__
        if kind in ("user-prompt", "user_prompt") or name == "UserPromptPart":
            return True
    return False


def _response_is_tool_call_only(msg: Any) -> bool:
    from pydantic_ai.messages import ModelResponse

    if not isinstance(msg, ModelResponse):
        return False
    has_call = False
    has_text = False
    for part in msg.parts:
        kind = _part_kind(part)
        name = part.__class__.__name__
        if kind in ("tool-call", "tool_call") or "ToolCall" in name:
            has_call = True
        if kind == "text" or name == "TextPart":
            has_text = True
    return has_call and not has_text


def trim_model_messages(
    messages: list[Any],
    max_n: int = MAX_MODEL_MESSAGES,
) -> list[Any]:
    """
    Ventana deslizante: últimos N Model*.
    Empieza en UserPrompt y no deja tool_call sin su tool_return.
    """
    if not messages:
        return []
    from pydantic_ai.messages import ModelRequest

    trimmed = list(messages[-max(1, int(max_n)) :])

    while trimmed and not _is_user_prompt_request(trimmed[0]):
        trimmed = trimmed[1:]

    while trimmed and _response_is_tool_call_only(trimmed[-1]):
        trimmed = trimmed[:-1]
        while (
            trimmed
            and isinstance(trimmed[-1], ModelRequest)
            and not _is_user_prompt_request(trimmed[-1])
        ):
            trimmed = trimmed[:-1]

    while trimmed and not _is_user_prompt_request(trimmed[0]):
        trimmed = trimmed[1:]
    return trimmed


def build_turn_messages(user_text: str, assistant_text: str) -> list[Any]:
    """Un turno user→assistant en formato PydanticAI."""
    from pydantic_ai.messages import (
        ModelRequest,
        ModelResponse,
        TextPart,
        UserPromptPart,
    )

    user = (user_text or "").strip()
    assistant = (assistant_text or "").strip()
    out: list[Any] = []
    if user:
        out.append(ModelRequest(parts=[UserPromptPart(content=user)]))
    if assistant:
        out.append(ModelResponse(parts=[TextPart(content=assistant)]))
    return out


def plain_history_from_model_messages(messages: list[Any]) -> list[dict[str, str]]:
    """Convierte Model* → history role/content para el agent OpenAI actual."""
    from pydantic_ai.messages import ModelRequest, ModelResponse

    out: list[dict[str, str]] = []
    for msg in messages:
        if isinstance(msg, ModelRequest):
            chunks: list[str] = []
            for part in msg.parts:
                kind = getattr(part, "part_kind", "") or ""
                if kind in ("user-prompt", "user_prompt") or part.__class__.__name__ == "UserPromptPart":
                    content = getattr(part, "content", None)
                    if content is not None:
                        chunks.append(str(content))
            text = "\n".join(c for c in chunks if c).strip()
            if text:
                out.append({"role": "user", "content": text})
        elif isinstance(msg, ModelResponse):
            chunks = []
            for part in msg.parts:
                kind = getattr(part, "part_kind", "") or ""
                name = part.__class__.__name__
                if kind == "text" or name == "TextPart":
                    chunks.append(str(getattr(part, "content", "") or ""))
                elif kind in ("tool-call", "tool_call") or "ToolCall" in name:
                    tool = getattr(part, "tool_name", None) or getattr(
                        part, "name", "tool"
                    )
                    args = getattr(part, "args", None) or getattr(
                        part, "arguments", ""
                    )
                    chunks.append(f"[herramienta:{tool} {args}]")
                elif kind in ("tool-return", "tool_return") or "ToolReturn" in name:
                    content = getattr(part, "content", "")
                    chunks.append(f"[resultado:{str(content)[:400]}]")
            text = "\n".join(c for c in chunks if c).strip()
            if text:
                out.append({"role": "assistant", "content": text})
    return out


def seed_from_plain_history(history: list[dict] | None) -> list[Any]:
    """Si Supabase está vacío, arma Model* desde el history del front."""
    from pydantic_ai.messages import (
        ModelRequest,
        ModelResponse,
        TextPart,
        UserPromptPart,
    )

    out: list[Any] = []
    for item in history or []:
        role = str(item.get("role") or "").strip().lower()
        text = str(item.get("content") or item.get("text") or "").strip()
        if not text:
            continue
        if role in ("user", "human"):
            out.append(ModelRequest(parts=[UserPromptPart(content=text)]))
        elif role in ("assistant", "bot", "model"):
            out.append(ModelResponse(parts=[TextPart(content=text)]))
    return trim_model_messages(out)


def load_session_messages(session_id: str) -> list[Any]:
    sid = str(session_id or "").strip()
    if not sid:
        return []
    env = get_env()
    base, attempts = _supabase_base_and_keys(env)
    if not base or not attempts:
        return []

    qs = (
        f"{TABLE}?select=messages_json&session_id=eq.{quote(sid, safe='')}"
    )
    for name, key, send_bearer in attempts:
        url = f"{base}/rest/v1/{qs}"
        headers = {"apikey": key, "Accept": "application/json"}
        if send_bearer:
            headers["Authorization"] = f"Bearer {key}"
        payload, error, _ = _request_json("GET", url, headers=headers)
        if error:
            logger.debug("load_session_messages %s: %s", name, error)
            continue
        if not isinstance(payload, list) or not payload:
            return []
        raw = payload[0].get("messages_json") if isinstance(payload[0], dict) else None
        return trim_model_messages(messages_from_json(raw))
    return []


def clear_session_messages(session_id: str) -> bool:
    """Vacía o borra messages_json de la sesión."""
    sid = str(session_id or "").strip()
    if not sid:
        return False
    # Preferir vaciar (upsert []) para no romper FK / unicidad.
    if save_session_messages(sid, []):
        return True
    env = get_env()
    base, attempts = _supabase_base_and_keys(env)
    if not base or not attempts:
        return False
    qs = f"{TABLE}?session_id=eq.{quote(sid, safe='')}"
    for name, key, send_bearer in attempts:
        url = f"{base}/rest/v1/{qs}"
        headers = {"apikey": key, "Accept": "application/json"}
        if send_bearer:
            headers["Authorization"] = f"Bearer {key}"
        _payload, error, _ = _request_json("DELETE", url, headers=headers)
        if error:
            logger.warning("clear_session_messages %s: %s", name, error[:300])
            continue
        return True
    return False


def save_session_messages(session_id: str, messages: list[Any]) -> bool:
    sid = str(session_id or "").strip()
    if not sid:
        return False
    trimmed = trim_model_messages(messages)
    body = {
        "session_id": sid,
        "messages_json": json.loads(messages_to_json(trimmed)),
        "updated_at": "now()",
    }
    # PostgREST: now() as string may not work in JSON — use ISO from Python.
    from datetime import datetime, timezone

    body["updated_at"] = datetime.now(timezone.utc).isoformat()

    env = get_env()
    base, attempts = _supabase_base_and_keys(env)
    if not base or not attempts:
        return False

    path = f"{TABLE}?on_conflict=session_id"
    for name, key, send_bearer in attempts:
        url = f"{base}/rest/v1/{path}"
        headers = {
            "apikey": key,
            "Accept": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }
        if send_bearer:
            headers["Authorization"] = f"Bearer {key}"
        _payload, error, _ = _request_json("POST", url, headers=headers, body=body)
        if error:
            logger.warning("save_session_messages %s: %s", name, error[:300])
            continue
        return True
    return False


def append_and_save_turn(
    session_id: str,
    user_text: str,
    assistant_text: str,
    *,
    prior: list[Any] | None = None,
) -> list[Any]:
    """Añade el turno y persiste en Supabase."""
    base = list(prior) if prior is not None else load_session_messages(session_id)
    merged = trim_model_messages(base + build_turn_messages(user_text, assistant_text))
    save_session_messages(session_id, merged)
    return merged


def resolve_message_history(
    session_id: str | None,
    client_history: list[dict] | None = None,
) -> list[Any]:
    """
    Carga messages_json de Supabase; si vacío, siembra desde history del front.
    """
    sid = str(session_id or "").strip()
    stored = load_session_messages(sid) if sid else []
    if stored:
        return stored
    seeded = seed_from_plain_history(client_history)
    if sid and seeded:
        save_session_messages(sid, seeded)
    return seeded


def history_for_openai_agent(
    session_id: str | None,
    client_history: list[dict] | None = None,
) -> list[dict[str, str]]:
    """History listo para run_chat_agent (role/content)."""
    model_msgs = resolve_message_history(session_id, client_history)
    from_model = plain_history_from_model_messages(model_msgs)
    if from_model:
        return from_model
    # Fallback: history plano del cliente
    out: list[dict[str, str]] = []
    for item in client_history or []:
        role = str(item.get("role") or "").strip().lower()
        text = str(item.get("content") or item.get("text") or "").strip()
        if not text:
            continue
        if role in ("assistant", "bot", "model"):
            out.append({"role": "assistant", "content": text})
        elif role in ("user", "human"):
            out.append({"role": "user", "content": text})
    return out
