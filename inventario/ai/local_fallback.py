"""Respuestas locales si los proveedores IA no están disponibles."""

from __future__ import annotations

import re

from inventario.supabase_client import (
    count_inventario,
    count_por_campo,
    listar_recientes,
    read_inventario,
    search_inventario,
    resumen_inventario,
)

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
        return (
            "¡Hola! ¿En qué te puedo ayudar con el inventario?\n\n"
            "Puedo consultar datos reales, ayudarte a registrar artículos "
            "o importar un archivo. Si quieres empezar, dime por ejemplo:\n"
            "• ¿Consultamos el inventario general, por área o por persona?\n"
            "• ¿Buscamos por etiqueta/artículo o vemos los últimos registros?\n"
            "• ¿Quieres dar de alta un artículo nuevo (+ Nuevo artículo)?\n"
            "• ¿Prefieres importar un Excel o CSV con el clip 📎?\n"
            "• ¿Generamos códigos QR de algún grupo?\n\n"
            "Dime qué camino prefieres y lo hacemos.",
            [],
        )

    if any(k in msg for k in ("ayuda", "qué puedes", "que puedes")):
        return (
            "Puedo trabajar contigo el inventario así:\n"
            "• Consultar totales, áreas, personas y artículos\n"
            "• Buscar por etiqueta, persona o área\n"
            "• Ver últimos registros o generar códigos QR\n"
            "• Orientarte para dar de alta un artículo (+ Nuevo artículo)\n"
            "• Importar Excel/CSV con el clip 📎\n"
            "• Resumen general del inventario\n\n"
            "Dime qué quieres hacer y te guío paso a paso.",
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
        lines = []
        for r in rows[:8]:
            et = r.get("etiqueta") or "S/E"
            art = f"{r.get('articulo') or ''} {r.get('marca') or ''}".strip()
            lines.append(
                f"• {et}: {art} — {r.get('persona') or 'Sin asignar'} ({r.get('area') or 'General'})"
            )
        titulo = "Registros de hoy" if solo_hoy else "Último(s) registro(s)"
        return f"{titulo} (modo local):\n" + "\n".join(lines), items

    if "biblioteca" in msg and any(k in msg for k in ("cuantos", "cuántos", "cuanto", "cuánto", "hay")):
        total, error = count_por_campo("area", "Biblioteca")
        if error:
            return f"No pude contar Biblioteca: {error}", []
        return f"En Biblioteca hay {total} artículos registrados.", []

    # "cuántos registros tiene GARCIA AVILA MARTIN"
    if any(k in msg for k in ("cuantos", "cuántos", "cuanto", "cuánto")) and (
        "tiene" in msg or "tienen" in msg
    ):
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
            f"{obs_txt}. El desglose está en el visor derecho.\n\n"
            "Si quieres seguir, dime por ejemplo:\n"
            "• Filtrar por un área o persona\n"
            "• Ver los últimos registros o generar QR\n"
            "• Dar de alta un artículo (+ Nuevo artículo)\n"
            "• Importar un Excel o CSV con el clip 📎",
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
    lines = []
    for r in rows[:8]:
        et = r.get("etiqueta") or "S/E"
        art = f"{r.get('articulo') or ''} {r.get('marca') or ''}".strip()
        lines.append(
            f"• {et}: {art} — {r.get('persona') or 'Sin asignar'} ({r.get('area') or 'General'})"
        )
    more = f"\n… y {len(rows) - 8} más." if len(rows) > 8 else ""
    return (
        f"Encontré {len(rows)} registro(s) (modo local):\n"
        + "\n".join(lines)
        + more,
        items,
    )
