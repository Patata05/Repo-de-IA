"""Agente pydantic-ai + OpenAI con tools reales de Supabase."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

TOOL_AGENT_INSTRUCTIONS = """
Eres el asistente de inventario (español de México). Tono cálido, claro y profesional.

Reglas de verdad:
- NUNCA inventes etiquetas, totales, personas, áreas ni marcas.
- Toda cifra o ficha debe salir de una tool de Supabase. Si la tool no encuentra
  nada, dilo con naturalidad y ofrece otra búsqueda.
- Ortografía: interpreta faltas sin corregir al usuario en voz alta; usa la tool
  con el nombre que entendiste.

Estilo:
- Responde en párrafos naturales y conversacionales (1–3 frases o un párrafo corto).
- Evita viñetas y listas numeradas salvo que el usuario pida explícitamente un listado.
- Si te saludan, saluda con amabilidad y pregunta en qué puedes apoyar hoy.
- Cierra con UNA pregunta breve de seguimiento cuando aporte.
- No uses slang (chido, órale, neta, wey).

Tools (elige la mínima necesaria):
- contar_total / resumen_inventario → totales globales.
- contar_por_campo(campo=persona|area|origen|marca|..., valor=...) →
  “cuántos tiene X” / “etiquetas de Fernanda Vargas” / área concreta.
- buscar_inventario(query, limit) → listados por texto libre.
- obtener_por_etiqueta → ficha exacta.
- listar_recientes → últimos / de hoy.
- buscar_semantico → si la búsqueda léxica falla o piden “como una laptop /
  algo parecido / similar a…”.
- generar_qr → SOLO si piden QR / códigos QR (no para “dame etiquetas”).
  Sin número (“dame sus QR”, “QR de Ricardo”): query=nombre y limit=50
  (todos los que tenga). Solo usa limit=N si el usuario pidió N.

