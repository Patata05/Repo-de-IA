from __future__ import annotations

import hashlib
from dataclasses import dataclass

from openai import OpenAI

from inventario.supabase_client import get_env

DEEPSEEK_BASE_URL = "https://api.deepseek.com"

PROVIDER_LABELS: dict[str, str] = {
    "deepseek": "DeepSeek",
}

PROVIDER_MODEL_CATALOG: dict[str, tuple[dict[str, object], ...]] = {
    "deepseek": (
        {
            "id": "deepseek-chat",
            "label": "DeepSeek V3 Chat",
            "badge": "Mejor · Rápido",
            "token_budget": 64_000,
            "recommended": True,
        },
        {
            "id": "deepseek-reasoner",
            "label": "DeepSeek R1",
            "badge": "Razonamiento",
            "token_budget": 64_000,
            "recommended": False,
        },
    ),
}

MODEL_TOKEN_BUDGETS: dict[str, int] = {
    str(entry["id"]): int(entry["token_budget"])
    for catalog in PROVIDER_MODEL_CATALOG.values()
    for entry in catalog
}

PROVIDER_DEFAULT_BUDGETS: dict[str, int] = {
    "deepseek": 64_000,
}


@dataclass(frozen=True)
class LlmEndpoint:
    provider: str
    client: OpenAI
    models: tuple[str, ...]
    key_fingerprint: str
    token_budget: int


_CLIENT_POOL: dict[tuple[str, str, float], OpenAI] = {}


def _get_pooled_client(api_key: str, base_url: str, timeout: float) -> OpenAI:
    cache_key = (api_key, base_url, timeout)
    cached = _CLIENT_POOL.get(cache_key)
    if cached is not None:
        return cached
    client = OpenAI(
        api_key=api_key,
        base_url=base_url,
        timeout=timeout,
        max_retries=0,
    )
    _CLIENT_POOL[cache_key] = client
    return client


def get_key_fingerprint(api_key: str, provider: str = "") -> str:
    raw = f"{provider}:{(api_key or 'local').strip()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:10]


def get_token_budget(provider: str, model: str) -> int:
    m = (model or "").strip().lower()
    for name, budget in MODEL_TOKEN_BUDGETS.items():
        if name.lower() == m or name.lower() in m:
            return budget
    return PROVIDER_DEFAULT_BUDGETS.get((provider or "").lower(), 64_000)


def _deepseek_models(env: dict[str, str]) -> tuple[str, ...]:
    catalog = [str(entry["id"]) for entry in PROVIDER_MODEL_CATALOG["deepseek"]]
    raw = (env.get("DEEPSEEK_MODEL") or env.get("LLM_MODEL") or "").strip()
    if raw and raw not in catalog:
        catalog.insert(0, raw)
    elif raw and raw in catalog:
        catalog = [raw, *[m for m in catalog if m != raw]]
    return tuple(catalog) if catalog else ("deepseek-chat",)


def build_llm_endpoints() -> tuple[list[LlmEndpoint], list[str]]:
    """Solo DeepSeek."""
    env = get_env()
    endpoints: list[LlmEndpoint] = []
    warnings: list[str] = []

    key = (env.get("DEEPSEEK_API_KEY") or "").strip()
    if not key:
        warnings.append("deepseek: falta DEEPSEEK_API_KEY")
        return endpoints, warnings

    base = (env.get("DEEPSEEK_BASE_URL") or DEEPSEEK_BASE_URL).rstrip("/")
    models = _deepseek_models(env)
    endpoints.append(
        LlmEndpoint(
            provider="deepseek",
            client=_get_pooled_client(key, base, 22.0),
            models=models,
            key_fingerprint=get_key_fingerprint(key, "deepseek"),
            token_budget=get_token_budget("deepseek", models[0]),
        )
    )
    return endpoints, warnings


def get_llm_endpoints() -> list[LlmEndpoint]:
    endpoints, _ = build_llm_endpoints()
    return endpoints


def get_catalog_metadata(provider: str, model_id: str, is_first: bool = False) -> dict[str, object]:
    catalog = PROVIDER_MODEL_CATALOG.get(provider, ())
    for entry in catalog:
        if str(entry.get("id")).lower() == model_id.lower():
            return {
                "id": model_id,
                "label": str(entry.get("label") or model_id),
                "badge": str(entry.get("badge") or ""),
                "token_budget": int(entry.get("token_budget") or get_token_budget(provider, model_id)),
                "recommended": bool(entry.get("recommended", False)),
            }
    short = model_id.split("/")[-1] if "/" in model_id else model_id
    return {
        "id": model_id,
        "label": short,
        "badge": "Mejor · Por defecto" if is_first else "Disponible",
        "token_budget": get_token_budget(provider, model_id),
        "recommended": is_first,
    }


def describe_llm_setup() -> dict:
    endpoints, warnings = build_llm_endpoints()
    primary = endpoints[0] if endpoints else None
    primary_model = (
        primary.models[0] if primary and primary.models else "deepseek-chat"
    )
    primary_provider = primary.provider if primary else "local"

    available_models: list[dict[str, object]] = []
    seen_model_ids: set[str] = set()
    for ep_idx, ep in enumerate(endpoints):
        prov_label = PROVIDER_LABELS.get(ep.provider, ep.provider.upper())
        for m_idx, m_id in enumerate(ep.models):
            unique_key = f"{ep.provider}:{m_id}"
            if unique_key in seen_model_ids:
                continue
            seen_model_ids.add(unique_key)
            meta = get_catalog_metadata(ep.provider, m_id, is_first=(m_idx == 0))
            is_recommended = bool(meta["recommended"]) and ep_idx == 0 and m_idx == 0
            available_models.append(
                {
                    "id": m_id,
                    "label": meta["label"],
                    "badge": meta["badge"],
                    "provider": ep.provider,
                    "provider_label": prov_label,
                    "key_fingerprint": ep.key_fingerprint,
                    "token_budget": meta["token_budget"],
                    "recommended": is_recommended,
                }
            )

    return {
        "providers": [
            {
                "name": ep.provider,
                "label": PROVIDER_LABELS.get(ep.provider, ep.provider.upper()),
                "models": list(ep.models),
                "key_fingerprint": ep.key_fingerprint,
                "token_budget": ep.token_budget,
            }
            for ep in endpoints
        ],
        "available_models": available_models,
        "default_model": primary_model,
        "warnings": warnings,
        "configured": bool(endpoints),
        "active_provider": primary_provider,
        "active_provider_label": PROVIDER_LABELS.get(primary_provider, primary_provider.upper()),
        "active_model": primary_model,
        "key_fingerprint": primary.key_fingerprint if primary else "local",
        "token_budget": primary.token_budget if primary else 64_000,
    }


def get_llm_model() -> str:
    endpoints, _ = build_llm_endpoints()
    if endpoints and endpoints[0].models:
        return endpoints[0].models[0]
    return "deepseek-chat"
