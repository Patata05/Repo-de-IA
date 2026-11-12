from __future__ import annotations

import json
import re
import time
import unicodedata

from inventario.ai.client import (
    LlmEndpoint,
    get_llm_endpoints,
    get_token_budget,
)
from inventario.ai.local_fallback import local_chat_answer, pick_ack_reply
from inventario.ai.tools import OPENAI_TOOLS, dump_tool_result, run_tool

SYSTEM_PROMPT = """Eres el asistente experto de inventario de oficina (español de México).
Eres ágil, proactivo y preciso: das contexto claro, cifras exactas y siguientes pasos útiles,
sin inventar datos.

REGLA DE ALCANCE ESTRICTA:
- Respondes TODO lo relacionado con el inventario (totales, áreas, personas, etiquetas, series, marcas, modelos, estados activo/inactivo, observaciones, orígenes, recientes, códigos QR, altas, bajas, modificaciones e importación de archivos Excel/CSV).
- Si preguntan algo ajeno al inventario, indícalo con amabilidad en 1 línea y ofrece opciones de consulta del inventario.
- Responde SIEMPRE con datos reales de las herramientas. NUNCA inventes totales ni redondees a 1000.
- Cuando una herramienta devuelve `"total"` y `"count"`, `"total"` es el total real de coincidencias en el inventario y `"count"` es la muestra cargada en el visor derecho. Reporta siempre `"total"` como la cifra principal.

Ortografía:
- El usuario puede escribir con errores (ej. "generla", "inventaro", "codigos", "bbliteca").
- Interpreta la intención más cercana y actúa igual que si estuviera bien escrito.

Consultas y herramientas (optimiza en UNA sola ronda cuando sea posible):
- "cuántos" / total del inventario → contar_total o resumen_inventario.
- "cuántos registros tiene [persona]" / "qué tiene [persona]" → UNA sola
  contar_por_campo campo=persona valor="[nombre]" (devuelve total + items para el visor).
- Área (ej. Biblioteca, "EDIF B", "edificio B", "dame toda su información")
  → UNA sola contar_por_campo campo=area valor="EDIF B" (o el nombre).
- Búsqueda libre o combinada (artículo, marca, modelo, serie, observación) → buscar_inventario.
- Etiqueta concreta → obtener_por_etiqueta.
- "último registro", "los de hoy", "más recientes" → listar_recientes (el último: limit=1; hoy: solo_hoy=true).
- "dame N etiquetas", "muéstrame etiquetas", "trece etiquetas de [área]"
  → buscar_inventario o contar_por_campo con limit=N (máx. 50).
  NUNCA uses generar_qr si solo piden "etiquetas" ("etiquetas" ≠ "códigos QR").
- "dame un QR", "código QR de …" → generar_qr (etiqueta, id, query+limit o ultimo=true, máx. 7).

Importación Excel/CSV:
- El usuario puede adjuntar el archivo EN ESTE chat (+ → Excel/CSV o arrastrar).
- NUNCA llames crear_articulo en bucle para un Excel/CSV.

Cambios (actualizar / crear / eliminar):
- Si piden cambiar datos: primero busca el registro y PROPÓN el cambio.
- Formato OBLIGATORIO de la propuesta (una línea por cambio):
  • **ETIQUETA** · **campo** · “valor actual” → “valor nuevo”
- NUNCA llames actualizar_campo ni crear_articulo hasta que el usuario confirme (sí / confirma / adelante / ok / dale).
- Eliminar registros: pide la etiqueta si falta y aclara que debe confirmar en el aviso modal.
- Comparar inventarios (Inventario N vs S/O): resume faltan X / sobran Y / cambiaron Z; no digas solo “hay duplicados”.
- Si el mensaje es vago o ambiguo (“no se ven”, “eso”, “y eso”), NO inventes una búsqueda distinta: pregunta qué acción quiere o reutiliza el contexto del mensaje anterior.

ESTRUCTURA VISUAL UNIFORME (OBLIGATORIA EN CADA RESPUESTA):
1. **Resumen ejecutivo inicial (1 párrafo breve):** Empieza directamente con la cifra exacta y el hallazgo principal usando **negritas** para cifras, áreas, personas, marcas y etiquetas.
2. **Desglose en viñetas (`• **Clave:** Valor`):** Presenta de 3 a 6 puntos clave alineados y uniformes (ej. desglose por área/estado o muestra de registros con formato `• **Etiqueta** — Artículo · Marca (Área · Persona)`).
3. **Cierre y visor derecho (1 línea):** Indica que el detalle interactivo está en el visor derecho y sugiere 1 o 2 acciones concretas para continuar.
- NUNCA menciones nombres internos de funciones/tools (como `buscar_inventario`, `contar_por_campo`, `generar_qr`) ni escribas etiquetas como "Sugerencia 1:".
- NO pongas tablas markdown largas en el chat; usa viñetas limpias porque el listado completo ya aparece en el visor derecho.
- Memoria entre chats: si el bloque memory trae "lastFieldChange" o "previousTotal", úsalo con naturalidad cuando pregunten "cuántos había antes" o "pon el nombre que tenía antes".
"""

MAX_TOOL_ROUNDS = 3
MAX_SIDE_ITEMS = 50
MAX_HISTORY_TURNS = 8
MAX_HISTORY_CHARS = 550
MAX_MEMORY_CHARS = 1400
MAX_RETRIES_PER_MODEL = 1
RETRY_SLEEP_SEC = (0.18,)
MAX_COMPLETION_TOKENS = 520


def _estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, (len(text) + 3) // 4)


def _estimate_messages_tokens(messages: list[dict]) -> int:
    total = 0
    for m in messages:
        total += 4 + _estimate_tokens(str(m.get("content") or ""))
        for tc in m.get("tool_calls") or []:
            fn = tc.get("function") or {}
            total += 8 + _estimate_tokens(str(fn.get("name") or "")) + _estimate_tokens(str(fn.get("arguments") or ""))
    return total


