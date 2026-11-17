"""
Legacy stub. El chat ya no usa respuestas hardcodeadas ni detectores locales;
todo pasa por PydanticAI (tool_agent). Se mantiene el módulo vacío por si
algún import residual lo referencia.
"""

from __future__ import annotations


def pick_ack_reply() -> str:
    raise RuntimeError("local_fallback deshabilitado: usar PydanticAI")


def pick_greeting_reply() -> str:
    raise RuntimeError("local_fallback deshabilitado: usar PydanticAI")


def pick_help_reply() -> str:
    raise RuntimeError("local_fallback deshabilitado: usar PydanticAI")


def local_chat_answer(message: str) -> tuple[str, list[dict]]:
    raise RuntimeError("local_fallback deshabilitado: usar PydanticAI")
