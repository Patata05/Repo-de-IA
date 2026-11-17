from __future__ import annotations

import json
import logging
from typing import Any

from inventario import supabase_client as db

logger = logging.getLogger(__name__)

# Tope para listados conversacionales (texto en chat). Export/consolidación/contar_por_campo
# siguen con límites altos propios.
# Listados etiquetas/búsqueda: respeta N del usuario (sin tope artificial 40/50).
CHAT_LIST_CAP = 2000


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
            "name": "ranking_areas",
            "description": (
                "Ranking GLOBAL de TODAS las áreas del inventario (artículos y personas "
                "por área, mayor a menor). Úsalo para 'áreas en general', 'todas las áreas', "
                "'qué áreas hay', 'ranking de áreas'. NO uses contar_por_campo de un área "
                "puntual para estas consultas."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "comparar_inventarios",
            "description": (
                "Compara inventarios/orígenes de forma rápida (métricas, sin filas). "
                "Úsalo para 'compara inventarios', 'compara excel 1 vs excel 2', "
                "'compara todo', 'diferencias entre inventarios'. "
                "origenes=null o vacío → todos los orígenes. "
                "Devuelve totales, cruces de etiquetas y desglose por área."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "origenes": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "Lista opcional de orígenes, ej. ['excel 1','excel 2'] "
                            "o ['Inventario 1','Inventario 5']. Omitir = todos."
                        ),
                    },
                },
            },
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
                "Cuenta y resume por campo (ilike, sin importar mayúsculas/espacios). "
                "Devuelve total de artículos, personas asignadas y equipos/artículos. "
                "Ej: campo=area valor=Recursos Humanos; "
                "campo=persona valor=GARCIA AVILA MARTIN. "
                "Columna area SIN acento. Una sola llamada para 'datos/cuántos de X'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "campo": {
                        "type": "string",
                        "description": "area | persona | articulo | etiqueta | origen | marca | modelo | estado (sin acentos)",
                    },
                    "valor": {
                        "type": "string",
                        "description": "Texto a buscar (parcial OK; ej. Recursos Humanos)",
                    },
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
            "name": "buscar_semantico",
            "description": (
                "Búsqueda semántica (pgvector). Usar si buscar_inventario no encuentra "
                "por significado (ej. 'computadora portátil' vs 'MacBook'). "
                "Hoy puede estar desactivada hasta generar embeddings."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "limit": {"type": "integer"},
                },
                "required": ["query"],
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
                "Varios conocidos: etiquetas=[...] o ids=[...]. "
                "Todos los QR de una persona/área sin número (ej. 'dame sus QR', "
                "'QR de Ricardo'): query='Ricardo Morales' y limit=50 (o el total). "
                "Si piden N concreto (ej. '5 QR de Biblioteca'): query + limit=N. "
                "NUNCA recortes a 7 si el usuario no pidió 7. "
                "La UI muestra los QR en el visor; resume breve en el chat."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "etiqueta": {"type": "string"},
                    "id": {"type": "integer"},
                    "etiquetas": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Lista de etiquetas para varios QR (máx. 50).",
                    },
                    "ids": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "Lista de ids para varios QR (máx. 50).",
                    },
                    "query": {
                        "type": "string",
                        "description": (
                            "Busca artículos (área, persona, etc.) y genera QR. "
                            "Ej: 'Biblioteca', 'Juan Pérez'."
                        ),
                    },
                    "limit": {
                        "type": "integer",
                        "description": (
                            "Cuántos QR (1-50). Sin número del usuario: 50 "
                            "(todos los que quepan). Con N: usa N."
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
                "Actualiza campos permitidos de un artículo. "
                "Prefiere etiqueta (OF-0026, 281367…). El id numérico interno "
                "NO es lo mismo que los dígitos de una etiqueta (OF-0026 ≠ id 26). "
                "Campos: etiqueta, articulo, marca, modelo, serie, area, persona, "
                "cantidad, observaciones, estado, origen."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "integer",
                        "description": "ID interno numérico (solo si el usuario dio ese id, no dígitos de etiqueta).",
                    },
                    "etiqueta": {
                        "type": "string",
                        "description": "Etiqueta del artículo (preferida; ej. OF-0026).",
                    },
                    "campos": {
                        "type": "object",
                        "description": "Mapa campo→valor a actualizar",
                    },
                },
                "required": ["campos"],
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
    {
        "type": "function",
        "function": {
            "name": "preparar_consolidacion_inventario",
            "description": (
                "Prepara copiar/agregar o mover registros entre orígenes "
                "(excel N, Inventario N) hacia un destino o un inventario nuevo. "
                "Valida etiquetas únicas en el destino, guarda el lote pendiente "
                "y pide confirmación. NO inserta hasta confirmar_consolidacion_inventario "
                "o que el usuario diga sí. "
                "Ej: tramos=[{origen:'excel 1',cantidad:200},{origen:'excel 2',cantidad:30}], "
                "destino='Inventario 3' o null/'nuevo', mover=false."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "tramos": {
                        "type": "array",
                        "description": "Lista de {origen, cantidad?}. cantidad omite = todos.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "origen": {
                                    "type": "string",
                                    "description": "excel 1, Inventario 2, etc.",
                                },
                                "cantidad": {
                                    "type": "integer",
                                    "description": "Máximo de registros a tomar de ese origen",
                                },
                            },
                            "required": ["origen"],
                        },
                    },
                    "destino": {
                        "type": ["string", "null"],
                        "description": (
                            "Inventario 1 / excel 2, o null/'nuevo' para Inventario N+1"
                        ),
                    },
                    "mover": {
                        "type": "boolean",
                        "description": (
                            "false=copiar/agregar (default). true solo si el usuario "
                            "dijo explícitamente mover/quitar del origen."
                        ),
                    },
                },
                "required": ["tramos"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "confirmar_consolidacion_inventario",
            "description": (
                "Ejecuta la consolidación pendiente tras el sí del usuario: "
                "inserta el lote válido en el destino y, si mover=true, elimina "
                "los IDs del origen anterior."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cancelar_consolidacion_inventario",
            "description": "Cancela el lote de consolidación pendiente sin tocar datos.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "listar_criterios",
            "description": (
                "Lista cantidades por varios filtros a la vez. "
                "Ej: [{campo:'persona',valor:'aquí',limit:5},"
                "{campo:'area',valor:'TI',limit:5}]. "
                "«aquí» usa CONTEXTO_VISTA. No rellena ni duplica etiquetas."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "criterios": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "campo": {
                                    "type": "string",
                                    "description": "persona|area|origen o 'aqui'",
                                },
                                "valor": {"type": "string"},
                                "limit": {"type": "integer"},
                            },
                            "required": ["valor"],
                        },
                    },
                },
                "required": ["criterios"],
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


