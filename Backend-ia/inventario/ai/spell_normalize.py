"""
Normalización ortográfica del chat de inventario.

Combina:
- RapidFuzz / TheFuzz → acercar typos al vocabulario de dominio
- pyspellchecker (es) → faltas generales en español
- Autocorrect (es) → segunda pasada suave

No “lista” millones de faltas: corrige por distancia + diccionario.
"""

from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

# --- dependencias opcionales (si faltan, degradamos sin tumbar el chat) ---
try:
    from rapidfuzz import fuzz as rapid_fuzz
    from rapidfuzz import process as rapid_process

    HAS_RAPID = True
except ImportError:  # pragma: no cover
    HAS_RAPID = False
    rapid_fuzz = None  # type: ignore
    rapid_process = None  # type: ignore

try:
    from thefuzz import fuzz as the_fuzz
    from thefuzz import process as the_process

    HAS_THEFUZZ = True
except ImportError:  # pragma: no cover
    HAS_THEFUZZ = False
    the_fuzz = None  # type: ignore
    the_process = None  # type: ignore

try:
    from spellchecker import SpellChecker

    HAS_PYSPELL = True
except ImportError:  # pragma: no cover
    HAS_PYSPELL = False
    SpellChecker = None  # type: ignore

try:
    from autocorrect import Speller

    HAS_AUTOCORRECT = True
except ImportError:  # pragma: no cover
    HAS_AUTOCORRECT = False
    Speller = None  # type: ignore


# Vocabulario de dominio: verbos/sustantivos del chat (prioridad sobre diccionario genérico).
DOMAIN_VOCAB: tuple[str, ...] = (
    "agrega",
    "agregar",
    "agregala",
    "agregalo",
    "pasa",
    "pasar",
    "pasala",
    "pasalo",
    "pases",
    "copia",
    "copiar",
    "copiala",
    "mete",
    "meter",
    "mueve",
    "mover",
    "traslada",
    "trasladar",
    "traspasa",
    "importa",
    "importar",
    "trae",
    "traer",
    "pon",
    "poner",
    "llena",
    "llenar",
    "dame",
    "muestra",
    "mostrar",
    "ver",
    "lista",
    "listar",
    "busca",
    "buscar",
    "checa",
    "chequea",
    "revisa",
    "compara",
    "comparar",
    "crea",
    "crear",
    "haz",
    "hacer",
    "abre",
    "abrir",
    "genera",
    "generar",
    "sube",
    "subir",
    "carga",
    "cargar",
    "cambia",
    "cambiar",
    "actualiza",
    "actualizar",
    "corrige",
    "corregir",
    "elimina",
    "eliminar",
    "etiqueta",
    "etiquetas",
    "inventario",
    "inventarios",
    "registro",
    "registros",
    "articulo",
    "articulos",
    "area",
    "areas",
    "persona",
    "personas",
    "origen",
    "fuente",
    "duplicadas",
    "duplicados",
    "todo",
    "toda",
    "todas",
    "todos",
    "vacio",
    "vacia",
    "antes",
    "venia",
    "quiero",
    "necesito",
    "esa",
    "ese",
    "eso",
    "esta",
    "este",
    "notifica",
    "notificar",
    "existe",
    "existen",
    "ficha",
    "fichas",
    "omite",
    "omitir",
    "excluye",
    "excluir",
    "salta",
    "saltar",
    "excepto",
    "demas",
)

DOMAIN_SET = set(DOMAIN_VOCAB)

# Palabras funcionales ES: nunca “corregir” (evita que→chequea, los→articulos).
STOPWORDS: frozenset[str] = frozenset(
    {
        "a",
        "al",
        "ante",
        "como",
        "con",
        "contra",
        "de",
        "del",
        "desde",
        "donde",
        "e",
        "el",
        "en",
        "entre",
        "era",
        "es",
        "esa",
        "ese",
        "eso",
        "esta",
        "este",
        "ha",
        "hay",
        "la",
        "las",
        "le",
        "les",
        "lo",
        "los",
        "me",
        "mi",
        "muy",
        "ni",
        "no",
        "o",
        "para",
        "pero",
        "por",
        "que",
        "se",
        "si",
        "sin",
        "sobre",
        "su",
        "sus",
        "te",
        "tu",
        "un",
        "una",
        "uno",
        "y",
        "ya",
        "yo",
        "ok",
        "okey",
        "vale",
        "dale",
    }
)

# Conjugaciones / typos frecuentes → lema de dominio (atajo antes de fuzzy).
DOMAIN_ALIAS: dict[str, str] = {
    "agregues": "agrega",
    "agregue": "agrega",
    "agregame": "agrega",
    "agregamela": "agregala",
    "importaras": "importar",
    "importame": "importa",
    "importalos": "importa",
    "importemos": "importa",
    "pasame": "pasa",
    "pasamelas": "pasa",
    "regsitros": "registros",
    "todosa": "todos",
    "inventari": "inventario",
    "alnventario": "inventario",
    "gsutaria": "quiero",
    "gustaria": "quiero",
    "excisten": "existen",
    "exsisten": "existen",
    "etiwqueta": "etiqueta",
    "etqiueta": "etiqueta",
    "inevtario": "inventario",
    "invetario": "inventario",
    "directamnete": "directamente",
    "omitala": "omite",
    "excluyela": "excluye",
}


