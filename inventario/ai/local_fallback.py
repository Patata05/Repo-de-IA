"""Respuestas locales si los proveedores IA no están disponibles."""

from __future__ import annotations

import random
import re

from inventario.supabase_client import (
    count_inventario,
    count_por_campo,
    listar_recientes,
    read_inventario,
    search_inventario,
    resumen_inventario,
)

_GREETING_REPLIES = (
    (
        "¡Hola! Estoy listo para ayudarte con el inventario: consultas por "
        "persona o área, etiquetas, QR, altas o importar un Excel/CSV. "
        "¿Qué te gustaría hacer primero?"
    ),
    (
        "¡Qué tal! Puedo buscar registros, ver totales, generar códigos QR "
        "o ayudarte a pasar datos entre personas y áreas. ¿Por dónde empezamos?"
    ),
    (
        "¡Hola! Cuéntame qué necesitas del inventario y lo vemos juntos. "
        "Si quieres, prueba con algo como «qué tiene Juan» o «equipos de Biblioteca»."
    ),
    (
        "¡Bienvenido! Soy tu asistente de inventario. Dime qué quieres "
        "revisar o cambiar y te guío en lenguaje natural."
    ),
)

_HELP_REPLIES = (
    (
        "Puedo consultar el inventario con datos reales, filtrar por persona "
        "o área, mostrar listados en el visor, generar QR, importar Excel/CSV "
        "y ayudarte con cambios o traspasos (siempre con confirmación). "
        "¿Qué quieres hacer ahora?"
    ),
    (
        "Piénsame como un chat del inventario: me pides algo en español "
        "normal y te respondo con cifras y contexto. Por ejemplo, "
        "«dame lo que tiene Juan Pérez» o «mueve todo de Juan a María». "
        "¿Con qué empezamos?"
    ),
    (
        "Sirvo para buscar, contar, mostrar en el panel, armar QR e importar "
        "archivos. Dime la tarea en una frase y lo resolvemos."
    ),
)

_ACK_REPLIES = (
    (
        "Perfecto. Cuando quieras seguimos: puedo revisar a alguien, un área, "
        "una etiqueta, armar QR o importar un archivo. ¿Qué hacemos?"
    ),
    (
        "Va. Si quieres, vemos un área o una persona, buscamos una etiqueta, "
        "traemos lo reciente o te ayudo a importar un Excel. ¿Qué te late?"
    ),
    (
        "Listo. Estoy aquí para lo que necesites del inventario; "
        "dime la siguiente consulta cuando quieras."
    ),
    (
        "De acuerdo. ¿Seguimos con una búsqueda, un total, QR o una importación?"
    ),
    (
        "¡Hecho! Cuando quieras, dime persona, área, etiqueta o lo que "
        "necesites y lo vemos."
    ),
)


def pick_greeting_reply() -> str:
    return random.choice(_GREETING_REPLIES)


def pick_help_reply() -> str:
    return random.choice(_HELP_REPLIES)


def pick_ack_reply() -> str:
    return random.choice(_ACK_REPLIES)

STOPWORDS = {
    "el",
    "la",
    "los",
    "las",
    "un",
    "una",
    "de",
    "del",
    "en",
    "con",
    "por",
    "para",
    "que",
    "qué",
    "quien",
    "quién",
    "tiene",
    "hay",
    "donde",
    "dónde",
    "como",
    "cómo",
    "dime",
    "buscar",
    "busca",
    "ver",
    "no",
    "se",
    "ven",
    "veo",
    "aparecen",
    "aparece",
    "visor",
    "panel",
}


def _clean_tokens(text: str) -> list[str]:
    cleaned = re.sub(r"[^\w\s]", " ", text.lower())
    return [t for t in cleaned.split() if len(t) > 1 and t not in STOPWORDS]


