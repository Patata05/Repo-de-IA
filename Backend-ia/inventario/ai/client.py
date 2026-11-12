from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from urllib.error import URLError
from urllib.request import urlopen

from openai import OpenAI

from inventario.supabase_client import get_env

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
META_BASE_URL = "https://api.meta.ai/v1"
NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"
OPENAI_BASE_URL = "https://api.openai.com/v1"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OLLAMA_DEFAULT_BASE = "http://127.0.0.1:11434/v1"

PROVIDER_LABELS: dict[str, str] = {
    "nvidia": "NVIDIA NIM",
    "groq": "Groq Cloud",
    "gemini": "Google Gemini",
    "muse": "Meta Muse",
    "deepseek": "DeepSeek",
    "openai": "OpenAI",
    "openrouter": "OpenRouter",
    "ollama": "Ollama Local",
}

# Catálogo de modelos disponibles por proveedor (el primero es SIEMPRE el mejor por defecto)
PROVIDER_MODEL_CATALOG: dict[str, tuple[dict[str, object], ...]] = {
    "nvidia": (
        {
            "id": "nvidia/nemotron-3.5-bolt-e4b",
            "label": "Nemotron 3.5 Bolt",
            "badge": "Mejor · Ultra rápido",
            "token_budget": 128_000,
            "recommended": True,
        },
        {
            "id": "nvidia/nemotron-3.5-lightning-30b-a3b",
            "label": "Nemotron 3.5 Lightning 30B",
            "badge": "Equilibrado · 30B",
            "token_budget": 128_000,
            "recommended": False,
        },
        {
            "id": "mistralai/mistral-large-4-1t-a52b",
            "label": "Mistral Large 4",
            "badge": "Alta capacidad · 1T",
            "token_budget": 128_000,
            "recommended": False,
        },
        {
            "id": "minimaxai/minimax-m3.1-flash",
            "label": "MiniMax M3.1 Flash",
            "badge": "Ágil",
            "token_budget": 128_000,
            "recommended": False,
        },
        {
            "id": "deepseek-ai/deepseek-v4.1-flash",
            "label": "DeepSeek V4.1 Flash",
            "badge": "Razonamiento profundo",
            "token_budget": 64_000,
            "recommended": False,
        },
    ),
    "groq": (
        {
            "id": "llama-3.3-70b-versatile",
            "label": "Llama 3.3 70B Versatile",
            "badge": "Mejor · Más capaz",
            "token_budget": 131_072,
            "recommended": True,
        },
        {
            "id": "llama-3.1-8b-instant",
            "label": "Llama 3.1 8B Instant",
            "badge": "Ultra rápido",
            "token_budget": 131_072,
            "recommended": False,
        },
        {
            "id": "qwen-qwq-32b",
            "label": "Qwen QwQ 32B",
            "badge": "Razonamiento",
            "token_budget": 131_072,
            "recommended": False,
        },
        {
            "id": "mixtral-8x7b-32768",
            "label": "Mixtral 8x7B",
            "badge": "Ligero",
            "token_budget": 32_768,
            "recommended": False,
        },
    ),
    "gemini": (
        {
            "id": "gemini-2.5-flash",
            "label": "Gemini 2.5 Flash",
            "badge": "Mejor · Rápido y preciso",
            "token_budget": 250_000,
            "recommended": True,
        },
        {
            "id": "gemini-2.5-pro",
            "label": "Gemini 2.5 Pro",
            "badge": "Máxima capacidad",
            "token_budget": 250_000,
            "recommended": False,
        },
        {
            "id": "gemini-2.0-flash",
            "label": "Gemini 2.0 Flash",
            "badge": "Ligero",
            "token_budget": 250_000,
            "recommended": False,
        },
    ),
    "muse": (
        {
            "id": "muse-spark-1.3",
            "label": "Muse Spark 1.3",
            "badge": "Mejor · Rápido",
            "token_budget": 128_000,
            "recommended": True,
        },
        {
            "id": "muse-wonder-1.0",
            "label": "Muse Wonder 1.0",
            "badge": "Alta capacidad",
            "token_budget": 128_000,
            "recommended": False,
        },
    ),
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
    "openai": (
        {
            "id": "gpt-4o-mini",
            "label": "GPT-4o Mini",
            "badge": "Mejor · Rápido y eficiente",
            "token_budget": 128_000,
            "recommended": True,
        },
        {
            "id": "gpt-4o",
            "label": "GPT-4o",
            "badge": "Máxima capacidad",
            "token_budget": 128_000,
            "recommended": False,
        },
    ),
    "openrouter": (
        {
            "id": "google/gemini-2.5-flash",
            "label": "Gemini 2.5 Flash",
            "badge": "Mejor · Rápido",
            "token_budget": 128_000,
            "recommended": True,
        },
        {
            "id": "meta-llama/llama-3.3-70b-instruct:free",
            "label": "Llama 3.3 70B Free",
            "badge": "Gratis · 70B",
            "token_budget": 128_000,
            "recommended": False,
        },
        {
            "id": "deepseek/deepseek-chat-v3-0324:free",
            "label": "DeepSeek V3 Free",
            "badge": "Gratis",
            "token_budget": 64_000,
            "recommended": False,
        },
    ),
    "ollama": (
        {
            "id": "llama3.2",
            "label": "Llama 3.2 Local",
            "badge": "Mejor · Local",
            "token_budget": 32_768,
            "recommended": True,
        },
    ),
}