def _fold(s: str) -> str:
    text = unicodedata.normalize("NFD", str(s or "").lower())
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return text


@lru_cache(maxsize=1)
def _es_spellchecker():
    if not HAS_PYSPELL:
        return None
    sp = SpellChecker(language="es")
    # Añadir vocabulario de dominio para que no “corrija” inventario→inventario mal.
    sp.word_frequency.load_words(DOMAIN_VOCAB)
    return sp


@lru_cache(maxsize=1)
def _es_autocorrect():
    if not HAS_AUTOCORRECT:
        return None
    return Speller(lang="es")


def _is_protected_token(tok: str) -> bool:
    if not tok:
        return True
    if tok.isdigit():
        return True
    # Códigos de etiqueta: OF-0026, 283586, CF1234…
    if re.fullmatch(r"[a-z]{0,10}[-_/]?\d{2,}", tok):
        return True
    if re.fullmatch(r"\d{4,12}", tok):
        return True
    return False


def _fuzzy_domain(tok: str) -> str | None:
    """RapidFuzz (preferido) o TheFuzz → mejor match de dominio."""
    if tok in STOPWORDS:
        return tok
    if tok in DOMAIN_SET:
        return tok
    if tok in DOMAIN_ALIAS:
        return DOMAIN_ALIAS[tok]
    if len(tok) < 4:
        return None
    # Prefijo de verbo conjugado: agregues→agrega
    for canon in DOMAIN_VOCAB:
        if len(canon) >= 4 and tok.startswith(canon) and len(tok) - len(canon) <= 3:
            return canon

    # Ratio estricto: tokens cortos necesitan score más alto.
    cutoff = 90 if len(tok) <= 5 else 82

    if HAS_RAPID and rapid_process is not None:
        hit = rapid_process.extractOne(
            tok,
            DOMAIN_VOCAB,
            scorer=rapid_fuzz.ratio,
            score_cutoff=cutoff,
        )
        if hit:
            return hit[0]

    if HAS_THEFUZZ and the_process is not None:
        hit = the_process.extractOne(tok, DOMAIN_VOCAB, scorer=the_fuzz.ratio)
        if hit and hit[1] >= cutoff:
            return hit[0]

    return None


def _edit_close(a: str, b: str, max_dist: int) -> bool:
    if a == b:
        return True
    # Distancia rápida con RapidFuzz si existe
    if HAS_RAPID and rapid_fuzz is not None:
        # ratio 100 = igual; aprox dist
        r = rapid_fuzz.ratio(a, b)
        need = 100 - max_dist * (12 if len(a) <= 6 else 8)
        return r >= need
    if len(a) > len(b) + max_dist or len(b) > len(a) + max_dist:
        return False
    # Levenshtein mínimo
    if HAS_THEFUZZ and the_fuzz is not None:
        return the_fuzz.ratio(a, b) >= (100 - max_dist * 12)
    return a[:3] == b[:3]


def _dict_correct(tok: str) -> str:
    """pyspellchecker → Autocorrect (español). Solo si el cambio es cercano."""
    if tok in STOPWORDS or len(tok) < 4:
        return tok

    max_dist = 1 if len(tok) <= 5 else 2

    sp = _es_spellchecker()
    if sp is not None:
        if tok in sp:
            return tok
        cand = sp.correction(tok)
        if cand and cand != tok and _edit_close(tok, cand, max_dist):
            dom = _fuzzy_domain(cand)
            if dom:
                return dom
            if cand not in STOPWORDS:
                return cand

    ac = _es_autocorrect()
    if ac is not None:
        try:
            fixed = ac(tok)
            if (
                fixed
                and isinstance(fixed, str)
                and fixed != tok
                and _edit_close(tok, fixed, max_dist)
            ):
                dom = _fuzzy_domain(fixed)
                return dom or fixed
        except Exception:
            pass
    return tok


def correct_token(tok: str) -> str:
    raw = _fold(tok)
    if _is_protected_token(raw):
        return raw
    if raw in STOPWORDS:
        return raw
    if len(raw) <= 2:
        return raw

    dom = _fuzzy_domain(raw)
    if dom:
        return dom

    return _dict_correct(raw)


def normalize_chat_spelling(text: str) -> dict:
    """
    Corrige typos del mensaje completo.
    Returns: { original, normalized, changed, engines }
    """
    original = str(text or "").strip()
    if not original:
        return {
            "original": original,
            "normalized": original,
            "changed": False,
            "engines": _engines_status(),
        }

    folded = _fold(original)
    # Conservar estructura por tokens alfanuméricos
    parts = re.split(r"([^a-z0-9]+)", folded)
    out: list[str] = []
    for part in parts:
        if not part:
            continue
        if re.fullmatch(r"[a-z0-9]+", part):
            out.append(correct_token(part))
        else:
            out.append(part)
    normalized = "".join(out)
    normalized = re.sub(r"\s+", " ", normalized).strip()

    return {
        "original": original,
        "normalized": normalized,
        "changed": normalized != folded.strip(),
        "engines": _engines_status(),
    }


def _engines_status() -> dict:
    return {
        "rapidfuzz": HAS_RAPID,
        "thefuzz": HAS_THEFUZZ,
        "pyspellchecker": HAS_PYSPELL,
        "autocorrect": HAS_AUTOCORRECT,
    }
