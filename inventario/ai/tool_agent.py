"""Agente pydantic-ai + OpenAI con tools reales de Supabase."""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any

import httpx
from pydantic_ai import RunContext

logger = logging.getLogger(__name__)

# Singleton: AsyncClient keep-alive para OpenAI (PydanticAI).
_OPENAI_HTTP: httpx.AsyncClient | None = None
_AGENT_LOCK = threading.Lock()
_AGENT_CACHE: dict[tuple[str, str, str, str], Any] = {}


def _openai_http_client() -> httpx.AsyncClient:
    global _OPENAI_HTTP
    if _OPENAI_HTTP is None or _OPENAI_HTTP.is_closed:
        _OPENAI_HTTP = httpx.AsyncClient(
            timeout=httpx.Timeout(60.0, connect=10.0),
            limits=httpx.Limits(max_keepalive_connections=20, max_connections=40),
        )
    return _OPENAI_HTTP


# Bump al cambiar instrucciones/tools del Agent (invalida singleton).
_AGENT_INSTR_VER = "v9-panorama-export-confirm"

def _cache_key(api_key: str, model_name: str, base_url: str) -> tuple[str, str, str, str]:
    # No guardar la key completa en logs; fingerprint corto para el dict.
    fp = f"{api_key[:8]}…{api_key[-4:]}" if len(api_key) > 12 else api_key
    return (fp, model_name, base_url.rstrip("/"), _AGENT_INSTR_VER)

TOOL_AGENT_INSTRUCTIONS = """
Eres el asistente de inventario (español de México). Tono cálido, claro y profesional.
TÚ redactas SIEMPRE la respuesta al usuario en párrafos naturales. Las tools solo
devuelven datos/estados crudos: NUNCA copies un “mensaje” prefabricado de una tool;
interpreta los hechos (totales, items, ok/error) y habla como en una conversación real.

Reglas de verdad:
- NUNCA inventes etiquetas, totales, personas, áreas ni marcas.
- Toda cifra o ficha debe salir de una tool de Supabase. Si la tool no encuentra
  nada, dilo con naturalidad y ofrece otra búsqueda.
- Ortografía: interpreta faltas sin corregir al usuario en voz alta; usa la tool
  con el nombre que entendiste.
- Usa el hilo reciente y la memoria de sesión: mantén el contexto (persona/área/
  excel anunciado, confirmaciones pendientes, etc.).

Estilo:
- Responde en párrafos naturales y conversacionales (1–3 frases o un párrafo corto).
- PROHIBIDO viñetas (•), guiones (- *) o listas verticales campo por campo.
- Si piden “últimos registros” o varios artículos: un párrafo breve por ítem
  (“Etiqueta **269459** — **Laptop HP …** asignada a **Nombre** en **Área**,
  estado **Activo**.”). Negritas sutiles; sin bullets.
- Si te saludan, saluda con amabilidad y pregunta en qué puedes apoyar hoy.
- Cierra con UNA pregunta breve de seguimiento cuando aporte.
- No uses slang (chido, órale, neta, wey).

Excel / archivos (importante):
- SUBIR/IMPORTAR ≠ EXPORTAR/DESCARGAR. Son acciones opuestas.
- Si el usuario quiere SUBIR o IMPORTAR un Excel/CSV (“quiero importarte un
  excel”, “te voy a subir un archivo”, “cómo subo mi excel”, “voy a adjuntar”)
  SIN archivo en este turno: explica en prosa cómo hacerlo (botón «+» o
  arrastrar .xlsx/.csv a la barra inferior) y las columnas esperadas
  (ETIQUETA, ARTÍCULO, MARCA, MODELO, SERIE, ÁREA, PERSONA, CANTIDAD, ESTADO).
  NO inventes ni generes un Excel descargable. NO llames tools de exportación.
- Crear / juntar / trasladar inventarios en Supabase ≠ exportar. Si pide
  “crea un nuevo inventario…”, “junta excel 1 y 2…”, “traslada registros…”,
  “arma un Inventario N…”, usa SOLO preparar/confirmar_consolidacion_inventario.
  PROHIBIDO generar .xlsx, tarjetas de descarga o hablar de “archivo listo”.
- Panorama / resumen / “dame el panorama de xlsx 2” ≠ exportar. Usa
  panorama_inventario (o contar_por_campo/resumen). NUNCA digas “archivo listo”
  ni generes descarga. Alias: xlsx/ecel/exel/csv N → excel N real en Supabase.
- “Inventario general” / “todo el inventario” / “general” SIN persona/área →
  TODOS los registros (resumen_inventario o panorama_inventario sin origen).
  NUNCA filtres por la palabra “general” como texto de origen/área.
- Exportar Excel (solo con “exporta”, “descarga”, “dame el archivo excel”):
  1) preparar_exportacion_excel → vista previa + contexto_vista; pregunta
     confirmación; exportar_excel=false (sin tarjeta).
  2) Si confirma → confirmar_exportacion_excel (exportar_excel=true + items).
- Importar con archivo adjunto: si falta el archivo, invita a adjuntarlo.

Orígenes (regla estricta):
- “excel N” SOLO existe si el usuario subió un archivo .xlsx/.csv. PROHIBIDO
  crear “excel 1/2/3…” desde el chat o tools internas.
- Contenedores creados/consolidados en chat → SIEMPRE “Inventario 1, 2, 3…”
  (consecutivo). “actual” / “más reciente” / sin número → Inventario N mayor.
- Al pasar datos DESDE un excel N hacia un Inventario: SOLO copia (mover=false).
  NUNCA borres ni vacíes el excel fuente.

Consolidación / Inventario N (Supabase directo):
- preparar_consolidacion_inventario(tramos, destino?, mover?) → OBLIGATORIO
  para crear/juntar/copiar. Cada tramo: origen?, persona?, area?, articulo?,
  cantidad?. Ej. “4 de Fernanda… en inventario nuevo” → destino=null.
- “pasa excel 1 al inventario más reciente” →
  tramos=[{origen:'excel 1'}], destino='más reciente', mover=false.
  Informa validos / omitidos_duplicados / destino y pide:
  «¿Deseas pasar estos X registros a Inventario N? Confirma con sí».
- SIEMPRE confirma antes. sí → confirmar_consolidacion_inventario;
  no → cancelar_consolidacion_inventario. NUNCA exportes Excel aquí.

Eliminación explícita:
- Solo con pedido claro (“elimina el excel 1”, “borra el Inventario 5”).
- preparar_eliminacion_origen(origen) → cuenta + pide confirmación.
- sí → confirmar_eliminacion_origen. Tras borrar un excel N, renumerar
  automáticamente los excel restantes (más viejo→excel 1, etc.).

Tools (elige la mínima necesaria; solo datos):
- contar_total / resumen_inventario → totales globales.
- ranking_areas → OBLIGATORIO si piden “áreas en general”, “todas las áreas”,
  “qué áreas hay”, “ranking de áreas” SIN nombrar un departamento. Devuelve
  el ranking completo. NUNCA uses contar_por_campo ni buscar_inventario para
  eso (no arrastres el área del turno anterior).
- contar_por_campo(campo=persona|area|origen|marca|..., valor=...) →
  persona (“registros de Eduardo”) O UN área concreta (TI → Sistemas y TI).
  Columna area SIN acento. No busques “ti” como texto libre.
  Si filtraste por PERSONA → viewer/filtro tipo=persona (NUNCA uses el área
  de un artículo). Si filtraste por ÁREA puntual → viewer tipo=area.
- buscar_inventario(query, limit) → listados.
- obtener_por_etiqueta → ficha exacta.
- listar_recientes → últimos / de hoy.
- buscar_semantico → si la léxica falla o piden “similar a…”.
- generar_qr → SOLO si piden QR (no para “dame etiquetas”).
  “todos los QR” / sin N → TODOS los registros (o del origen indicado:
  excel 1 / Inventario 1). Con N concreto → ese N. El visor recibe la
  lista completa; en el chat resume el total + 3–5 ejemplos.
- listar_criterios → varios filtros (N de aquí y M de TI).
- preparar/confirmar/cancelar_consolidacion_inventario → crear/copiar en
  Supabase (ver bloque Consolidación). NO exporta Excel.
- preparar/confirmar/cancelar_eliminacion_origen → borrar excel/Inventario
  con confirmación; renumerar exceles tras borrar.
- panorama_inventario(origen?) → OBLIGATORIO para “panorama general”, “resumen
  de excel/xlsx 2”, “inventario general”. origen=null → todo el inventario.
  Normaliza xlsx/ecel→excel. Devuelve métricas + viewer; SIN Excel.
- preparar/confirmar_exportacion_excel → solo con pedido explícito de descarga.
- comparar_inventarios(origenes?) → OBLIGATORIO para “compara inventarios”,
  “compara excel 1 vs excel 2”, “compara todo”, “diferencias entre inventarios”.
  origenes=null → todos. Devuelve SOLO métricas (totales, cruces de etiquetas,
  áreas). Redacta un panorama claro con esas cifras; NO listes filas.

Orígenes: excel N (importados; alias xlsx/xls/csv/ecel N); Inventario N (creados).
No inventes nombres. No uses “general” como valor de origen.
""".strip()

# Alineado con CHAT_SIDE_RESULT_CAP del front: todas las etiquetas del filtro.
MAX_SIDE_ITEMS = 2000

# Exportación Excel pendiente (vista previa → confirmación).
_EXPORT_PENDING: dict[str, dict[str, Any]] = {}
_EXPORT_LOCK = threading.Lock()
_EXPORT_TTL_SEC = 10 * 60


def canonicalize_origen_alias(needle: str) -> str:
    """xlsx/ecel/exel/csv/xls N → excel N; resto igual."""
    import re

    t = str(needle or "").strip()
    if not t:
        return t
    m = re.match(
        r"(?i)^(xlsx|xls|csv|ecel|exel|excel)e?s?\s*(\d+)\s*$",
        t,
    )
    if m:
        return f"excel {int(m.group(2))}"
    # “general” / “todo” no son orígenes.
    folded = re.sub(r"\s+", " ", t.lower())
    if folded in {
        "general",
        "inventario general",
        "todo",
        "todo el inventario",
        "todos",
        "completa",
        "completo",
    }:
        return ""
    return t


def resolve_origen_alias(needle: str, rows: list[dict] | None = None) -> str | None:
    from inventario import supabase_client as db

    canon = canonicalize_origen_alias(needle)
    if not canon:
        return None
    return db.resolve_origen_label(canon, rows) or (
        db.resolve_origen_label(str(needle or "").strip(), rows)
    )