def _items_unique_etiqueta(rows: list[dict]) -> list[dict]:
    return [_compact_row(r) for r in db.dedupe_by_etiqueta(rows)]


def run_tool(
    name: str,
    args: dict[str, Any],
    *,
    session_id: str | None = None,
    contexto_vista: dict[str, str] | None = None,
) -> dict[str, Any]:
    try:
        if name == "buscar_inventario":
            query = str(args.get("query") or "").strip()
            limit = int(args.get("limit") or 15)
            cap = max(1, min(int(limit or 15), CHAT_LIST_CAP))
            # «de aquí» → persona/área/origen del panel
            q_fold = query.lower().strip()
            area_resolved = None
            if contexto_vista and q_fold in {
                "aqui",
                "aquí",
                "de aqui",
                "de aquí",
                "esta lista",
                "este panel",
                "este visor",
            }:
                rows, error = db.list_por_campo(
                    contexto_vista["tipo"],
                    contexto_vista["valor"],
                    limit=cap,
                )
            else:
                # Preferir área canónica (ti → Sistemas y TI) antes de búsqueda libre
                area_resolved = db.resolve_area_label(query)
                if area_resolved:
                    rows, error = db.list_por_campo(
                        "area", area_resolved, limit=cap
                    )
                else:
                    rows, error = db.search_inventario(query, limit=cap)
            if error:
                return {"ok": False, "error": error}
            items = _items_unique_etiqueta(rows)[:cap]
            # Verificación: si fue área, solo filas de esa área
            if area_resolved:
                fold_a = db._fold_text(area_resolved)
                items = [
                    it
                    for it in items
                    if db._fold_text(str(it.get("area") or "")) == fold_a
                ]
            # Área canónica (TI → Sistemas y TI): devolver TODO el listado del área.
            if area_resolved and cap < CHAT_LIST_CAP:
                rows_full, err_full = db.list_por_campo(
                    "area", area_resolved, limit=CHAT_LIST_CAP
                )
                if not err_full and rows_full:
                    fold_a = db._fold_text(area_resolved)
                    items = [
                        it
                        for it in _items_unique_etiqueta(rows_full)[:CHAT_LIST_CAP]
                        if db._fold_text(str(it.get("area") or "")) == fold_a
                    ]
                    cap = CHAT_LIST_CAP
            out: dict[str, Any] = {
                "ok": True,
                "count": len(items),
                "pedidos": limit,
                "faltaron": max(0, int(limit or 0) - len(items)),
                "items": items,
                # N explícito (ej. 8) < tope chat → lista acotada (no expandir).
                # Área resuelta → nunca vista previa recortada.
                "lista_limitada": (not area_resolved) and cap < CHAT_LIST_CAP,
            }
            if area_resolved:
                out["filtro"] = {"tipo": "area", "valor": area_resolved}
                out["viewer"] = {"tipo": "area", "valor": area_resolved}
            elif items:
                # Si la búsqueda apunta a una sola persona dominante → panel persona.
                personas_hit: dict[str, int] = {}
                for it in items:
                    p = str(it.get("persona") or "").strip()
                    if p:
                        personas_hit[p] = personas_hit.get(p, 0) + 1
                if personas_hit:
                    top_p = max(personas_hit.items(), key=lambda kv: kv[1])[0]
                    fold_q = db._fold_text(query)
                    fold_p = db._fold_text(top_p)
                    if fold_q and (
                        fold_q in fold_p
                        or any(
                            t in fold_p
                            for t in fold_q.split()
                            if len(t) > 2
                        )
                    ):
                        # Mayoría clara (≥50%) o todos con esa persona.
                        if personas_hit[top_p] >= max(1, (len(items) + 1) // 2):
                            out["filtro"] = {"tipo": "persona", "valor": top_p}
                            out["viewer"] = {"tipo": "persona", "valor": top_p}
            return out

        if name == "resumen_inventario":
            data, error = db.resumen_inventario()
            if error:
                return {"ok": False, "error": error}
            return {"ok": True, **data}

        if name == "ranking_areas":
            data, error = db.ranking_areas()
            if error:
                return {"ok": False, "error": error}
            ranking = data.get("ranking") if isinstance(data, dict) else None
            return {
                "ok": True,
                **(data if isinstance(data, dict) else {}),
                # Visor global: ranking completo (areas_general).
                "viewer": {
                    "tipo": "areas_general",
                    "valor": "general",
                    "ranking": ranking if isinstance(ranking, list) else [],
                },
                "filtro": {"tipo": "areas_general", "valor": "general"},
                "items": [],
                "count": len(ranking) if isinstance(ranking, list) else 0,
                "lista_limitada": False,
            }

        if name == "comparar_inventarios":
            raw_origenes = args.get("origenes")
            origenes_arg: list[str] | None = None
            if isinstance(raw_origenes, list) and raw_origenes:
                origenes_arg = [
                    str(o).strip() for o in raw_origenes if str(o or "").strip()
                ] or None
            data, error = db.comparar_inventarios(origenes_arg)
            if error:
                return {"ok": False, "error": error}
            if not isinstance(data, dict) or not data.get("ok", True):
                return {
                    "ok": False,
                    "error": (
                        (data or {}).get("error")
                        if isinstance(data, dict)
                        else "No se pudo comparar"
                    ),
                    "origenes_disponibles": (
                        (data or {}).get("origenes_disponibles")
                        if isinstance(data, dict)
                        else []
                    ),
                }
            titulo = str(data.get("titulo") or "Comparativa")
            valor = (
                "general"
                if data.get("general")
                else " vs ".join(str(o) for o in (data.get("origenes") or [])[:2])
            )
            inventarios = data.get("inventarios") or []
            comparativa_areas = data.get("comparativa_areas") or data.get("por_area") or []
            resumen_cruces = data.get("resumen_cruces") or {
                "etiquetas_compartidas": (data.get("cruces") or {}).get(
                    "compartidas", 0
                ),
                "exclusivas_por_inventario": (data.get("cruces") or {}).get(
                    "solo_en", {}
                ),
            }
            # Normalizar áreas: siempre int >= 0 por inventario (nunca null).
            nombres = [
                str(i.get("nombre") or i.get("origen") or "").strip()
                for i in inventarios
                if isinstance(i, dict)
            ]
            areas_norm: list[dict] = []
            for row in comparativa_areas:
                if not isinstance(row, dict):
                    continue
                area = str(row.get("area") or "Sin área").strip() or "Sin área"
                raw_vals = row.get("valores") or row.get("totales") or {}
                if not isinstance(raw_vals, dict):
                    raw_vals = {}
                valores = {
                    n: int(raw_vals.get(n) or 0) for n in nombres if n
                }
                areas_norm.append(
                    {
                        "area": area,
                        "valores": valores,
                        "totales": valores,
                        "suma": sum(valores.values()),
                    }
                )
            comparacion = {
                "titulo": titulo,
                "general": bool(data.get("general")),
                "origenes": data.get("origenes") or nombres,
                "inventarios": inventarios,
                "comparativa_areas": areas_norm,
                "resumen_cruces": resumen_cruces,
                "cruces": {
                    "compartidas": int(
                        resumen_cruces.get("etiquetas_compartidas") or 0
                    ),
                    "solo_en": resumen_cruces.get("exclusivas_por_inventario")
                    or {},
                },
                "por_area": areas_norm,
            }
            return {
                "ok": True,
                "titulo": titulo,
                "resumen": data.get("resumen_llm") or comparacion,
                "viewer": {
                    "tipo": "comparacion",
                    "valor": valor or "general",
                    "comparacion": comparacion,
                },
                "filtro": {"tipo": "comparacion", "valor": valor or "general"},
                "items": [],
                "count": len(comparacion.get("origenes") or []),
                "lista_limitada": False,
            }

        if name == "contar_total":
            total, error = db.count_inventario()
            if error:
                return {"ok": False, "error": error}
            return {"ok": True, "total": total}

        if name == "contar_por_campo":
            campo = str(args.get("campo") or "").strip()
            valor = str(args.get("valor") or "").strip()
            print(
                f"[inventario] contar_por_campo inicio campo={campo!r} valor={valor!r}"
            )
            total, error = db.count_por_campo(campo, valor)
            if error:
                logger.error(
                    "contar_por_campo falló campo=%r valor=%r error=%s",
                    campo,
                    valor,
                    error,
                )
                print(
                    f"[inventario] contar_por_campo ERROR campo={campo!r} "
                    f"valor={valor!r}: {error}"
                )
                return {
                    "ok": False,
                    "error": error,
                    "campo": campo,
                    "valor": valor,
                }
            # Todas las etiquetas únicas del filtro para el visor (tope alto).
            rows, list_err = db.list_por_campo(campo, valor, limit=50_000)
            if list_err:
                logger.warning(
                    "contar_por_campo list_por_campo: %s (campo=%r valor=%r)",
                    list_err,
                    campo,
                    valor,
                )
                print(f"[inventario] contar_por_campo list warning: {list_err}")
            if total is None:
                total = len(rows)
            personas_map: dict[str, int] = {}
            equipos_map: dict[str, int] = {}
            areas: dict[str, int] = {}
            for row in rows:
                area = str(row.get("area") or "Sin área").strip() or "Sin área"
                areas[area] = areas.get(area, 0) + 1
                persona = str(row.get("persona") or "").strip()
                if persona:
                    personas_map[persona] = personas_map.get(persona, 0) + 1
                equipo = (
                    " ".join(
                        p
                        for p in (
                            str(row.get("articulo") or "").strip(),
                            str(row.get("marca") or "").strip(),
                            str(row.get("modelo") or "").strip(),
                        )
                        if p
                    ).strip()
                    or str(row.get("articulo") or "").strip()
                )
                if equipo:
                    equipos_map[equipo] = equipos_map.get(equipo, 0) + 1
            personas = sorted(personas_map.keys(), key=str.casefold)
            equipos = sorted(equipos_map.keys(), key=str.casefold)
            items = _items_unique_etiqueta(rows)[:2000]
            campo_n = db._fold_field(campo)
            valor_out = valor.strip()
            if campo_n == "area":
                resolved = db.resolve_area_label(valor)
                if resolved:
                    valor_out = resolved
                    fold_a = db._fold_text(resolved)
                    items = [
                        it
                        for it in items
                        if db._fold_text(str(it.get("area") or "")) == fold_a
                    ]
            total_unique = len(items) if items else (total or 0)
            resumen = (
                f"{total_unique} artículo{'s' if total_unique != 1 else ''} "
                f"(etiquetas únicas), "
                f"{len(personas)} persona{'s' if len(personas) != 1 else ''} "
                f"asignada{'s' if len(personas) != 1 else ''}, "
                f"{len(equipos)} equipo{'s' if len(equipos) != 1 else ''} "
                f"en {valor_out}"
            )
            print(f"[inventario] contar_por_campo OK: {resumen}")
            out_c: dict[str, Any] = {
                "ok": True,
                "campo": campo_n,
                "valor": valor_out,
                "total": total_unique,
                "articulos": total_unique,
                "count": len(items),
                "personas_count": len(personas),
                "personas": personas[:40],
                "equipos_count": len(equipos),
                "equipos": equipos[:40],
                "areas": areas,
                "resumen": resumen,
                "items": items,
            }
            if campo_n == "area":
                out_c["filtro"] = {"tipo": "area", "valor": valor_out}
                out_c["viewer"] = {"tipo": "area", "valor": valor_out}
            elif campo_n == "persona":
                # Nombre canónico (Eduardo → Eduardo Delgado); nunca el área del artículo.
                persona_out = valor_out
                if personas_map:
                    fold_v = db._fold_text(valor_out)
                    matched = [
                        (p, n)
                        for p, n in personas_map.items()
                        if fold_v and fold_v in db._fold_text(p)
                    ]
                    if matched:
                        persona_out = max(matched, key=lambda kv: kv[1])[0]
                    else:
                        persona_out = max(
                            personas_map.items(), key=lambda kv: kv[1]
                        )[0]
                out_c["valor"] = persona_out
                out_c["filtro"] = {"tipo": "persona", "valor": persona_out}
                out_c["viewer"] = {"tipo": "persona", "valor": persona_out}
            elif campo_n == "origen":
                out_c["filtro"] = {"tipo": "origen", "valor": valor_out}
                out_c["viewer"] = {"tipo": "origen", "valor": valor_out}
            return out_c

        if name == "obtener_por_etiqueta":
            etiqueta = str(args.get("etiqueta") or "").strip()
            origen = args.get("origen")
            origen_s = str(origen).strip() if origen else None
            rows, error = db.get_by_etiqueta(etiqueta, origen_s)
            if error:
                return {"ok": False, "error": error}
            items = _items_unique_etiqueta(rows)
            return {
                "ok": True,
                "count": len(items),
                "items": items,
            }

        if name == "listar_recientes":
            limit = int(args.get("limit") or 5)
            solo_hoy = bool(args.get("solo_hoy"))
            cap = max(1, min(int(limit or 5), CHAT_LIST_CAP))
            rows, error = db.listar_recientes(limit=cap, solo_hoy=solo_hoy)
            if error:
                return {"ok": False, "error": error}
            items = _items_unique_etiqueta(rows)[:cap]
            return {
                "ok": True,
                "count": len(items),
                "pedidos": limit,
                "faltaron": max(0, int(limit or 0) - len(items)),
                "items": items,
            }

        if name == "buscar_semantico":
            query = str(args.get("query") or "").strip()
            limit = int(args.get("limit") or 15)
            cap = max(1, min(int(limit or 15), CHAT_LIST_CAP))
            rows, error = db.search_semantico(query, limit=cap)
            if error:
                return {"ok": False, "error": error}
            items = _items_unique_etiqueta(rows)[:cap]
            return {
                "ok": True,
                "count": len(items),
                "pedidos": limit,
                "faltaron": max(0, int(limit or 0) - len(items)),
                "items": items,
                "mode": "pgvector",
            }

        if name == "generar_qr":
            max_batch = 50
            query = str(args.get("query") or "").strip()
            raw_ids = args.get("ids")
            raw_etiquetas = args.get("etiquetas")
            # Sin N del usuario: por query/persona devolver todos (hasta 50).
            default_limit = max_batch if query else 5
            try:
                if args.get("limit") is None or args.get("limit") == "":
                    limit = default_limit
                else:
                    limit = int(args.get("limit"))
            except (TypeError, ValueError):
                limit = default_limit
            limit = max(1, min(max_batch, limit))
            rows_batch: list[dict[str, Any]] = []

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
                # Preferir coincidencia por persona/área para no truncar de más.
                by_person, _ = db.list_por_campo("persona", query, limit=limit)
                if len(by_person) >= 1:
                    rows_batch = list(by_person)
                else:
                    by_area, _ = db.list_por_campo("area", query, limit=limit)
                    if len(by_area) >= 1:
                        rows_batch = list(by_area)
                    else:
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
                return {"ok": False, "error": "qr_text_empty"}
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
            campos = args.get("campos") or {}
            if not isinstance(campos, dict):
                return {"ok": False, "error": "campos debe ser un objeto"}
            row_id = None
            if args.get("id") is not None and str(args.get("id")).strip() != "":
                try:
                    row_id = int(args.get("id"))
                except (TypeError, ValueError):
                    return {"ok": False, "error": "id inválido", "mutated": False}
            etiqueta = str(args.get("etiqueta") or "").strip()
            if row_id is None and etiqueta:
                found, error = db.get_by_etiqueta(etiqueta)
                if error:
                    return {"ok": False, "error": error, "mutated": False}
                if not found:
                    return {
                        "ok": False,
                        "error": f"No encontré la etiqueta {etiqueta}.",
                        "mutated": False,
                    }
                try:
                    row_id = int(found[0].get("id"))
                except (TypeError, ValueError):
                    return {
                        "ok": False,
                        "error": "La etiqueta no tiene id interno válido.",
                        "mutated": False,
                    }
            if row_id is None:
                return {
                    "ok": False,
                    "error": "Indica etiqueta (preferido) o id interno.",
                    "mutated": False,
                }
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

        if name == "preparar_consolidacion_inventario":
            from inventario.ai.consolidacion import preparar_consolidacion

            tramos = args.get("tramos")
            destino = args.get("destino")
            mover = bool(args.get("mover"))
            sid = str(args.get("session_id") or session_id or "").strip() or None
            result = preparar_consolidacion(
                tramos=tramos,
                destino=None if destino in (None, "", "null") else str(destino),
                mover=mover,
                session_id=sid,
            )
            return result

        if name == "confirmar_consolidacion_inventario":
            from inventario.ai.consolidacion import confirmar_consolidacion

            sid = str(args.get("session_id") or session_id or "").strip() or None
            return confirmar_consolidacion(sid)

        if name == "cancelar_consolidacion_inventario":
            from inventario.ai.consolidacion import cancelar_consolidacion

            sid = str(args.get("session_id") or session_id or "").strip() or None
            return cancelar_consolidacion(sid)

        if name == "listar_criterios":
            from inventario.ai.vista_contexto import listar_criterios

            return listar_criterios(
                args.get("criterios") or [],
                contexto_vista,
            )

        return {"ok": False, "error": f"Herramienta desconocida: {name}"}
    except Exception as exc:  # noqa: BLE001
        logger.exception("run_tool(%s) excepción args=%r", name, args)
        print(f"[inventario] run_tool({name}) excepción: {exc!r} args={args!r}")
        return {"ok": False, "error": str(exc)}


def slim_tool_result(result: dict[str, Any]) -> dict[str, Any]:
    """Dict esencial para el LLM (sin tabla completa ni campos muertos)."""
    if not isinstance(result, dict):
        return {"ok": False, "error": "resultado inválido"}

    slim: dict[str, Any] = {
        k: result[k]
        for k in (
            "ok",
            "error",
            "mutated",
            "count",
            "total",
            "articulos",
            "personas_count",
            "equipos_count",
            "resumen",
            "campo",
            "valor",
            "qr",
            "qr_text",
            "needs_confirm",
            "destino",
            "mover",
            "solicitados",
            "validos",
            "omitidos_duplicados",
            "insertados",
            "eliminados_origen",
            "faltaron",
            "filtro",
            "viewer",
            "total_areas",
            "total_articulos",
            "ranking",
            "mensaje_agente",
            "titulo",
            "registros",
            "activos",
        )
        if k in result
    }
    # Totales escalares de panorama (no listas).
    for k in ("personas", "areas"):
        v = result.get(k)
        if isinstance(v, (int, float)):
            slim[k] = v
    if isinstance(result.get("item"), dict):
        slim["item"] = _compact_row(result["item"])
    items = result.get("items")
    if isinstance(items, list):
        # Muestra corta: el visor derecho ya tiene el lote completo en deps.
        slim["items"] = [
            _compact_row(row) if isinstance(row, dict) else row for row in items[:6]
        ]
        if len(items) > 6:
            slim["items_truncated"] = len(items) - 6
            slim["count"] = (
                int(result["count"])
                if isinstance(result.get("count"), int)
                else len(items)
            )
    for list_key in ("personas", "equipos"):
        vals = result.get(list_key)
        if isinstance(vals, list):
            slim[list_key] = vals[:20]
            if len(vals) > 20:
                slim[f"{list_key}_truncated"] = len(vals) - 20
    areas = result.get("areas")
    if isinstance(areas, dict):
        slim["areas"] = dict(list(areas.items())[:12])
    qrs = result.get("qrs")
    if isinstance(qrs, list):
        slim["qrs"] = qrs[:5]
        slim["count"] = slim.get("count", len(qrs))
    for k, v in result.items():
        if k in slim or k in ("item", "items", "qrs", "personas", "equipos", "areas"):
            continue
        if isinstance(v, (int, float, str, bool)) or v is None:
            slim[k] = v
    return slim


def dump_tool_result(result: dict[str, Any]) -> str:
    """Payload compacto para el LLM (JSON sin indentación)."""
    slim = slim_tool_result(result if isinstance(result, dict) else {})
    return json.dumps(
        slim, ensure_ascii=False, default=str, separators=(",", ":")
    )
