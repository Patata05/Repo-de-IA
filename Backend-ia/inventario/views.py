import json

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
                "order": env.get("LLM_PROVIDERS") or "groq,ollama,gemini",
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

    reply, error, used_model, items, mutated, qr_list = run_chat_agent(
        message, history or [], memory
    )

    if error in ("llm_unavailable", "missing_key"):
        local_reply, local_items = local_chat_answer(message)
        prefix = ""
        if error == "missing_key":
            prefix = "(Sin proveedores IA — modo local)\n\n"
        elif error == "llm_unavailable":
            prefix = "(Los proveedores IA no respondieron — modo local)\n\n"
        return JsonResponse(
            {
                "reply": prefix + local_reply,
                "error": None,
                "used": "local_fallback",
                "items": local_items or items or [],
                "mutated": False,
                "qr": [],
            }
        )

    return JsonResponse(
        {
            "reply": reply,
            "error": error,
            "used": used_model,
            "items": items or [],
            "mutated": bool(mutated),
            "qr": qr_list or [],
        }
    )
