import json
import re

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from inventario.ai.agent import run_chat_agent
from inventario.ai.client import describe_llm_setup, get_llm_model
from inventario.ai.local_fallback import local_chat_answer
from inventario.supabase_client import get_env, read_inventario


@require_GET
def inventario(request):
    rows, error, used = read_inventario()
    return JsonResponse({"rows": rows, "error": error, "used": used})


@require_GET
def health(request):
    env = get_env()
    setup = describe_llm_setup()
    rows, db_error, used = read_inventario()
    return JsonResponse(
        {
            "ok": setup.get("configured") and db_error is None,
            "llm": {
                **setup,
                "preferred_model": get_llm_model(),
                "order": env.get("LLM_PROVIDERS") or "deepseek",
            },
            "supabase": {
                "configured": bool(env.get("NEXT_PUBLIC_SUPABASE_URL") or env.get("SUPABASE_URL")),
                "used": used,
                "rows_sample": len(rows) if not db_error else 0,
                "error": db_error,
            },
        }
    )


@csrf_exempt
@require_POST
def chat_compose(request):
    """PydanticAI: prosa dinámica a partir de hechos verificados."""
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "El mensaje no es JSON valido."}, status=400)

    user_text = str(payload.get("user_text") or payload.get("message") or "").strip()
    kind = str(payload.get("kind") or "general").strip() or "general"
    thread_hint = str(payload.get("thread_hint") or "").strip()
    facts = payload.get("facts")
    if facts is not None and not isinstance(facts, dict):
        return JsonResponse({"error": "facts debe ser un objeto."}, status=400)
    fallback = str(payload.get("fallback") or "").strip()
    session_raw = payload.get("session_id") or payload.get("sessionId")
    session_id = (
        str(session_raw).strip()
        if isinstance(session_raw, str) and session_raw.strip()
        else None
    )

    from inventario.ai.dynamic_reply import compose_dynamic_reply

    composed = compose_dynamic_reply(
        user_text=user_text,
        facts=facts if isinstance(facts, dict) else {},
        thread_hint=thread_hint,
        kind=kind,
        session_id=session_id,
    )
    if composed is None:
        return JsonResponse(
            {
                "ok": False,
                "reply": fallback or None,
                "follow_ups": [],
                "engine": "fallback",
            }
        )
    return JsonResponse(
        {
            "ok": True,
            "reply": composed.reply,
            "follow_ups": composed.follow_ups,
            "engine": "pydantic-ai",
        }
    )


@csrf_exempt
@require_POST
def chat_n8n(request):
    """
    Ruta opt-in hacia n8n. No reemplaza /api/chat/ (DeepSeek + tools).
    Solo responde si N8N_INVENTARIO_URL está en .env.
    """
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "El mensaje no es JSON valido."}, status=400)

    message = str(payload.get("message") or "").strip()
    if not message:
        return JsonResponse({"error": "Escribe un mensaje."}, status=400)

    session_raw = (
        payload.get("session_id")
        or payload.get("sessionId")
        or payload.get("conversationId")
        or "default"
    )
    session_id = re.sub(r"[^a-zA-Z0-9_-]", "", str(session_raw))[:64] or "default"

    thread_focus = payload.get("threadFocus") or payload.get("thread_focus")
    if thread_focus is not None and not isinstance(thread_focus, dict):
        thread_focus = None
    last_user = str(
        payload.get("lastUser") or payload.get("last_user") or ""
    ).strip() or None
    thread_summary = str(
        payload.get("threadSummary") or payload.get("thread_summary") or ""
    ).strip() or None

    from inventario.services.asistente import n8n_configured, preguntar_asistente

    if not n8n_configured():
        return JsonResponse(
            {
                "error": "n8n_not_configured",
                "reply": "n8n no está configurado. Define N8N_INVENTARIO_URL en Backend-ia/.env.",
                "acciones": [],
            },
            status=503,
        )

    try:
        res = preguntar_asistente(
            message,
            session_id,
            thread_focus=thread_focus,
            last_user=last_user,
            thread_summary=thread_summary,
        )
    except Exception as exc:  # noqa: BLE001
        return JsonResponse(
            {
                "error": "n8n_unreachable",
                "reply": "El asistente n8n no respondió, intenta de nuevo.",
                "detail": str(exc)[:300],
                "acciones": [],
            },
            status=502,
        )

    return JsonResponse(
        {
            "reply": res.get("reply") or "",
            "acciones": res.get("acciones") or [],
            "items": [],
            "qr": [],
            "mutated": False,
            "used": "n8n",
            "error": None,
        }
    )