# Presupuesto de contexto/cuota de sesión por proveedor/modelo (tokens)
MODEL_TOKEN_BUDGETS: dict[str, int] = {
    str(entry["id"]): int(entry["token_budget"])
    for catalog in PROVIDER_MODEL_CATALOG.values()
    for entry in catalog
}

PROVIDER_DEFAULT_BUDGETS: dict[str, int] = {
    "nvidia": 128_000,
    "muse": 128_000,
    "deepseek": 64_000,
    "groq": 131_072,
    "gemini": 250_000,
    "openai": 128_000,
    "openrouter": 128_000,
    "ollama": 32_768,
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
    return PROVIDER_DEFAULT_BUDGETS.get((provider or "").lower(), 128_000)


def detect_provider_from_key(api_key: str, hint_var: str = "") -> str | None:
    """
    Reconoce automáticamente el proveedor de IA a partir del formato/prefijo de la API key
    o del nombre de la variable donde se colocó.
    """
    k = (api_key or "").strip()
    if not k or k.startswith(("http://", "https://", "eyJ", "sb_")):
        return None
    if k.startswith("nvapi-"):
        return "nvidia"
    if k.startswith("gsk_"):
        return "groq"
    if k.startswith("AIza"):
        return "gemini"
    if k.startswith("LLM_"):
        return "muse"
    if k.startswith("sk-or-"):
        return "openrouter"
    if k.startswith(("sk-proj-", "sk-svcacct-")):
        return "openai"

    var_u = (hint_var or "").upper()
    if "NVIDIA" in var_u:
        return "nvidia"
    if "GROQ" in var_u:
        return "groq"
    if "GEMINI" in var_u or "GOOGLE" in var_u:
        return "gemini"
    if "OPENROUTER" in var_u:
        return "openrouter"
    if "OPENAI" in var_u:
        return "openai"
    if "DEEPSEEK" in var_u:
        return "deepseek"
    if "MUSE" in var_u or "META" in var_u:
        return "muse"

    if k.startswith("sk-"):
        # Keys hexadecimales de 32 caracteres tras sk- suelen ser DeepSeek; el resto OpenAI
        tail = k[3:]
        if len(tail) == 32 and all(c in "0123456789abcdefABCDEF" for c in tail):
            return "deepseek"
        return "openai"
    return None


def _base_url_for_provider(provider: str, env: dict[str, str]) -> str:
    if provider == "nvidia":
        return (env.get("NVIDIA_BASE_URL") or NVIDIA_BASE_URL).rstrip("/")
    if provider == "groq":
        return GROQ_BASE_URL
    if provider == "gemini":
        return GEMINI_OPENAI_BASE_URL
    if provider == "muse":
        return (env.get("META_BASE_URL") or META_BASE_URL).rstrip("/")
    if provider == "deepseek":
        return (env.get("DEEPSEEK_BASE_URL") or DEEPSEEK_BASE_URL).rstrip("/")
    if provider == "openai":
        return (env.get("OPENAI_BASE_URL") or OPENAI_BASE_URL).rstrip("/")
    if provider == "openrouter":
        return OPENROUTER_BASE_URL
    if provider == "ollama":
        return (env.get("OLLAMA_BASE_URL") or OLLAMA_DEFAULT_BASE).rstrip("/")
    return NVIDIA_BASE_URL


def _models_for_provider(provider: str, env: dict[str, str]) -> tuple[str, ...]:
    """
    Devuelve la tupla de modelos para el proveedor, colocando SIEMPRE el mejor
    modelo recomendado primero por defecto, seguido del resto del catálogo.
    """
    catalog = PROVIDER_MODEL_CATALOG.get(provider, ())
    out: list[str] = [str(entry["id"]) for entry in catalog]

    # Si el usuario definió un modelo extra compatible con ese proveedor, agregarlo a las opciones
    env_vars_by_provider: dict[str, tuple[str, ...]] = {
        "nvidia": ("NVIDIA_MODEL",),
        "groq": ("GROQ_MODEL",),
        "gemini": ("GEMINI_MODEL",),
        "muse": ("MUSE_MODEL", "META_MODEL"),
        "deepseek": ("DEEPSEEK_MODEL",),
        "openai": ("OPENAI_MODEL",),
        "openrouter": ("OPENROUTER_MODEL",),
        "ollama": ("OLLAMA_MODEL",),
    }
    for var_name in env_vars_by_provider.get(provider, ()):
        raw = (env.get(var_name) or "").strip()
        for item in raw.split(","):
            cleaned = item.strip()
            if cleaned and cleaned not in out:
                # Evitar mezclar modelos de otro proveedor (ej. muse-spark-1.3 en nvidia)
                if provider == "nvidia" and cleaned == "muse-spark-1.3":
                    continue
                out.append(cleaned)

    return tuple(out) if out else ("nvidia/nemotron-3.5-bolt-e4b",)


def _ollama_installed_models(openai_base: str) -> list[str]:
    """Comprueba tags en el host Ollama (sin /v1) y devuelve los modelos instalados."""
    root = openai_base.rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3]
    tags_url = f"{root.rstrip('/')}/api/tags"
    try:
        with urlopen(tags_url, timeout=0.8) as response:
            status = getattr(response, "status", 200)
            if not (200 <= status < 300):
                return []
            payload = json.loads(response.read().decode("utf-8") or "{}")
            models = payload.get("models") or []
            names = [
                str(m.get("name") or "").strip()
                for m in models
                if isinstance(m, dict) and str(m.get("name") or "").strip()
            ]
            return names or ["llama3.2"]
    except (URLError, TimeoutError, OSError, ValueError):
        return []


