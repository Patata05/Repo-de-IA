"""
Instructor + Pydantic: clasifica la intención del usuario en estructura
válida antes de que el LLM improvise.
"""

from __future__ import annotations

import logging
from typing import Literal

logger = logging.getLogger(__name__)

try:
    from pydantic import BaseModel, Field
except ImportError:  # pragma: no cover
    BaseModel = object  # type: ignore
    Field = lambda **kwargs: None  # type: ignore


class InventarioIntent(BaseModel):
    """Intención estructurada para coordinar herramientas del inventario."""

    action: Literal[
        "search",
        "count",
        "compare",
        "duplicates",
        "copy_between",
        "etiqueta_origen",
        "mutate",
        "qr",
        "recent",
        "other",
        "off_topic",
    ] = Field(description="Acción principal detectada")
    query: str = Field(default="", description="Texto de búsqueda libre")
    etiqueta: str | None = Field(default=None, description="Código de etiqueta si aplica")
    origen_from: str | None = Field(
        default=None, description="Inventario origen, ej. Inventario 1"
    )
    origen_to: str | None = Field(
        default=None, description="Inventario destino, ej. Inventario 3"
    )
    area: str | None = None
    persona: str | None = None
    exclude_etiquetas: list[str] = Field(default_factory=list)
    needs_confirmation: bool = False
    confidence: float = Field(default=0.5, ge=0, le=1)


def classify_intent_with_instructor(
    client,
    *,
    model: str,
    user_text: str,
    thread_hint: str = "",
) -> InventarioIntent | None:
    """
    Usa Instructor sobre un cliente OpenAI-compatible.
    temperature=0 vía create kwargs.
    """
    try:
        import instructor
        from instructor import Mode
    except ImportError:
        logger.warning("instructor no instalado")
        return None

    try:
        patched = instructor.from_openai(client, mode=Mode.JSON)
        system = (
            "Clasifica la petición del usuario sobre un inventario de oficina. "
            "Responde SOLO con el esquema. No inventes etiquetas ni inventarios. "
            "Si dice «esa etiqueta», deja etiqueta vacía (el front la resuelve). "
            "Si pide omitir/excluir, llena exclude_etiquetas si hay código visible. "
            "Temperatura conceptual: sé determinista y estricto."
        )
        messages = [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": (
                    f"Hilo: {thread_hint[:400]}\n\nMensaje: {user_text}"
                    if thread_hint
                    else user_text
                ),
            },
        ]
        result = patched.chat.completions.create(
            model=model,
            messages=messages,
            response_model=InventarioIntent,
            temperature=0,
            max_tokens=300,
        )
        return result
    except Exception as exc:  # noqa: BLE001
        logger.warning("Instructor classify falló: %s", exc)
        return None


def intent_to_hint(intent: InventarioIntent | None) -> str:
    if intent is None:
        return ""
    return (
        "INTención estructurada (Instructor, temp=0):\n"
        f"- action={intent.action} confidence={intent.confidence:.2f}\n"
        f"- query={intent.query!r} etiqueta={intent.etiqueta!r}\n"
        f"- from={intent.origen_from!r} to={intent.origen_to!r}\n"
        f"- area={intent.area!r} persona={intent.persona!r}\n"
        f"- exclude={intent.exclude_etiquetas} needs_confirm={intent.needs_confirmation}\n"
        "OBLIGATORIO: respeta esta intención; usa herramientas reales; no inventes cifras."
    )