@csrf_exempt
@require_POST
def chat(request):
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "El mensaje no es JSON valido."}, status=400)

    message = str(payload.get("message") or "").strip()
    if not message:
        return JsonResponse({"error": "Escribe un mensaje."}, status=400)

    history = payload.get("history")
    if history is not None and not isinstance(history, list):
        return JsonResponse({"error": "history debe ser una lista."}, status=400)

    memory_raw = payload.get("memory")
    memory = None
    if isinstance(memory_raw, str):
        memory = memory_raw.strip() or None
    elif memory_raw is not None:
        return JsonResponse({"error": "memory debe ser texto."}, status=400)

    model_raw = payload.get("model")
    preferred_model = None
    if isinstance(model_raw, str):
        preferred_model = model_raw.strip() or None

    session_raw = payload.get("session_id") or payload.get("sessionId")
    session_id = (
        str(session_raw).strip()
        if isinstance(session_raw, str) and session_raw.strip()
        else None
    )

    env = get_env()
    if not (env.get("NEXT_PUBLIC_SUPABASE_URL") or env.get("SUPABASE_URL")):
        return JsonResponse(
            {
                "reply": "Supabase no está configurado en el backend.",
                "error": "supabase_missing",
                "used": None,
                "mutated": False,
            }
        )

    # PydanticAI message_history (Supabase messages_json) + recorte de tokens.
    effective_history = history or []
    model_msgs = []
    try:
        from inventario.ai.session_memory import (
            append_and_save_turn,
            history_for_openai_agent,
            resolve_message_history,
        )

        model_msgs = resolve_message_history(session_id, effective_history)
        effective_history = history_for_openai_agent(session_id, effective_history)
    except Exception:  # noqa: BLE001
        model_msgs = []
        effective_history = history or []

    reply, error, used_model, items, mutated, qr_list = run_chat_agent(
        message, effective_history, memory, preferred_model=preferred_model
    )

    if error in ("llm_unavailable", "missing_key"):
        local_reply, local_items = local_chat_answer(message)
        prefix = ""
        if error == "missing_key":
            prefix = "(Sin proveedores IA — modo local)\n\n"
        elif error == "llm_unavailable":
            prefix = "(Los proveedores IA no respondieron — modo local)\n\n"
        final_reply = prefix + local_reply
        if session_id and final_reply:
            try:
                append_and_save_turn(
                    session_id, message, final_reply, prior=model_msgs
                )
            except Exception:  # noqa: BLE001
                pass
        return JsonResponse(
            {
                "reply": final_reply,
                "error": None,
                "used": "local_fallback",
                "items": local_items or items or [],
                "mutated": False,
                "qr": [],
                "memory_engine": "pydantic-ai" if session_id else None,
            }
        )

    if session_id and reply:
        try:
            append_and_save_turn(session_id, message, reply, prior=model_msgs)
        except Exception:  # noqa: BLE001
            pass

    return JsonResponse(
        {
            "reply": reply,
            "error": error,
            "used": used_model,
            "items": items or [],
            "mutated": bool(mutated),
            "qr": qr_list or [],
            "memory_engine": "pydantic-ai" if session_id else None,
        }
    )
