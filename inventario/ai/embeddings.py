"""Embeddings vía API HTTP (OpenAI-compatible) — sin numpy/local models.

Default: text-embedding-3-small → 1536 dims (columna inventario.embedding).
Requiere OPENAI_API_KEY (o EMBEDDING_API_KEY + EMBEDDING_BASE_URL).
"""

from __future__ import annotations

import json
import logging
from typing import Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from inventario.supabase_client import get_env

logger = logging.getLogger(__name__)

EMBEDDING_DIMS = 1536
DEFAULT_MODEL = "text-embedding-3-small"


def row_to_embed_text(row: dict) -> str:
    parts = [
        str(row.get("articulo") or "").strip(),
        str(row.get("marca") or "").strip(),
        str(row.get("modelo") or "").strip(),
        str(row.get("area") or "").strip(),
        str(row.get("persona") or "").strip(),
        str(row.get("etiqueta") or "").strip(),
        str(row.get("origen") or "").strip(),
    ]
    return " | ".join(p for p in parts if p)


def _cfg() -> tuple[str, str, str]:
    env = get_env()
    api_key = (
        env.get("EMBEDDING_API_KEY")
        or env.get("OPENAI_API_KEY")
        or ""
    ).strip()
    base = (
        env.get("EMBEDDING_BASE_URL")
        or "https://api.openai.com/v1"
    ).rstrip("/")
    model = (
        env.get("EMBEDDING_MODEL") or DEFAULT_MODEL
    ).strip() or DEFAULT_MODEL
    return api_key, base, model


def embeddings_configured() -> bool:
    return bool(_cfg()[0])


def _embed_batch(texts: Sequence[str]) -> list[list[float]]:
    api_key, base, model = _cfg()
    if not api_key:
        raise RuntimeError(
            "Falta OPENAI_API_KEY (o EMBEDDING_API_KEY) para embeddings."
        )
    cleaned = [(t or "").strip() or "sin datos" for t in texts]
    url = f"{base}/embeddings"
    body = json.dumps(
        {
            "model": model,
            "input": cleaned if len(cleaned) > 1 else cleaned[0],
            "encoding_format": "float",
        }
    ).encode("utf-8")
    req = Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:400]
        raise RuntimeError(f"embeddings HTTP {exc.code}: {detail}") from exc
    except URLError as exc:
        raise RuntimeError(f"embeddings red: {exc}") from exc

    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list) or not data:
        raise RuntimeError("embeddings: respuesta vacía")
    ordered = sorted(data, key=lambda d: int(d.get("index") or 0))
    out: list[list[float]] = []
    for item in ordered:
        vec = item.get("embedding")
        if not isinstance(vec, list) or not vec:
            raise RuntimeError("embeddings: vector inválido")
        out.append([float(x) for x in vec])
    return out


def embed_passages(texts: Sequence[str]) -> list[list[float]]:
    return _embed_batch(texts)


def embed_query(text: str) -> list[float]:
    return _embed_batch([(text or "").strip() or "inventario"])[0]


def vector_literal(vec: Sequence[float]) -> str:
    return "[" + ",".join(f"{float(x):.8f}" for x in vec) + "]"
