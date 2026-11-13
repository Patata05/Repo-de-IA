"""
Búsqueda léxica BM25 entre inventarios (ligera, sin Torch/embeddings).
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
import unicodedata
from typing import Any

logger = logging.getLogger(__name__)

_lock = threading.RLock()
_cache_key: str | None = None
_rows_by_id: dict[str, dict] = {}
_bm25 = None
_bm25_corpus_ids: list[str] = []

TOP_K_DEFAULT = 20


def _fold(s: str) -> str:
    text = unicodedata.normalize("NFD", str(s or "").lower())
    return "".join(ch for ch in text if unicodedata.category(ch) != "Mn")


def _row_id(row: dict) -> str:
    if row.get("id") is not None:
        return f"id:{row['id']}"
    et = str(row.get("etiqueta") or "").strip().lower()
    og = str(row.get("origen") or "").strip().lower()
    return f"etq:{et}|{og}"


def _row_text(row: dict) -> str:
    parts = [
        row.get("etiqueta"),
        row.get("articulo"),
        row.get("marca"),
        row.get("modelo"),
        row.get("serie"),
        row.get("area"),
        row.get("persona"),
        row.get("origen"),
        row.get("estado"),
        row.get("observaciones"),
    ]
    return " ".join(str(p).strip() for p in parts if p not in (None, ""))


def _fingerprint(rows: list[dict]) -> str:
    n = len(rows)
    sample = []
    for r in rows[:5] + rows[-5:]:
        sample.append(
            f"{r.get('id')}:{r.get('etiqueta')}:{r.get('origen')}:{r.get('updated_at')}"
        )
    raw = f"{n}|" + "|".join(sample)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


def _tokenize(text: str) -> list[str]:
    return re.findall(r"[a-z0-9áéíóúüñ]+", _fold(text))


def rebuild_index(rows: list[dict]) -> dict[str, Any]:
    """Reconstruye índice BM25 en memoria."""
    global _cache_key, _rows_by_id, _bm25, _bm25_corpus_ids

    key = _fingerprint(rows)
    with _lock:
        if key == _cache_key and _bm25 is not None:
            return {"ok": True, "cached": True, "rows": len(rows), "engines": status()}

        _rows_by_id = {_row_id(r): r for r in rows}
        _bm25_corpus_ids = list(_rows_by_id.keys())
        corpus_texts = [_row_text(_rows_by_id[i]) for i in _bm25_corpus_ids]
        tokenized = [_tokenize(t) for t in corpus_texts]

        try:
            from rank_bm25 import BM25Okapi

            _bm25 = BM25Okapi(tokenized) if tokenized else None
        except Exception as exc:  # noqa: BLE001
            logger.warning("BM25 falló: %s", exc)
            _bm25 = None

        _cache_key = key
        return {"ok": True, "cached": False, "rows": len(rows), "engines": status()}


def status() -> dict[str, bool]:
    return {
        "bm25": _bm25 is not None,
        "rows_indexed": bool(_rows_by_id),
    }


def _scores_bm25(query: str, top_k: int) -> list[tuple[str, float]]:
    if _bm25 is None or not _bm25_corpus_ids:
        return []
    tokens = _tokenize(query)
    if not tokens:
        return []
    scores = _bm25.get_scores(tokens)
    ranked = sorted(
        enumerate(scores), key=lambda x: float(x[1]), reverse=True
    )[:top_k]
    out = []
    for i, sc in ranked:
        if float(sc) <= 0:
            continue
        out.append((_bm25_corpus_ids[i], float(sc)))
    return out


def hybrid_search(
    query: str,
    rows: list[dict] | None = None,
    *,
    top_k: int = TOP_K_DEFAULT,
    origen: str | None = None,
) -> list[dict]:
    """Búsqueda BM25 (+ fallback léxico). Nombre histórico: hybrid_search."""
    q = str(query or "").strip()
    if not q:
        return []

    if rows is not None:
        rebuild_index(rows)
    elif _bm25 is None:
        return []

    with _lock:
        scored: dict[str, float] = {}

        for rank, (rid, raw) in enumerate(_scores_bm25(q, top_k * 2)):
            scored[rid] = scored.get(rid, 0.0) + 1.2 * (1.0 / (60 + rank)) + 0.012 * float(
                raw
            )

        if not scored and _rows_by_id:
            qf = _fold(q)
            q_toks = set(_tokenize(q))
            for rid, row in _rows_by_id.items():
                text = _fold(_row_text(row))
                toks = set(_tokenize(text))
                if qf and qf in text:
                    scored[rid] = scored.get(rid, 0.0) + 2.0
                elif q_toks and q_toks.issubset(toks):
                    scored[rid] = scored.get(rid, 0.0) + 1.5
                elif q_toks and q_toks & toks:
                    scored[rid] = scored.get(rid, 0.0) + 0.8

        if not scored:
            return []

        ranked_ids = sorted(scored.keys(), key=lambda k: scored[k], reverse=True)
        origen_f = _fold(origen or "")
        out: list[dict] = []
        for rid in ranked_ids:
            row = _rows_by_id.get(rid)
            if not row:
                continue
            if origen_f and _fold(str(row.get("origen") or "")) != origen_f:
                continue
            out.append(dict(row))
            if len(out) >= top_k:
                break
        return out


def format_rag_context(hits: list[dict], limit: int = 12) -> str:
    if not hits:
        return ""
    lines = ["CONTEXTO RAG (BM25) — usa SOLO estos datos reales:"]
    for row in hits[:limit]:
        et = str(row.get("etiqueta") or "—")
        art = str(row.get("articulo") or "—")
        og = str(row.get("origen") or "—")
        area = str(row.get("area") or "—")
        per = str(row.get("persona") or "—")
        lines.append(f"- {et} | {art} | origen={og} | área={area} | persona={per}")
    return "\n".join(lines)