def _export_set_pending(session_id: str | None, payload: dict[str, Any]) -> None:
    sid = str(session_id or "").strip() or "default"
    data = dict(payload)
    data["created_at"] = __import__("time").time()
    with _EXPORT_LOCK:
        _EXPORT_PENDING[sid] = data


def _export_get_pending(session_id: str | None) -> dict[str, Any] | None:
    import time

    sid = str(session_id or "").strip() or "default"
    with _EXPORT_LOCK:
        dead = [
            k
            for k, v in _EXPORT_PENDING.items()
            if time.time() - float(v.get("created_at") or 0) > _EXPORT_TTL_SEC
        ]
        for k in dead:
            _EXPORT_PENDING.pop(k, None)
        payload = _EXPORT_PENDING.get(sid)
        return dict(payload) if isinstance(payload, dict) else None


def _export_clear_pending(session_id: str | None) -> None:
    sid = str(session_id or "").strip() or "default"
    with _EXPORT_LOCK:
        _EXPORT_PENDING.pop(sid, None)


def _panorama_metrics(rows: list[dict]) -> dict[str, Any]:
    personas: set[str] = set()
    areas: dict[str, int] = {}
    articulos: set[str] = set()
    activos = 0
    for row in rows:
        p = str(row.get("persona") or "").strip()
        if p:
            personas.add(p)
        a = str(row.get("area") or "").strip() or "Sin área"
        areas[a] = areas.get(a, 0) + 1
        art = str(row.get("articulo") or "").strip()
        if art:
            articulos.add(art)
        est = str(row.get("estado") or "").strip().lower()
        if est not in {"inactivo", "baja", "no", "inactive"}:
            activos += 1
    top_areas = sorted(areas.items(), key=lambda kv: (-kv[1], kv[0].casefold()))[:8]
    return {
        "registros": len(rows),
        "personas": len(personas),
        "areas": len(areas),
        "tipos_equipo": len(articulos),
        "activos": activos,
        "top_areas": [{"area": a, "articulos": n} for a, n in top_areas],
    }


def generar_qr_data(
    *,
    etiqueta: str | None = None,
    query: str | None = None,
    origen: str | None = None,
    limit: int | None = None,
    ultimo: bool = False,
) -> dict[str, Any]:
    """
    Genera QR sin tope artificial de 5/50.
    limit=None → todos los que correspondan (visor completo).
    limit=N → exactamente N (pedido explícito del usuario).
    """
    from inventario import supabase_client as db
    from inventario.ai.tools import format_inventario_qr_text

    all_rows, err, _ = db.read_inventario()
    if err:
        return {"ok": False, "error": err, "qr": [], "qrs": [], "count": 0}

    rows_batch: list[dict[str, Any]] = []
    viewer: dict[str, Any] | None = None
    cap = int(limit) if isinstance(limit, int) and limit > 0 else None

    # 1) Origen explícito o alias en query (excel 1 / Inventario 2).
    origen_raw = str(origen or "").strip()
    q_raw = str(query or "").strip()
    origen_from_query = ""
    if not origen_raw and q_raw:
        canon_q = canonicalize_origen_alias(q_raw) or q_raw
        if db.is_excel_origen_label(canon_q) or db.is_inventario_origen_label(
            canon_q
        ):
            origen_from_query = canon_q
    origen_needle = origen_raw or origen_from_query
    if origen_needle:
        resolved = resolve_origen_alias(origen_needle, all_rows)
        if not resolved:
            return {
                "ok": False,
                "error": f"No encontré el origen «{origen_needle}».",
                "qr": [],
                "qrs": [],
                "count": 0,
            }
        want = db._origen_fold(resolved)
        rows_batch = [
            r
            for r in all_rows
            if db._origen_fold(str(r.get("origen") or "")) == want
        ]
        viewer = {"tipo": "origen", "valor": resolved}
    elif str(etiqueta or "").strip():
        found, e2 = db.get_by_etiqueta(str(etiqueta).strip())
        if e2:
            return {"ok": False, "error": e2, "qr": [], "qrs": [], "count": 0}
        rows_batch = list(found or [])
    elif ultimo:
        found, e2 = db.listar_recientes(limit=1, solo_hoy=False)
        if e2:
            return {"ok": False, "error": e2, "qr": [], "qrs": [], "count": 0}
        rows_batch = list(found or [])
    elif q_raw:
        by_person, _ = db.list_por_campo("persona", q_raw, limit=50_000)
        if by_person:
            rows_batch = list(by_person)
            viewer = {"tipo": "persona", "valor": q_raw}
        else:
            by_area, _ = db.list_por_campo("area", q_raw, limit=50_000)
            if by_area:
                rows_batch = list(by_area)
                resolved_area = db.resolve_area_label(q_raw, all_rows) or q_raw
                viewer = {"tipo": "area", "valor": resolved_area}
            else:
                found, e2 = db.search_inventario(q_raw, limit=min(cap or 2000, 2000))
                if e2:
                    return {
                        "ok": False,
                        "error": e2,
                        "qr": [],
                        "qrs": [],
                        "count": 0,
                    }
                rows_batch = list(found or [])
    else:
        # “todos los QR” sin filtro → inventario completo.
        rows_batch = list(all_rows)
        viewer = {"tipo": "origen", "valor": "Todo el inventario"}

    if cap is not None:
        rows_batch = rows_batch[:cap]

    seen: set[str] = set()
    unique_rows: list[dict[str, Any]] = []
    for row in rows_batch:
        etq = str(row.get("etiqueta") or "").strip()
        if not etq:
            continue
        key = str(row.get("id")) if row.get("id") is not None else etq.lower()
        if key in seen:
            continue
        seen.add(key)
        unique_rows.append(row)

    if not unique_rows:
        return {
            "ok": False,
            "error": "No encontré artículos con etiqueta para generar QR.",
            "qr": [],
            "qrs": [],
            "count": 0,
        }

    qrs: list[dict[str, Any]] = []
    items: list[dict[str, Any]] = []
    for r in unique_rows:
        text = format_inventario_qr_text(r)
        if not text:
            continue
        item = {
            k: r.get(k)
            for k in (
                "id",
                "etiqueta",
                "articulo",
                "persona",
                "area",
                "origen",
                "estado",
            )
            if r.get(k) not in (None, "")
        }
        items.append(item)
        qrs.append(
            {
                "text": text,
                "etiqueta": item.get("etiqueta"),
                "articulo": item.get("articulo"),
                "id": item.get("id"),
                "persona": item.get("persona"),
                "area": item.get("area"),
                "origen": item.get("origen"),
                "item": item,
            }
        )

    if not qrs:
        return {
            "ok": False,
            "error": "qr_text_empty",
            "qr": [],
            "qrs": [],
            "count": 0,
        }

    sample = [
        str(c.get("etiqueta") or "").strip()
        for c in qrs[:5]
        if str(c.get("etiqueta") or "").strip()
    ]
    focus = (
        (viewer or {}).get("valor")
        if isinstance(viewer, dict)
        else (origen_needle or q_raw or "inventario")
    )
    return {
        "ok": True,
        "count": len(qrs),
        "items": items,
        "qr": qrs,  # lista completa → visor (deps.qr vía _absorb)
        "qrs": qrs,
        "qr_text": qrs[0]["text"],
        "viewer": viewer,
        "filtro": viewer,
        "exportar_excel": False,
        "mensaje_agente": (
            f"Se generaron {len(qrs)} códigos QR"
            + (f" de «{focus}»" if focus else "")
            + " y están en el visor derecho. "
            f"En el chat resume el total"
            + (f" y menciona ejemplos: {', '.join(sample)}" if sample else "")
            + ". NO listes todos los QR en el texto."
        ),
    }


def panorama_inventario_data(
    origen: str | None = None,
) -> dict[str, Any]:
    """
    Panorama de un origen (excel N) o de TODO el inventario si origen vacío/general.
    """
    from inventario import supabase_client as db

    all_rows, err, _ = db.read_inventario()
    if err:
        return {"ok": False, "error": err, "exportar_excel": False}

    label = "Todo el inventario"
    scope_rows = all_rows
    viewer: dict[str, Any]

    raw = str(origen or "").strip()
    canon = canonicalize_origen_alias(raw) if raw else ""
    if canon:
        resolved = resolve_origen_alias(raw, all_rows)
        if not resolved:
            return {
                "ok": False,
                "error": f"No encontré el origen «{raw}».",
                "exportar_excel": False,
            }
        want = db._origen_fold(resolved)
        scope_rows = [
            r
            for r in all_rows
            if db._origen_fold(str(r.get("origen") or "")) == want
        ]
        label = resolved
        viewer = {"tipo": "origen", "valor": resolved}
    else:
        # Inventario general / todo → sin filtrar por la palabra "general".
        viewer = {"tipo": "origen", "valor": "Todo el inventario"}

    metrics = _panorama_metrics(scope_rows)
    sample = []
    for row in scope_rows[:12]:
        sample.append(
            {
                k: row.get(k)
                for k in (
                    "id",
                    "etiqueta",
                    "articulo",
                    "persona",
                    "area",
                    "estado",
                    "origen",
                )
                if row.get(k) not in (None, "")
            }
        )

    return {
        "ok": True,
        "titulo": f"Panorama de {label}",
        "origen": label if canon else None,
        "general": not bool(canon),
        **metrics,
        "items": sample,
        "viewer": viewer,
        "filtro": viewer,
        "exportar_excel": False,
        "mensaje_agente": (
            f"Redacta el panorama de «{label}» con registros={metrics['registros']}, "
            f"personas={metrics['personas']}, áreas={metrics['areas']}, "
            f"activos={metrics['activos']}. NO generes Excel ni digas archivo listo."
        ),
    }


