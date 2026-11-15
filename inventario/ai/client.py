from __future__ import annotations

from dataclasses import dataclass

from openai import OpenAI

from inventario.supabase_client import get_env

DEEPSEEK_BASE_URL = "https://api.deepseek.com"


@dataclass(frozen=True)
class LlmEndpoint:
    provider: str
    client: OpenAI
    models: tuple[str, ...]


def _deepseek_models(env: dict[str, str]) -> tuple[str, ...]:
    preferred = (env.get("DEEPSEEK_MODEL") or env.get("LLM_MODEL") or "deepseek-chat").strip()
    models = [preferred] if preferred else ["deepseek-chat"]
    for extra in ("deepseek-chat", "deepseek-reasoner"):
        if extra not in models:
            models.append(extra)
    return tuple(models)


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
    endpoints.append(
        LlmEndpoint(
            provider="deepseek",
            client=OpenAI(
                api_key=key,
                base_url=base,
                timeout=22.0,
                max_retries=0,
            ),
            models=_deepseek_models(env),
        )
    )
    return endpoints, warnings


def get_llm_endpoints() -> list[LlmEndpoint]:
    endpoints, _ = build_llm_endpoints()
    return endpoints


_PROVIDER_LABELS = {
    "deepseek": "DeepSeek",
}


def describe_llm_setup() -> dict:
    endpoints, warnings = build_llm_endpoints()
    primary = endpoints[0] if endpoints else None
    primary_model = primary.models[0] if primary and primary.models else "deepseek-chat"
    primary_provider = primary.provider if primary else "local"
    available_models: list[dict[str, object]] = []
    seen: set[str] = set()
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
                    "badge": "Mejor · Por defecto" if ep_idx == 0 and m_idx == 0 else "",
                    "provider": ep.provider,
                    "provider_label": prov_label,
                    "recommended": ep_idx == 0 and m_idx == 0,
                }
            )

    return {
        "providers": [
            {
                "name": ep.provider,
                "label": _PROVIDER_LABELS.get(ep.provider, ep.provider.upper()),
                "models": list(ep.models),
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
    }


def get_llm_model() -> str:
    endpoints, _ = build_llm_endpoints()
    if endpoints and endpoints[0].models:
        return endpoints[0].models[0]
    return "deepseek-chat"
