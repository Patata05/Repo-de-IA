from __future__ import annotations

import json
from typing import Any

from inventario import supabase_client as db


def format_inventario_qr_text(row: dict[str, Any]) -> str:
    """
    Payload corto para QR del chat (pocos módulos, sin congelar el front).
    Formato: INV:<etiqueta>|<origen>
    La ficha completa legible va en el modal de detalle del artículo.
    """
    etiqueta = str(row.get("etiqueta") or "").strip().replace("|", "/")
    origen = str(row.get("origen") or "").strip().replace("|", "/")
    if not etiqueta:
        return ""
    return f"INV:{etiqueta}|{origen}" if origen else f"INV:{etiqueta}"


OPENAI_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "buscar_inventario",
            "description": (
                "Busca artículos del inventario por texto libre "
                "(persona, área, etiqueta, artículo, marca, modelo, serie, origen)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Texto de búsqueda, ej. 'Juan Pérez', 'Biblioteca', 'laptop'",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Máximo de resultados (1-50). Default 15.",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "resumen_inventario",
            "description": "Devuelve totales EXACTOS del inventario (total real, no limitado a 1000).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "contar_total",
            "description": "Cuenta el total exacto de artículos en todo el inventario (rápido).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "contar_por_campo",
            "description": (
                "Cuenta artículos donde un campo contiene un texto y devuelve "
                "una muestra de items para el visor. "
                "Ej: campo=persona valor=GARCIA AVILA MARTIN; "
                "campo=area valor=Biblioteca. "
                "Usa UNA sola llamada para 'cuántos tiene [persona]'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "campo": {
                        "type": "string",
                        "description": "area | persona | articulo | etiqueta | origen | marca | modelo | estado",
                    },
                    "valor": {"type": "string", "description": "Texto a buscar (parcial OK)"},
                },
                "required": ["campo", "valor"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "obtener_por_etiqueta",
            "description": "Obtiene registros exactos por etiqueta (origen opcional).",
            "parameters": {
                "type": "object",
                "properties": {
                    "etiqueta": {"type": "string"},
                    "origen": {
                        "type": "string",
                        "description": "Inventario/origen opcional, ej. S/O",
                    },
                },
                "required": ["etiqueta"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "listar_recientes",
            "description": (
                "Lista los registros más recientes (último creado, los de hoy, etc.). "
                "Usa esto para 'último registro', 'qué registré hoy', 'los más nuevos'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "Cuántos devolver (1-20). Default 5; para 'el último' usa 1.",
                    },
                    "solo_hoy": {
                        "type": "boolean",
                        "description": "Si true, solo registros creados hoy (UTC).",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "generar_qr",
            "description": (
                "Genera códigos QR. SOLO si el usuario pide QR / código(s) QR. "
                "NO uses esta tool para 'dame N etiquetas' (eso es listar_recientes "
                "o buscar_inventario). "
                "Uno: etiqueta, id, o ultimo=true. "
                "Varios conocidos: etiquetas=[...] o ids=[...] (máx. 7). "
                "N QR de un área/persona (ej. '5 QR de Biblioteca'): "
                "query='Biblioteca' y limit=5 en UNA sola llamada. "
                "La UI muestra los QR en el visor; resume breve."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "etiqueta": {"type": "string"},
                    "id": {"type": "integer"},
                    "etiquetas": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Lista de etiquetas para varios QR (máx. 7).",
                    },
                    "ids": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "Lista de ids para varios QR (máx. 7).",
                    },
                    "query": {
                        "type": "string",
                        "description": (
                            "Busca artículos (área, persona, etc.) y genera QR de los "
                            "primeros N. Ej: 'Biblioteca', 'Juan Pérez'."
                        ),
                    },
                    "limit": {
                        "type": "integer",
                        "description": (
                            "Cuántos QR generar con query / lote (1-7). Default 5."
                        ),
                    },
                    "ultimo": {
                        "type": "boolean",
                        "description": "Si true, usa el registro más reciente.",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "actualizar_campo",
            "description": (
                "Actualiza campos permitidos de un artículo por id. "
                "Campos: etiqueta, articulo, marca, modelo, serie, area, persona, "
                "cantidad, observaciones, estado, origen."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer", "description": "ID del registro"},
                    "campos": {
                        "type": "object",
                        "description": "Mapa campo→valor a actualizar",
                    },
                },
                "required": ["id", "campos"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "crear_articulo",
            "description": (
                "Crea un artículo nuevo. Obligatorios: etiqueta, articulo, area."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "etiqueta": {"type": "string"},
                    "articulo": {"type": "string"},
                    "area": {"type": "string"},
                    "marca": {"type": "string"},
                    "modelo": {"type": "string"},
                    "serie": {"type": "string"},
                    "persona": {"type": "string"},
                    "cantidad": {"type": "integer"},
                    "observaciones": {"type": "string"},
                    "estado": {"type": "string"},
                    "origen": {"type": "string"},
                },
                "required": ["etiqueta", "articulo", "area"],
            },
        },
    },
]


def _compact_row(row: dict) -> dict:
    keys = (
        "id",
        "etiqueta",
        "articulo",
        "marca",
        "modelo",
        "serie",
        "area",
        "persona",
        "cantidad",
        "estado",
        "origen",
        "observaciones",
        "created_at",
        "updated_at",
    )
    return {k: row.get(k) for k in keys if row.get(k) not in (None, "")}


def run_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    try:
        if name == "buscar_inventario":
            query = str(args.get("query") or "").strip()
            limit = int(args.get("limit") or 15)
            rows, error = db.search_inventario(query, limit=limit)
            if error:
                return {"ok": False, "error": error}
            return {
                "ok": True,
                "count": len(rows),
                "items": [_compact_row(r) for r in rows],
            }

        if name == "resumen_inventario":
            data, error = db.resumen_inventario()
            if error:
                return {"ok": False, "error": error}
            return {"ok": True, **data}

        if name == "contar_total":
            total, error = db.count_inventario()
            if error:
                return {"ok": False, "error": error}
            return {"ok": True, "total": total}

        if name == "contar_por_campo":
            campo = str(args.get("campo") or "").strip()
            valor = str(args.get("valor") or "").strip()
            total, error = db.count_por_campo(campo, valor)
            if error:
                return {"ok": False, "error": error}
            # Incluye filas para el visor (hasta 50; el front recorta a lo pedido).
            rows, _list_err = db.list_por_campo(campo, valor, limit=50)
            areas: dict[str, int] = {}
            for row in rows:
                area = str(row.get("area") or "Sin área").strip() or "Sin área"
                areas[area] = areas.get(area, 0) + 1
            return {
                "ok": True,
                "campo": campo,
                "valor": valor,
                "total": total,
                "count": len(rows),
                "areas": areas,
                "items": [_compact_row(r) for r in rows],
            }

        if name == "obtener_por_etiqueta":
            etiqueta = str(args.get("etiqueta") or "").strip()
            origen = args.get("origen")
            origen_s = str(origen).strip() if origen else None
            rows, error = db.get_by_etiqueta(etiqueta, origen_s)
            if error:
                return {"ok": False, "error": error}
            return {
                "ok": True,
                "count": len(rows),
                "items": [_compact_row(r) for r in rows],
            }

        if name == "listar_recientes":
            limit = int(args.get("limit") or 5)
            solo_hoy = bool(args.get("solo_hoy"))
            rows, error = db.listar_recientes(limit=limit, solo_hoy=solo_hoy)
            if error:
                return {"ok": False, "error": error}
            return {
                "ok": True,
                "count": len(rows),
                "items": [_compact_row(r) for r in rows],
            }

        if name == "generar_qr":
            max_batch = 7
            try:
                limit = int(args.get("limit") or max_batch)
            except (TypeError, ValueError):
                limit = max_batch
            limit = max(1, min(max_batch, limit))
            rows_batch: list[dict[str, Any]] = []

            raw_ids = args.get("ids")
            raw_etiquetas = args.get("etiquetas")
            query = str(args.get("query") or "").strip()
            if isinstance(raw_ids, list) and raw_ids:
                for raw_id in raw_ids[:limit]:
                    try:
                        row, error = db.get_by_id(int(raw_id))
                    except (TypeError, ValueError):
                        continue
                    if error or not row:
                        continue
                    rows_batch.append(row)
            elif isinstance(raw_etiquetas, list) and raw_etiquetas:
                for raw_tag in raw_etiquetas[:limit]:
                    tag = str(raw_tag or "").strip()
                    if not tag:
                        continue
                    found, error = db.get_by_etiqueta(tag)
                    if error or not found:
                        continue
                    rows_batch.append(found[0])
            elif query:
                found, error = db.search_inventario(query, limit=limit)
                if error:
                    return {"ok": False, "error": error}
                rows_batch = list(found or [])
            else:
                row: dict[str, Any] | None = None
                if args.get("id") is not None:
                    row, error = db.get_by_id(int(args["id"]))
                    if error:
                        return {"ok": False, "error": error}
                elif str(args.get("etiqueta") or "").strip():
                    found, error = db.get_by_etiqueta(str(args.get("etiqueta")).strip())
                    if error:
                        return {"ok": False, "error": error}
                    row = found[0] if found else None
                elif args.get("ultimo"):
                    found, error = db.listar_recientes(limit=1, solo_hoy=False)
                    if error:
                        return {"ok": False, "error": error}
                    row = found[0] if found else None
                else:
                    return {
                        "ok": False,
                        "error": (
                            "Indica etiqueta, id, etiquetas, ids, query+limit "
                            "o ultimo=true."
                        ),
                    }
                if not row:
                    return {"ok": False, "error": "No encontré el artículo para el QR."}
                rows_batch = [row]

            if not rows_batch:
                return {"ok": False, "error": "No encontré artículos para el QR."}

            # Deduplicar por id y quedarnos con filas que tengan etiqueta (QR válido)
            seen_ids: set[str] = set()
            unique_rows: list[dict[str, Any]] = []
            for row in rows_batch:
                if not str(row.get("etiqueta") or "").strip():
                    continue
                key = str(row.get("id")) if row.get("id") is not None else ""
                if key and key in seen_ids:
                    continue
                if key:
                    seen_ids.add(key)
                unique_rows.append(row)
                if len(unique_rows) >= limit:
                    break

            if not unique_rows:
                return {
                    "ok": False,
                    "error": "No encontré artículos con etiqueta para generar QR.",
                }

            items = [_compact_row(r) for r in unique_rows]
            qrs = []
            for i, r in enumerate(unique_rows):
                text = format_inventario_qr_text(r)
                if not text:
                    continue
                qrs.append(
                    {
                        "text": text,
                        "etiqueta": items[i].get("etiqueta"),
                        "articulo": items[i].get("articulo"),
                        "id": items[i].get("id"),
                        "item": items[i],
                    }
                )
            if not qrs:
                return {"ok": False, "error": "No pude armar el texto de los QR."}
            first = items[0]
            return {
                "ok": True,
                "item": first,
                "items": items[: len(qrs)],
                "qr_text": qrs[0]["text"],
                "qr": True,
                "qrs": qrs,
                "count": len(qrs),
            }

        if name == "actualizar_campo":
            row_id = int(args.get("id"))
            campos = args.get("campos") or {}
            if not isinstance(campos, dict):
                return {"ok": False, "error": "campos debe ser un objeto"}
            row, error = db.update_inventario_row(row_id, campos)
            if error:
                return {"ok": False, "error": error, "mutated": False}
            return {
                "ok": True,
                "mutated": True,
                "item": _compact_row(row or {}),
            }

        if name == "crear_articulo":
            row, error = db.create_inventario_row(args)
            if error:
                return {"ok": False, "error": error, "mutated": False}
            return {
                "ok": True,
                "mutated": True,
                "item": _compact_row(row or {}),
            }

        return {"ok": False, "error": f"Herramienta desconocida: {name}"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def dump_tool_result(result: dict[str, Any]) -> str:
    """Payload compacto para el LLM (menos tokens = respuesta más rápida)."""
    if not isinstance(result, dict):
        return json.dumps({"ok": False, "error": "resultado inválido"}, ensure_ascii=False)

    slim: dict[str, Any] = {
        k: result[k]
        for k in ("ok", "error", "mutated", "count", "total", "qr", "qr_text")
        if k in result
    }
    if isinstance(result.get("item"), dict):
        slim["item"] = _compact_row(result["item"])
    items = result.get("items")
    if isinstance(items, list):
        slim["items"] = [
            _compact_row(row) if isinstance(row, dict) else row for row in items[:8]
        ]
        if len(items) > 8:
            slim["items_truncated"] = len(items) - 8
    qrs = result.get("qrs")
    if isinstance(qrs, list):
        slim["qrs"] = qrs[:7]
        slim["count"] = slim.get("count", len(qrs))
    # Resumen / totales: pasar campos numéricos útiles
    for k, v in result.items():
        if k in slim or k in ("item", "items", "qrs"):
            continue
        if isinstance(v, (int, float, str, bool)) or v is None:
            slim[k] = v
    return json.dumps(slim, ensure_ascii=False, default=str)
