"""Conteo de tokens (tiktoken) + empaquetado de usage para el frontend."""

from __future__ import annotations

from typing import Any

from inventario.ai.client import (
    DEFAULT_MODEL,
    TOKEN_BUDGET,
    estimate_cost_usd,
    key_fingerprint,
)


def count_tokens(text: str, model: str = DEFAULT_MODEL) -> int:
    raw = text or ""
    if not raw:
        return 0
    try:
        import tiktoken

        try:
            enc = tiktoken.encoding_for_model(model)
        except KeyError:
            enc = tiktoken.get_encoding("o200k_base")
        return len(enc.encode(raw))
    except Exception:  # noqa: BLE001
        return max(1, (len(raw) + 3) // 4)


def empty_usage(
    *,
    model: str = DEFAULT_MODEL,
    api_key: str = "",
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
) -> dict[str, Any]:
    total = int(prompt_tokens) + int(completion_tokens)
    return {
        "provider": "openai",
        "proveedor": "OpenAI",
        "model": model,
        "modelo": model,
        "token_budget": TOKEN_BUDGET,
        "limite_contexto": TOKEN_BUDGET,
        "prompt_tokens": int(prompt_tokens),
        "completion_tokens": int(completion_tokens),
        "total_tokens": total,
        "acumulado_sesion": total,
        "costo_usd": estimate_cost_usd(model, prompt_tokens, completion_tokens),
        "key_fingerprint": key_fingerprint(api_key),
    }


def usage_from_pydantic_result(
    result: Any,
    *,
    model: str,
    api_key: str = "",
    fallback_prompt: str = "",
    fallback_reply: str = "",
) -> dict[str, Any]:
    prompt_tokens = 0
    completion_tokens = 0
    try:
        u = result.usage() if callable(getattr(result, "usage", None)) else None
        if u is None:
            u = getattr(result, "usage", None)
        if u is not None:
            prompt_tokens = int(
                getattr(u, "request_tokens", None)
                or getattr(u, "input_tokens", None)
                or getattr(u, "prompt_tokens", None)
                or 0
            )
            completion_tokens = int(
                getattr(u, "response_tokens", None)
                or getattr(u, "output_tokens", None)
                or getattr(u, "completion_tokens", None)
                or 0
            )
            # Algunos RunUsage usan .total_tokens / details
            if prompt_tokens == 0 and completion_tokens == 0:
                total = int(getattr(u, "total_tokens", 0) or 0)
                if total:
                    prompt_tokens = total
    except Exception:  # noqa: BLE001
        prompt_tokens = 0
        completion_tokens = 0

    if prompt_tokens == 0 and fallback_prompt:
        prompt_tokens = count_tokens(fallback_prompt, model)
    if completion_tokens == 0 and fallback_reply:
        completion_tokens = count_tokens(fallback_reply, model)

    return empty_usage(
        model=model,
        api_key=api_key,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )
