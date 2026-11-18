"""Few-shot dinámico: guardar / recuperar ejemplos en ai_learned_examples (pgvector)."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from inventario import supabase_client as db
from inventario.ai.embeddings import EMBEDDING_DIMS

logger = logging.getLogger(__name__)

_MAX_Q = 400
_MAX_INTENT = 280
_MAX_REPLY = 900
_ALLOWED_SOURCES = frozenset({"thumbs_up", "correction", "manual"})


def _clip(text: str, limit: int) -> str:
    t = re.sub(r"\s+", " ", str(text or "").strip())
    if len(t) <= limit:
        return t
    return t[: max(0, limit - 1)].rstrip() + "…"


def looks_like_learning_message(user_text: str) -> bool:
    """True si el turno es enseñanza/corrección (prioridad sobre consultas)."""
    folded = re.sub(
        r"\s+",
        " ",
        "".join(
            c
            for c in __import__("unicodedata").normalize(
                "NFD", str(user_text or "").lower()
            )
            if __import__("unicodedata").category(c) != "Mn"
        ),
    ).strip()
    if not folded:
        return False
    if re.search(r"\bnueva\s+reglas?\b|\breglas?\s+nueva\b", folded):
        return True
    if re.search(
        r"\b(aprende|aprender|aprendelo|aprendela|memoriza|memorizar)\b",
        folded,
    ):
        return True
    if re.search(
        r"\b(guarda|guardar|anota|registra)\s+(esta\s+|una\s+|la\s+)?(nueva\s+)?(regla|correccion|preferencia|instruccion)\b",
        folded,
    ):
        return True
    if re.search(r"\brecuerda\s+que\b|\bten\s+en\s+cuenta\s+que\b", folded):
        return True
    if re.search(
        r"\b(asi\s+no|no\s+asi|no\s+es\s+asi|esto\s+esta\s+mal|incorrecto)\b",
        folded,
    ):
        return True
    if re.search(
        r"\bcuando\s+(yo\s+)?(diga|pida|digas|pidas|mencione|pregunte)\b",
        folded,
    ):
        return True
    return False


def format_learned_block(examples: list[dict[str, Any]]) -> str:
    """Bloque corto para inyectar en el prompt (pocos tokens)."""
    if not examples:
        return ""
    lines = [
        "EJEMPLOS APRENDIDOS del usuario (OBLIGATORIO aplicar si encajan: "
        "misma intención pese a faltas de ortografía; mismos filtros y "
        "mismo tipo de visor chat+panel. NO los cites ni digas que son ejemplos):"
    ]
    for i, ex in enumerate(examples[:4], start=1):
        q = _clip(str(ex.get("pregunta_usuario") or ""), 160)
        intent = _clip(str(ex.get("intencion_y_filtros") or ""), 120)
        ideal = _clip(str(ex.get("respuesta_ideal") or ""), 220)
        sim = ex.get("similarity")
        sim_s = f" sim={float(sim):.2f}" if isinstance(sim, (int, float)) else ""
        lines.append(
            f"{i}) Q: {q}"
            + (f" | Intent: {intent}" if intent else "")
            + (f" | Ideal: {ideal}" if ideal else "")
            + sim_s
        )
    return "\n".join(lines)


def _service_base_and_key() -> tuple[str | None, str | None, str | None]:
    """
    ai_learned_examples tiene RLS sin políticas para anon: hace falta service_role.
    Lee SUPABASE_SERVICE_ROLE_KEY (o SUPABASE_SECRET_KEY) del .env de Backend-ia.
    """
    env = db.get_env()
    base = (
        env.get("NEXT_PUBLIC_SUPABASE_URL") or env.get("SUPABASE_URL") or ""
    ).rstrip("/")
    service = (
        env.get("SUPABASE_SERVICE_ROLE_KEY") or env.get("SUPABASE_SECRET_KEY") or ""
    ).strip()
    if not base:
        return None, None, "Falta SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL en Backend-ia/.env"
    if not service:
        return (
            base,
            None,
            "Falta SUPABASE_SERVICE_ROLE_KEY en Backend-ia/.env "
            "(Dashboard Supabase → Settings → API → service_role). "
            "Con solo ANON_KEY el insert falla por RLS (42501).",
        )
    return base, service, None


def _brief_supabase_error(status: int, raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        return f"HTTP {status}"
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            code = parsed.get("code") or ""
            msg = parsed.get("message") or parsed.get("error") or text
            return f"HTTP {status} {code}: {msg}".strip()
    except Exception:  # noqa: BLE001
        pass
    return f"HTTP {status}: {text[:400]}"


def _build_embedding_for_pregunta(pregunta: str) -> tuple[Any | None, str | None]:
    """
    Genera embedding text-embedding-3-small (1536 dims).
    Devuelve (valor_para_postgrest, error). valor = string literal "[...]" (pgvector).
    """
    try:
        from inventario.ai.embeddings import (
            embeddings_configured,
            embed_query,
            vector_literal,
        )
    except Exception as exc:  # noqa: BLE001
        msg = f"embeddings import falló: {exc}"
        logger.warning(msg)
        print(f"[inventario] learned_examples {msg}")
        return None, msg

    if not embeddings_configured():
        msg = "OPENAI_API_KEY/EMBEDDING_API_KEY ausente; guardo sin embedding"
        logger.warning(msg)
        print(f"[inventario] learned_examples {msg}")
        return None, None

    try:
        vec = embed_query(pregunta)
    except Exception as exc:  # noqa: BLE001
        msg = f"client.embeddings / embed_query falló: {exc}"
        logger.exception(msg)
        print(f"[inventario] learned_examples {msg}")
        return None, msg

    if not isinstance(vec, list) or len(vec) != EMBEDDING_DIMS:
        msg = (
            f"embedding dim inválida: got={len(vec) if isinstance(vec, list) else type(vec)} "
            f"expected={EMBEDDING_DIMS}"
        )
        logger.error(msg)
        print(f"[inventario] learned_examples {msg}")
        return None, msg

    print(
        f"[inventario] learned_examples embedding OK dims={len(vec)} "
        f"model=text-embedding-3-small"
    )
    # PostgREST + pgvector: literal "[...]" (mismo formato que inventario.embedding).
    return vector_literal(vec), None


def search_similar_examples(
    pregunta: str,
    *,
    limit: int = 2,
    threshold: float = 0.80,
) -> list[dict[str, Any]]:
    """Top-N ejemplos semánticos (similitud cosine ≥ threshold)."""
    q = (pregunta or "").strip()
    if not q:
        return []
    emb, _emb_err = _build_embedding_for_pregunta(q)
    if not emb:
        return []

    base, service, cfg_err = _service_base_and_key()
    if cfg_err or not base or not service:
        print(f"[inventario] match_ai_learned_examples skip: {cfg_err}")
        return []

    body = {
        "query_embedding": emb,
        "match_count": max(1, min(int(limit or 2), 5)),
        "match_threshold": float(threshold),
    }
    url, headers, _ = db._with_key(
        base, "rpc/match_ai_learned_examples", "service", service, True
    )
    client = db.get_http_client()
    try:
        response = client.request(
            "POST",
            url,
            headers={**headers, "Content-Type": "application/json"},
            json=body,
            timeout=30,
        )
        raw = response.content.decode("utf-8", errors="replace") if response.content else ""
        print(
            f"[inventario] match_ai_learned_examples status={response.status_code} "
            f"body={(raw[:300] if raw else '')!r}"
        )
        if response.status_code not in (200, 201):
            logger.warning(
                "match_ai_learned_examples fail %s",
                _brief_supabase_error(response.status_code, raw),
            )
            return []
        payload = json.loads(raw) if raw else []
    except Exception as exc:  # noqa: BLE001
        print(f"[inventario] match_ai_learned_examples excepción: {exc!r}")
        return []

    if not isinstance(payload, list):
        return []
    out: list[dict[str, Any]] = []
    for row in payload:
        if not isinstance(row, dict):
            continue
        out.append(
            {
                "id": row.get("id"),
                "pregunta_usuario": str(row.get("pregunta_usuario") or ""),
                "intencion_y_filtros": str(row.get("intencion_y_filtros") or ""),
                "respuesta_ideal": str(row.get("respuesta_ideal") or ""),
                "source": str(row.get("source") or ""),
                "similarity": row.get("similarity"),
            }
        )
    return out[: max(1, min(int(limit or 2), 5))]


def _post_example(body: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    base, service, cfg_err = _service_base_and_key()
    if cfg_err:
        print(f"[inventario] ai_learned_examples INSERT blocked: {cfg_err}")
        return None, cfg_err
    assert base and service

    url, headers, _ = db._with_key(
        base, "ai_learned_examples", "service", service, True
    )
    headers = {
        **headers,
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    # apikey + Authorization: Bearer <SERVICE_ROLE_KEY> (bypass RLS)
    print(
        f"[inventario] ai_learned_examples POST {url} "
        f"keys=apikey+Authorization(Bearer service) "
        f"source={body.get('source')!r} embedded={'embedding' in body}"
    )

    client = db.get_http_client()
    try:
        response = client.request(
            "POST",
            url,
            headers=headers,
            json=body,
            timeout=30,
        )
    except Exception as exc:  # noqa: BLE001
        msg = f"httpx error: {exc}"
        print(f"[inventario] ai_learned_examples INSERT excepción: {msg}")
        return None, msg

    raw = response.content.decode("utf-8", errors="replace") if response.content else ""
    print(
        f"[inventario] ai_learned_examples INSERT status={response.status_code} "
        f"response.text={raw[:800]!r}"
    )

    if response.status_code not in (200, 201):
        err = _brief_supabase_error(response.status_code, raw)
        logger.warning("ai_learned_examples insert %s", err)
        return None, err

    try:
        payload = json.loads(raw) if raw else None
    except json.JSONDecodeError:
        return None, f"HTTP {response.status_code}: JSON inválido: {raw[:300]}"

    row = None
    if isinstance(payload, list) and payload:
        row = payload[0] if isinstance(payload[0], dict) else None
    elif isinstance(payload, dict):
        row = payload

    print(
        f"[inventario] ai_learned_examples INSERT ok id={(row or {}).get('id')}"
    )
    return (
        {
            "id": row.get("id") if isinstance(row, dict) else None,
            "ok": True,
            "source": body.get("source"),
            "embedded": "embedding" in body,
        },
        None,
    )


def save_learned_example(
    *,
    pregunta_usuario: str,
    intencion_y_filtros: str = "",
    respuesta_ideal: str,
    source: str = "thumbs_up",
    session_id: str | None = None,
) -> tuple[dict[str, Any] | None, str | None]:
    """Inserta ejemplo + embedding (1536). Si el vector falla, guarda sin embedding."""
    pregunta = _clip(pregunta_usuario, _MAX_Q)
    intent = _clip(intencion_y_filtros, _MAX_INTENT)
    ideal = _clip(respuesta_ideal, _MAX_REPLY)
    if not pregunta or not ideal:
        return None, "Faltan pregunta_usuario o respuesta_ideal."

    src = (source or "thumbs_up").strip().lower()
    if src not in _ALLOWED_SOURCES:
        src = "thumbs_up"

    # Fail-fast: sin service_role el POST siempre choca con RLS.
    _base, _service, cfg_err = _service_base_and_key()
    if cfg_err:
        print(f"[inventario] ai_learned_examples INSERT blocked: {cfg_err}")
        return None, cfg_err

    emb, emb_err = _build_embedding_for_pregunta(pregunta)
    if emb_err and emb is None:
        # Ya logueado; seguimos sin vector.
        pass

    base_body: dict[str, Any] = {
        "pregunta_usuario": pregunta,
        "intencion_y_filtros": intent,
        "respuesta_ideal": ideal,
        "source": src,
    }
    if session_id:
        base_body["session_id"] = str(session_id).strip()[:120]

    if emb is not None:
        with_emb = {**base_body, "embedding": emb}
        row, err = _post_example(with_emb)
        if not err:
            return row, None
        print(
            f"[inventario] learned_examples reintento SIN embedding tras: {err[:400]}"
        )

    row, err = _post_example(base_body)
    if err:
        return None, err
    return row, None