def local_chat_answer(message: str) -> tuple[str, list[dict]]:
    msg = message.lower().strip()
    items: list[dict] = []

    greetings = (
        "hola",
        "buen dia",
        "buenos dias",
        "buenas tardes",
        "buenas noches",
        "saludos",
        "hey",
        "que tal",
        "qué tal",
    )
    # Solo saludo puro (evita "hola dame el último registro…")
    if any(msg == g or msg == f"{g}!" for g in greetings):
        return (pick_greeting_reply(), [])

    if any(k in msg for k in ("ayuda", "qué puedes", "que puedes")):
        return (pick_help_reply(), [])

    # Traspaso masivo: lo confirma el front (sí/no). Evitar N updates 1×1.
    if (
        any(
            k in msg
            for k in (
                "mueve",
                "mover",
                "pasa",
                "pasar",
                "traslada",
                "trasladar",
                "transfiere",
                "transferir",
                "reasigna",
                "reasignar",
            )
        )
        and " a " in f" {msg} "
        and not any(k in msg for k in ("excel", "xlsx", "xls", "csv", "archivo"))
    ):
        return (
            "Para un traspaso masivo (persona o área) el chat te pedirá confirmación "
            "y aplicará el cambio en lote. Prueba con «mueve todo de Juan a María», "
            "«pasa todo de Sistemas a Biblioteca» o «pasa estos a María» "
            "(usando el listado del visor). Responde **sí** o **no** cuando te lo proponga.",
            [],
        )

    if any(
        k in msg
        for k in (
            "ultimo",
            "último",
            "reciente",
            "recien",
            "recién",
            "hoy",
            "nuevo",
            "nueva",
            "acabe",
            "acabo",
            "agregue",
            "agregué",
            "registre",
            "registré",
        )
    ) and any(
        k in msg
        for k in (
            "registro",
            "articulo",
            "artículo",
            "equipo",
            "alta",
            "entrada",
            "hice",
            "agreg",
            "cre",
        )
    ):
        solo_hoy = "hoy" in msg
        limit = 1 if any(k in msg for k in ("ultimo", "último")) and not solo_hoy else 5
        if solo_hoy and any(k in msg for k in ("ultimo", "último")):
            limit = 5
        rows, error = listar_recientes(limit=limit, solo_hoy=solo_hoy)
        if error:
            return f"No pude leer registros recientes: {error}", []
        if not rows:
            return (
                "No encontré registros recientes"
                + (" de hoy." if solo_hoy else ".")
                + " Revisa en Inventario o importa de nuevo.",
                [],
            )
        items = rows
        sample = rows[0]
        et = sample.get("etiqueta") or "S/E"
        art = (
            f"{sample.get('articulo') or ''} {sample.get('marca') or ''}".strip()
            or "artículo"
        )
        titulo = "Registros de hoy" if solo_hoy else "Últimos registros"
        more = f" ({len(rows)} en total)" if len(rows) > 1 else ""
        return (
            f"{titulo}{more} (modo local). El más reciente es {et}: {art} — "
            f"{sample.get('persona') or 'Sin asignar'} "
            f"({sample.get('area') or 'General'}). El detalle está en el visor.",
            items,
        )

    # "dame 5/trece etiquetas" → lista (sin QR)
    if "etiqueta" in msg and "qr" not in msg:
        words = {
            "un": 1,
            "uno": 1,
            "dos": 2,
            "tres": 3,
            "cuatro": 4,
            "cinco": 5,
            "seis": 6,
            "siete": 7,
            "ocho": 8,
            "nueve": 9,
            "diez": 10,
            "once": 11,
            "doce": 12,
            "trece": 13,
            "catorce": 14,
            "quince": 15,
            "veinte": 20,
        }
        m = re.search(r"(\d{1,3})\s*etiqueta", msg) or re.search(
            r"etiqueta\w*\s*(\d{1,3})", msg
        )
        if m:
            limit = max(1, min(50, int(m.group(1))))
        else:
            wm = re.search(
                r"\b(" + "|".join(words.keys()) + r")\s+etiqueta",
                msg,
            )
            limit = max(1, min(50, words[wm.group(1)])) if wm else 50
        rows, error = listar_recientes(limit=limit, solo_hoy=False)
        if error:
            return f"No pude listar etiquetas: {error}", []
        if not rows:
            return "No hay etiquetas para mostrar en el inventario.", []
        items = rows
        sample = rows[0]
        et = sample.get("etiqueta") or "S/E"
        art = (
            f"{sample.get('articulo') or ''} {sample.get('marca') or ''}".strip()
            or "artículo"
        )
        return (
            f"Aquí tienes {len(rows)} etiqueta(s). Por ejemplo {et}: {art} — "
            f"{sample.get('persona') or 'Sin asignar'} "
            f"({sample.get('area') or 'General'}). El detalle está en el visor.",
            items,
        )

    if "biblioteca" in msg and any(k in msg for k in ("cuantos", "cuántos", "cuanto", "cuánto", "hay")):
        total, error = count_por_campo("area", "Biblioteca")
        if error:
            return f"No pude contar Biblioteca: {error}", []
        return f"En Biblioteca hay {total} artículos registrados.", []

    # "cuántas áreas hay / en total / tiene este inventario"
    if (
        ("area" in msg or "áreas" in msg or "areas" in msg)
        and any(
            k in msg
            for k in (
                "cuantas",
                "cuántas",
                "cuantos",
                "cuántos",
                "cuanta",
                "cuánta",
                "total",
                "totales",
                "hay",
                "existen",
                "ranking",
                "distribucion",
                "distribución",
            )
        )
        and not re.search(
            r"\b(biblioteca|edif|edificio|sistemas|coordinacion|coordinación)\b",
            msg,
        )
    ):
        data, error = resumen_inventario()
        if error and not data:
            return f"No pude contar las áreas: {error}", []
        areas_n = data.get("areas")
        total_n = data.get("total")
        if areas_n is None:
            rows, err2, _ = read_inventario()
            if err2 or not rows:
                return (
                    "No pude calcular cuántas áreas hay. "
                    "¿Quieres que intente el inventario general o un área concreta?",
                    [],
                )
            areas_n = len(
                {
                    str(r.get("area") or "").strip()
                    for r in rows
                    if str(r.get("area") or "").strip()
                }
            )
            total_n = total_n if total_n is not None else len(rows)
        return (
            f"Este inventario tiene **{areas_n}** área"
            f"{'' if areas_n == 1 else 's'} distintas"
            + (f" (**{total_n}** registros en total)" if total_n is not None else "")
            + ".\n\n"
            "Si quieres el ranking o el detalle de un área, dime "
            "«dame las áreas» o el nombre del área.",
            [],
        )

    # "cuántos registros tiene GARCIA AVILA MARTIN"
    if any(k in msg for k in ("cuantos", "cuántos", "cuanto", "cuánto", "cuantas", "cuántas")) and (
        "tiene" in msg or "tienen" in msg
    ) and not any(k in msg for k in ("area", "áreas", "areas", "inventario")):
        from inventario.supabase_client import list_por_campo

        stop = {
            "cuantos",
            "cuántos",
            "cuanto",
            "cuánto",
            "cuantas",
            "cuántas",
            "registros",
            "registro",
            "articulos",
            "artículos",
            "equipos",
            "tiene",
            "tienen",
            "hay",
            "de",
            "del",
            "la",
            "el",
            "los",
            "las",
            "un",
            "una",
            "me",
            "dame",
            "persona",
        }
        tokens = [
            t
            for t in _clean_tokens(message)
            if t not in stop and len(t) > 1
        ]
        persona = " ".join(tokens).strip()
        if persona:
            total, error = count_por_campo("persona", persona)
            rows, _ = list_por_campo("persona", persona, limit=12)
            if error:
                return f"No pude contar registros de {persona}: {error}", []
            items = rows
            return (
                f"{persona} tiene {total} registro(s) en el inventario. "
                "El detalle está en el visor derecho.\n\n"
                "¿Quieres ver solo los más recientes, generar QR de un lote "
                "o filtrar por un área?",
                items,
            )

    if any(k in msg for k in ("resumen", "estadistica", "estadística")) or (
        any(k in msg for k in ("cuantos", "cuántos", "cuanto", "cuánto", "total"))
        and any(k in msg for k in ("inventario", "todo", "todos", "hay"))
    ):
        total, err_t = count_inventario()
        data, error = resumen_inventario()
        if err_t and error:
            return f"No pude leer el inventario: {error or err_t}", []
        real_total = total if total is not None else data.get("total", 0)
        obs = data.get("con_observaciones") or 0
        obs_txt = f", {obs} con observaciones" if obs else ""
        return (
            f"Inventario general: {real_total} artículos, "
            f"{data.get('personas', '—')} personas y {data.get('areas', '—')} áreas"
            f"{obs_txt}. "
            "Si quieres seguir, dime un área, una persona, los últimos registros, "
            "QR o importar un Excel/CSV.",
            [],
        )

    tokens = _clean_tokens(message)
    query = " ".join(tokens) if tokens else message
    rows, error = search_inventario(query, limit=12)
    if error:
        return f"No pude leer el inventario: {error}", []
    if not rows:
        # si search vacío, intenta leer todo y avisar
        _, err2, _ = read_inventario()
        if err2:
            return f"No pude leer el inventario: {err2}", []
        return (
            f"No encontré coincidencias con “{message}”. Prueba con persona, área o etiqueta.",
            [],
        )

    items = rows
    sample = rows[0]
    et = sample.get("etiqueta") or "S/E"
    art = f"{sample.get('articulo') or ''} {sample.get('marca') or ''}".strip() or "artículo"
    more = f" (y {len(rows) - 1} más)" if len(rows) > 1 else ""
    return (
        f"Encontré {len(rows)} registro(s){more} (modo local). "
        f"Por ejemplo {et}: {art} — {sample.get('persona') or 'Sin asignar'} "
        f"({sample.get('area') or 'General'}). El detalle está en el visor.",
        items,
    )
