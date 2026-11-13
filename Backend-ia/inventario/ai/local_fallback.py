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
    "como",
    "cómo",
    "cual",
    "cuál",
    "cuales",
    "cuáles",
    "me",
    "te",
    "se",
    "le",
    "les",
    "mi",
    "tu",
    "su",
    "al",
    "lo",
    "ya",
    "si",
    "sí",
    "no",
    "o",
    "y",
    "a",
    "es",
    "son",
    "hay",
    "tiene",
    "tienen",
    "dame",
    "muestra",
    "mostrar",
    "ver",
    "busca",
    "buscar",
    "lista",
    "listar",
    "quiero",
    "necesito",
    "puedes",
    "puede",
    "puedo",
    "hola",
    "buenas",
    "gracias",
}


def _fold(text: str) -> str:
    t = str(text or "").lower()
    for a, b in (
        ("á", "a"),
        ("é", "e"),
        ("í", "i"),
        ("ó", "o"),
        ("ú", "u"),
        ("ü", "u"),
        ("ñ", "n"),
    ):
        t = t.replace(a, b)
    t = re.sub(r"[^a-z0-9\s]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def _clean_tokens(message: str) -> list[str]:
    return [t for t in _fold(message).split() if t and t not in STOPWORDS]


def local_chat_answer(message: str) -> tuple[str, list]:
    msg = _fold(message)
    if not msg:
        return pick_greeting_reply(), []

    if any(
        k in msg
        for k in (
            "hola",
            "buenas",
            "buen dia",
            "buenos dias",
            "buenas tardes",
            "buenas noches",
            "hey",
            "saludos",
        )
    ) and len(msg.split()) <= 6:
        return pick_greeting_reply(), []

    if any(
        k in msg
        for k in (
            "que se puede",
            "que puedes",
            "que puedo",
            "que hacemos",
            "que podemos",
            "opciones",
            "ayuda",
            "ayudame",
            "para que sirves",
            "como te uso",
            "como funciona",
            "en que me ayudas",
        )
    ):
        return pick_help_reply(), []

    if re.fullmatch(
        r"(ok|okay|okey|vale|va|sale|bueno|bien|gracias|thanks|perfecto|"
        r"listo|entendido|claro|dale|de acuerdo|sip|si)",
        msg,
    ):
        return pick_ack_reply(), []

    if "traspaso" in msg or (
        any(k in msg for k in ("mueve", "pasar", "pasa", "transfer"))
        and any(k in msg for k in ("todo", "todos", "estos", "estas", "lote"))
    ):
        return (
            "Para traspasos masivos el chat te pide confirmación y luego "
            "aplica el cambio en lote. Prueba con frases como "
            "«mueve todo de Juan a María», «pasa todo de Sistemas a Biblioteca» "
            "o «pasa estos a María» (usando el listado del visor). "
            "¿Quieres armar uno?",
            [],
        )

    if any(k in msg for k in ("reciente", "recientes", "ultimo", "ultimos", "hoy")):
        rows, error = listar_recientes(limit=8, solo_hoy="hoy" in msg)
        if error:
            return f"No pude leer los recientes: {error}", []
        if not rows:
            return "No hay registros recientes para mostrar.", []
        n = len(rows)
        sample = rows[0]
        et = sample.get("etiqueta") or "S/E"
        art = sample.get("articulo") or "artículo"
        return (
            f"Hay {n} registro{'s' if n != 1 else ''} reciente{'s' if n != 1 else ''}. "
            f"El más nuevo es {et} ({art}). El detalle está en el visor. "
            "¿Quieres filtrar por persona, un área o generar QR?",
            rows,
        )

    if any(k in msg for k in ("cuantas areas", "cuantas area", "areas hay", "areas en total")):
        data, error = resumen_inventario()
        if error:
            rows, err2, _ = read_inventario()
            if err2:
                return f"No pude leer el inventario: {error or err2}", []
            areas = {
                str(r.get("area") or "").strip()
                for r in (rows or [])
                if str(r.get("area") or "").strip()
            }
            areas_n = len(areas)
        else:
            areas_n = data.get("areas", 0)
        return (
            f"Este inventario tiene {areas_n} área{'s' if areas_n != 1 else ''} distintas. "
            "Si quieres el detalle de una, dime su nombre.",
            [],
        )

    if any(k in msg for k in ("resumen", "estadistica", "estadistica")) or (
        any(k in msg for k in ("cuantos", "cuanto", "total"))
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

    # Persona: "cuantos tiene X"
    m_person = re.search(
        r"(?:cuantos|cuantas|que tiene|tiene)\s+(.+)$",
        msg,
    )
    if m_person and "area" not in msg:
        persona = m_person.group(1).strip()
        if persona and persona not in STOPWORDS:
            total, error = count_por_campo("persona", persona)
            if not error and total is not None:
                from inventario.supabase_client import list_por_campo

                rows, _ = list_por_campo("persona", persona, limit=12)
                return (
                    f"{persona} tiene {total} registro(s) en el inventario. "
                    "El detalle está en el visor derecho. "
                    "¿Quieres ver solo los más recientes, generar QR de un lote "
                    "o filtrar por un área?",
                    rows or [],
                )

    tokens = _clean_tokens(message)
    query = " ".join(tokens) if tokens else message
    rows, error = search_inventario(query, limit=12)
    if error:
        return f"No pude leer el inventario: {error}", []
    if not rows:
        _, err2, _ = read_inventario()
        if err2:
            return f"No pude leer el inventario: {err2}", []
        return (
            f"No encontré coincidencias con “{message}”. Prueba con persona, área o etiqueta.",
            [],
        )

    sample = rows[0]
    et = sample.get("etiqueta") or "S/E"
    art = f"{sample.get('articulo') or ''} {sample.get('marca') or ''}".strip() or "artículo"
    more = f" (y {len(rows) - 1} más)" if len(rows) > 1 else ""
    return (
        f"Encontré {len(rows)} registro(s){more}. "
        f"Por ejemplo {et}: {art} — {sample.get('persona') or 'Sin asignar'} "
        f"({sample.get('area') or 'General'}). El detalle está en el visor.",
        rows,
    )