Import Excel / borrados / traspasos masivos: el frontend los maneja. Si no hay
archivo, indica adjuntar Excel/CSV en el chat.
""".strip()

MAX_SIDE_ITEMS = 80


@dataclass
class ToolAgentDeps:
    collected: list[dict[str, Any]] = field(default_factory=list)
    qr: list[dict[str, Any]] = field(default_factory=list)
    mutated: bool = False


def _absorb(deps: ToolAgentDeps, result: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(result, dict):
        return {"ok": False, "error": "resultado inválido"}
    if result.get("mutated"):
        deps.mutated = True
    items = result.get("items")
    if isinstance(items, list):
        for row in items:
            if isinstance(row, dict) and row not in deps.collected:
                deps.collected.append(row)
    qr = result.get("qr")
    if isinstance(qr, list):
        for card in qr:
            if isinstance(card, dict) and card.get("text"):
                deps.qr.append(card)
    out = dict(result)
    if isinstance(out.get("items"), list) and len(out["items"]) > 25:
        out["items"] = out["items"][:25]
        out["items_truncated"] = True
    return out


def _build_agent(api_key: str, model_name: str, base_url: str = ""):
    from pydantic_ai import Agent, RunContext
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    from inventario.ai.tools import run_tool

    provider = OpenAIProvider(
        api_key=api_key,
        base_url=(base_url or "https://api.openai.com/v1").rstrip("/"),
    )
    model = OpenAIChatModel(model_name, provider=provider)
    agent: Agent[ToolAgentDeps, str] = Agent(
        model,
        deps_type=ToolAgentDeps,
        output_type=str,
        instructions=TOOL_AGENT_INSTRUCTIONS,
    )

    @agent.tool
    def buscar_inventario(
        ctx: RunContext[ToolAgentDeps], query: str, limit: int = 15
    ) -> dict[str, Any]:
        """Busca artículos por texto (persona, área, etiqueta, marca, etc.)."""
        return _absorb(
            ctx.deps,
            run_tool(
                "buscar_inventario",
                {"query": query, "limit": max(1, min(50, int(limit or 15)))},
            ),
        )

    @agent.tool
    def resumen_inventario(ctx: RunContext[ToolAgentDeps]) -> dict[str, Any]:
        """Totales exactos del inventario (total, áreas, personas, activos)."""
        return _absorb(ctx.deps, run_tool("resumen_inventario", {}))

    @agent.tool
    def contar_total(ctx: RunContext[ToolAgentDeps]) -> dict[str, Any]:
        """Cuenta el total exacto de artículos."""
        return _absorb(ctx.deps, run_tool("contar_total", {}))

    @agent.tool
    def contar_por_campo(
        ctx: RunContext[ToolAgentDeps], campo: str, valor: str
    ) -> dict[str, Any]:
        """Cuenta y lista por campo (persona, area, origen, marca, etiqueta…)."""
        return _absorb(
            ctx.deps,
            run_tool("contar_por_campo", {"campo": campo, "valor": valor}),
        )

    @agent.tool
    def obtener_por_etiqueta(
        ctx: RunContext[ToolAgentDeps],
        etiqueta: str,
        origen: str | None = None,
    ) -> dict[str, Any]:
        """Obtiene registros exactos por etiqueta (origen opcional)."""
        args: dict[str, Any] = {"etiqueta": etiqueta}
        if origen:
            args["origen"] = origen
        return _absorb(ctx.deps, run_tool("obtener_por_etiqueta", args))

    @agent.tool
    def listar_recientes(
        ctx: RunContext[ToolAgentDeps],
        limit: int = 5,
        solo_hoy: bool = False,
    ) -> dict[str, Any]:
        """Lista los registros más recientes (o solo los de hoy)."""
        return _absorb(
            ctx.deps,
            run_tool(
                "listar_recientes",
                {
                    "limit": max(1, min(20, int(limit or 5))),
                    "solo_hoy": bool(solo_hoy),
                },
            ),
        )

    @agent.tool
    def buscar_semantico(
        ctx: RunContext[ToolAgentDeps], query: str, limit: int = 15
    ) -> dict[str, Any]:
        """Búsqueda por significado (pgvector / fuzzy)."""
        return _absorb(
            ctx.deps,
            run_tool(
                "buscar_semantico",
                {"query": query, "limit": max(1, min(50, int(limit or 15)))},
            ),
        )

    @agent.tool
    def generar_qr(
        ctx: RunContext[ToolAgentDeps],
        etiqueta: str | None = None,
        query: str | None = None,
        limit: int | None = None,
        ultimo: bool = False,
    ) -> dict[str, Any]:
        """Genera QR. Sin N del usuario + query → todos (hasta 50)."""
        args: dict[str, Any] = {"ultimo": bool(ultimo)}
        if etiqueta:
            args["etiqueta"] = etiqueta
        if query:
            args["query"] = query
        if limit is None:
            # Persona/área sin número → total (tope 50). Uno suelto → 5.
            args["limit"] = 50 if query else 5
        else:
            args["limit"] = max(1, min(50, int(limit)))
        return _absorb(ctx.deps, run_tool("generar_qr", args))

    return agent


def run_tool_agent(
    message: str,
    history: list[dict] | None = None,
    memory: str | None = None,
    preferred_model: str | None = None,
) -> tuple[str, str | None, str | None, list[dict], bool, list[dict], dict]:
    """
    reply, error, used_model, items, mutated, qr_list, usage
    """
    from inventario.ai.client import DEFAULT_MODEL, OPENAI_BASE_URL, get_llm_endpoints
    from inventario.ai.usage import empty_usage, usage_from_pydantic_result
    from inventario.supabase_client import get_env

    try:
        endpoints = get_llm_endpoints()
    except Exception as exc:  # noqa: BLE001
        return (
            f"Agente no disponible: {exc}",
            "tool_agent_import",
            None,
            [],
            False,
            [],
            empty_usage(),
        )

    if not endpoints:
        return (
            "No hay proveedores de IA listos. Configura OPENAI_API_KEY.",
            "missing_key",
            None,
            [],
            False,
            [],
            empty_usage(),
        )

    env = get_env()
    ep = endpoints[0]
    api_key = (ep.api_key or env.get("OPENAI_API_KEY") or "").strip()
    if not api_key:
        return (
            "No hay proveedores de IA listos. Configura OPENAI_API_KEY.",
            "missing_key",
            None,
            [],
            False,
            [],
            empty_usage(),
        )

    model_name = (preferred_model or "").strip() or (
        ep.models[0] if ep.models else DEFAULT_MODEL
    )
    base_url = (ep.base_url or env.get("OPENAI_BASE_URL") or OPENAI_BASE_URL).rstrip(
        "/"
    )

    deps = ToolAgentDeps()
    try:
        agent = _build_agent(api_key, model_name, base_url)
    except Exception as exc:  # noqa: BLE001
        logger.exception("tool_agent build failed")
        return (
            f"No pude iniciar el agente: {exc}",
            "tool_agent_build",
            None,
            [],
            False,
            [],
            empty_usage(model=model_name, api_key=api_key),
        )

    hist_bits: list[str] = []
    for item in (history or [])[-8:]:
        role = str(item.get("role") or "").strip().lower()
        text = str(item.get("content") or item.get("text") or "").strip()
        if not text:
            continue
        if len(text) > 400:
            text = text[:399] + "…"
        label = "Asistente" if role in ("assistant", "bot", "model") else "Usuario"
        hist_bits.append(f"{label}: {text}")

    mem = (memory or "").strip()
    if len(mem) > 1200:
        mem = mem[:1199] + "…"

    prompt_parts = []
    if mem:
        prompt_parts.append(f"Memoria de sesión:\n{mem}")
    if hist_bits:
        prompt_parts.append("Hilo reciente:\n" + "\n".join(hist_bits))
    prompt_parts.append(f"Usuario: {(message or '').strip()}")
    prompt = "\n\n".join(prompt_parts)

    try:
        result = agent.run_sync(prompt, deps=deps)
        text = str(result.output or "").strip()
        if not text:
            text = (
                "Consulté el inventario pero no armé una respuesta clara. "
                "¿Me reformulas en una frase (persona, área o etiqueta)?"
            )
        usage = usage_from_pydantic_result(
            result,
            model=model_name,
            api_key=api_key,
            fallback_prompt=prompt,
            fallback_reply=text,
        )
        used = f"pydantic-ai:{model_name}"
        return (
            text,
            None,
            used,
            deps.collected[:MAX_SIDE_ITEMS],
            deps.mutated,
            deps.qr,
            usage,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("tool_agent run failed")
        err = str(exc)
        usage = empty_usage(model=model_name, api_key=api_key)
        if "api" in err.lower() or "timeout" in err.lower() or "connect" in err.lower():
            return (
                "OpenAI no respondió. Reintento en unos segundos…",
                "llm_unavailable",
                f"pydantic-ai:{model_name}",
                deps.collected[:MAX_SIDE_ITEMS],
                deps.mutated,
                deps.qr,
                usage,
            )
        return (
            f"Error al consultar la IA: {exc}",
            str(exc),
            f"pydantic-ai:{model_name}",
            deps.collected[:MAX_SIDE_ITEMS],
            deps.mutated,
            deps.qr,
            usage,
        )
