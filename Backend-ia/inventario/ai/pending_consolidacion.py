"""Lote pendiente de consolidación (copiar/mover) por session_id."""

from __future__ import annotations

import threading
import time
from typing import Any

_LOCK = threading.Lock()
_STORE: dict[str, dict[str, Any]] = {}
_TTL_SEC = 10 * 60  # 10 minutos


def _purge_expired(now: float | None = None) -> None:
    ts = now if now is not None else time.time()
    dead = [
        sid
        for sid, payload in _STORE.items()
        if ts - float(payload.get("created_at") or 0) > _TTL_SEC
    ]
    for sid in dead:
        _STORE.pop(sid, None)


def set_pending(session_id: str, payload: dict[str, Any]) -> None:
    sid = str(session_id or "").strip() or "default"
    data = dict(payload)
    data["created_at"] = time.time()
    data["session_id"] = sid
    with _LOCK:
        _purge_expired()
        _STORE[sid] = data


def get_pending(session_id: str | None) -> dict[str, Any] | None:
    sid = str(session_id or "").strip() or "default"
    with _LOCK:
        _purge_expired()
        payload = _STORE.get(sid)
        return dict(payload) if isinstance(payload, dict) else None


def clear_pending(session_id: str | None) -> bool:
    sid = str(session_id or "").strip() or "default"
    with _LOCK:
        return _STORE.pop(sid, None) is not None


def is_affirmative_confirm(message: str) -> bool:
    t = (message or "").strip().lower().rstrip("!?.…")
    if not t:
        return False
    # Solo confirmaciones cortas / explícitas (no “sí, pero cambia el destino”).
    if t in {
        "si",
        "sí",
        "yes",
        "ok",
        "okay",
        "okey",
        "vale",
        "dale",
        "claro",
        "listo",
        "adelante",
        "hazlo",
        "procede",
        "proceder",
        "confirma",
        "confirmo",
        "de acuerdo",
        "correcto",
        "afirmativo",
    }:
        return True
    return bool(
        __import__("re").match(
            r"^(sí|si|yes|ok|okay|okey|vale|dale|claro|listo|adelante|hazlo|"
            r"procede|confirma|confirmo|de acuerdo)([,.\s].*)?$",
            t,
        )
    )


def is_negative_cancel(message: str) -> bool:
    t = (message or "").strip().lower().rstrip("!?.…")
    if not t:
        return False
    if t in {
        "no",
        "nop",
        "nope",
        "cancel",
        "cancela",
        "cancelar",
        "cancelalo",
        "mejor no",
        "olvidalo",
        "olvídalo",
        "para",
        "deten",
        "detén",
    }:
        return True
    return bool(
        __import__("re").match(
            r"^(no|nop|nope|cancel\w*|mejor no|olvid\w*|para|det[eé]n)([,.\s].*)?$",
            t,
        )
    )