def _discover_api_keys(env: dict[str, str]) -> list[tuple[str, str]]:
    """
    Escanea todas las variables de entorno posibles y detecta automáticamente qué
    proveedor corresponde a cada API key configurada en el dispositivo.
    """
    candidate_vars = (
        "NVIDIA_API_KEY",
        "GROQ_API_KEY",
        "GEMINI_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY",
        "DEEPSEEK_API_KEY",
        "MODEL_API_KEY",
        "MUSE_API_KEY",
        "META_API_KEY",
        "API_KEY",
        "LLM_API_KEY",
        "AI_API_KEY",
        "NEXT_PUBLIC_CHAT_API_URL",
    )
    discovered: list[tuple[str, str]] = []
    seen_keys: set[str] = set()

    for var in candidate_vars:
        raw_val = (env.get(var) or "").strip()
        if not raw_val or raw_val in seen_keys:
            continue
        provider = detect_provider_from_key(raw_val, hint_var=var)
        if not provider:
            continue
        seen_keys.add(raw_val)
        discovered.append((provider, raw_val))

    return discovered


def build_llm_endpoints() -> tuple[list[LlmEndpoint], list[str]]:
    """
    Construye los endpoints de IA reconociendo automáticamente las API keys
    presentes en el dispositivo y asignando por defecto el mejor modelo de su catálogo.
    """
    env = get_env()
    discovered = _discover_api_keys(env)
    endpoints: list[LlmEndpoint] = []
    warnings: list[str] = []
    seen_provider_keys: set[tuple[str, str]] = set()

    for provider, key in discovered:
        base = _base_url_for_provider(provider, env)
        sig = (base, key)
        if sig in seen_provider_keys:
            continue
        seen_provider_keys.add(sig)
        models = _models_for_provider(provider, env)
        timeout = 15.0 if provider == "gemini" else 14.0
        endpoints.append(
            LlmEndpoint(
                provider=provider,
                client=_get_pooled_client(key, base, timeout),
                models=models,
                key_fingerprint=get_key_fingerprint(key, provider),
                token_budget=get_token_budget(provider, models[0]),
            )
        )

    # Comprobar Ollama local si está activo
    ollama_base = _base_url_for_provider("ollama", env)
    ollama_models = _ollama_installed_models(ollama_base)
    if ollama_models:
        configured_ollama = [
            m.strip()
            for m in (env.get("OLLAMA_MODEL") or "").split(",")
            if m.strip()
        ]
        merged_ollama = list(dict.fromkeys([*configured_ollama, *ollama_models]))
        key = env.get("OLLAMA_API_KEY") or "ollama"
        endpoints.append(
            LlmEndpoint(
                provider="ollama",
                client=_get_pooled_client(key, ollama_base, 8.0),
                models=tuple(merged_ollama),
                key_fingerprint=get_key_fingerprint(key, "ollama"),
                token_budget=get_token_budget("ollama", merged_ollama[0]),
            )
        )

    if not endpoints:
        warnings.append(
            "No se detectó ninguna API key activa (NVIDIA nvapi-..., Groq gsk_..., Gemini AIza..., OpenAI/DeepSeek sk-..., o Meta LLM_...)."
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
        primary.models[0]
        if primary and primary.models
        else "nvidia/nemotron-3.5-bolt-e4b"
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
        "token_budget": primary.token_budget if primary else 128_000,
    }


def get_llm_model() -> str:
    endpoints, _ = build_llm_endpoints()
    if endpoints and endpoints[0].models:
        return endpoints[0].models[0]
    return "nvidia/nemotron-3.5-bolt-e4b"
