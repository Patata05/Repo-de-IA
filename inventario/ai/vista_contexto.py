"""Contexto del panel derecho + listados multi-criterio (de aquí + TI…)."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from inventario import supabase_client as db

_AQUI_RE = re.compile(
    r"^(aqui|aquí|esta\s+lista|este\s+panel|este\s+visor|esta\s+persona|"
    r"este\s+area|esta\s+area|este\s+área|esta\s+área|el\s+panel|"
    r"la\s+lista|estos|estas)$",
    re.I,
)


def _fold(s: str) -> str:
    t = unicodedata.normalize("NFD", str(s or "").strip().lower())
    return "".join(c for c in t if unicodedata.category(c) != "Mn")


def normalize_contexto_vista(raw: Any) -> dict[str, str] | None:
    if not isinstance(raw, dict):
        return None
    tipo = _fold(str(raw.get("tipo") or raw.get("type") or ""))
    valor = str(raw.get("valor") or raw.get("value") or "").strip()
    aliases = {
        "person": "persona",
        "people": "persona",
        "area": "area",
        "origen": "origen",
        "inventario": "origen",
        "source": "origen",
    }
    tipo = aliases.get(tipo, tipo)
    if tipo not in {"persona", "area", "origen"} or not valor:
        return None
    # Quitar encoding tipo "Daniela::a||b"
    if "::" in valor:
        valor = valor.split("::", 1)[0].strip()
    if not valor:
        return None
    return {"tipo": tipo, "valor": valor}


def resolve_aqui_valor(
    valor: str, contexto: dict[str, str] | None
) -> tuple[str, str] | None:
    """Si valor es 'aquí'/'este panel', usa contexto_vista → (campo, valor)."""
    v = _fold(valor)
    if not _AQUI_RE.match(v.replace("  ", " ").strip()):
        # También: vacío + contexto, o "de aquí" residual
        if v not in {"aqui", "aquí"} and "aqui" not in v and "aquí" not in valor.lower():
            if not (
                "panel" in v
                or "lista" in v
                or "visor" in v
                or v in {"estos", "estas"}
            ):
                return None
    if not contexto:
        return None
    tipo = contexto["tipo"]
    return tipo, contexto["valor"]


def listar_criterios(
    criterios: list[dict[str, Any]],
    contexto: dict[str, str] | None = None,
) -> dict[str, Any]:
    """
    Ejecuta varios {campo|valor|limit} con etiquetas únicas globales.
    No rellena: si piden 5 y hay 2, devuelve 2 e informa el faltante.
    """
    if not isinstance(criterios, list) or not criterios:
        return {"ok": False, "error": "Indica al menos un criterio."}

    global_seen: set[str] = set()
    blocks: list[dict[str, Any]] = []
    all_items: list[dict] = []

    for raw in criterios:
        if not isinstance(raw, dict):
            continue
        campo = str(raw.get("campo") or "").strip()
        valor = str(raw.get("valor") or "").strip()
        try:
            # Chat: tope 40 por criterio (export/consolidación no usan esta ruta).
            limit = max(1, min(int(raw.get("limit") or 5), 40))
        except (TypeError, ValueError):
            limit = 5

        resolved = resolve_aqui_valor(valor, contexto) or resolve_aqui_valor(
            campo, contexto
        )
        if resolved:
            campo, valor = resolved
        elif _fold(valor) in {"aqui", "aquí"} or _fold(campo) in {"aqui", "aquí"}:
            if contexto:
                campo, valor = contexto["tipo"], contexto["valor"]
            else:
                return {
                    "ok": False,
                    "error": "contexto_vista_missing",
                    "hint": "aqui_sin_panel",
                }

        campo_n = db._fold_field(campo) if campo else ""
        if campo_n not in db.WRITABLE_FIELDS:
            # Inferir: TI → area, nombre persona → persona
            if contexto and _fold(valor) == _fold(contexto["valor"]):
                campo_n = contexto["tipo"]
            else:
                campo_n = "area" if len(valor) <= 12 else "persona"

        # Pool amplio (dedupe local) para elegir hasta `limit` sin chocar el lote.
        rows, err = db.list_por_campo(campo_n, valor, limit=50_000)
        if err:
            return {"ok": False, "error": err}
        disponibles = len(rows)

        taken: list[dict] = []
        for row in rows:
            etq = str(row.get("etiqueta") or "").strip().lower()
            if etq and etq in global_seen:
                continue
            if etq:
                global_seen.add(etq)
            taken.append(row)
            if len(taken) >= limit:
                break

        blocks.append(
            {
                "campo": campo_n,
                "valor": valor,
                "pedidos": limit,
                "devueltos": len(taken),
                "disponibles_filtro": disponibles,
                "faltaron": max(0, limit - len(taken)),
                "items": taken,
            }
        )
        all_items.extend(taken)

    compact = []
    for r in all_items:
        compact.append(
            {
                k: r.get(k)
                for k in (
                    "id",
                    "etiqueta",
                    "articulo",
                    "marca",
                    "modelo",
                    "area",
                    "persona",
                    "estado",
                    "origen",
                )
                if r.get(k) not in (None, "")
            }
        )

    # Viewer desde el primer bloque con campo persona/area/origen.
    viewer = None
    lista_lim = False
    for b in blocks:
        campo_b = str(b.get("campo") or "")
        valor_b = str(b.get("valor") or "").strip()
        if campo_b in {"persona", "area", "origen"} and valor_b:
            viewer = {"tipo": campo_b, "valor": valor_b}
        if int(b.get("pedidos") or 0) < 40:
            lista_lim = True
        if viewer:
            break

    return {
        "ok": True,
        "count": len(compact),
        "bloques": [
            {
                "campo": b["campo"],
                "valor": b["valor"],
                "pedidos": b["pedidos"],
                "devueltos": b["devueltos"],
                "faltaron": b["faltaron"],
                "disponibles_filtro": b["disponibles_filtro"],
            }
            for b in blocks
        ],
        "items": compact,
        "contexto_aplicado": contexto,
        "viewer": viewer,
        "filtro": viewer,
        "lista_limitada": lista_lim,
    }
