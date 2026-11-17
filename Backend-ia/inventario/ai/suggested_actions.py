"""Acciones sugeridas (chips) a partir de la respuesta + items del turno."""

from __future__ import annotations

import re
import unicodedata
from typing import Any


def _fold(raw: str) -> str:
    s = unicodedata.normalize("NFD", str(raw or "").lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", s).strip()


def _is_chitchat(reply: str, user_message: str = "") -> bool:
    text = _fold(f"{user_message} {reply}")
    if not text:
        return True
    if re.search(
        r"\b(hola|buenas|buen dia|buen dia|hey|hi|hello|adios|hasta luego|"
        r"nos vemos|gracias|de nada|okey|ok|vale)\b",
        text,
    ) and not re.search(
        r"\b(\d{4,}|etiqueta|persona|area|inventario|excel|mantenimiento|"
        r"inactivo|activo|registro|proyector|laptop|monitor)\b",
        text,
    ):
        return True
    # Saludo/despedida cortos sin datos consultables.
    if len(text.split()) <= 12 and re.match(
        r"^(hola|buenas|hey|gracias|adios|hasta luego|en que te puedo|con gusto)\b",
        text,
    ):
        return True
    return False


def _first_etiqueta(reply: str, items: list[dict[str, Any]]) -> str | None:
    bold = re.findall(r"\*\*([A-Za-z0-9][A-Za-z0-9/_-]{2,20})\*\*", reply or "")
    for tok in bold:
        if re.fullmatch(r"\d{4,12}", tok) or re.fullmatch(
            r"[A-Za-z]{1,6}[-_]?\d{2,10}", tok
        ):
            return tok
    m = re.search(r"\betiqueta\s+(\d{4,12})\b", _fold(reply))
    if m:
        return m.group(1)
    m = re.search(r"\b(\d{5,12})\b", reply or "")
    if m:
        return m.group(1)
    for it in items:
        et = str(it.get("etiqueta") or "").strip()
        if et:
            return et
    return None


def _majority_field(items: list[dict[str, Any]], field: str) -> str | None:
    counts: dict[str, int] = {}
    for it in items:
        v = str(it.get(field) or "").strip()
        if not v:
            continue
        counts[v] = counts.get(v, 0) + 1
    if not counts:
        return None
    return max(counts.items(), key=lambda kv: kv[1])[0]


def _looks_like_person_name(raw: str) -> bool:
    t = str(raw or "").strip()
    if not t or re.search(r"\d", t):
        return False
    folded = _fold(t)
    if folded.startswith(("inventario ", "excel ", "csv ", "xls ", "xlsx ")):
        return False
    if folded in {
        "activo",
        "inactivo",
        "mantenimiento",
        "proyector",
        "laptop",
        "monitor",
        "atencion a clientes",
    }:
        return False
    words = t.split()
    if not (2 <= len(words) <= 5):
        return False
    return any(c.isupper() for c in t)


def _persona_from_reply(reply: str, items: list[dict[str, Any]]) -> str | None:
    from_items = _majority_field(items, "persona")
    # **Ana Sofía Ramírez**
    for tok in re.findall(r"\*\*([^*]{4,60})\*\*", reply or ""):
        t = tok.strip()
        if _looks_like_person_name(t):
            return t
    # “asignado a X” / Inventario <Nombre>
    m = re.search(
        r"(?:asignad[oa]\s+a|persona|tiene)\s+\*{0,2}([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+){1,4})\*{0,2}",
        reply or "",
    )
    if m and _looks_like_person_name(m.group(1)):
        return m.group(1).strip()
    m = re.search(
        r"(?:inventario|excel)\s+\*{0,2}([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑa-záéíóúñ]+){1,4})\*{0,2}",
        reply or "",
        flags=re.I,
    )
    if m and _looks_like_person_name(m.group(1)):
        return m.group(1).strip()
    return from_items


def _estado_cue(reply: str, items: list[dict[str, Any]]) -> str | None:
    folded = _fold(reply)
    for key in ("mantenimiento", "inactivo", "baja", "activo"):
        if re.search(rf"\b{key}\b", folded):
            return key
    est = _majority_field(items, "estado")
    if not est:
        return None
    f = _fold(est)
    if "manten" in f:
        return "mantenimiento"
    if "inactiv" in f or f in {"baja", "bajas"}:
        return "inactivo"
    if "activ" in f:
        return "activo"
    return None


def _area_from_context(reply: str, items: list[dict[str, Any]]) -> str | None:
    m = re.search(
        r"(?:area|área)\s+(?:de\s+)?\*{0,2}([A-ZÁÉÍÓÚÑ][^*\n]{2,40})\*{0,2}",
        reply or "",
        flags=re.I,
    )
    if m:
        return m.group(1).strip(" .")
    return _majority_field(items, "area")


def build_acciones_sugeridas(
    reply: str,
    items: list[dict[str, Any]] | None = None,
    user_message: str = "",
    contexto_vista: dict[str, Any] | None = None,
) -> list[dict[str, str]]:
    """
    Devuelve 0–3 objetos {etiqueta, prompt_accion} según datos del turno.
    """
    items = [it for it in (items or []) if isinstance(it, dict)]
    text = str(reply or "").strip()
    if not text:
        return []
    if _is_chitchat(text, user_message):
        return []

    # Subir/importar Excel (sin export explícito) → sin chips de descarga.
    um = _fold(str(user_message or ""))
    if (
        re.search(r"\b(import\w*|subir\w*|subo|cargar\w*|adjunt\w*)\b", um)
        and re.search(r"\b(excel|csv|archivo|xlsx|xls)\b", um)
        and not re.search(r"\b(exportar|descargar|bajar)\b", um)
    ):
        return []

    # Comparación de inventarios → chips de seguimiento (sin listar etiquetas).
    ctx_tipo = ""
    if isinstance(contexto_vista, dict):
        ctx_tipo = str(contexto_vista.get("tipo") or "").strip().lower()
    if ctx_tipo == "comparacion" or re.search(
        r"\b(compara\w*|diff|diferencia|diferencias)\b", um
    ):
        origs: list[str] = []
        if isinstance(contexto_vista, dict):
            comp = contexto_vista.get("comparacion")
            if isinstance(comp, dict) and isinstance(comp.get("origenes"), list):
                origs = [str(o).strip() for o in comp["origenes"] if str(o or "").strip()]
        left = origs[0] if len(origs) >= 1 else ""
        right = origs[1] if len(origs) >= 2 else ""
        actions_cmp: list[dict[str, str]] = []
        if left and right:
            actions_cmp.append(
                {
                    "etiqueta": f"Faltantes de {left}",
                    "prompt_accion": f"muestra las etiquetas que faltan en {right} respecto a {left}",
                }
            )
            actions_cmp.append(
                {
                    "etiqueta": f"Trasladar a {right}",
                    "prompt_accion": f"traslada a {right} las etiquetas que faltan desde {left}",
                }
            )
        actions_cmp.append(
            {
                "etiqueta": "Revisar otros inventarios",
                "prompt_accion": "compara todos los inventarios",
            }
        )
        return actions_cmp[:3]

    # Ranking global de áreas → no chips de un área puntual (Sistemas y TI…).
    if re.search(
        r"\b(areas?\s+en\s+general|ranking\s+(de\s+)?areas?|"
        r"(todas|todos)\s+(las?\s+)?areas?|por\s+areas?|"
        r"(que|cuales|cuantas)\s+areas\s+(hay|existen))\b",
        um,
    ) or (re.search(r"\bareas?\b", um) and re.search(r"\b(general|ranking|distribucion)\b", um)):
        return [
            {"etiqueta": "Personas", "prompt_accion": "dame el ranking de personas"},
            {
                "etiqueta": "Totales",
                "prompt_accion": "dame el resumen del inventario",
            },
            {"etiqueta": "Últimos registros", "prompt_accion": "últimos registros"},
        ]

    actions: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(label: str, prompt: str) -> None:
        lab = str(label or "").strip()
        pr = str(prompt or "").strip()
        if not lab or not pr or pr in seen or len(actions) >= 3:
            return
        seen.add(pr)
        actions.append({"etiqueta": lab[:48], "prompt_accion": pr[:160]})

    etq = _first_etiqueta(text, items)
    persona = _persona_from_reply(text, items)
    estado = _estado_cue(text, items)
    area = _area_from_context(text, items)
    n_items = len(items)

    # 1) Etiqueta concreta
    if etq and (n_items <= 3 or re.search(rf"\b{re.escape(etq)}\b", text)):
        add(f"Exportar etiqueta {etq}", f"exporta a excel solo la etiqueta {etq}")
        add(f"Generar QR de {etq}", f"genera el código QR de la etiqueta {etq}")
        if estado in {"mantenimiento", "inactivo", "baja"}:
            add("Cambiar estado a Activo", f"cambia el estado de {etq} a Activo")
        elif estado == "activo" and len(actions) < 3:
            add("Reasignar equipo", f"reasigna la etiqueta {etq} a otra persona")
        return actions[:3]

    # 2) Persona con varios equipos
    if persona and n_items >= 2:
        short = " ".join(persona.split()[:2])
        add(f"Exportar lista de {short}", f"exporta {persona} a excel")
        add("Ver desglose por área", f"en qué áreas está {persona}")
        add(f"Generar QR de {short}", f"genera QR de {persona}")
        return actions[:3]

    if persona and n_items == 1:
        short = " ".join(persona.split()[:2])
        add(f"Exportar de {short}", f"exporta {persona} a excel")
        add(f"Generar QR", f"genera QR de {persona}")
        if etq:
            add(f"QR de {etq}", f"genera el código QR de la etiqueta {etq}")
        return actions[:3]

    # 3) Estado sin etiqueta clara
    if estado in {"mantenimiento", "inactivo", "baja"}:
        add("Cambiar estado a Activo", "cambia el estado de estos a Activo")
        add("Reasignar equipo", "reasigna estos equipos a otra persona")
        add("Exportar Excel", "exporta estos registros a excel")
        return actions[:3]

    # 4) Área
    if area and n_items >= 1:
        add(f"Exportar {area}", f"exporta {area} a excel")
        add("Personas del área", f"quiénes hay en {area}")
        add("Generar QR", f"genera QR de {area}")
        return actions[:3]

    # 5) Listado genérico con items
    if n_items >= 1:
        add("Exportar Excel", "exporta estos registros a excel")
        add("Generar QR", "genera códigos QR de estos registros")
        add("Últimos registros", "últimos registros")
        return actions[:3]

    return []
