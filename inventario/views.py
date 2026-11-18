import json
import re

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from inventario.ai.agent import run_chat_agent
from inventario.ai.client import describe_llm_setup, get_llm_model
from inventario.ai.suggested_actions import build_acciones_sugeridas
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
                "order": env.get("LLM_PROVIDERS") or "openai",
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

    contexto_vista = payload.get("contexto_vista") or payload.get("contextoVista")
    if contexto_vista is not None and not isinstance(contexto_vista, dict):
        return JsonResponse(
            {"error": "contexto_vista debe ser un objeto."}, status=400
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

    # Saludo/charla o QR directo: respuesta ligera (sin historial gigante ni agente).
    from inventario.ai.tool_agent import (
        is_fast_chitchat_message,
        is_fast_qr_message,
        run_fast_chitchat_reply,
        run_fast_qr_reply,
    )

    hist_list = history if isinstance(history, list) else None
    if is_fast_chitchat_message(
        message, session_id=session_id, history=hist_list
    ):
        reply, error, used_model, items, mutated, qr_list, usage, viewer = (
            run_fast_chitchat_reply(
                message,
                preferred_model=preferred_model,
                history=hist_list,
                session_id=session_id,
            )
        )
        if session_id and reply:
            try:
                from inventario.ai.tool_agent import persist_short_turn

                persist_short_turn(session_id, message, reply)
            except Exception:  # noqa: BLE001
                pass
        acciones = build_acciones_sugeridas(reply or "", [], message, None)
        return JsonResponse(
            {
                "reply": reply,
                "error": error,
                "used": used_model,
                "items": [],
                "mutated": False,
                "qr": [],
                "usage": usage or {},
                "memory_engine": "openai-fast" if session_id else None,
                "acciones_sugeridas": acciones,
                "exportar_excel": False,
                "contexto_vista": None,
                "viewer": None,
            }
        )

    if is_fast_qr_message(message, session_id=session_id):
        reply, error, used_model, items, mutated, qr_list, usage, viewer = (
            run_fast_qr_reply(
                message,
                preferred_model=preferred_model,
                session_id=session_id,
            )
        )
        if session_id and reply:
            try:
                from inventario.ai.tool_agent import persist_short_turn

                persist_short_turn(session_id, message, reply)
            except Exception:  # noqa: BLE001
                pass
        acciones = build_acciones_sugeridas(
            reply or "", items or [], message, viewer
        )
        return JsonResponse(
            {
                "reply": reply,
                "error": error,
                "used": used_model,
                "items": items or [],
                "mutated": False,
                "qr": list(qr_list or []),
                "usage": usage or {},
                "memory_engine": "openai-fast-qr" if session_id else None,
                "acciones_sugeridas": acciones,
                "exportar_excel": False,
                "contexto_vista": viewer,
                "viewer": viewer,
            }
        )

    # PydanticAI message_history (Supabase messages_json) + recorte de tokens.
    effective_history = history or []
    model_msgs = []
    try:
        from inventario.ai.session_memory import (
            history_for_openai_agent,
            resolve_message_history,
        )
        from inventario.ai.tool_agent import (
            MAX_HISTORY_MESSAGES,
            compact_message_history_for_llm,
        )

        model_msgs = compact_message_history_for_llm(
            resolve_message_history(session_id, effective_history),
            max_n=MAX_HISTORY_MESSAGES,
        )
        effective_history = history_for_openai_agent(session_id, effective_history)[
            -MAX_HISTORY_MESSAGES:
        ]
    except Exception:  # noqa: BLE001
        model_msgs = []
        effective_history = (history or [])[-4:]

    reply, error, used_model, items, mutated, qr_list, usage, viewer = run_chat_agent(
        message,
        effective_history,
        memory,
        preferred_model=preferred_model,
        session_id=session_id,
        contexto_vista=contexto_vista if isinstance(contexto_vista, dict) else None,
        message_history=model_msgs,
    )

    # Guardar solo prosa corta del turno (sin dumps de tools).
    if session_id and reply:
        try:
            from inventario.ai.tool_agent import persist_short_turn

            persist_short_turn(session_id, message, reply)
        except Exception:  # noqa: BLE001
            pass

    items_out = items or []
    # Señal FE: abrir modal de borrado (preparar_eliminacion_origen).
    eliminacion_pendiente = None
    if isinstance(viewer, dict):
        ep = viewer.get("eliminacion_pendiente")
        if isinstance(ep, dict) and str(ep.get("origen") or "").strip():
            raw_ids = ep.get("ids") if isinstance(ep.get("ids"), list) else []
            eliminacion_pendiente = {
                "origen": str(ep.get("origen") or "").strip(),
                "count": int(ep.get("count") or 0),
                "kind": str(ep.get("kind") or "").strip(),
                "ids": [
                    int(x)
                    for x in raw_ids
                    if str(x).strip().lstrip("-").isdigit()
                ],
            }
    # contexto_vista: null = charla/sin datos (visor oculto); objeto = mostrar/sincronizar.
    contexto_out = None
    if isinstance(viewer, dict) and viewer.get("tipo"):
        tipo_v = str(viewer["tipo"]).strip().lower()
        valor_v = str(viewer.get("valor") or "").strip()
        if tipo_v == "comparacion":
            comp = viewer.get("comparacion")
            contexto_out = {
                "tipo": "comparacion",
                "valor": valor_v or "general",
                "comparacion": comp if isinstance(comp, dict) else {},
                "lista_limitada": False,
            }
        elif tipo_v in {"areas", "areas_general"}:
            ranking = viewer.get("ranking")
            contexto_out = {
                "tipo": "areas_general",
                "valor": "general",
                "ranking": ranking if isinstance(ranking, list) else [],
                "lista_limitada": False,
            }
        elif tipo_v in {"persona", "area", "origen"} and valor_v:
            contexto_out = {
                "tipo": tipo_v,
                "valor": valor_v,
                "lista_limitada": bool(viewer.get("lista_limitada")),
            }
        elif eliminacion_pendiente and not contexto_out:
            contexto_out = {
                "tipo": "origen",
                "valor": eliminacion_pendiente["origen"],
                "lista_limitada": False,
            }

    # Crear/juntar/mover inventarios ≠ exportar Excel.
    msg_fold = re.sub(
        r"\s+",
        " ",
        re.sub(
            r"[áàäâ]",
            "a",
            re.sub(
                r"[éèëê]",
                "e",
                re.sub(
                    r"[íìïî]",
                    "i",
                    re.sub(
                        r"[óòöô]",
                        "o",
                        re.sub(
                            r"[úùüû]",
                            "u",
                            (message or "").lower(),
                        ),
                    ),
                ),
            ),
        ),
    )
    # Confirmación de consolidación/traslado: forzar visor al origen destino
    # (evita arrastrar persona/área previa, p. ej. «excel 3»).
    is_confirm_consolidacion = bool(
        mutated
        and items_out
        and re.search(
            r"^(si|ok|okay|dale|procede|confirmo|confirmalo|adelante|hazlo|"
            r"de acuerdo|va|claro|perfecto)(\b|[,.!]|$)",
            msg_fold.strip(),
        )
    )
    if is_confirm_consolidacion:
        origenes_dest: dict[str, int] = {}
        for row in items_out:
            if not isinstance(row, dict):
                continue
            o = str(row.get("origen") or "").strip()
            if o:
                origenes_dest[o] = origenes_dest.get(o, 0) + 1
        if origenes_dest:
            top_origen, top_n = max(origenes_dest.items(), key=lambda kv: kv[1])
            if top_n >= max(1, (len(items_out) + 1) // 2):
                tipo_actual = (
                    str(contexto_out.get("tipo") or "").strip().lower()
                    if isinstance(contexto_out, dict)
                    else ""
                )
                if tipo_actual != "origen":
                    contexto_out = {
                        "tipo": "origen",
                        "valor": top_origen,
                        "lista_limitada": False,
                    }
    # Panorama/resumen ≠ exportar (aunque digan xlsx/excel N).
    is_panorama_ask = bool(
        re.search(r"\b(panorama|panorma|resumen|dashboard|totales?)\b", msg_fold)
        and not re.search(r"\b(exportar?|descargar?|bajar|descarga)\b", msg_fold)
    )
    wants_explicit_export = bool(
        re.search(
            r"\b(exportar?|descargar?|bajar|descarga|archivo\s+xlsx|"
            r"dame\s+(un\s+)?archivo\s+(excel|xlsx|csv)|"
            r"genera(r)?\s+(un\s+)?(archivo\s+)?(excel|xlsx))\b",
            msg_fold,
        )
    ) and not is_panorama_ask
    # Autorizado por tool confirmar_exportacion_excel.
    export_authorized = bool(
        isinstance(viewer, dict) and viewer.get("exportar_excel") is True
    )
    consolidacion_intent = bool(
        re.search(
            r"\b(crea(r)?|arma(r)?|junta(r)?|une|unir|consolida(r)?|"
            r"traslad\w*|pas(a|ar)|mueve|mover|copia(r)?)\b",
            msg_fold,
        )
        and re.search(
            r"\b(inventario|excel|origen|registros?|etiquetas?)\b",
            msg_fold,
        )
    )
    eliminacion_intent = bool(
        re.search(r"\b(elimina\w*|borra\w*|quitar|suprim\w*)\b", msg_fold)
        and re.search(r"\b(inventario|excel|origen)\b", msg_fold)
    )
    reply_asks_confirm = bool(
        re.search(
            r"\b(confirm|omit|validos|mover|crearan|inventario\s+\d+|"
            r"eliminar|borrara|renumer)\b",
            re.sub(r"\s+", " ", (reply or "").lower()),
        )
    )
    # Sin pedido explícito de export → no devolver ítems que disparen descarga.
    if consolidacion_intent and not wants_explicit_export and not export_authorized:
        items_out = []
    # Panorama: no marcar export.
    if is_panorama_ask:
        export_authorized = False

    # QR: lista completa al visor (sin recortar 5/50). El chat ya resume.
    qr_out = list(qr_list or [])

    acciones = build_acciones_sugeridas(
        reply or "", items_out, message, contexto_out
    )
    if (
        (
            consolidacion_intent
            or eliminacion_intent
            or reply_asks_confirm
            or wants_explicit_export
        )
        and not export_authorized
    ):
        acciones = [
            a
            for a in acciones
            if not re.search(
                r"\b(export|descarg|excel|xlsx|csv)\b",
                f"{a.get('etiqueta', '')} {a.get('prompt_accion', '')}".lower(),
            )
        ]
        if not acciones and (
            consolidacion_intent or eliminacion_intent or wants_explicit_export
        ):
            acciones = [
                {
                    "etiqueta": "Confirmar",
                    "prompt_accion": "sí, confírmalo",
                },
                {
                    "etiqueta": "Cancelar",
                    "prompt_accion": "cancela",
                },
            ]

    payload: dict = {
        "reply": reply,
        "error": error,
        "used": used_model,
        "items": items_out,
        "mutated": bool(mutated),
        "qr": qr_out,
        "usage": usage or {},
        "memory_engine": "pydantic-ai" if session_id else None,
        "acciones_sugeridas": acciones,
        # Solo true tras confirmar_exportacion_excel (o pedido ya confirmado).
        "exportar_excel": bool(export_authorized),
        # Modal FE de borrado (origen + count + ids); null si no hay pendiente.
        "eliminacion_pendiente": eliminacion_pendiente,
        "contexto_vista": contexto_out,
        # Alias retrocompatible.
        "viewer": (
            {
                "tipo": "areas"
                if contexto_out and contexto_out["tipo"] == "areas_general"
                else contexto_out["tipo"],
                "valor": contexto_out.get("valor") or "general",
                **(
                    {"comparacion": contexto_out.get("comparacion")}
                    if contexto_out and contexto_out.get("tipo") == "comparacion"
                    else {}
                ),
            }
            if contexto_out
            else None
        ),
    }
    return JsonResponse(payload)


@csrf_exempt
@require_POST
def chat_learn(request):
    """
    Guarda un turno aprobado (pulgar arriba) o corrección en ai_learned_examples.
    Body: pregunta_usuario, respuesta_ideal, intencion_y_filtros?, session_id?, vote?
    """
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "El mensaje no es JSON valido."}, status=400)

    vote = str(payload.get("vote") or payload.get("feedback") or "up").strip().lower()
    if vote in {"down", "thumbs_down", "dislike", "-1"}:
        # Pulgar abajo: solo acuse (no se usa como ejemplo ideal).
        return JsonResponse({"ok": True, "saved": False, "vote": "down"})

    pregunta = str(
        payload.get("pregunta_usuario")
        or payload.get("user_text")
        or payload.get("question")
        or ""
    ).strip()
    respuesta = str(
        payload.get("respuesta_ideal")
        or payload.get("bot_text")
        or payload.get("reply")
        or ""
    ).strip()
    intent = str(
        payload.get("intencion_y_filtros")
        or payload.get("intent")
        or ""
    ).strip()
    session_raw = payload.get("session_id") or payload.get("sessionId")
    session_id = (
        str(session_raw).strip()
        if isinstance(session_raw, str) and session_raw.strip()
        else None
    )
    if not pregunta or not respuesta:
        return JsonResponse(
            {"error": "Faltan pregunta_usuario o respuesta_ideal."},
            status=400,
        )

    try:
        from inventario.ai.learned_examples import save_learned_example

        row, err = save_learned_example(
            pregunta_usuario=pregunta,
            intencion_y_filtros=intent,
            respuesta_ideal=respuesta,
            source="thumbs_up",
            session_id=session_id,
        )
    except Exception as exc:  # noqa: BLE001
        return JsonResponse({"ok": False, "error": str(exc)}, status=500)

    if err:
        return JsonResponse({"ok": False, "error": err}, status=502)
    return JsonResponse(
        {
            "ok": True,
            "saved": True,
            "vote": "up",
            "id": (row or {}).get("id"),
            "embedded": bool((row or {}).get("embedded")),
        }
    )


@csrf_exempt
@require_POST
def chat_reiniciar(request):
    """Borra el historial pydantic-ai de la sesión en Supabase."""
    try:
        payload = json.loads(request.body.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        return JsonResponse({"error": "El mensaje no es JSON valido."}, status=400)

    session_raw = payload.get("session_id") or payload.get("sessionId")
    session_id = (
        str(session_raw).strip()
        if isinstance(session_raw, str) and session_raw.strip()
        else ""
    )
    if not session_id:
        return JsonResponse({"error": "Falta session_id."}, status=400)

    try:
        from inventario.ai.session_memory import clear_session_messages

        ok = clear_session_messages(session_id)
    except Exception as exc:  # noqa: BLE001
        return JsonResponse({"ok": False, "error": str(exc)}, status=500)

    return JsonResponse({"ok": bool(ok), "session_id": session_id})
