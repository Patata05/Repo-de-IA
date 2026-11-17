"""Preparar / confirmar consolidación entre orígenes (etiquetas únicas)."""

from __future__ import annotations

import logging
import re
from typing import Any

from inventario import supabase_client as db
from inventario.ai import pending_consolidacion as pending

logger = logging.getLogger(__name__)

_COPY_FIELDS = (
    "etiqueta",
    "articulo",
    "marca",
    "modelo",
    "serie",
    "area",
    "persona",
    "cantidad",
    "observaciones",
    "estado",
)


def _is_nuevo_destino(destino: str | None) -> bool:
    if destino is None:
        return True
    t = str(destino).strip().lower()
    if not t:
        return True
    folded = re.sub(r"\s+", " ", t)
    return folded in {
        "nuevo",
        "nueva",
        "nuevo inventario",
        "una nueva",
        "un nuevo",
        "un nuevo inventario",
        "inventario nuevo",
        "nueva inventario",
        "none",
        "null",
    } or bool(re.match(r"^nuevo(\s+inventario)?$", folded))


def _normalize_tramos(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        origen = str(item.get("origen") or "").strip()
        if not origen:
            continue
        cant_raw = item.get("cantidad")
        cantidad: int | None
        if cant_raw is None or str(cant_raw).strip() == "":
            cantidad = None
        else:
            try:
                cantidad = max(0, int(cant_raw))
            except (TypeError, ValueError):
                cantidad = None
        out.append({"origen": origen, "cantidad": cantidad})
    return out


def _row_to_insert(row: dict, destino: str) -> dict[str, Any]:
    payload: dict[str, Any] = {"origen": destino}
    for k in _COPY_FIELDS:
        if row.get(k) is not None and str(row.get(k)).strip() != "":
            payload[k] = row.get(k)
    if not payload.get("articulo"):
        payload["articulo"] = str(row.get("articulo") or "Artículo").strip() or "Artículo"
    if not payload.get("area"):
        payload["area"] = str(row.get("area") or "General").strip() or "General"
    if not payload.get("etiqueta"):
        payload["etiqueta"] = str(row.get("etiqueta") or "").strip()
    try:
        source_id = int(row.get("id"))
    except (TypeError, ValueError):
        source_id = None
    if source_id is not None:
        payload["_source_id"] = source_id
    return payload


def preparar_consolidacion(
    *,
    tramos: Any,
    destino: str | None,
    mover: bool,
    session_id: str | None,
) -> dict[str, Any]:
    """
    Filtra etiquetas únicas vs destino + lote, guarda pendiente y pide confirmación.
    """
    tramos_n = _normalize_tramos(tramos)
    if not tramos_n:
        return {
            "ok": False,
            "error": "Indica al menos un tramo con origen (ej. excel 1, Inventario 2).",
            "needs_confirm": False,
        }

    all_rows, read_err, _ = db.read_inventario()
    if read_err:
        logger.error("preparar_consolidacion read: %s", read_err)
        print(f"[inventario] preparar_consolidacion read error: {read_err}")
        return {"ok": False, "error": read_err, "needs_confirm": False}

    if _is_nuevo_destino(destino):
        destino_final = db.next_inventario_origen(all_rows)
        destino_es_nuevo = True
    else:
        resolved = db.resolve_origen_label(str(destino), all_rows)
        destino_final = resolved or str(destino).strip()
        destino_es_nuevo = resolved is None and not any(
            db._origen_fold(str(r.get("origen") or "")) == db._origen_fold(destino_final)
            for r in all_rows
        )

    dest_etq: set[str] = set()
    if not destino_es_nuevo:
        dest_etq, etq_err = db.etiquetas_en_origen(destino_final)
        if etq_err:
            return {"ok": False, "error": etq_err, "needs_confirm": False}

    lote: list[dict[str, Any]] = []
    lote_etq: set[str] = set()
    solicitados = 0
    omitidos = 0
    tramos_resumen: list[dict[str, Any]] = []
    errores_tramo: list[str] = []

    for tramo in tramos_n:
        origen_raw = tramo["origen"]
        cantidad = tramo.get("cantidad")
        source_rows, src_err = db.list_rows_por_origen(origen_raw, limit=cantidad)
        if src_err:
            errores_tramo.append(src_err)
            continue
        origen_real = (
            db.resolve_origen_label(origen_raw, all_rows) or origen_raw
        )
        if db._origen_fold(origen_real) == db._origen_fold(destino_final):
            errores_tramo.append(
                f"El origen «{origen_real}» no puede ser el mismo que el destino."
            )
            continue

        tomados = 0
        omitidos_tramo = 0
        for row in source_rows:
            solicitados += 1
            etq = str(row.get("etiqueta") or "").strip().lower()
            if not etq:
                omitidos += 1
                omitidos_tramo += 1
                continue
            if etq in dest_etq or etq in lote_etq:
                omitidos += 1
                omitidos_tramo += 1
                continue
            lote_etq.add(etq)
            lote.append(_row_to_insert(row, destino_final))
            tomados += 1
        tramos_resumen.append(
            {
                "origen": origen_real,
                "solicitados": len(source_rows),
                "validos": tomados,
                "omitidos_duplicados": omitidos_tramo,
                "cantidad_pedida": cantidad,
            }
        )

    if errores_tramo and not lote and solicitados == 0:
        return {
            "ok": False,
            "error": "; ".join(errores_tramo),
            "needs_confirm": False,
        }

    if not lote:
        return {
            "ok": True,
            "needs_confirm": False,
            "destino": destino_final,
            "destino_nuevo": destino_es_nuevo,
            "mover": bool(mover),
            "solicitados": solicitados,
            "validos": 0,
            "omitidos_duplicados": omitidos,
            "tramos": tramos_resumen,
            "errores_tramo": errores_tramo,
            "items": [],
        }

    sid = str(session_id or "").strip() or "default"
    pending.set_pending(
        sid,
        {
            "destino": destino_final,
            "destino_nuevo": destino_es_nuevo,
            "mover": bool(mover),
            "solicitados": solicitados,
            "validos": len(lote),
            "omitidos_duplicados": omitidos,
            "tramos": tramos_resumen,
            "rows": lote,
        },
    )
    print(
        f"[inventario] consolidación pendiente sid={sid} "
        f"destino={destino_final!r} validos={len(lote)} omitidos={omitidos} mover={mover}"
    )

    sample = []
    for row in lote[:12]:
        sample.append(
            {
                "etiqueta": row.get("etiqueta"),
                "articulo": row.get("articulo"),
                "persona": row.get("persona"),
                "area": row.get("area"),
                "origen": destino_final,
            }
        )

    return {
        "ok": True,
        "needs_confirm": True,
        "destino": destino_final,
        "destino_nuevo": destino_es_nuevo,
        "mover": bool(mover),
        "solicitados": solicitados,
        "validos": len(lote),
        "omitidos_duplicados": omitidos,
        "tramos": tramos_resumen,
        "errores_tramo": errores_tramo,
        "items": sample,
    }


def confirmar_consolidacion(session_id: str | None) -> dict[str, Any]:
    sid = str(session_id or "").strip() or "default"
    plan = pending.get_pending(sid)
    if not plan:
        return {
            "ok": False,
            "error": "No hay una consolidación pendiente de confirmar.",
            "mutated": False,
        }

    rows_raw = plan.get("rows") or []
    if not isinstance(rows_raw, list) or not rows_raw:
        pending.clear_pending(sid)
        return {
            "ok": False,
            "error": "El lote pendiente está vacío.",
            "mutated": False,
        }

    destino = str(plan.get("destino") or "").strip()
    mover = bool(plan.get("mover"))
    source_ids: list[int] = []
    to_insert: list[dict] = []
    for row in rows_raw:
        if not isinstance(row, dict):
            continue
        payload = {k: v for k, v in row.items() if k != "_source_id"}
        payload["origen"] = destino
        to_insert.append(payload)
        sid_raw = row.get("_source_id")
        if sid_raw is not None:
            try:
                source_ids.append(int(sid_raw))
            except (TypeError, ValueError):
                pass

    try:
        saved, err = db.create_inventario_rows_bulk(to_insert)
        if err:
            logger.error("confirmar_consolidacion insert: %s", err)
            print(f"[inventario] confirmar_consolidacion insert error: {err}")
            return {"ok": False, "error": err, "mutated": False}

        deleted = 0
        delete_err = None
        if mover and source_ids:
            deleted, delete_err = db.delete_inventario_by_ids(source_ids)
            if delete_err:
                logger.error(
                    "confirmar_consolidacion delete tras insert: %s", delete_err
                )
                print(
                    f"[inventario] confirmar_consolidacion delete error: {delete_err}"
                )

        pending.clear_pending(sid)
        omitidos = int(plan.get("omitidos_duplicados") or 0)
        print(
            f"[inventario] consolidación OK sid={sid} destino={destino!r} "
            f"insertados={len(saved)} deleted={deleted} mover={mover}"
        )
        return {
            "ok": True,
            "mutated": True,
            "destino": destino,
            "mover": mover,
            "insertados": len(saved),
            "eliminados_origen": deleted if mover else 0,
            "omitidos_duplicados": omitidos,
            "items": [
                {
                    k: r.get(k)
                    for k in (
                        "id",
                        "etiqueta",
                        "articulo",
                        "persona",
                        "area",
                        "origen",
                    )
                    if r.get(k) not in (None, "")
                }
                for r in saved[:50]
            ],
            "delete_error": delete_err,
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("confirmar_consolidacion excepción")
        print(f"[inventario] confirmar_consolidacion excepción: {exc!r}")
        return {"ok": False, "error": str(exc), "mutated": False}


def cancelar_consolidacion(session_id: str | None) -> dict[str, Any]:
    sid = str(session_id or "").strip() or "default"
    plan = pending.get_pending(sid)
    if not plan:
        return {
            "ok": True,
            "cancelled": False,
            "had_pending": False,
        }
    destino = str(plan.get("destino") or "").strip() or "destino"
    pending.clear_pending(sid)
    return {
        "ok": True,
        "cancelled": True,
        "had_pending": True,
        "destino": destino,
    }