def _build_usage_dict(
    *,
    prompt_tokens: int,
    completion_tokens: int,
    provider: str,
    model: str,
    key_fingerprint: str,
    rounds: int = 1,
) -> dict:
    total_tokens = prompt_tokens + completion_tokens
    budget = get_token_budget(provider, model)
    return {
        "prompt_tokens": int(prompt_tokens),
        "completion_tokens": int(completion_tokens),
        "total_tokens": int(total_tokens),
        "token_budget": int(budget),
        "provider": provider,
        "model": model,
        "key_fingerprint": key_fingerprint,
        "rounds": int(rounds),
    }


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
        or "410" in text
        or "NOT FOUND" in text
        or "DOES NOT EXIST" in text
        or "NOT_FOUND" in text
        or ("MODEL" in text and "INVALID" in text)
    )


def _resolve_preferred_target(
    endpoints: list[LlmEndpoint], preferred_model: str | None
) -> tuple[LlmEndpoint | None, str]:
    primary_ep = endpoints[0] if endpoints else None
    default_model = (
        primary_ep.models[0] if primary_ep and primary_ep.models else "local"
    )
    pref = (preferred_model or "").strip()
    if not pref or not endpoints:
        return primary_ep, default_model

    for ep in endpoints:
        for m in ep.models:
            if m.lower() == pref.lower():
                return ep, m
    return primary_ep, pref


def _chat_with_failover(
    messages: list[dict],
    preferred_model: str | None = None,
) -> tuple[object, str, LlmEndpoint, str]:
    endpoints = get_llm_endpoints()
    if not endpoints:
        raise RuntimeError("missing_providers")

    last_error: Exception | None = None
    saw_overload = False

    # Construir cola ordenada priorizando el modelo seleccionado por el usuario
    pref = (preferred_model or "").strip()
    candidates: list[tuple[LlmEndpoint, str]] = []
    seen_pairs: set[tuple[str, str, str]] = set()

    if pref:
        for ep in endpoints:
            for m in ep.models:
                if m.lower() == pref.lower():
                    key = (ep.provider, ep.key_fingerprint, m)
                    seen_pairs.add(key)
                    candidates.append((ep, m))
        if not candidates:
            # Si el usuario pidió un modelo válido del mismo proveedor aunque no esté en la tupla inicial
            ep0 = endpoints[0]
            key = (ep0.provider, ep0.key_fingerprint, pref)
            seen_pairs.add(key)
            candidates.append((ep0, pref))

    for ep in endpoints:
        for m in ep.models:
            key = (ep.provider, ep.key_fingerprint, m)
            if key not in seen_pairs:
                seen_pairs.add(key)
                candidates.append((ep, m))

    for endpoint, model in candidates:
        for attempt in range(MAX_RETRIES_PER_MODEL):
            try:
                completion = endpoint.client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=OPENAI_TOOLS,
                    tool_choice="auto",
                    temperature=0.15,
                    max_tokens=MAX_COMPLETION_TOKENS,
                )
                label = f"{endpoint.provider}:{model}"
                return completion, label, endpoint, model
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


