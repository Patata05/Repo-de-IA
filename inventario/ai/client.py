from __future__ import annotations

from dataclasses import dataclass
from urllib.error import URLError
from urllib.request import urlopen

from openai import OpenAI

from inventario.supabase_client import get_env

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
META_BASE_URL = "https://api.meta.ai/v1"
OLLAMA_DEFAULT_BASE = "http://127.0.0.1:11434/v1"


@dataclass(frozen=True)
class LlmEndpoint:
    provider: str
    client: OpenAI
    models: tuple[str, ...]


def _parse_providers(raw: str) -> list[str]:
    parts = [p.strip().lower() for p in (raw or "").split(",") if p.strip()]
    return parts or ["muse", "deepseek", "groq", "ollama", "gemini"]


def _preferred_only(*candidates: str) -> tuple[str, ...]:
    for name in candidates:
        cleaned = (name or "").strip()
        if cleaned:
            return (cleaned,)
    return ("llama-3.1-8b-instant",)


def _groq_models(env: dict[str, str]) -> tuple[str, ...]:
    return _preferred_only(
        env.get("GROQ_MODEL"),
        env.get("LLM_MODEL"),
        "llama-3.1-8b-instant",
    )


def _ollama_models(env: dict[str, str]) -> tuple[str, ...]:
    return _preferred_only(env.get("OLLAMA_MODEL"), "llama3.2")


def _gemini_models(env: dict[str, str]) -> tuple[str, ...]:
    return _preferred_only(env.get("GEMINI_MODEL"), "gemini-2.5-flash")


def _deepseek_models(env: dict[str, str]) -> tuple[str, ...]:
    return _preferred_only(env.get("DEEPSEEK_MODEL"), "deepseek-chat")


def _muse_models(env: dict[str, str]) -> tuple[str, ...]:
    # Meta Model API (OpenAI-compatible). Prefer Spark for tool loops del chatbot.
    return _preferred_only(
        env.get("MUSE_MODEL"),
        env.get("META_MODEL"),
        env.get("LLM_MODEL"),
        "muse-spark-1.3",
    )


def _muse_api_key(env: dict[str, str]) -> str:
    return (
        env.get("MODEL_API_KEY")
        or env.get("META_API_KEY")
        or env.get("MUSE_API_KEY")
        or ""
    )


def _ollama_is_alive(openai_base: str) -> bool:
    """Comprueba tags en el host Ollama (sin /v1). Timeout corto."""
    root = openai_base.rstrip("/")
    if root.endswith("/v1"):
        root = root[:-3]
    tags_url = f"{root.rstrip('/')}/api/tags"
    try:
        with urlopen(tags_url, timeout=1.5) as response:
            return 200 <= getattr(response, "status", 200) < 300
    except (URLError, TimeoutError, OSError):
        return False


def build_llm_endpoints() -> tuple[list[LlmEndpoint], list[str]]:
    """
    Arma clientes configurados en orden LLM_PROVIDERS.
    Devuelve (endpoints, avisos_de_config).
    """
    env = get_env()
    order = _parse_providers(
        env.get("LLM_PROVIDERS", "muse,deepseek,groq,ollama,gemini")
    )
    endpoints: list[LlmEndpoint] = []
    warnings: list[str] = []

    for provider in order:
        if provider in ("muse", "meta"):
            key = _muse_api_key(env)
            if not key:
                warnings.append("muse: falta MODEL_API_KEY (o META_API_KEY / MUSE_API_KEY)")
                continue
            base = (env.get("META_BASE_URL") or META_BASE_URL).rstrip("/")
            endpoints.append(
                LlmEndpoint(
                    provider="muse",
                    client=OpenAI(
                        api_key=key,
                        base_url=base,
                        timeout=28.0,
                        max_retries=0,
                    ),
                    models=_muse_models(env),
                )
            )
        elif provider == "groq":
            key = env.get("GROQ_API_KEY") or ""
            if not key:
                warnings.append("groq: falta GROQ_API_KEY")
                continue
            endpoints.append(
                LlmEndpoint(
                    provider="groq",
                    client=OpenAI(
                        api_key=key,
                        base_url=GROQ_BASE_URL,
                        timeout=20.0,
                        max_retries=0,
                    ),
                    models=_groq_models(env),
                )
            )
        elif provider == "deepseek":
            key = env.get("DEEPSEEK_API_KEY") or ""
            if not key:
                warnings.append("deepseek: falta DEEPSEEK_API_KEY")
                continue
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
        elif provider == "ollama":
            base = (env.get("OLLAMA_BASE_URL") or OLLAMA_DEFAULT_BASE).rstrip("/")
            if not _ollama_is_alive(base):
                warnings.append("ollama: no responde (omitido)")
                continue
            endpoints.append(
                LlmEndpoint(
                    provider="ollama",
                    client=OpenAI(
                        api_key=env.get("OLLAMA_API_KEY") or "ollama",
                        base_url=base,
                        timeout=8.0,
                        max_retries=0,
                    ),
                    models=_ollama_models(env),
                )
            )
        elif provider in ("gemini", "google"):
            key = env.get("GEMINI_API_KEY") or ""
            if not key:
                warnings.append("gemini: falta GEMINI_API_KEY")
                continue
            endpoints.append(
                LlmEndpoint(
                    provider="gemini",
                    client=OpenAI(
                        api_key=key,
                        base_url=GEMINI_OPENAI_BASE_URL,
                        timeout=20.0,
                        max_retries=0,
                    ),
                    models=_gemini_models(env),
                )
            )
        else:
            warnings.append(f"proveedor desconocido: {provider}")

    return endpoints, warnings


def get_llm_endpoints() -> list[LlmEndpoint]:
    endpoints, _ = build_llm_endpoints()
    return endpoints


def describe_llm_setup() -> dict:
    endpoints, warnings = build_llm_endpoints()
    return {
        "providers": [
            {"name": ep.provider, "models": list(ep.models)} for ep in endpoints
        ],
        "warnings": warnings,
        "configured": bool(endpoints),
    }


def get_llm_model() -> str:
    endpoints, _ = build_llm_endpoints()
    if endpoints:
        return endpoints[0].models[0]
    env = get_env()
    return env.get("LLM_MODEL") or "llama-3.1-8b-instant"