def preparar_exportacion_excel_data(
    *,
    session_id: str | None,
    origen: str | None = None,
    persona: str | None = None,
    area: str | None = None,
) -> dict[str, Any]:
    """Vista previa de exportación: métricas + viewer; sin archivo aún."""
    from inventario import supabase_client as db

    all_rows, err, _ = db.read_inventario()
    if err:
        return {"ok": False, "error": err, "needs_confirm": False, "exportar_excel": False}

    rows = list(all_rows)
    focus_bits: list[str] = []

    o_raw = str(origen or "").strip()
    if o_raw and canonicalize_origen_alias(o_raw):
        resolved = resolve_origen_alias(o_raw, all_rows)
        if not resolved:
            return {
                "ok": False,
                "error": f"No encontré el origen «{o_raw}».",
                "needs_confirm": False,
                "exportar_excel": False,
            }
        want = db._origen_fold(resolved)
        rows = [
            r for r in rows if db._origen_fold(str(r.get("origen") or "")) == want
        ]
        focus_bits.append(resolved)
        viewer = {"tipo": "origen", "valor": resolved}
    elif o_raw and not canonicalize_origen_alias(o_raw):
        # “inventario general” → todos
        focus_bits.append("Inventario general")
        viewer = {"tipo": "origen", "valor": "Todo el inventario"}
    else:
        focus_bits.append("Inventario general")
        viewer = {"tipo": "origen", "valor": "Todo el inventario"}

    if persona:
        rows = [r for r in rows if _fold_match(r.get("persona"), persona)]
        focus_bits.append(persona)
        viewer = {"tipo": "persona", "valor": persona}
    if area:
        resolved_area = db.resolve_area_label(area, all_rows) or area
        rows = [
            r
            for r in rows
            if _fold_match(r.get("area"), resolved_area)
            or _fold_match(r.get("area"), area)
        ]
        focus_bits.append(resolved_area)
        viewer = {"tipo": "area", "valor": resolved_area}

    # Compactar filas para el lote (sin embedding).
    compact = []
    for row in rows:
        etq = str(row.get("etiqueta") or "").strip()
        if not etq:
            continue
        compact.append(
            {
                k: row.get(k)
                for k in (
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
                )
                if row.get(k) not in (None, "")
            }
        )

    metrics = _panorama_metrics(compact)
    focus = " · ".join(focus_bits) or "Inventario general"
    _export_set_pending(
        session_id,
        {
            "focus": focus,
            "rows": compact,
            "metrics": metrics,
            "viewer": viewer,
        },
    )
    return {
        "ok": True,
        "needs_confirm": True,
        "focus": focus,
        **metrics,
        "viewer": viewer,
        "filtro": viewer,
        "items": compact[:40],
        "exportar_excel": False,
        "mensaje_agente": (
            f"Hay {metrics['registros']} registros listos para Excel («{focus}»), "
            f"{metrics['personas']} personas, {metrics['areas']} áreas. "
            "Muestra el panorama en el visor, resume cifras y PIDE confirmación "
            "antes de generar el archivo. NO digas que el Excel ya está listo."
        ),
    }


def confirmar_exportacion_excel_data(session_id: str | None) -> dict[str, Any]:
    plan = _export_get_pending(session_id)
    if not plan:
        return {
            "ok": False,
            "error": "No hay una exportación Excel pendiente de confirmar.",
            "exportar_excel": False,
            "mutated": False,
        }
    rows = plan.get("rows") if isinstance(plan.get("rows"), list) else []
    focus = str(plan.get("focus") or "Inventario")
    metrics = plan.get("metrics") if isinstance(plan.get("metrics"), dict) else {}
    viewer = plan.get("viewer") if isinstance(plan.get("viewer"), dict) else None
    _export_clear_pending(session_id)
    return {
        "ok": True,
        "confirmed": True,
        "focus": focus,
        **metrics,
        "items": rows[:MAX_SIDE_ITEMS],
        "count": len(rows),
        "viewer": viewer,
        "exportar_excel": True,
        "mensaje_agente": (
            f"Confirmado: el Excel de «{focus}» con {len(rows)} registros "
            "queda autorizado para descarga. El frontend genera la tarjeta."
        ),
    }


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
    import re

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


def _fold_destino_alias(destino: str | None) -> str:
    import re
    import unicodedata

    t = str(destino or "").strip().lower()
    t = "".join(
        c
        for c in unicodedata.normalize("NFD", t)
        if unicodedata.category(c) != "Mn"
    )
    return re.sub(r"\s+", " ", t).strip()


def _is_latest_destino_alias(destino: str | None) -> bool:
    folded = _fold_destino_alias(destino)
    if not folded:
        return False
    return folded in {
        "mas reciente",
        "el mas reciente",
        "inventario mas reciente",
        "el inventario mas reciente",
        "inventario actual",
        "el inventario actual",
        "actual",
        "el actual",
        "reciente",
        "el reciente",
        "ultimo",
        "el ultimo",
        "ultimo inventario",
        "el ultimo inventario",
        "inventario reciente",
    } or bool(
        __import__("re").search(
            r"\b(mas reciente|inventario actual|ultimo inventario)\b",
            folded,
        )
    )


def _resolve_destino_flex(
    destino: str | None, all_rows: list[dict]
) -> tuple[str, bool, str | None]:
    """
    Destino interno → siempre Inventario N.
    'actual' / 'más reciente' → Inventario con mayor N.
    Nunca crea un origen nuevo 'excel N' desde el chat.
    """
    from inventario import supabase_client as db

    if _is_nuevo_destino(destino):
        return db.next_inventario_origen(all_rows), True, None

    if _is_latest_destino_alias(destino):
        latest = db.latest_inventario_origen(all_rows)
        exists = db.resolve_origen_label(latest, all_rows) is not None
        return latest, not exists, "destino_mas_reciente"

    raw = canonicalize_origen_alias(str(destino or "").strip()) or str(
        destino or ""
    ).strip()
    resolved = db.resolve_origen_label(raw, all_rows)
    if resolved:
        return resolved, False, None

    # Destino nuevo: jamás crear excel N desde chat.
    if db.is_excel_origen_label(raw):
        dest = db.next_inventario_origen(all_rows)
        return dest, True, "excel_nuevo_prohibido"

    if db.is_inventario_origen_label(raw):
        import re

        m = re.match(r"(?i)^inventario\s+(\d+)\s*$", raw)
        num = int(m.group(1)) if m else 0
        return f"Inventario {num}", True, None

    # Cualquier otro nombre libre nuevo → Inventario N consecutivo.
    return db.next_inventario_origen(all_rows), True, "destino_forzado_inventario"


def _tramo_origen_es_excel(tramo: dict[str, Any], all_rows: list[dict]) -> bool:
    from inventario import supabase_client as db

    o = str(tramo.get("origen") or "").strip()
    if not o:
        return False
    resolved = db.resolve_origen_label(o, all_rows) or canonicalize_origen_alias(o) or o
    return db.is_excel_origen_label(resolved)


def _normalize_tramos_flex(raw: Any) -> list[dict[str, Any]]:
    """Tramos con origen/persona/area/articulo + cantidad opcional."""
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        origen = str(item.get("origen") or "").strip()
        persona = str(item.get("persona") or "").strip()
        area = str(item.get("area") or "").strip()
        articulo = str(item.get("articulo") or "").strip()
        if not (origen or persona or area or articulo):
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
        out.append(
            {
                "origen": origen,
                "persona": persona,
                "area": area,
                "articulo": articulo,
                "cantidad": cantidad,
            }
        )
    return out


def _fold_match(value: object, needle: str) -> bool:
    from inventario.supabase_client import _fold_text

    blob = _fold_text(str(value or ""))
    want = _fold_text(needle)
    if not blob or not want:
        return False
    if blob == want or want in blob or blob in want:
        return True
    toks = [t for t in want.split() if len(t) > 2]
    return bool(toks) and all(t in blob for t in toks)


def _rows_for_tramo_flex(
    tramo: dict[str, Any], all_rows: list[dict]
) -> tuple[list[dict], str | None, str]:
    """Filtra filas por origen/persona/area/articulo. Devuelve (rows, error, etiqueta_tramo)."""
    from inventario import supabase_client as db

    origen = str(tramo.get("origen") or "").strip()
    persona = str(tramo.get("persona") or "").strip()
    area = str(tramo.get("area") or "").strip()
    articulo = str(tramo.get("articulo") or "").strip()
    cantidad = tramo.get("cantidad")
    label_bits = [p for p in (origen, persona, area, articulo) if p]
    label = " · ".join(label_bits) or "tramo"

    rows = list(all_rows)
    if origen:
        resolved = resolve_origen_alias(origen, all_rows)
        if not resolved:
            return [], f"No encontré el origen «{origen}».", label
        want = db._origen_fold(resolved)
        rows = [
            r
            for r in rows
            if db._origen_fold(str(r.get("origen") or "")) == want
        ]
        label = resolved if not (persona or area or articulo) else f"{resolved} · {label}"

    if persona:
        rows = [r for r in rows if _fold_match(r.get("persona"), persona)]
    if area:
        resolved_area = db.resolve_area_label(area, all_rows) or area
        rows = [
            r
            for r in rows
            if _fold_match(r.get("area"), resolved_area)
            or _fold_match(r.get("area"), area)
        ]
    if articulo:
        rows = [r for r in rows if _fold_match(r.get("articulo"), articulo)]

    # Solo filas con etiqueta.
    rows = [r for r in rows if str(r.get("etiqueta") or "").strip()]

    def _id_key(row: dict) -> int:
        try:
            return int(row.get("id") or 0)
        except (TypeError, ValueError):
            return 0

    rows.sort(key=_id_key)
    # Dedupe por etiqueta dentro del tramo.
    seen: set[str] = set()
    unique: list[dict] = []
    for row in rows:
        etq = str(row.get("etiqueta") or "").strip().lower()
        if not etq or etq in seen:
            continue
        seen.add(etq)
        unique.append(row)
    if isinstance(cantidad, int) and cantidad >= 0:
        unique = unique[:cantidad]
    return unique, None, label


def _row_to_insert_flex(row: dict, destino: str) -> dict[str, Any]:
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