def _norm_text(s: str) -> str:
    s = unicodedata.normalize("NFD", str(s or "").lower())
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _try_fast_inventory_query(message: str) -> tuple[str, list[dict], list[dict]] | None:
    """
    Atajos determinísticos en memoria (<15ms) para consultas del inventario:
    - Etiqueta exacta
    - Resumen general / total del inventario
    - Últimos registros / registros de hoy
    - Estado / salud del inventario y listado de inactivos
    - Rankings por área, marca o persona
    - Equipos sin asignar o con observaciones
    - Totales / listado de un área concreta
    - Búsquedas directas y combinadas (artículo + marca + área + persona)
    """
    from collections import Counter
    from inventario.ai.tools import _compact_row
    from inventario.supabase_client import (
        _extract_search_tokens,
        _fold_text,
        _token_matches_blob,
        get_by_etiqueta,
        listar_recientes,
        read_inventario,
        resumen_inventario,
        search_inventario_with_total,
    )

    raw = (message or "").strip()
    if not raw:
        return None
    msg = _norm_text(raw)
    if not msg:
        return None
    msg_words = set(msg.split())

    # No interceptar escrituras/cambios/borrados/QR/memoria/comparaciones complejas
    if msg_words & {
        "actualiza",
        "actualizar",
        "cambia",
        "cambiar",
        "modifica",
        "modificar",
        "crea",
        "crear",
        "agrega",
        "agregar",
        "elimina",
        "eliminar",
        "borra",
        "borrar",
        "restaura",
        "restaurar",
        "qr",
        "qrs",
        "importa",
        "importar",
        "excel",
        "csv",
        "antes",
        "anterior",
        "tenia",
        "habia",
        "compara",
        "comparar",
        "diferencia",
    }:
        return None

    # 1. Etiqueta exacta: "etiqueta 310285", "busca 310285", "ficha de 310285"
    tag_match = re.search(
        r"\b(?:etiqueta|codigo|ficha|registro|articulo)\s+(?:numero\s+|no\s+)?([a-z0-9_-]{4,20})\b",
        msg,
    ) or (re.fullmatch(r"(?:busca|buscar|dame|ver|muestra|mostrar|ensename)?\s*(\d{4,12})", msg))
    if tag_match:
        candidate_tag = tag_match.group(1).strip()
        found, err = get_by_etiqueta(candidate_tag)
        if not err and found:
            r = found[0]
            et = r.get("etiqueta") or candidate_tag
            art = r.get("articulo") or "Artículo"
            marca = r.get("marca") or "S/M"
            modelo = r.get("modelo") or "S/M"
            serie = r.get("serie") or "S/S"
            area = r.get("area") or "Sin área"
            persona = r.get("persona") or "Sin asignar"
            estado = r.get("estado") or "Activo"
            origen = r.get("origen") or "S/O"
            obs = r.get("observaciones")
            obs_line = f"\n• **Observaciones:** {obs}" if obs else ""
            text = (
                f"Encontré el registro con etiqueta **{et}** ({origen}):\n\n"
                f"• **Artículo:** {art} ({marca} · {modelo})\n"
                f"• **Serie:** {serie}\n"
                f"• **Área:** {area}\n"
                f"• **Asignado a:** {persona}\n"
                f"• **Estado:** {estado}{obs_line}\n\n"
                "La ficha interactiva ya está disponible en el visor derecho. "
                "¿Deseas generar su código QR, actualizar algún campo o consultar otro equipo?"
            )
            return text, [_compact_row(x) for x in found[:10]], []

    # 2. Resumen / total general del inventario
    if msg in {
        "cuantos articulos hay",
        "cuantos registros hay",
        "total del inventario",
        "total de inventario",
        "inventario general",
        "resumen del inventario",
        "resumen de inventario",
        "resumen general",
        "dame el inventario general",
        "muestrame el inventario general",
        "cuanto hay en el inventario",
        "cuantos equipos hay",
        "totales del inventario",
        "cuantos articulos hay en total",
        "cuantos equipos hay en total",
    } or (
        any(k in msg for k in ("resumen", "panorama", "estadistica", "estadisticas"))
        and "inventario" in msg
    ):
        data, err = resumen_inventario()
        if not err and data:
            total = data.get("total", 0)
            personas = data.get("personas", 0)
            areas = data.get("areas", 0)
            activos = data.get("activos_aprox", 0)
            inactivos = data.get("inactivos_aprox", 0)
            con_obs = data.get("con_observaciones", 0)
            text = (
                f"El inventario general cuenta con **{total:,}** registros distribuidos en "
                f"**{areas}** áreas y asignados a **{personas}** personas.\n\n"
                f"• **Equipos activos:** **{activos:,}** registros\n"
                f"• **Inactivos / Baja:** **{inactivos:,}** registros\n"
                f"• **Con observaciones:** **{con_obs:,}** registros\n\n"
                "En el visor derecho tienes el tablero con métricas, áreas principales y actividad reciente. "
                "¿Quieres desglosar por **área**, **marca**, **persona** o generar **códigos QR**?"
            )
            return text, [], []

    # 3. Últimos registros / recientes
    if msg in {
        "ultimos registros",
        "ultimo registro",
        "mas recientes",
        "registros recientes",
        "registros de hoy",
        "que se registro hoy",
        "dame los ultimos registros",
        "muestrame los ultimos registros",
        "ver ultimos registros",
        "ultimos articulos",
        "ultimas altas",
    }:
        solo_hoy = "hoy" in msg
        limit = 1 if "ultimo registro" in msg and not solo_hoy else 8
        rows, err = listar_recientes(limit=limit, solo_hoy=solo_hoy)
        if not err and rows:
            compact = [_compact_row(r) for r in rows]
            lines = []
            for r in compact[:5]:
                et = r.get("etiqueta") or "S/E"
                art = r.get("articulo") or "Artículo"
                per = r.get("persona") or "Sin asignar"
                ar = r.get("area") or "Sin área"
                lines.append(f"• **{et}** — {art} ({ar} · {per})")
            header = (
                "Aquí tienes el **último registro** dado de alta en el inventario:"
                if limit == 1
                else f"Estos son los **{len(compact)}** registros más recientes{' de hoy' if solo_hoy else ''}:"
            )
            text = (
                f"{header}\n\n"
                + "\n".join(lines)
                + "\n\nEl listado interactivo está en el visor derecho. "
                "¿Quieres inspeccionar la ficha de alguno o generar sus códigos QR?"
            )
            return text, compact, []

    # 4. Listado específico de equipos inactivos / dados de baja
    if msg in {
        "inactivos",
        "equipos inactivos",
        "articulos inactivos",
        "registros inactivos",
        "cuantos inactivos hay",
        "dame los inactivos",
        "muestrame los inactivos",
        "equipos dados de baja",
        "articulos de baja",
        "bajas del inventario",
    }:
        rows, err, _ = read_inventario()
        if not err and rows:
            inactivos_rows = [
                r
                for r in rows
                if str(r.get("estado") or "").strip().lower()
                not in ("", "activo", "si", "sí", "yes")
            ]
            total_inact = len(inactivos_rows)
            compact = [_compact_row(r) for r in inactivos_rows[:50]]
            if total_inact == 0:
                return (
                    "Actualmente **no hay registros inactivos** en el inventario; todos los equipos figuran como **Activos**.",
                    [],
                    [],
                )
            lines = [
                f"• **{r.get('etiqueta') or 'S/E'}** — {r.get('articulo') or 'Artículo'} ({r.get('area') or 'Sin área'} · {r.get('persona') or 'Sin asignar'})"
                for r in compact[:5]
            ]
            text = (
                f"Hay **{total_inact:,}** registro{'s' if total_inact != 1 else ''} con estado **Inactivo / Baja** en el inventario:\n\n"
                + "\n".join(lines)
                + "\n\nEn el visor derecho puedes explorar los registros encontrados. "
                "¿Quieres filtrar estos equipos por área o reactivar alguno?"
            )
            return text, compact, []

    # 5. Estado / salud del inventario (activos vs inactivos)
    if msg in {
        "estado",
        "por estado",
        "activos",
        "activos e inactivos",
        "estado del inventario",
        "salud del inventario",
        "cuantos activos hay",
    }:
        data, err = resumen_inventario()
        if not err and data:
            total = max(1, int(data.get("total") or 1))
            activos = int(data.get("activos_aprox") or 0)
            inactivos = int(data.get("inactivos_aprox") or 0)
            pct_act = round((activos / total) * 100, 1)
            text = (
                f"Estado operativo del inventario (**{total:,}** registros en total):\n\n"
                f"• **Activos:** **{activos:,}** equipos (**{pct_act}%**)\n"
                f"• **Inactivos / Baja:** **{inactivos:,}** equipos (**{round(100 - pct_act, 1)}%**)\n\n"
                "En el visor derecho puedes consultar el indicador de salud. "
                "¿Quieres listar los equipos inactivos o revisar un área específica?"
            )
            return text, [], []

    # 6. Ranking / distribución por áreas
    if msg in {
        "areas",
        "que areas hay",
        "cuales areas hay",
        "cuantas areas hay",
        "areas del inventario",
        "ranking de areas",
        "distribucion por areas",
        "articulos por area",
        "equipos por area",
        "desglose por area",
        "desglose por areas",
        "todas las areas",
    }:
        rows, err, _ = read_inventario()
        if not err and rows:
            counts = Counter(
                str(r.get("area") or "Sin área").strip() or "Sin área" for r in rows
            )
            total = len(rows)
            top_areas = counts.most_common(6)
            lines = [
                f"• **{area}:** **{cnt:,}** registros ({round((cnt / max(1, total)) * 100, 1)}%)"
                for area, cnt in top_areas
            ]
            text = (
                f"El inventario está distribuido en **{len(counts)}** áreas (**{total:,}** registros en total). "
                "Las áreas con mayor concentración son:\n\n"
                + "\n".join(lines)
                + "\n\nEn el visor derecho tienes la distribución gráfica por áreas. "
                "Dime el nombre de cualquier área para listar todos sus equipos."
            )
            return text, [], []

    # 7. Ranking / distribución por marcas
    if msg in {
        "marcas",
        "que marcas hay",
        "cuales marcas hay",
        "cuantas marcas hay",
        "marcas del inventario",
        "ranking de marcas",
        "distribucion por marcas",
        "articulos por marca",
        "equipos por marca",
        "desglose por marca",
        "desglose por marcas",
        "todas las marcas",
    }:
        rows, err, _ = read_inventario()
        if not err and rows:
            counts = Counter(
                str(r.get("marca") or "Sin marca").strip().upper() or "SIN MARCA"
                for r in rows
            )
            total = len(rows)
            unbranded_keys = {"S/M", "SIN MARCA", "SIN MCA.", "SIN MCA", "S/MCA", "N/A", "NONE", ""}
            top_brands = [
                (b, c)
                for b, c in counts.most_common(12)
                if b not in unbranded_keys
            ][:6]
            if not top_brands:
                top_brands = counts.most_common(6)
            lines = [
                f"• **{brand}:** **{cnt:,}** equipos ({round((cnt / max(1, total)) * 100, 1)}%)"
                for brand, cnt in top_brands
            ]
            sin_marca = sum(
                counts.get(k, 0) for k in unbranded_keys
            )
            extra = (
                f"\n• **Sin marca especificada (S/M):** **{sin_marca:,}** registros"
                if sin_marca
                else ""
            )
            text = (
                f"Se registran **{len(counts)}** marcas distintas en el inventario (**{total:,}** equipos). "
                "Las marcas principales son:\n\n"
                + "\n".join(lines)
                + extra
                + "\n\n¿Qué marca o tipo de equipo te gustaría listar en el visor derecho?"
            )
            return text, [], []

    # 8. Ranking / distribución por personas
    if msg in {
        "personas",
        "que personas hay",
        "cuantas personas hay",
        "quien tiene mas equipos",
        "quien tiene mas articulos",
        "ranking de personas",
        "articulos por persona",
        "equipos por persona",
        "resguardantes",
        "distribucion por persona",
    }:
        rows, err, _ = read_inventario()
        if not err and rows:
            counts = Counter(
                str(r.get("persona") or "").strip()
                for r in rows
                if str(r.get("persona") or "").strip()
                and _norm_text(str(r.get("persona") or ""))
                not in {"sin asignar", "no asignado", "s a", "n a", "na"}
            )
            top_people = counts.most_common(6)
            lines = [
                f"• **{person}:** **{cnt:,}** equipos asignados"
                for person, cnt in top_people
            ]
            text = (
                f"Hay **{len(counts)}** personas con resguardo activo en el inventario. "
                "Quienes concentran más registros son:\n\n"
                + "\n".join(lines)
                + "\n\nEscribe el nombre de cualquier persona para ver sus artículos en el visor derecho."
            )
            return text, [], []

    # 9. Equipos sin asignar / con observaciones
    if any(
        phrase in msg
        for phrase in (
            "sin asignar",
            "no asignados",
            "sin persona",
            "sin resguardante",
        )
    ):
        rows, err, _ = read_inventario()
        if not err and rows:
            unassigned = [
                r
                for r in rows
                if not str(r.get("persona") or "").strip()
                or _norm_text(str(r.get("persona") or ""))
                in {"sin asignar", "no asignado", "s a", "n a", "na", "ninguno"}
            ]
            total_u = len(unassigned)
            compact = [_compact_row(r) for r in unassigned[:50]]
            if total_u == 0:
                return (
                    "Todos los registros del inventario cuentan actualmente con una **persona asignada**.",
                    [],
                    [],
                )
            lines = [
                f"• **{r.get('etiqueta') or 'S/E'}** — {r.get('articulo') or 'Artículo'} ({r.get('area') or 'Sin área'})"
                for r in compact[:5]
            ]
            text = (
                f"Encontré **{total_u:,}** registro{'s' if total_u != 1 else ''} **sin persona asignada**:\n\n"
                + "\n".join(lines)
                + "\n\nEl listado está disponible en el visor derecho. "
                "¿Quieres asignar alguno a un responsable o filtrar por área?"
            )
            return text, compact, []

    if any(
        phrase in msg
        for phrase in (
            "con observaciones",
            "tienen observaciones",
            "registros con observaciones",
            "articulos con observaciones",
            "equipos con observaciones",
        )
    ):
        rows, err, _ = read_inventario()
        if not err and rows:
            with_obs = [
                r for r in rows if str(r.get("observaciones") or "").strip()
            ]
            total_obs = len(with_obs)
            compact = [_compact_row(r) for r in with_obs[:50]]
            lines = [
                f"• **{r.get('etiqueta') or 'S/E'}** — {r.get('articulo') or 'Artículo'}: *{str(r.get('observaciones'))[:70]}*"
                for r in compact[:5]
            ]
            text = (
                f"Hay **{total_obs:,}** registro{'s' if total_obs != 1 else ''} con **observaciones** registradas:\n\n"
                + "\n".join(lines)
                + "\n\nPuedes revisar cada ficha en el visor derecho. "
                "¿Deseas filtrar las observaciones por área o actualizar alguna nota?"
            )
            return text, compact, []

    # 10. Total/info de un área concreta (solo cuando no se pide un artículo/marca específico dentro del área)
    area_fast = _try_area_total_fast(message)
    if area_fast is not None:
        text, items = area_fast
        return text, items, []

    # 11. Búsqueda estructurada rápida (artículo, marca, persona o combinación como "laptops dell")
    # No interceptar anáforas ("esas etiquetas", "las de arriba") ni reparaciones de visor
    # ("no se ven"): el front reusa el resultado previo.
    msg_anaphora = _norm_text(message or "")
    if re.search(
        r"\b(esas|esos|estas|estos|esa|ese|este|esta|arriba|anteriores?|previas?|mismas?|mismos)\b",
        msg_anaphora,
    ) or re.search(
        r"\bno\s+se\s+(ve|ven|veen|nota|notan|muestra|muestran)\b"
        r"|\bno\s+(aparecen|aparece|salen|sale)\b"
        r"|\bno\s+(los|las)\s+(veo|ve|aparecen|estan)\b"
        r"|\bno\s+me\s+(los|las)?\s*(veo|aparecen)\b"
        r"|\b(donde|dónde)\s+(estan|están|esta|está|quedo|quedó|queda)\b"
        r"|\b(abre|abrir|muestra|mostrar|pon|poner)\s+(el\s+)?(visor|panel|listado)\b",
        msg_anaphora,
    ):
        pass
    else:
        search_fast = _try_structured_search_fast(message)
        if search_fast is not None:
            text, items = search_fast
            return text, items, []

    return None


