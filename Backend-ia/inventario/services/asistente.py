"""Cliente n8n para automatización del asistente de inventario (opt-in)."""

from __future__ import annotations

import json
import re
from collections import Counter
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from inventario.supabase_client import get_env, read_inventario

ACCION_RE = re.compile(r"\[\[ACCION:(.*?)\]\]", re.DOTALL)


def n8n_configured() -> bool:
    env = get_env()
    return bool((env.get("N8N_INVENTARIO_URL") or "").strip())


def _origen_catalog() -> list[dict[str, Any]]:
    """Conteos reales por columna origen (Supabase) para anclar al LLM de n8n."""
    rows, error, _used = read_inventario()
    if error or not rows:
        return []
    counts = Counter(
        (str(r.get("origen") or "").strip() or "(vacío)") for r in rows
    )
    out = [
        {"origen": name, "registros": count}
        for name, count in sorted(counts.items(), key=lambda x: (-x[1], x[0]))
    ]
    return out


def preguntar_asistente(
    mensaje: str,
    session_id: str,
    *,
    thread_focus: dict[str, Any] | None = None,
    last_user: str | None = None,
    thread_summary: str | None = None,
) -> dict[str, Any]:
    """
    POST al webhook n8n. Espera JSON { "reply": "..." } y extrae [[ACCION:{...}]].
    No muta inventario aquí: solo parsea acciones para el front.
    """
    env = get_env()
    url = (env.get("N8N_INVENTARIO_URL") or "").strip()
    if not url:
        raise RuntimeError("N8N_INVENTARIO_URL no configurada")

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    key = (env.get("N8N_INVENTARIO_KEY") or "").strip()
    if key:
        headers["X-API-Key"] = key

    catalog = _origen_catalog()
    focus = thread_focus if isinstance(thread_focus, dict) else {}
    facts = (
        "Hechos verificados desde Supabase (columna origen exacta). "
        "NUNCA digas que un inventario está vacío si aparece aquí con registros > 0. "
        "Filtra siempre con igualdad exacta del nombre (ej. origen = 'Inventario 1'). "
        "Para listados en el panel derecho del chat, emite "
        '[[ACCION:{"tipo":"mostrar_panel","overview":"personTotal|areaTotal|recent|...",'
        '"persona":"...","area":"...","origen":"...","focus":"...","limit":50}]]. '
        f"Catálogo: {json.dumps(catalog, ensure_ascii=False)}"
    )
    if focus:
        facts += f" Foco del hilo: {json.dumps(focus, ensure_ascii=False)}."

    body = json.dumps(
        {
            "message": mensaje,
            "sessionId": session_id,
            "origenCatalog": catalog,
            "systemFacts": facts,
            "totalRegistros": sum(int(c["registros"]) for c in catalog),
            "threadFocus": focus or None,
            "lastUser": (last_user or "").strip() or None,
            "threadSummary": (thread_summary or "").strip() or None,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    req = Request(url, data=body, headers=headers, method="POST")

    try:
        with urlopen(req, timeout=150) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:400]
        raise RuntimeError(f"n8n HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"n8n unreachable: {exc.reason}") from exc

    try:
        data = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        data = {"reply": raw}

    if isinstance(data, list) and data:
        # Algunos webhooks n8n devuelven [{ json: {...} }]
        first = data[0]
        if isinstance(first, dict):
            data = first.get("json") if isinstance(first.get("json"), dict) else first

    if not isinstance(data, dict):
        data = {"reply": str(data)}

    texto = str(data.get("reply") or data.get("output") or data.get("text") or "")
    acciones: list[Any] = []
    if isinstance(data.get("acciones"), list):
        acciones.extend([a for a in data["acciones"] if isinstance(a, dict)])

    for bloque in ACCION_RE.findall(texto):
        try:
            parsed = json.loads(bloque.strip())
            if isinstance(parsed, dict):
                acciones.append(parsed)
        except json.JSONDecodeError:
            pass

    texto_limpio = ACCION_RE.sub("", texto).strip()
    return {"reply": texto_limpio, "acciones": acciones}