def preparar_consolidacion_flex(
    *,
    tramos: Any,
    destino: str | None,
    mover: bool,
    session_id: str | None,
) -> dict[str, Any]:
    """
    Prepara crear/mover en Supabase con tramos flexibles
    (origen/persona/area/articulo + cantidad). Sin Excel.
    """
    from inventario import supabase_client as db
    from inventario.ai import pending_consolidacion as pending

    tramos_n = _normalize_tramos_flex(tramos)
    if not tramos_n:
        return {
            "ok": False,
            "error": (
                "Indica al menos un tramo con origen, persona, área o artículo "
                "(ej. {persona:'Fernanda Vargas', cantidad:4})."
            ),
            "needs_confirm": False,
        }

    all_rows, read_err, _ = db.read_inventario()
    if read_err:
        return {"ok": False, "error": read_err, "needs_confirm": False}

    destino_final, destino_es_nuevo, dest_note = _resolve_destino_flex(
        destino, all_rows
    )

    # Fuentes excel N: solo COPIA (nunca borrar/vaciar el archivo subido).
    fuentes_excel = any(
        _tramo_origen_es_excel(tramo, all_rows) for tramo in tramos_n
    )
    mover_efectivo = bool(mover) and not fuentes_excel
    if fuentes_excel and mover:
        dest_note = (
            f"{dest_note};" if dest_note else ""
        ) + "copia_sin_borrar_excel"

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
        source_rows, src_err, label = _rows_for_tramo_flex(tramo, all_rows)
        if src_err:
            errores_tramo.append(src_err)
            continue
        # No mover/copiar desde el mismo destino.
        if tramo.get("origen"):
            origen_real = (
                db.resolve_origen_label(str(tramo["origen"]), all_rows)
                or str(tramo["origen"])
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
            # En mover: no re-tomar filas que ya están en el destino.
            if mover_efectivo and not destino_es_nuevo:
                row_origen = db._origen_fold(str(row.get("origen") or ""))
                if row_origen == db._origen_fold(destino_final):
                    omitidos += 1
                    omitidos_tramo += 1
                    continue
            lote_etq.add(etq)
            lote.append(_row_to_insert_flex(row, destino_final))
            tomados += 1
        tramos_resumen.append(
            {
                "filtro": {
                    "origen": tramo.get("origen") or None,
                    "persona": tramo.get("persona") or None,
                    "area": tramo.get("area") or None,
                    "articulo": tramo.get("articulo") or None,
                },
                "etiqueta": label,
                "solicitados": len(source_rows),
                "validos": tomados,
                "omitidos_duplicados": omitidos_tramo,
                "cantidad_pedida": tramo.get("cantidad"),
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
            "mover": mover_efectivo,
            "fuentes_excel": fuentes_excel,
            "nota_destino": dest_note,
            "solicitados": solicitados,
            "validos": 0,
            "omitidos_duplicados": omitidos,
            "tramos": tramos_resumen,
            "errores_tramo": errores_tramo,
            "items": [],
            "exportar_excel": False,
            "mensaje_agente": (
                f"No hay registros nuevos que pasar a «{destino_final}»: "
                f"{omitidos} ya están (etiqueta duplicada) o el origen está vacío. "
                "Informa con claridad y NO borres los excel."
            ),
        }

    sid = str(session_id or "").strip() or "default"
    pending.set_pending(
        sid,
        {
            "destino": destino_final,
            "destino_nuevo": destino_es_nuevo,
            "mover": mover_efectivo,
            "mode": (
                "update_origen"
                if mover_efectivo and not destino_es_nuevo
                else "insert"
            ),
            "solicitados": solicitados,
            "validos": len(lote),
            "omitidos_duplicados": omitidos,
            "tramos": tramos_resumen,
            "rows": lote,
            "fuentes_excel": fuentes_excel,
        },
    )
    print(
        f"[inventario] consolidación flex pendiente sid={sid} "
        f"destino={destino_final!r} validos={len(lote)} omitidos={omitidos} "
        f"mover={mover_efectivo} fuentes_excel={fuentes_excel}"
    )

    # Muestra corta SOLO para que el agente redacte; no implica Excel.
    sample = [
        {
            "etiqueta": row.get("etiqueta"),
            "articulo": row.get("articulo"),
            "persona": row.get("persona"),
            "area": row.get("area"),
            "origen": destino_final,
        }
        for row in lote[:8]
    ]

    accion = (
        "moverán"
        if mover_efectivo and not destino_es_nuevo
        else "copiarán / crearán"
    )
    return {
        "ok": True,
        "needs_confirm": True,
        "destino": destino_final,
        "destino_nuevo": destino_es_nuevo,
        "mover": mover_efectivo,
        "fuentes_excel": fuentes_excel,
        "nota_destino": dest_note,
        "solicitados": solicitados,
        "validos": len(lote),
        "omitidos_duplicados": omitidos,
        "tramos": tramos_resumen,
        "errores_tramo": errores_tramo,
        "items": sample,
        "exportar_excel": False,
        "mensaje_agente": (
            f"Pide confirmación explícita: ¿Deseas pasar estos {len(lote)} "
            f"registros a «{destino_final}»? Confirma con sí. "
            f"Se {accion} {len(lote)} y se omiten {omitidos} por etiqueta "
            f"repetida."
            + (
                " Los excel de origen NO se borran (solo copia)."
                if fuentes_excel
                else ""
            )
            + " NO generes ni menciones un Excel descargable."
        ),
    }


def _vista_inventario_destino(destino: str) -> dict[str, Any]:
    """
    Tras confirmar consolidación/traslado: viewer + items reales del origen destino
    (total acumulado en Supabase, no el filtro previo del chat).
    """
    from inventario import supabase_client as db

    destino_l = str(destino or "").strip()
    viewer = {"tipo": "origen", "valor": destino_l}
    if not destino_l:
        return {
            "viewer": viewer,
            "filtro": viewer,
            "items": [],
            "count": 0,
            "consolidacion_ok": True,
        }

    all_rows, err, _ = db.read_inventario(force=True)
    if err:
        return {
            "viewer": viewer,
            "filtro": viewer,
            "items": [],
            "count": 0,
            "consolidacion_ok": True,
            "read_error": err,
        }

    want = db._origen_fold(destino_l)
    scope = [
        r
        for r in all_rows
        if db._origen_fold(str(r.get("origen") or "")) == want
    ]
    items: list[dict[str, Any]] = []
    for row in scope[:MAX_SIDE_ITEMS]:
        items.append(
            {
                k: row.get(k)
                for k in (
                    "id",
                    "etiqueta",
                    "articulo",
                    "persona",
                    "area",
                    "estado",
                    "origen",
                )
                if row.get(k) not in (None, "")
            }
        )
    return {
        "viewer": viewer,
        "filtro": viewer,
        "items": items,
        "count": len(scope),
        "consolidacion_ok": True,
    }


def confirmar_consolidacion_flex(session_id: str | None) -> dict[str, Any]:
    """
    Confirma el lote: inventario nuevo → INSERT; traslado a origen existente →
    UPDATE del campo origen (sin duplicar etiquetas).
    """
    from inventario import supabase_client as db
    from inventario.ai import pending_consolidacion as pending

    sid = str(session_id or "").strip() or "default"
    plan = pending.get_pending(sid)
    if not plan:
        return {
            "ok": False,
            "error": "No hay una consolidación pendiente de confirmar.",
            "mutated": False,
            "exportar_excel": False,
        }

    rows_raw = plan.get("rows") or []
    if not isinstance(rows_raw, list) or not rows_raw:
        pending.clear_pending(sid)
        return {
            "ok": False,
            "error": "El lote pendiente está vacío.",
            "mutated": False,
            "exportar_excel": False,
        }

    destino = str(plan.get("destino") or "").strip()
    mover = bool(plan.get("mover"))
    destino_nuevo = bool(plan.get("destino_nuevo"))
    mode = str(plan.get("mode") or "").strip() or (
        "update_origen" if mover and not destino_nuevo else "insert"
    )
    omitidos = int(plan.get("omitidos_duplicados") or 0)

    try:
        if mode == "update_origen" and mover and not destino_nuevo:
            updated = 0
            errors: list[str] = []
            for row in rows_raw:
                if not isinstance(row, dict):
                    continue
                try:
                    source_id = int(row.get("_source_id"))
                except (TypeError, ValueError):
                    continue
                saved, err = db.update_inventario_row(
                    source_id, {"origen": destino}
                )
                if err:
                    errors.append(err)
                    continue
                if saved is not None:
                    updated += 1
            pending.clear_pending(sid)
            if updated == 0 and errors:
                return {
                    "ok": False,
                    "error": errors[0],
                    "mutated": False,
                    "exportar_excel": False,
                }
            print(
                f"[inventario] consolidación UPDATE origen sid={sid} "
                f"destino={destino!r} movidos={updated}"
            )
            vista = _vista_inventario_destino(destino)
            return {
                "ok": True,
                "mutated": True,
                "destino": destino,
                "mover": True,
                "movidos": updated,
                "insertados": 0,
                "omitidos_duplicados": omitidos,
                "exportar_excel": False,
                **vista,
            }

        # Inventario nuevo o copia: INSERT (+ delete si mover desde origen).
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

        saved, err = db.create_inventario_rows_bulk(to_insert)
        if err:
            return {
                "ok": False,
                "error": err,
                "mutated": False,
                "exportar_excel": False,
            }

        deleted = 0
        delete_err = None
        if mover and source_ids:
            deleted, delete_err = db.delete_inventario_by_ids(source_ids)

        pending.clear_pending(sid)
        print(
            f"[inventario] consolidación INSERT sid={sid} destino={destino!r} "
            f"insertados={len(saved)} deleted={deleted} mover={mover}"
        )
        vista = _vista_inventario_destino(destino)
        return {
            "ok": True,
            "mutated": True,
            "destino": destino,
            "mover": mover,
            "insertados": len(saved),
            "eliminados_origen": deleted if mover else 0,
            "omitidos_duplicados": omitidos,
            "delete_error": delete_err,
            "exportar_excel": False,
            **vista,
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("confirmar_consolidacion_flex excepción")
        return {
            "ok": False,
            "error": str(exc),
            "mutated": False,
            "exportar_excel": False,
        }


def preparar_eliminacion_origen_data(
    *,
    origen: str,
    session_id: str | None,
) -> dict[str, Any]:
    """Prepara borrado de un origen (excel N o Inventario N). Requiere confirmación."""
    from inventario import supabase_client as db
    from inventario.ai import pending_eliminacion as pending

    raw = str(origen or "").strip()
    if not raw:
        return {
            "ok": False,
            "error": "Indica qué excel o Inventario quieres eliminar.",
            "needs_confirm": False,
        }

    all_rows, err, _ = db.read_inventario()
    if err:
        return {"ok": False, "error": err, "needs_confirm": False}

    canon = canonicalize_origen_alias(raw) or raw
    resolved = db.resolve_origen_label(canon, all_rows) or db.resolve_origen_label(
        raw, all_rows
    )
    if not resolved:
        return {
            "ok": False,
            "error": f"No encontré el origen «{raw}».",
            "needs_confirm": False,
        }

    want = db._origen_fold(resolved)
    ids: list[int] = []
    for r in all_rows:
        if db._origen_fold(str(r.get("origen") or "")) != want:
            continue
        try:
            ids.append(int(r["id"]))
        except (TypeError, ValueError, KeyError):
            continue

    if not ids:
        return {
            "ok": False,
            "error": f"«{resolved}» no tiene registros.",
            "needs_confirm": False,
        }

    kind = "excel" if db.is_excel_origen_label(resolved) else "inventario"
    sid = str(session_id or "").strip() or "default"
    pending.set_pending(
        sid,
        {
            "origen": resolved,
            "ids": ids,
            "kind": kind,
            "count": len(ids),
        },
    )
    return {
        "ok": True,
        "needs_confirm": True,
        "origen": resolved,
        "kind": kind,
        "count": len(ids),
        "renumerara_excel": kind == "excel",
        "exportar_excel": False,
        "mensaje_agente": (
            f"Pide confirmación explícita: se eliminarán {len(ids)} registros "
            f"de «{resolved}». "
            + (
                "Tras borrar, los excel restantes se renumerarán 1..N "
                "(del más viejo al más reciente). "
                if kind == "excel"
                else ""
            )
            + "Confirma con sí o cancela."
        ),
    }


def confirmar_eliminacion_origen_data(session_id: str | None) -> dict[str, Any]:
    from inventario import supabase_client as db
    from inventario.ai import pending_eliminacion as pending

    sid = str(session_id or "").strip() or "default"
    plan = pending.get_pending(sid)
    if not plan:
        return {
            "ok": False,
            "error": "No hay una eliminación pendiente de confirmar.",
            "mutated": False,
        }

    origen = str(plan.get("origen") or "").strip()
    ids = plan.get("ids") if isinstance(plan.get("ids"), list) else []
    kind = str(plan.get("kind") or "")
    deleted, err = db.delete_inventario_by_ids(ids)
    if err:
        return {"ok": False, "error": err, "mutated": False}

    renumber_changes: list[dict[str, str]] = []
    if kind == "excel":
        changes, ren_err = db.renumber_excel_origenes()
        if ren_err:
            pending.clear_pending(sid)
            return {
                "ok": True,
                "mutated": True,
                "origen": origen,
                "eliminados": deleted,
                "renumber_error": ren_err,
                "exportar_excel": False,
            }
        renumber_changes = [
            c for c in changes if c.get("phase") == "final"
        ]

    pending.clear_pending(sid)
    viewer = None
    if renumber_changes:
        # Mostrar el excel 1 tras renumerar si queda alguno.
        rows, _, _ = db.read_inventario(force=True)
        excels = db.list_excel_origenes_chronological(rows)
        if excels:
            viewer = {"tipo": "origen", "valor": excels[0]}
    return {
        "ok": True,
        "mutated": True,
        "origen": origen,
        "eliminados": deleted,
        "kind": kind,
        "renumber": renumber_changes,
        "viewer": viewer,
        "filtro": viewer,
        "items": [],
        "exportar_excel": False,
        "mensaje_agente": (
            f"Eliminados {deleted} registros de «{origen}»."
            + (
                " Exceles renumerados: "
                + ", ".join(f"{c['from']}→{c['to']}" for c in renumber_changes)
                if renumber_changes
                else ""
            )
        ),
    }


@dataclass
class ToolAgentDeps:
    collected: list[dict[str, Any]] = field(default_factory=list)
    qr: list[dict[str, Any]] = field(default_factory=list)
    mutated: bool = False
    session_id: str | None = None
    contexto_vista: dict[str, str] | None = None
    # Último filtro explícito de tools (persona/área/origen/areas_general).
    viewer: dict[str, Any] | None = None
    # Ranking global (áreas) para contexto_vista.
    ranking_areas: list[dict[str, Any]] = field(default_factory=list)
    # Métricas de comparar_inventarios para el visor.
    comparacion: dict[str, Any] | None = None
    # True si la tool devolvió un subconjunto (ej. 8 de aquí), no el total del filtro.
    lista_limitada: bool = False
    # Autorizar tarjeta Excel en el frontend (solo tras confirmar_exportacion).
    exportar_excel: bool = False


def _absorb(deps: ToolAgentDeps, result: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(result, dict):
        return {"ok": False, "error": "resultado inválido"}
    if result.get("mutated"):
        deps.mutated = True
    items = result.get("items")
    if isinstance(items, list):
        for row in items:
            if isinstance(row, dict) and row not in deps.collected:
                deps.collected.append(row)
    ranking = result.get("ranking")
    if isinstance(ranking, list) and ranking:
        deps.ranking_areas = [r for r in ranking if isinstance(r, dict)]
    if result.get("lista_limitada") is True:
        deps.lista_limitada = True
    if result.get("exportar_excel") is True:
        deps.exportar_excel = True
    # Prioridad: viewer/filtro de la tool (persona / área / ranking / comparación).
    # Si ya hay ranking global de áreas o comparación, no lo pisa un área puntual.
    locked_viewer = bool(
        deps.viewer
        and str(deps.viewer.get("tipo") or "").lower()
        in {"areas", "areas_general", "comparacion"}
    )
    for key in ("viewer", "filtro"):
        raw = result.get(key)
        if not isinstance(raw, dict):
            continue
        tipo = str(raw.get("tipo") or "").strip().lower()
        valor = str(raw.get("valor") or "").strip()
        if tipo == "comparacion":
            comp = raw.get("comparacion")
            if isinstance(comp, dict):
                deps.comparacion = comp
            deps.viewer = {
                "tipo": "comparacion",
                "valor": valor or "general",
                "comparacion": deps.comparacion,
            }
            break
        if tipo in {"areas", "areas_general"}:
            deps.viewer = {
                "tipo": "areas_general",
                "valor": valor or "general",
                "ranking": deps.ranking_areas,
            }
            break
        if locked_viewer:
            break
        if tipo in {"persona", "area", "origen"} and valor:
            deps.viewer = {"tipo": tipo, "valor": valor}
            break
    # QR: aceptar lista en "qr" o "qrs" (tools legacy usa qrs + qr=True).
    qr_cards = result.get("qr")
    if not isinstance(qr_cards, list):
        qr_cards = result.get("qrs")
    if isinstance(qr_cards, list):
        for card in qr_cards:
            if isinstance(card, dict) and card.get("text"):
                deps.qr.append(card)
    # Al LLM: muestra corta; deps.collected / deps.qr conservan el lote del visor.
    out = dict(result)
    if isinstance(out.get("items"), list) and len(out["items"]) > 25:
        out["items"] = out["items"][:25]
        out["items_truncated"] = len(items) - 25 if isinstance(items, list) else True
        if isinstance(result.get("count"), int):
            out["count"] = result["count"]
        elif isinstance(items, list):
            out["count"] = len(items)
    # Chat: no saturar el modelo con cientos de QR; el visor ya tiene deps.qr.
    full_qrs = out.get("qrs") if isinstance(out.get("qrs"), list) else None
    if full_qrs is None and isinstance(result.get("qr"), list):
        full_qrs = result.get("qr")
    if isinstance(full_qrs, list) and len(full_qrs) > 5:
        out["qrs"] = full_qrs[:5]
        out["qrs_truncated"] = len(full_qrs) - 5
        out["count"] = (
            int(result["count"])
            if isinstance(result.get("count"), int)
            else len(full_qrs)
        )
        out["mensaje_agente"] = (
            str(result.get("mensaje_agente") or "")
            or (
                f"Se generaron {out['count']} códigos QR en el visor derecho. "
                "Resume el total en el chat con 3–5 ejemplos; NO listes todos."
            )
        )
    return out


def build_contexto_vista_payload(
    deps: ToolAgentDeps,
    *,
    user_message: str = "",
    reply: str = "",
) -> dict[str, Any] | None:
    """
    Objeto contexto_vista para el frontend.
    null → saludo/charla o sin tools de datos (visor derecho oculto).
    objeto → mostrar/sincronizar el visor con esos datos.
    """
    from inventario.ai.suggested_actions import _is_chitchat

    viewer = deps.viewer
    items = deps.collected
    # Sin tools de datos → null explícito (no reabrir el panel).
    tools_used = (
        bool(viewer)
        or bool(items)
        or bool(deps.qr)
        or bool(deps.ranking_areas)
        or bool(deps.comparacion)
    )
    if not tools_used:
        return None
    if viewer:
        tipo = str(viewer.get("tipo") or "").strip().lower()
        valor = str(viewer.get("valor") or "").strip()
        if tipo == "comparacion":
            comp = deps.comparacion or viewer.get("comparacion") or {}
            return {
                "tipo": "comparacion",
                "valor": valor or "general",
                "comparacion": comp if isinstance(comp, dict) else {},
                "lista_limitada": False,
            }
        if tipo in {"areas", "areas_general"}:
            ranking = deps.ranking_areas or viewer.get("ranking") or []
            return {
                "tipo": "areas_general",
                "valor": "general",
                "ranking": ranking if isinstance(ranking, list) else [],
                "lista_limitada": False,
            }
        if tipo in {"persona", "area", "origen"} and valor:
            out: dict[str, Any] = {
                "tipo": tipo,
                "valor": valor,
                "lista_limitada": bool(deps.lista_limitada),
            }
            return out

    # Inferir desde items si la tool no marcó viewer.
    if items:
        personas: dict[str, int] = {}
        areas: dict[str, int] = {}
        origenes: dict[str, int] = {}
        for row in items:
            p = str(row.get("persona") or "").strip()
            a = str(row.get("area") or "").strip()
            o = str(row.get("origen") or "").strip()
            if p:
                personas[p] = personas.get(p, 0) + 1
            if a:
                areas[a] = areas.get(a, 0) + 1
            if o:
                origenes[o] = origenes.get(o, 0) + 1
        if personas:
            top_p, n_p = max(personas.items(), key=lambda kv: kv[1])
            if n_p >= max(1, (len(items) + 1) // 2):
                return {
                    "tipo": "persona",
                    "valor": top_p,
                    "lista_limitada": bool(deps.lista_limitada),
                }
        if areas:
            top_a, n_a = max(areas.items(), key=lambda kv: kv[1])
            if n_a >= max(1, (len(items) + 1) // 2):
                return {
                    "tipo": "area",
                    "valor": top_a,
                    "lista_limitada": bool(deps.lista_limitada),
                }
        if origenes:
            top_o, n_o = max(origenes.items(), key=lambda kv: kv[1])
            if n_o >= max(1, (len(items) + 1) // 2):
                return {
                    "tipo": "origen",
                    "valor": top_o,
                    "lista_limitada": bool(deps.lista_limitada),
                }

    # Tools sin filtro claro / charla → null (visor oculto).
    if _is_chitchat(reply, user_message):
        return None
    return None


def _normalize_tool_args(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Alias xlsx/ecel→excel; evita filtrar por la palabra «general»."""
    out = dict(args or {})
    if name in {
        "contar_por_campo",
        "obtener_por_etiqueta",
        "buscar_inventario",
        "listar_criterios",
        "comparar_inventarios",
    }:
        if "valor" in out and str(out.get("campo") or "").strip().lower() == "origen":
            canon = canonicalize_origen_alias(str(out.get("valor") or ""))
            if not canon:
                # «general» como origen → no filtrar; el caller debe usar resumen.
                out["_skip_origen_general"] = True
            else:
                out["valor"] = canon
        if "query" in out:
            q = str(out.get("query") or "").strip()
            canon_q = canonicalize_origen_alias(q)
            if canon_q and canon_q != q:
                out["query"] = canon_q
        if "origen" in out and out.get("origen"):
            canon_o = canonicalize_origen_alias(str(out.get("origen") or ""))
            out["origen"] = canon_o or out["origen"]
        if name == "comparar_inventarios" and isinstance(out.get("origenes"), list):
            resolved_list: list[str] = []
            for o in out["origenes"]:
                raw_o = str(o or "").strip()
                if not raw_o:
                    continue
                if _is_latest_destino_alias(raw_o):
                    from inventario import supabase_client as _db

                    resolved_list.append(_db.latest_inventario_origen())
                else:
                    resolved_list.append(
                        canonicalize_origen_alias(raw_o) or raw_o
                    )
            out["origenes"] = resolved_list
    return out


def _run(deps: ToolAgentDeps, name: str, args: dict[str, Any]) -> dict[str, Any]:
    from inventario.ai.tools import run_tool

    norm = _normalize_tool_args(name, args)
    # contar_por_campo(origen=general) → resumen global (todos los registros).
    if name == "contar_por_campo" and norm.pop("_skip_origen_general", False):
        return _absorb(deps, panorama_inventario_data(None))

    return _absorb(
        deps,
        run_tool(
            name,
            norm,
            session_id=deps.session_id,
            contexto_vista=deps.contexto_vista,
        ),
    )


def _build_agent(api_key: str, model_name: str, base_url: str = ""):
    from pydantic_ai import Agent
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    provider = OpenAIProvider(
        api_key=api_key,
        base_url=(base_url or "https://api.openai.com/v1").rstrip("/"),
        http_client=_openai_http_client(),
    )
    model = OpenAIChatModel(model_name, provider=provider)
    agent: Agent[ToolAgentDeps, str] = Agent(
        model,
        deps_type=ToolAgentDeps,
        output_type=str,
        instructions=TOOL_AGENT_INSTRUCTIONS,
    )

    @agent.tool
    def buscar_inventario(
        ctx: RunContext[ToolAgentDeps], query: str, limit: int = 40
    ) -> dict[str, Any]:
        """Busca artículos por texto (persona, área, etiqueta, marca, etc.)."""
        # Chat conversacional: tope 40. Export/consolidación usan otras tools/límites.
        return _run(
            ctx.deps,
            "buscar_inventario",
            {"query": query, "limit": max(1, min(40, int(limit or 40)))},
        )

    @agent.tool
    def resumen_inventario(ctx: RunContext[ToolAgentDeps]) -> dict[str, Any]:
        """Totales exactos del inventario (total, áreas, personas, activos)."""
        return _run(ctx.deps, "resumen_inventario", {})

    @agent.tool
    def ranking_areas(ctx: RunContext[ToolAgentDeps]) -> dict[str, Any]:
        """Ranking global de TODAS las áreas (artículos/personas). No filtrar a una sola."""
        return _run(ctx.deps, "ranking_areas", {})

    @agent.tool
    def comparar_inventarios(
        ctx: RunContext[ToolAgentDeps],
        origenes: list[str] | None = None,
    ) -> dict[str, Any]:
        """Compara orígenes (métricas rápidas). origenes=None → todos."""
        args: dict[str, Any] = {}
        if origenes:
            args["origenes"] = [str(o).strip() for o in origenes if str(o or "").strip()]
        return _run(ctx.deps, "comparar_inventarios", args)

    @agent.tool
    def contar_total(ctx: RunContext[ToolAgentDeps]) -> dict[str, Any]:
        """Cuenta el total exacto de artículos."""
        return _run(ctx.deps, "contar_total", {})

    @agent.tool
    def contar_por_campo(
        ctx: RunContext[ToolAgentDeps], campo: str, valor: str
    ) -> dict[str, Any]:
        """Cuenta por campo con ilike (area sin acento). Devuelve total, personas y equipos."""
        try:
            return _run(
                ctx.deps, "contar_por_campo", {"campo": campo, "valor": valor}
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "tool contar_por_campo excepción campo=%r valor=%r", campo, valor
            )
            print(
                f"[inventario] tool contar_por_campo excepción: {exc!r} "
                f"campo={campo!r} valor={valor!r}"
            )
            return {"ok": False, "error": str(exc), "campo": campo, "valor": valor}

    @agent.tool
    def obtener_por_etiqueta(
        ctx: RunContext[ToolAgentDeps],
        etiqueta: str,
        origen: str | None = None,
    ) -> dict[str, Any]:
        """Obtiene registros exactos por etiqueta (origen opcional)."""
        args: dict[str, Any] = {"etiqueta": etiqueta}
        if origen:
            args["origen"] = origen
        return _run(ctx.deps, "obtener_por_etiqueta", args)

    @agent.tool
    def listar_recientes(
        ctx: RunContext[ToolAgentDeps],
        limit: int = 5,
        solo_hoy: bool = False,
    ) -> dict[str, Any]:
        """Lista los registros más recientes (o solo los de hoy)."""
        return _run(
            ctx.deps,
            "listar_recientes",
            {
                "limit": max(1, min(40, int(limit or 5))),
                "solo_hoy": bool(solo_hoy),
            },
        )

    @agent.tool
    def buscar_semantico(
        ctx: RunContext[ToolAgentDeps], query: str, limit: int = 40
    ) -> dict[str, Any]:
        """Búsqueda por significado (pgvector / fuzzy)."""
        return _run(
            ctx.deps,
            "buscar_semantico",
            {"query": query, "limit": max(1, min(40, int(limit or 40)))},
        )

    @agent.tool
    def generar_qr(
        ctx: RunContext[ToolAgentDeps],
        etiqueta: str | None = None,
        query: str | None = None,
        origen: str | None = None,
        limit: int | None = None,
        ultimo: bool = False,
    ) -> dict[str, Any]:
        """
        Genera QR. Sin N → todos (inventario completo o del origen/query).
        Con N → ese máximo. El visor recibe la lista completa.
        """
        try:
            lim: int | None
            if limit is None or str(limit).strip() == "":
                lim = None  # sin tope artificial
            else:
                lim = max(1, int(limit))
            return _absorb(
                ctx.deps,
                generar_qr_data(
                    etiqueta=etiqueta,
                    query=query,
                    origen=origen,
                    limit=lim,
                    ultimo=bool(ultimo),
                ),
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("generar_qr excepción")
            return {"ok": False, "error": str(exc), "qr": [], "count": 0}

    @agent.tool
    def panorama_inventario(
        ctx: RunContext[ToolAgentDeps],
        origen: str | None = None,
    ) -> dict[str, Any]:
        """
        Panorama de un origen (excel/xlsx N) o de TODO el inventario (origen=null/general).
        Sin generar Excel.
        """
        try:
            return _absorb(ctx.deps, panorama_inventario_data(origen))
        except Exception as exc:  # noqa: BLE001
            logger.exception("panorama_inventario excepción")
            return {"ok": False, "error": str(exc), "exportar_excel": False}

    @agent.tool
    def preparar_exportacion_excel(
        ctx: RunContext[ToolAgentDeps],
        origen: str | None = None,
        persona: str | None = None,
        area: str | None = None,
    ) -> dict[str, Any]:
        """Vista previa de exportación Excel; pide confirmación. Sin tarjeta aún."""
        try:
            return _absorb(
                ctx.deps,
                preparar_exportacion_excel_data(
                    session_id=ctx.deps.session_id,
                    origen=origen,
                    persona=persona,
                    area=area,
                ),
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("preparar_exportacion_excel excepción")
            return {
                "ok": False,
                "error": str(exc),
                "needs_confirm": False,
                "exportar_excel": False,
            }

    @agent.tool
    def confirmar_exportacion_excel(
        ctx: RunContext[ToolAgentDeps],
    ) -> dict[str, Any]:
        """Confirma la exportación pendiente (autoriza tarjeta Excel en el frontend)."""
        try:
            return _absorb(
                ctx.deps, confirmar_exportacion_excel_data(ctx.deps.session_id)
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("confirmar_exportacion_excel excepción")
            return {"ok": False, "error": str(exc), "exportar_excel": False}

    @agent.tool
    def preparar_consolidacion_inventario(
        ctx: RunContext[ToolAgentDeps],
        tramos: list[dict[str, Any]],
        destino: str | None = None,
        mover: bool = False,
    ) -> dict[str, Any]:
        """
        Prepara crear/mover en Supabase (sin Excel).
        Cada tramo: origen?, persona?, area?, articulo?, cantidad?.
        destino=null → siguiente Inventario N. mover=true → traslado.
        """
        try:
            result = preparar_consolidacion_flex(
                tramos=tramos or [],
                destino=destino,
                mover=bool(mover),
                session_id=ctx.deps.session_id,
            )
            # No volcar sample al visor como listado exportable.
            return _absorb(
                ctx.deps,
                {
                    **result,
                    "items": [],
                    "viewer": None,
                    "filtro": None,
                },
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("preparar_consolidacion_inventario excepción")
            print(f"[inventario] preparar_consolidacion excepción: {exc!r}")
            return {"ok": False, "error": str(exc), "needs_confirm": False}

    @agent.tool
    def confirmar_consolidacion_inventario(
        ctx: RunContext[ToolAgentDeps],
    ) -> dict[str, Any]:
        """Confirma el lote en Supabase (INSERT Inventario N o UPDATE origen)."""
        try:
            result = confirmar_consolidacion_flex(ctx.deps.session_id)
            # Visor = origen destino acumulado (no arrastrar persona/área previa).
            if result.get("ok") and result.get("consolidacion_ok"):
                ctx.deps.collected.clear()
                ctx.deps.lista_limitada = False
                ctx.deps.viewer = None
                ctx.deps.ranking_areas = []
                ctx.deps.comparacion = None
            return _absorb(ctx.deps, {**result, "exportar_excel": False})
        except Exception as exc:  # noqa: BLE001
            logger.exception("confirmar_consolidacion_inventario excepción")
            print(f"[inventario] confirmar_consolidacion excepción: {exc!r}")
            return {"ok": False, "error": str(exc), "mutated": False}

    @agent.tool
    def cancelar_consolidacion_inventario(
        ctx: RunContext[ToolAgentDeps],
    ) -> dict[str, Any]:
        """Cancela la consolidación pendiente."""
        from inventario.ai.consolidacion import cancelar_consolidacion

        return cancelar_consolidacion(ctx.deps.session_id)

    @agent.tool
    def preparar_eliminacion_origen(
        ctx: RunContext[ToolAgentDeps],
        origen: str,
    ) -> dict[str, Any]:
        """Prepara borrar un excel N o Inventario N (pide confirmación)."""
        try:
            return preparar_eliminacion_origen_data(
                origen=origen, session_id=ctx.deps.session_id
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("preparar_eliminacion_origen excepción")
            return {"ok": False, "error": str(exc), "needs_confirm": False}

    @agent.tool
    def confirmar_eliminacion_origen(
        ctx: RunContext[ToolAgentDeps],
    ) -> dict[str, Any]:
        """Confirma el borrado pendiente; renumerar exceles si aplica."""
        try:
            return _absorb(
                ctx.deps, confirmar_eliminacion_origen_data(ctx.deps.session_id)
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("confirmar_eliminacion_origen excepción")
            return {"ok": False, "error": str(exc), "mutated": False}

    @agent.tool
    def cancelar_eliminacion_origen(
        ctx: RunContext[ToolAgentDeps],
    ) -> dict[str, Any]:
        """Cancela la eliminación pendiente."""
        from inventario.ai import pending_eliminacion as pending

        pending.clear_pending(ctx.deps.session_id)
        return {"ok": True, "cancelled": True, "mutated": False}

    @agent.tool
    def listar_criterios(
        ctx: RunContext[ToolAgentDeps],
        criterios: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Lista N por cada criterio (ej. 5 de aquí + 5 de TI). Sin rellenar ni duplicar etiquetas."""
        return _run(ctx.deps, "listar_criterios", {"criterios": criterios or []})

    return agent


def get_or_build_agent(api_key: str, model_name: str, base_url: str = ""):
    """Una sola instancia de Agent por (key, model, base_url)."""
    # Incluye revisión de reglas excel/Inventario para invalidar cache viejo.
    key = _cache_key(
        api_key, model_name, (base_url or "https://api.openai.com/v1") + "|origen-v3-qr"
    )
    with _AGENT_LOCK:
        cached = _AGENT_CACHE.get(key)
        if cached is not None:
            return cached
        agent = _build_agent(api_key, model_name, base_url)
        _AGENT_CACHE[key] = agent
        return agent


# Historial corto → menos tokens / menos latencia.
MAX_HISTORY_MESSAGES = 6
_TOOL_RETURN_MAX_CHARS = 280


def _fold_user_text(raw: str) -> str:
    import re
    import unicodedata

    t = unicodedata.normalize("NFD", str(raw or "").lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    t = re.sub(r"[!?.…,;:]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def _session_has_pending_action(session_id: str | None) -> bool:
    sid = str(session_id or "").strip()
    if not sid:
        return False
    try:
        from inventario.ai.pending_consolidacion import get_pending as get_cons

        if get_cons(sid):
            return True
    except Exception:  # noqa: BLE001
        pass
    try:
        from inventario.ai import pending_eliminacion as pend_del

        if pend_del.get_pending(sid):
            return True
    except Exception:  # noqa: BLE001
        pass
    try:
        if _export_get_pending(sid):
            return True
    except Exception:  # noqa: BLE001
        pass
    return False


def is_fast_chitchat_message(
    message: str, *, session_id: str | None = None
) -> bool:
    """
    Saludo / charla corta sin pedido de datos.
    False si hay consolidación/export/borrado pendiente (p. ej. «sí»).
    """
    if _session_has_pending_action(session_id):
        return False
    t = _fold_user_text(message)
    if not t or len(t) > 48:
        return False
    import re

    if re.search(
        r"\b(\d{3,}|etiqueta|persona|area|inventario|excel|xlsx|csv|"
        r"export|descarg|import|compara|consolida|traslad|elimina|borra|"
        r"registro|proyector|laptop|qr|panorama|resumen|cuantos|cuantas)\b",
        t,
    ):
        return False
    if re.fullmatch(
        r"(hola|holaa*|hey|hi|hello|buenas|buen dia|buenos dias|"
        r"buena tarde|buenas tardes|buena noche|buenas noches|"
        r"que tal|como estas|como va|que onda|saludos|"
        r"gracias|muchas gracias|mil gracias|de nada|"
        r"adios|hasta luego|nos vemos|buen dia|"
        r"ok|okay|okey|vale|perfecto|excelente|genial|"
        r"todo bien|muy bien)( {0,3}\w+){0,3}",
        t,
    ):
        return True
    # Frases cortas de cortesía (≤6 palabras) solo con tokens de saludo.
    words = t.split()
    if len(words) <= 6 and re.match(
        r"^(hola|buenas|hey|hi|gracias|adios|que tal|como estas)\b",
        t,
    ):
        return True
    return False


def run_fast_chitchat_reply(
    message: str,
    *,
    preferred_model: str | None = None,
) -> tuple[str, str | None, str | None, list, bool, list, dict, None]:
    """
    Llamada ligera a gpt-4o-mini: sin tools ni historial.
    Devuelve el mismo shape que run_tool_agent.
    """
    from inventario.ai.client import DEFAULT_MODEL, OPENAI_BASE_URL, get_llm_endpoints
    from inventario.ai.usage import count_tokens, empty_usage

    try:
        endpoints = get_llm_endpoints()
    except Exception as exc:  # noqa: BLE001
        return (
            f"Agente no disponible: {exc}",
            "tool_agent_import",
            None,
            [],
            False,
            [],
            empty_usage(),
            None,
        )
    if not endpoints:
        return (
            "No hay proveedores de IA listos. Configura OPENAI_API_KEY.",
            "missing_key",
            None,
            [],
            False,
            [],
            empty_usage(),
            None,
        )

    ep = endpoints[0]
    from inventario.supabase_client import get_env

    env = get_env()
    api_key = (ep.api_key or env.get("OPENAI_API_KEY") or "").strip()
    if not api_key:
        return (
            "No hay proveedores de IA listos. Configura OPENAI_API_KEY.",
            "missing_key",
            None,
            [],
            False,
            [],
            empty_usage(),
            None,
        )

    model_name = (preferred_model or "").strip() or (
        ep.models[0] if ep.models else DEFAULT_MODEL
    )
    user_msg = (message or "").strip() or "hola"
    system = (
        "Eres el asistente de inventario (español de México). "
        "El usuario solo saluda o hace charla corta. "
        "Responde en 1–2 frases naturales y cordiales. "
        "NO menciones inventarios, Excel, comparaciones ni acciones previas. "
        "NO uses herramientas. Cierra invitando a preguntar sobre el inventario."
    )
    try:
        client = ep.client
        completion = client.chat.completions.create(
            model=model_name,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_msg},
            ],
            max_tokens=80,
            temperature=0.7,
        )
        text = (
            (completion.choices[0].message.content or "").strip()
            if completion.choices
            else ""
        )
        if not text:
            text = "¡Hola! ¿En qué te ayudo con el inventario?"
        prompt_tokens = int(
            getattr(getattr(completion, "usage", None), "prompt_tokens", 0) or 0
        )
        completion_tokens = int(
            getattr(getattr(completion, "usage", None), "completion_tokens", 0)
            or 0
        )
        if not prompt_tokens:
            prompt_tokens = count_tokens(system + user_msg, model_name)
        if not completion_tokens:
            completion_tokens = count_tokens(text, model_name)
        usage = empty_usage(
            model=model_name,
            api_key=api_key,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )
        return (
            text,
            None,
            f"openai-fast:{model_name}",
            [],
            False,
            [],
            usage,
            None,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("fast chitchat failed")
        # Fallback mínimo (sin historial/tools) si OpenAI falla.
        text = "¡Hola! ¿En qué te ayudo con el inventario?"
        usage = empty_usage(
            model=model_name,
            api_key=api_key,
            prompt_tokens=count_tokens(user_msg, model_name),
            completion_tokens=count_tokens(text, model_name),
        )
        return (
            text,
            str(exc),
            f"openai-fast:{model_name}",
            [],
            False,
            [],
            usage,
            None,
        )


def _truncate_tool_payload(raw: Any, limit: int = _TOOL_RETURN_MAX_CHARS) -> str:
    text = str(raw or "")
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"


def compact_message_history_for_llm(
    messages: list[Any] | None,
    *,
    max_n: int = MAX_HISTORY_MESSAGES,
) -> list[Any]:
    """
    Últimos N mensajes; resultados de tools recortados (sin listas gigantes).
    """
    from inventario.ai.session_memory import trim_model_messages

    trimmed = trim_model_messages(list(messages or []), max_n=max_n)
    if not trimmed:
        return []

    try:
        from pydantic_ai.messages import (
            ModelRequest,
            ModelResponse,
            TextPart,
            ToolReturnPart,
            UserPromptPart,
        )
    except Exception:  # noqa: BLE001
        return trimmed

    out: list[Any] = []
    for msg in trimmed:
        if isinstance(msg, ModelRequest):
            new_parts = []
            for part in msg.parts:
                kind = str(getattr(part, "part_kind", "") or "")
                name = part.__class__.__name__
                if kind in ("tool-return", "tool_return") or "ToolReturn" in name:
                    content = _truncate_tool_payload(
                        getattr(part, "content", "")
                    )
                    tool_name = getattr(part, "tool_name", None) or getattr(
                        part, "name", "tool"
                    )
                    tool_call_id = getattr(part, "tool_call_id", None) or getattr(
                        part, "tool_call_id", ""
                    )
                    try:
                        new_parts.append(
                            ToolReturnPart(
                                tool_name=str(tool_name),
                                content=content,
                                tool_call_id=str(tool_call_id or "tool"),
                            )
                        )
                    except Exception:  # noqa: BLE001
                        new_parts.append(part)
                elif kind in ("user-prompt", "user_prompt") or name == "UserPromptPart":
                    content = str(getattr(part, "content", "") or "")
                    if len(content) > 600:
                        content = content[:599] + "…"
                    try:
                        new_parts.append(UserPromptPart(content=content))
                    except Exception:  # noqa: BLE001
                        new_parts.append(part)
                else:
                    new_parts.append(part)
            out.append(ModelRequest(parts=new_parts))
        elif isinstance(msg, ModelResponse):
            new_parts = []
            for part in msg.parts:
                kind = str(getattr(part, "part_kind", "") or "")
                name = part.__class__.__name__
                if kind == "text" or name == "TextPart":
                    content = str(getattr(part, "content", "") or "")
                    if len(content) > 500:
                        content = content[:499] + "…"
                    try:
                        new_parts.append(TextPart(content=content))
                    except Exception:  # noqa: BLE001
                        new_parts.append(part)
                elif kind in ("tool-call", "tool_call") or "ToolCall" in name:
                    # Conservar la llamada; args suelen ser cortos.
                    new_parts.append(part)
                else:
                    new_parts.append(part)
            out.append(ModelResponse(parts=new_parts))
        else:
            out.append(msg)
    return out


def persist_short_turn(
    session_id: str | None,
    user_text: str,
    assistant_text: str,
) -> None:
    """
    Guarda solo prosa corta user/assistant (sin tool dumps).
    Ventana máxima: MAX_HISTORY_MESSAGES.
    """
    sid = str(session_id or "").strip()
    if not sid:
        return
    from inventario.ai.session_memory import (
        build_turn_messages,
        load_session_messages,
        plain_history_from_model_messages,
        save_session_messages,
        seed_from_plain_history,
        trim_model_messages,
    )

    prior = trim_model_messages(
        load_session_messages(sid), max_n=MAX_HISTORY_MESSAGES
    )
    plain = plain_history_from_model_messages(prior)
    short_plain: list[dict[str, str]] = []
    for item in plain[-MAX_HISTORY_MESSAGES:]:
        role = str(item.get("role") or "")
        content = str(item.get("content") or "").strip()
        if not content:
            continue
        # Quitar restos de herramientas si vinieran del plain converter.
        if content.startswith("[resultado:") or content.startswith("[herramienta:"):
            content = content[:120] + ("…" if len(content) > 120 else "")
        elif len(content) > 400:
            content = content[:399] + "…"
        short_plain.append({"role": role, "content": content})
    seeded = seed_from_plain_history(short_plain)
    merged = trim_model_messages(
        seeded + build_turn_messages(user_text, assistant_text),
        max_n=MAX_HISTORY_MESSAGES,
    )
    save_session_messages(sid, merged)


def run_tool_agent(
    message: str,
    history: list[dict] | None = None,
    memory: str | None = None,
    preferred_model: str | None = None,
    session_id: str | None = None,
    contexto_vista: dict[str, str] | None = None,
    message_history: list | None = None,
) -> tuple[str, str | None, str | None, list[dict], bool, list[dict], dict, dict | None]:
    """
    reply, error, used_model, items, mutated, qr_list, usage, contexto_vista
    """
    from inventario.ai.client import DEFAULT_MODEL, OPENAI_BASE_URL, get_llm_endpoints
    from inventario.ai.usage import empty_usage, usage_from_pydantic_result
    from inventario.supabase_client import get_env

    # Saludo / charla: sin tools ni historial largo.
    if is_fast_chitchat_message(message, session_id=session_id):
        return run_fast_chitchat_reply(message, preferred_model=preferred_model)

    try:
        endpoints = get_llm_endpoints()
    except Exception as exc:  # noqa: BLE001
        return (
            f"Agente no disponible: {exc}",
            "tool_agent_import",
            None,
            [],
            False,
            [],
            empty_usage(),
            None,
        )

    if not endpoints:
        return (
            "No hay proveedores de IA listos. Configura OPENAI_API_KEY.",
            "missing_key",
            None,
            [],
            False,
            [],
            empty_usage(),
            None,
        )

    env = get_env()
    ep = endpoints[0]
    api_key = (ep.api_key or env.get("OPENAI_API_KEY") or "").strip()
    if not api_key:
        return (
            "No hay proveedores de IA listos. Configura OPENAI_API_KEY.",
            "missing_key",
            None,
            [],
            False,
            [],
            empty_usage(),
            None,
        )

    model_name = (preferred_model or "").strip() or (
        ep.models[0] if ep.models else DEFAULT_MODEL
    )
    base_url = (ep.base_url or env.get("OPENAI_BASE_URL") or OPENAI_BASE_URL).rstrip(
        "/"
    )

    deps = ToolAgentDeps(session_id=session_id, contexto_vista=contexto_vista)
    try:
        agent = get_or_build_agent(api_key, model_name, base_url)
    except Exception as exc:  # noqa: BLE001
        logger.exception("tool_agent build failed")
        return (
            f"No pude iniciar el agente: {exc}",
            "tool_agent_build",
            None,
            [],
            False,
            [],
            empty_usage(model=model_name, api_key=api_key),
            None,
        )

    # Ventana corta + tool-returns resumidos (sin dumps de cientos de filas).
    model_history = compact_message_history_for_llm(
        list(message_history or []), max_n=MAX_HISTORY_MESSAGES
    )

    # Fallback plano solo si no hay message_history estructurado.
    hist_bits: list[str] = []
    if not model_history:
        for item in (history or [])[-MAX_HISTORY_MESSAGES:]:
            role = str(item.get("role") or "").strip().lower()
            text = str(item.get("content") or item.get("text") or "").strip()
            if not text:
                continue
            if len(text) > 220:
                text = text[:219] + "…"
            label = "Asistente" if role in ("assistant", "bot", "model") else "Usuario"
            hist_bits.append(f"{label}: {text}")

    mem = (memory or "").strip()
    if len(mem) > 400:
        mem = mem[:399] + "…"

    prompt_parts = []
    if contexto_vista:
        prompt_parts.append(
            "CONTEXTO_VISTA (panel derecho abierto ahora):\n"
            f'tipo={contexto_vista.get("tipo")!s} valor={contexto_vista.get("valor")!s}\n'
            'Si el usuario dice «de aquí», «esta lista» o «este panel», filtra con ese '
            "tipo/valor. No cambies de persona/área."
        )
    # Lote pendiente de crear/mover inventarios (confirmación).
    try:
        from inventario.ai.pending_consolidacion import (
            get_pending,
            is_affirmative_confirm,
            is_negative_cancel,
        )

        pend = get_pending(session_id) if session_id else None
        if pend:
            prompt_parts.append(
                "CONSOLIDACIÓN PENDIENTE EN SUPABASE (sin Excel):\n"
                f"destino={pend.get('destino')!s} destino_nuevo={pend.get('destino_nuevo')!s} "
                f"mover={pend.get('mover')!s} validos={pend.get('validos')!s} "
                f"omitidos_duplicados={pend.get('omitidos_duplicados')!s}.\n"
                "Si el usuario confirma (sí/ok/dale/confirmo) → llama "
                "confirmar_consolidacion_inventario. Si cancela → "
                "cancelar_consolidacion_inventario. NO exportes Excel."
            )
            if is_affirmative_confirm(message or ""):
                prompt_parts.append(
                    "El usuario CONFIRMÓ. Debes llamar confirmar_consolidacion_inventario ahora."
                )
            elif is_negative_cancel(message or ""):
                prompt_parts.append(
                    "El usuario CANCELÓ. Debes llamar cancelar_consolidacion_inventario ahora."
                )
    except Exception:  # noqa: BLE001
        pass
    try:
        from inventario.ai import pending_eliminacion as pend_del
        from inventario.ai.pending_consolidacion import (
            is_affirmative_confirm as _aff_del,
            is_negative_cancel as _neg_del,
        )

        del_pend = pend_del.get_pending(session_id) if session_id else None
        if del_pend:
            prompt_parts.append(
                "ELIMINACIÓN PENDIENTE:\n"
                f"origen={del_pend.get('origen')!s} count={del_pend.get('count')!s} "
                f"kind={del_pend.get('kind')!s}.\n"
                "Si confirma → confirmar_eliminacion_origen. "
                "Si cancela → cancelar_eliminacion_origen."
            )
            if _aff_del(message or ""):
                prompt_parts.append(
                    "El usuario CONFIRMÓ el borrado. Llama confirmar_eliminacion_origen ahora."
                )
            elif _neg_del(message or ""):
                prompt_parts.append(
                    "El usuario CANCELÓ el borrado. Llama cancelar_eliminacion_origen."
                )
    except Exception:  # noqa: BLE001
        pass
    try:
        exp = _export_get_pending(session_id) if session_id else None
        if exp:
            prompt_parts.append(
                "EXPORTACIÓN EXCEL PENDIENTE (vista previa ya hecha):\n"
                f"focus={exp.get('focus')!s} registros={len(exp.get('rows') or [])}.\n"
                "Si el usuario confirma → confirmar_exportacion_excel. "
                "Si cancela → dilo y no generes archivo."
            )
            from inventario.ai.pending_consolidacion import (
                is_affirmative_confirm as _aff,
                is_negative_cancel as _neg,
            )

            if _aff(message or ""):
                prompt_parts.append(
                    "El usuario CONFIRMÓ la exportación. Llama confirmar_exportacion_excel ahora."
                )
            elif _neg(message or ""):
                prompt_parts.append(
                    "El usuario CANCELÓ la exportación. No llames confirmar_exportacion_excel."
                )
    except Exception:  # noqa: BLE001
        pass
    if mem:
        prompt_parts.append(f"Memoria de sesión:\n{mem}")
    if hist_bits:
        prompt_parts.append("Hilo reciente:\n" + "\n".join(hist_bits))
    # Con message_history el turno actual va solo como prompt (sin duplicar hilo).
    prompt_parts.append((message or "").strip())
    prompt = "\n\n".join(p for p in prompt_parts if p)

    try:
        run_kwargs: dict[str, Any] = {"deps": deps}
        if model_history:
            run_kwargs["message_history"] = model_history
        result = agent.run_sync(prompt, **run_kwargs)
        text = str(result.output or "").strip()
        if not text:
            # Último recurso vacío del modelo (no es detector de intención).
            text = (
                "No logré armar una respuesta clara con lo consultado. "
                "¿Me lo dices de otra forma?"
            )
        usage = usage_from_pydantic_result(
            result,
            model=model_name,
            api_key=api_key,
            fallback_prompt=prompt,
            fallback_reply=text,
        )
        used = f"pydantic-ai:{model_name}"
        ctx = build_contexto_vista_payload(
            deps, user_message=message or "", reply=text
        )
        if deps.exportar_excel:
            if not isinstance(ctx, dict):
                ctx = {"tipo": "origen", "valor": "Todo el inventario"}
            ctx = {**ctx, "exportar_excel": True}
        return (
            text,
            None,
            used,
            deps.collected[:MAX_SIDE_ITEMS],
            deps.mutated,
            deps.qr,
            usage,
            ctx,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("tool_agent run failed")
        err = str(exc)
        usage = empty_usage(model=model_name, api_key=api_key)
        ctx = build_contexto_vista_payload(
            deps, user_message=message or "", reply=""
        )
        if "api" in err.lower() or "timeout" in err.lower() or "connect" in err.lower():
            return (
                "OpenAI no respondió. Reintento en unos segundos…",
                "llm_unavailable",
                f"pydantic-ai:{model_name}",
                deps.collected[:MAX_SIDE_ITEMS],
                deps.mutated,
                deps.qr,
                usage,
                ctx,
            )
        return (
            f"Error al consultar la IA: {exc}",
            str(exc),
            f"pydantic-ai:{model_name}",
            deps.collected[:MAX_SIDE_ITEMS],
            deps.mutated,
            deps.qr,
            usage,
            ctx,
        )