def _try_area_total_fast(message: str) -> tuple[str, list[dict]] | None:
    """Resuelve total/info de un área (con desambiguación si coinciden varias áreas) sin rondas de LLM."""
    from collections import Counter
    from inventario.ai.tools import _compact_row
    from inventario.supabase_client import (
        _extract_search_tokens,
        read_inventario,
    )

    raw = (message or "").strip()
    if not raw:
        return None

    msg = _norm_text(raw)
    if re.search(r"\b\d{4,}\b", msg):
        return None
    if ("todas" in msg or "todos" in msg) and ("area" in msg or "areas" in msg):
        return None

    rows, error, _ = read_inventario()
    if error or not rows:
        return None

    def area_fold(area: str) -> str:
        return re.sub(r"\b(?:edificios?|edifs)\b", "edif", _norm_text(area))

    by_area: dict[str, list[dict]] = {}
    for r in rows:
        a = str(r.get("area") or "").strip()
        if not a:
            continue
        by_area.setdefault(a, []).append(r)

    if not by_area:
        return None

    area_vocab: set[str] = set()
    area_folded_map: dict[str, list[str]] = {}
    for a_name in by_area:
        f = area_fold(a_name)
        toks = f.split()
        area_folded_map[a_name] = toks
        area_vocab.update(toks)

    # Limpiar expresiones de cantidad ("7 registros", "10 etiquetas")
    msg_clean = re.sub(
        r"\b(\d{1,3}|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte|treinta|cuarenta|cincuenta)\s+(?:registros?|etiquetas?|articulos?|equipos?|codigos?|qr)\b",
        " ",
        msg,
    )
    msg_clean = re.sub(r"\b(?:edificios?|edifs)\b", "edif", msg_clean)

    stop_area = {
        "area",
        "areas",
        "de",
        "del",
        "la",
        "el",
        "los",
        "las",
        "en",
        "al",
        "un",
        "una",
        "dame",
        "dime",
        "muestra",
        "mostrar",
        "muestrame",
        "ensename",
        "ensenar",
        "ensena",
        "ver",
        "trae",
        "lista",
        "listar",
        "busca",
        "buscar",
        "consulta",
        "consultar",
        "registro",
        "registros",
        "etiqueta",
        "etiquetas",
        "articulo",
        "articulos",
        "equipo",
        "equipos",
        "informacion",
        "infomacion",
        "info",
        "datos",
        "detalle",
        "resumen",
        "total",
        "totales",
        "conteo",
        "cuantos",
        "cuantas",
        "cuanto",
        "cuanta",
        "hay",
        "tiene",
        "tienen",
        "que",
        "cual",
        "cuales",
        "esta",
        "estan",
        "existe",
        "existen",
        "incidencia",
        "incidencias",
        "inventario",
        "inventarios",
        "por",
        "favor",
        "para",
        "con",
        "sobre",
    }

    cand_tokens = [t for t in msg_clean.split() if t and t not in stop_area]
    if not cand_tokens:
        return None

    # Si algún token NO pertenece al vocabulario de áreas (ej. "laptops", "dell"),
    # delegar a búsqueda estructurada de artículos
    if not all(t in area_vocab for t in cand_tokens):
        return None

    matching_areas = [
        a_name
        for a_name, a_toks in area_folded_map.items()
        if all(qt in a_toks for qt in cand_tokens)
    ]
    if not matching_areas:
        return None

    matching_areas.sort(key=lambda a: (-len(by_area[a]), a))

    if len(matching_areas) > 1:
        query_label = " ".join(cand_tokens)
        total_combined = sum(len(by_area[a]) for a in matching_areas)
        all_people = {
            str(r.get("persona") or "").strip()
            for a in matching_areas
            for r in by_area[a]
            if str(r.get("persona") or "").strip()
        }
        lines = []
        for idx, a_name in enumerate(matching_areas, 1):
            a_rows = by_area[a_name]
            a_people = {
                str(r.get("persona") or "").strip()
                for r in a_rows
                if str(r.get("persona") or "").strip()
            }
            a_activos = sum(
                1
                for r in a_rows
                if str(r.get("estado") or "").strip().lower()
                not in {"inactivo", "baja", "no", "inactive"}
            )
            lines.append(
                f"• **{idx}. {a_name}** — **{len(a_rows):,}** registro{'s' if len(a_rows) != 1 else ''} "
                f"({len(a_people)} persona{'s' if len(a_people) != 1 else ''} · {a_activos} activo{'s' if a_activos != 1 else ''})"
            )
        text = (
            f"Encontré **{len(matching_areas)} áreas** en el inventario que coinciden con **«{query_label}»** "
            f"(**{total_combined:,} registros** y **{len(all_people)} persona{'s' if len(all_people) != 1 else ''}** en conjunto):\n\n"
            + "\n".join(lines)
            + f"\n\nPara evitar ambigüedad, ¿a cuál de estas **{len(matching_areas)} áreas** deseas consultar? "
            f"Indícame el **número de opción (1 al {len(matching_areas)})** o el **nombre específico del área**."
        )
        return text, []

    chosen_area = matching_areas[0]
    matched_rows = by_area[chosen_area]
    total = len(matched_rows)
    personas = {
        str(r.get("persona") or "").strip()
        for r in matched_rows
        if str(r.get("persona") or "").strip()
    }
    activos = sum(
        1
        for r in matched_rows
        if str(r.get("estado") or "").strip().lower()
        not in {"inactivo", "baja", "no", "inactive"}
    )
    top_articles = Counter(
        str(r.get("articulo") or "Artículo").strip() for r in matched_rows
    ).most_common(4)
    art_lines = [
        f"• **{art}:** {cnt} registro{'s' if cnt != 1 else ''}"
        for art, cnt in top_articles
    ]
    compact_sample = [_compact_row(r) for r in matched_rows[:50]]
    text = (
        f"En el área **{chosen_area}** hay **{total:,}** registro{'s' if total != 1 else ''} "
        f"(**{activos:,}** activo{'s' if activos != 1 else ''} · **{len(personas)}** persona{'s' if len(personas) != 1 else ''}):\n\n"
        + "\n".join(art_lines)
        + "\n\nEl listado completo ya está en el visor derecho. "
        "¿Quieres filtrar por persona, buscar un equipo específico o generar códigos QR?"
    )
    return text, compact_sample


