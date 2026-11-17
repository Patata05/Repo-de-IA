from __future__ import annotations

import hashlib
from dataclasses import dataclass

from openai import OpenAI

from inventario.supabase_client import get_env

OPENAI_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-4o-mini"
OPENAI_MODELS = ("gpt-4o-mini", "gpt-4.1-mini", "gpt-4o")
TOKEN_BUDGET = 128_000

# USD por token (aprox. list price).
MODEL_RATES: dict[str, tuple[float, float]] = {
    "gpt-4o-mini": (0.00000015, 0.00000060),
    "gpt-4.1-mini": (0.0000004, 0.0000016),
    "gpt-4o": (0.0000025, 0.00001),
}


@dataclass(frozen=True)
class LlmEndpoint:
    provider: str
    client: OpenAI
    models: tuple[str, ...]
    api_key: str = ""
    base_url: str = OPENAI_BASE_URL


def _openai_models(env: dict[str, str]) -> tuple[str, ...]:
    preferred = (
        env.get("OPENAI_MODEL") or env.get("LLM_MODEL") or DEFAULT_MODEL
    ).strip()
    models: list[str] = []
    if preferred in OPENAI_MODELS:
        models.append(preferred)
    elif preferred:
        models.append(preferred)
    for m in OPENAI_MODELS:
        if m not in models:
            models.append(m)
    return tuple(models)


def key_fingerprint(api_key: str) -> str:
    raw = (api_key or "").strip()
    if not raw:
        return "default"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8]


def build_llm_endpoints() -> tuple[list[LlmEndpoint], list[str]]:
    """Solo OpenAI (chat)."""
    env = get_env()
    endpoints: list[LlmEndpoint] = []
    warnings: list[str] = []

    key = (env.get("OPENAI_API_KEY") or env.get("EMBEDDING_API_KEY") or "").strip()
    if not key:
        warnings.append("openai: falta OPENAI_API_KEY")
        return endpoints, warnings

    base = (env.get("OPENAI_BASE_URL") or OPENAI_BASE_URL).rstrip("/")
    endpoints.append(
        LlmEndpoint(
            provider="openai",
            client=OpenAI(
                api_key=key,
                base_url=base,
                timeout=45.0,
                max_retries=0,
            ),
            models=_openai_models(env),
            api_key=key,
            base_url=base,
        )
    )
    return endpoints, warnings


def get_llm_endpoints() -> list[LlmEndpoint]:
    endpoints, _ = build_llm_endpoints()
    return endpoints


_PROVIDER_LABELS = {
    "openai": "OpenAI",
}


def describe_llm_setup() -> dict:
    endpoints, warnings = build_llm_endpoints()
    primary = endpoints[0] if endpoints else None
    primary_model = primary.models[0] if primary and primary.models else DEFAULT_MODEL
    primary_provider = primary.provider if primary else "local"
    fp = key_fingerprint(primary.api_key) if primary else "default"
    available_models: list[dict[str, object]] = []
    seen: set[str] = set()
    badges = {
        "gpt-4o-mini": "Mejor · Por defecto",
        "gpt-4.1-mini": "Más contexto",
        "gpt-4o": "Más capaz",
    }
    for ep_idx, ep in enumerate(endpoints):
        prov_label = _PROVIDER_LABELS.get(ep.provider, ep.provider.upper())
        for m_idx, m_id in enumerate(ep.models):
            key = f"{ep.provider}:{m_id}"
            if key in seen:
                continue
            seen.add(key)
            available_models.append(
                {
                    "id": m_id,
                    "label": m_id,
                    "badge": badges.get(m_id, "")
                    or ("Mejor · Por defecto" if ep_idx == 0 and m_idx == 0 else ""),
                    "provider": ep.provider,
                    "provider_label": prov_label,
                    "recommended": m_id == DEFAULT_MODEL,
                    "token_budget": TOKEN_BUDGET,
                    "key_fingerprint": fp,
                }
            )

    return {
        "providers": [
            {
                "name": ep.provider,
                "label": _PROVIDER_LABELS.get(ep.provider, ep.provider.upper()),
                "models": list(ep.models),
                "token_budget": TOKEN_BUDGET,
                "key_fingerprint": key_fingerprint(ep.api_key),
            }
            for ep in endpoints
        ],
        "available_models": available_models,
        "default_model": primary_model,
        "warnings": warnings,
        "configured": bool(endpoints),
        "active_provider": primary_provider,
        "active_provider_label": _PROVIDER_LABELS.get(
            primary_provider, primary_provider.upper()
        ),
        "active_model": primary_model,
        "token_budget": TOKEN_BUDGET,
        "key_fingerprint": fp,
    }


def get_llm_model() -> str:
    endpoints, _ = build_llm_endpoints()
    if endpoints and endpoints[0].models:
        return endpoints[0].models[0]
    return DEFAULT_MODEL


def estimate_cost_usd(
    model: str, prompt_tokens: int, completion_tokens: int
) -> float:
    rates = MODEL_RATES.get(model) or MODEL_RATES[DEFAULT_MODEL]
    pin, pout = rates
    return round(
        max(0, int(prompt_tokens)) * pin + max(0, int(completion_tokens)) * pout,
        8,
    )