def _try_structured_search_fast(message: str) -> tuple[str, list[dict]] | None:
    """
    Resuelve búsquedas directas y combinadas de artículos, marcas, personas o áreas
    (ej. "busca si hay laptops dell", "cuántas impresoras hp hay", "qué tiene García")
    en <15ms asegurando coincidencia exacta de todos los términos relevantes.
    """
    from collections import Counter
    from inventario.ai.tools import _compact_row
    from inventario.supabase_client import (
        _extract_search_tokens,
        _fold_text,
        _token_matches_blob,
        search_inventario_with_total,
    )

    raw = (message or "").strip()
    if not raw:
        return None
    msg = _norm_text(raw)
    if len(msg) > 95:
        return None

    # Solo activar cuando la intención es claramente de consulta/búsqueda/conteo
    has_query_intent = any(
        w in msg.split()
        for w in (
            "busca",
            "buscar",
            "buscame",
            "busques",
            "hay",
            "existe",
            "existen",
            "cuantos",
            "cuantas",
            "cuanto",
            "cuanta",
            "dame",
            "dime",
            "diga",
            "digas",
            "muestra",
            "mostrar",
            "muestrame",
            "ver",
            "lista",
            "listar",
            "tiene",
            "tienen",
            "equipos",
            "articulos",
            "registros",
            "quiero",
            "gustaria",
            "quisiera",
            "necesito",
        )
    )
    tokens = _extract_search_tokens(raw)
    if not tokens or len(tokens) > 5:
        return None
    if not has_query_intent and len(tokens) > 3:
        return None

    # Buscar solo con la(s) palabra(s) clave, no con toda la frase.
    keyword_query = " ".join(tokens)
    rows, total_found, err = search_inventario_with_total(keyword_query, limit=50)
    if err:
        return None

    subject = " / ".join(t.upper() for t in tokens)

    # Verificar si el primer resultado cumple TODOS los tokens clave
    if rows:
        top = rows[0]
        top_blob = " ".join(
            _fold_text(top.get(k))
            for k in (
                "etiqueta",
                "articulo",
                "marca",
                "modelo",
                "serie",
                "area",
                "persona",
                "origen",
                "estado",
                "observaciones",
            )
        )
        top_blob_tokens = set(top_blob.split())
        matched = [
            t for t in tokens if _token_matches_blob(t, top_blob, top_blob_tokens)
        ]
        all_matched = len(matched) == len(tokens)
        if not all_matched and len(tokens) > 1:
            # Si falla el AND, reintenta con la palabra clave más larga (ej. tarjas).
            primary = max(tokens, key=len)
            rows2, total2, err2 = search_inventario_with_total(primary, limit=50)
            if not err2 and rows2:
                rows, total_found = rows2, total2
                tokens = [primary]
                subject = primary.upper()
                all_matched = True
        if not all_matched:
            if any(
                w in msg.split()
                for w in (
                    "hay",
                    "cuantos",
                    "cuantas",
                    "busca",
                    "buscar",
                    "existe",
                    "existen",
                    "digas",
                    "dime",
                    "quiero",
                    "gustaria",
                )
            ):
                return (
                    f"No encontré coincidencia exacta para **{subject}**.\n\n"
                    f"• Había **{len(rows)}** resultado(s) parciales en el visor derecho.\n\n"
                    "¿Quieres que busque solo por esa palabra clave, por marca o por área?",
                    [_compact_row(r) for r in rows[:20]],
                )
            return None
    else:
        if has_query_intent:
            return (
                f"No se encontraron registros para **{subject}** en el inventario actual.\n\n"
                "Verifica la etiqueta, marca o nombre, o dime si deseas dar de alta un artículo.",
                [],
            )
        return None

    compact = [_compact_row(r) for r in rows[:50]]
    activos = sum(
        1
        for r in rows
        if str(r.get("estado") or "").strip().lower()
        not in {"inactivo", "baja", "no", "inactive"}
    )
    area_counts = Counter(
        str(r.get("area") or "Sin área").strip() or "Sin área" for r in rows
    ).most_common(3)
    area_summary = ", ".join(f"**{a}** ({c})" for a, c in area_counts)

    sample_lines = []
    for r in compact[:5]:
        et = r.get("etiqueta") or "S/E"
        art = r.get("articulo") or "Artículo"
        marca = r.get("marca")
        marca_s = f" · {marca}" if marca and str(marca).upper() not in {"S/M", "SIN MARCA"} else ""
        ar = r.get("area") or "Sin área"
        per = r.get("persona") or "Sin asignar"
        sample_lines.append(f"• **{et}** — {art}{marca_s} ({ar} · {per})")

    subject_label = " ".join(tokens).upper()
    more_note = (
        f" (mostrando los primeros **{len(compact)}** en el visor)"
        if total_found > len(compact)
        else ""
    )
    text = (
        f"Encontré **{total_found:,}** registro{'s' if total_found != 1 else ''} para **{subject_label}** "
        f"(**{activos:,}** activo{'s' if activos != 1 else ''}){more_note}.\n"
        f"Principales áreas: {area_summary}.\n\n"
        + "\n".join(sample_lines)
        + "\n\nEl listado interactivo está en el visor derecho. "
        "¿Quieres abrir alguna ficha, filtrar por área o generar códigos QR?"
    )
    return text, compact


def run_chat_agent(
    message: str,
    history: list[dict] | None = None,
    memory: str | None = None,
    preferred_model: str | None = None,
) -> tuple[str, str | None, str | None, list[dict], bool, list[dict], dict]:
    endpoints = get_llm_endpoints()
    primary_ep, default_model = _resolve_preferred_target(endpoints, preferred_model)
    default_provider = primary_ep.provider if primary_ep else "local"
    default_fp = primary_ep.key_fingerprint if primary_ep else "local"

    if not endpoints:
        return (
            "No hay proveedores de IA listos. Configura NVIDIA_API_KEY, MODEL_API_KEY, GROQ_API_KEY o GEMINI_API_KEY.",
            "missing_key",
            None,
            [],
            False,
            [],
            _build_usage_dict(
                prompt_tokens=0,
                completion_tokens=0,
                provider="local",
                model="local",
                key_fingerprint="local",
                rounds=0,
            ),
        )

    memory_text = (memory or "").strip()
    if len(memory_text) > MAX_MEMORY_CHARS:
        memory_text = memory_text[: MAX_MEMORY_CHARS - 1] + "…"

    # Saludos / ayuda simple: respuesta instantánea sin round-trip al LLM.
    msg_l = (message or "").strip().lower().rstrip("!?.")
    if msg_l in {
        "hola",
        "buenas",
        "hey",
        "hi",
        "hello",
        "qué tal",
        "que tal",
        "saludos",
        "buen dia",
        "buen día",
        "buenos dias",
        "buenos días",
        "buenas tardes",
        "buenas noches",
    }:
        local_text, local_items = local_chat_answer("hola")
        return (
            local_text,
            None,
            f"{default_provider}:{default_model}",
            local_items[:MAX_SIDE_ITEMS],
            False,
            [],
            _build_usage_dict(
                prompt_tokens=_estimate_tokens(message),
                completion_tokens=_estimate_tokens(local_text),
                provider=default_provider,
                model=default_model,
                key_fingerprint=default_fp,
                rounds=0,
            ),
        )
    if msg_l in {
        "ayuda",
        "qué puedes",
        "que puedes",
        "que puedes hacer",
        "qué puedes hacer",
        "qué puedo preguntarte del inventario",
        "que puedo preguntarte del inventario",
    }:
        local_text, local_items = local_chat_answer("ayuda")
        return (
            local_text,
            None,
            f"{default_provider}:{default_model}",
            local_items[:MAX_SIDE_ITEMS],
            False,
            [],
            _build_usage_dict(
                prompt_tokens=_estimate_tokens(message),
                completion_tokens=_estimate_tokens(local_text),
                provider=default_provider,
                model=default_model,
                key_fingerprint=default_fp,
                rounds=0,
            ),
        )

    # Acuses sin pedido concreto: solo texto instantáneo.
    if msg_l in {
        "ok",
        "okay",
        "okey",
        "oke",
        "vale",
        "va",
        "sale",
        "bueno",
        "bien",
        "gracias",
        "thanks",
        "de acuerdo",
        "perfecto",
        "listo",
        "entendido",
        "claro",
        "dale",
        "esta bien",
        "está bien",
    }:
        ack_text = pick_ack_reply()
        return (
            ack_text,
            None,
            f"{default_provider}:{default_model}",
            [],
            False,
            [],
            _build_usage_dict(
                prompt_tokens=_estimate_tokens(message),
                completion_tokens=_estimate_tokens(ack_text),
                provider=default_provider,
                model=default_model,
                key_fingerprint=default_fp,
                rounds=0,
            ),
        )

    # Consultas directas frecuentes → resolución en caché (<15ms) con datos exactos
    fast_result = _try_fast_inventory_query(message)
    if fast_result is not None:
        text, items, qrs = fast_result
        return (
            text,
            None,
            f"{default_provider}:{default_model}",
            items[:MAX_SIDE_ITEMS],
            False,
            qrs,
            _build_usage_dict(
                prompt_tokens=_estimate_tokens(message),
                completion_tokens=_estimate_tokens(text),
                provider=default_provider,
                model=default_model,
                key_fingerprint=default_fp,
                rounds=1,
            ),
        )

    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    if memory_text:
        messages.append(
            {
                "role": "system",
                "content": memory_text,
            }
        )
    recent_history = (history or [])[-MAX_HISTORY_TURNS:]
    for item in recent_history:
        role = str(item.get("role") or "").strip().lower()
        text = str(item.get("content") or item.get("text") or "").strip()
        if not text:
            continue
        if len(text) > MAX_HISTORY_CHARS:
            text = text[: MAX_HISTORY_CHARS - 1] + "…"
        if role in ("assistant", "bot", "model"):
            messages.append({"role": "assistant", "content": text})
        elif role in ("user", "human"):
            messages.append({"role": "user", "content": text})
    messages.append({"role": "user", "content": message})

    collected: list[dict] = []
    qr_payloads: list[dict] = []
    used_label: str | None = None
    used_ep: LlmEndpoint | None = primary_ep
    used_model_name: str = default_model
    mutated = False
    total_prompt_tokens = 0
    total_completion_tokens = 0
    rounds_run = 0

    try:
        for _ in range(MAX_TOOL_ROUNDS):
            rounds_run += 1
            completion, used_label, used_ep, used_model_name = _chat_with_failover(
                messages, preferred_model=preferred_model
            )
            raw_usage = getattr(completion, "usage", None)
            if raw_usage is not None:
                p_tok = int(getattr(raw_usage, "prompt_tokens", 0) or 0)
                c_tok = int(getattr(raw_usage, "completion_tokens", 0) or 0)
                t_tok = int(getattr(raw_usage, "total_tokens", 0) or 0)
                if p_tok == 0 and c_tok == 0 and t_tok > 0:
                    p_tok = int(t_tok * 0.75)
                    c_tok = t_tok - p_tok
                total_prompt_tokens += p_tok
                total_completion_tokens += c_tok
            else:
                total_prompt_tokens += _estimate_messages_tokens(messages)

            choice = completion.choices[0].message
            tool_calls = choice.tool_calls or []

            if not tool_calls:
                text = (choice.content or "").strip()
                if not raw_usage:
                    total_completion_tokens += _estimate_tokens(text)
                side = _side_items_for_reply(collected, qr_payloads)
                usage_info = _build_usage_dict(
                    prompt_tokens=total_prompt_tokens,
                    completion_tokens=total_completion_tokens,
                    provider=used_ep.provider if used_ep else default_provider,
                    model=used_model_name,
                    key_fingerprint=used_ep.key_fingerprint if used_ep else default_fp,
                    rounds=rounds_run,
                )
                if not text:
                    return (
                        "No pude formular una respuesta. Intenta de nuevo.",
                        "empty_text",
                        used_label,
                        side,
                        mutated,
                        qr_payloads,
                        usage_info,
                    )
                return (
                    text,
                    None,
                    used_label,
                    side,
                    mutated,
                    qr_payloads,
                    usage_info,
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

        side = _side_items_for_reply(collected, qr_payloads)
        usage_info = _build_usage_dict(
            prompt_tokens=total_prompt_tokens,
            completion_tokens=total_completion_tokens,
            provider=used_ep.provider if used_ep else default_provider,
            model=used_model_name,
            key_fingerprint=used_ep.key_fingerprint if used_ep else default_fp,
            rounds=rounds_run,
        )
        if side:
            n = len(side)
            return (
                f"Encontré **{n}** registro{'s' if n != 1 else ''} relacionados. "
                "El detalle está en el visor derecho. "
                "Si quieres, afina por persona, etiqueta o área.",
                None,
                used_label,
                side,
                mutated,
                qr_payloads,
                usage_info,
            )
        local_text, local_items = local_chat_answer(message)
        return (
            local_text,
            None,
            used_label or "local:fallback",
            local_items[:MAX_SIDE_ITEMS],
            mutated,
            qr_payloads,
            usage_info,
        )
    except Exception as exc:  # noqa: BLE001
        text = str(exc)
        usage_info = _build_usage_dict(
            prompt_tokens=total_prompt_tokens or _estimate_tokens(message),
            completion_tokens=total_completion_tokens,
            provider=used_ep.provider if used_ep else default_provider,
            model=used_model_name,
            key_fingerprint=used_ep.key_fingerprint if used_ep else default_fp,
            rounds=rounds_run,
        )
        if text.startswith("llm_unavailable:") or text == "missing_providers" or _is_retryable(exc):
            return (
                "Ningún proveedor de IA respondió. Reintento en unos segundos…",
                "llm_unavailable",
                used_label,
                _side_items_for_reply(collected, qr_payloads),
                mutated,
                qr_payloads,
                usage_info,
            )
        return (
            f"Error al consultar la IA: {exc}",
            str(exc),
            used_label,
            _side_items_for_reply(collected, qr_payloads),
            mutated,
            qr_payloads,
            usage_info,
        )
