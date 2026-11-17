import json
import logging
import re
import time
import unicodedata
from pathlib import Path
from urllib.parse import quote

from dotenv import load_dotenv
import httpx
import os

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parents[1]
DB_ENV_PATH = BASE_DIR.parent / "Database" / ".env.local"
BACKEND_ENV_PATH = BASE_DIR / ".env"

_CACHE: dict[str, object] = {"rows": None, "at": 0.0, "used": None, "error": None}
_CACHE_TTL_SEC = 60.0
_PAGE_SIZE = 1000

# Columnas ligeras (sin embedding / vectores) para lecturas de chat e inventario.
INVENTARIO_LIGHT_SELECT = (
    "id,etiqueta,articulo,marca,modelo,serie,area,persona,"
    "cantidad,observaciones,estado,origen,created_at,updated_at"
)

# Cliente HTTP keep-alive reutilizado (evita SSL handshake por petición).
_HTTP: httpx.Client | None = None


def get_http_client() -> httpx.Client:
    global _HTTP
    if _HTTP is None or _HTTP.is_closed:
        _HTTP = httpx.Client(
            timeout=httpx.Timeout(30.0, connect=10.0),
            limits=httpx.Limits(max_keepalive_connections=20, max_connections=40),
            http2=False,
        )
    return _HTTP

WRITABLE_FIELDS = frozenset(
    {
        "etiqueta",
        "articulo",
        "marca",
        "modelo",
        "serie",
        "area",
        "persona",
        "cantidad",
        "observaciones",
        "estado",
        "origen",
    }
)


def _load_env() -> dict[str, str]:
    load_dotenv(BACKEND_ENV_PATH, override=False)
    load_dotenv(DB_ENV_PATH, override=False)
    keys = (
        "NEXT_PUBLIC_SUPABASE_URL",
        "SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        "SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_SECRET_KEY",
        "LLM_MODEL",
        "LLM_PROVIDERS",
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_MODEL",
        "DEEPSEEK_BASE_URL",
        "N8N_INVENTARIO_URL",
        "N8N_INVENTARIO_KEY",
        "OPENAI_API_KEY",
        "OPENAI_MODEL",
        "OPENAI_BASE_URL",
        "EMBEDDING_API_KEY",
        "EMBEDDING_BASE_URL",
        "EMBEDDING_MODEL",
    )
    values: dict[str, str] = {}
    for key in keys:
        val = os.getenv(key, "").strip()
        if val:
            values[key] = val
    if DB_ENV_PATH.exists():
        for line in DB_ENV_PATH.read_text(encoding="utf-8").splitlines():
            trimmed = line.strip()
            if not trimmed or trimmed.startswith("#") or "=" not in trimmed:
                continue
            k, v = trimmed.split("=", 1)
            k, v = k.strip(), v.strip()
            if k and v and k not in values:
                values[k] = v
    if BACKEND_ENV_PATH.exists():
        for line in BACKEND_ENV_PATH.read_text(encoding="utf-8").splitlines():
            trimmed = line.strip()
            if not trimmed or trimmed.startswith("#") or "=" not in trimmed:
                continue
            k, v = trimmed.split("=", 1)
            k, v = k.strip(), v.strip()
            if k and v:
                values[k] = v
    return values


def get_env() -> dict[str, str]:
    return _load_env()


def _supabase_base_and_keys(env: dict[str, str]) -> tuple[str, list[tuple[str, str, bool]]]:
    base = (env.get("NEXT_PUBLIC_SUPABASE_URL") or env.get("SUPABASE_URL") or "").rstrip("/")
    attempts: list[tuple[str, str, bool]] = []
    service = env.get("SUPABASE_SERVICE_ROLE_KEY") or env.get("SUPABASE_SECRET_KEY") or ""
    if service:
        attempts.append(("service", service, True))
    publishable = env.get("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY") or ""
    if publishable:
        attempts.append(("publishable", publishable, False))
    anon = env.get("SUPABASE_ANON_KEY") or env.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") or ""
    if anon:
        attempts.append(("anon", anon, True))
    return base, attempts


def _request_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    body: dict | list | None = None,
    timeout: int = 30,
) -> tuple[object | None, str | None, dict[str, str]]:
    req_headers = dict(headers)
    json_body = None
    if body is not None:
        json_body = body
        req_headers["Content-Type"] = "application/json"
        req_headers.setdefault("Prefer", "return=representation")
    client = get_http_client()
    try:
        response = client.request(
            method.upper(),
            url,
            headers=req_headers,
            json=json_body,
            timeout=timeout,
        )
        resp_headers = {k.lower(): v for k, v in response.headers.items()}
        raw = response.content.decode("utf-8", errors="replace") if response.content else ""
        # PostgREST: 206 Partial Content / rangos OK con body
        if response.status_code in (200, 201, 204, 206):
            if not raw or response.status_code == 204:
                return None, None, resp_headers
            try:
                return json.loads(raw), None, resp_headers
            except json.JSONDecodeError:
                return None, raw[:500] or "JSON inválido", resp_headers
        if response.status_code == 416 and raw:
            try:
                return json.loads(raw), None, resp_headers
            except json.JSONDecodeError:
                pass
        return None, raw or f"HTTP {response.status_code}", resp_headers
    except httpx.TimeoutException as error:
        return None, f"timeout: {error}", {}
    except httpx.HTTPError as error:
        return None, str(error), {}


def _with_key(base: str, path_qs: str, key_name: str, key: str, send_bearer: bool):
    headers = {"apikey": key, "Accept": "application/json"}
    if send_bearer:
        headers["Authorization"] = f"Bearer {key}"
    url = f"{base}/rest/v1/{path_qs.lstrip('/')}"
    return url, headers, key_name


def invalidate_inventario_cache() -> None:
    _CACHE["rows"] = None
    _CACHE["at"] = 0.0
    _CACHE["used"] = None
    _CACHE["error"] = None


def _parse_total_from_content_range(content_range: str | None) -> int | None:
    if not content_range:
        return None
    # formats: "0-999/2028" or "*/2028"
    if "/" not in content_range:
        return None
    total = content_range.rsplit("/", 1)[-1].strip()
    if total == "*":
        return None
    try:
        return int(total)
    except ValueError:
        return None


def count_inventario(filters_qs: str = "") -> tuple[int | None, str | None]:
    """Conteo exacto vía PostgREST (sin traer todas las filas)."""
    env = get_env()
    base, attempts = _supabase_base_and_keys(env)
    if not base or not attempts:
        return None, "Supabase no configurado."

    qs = "inventario?select=id"
    if filters_qs:
        qs = f"{qs}&{filters_qs.lstrip('&')}"

    last_error = "No se pudo contar"
    for name, key, send_bearer in attempts:
        url, headers, _ = _with_key(base, qs, name, key, send_bearer)
        headers["Prefer"] = "count=exact"
        headers["Range"] = "0-0"
        payload, error, resp_headers = _request_json("GET", url, headers=headers)
        if error and "JWT" not in error and "401" not in error and "403" not in error:
            last_error = error
            continue
        if error:
            last_error = error
            continue
        total = _parse_total_from_content_range(resp_headers.get("content-range"))
        if total is not None:
            return total, None
        if isinstance(payload, list):
            return len(payload), None
        last_error = "Sin Content-Range en la respuesta"
    return None, last_error


def _fold_field(raw: str) -> str:
    """Normaliza nombre de columna (área→area) al esquema real sin acentos."""
    s = unicodedata.normalize("NFD", str(raw or "").strip().lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    aliases = {
        "areas": "area",
        "personas": "persona",
        "articulos": "articulo",
        "etiquetas": "etiqueta",
        "origenes": "origen",
        "marcas": "marca",
        "modelos": "modelo",
        "estados": "estado",
    }
    return aliases.get(s, s)


def _fold_text(raw: str) -> str:
    s = unicodedata.normalize("NFD", str(raw or "").strip().lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


# Abreviaturas → nombre canónico (se resuelve contra catálogo real).
_AREA_ALIASES: dict[str, tuple[str, ...]] = {
    "ti": ("sistemas y ti", "sistemas", "tecnologia", "tecnologias"),
    "it": ("sistemas y ti", "sistemas"),
    "sistemas": ("sistemas y ti", "sistemas"),
    "tic": ("sistemas y ti", "sistemas"),
    "tics": ("sistemas y ti", "sistemas"),
    "rh": ("recursos humanos",),
    "rrhh": ("recursos humanos",),
    "hr": ("recursos humanos",),
    "recursos": ("recursos humanos",),
    "humanos": ("recursos humanos",),
    "contabilidad": ("contabilidad y finanzas",),
    "finanzas": ("contabilidad y finanzas",),
    "cont": ("contabilidad y finanzas",),
    "compras": ("compras y logistica",),
    "logistica": ("compras y logistica",),
    "marketing": ("marketing",),
    "ventas": ("ventas y comercial",),
    "comercial": ("ventas y comercial",),
    "legal": ("legal y cumplimiento",),
    "operaciones": ("operaciones",),
    "clientes": ("atencion a clientes",),
    "direccion": ("direccion general",),
}


def catalogo_areas(rows: list[dict] | None = None) -> list[str]:
    if rows is None:
        rows, error, _ = read_inventario()
        if error or not rows:
            return []
    return sorted(
        {
            str(r.get("area") or "").strip()
            for r in rows
            if str(r.get("area") or "").strip()
        },
        key=str.casefold,
    )


def resolve_area_label(
    needle: str, rows: list[dict] | None = None
) -> str | None:
    """
    Normaliza 'ti' / 'sistemas' / typo → nombre exacto en columna area
    (ej. 'Sistemas y TI'). None si no hay match seguro.
    """
    want = _fold_text(needle)
    if not want:
        return None
    # “en general” / “general” / typo “ne general” → inventario global,
    # NUNCA fuzzy con “Dirección General” (salvo que digan “dirección…”).
    if "direccion" not in want and (
        want in {"general", "en general", "ne general"}
        or re.fullmatch(r"(en|ne)\s+general", want)
        or re.search(r"(^|\s)(en|ne)\s+general(\s|$)", want)
        or want == "general"
    ):
        return None
    if rows is None:
        rows, error, _ = read_inventario()
        if error or not rows:
            return None
    catalog = catalogo_areas(rows)
    if not catalog:
        return None

    # 1) Igualdad exacta (fold)
    for label in catalog:
        if _fold_text(label) == want:
            return label

    # 2) Alias conocidos → mejor match en catálogo
    alias_targets = _AREA_ALIASES.get(want)
    if alias_targets:
        for target in alias_targets:
            for label in catalog:
                folded = _fold_text(label)
                if folded == target or target in folded.split():
                    return label
            for label in catalog:
                if target in _fold_text(label):
                    return label

    # 3) Token completo (palabra entera), no substring: 'ti' ∈ tokens de
    #    'sistemas y ti', pero NO dentro de 'marketing'.
    want_tokens = [t for t in want.split() if t]
    if len(want_tokens) == 1 and len(want_tokens[0]) <= 3:
        tok = want_tokens[0]
        hits = [
            label
            for label in catalog
            if tok in _fold_text(label).split()
        ]
        if len(hits) == 1:
            return hits[0]
        # Acrónimo: 'rh' ← 'recursos humanos'
        acro_hits = []
        for label in catalog:
            parts = [
                p
                for p in _fold_text(label).split()
                if p not in {"y", "de", "del", "la", "el", "a", "al"}
            ]
            acro = "".join(p[0] for p in parts if p)
            if acro == tok or (len(tok) >= 2 and acro.startswith(tok)):
                acro_hits.append(label)
        if len(acro_hits) == 1:
            return acro_hits[0]
        return None

    # 4) Todos los tokens del needle son palabras del área
    hits = []
    for label in catalog:
        parts = set(_fold_text(label).split())
        if want_tokens and all(t in parts for t in want_tokens):
            hits.append(label)
    if len(hits) == 1:
        return hits[0]

    # 5) Contiene la frase completa como substring solo si needle es largo
    if len(want) >= 5:
        hits = [label for label in catalog if want in _fold_text(label)]
        if len(hits) == 1:
            return hits[0]

    return None


def _postgrest_ilike_exact(campo: str, valor: str) -> str:
    """ilike exacto (sin %): area=ilike.Sistemas%20y%20TI"""
    safe = (
        valor.strip()
        .replace(",", " ")
        .replace(")", " ")
        .replace("(", " ")
        .replace("*", " ")
    )
    return f"{campo}=ilike.{quote(safe, safe='')}"


def _postgrest_ilike_filter(campo: str, valor: str) -> str:
    """
    Contiene (otros campos). Para area usar resolve + _postgrest_ilike_exact.
    """
    safe = (
        valor.strip()
        .replace(",", " ")
        .replace(")", " ")
        .replace("(", " ")
        .replace("*", " ")
    )
    return f"{campo}=ilike.*{quote(safe, safe='')}*"


def _field_matches(campo: str, blob: str, needle: str) -> bool:
    """Match seguro: área = igualdad exacta; otros = tokens/contiene."""
    if not blob or not needle:
        return False
    if campo == "area":
        return blob == needle
    tokens = [t for t in needle.split() if len(t) > 1] or [needle]
    if needle in blob or all(t in blob for t in tokens):
        return True
    # Token boundary para agujas cortas (evita 'ti' ⊂ 'marketing')
    if len(needle) <= 3 and " " not in needle:
        return needle in blob.split()
    return False


def count_por_campo(campo: str, valor: str) -> tuple[int | None, str | None]:
    """Cuenta filas por campo. Área: canónica + match exacto (sin %ti%)."""
    campo = _fold_field(campo)
    if campo not in WRITABLE_FIELDS and campo != "id":
        return None, f"Campo no permitido: {campo}"
    valor = str(valor or "").strip()
    if not valor:
        return None, "Falta el valor a buscar"
    try:
        rows_cache, _, _ = read_inventario()
        if campo == "area":
            resolved = resolve_area_label(valor, rows_cache)
            if not resolved:
                # Sin área canónica: no usar %parcial%; contar 0 vía list.
                rows, list_err = list_por_campo(campo, valor, limit=50_000)
                if list_err:
                    return None, list_err
                return len(rows), None
            valor = resolved
            total, error = count_inventario(_postgrest_ilike_exact(campo, valor))
        else:
            total, error = count_inventario(_postgrest_ilike_filter(campo, valor))
        if error:
            logger.warning(
                "count_por_campo PostgREST falló (%s=%r): %s — fallback caché",
                campo,
                valor,
                error,
            )
            rows, list_err = list_por_campo(campo, valor, limit=50_000)
            if list_err:
                return None, list_err
            return len(rows), None
        return total, None
    except Exception as exc:  # noqa: BLE001
        logger.exception("count_por_campo excepción (%s=%r)", campo, valor)
        print(f"[inventario] count_por_campo error: {exc!r} campo={campo} valor={valor!r}")
        return None, str(exc)


def list_por_campo(
    campo: str, valor: str, limit: int = 20
) -> tuple[list[dict], str | None]:
    """Lista por campo. Área: resolve canónico + igualdad exacta en columna area."""
    campo = _fold_field(campo)
    if campo not in WRITABLE_FIELDS and campo != "id":
        return [], f"Campo no permitido: {campo}"
    raw_valor = str(valor or "").strip()
    if not raw_valor:
        return [], "Falta el valor a buscar"
    try:
        rows, error, _ = read_inventario()
        if error:
            logger.warning("list_por_campo read_inventario: %s", error)
            return [], error

        if campo == "area":
            resolved = resolve_area_label(raw_valor, rows)
            if not resolved:
                print(
                    f"[inventario] list_por_campo área sin match seguro: {raw_valor!r}"
                )
                return [], None
            needle = _fold_text(resolved)
            print(
                f"[inventario] área {raw_valor!r} → canónica {resolved!r}"
            )
        else:
            resolved = None
            needle = _fold_text(raw_valor)

        requested = max(1, int(limit or 20))
        cap = min(requested, 50_000)
        matched: list[dict] = []
        for row in rows:
            blob = _fold_text(str(row.get(campo) or ""))
            if not _field_matches(campo, blob, needle):
                continue
            # Doble check área: valor canónico exacto
            if campo == "area" and resolved:
                if str(row.get("area") or "").strip() != resolved and _fold_text(
                    str(row.get("area") or "")
                ) != needle:
                    continue
            matched.append(row)
        if matched:
            return dedupe_by_etiqueta(matched, cap), None

        # Fuzzy solo fuera de área (o área con needle largo ya resuelto falló)
        if campo == "area":
            return [], None
        scored: list[tuple[float, dict]] = []
        for row in rows:
            blob = _fold_text(str(row.get(campo) or ""))
            if not blob:
                continue
            ratio = _fuzzy_ratio(needle, blob)
            if ratio >= 78:
                scored.append((ratio, row))
        scored.sort(key=lambda x: x[0], reverse=True)
        return dedupe_by_etiqueta([r for _, r in scored], cap), None
    except Exception as exc:  # noqa: BLE001
        logger.exception("list_por_campo excepción (%s=%r)", campo, valor)
        print(f"[inventario] list_por_campo error: {exc!r} campo={campo} valor={valor!r}")
        return [], str(exc)


def read_inventario(force: bool = False) -> tuple[list[dict], str | None, str | None]:
    now = time.monotonic()
    cached_rows = _CACHE.get("rows")
    if (
        not force
        and isinstance(cached_rows, list)
        and now - float(_CACHE.get("at") or 0) < _CACHE_TTL_SEC
    ):
        return cached_rows, None, str(_CACHE.get("used") or "")

    env = get_env()
    base, attempts = _supabase_base_and_keys(env)
    if not base:
        return [], "Falta la URL de Supabase en Backend-ia/.env o Database/.env.local", None
    if not attempts:
        return [], "No hay llaves de Supabase configuradas", None

    last_error = "No se pudo leer inventario"
    used_name: str | None = None
    for name, key, send_bearer in attempts:
        used_name = name
        rows: list[dict] = []
        page_error: str | None = None
        for from_idx in range(0, 50_000, _PAGE_SIZE):
            to_idx = from_idx + _PAGE_SIZE - 1
            url, headers, _ = _with_key(
                base,
                f"inventario?select={INVENTARIO_LIGHT_SELECT}&order=id.asc",
                name,
                key,
                send_bearer,
            )
            headers["Range"] = f"{from_idx}-{to_idx}"
            payload, error, _resp = _request_json("GET", url, headers=headers)
            if error:
                page_error = error
                break
            chunk = payload if isinstance(payload, list) else []
            rows.extend(chunk)
            if len(chunk) < _PAGE_SIZE:
                break
        if page_error:
            last_error = page_error
            if "JWT" in page_error or "401" in page_error or "403" in page_error:
                continue
            _CACHE.update({"rows": None, "at": now, "used": name, "error": last_error})
            return [], last_error, name
        _CACHE.update({"rows": rows, "at": now, "used": name, "error": None})
        return rows, None, name

    return [], last_error, used_name


def get_by_id(row_id: int) -> tuple[dict | None, str | None]:
    env = get_env()
    base, attempts = _supabase_base_and_keys(env)
    if not base or not attempts:
        return None, "Supabase no configurado."

    path_qs = (
        f"inventario?id=eq.{int(row_id)}&select={INVENTARIO_LIGHT_SELECT}&limit=1"
    )
    last_error = "No se encontró el registro"
    for name, key, send_bearer in attempts:
        url, headers, _ = _with_key(base, path_qs, name, key, send_bearer)
        payload, error, _resp = _request_json("GET", url, headers=headers)
        if error:
            last_error = error
            continue
        if isinstance(payload, list) and payload:
            return payload[0], None
        return None, "No existe un artículo con ese id."
    return None, last_error


def dedupe_by_etiqueta(
    rows: list[dict], limit: int | None = None
) -> list[dict]:
    """Una sola fila por etiqueta (lower). Sin rellenar ni repetir."""
    seen: set[str] = set()
    out: list[dict] = []
    for row in rows:
        etq = str(row.get("etiqueta") or "").strip().lower()
        if etq:
            if etq in seen:
                continue
            seen.add(etq)
        out.append(row)
        if limit is not None and len(out) >= max(0, int(limit)):
            break
    return out


def get_by_etiqueta(etiqueta: str, origen: str | None = None) -> tuple[list[dict], str | None]:
    rows, error, _ = read_inventario()
    if error:
        return [], error
    needle = etiqueta.strip().lower()
    matches = []
    for row in rows:
        if str(row.get("etiqueta") or "").strip().lower() != needle:
            continue
        if origen and str(row.get("origen") or "").strip().lower() != origen.strip().lower():
            continue
        matches.append(row)
    # Misma etiqueta en varios orígenes → una sola ficha (la primera).
    return dedupe_by_etiqueta(matches), None


def listar_recientes(
    limit: int = 5,
    solo_hoy: bool = False,
) -> tuple[list[dict], str | None]:
    """Últimos registros por created_at / id (sin cargar todo el inventario)."""
    from datetime import datetime, timezone

    env = get_env()
    base, attempts = _supabase_base_and_keys(env)
    if not base or not attempts:
        return [], "Supabase no configurado."

    n = max(1, min(int(limit or 5), 50))
    filters = [
        f"select={INVENTARIO_LIGHT_SELECT}",
        "order=created_at.desc,id.desc",
        f"limit={n}",
    ]
    if solo_hoy:
        today = datetime.now(timezone.utc).date().isoformat()
        filters.append(f"created_at=gte.{today}T00:00:00")

    path_qs = "inventario?" + "&".join(filters)
    last_error = "No se pudieron leer registros recientes"
    for name, key, send_bearer in attempts:
        url, headers, _ = _with_key(base, path_qs, name, key, send_bearer)
        payload, error, _resp = _request_json("GET", url, headers=headers)
        if error:
            last_error = error
            continue
        if isinstance(payload, list):
            return dedupe_by_etiqueta(payload, n), None
        return [], "Respuesta inesperada de Supabase"
    return [], last_error


def _fuzzy_ratio(a: str, b: str) -> float:
    """rapidfuzz solo dentro de la consulta (no reescribe el prompt del chat)."""
    if not a or not b:
        return 0.0
    try:
        from rapidfuzz import fuzz

        return float(fuzz.partial_ratio(a, b))
    except Exception:  # noqa: BLE001
        return 100.0 if a in b or b in a else 0.0


def search_inventario(query: str, limit: int = 20) -> tuple[list[dict], str | None]:
    rows, error, _ = read_inventario()
    if error:
        return [], error
    q = (query or "").strip().lower()
    tokens = [t for t in q.split() if len(t) > 1]
    cap = max(1, min(int(limit or 20), 2000))
    if not tokens:
        return dedupe_by_etiqueta(rows, cap), None

    scored: list[tuple[float, dict]] = []
    for row in rows:
        persona = str(row.get("persona") or "").lower()
        area = str(row.get("area") or "").lower()
        articulo = str(row.get("articulo") or "").lower()
        etiqueta = str(row.get("etiqueta") or "").lower()
        marca = str(row.get("marca") or "").lower()
        blob_parts = [
            etiqueta,
            articulo,
            marca,
            str(row.get("modelo") or "").lower(),
            str(row.get("serie") or "").lower(),
            area,
            persona,
            str(row.get("origen") or "").lower(),
            str(row.get("estado") or "").lower(),
            str(row.get("observaciones") or "").lower(),
        ]
        blob = " ".join(blob_parts)
        score = 0.0
        for t in tokens:
            if t == etiqueta:
                score += 15
            elif t in etiqueta:
                score += 8
            if t in persona:
                score += 8
            if t in articulo:
                score += 6
            if t in area:
                score += 5
            if t in blob:
                score += 2
        # Coincidencia difusa contra campos reales (persona/área/artículo/marca).
        for field_val, weight in (
            (persona, 10.0),
            (area, 8.0),
            (articulo, 7.0),
            (marca, 6.0),
        ):
            if not field_val:
                continue
            ratio = _fuzzy_ratio(q, field_val)
            if ratio >= 78:
                score += weight * (ratio / 100.0)
        if score > 0:
            scored.append((score, row))
    scored.sort(key=lambda x: x[0], reverse=True)
    # Pedir más candidatos y deduplicar hasta `cap` etiquetas únicas.
    raw = [r for _, r in scored[: max(cap * 4, cap)]]
    return dedupe_by_etiqueta(raw, cap), None


def resumen_inventario() -> tuple[dict, str | None]:
    total, count_error = count_inventario()
    rows, error, _ = read_inventario()
    if error and total is None:
        return {}, error or count_error
    if error:
        # al menos devolver total exacto si el conteo funcionó
        return {
            "total": total,
            "personas": None,
            "areas": None,
            "activos_aprox": None,
            "inactivos_aprox": None,
            "con_observaciones": None,
            "nota": f"Total exacto OK; detalle parcial: {error}",
        }, None
    personas = {str(r.get("persona")).strip() for r in rows if r.get("persona")}
    areas = {str(r.get("area")).strip() for r in rows if r.get("area")}
    activos = sum(
        1
        for r in rows
        if str(r.get("estado") or "").lower() in ("", "activo", "si", "sí", "yes")
    )
    inactivos = len(rows) - activos
    con_obs = sum(1 for r in rows if r.get("observaciones"))
    return {
        "total": total if total is not None else len(rows),
        "filas_cargadas": len(rows),
        "personas": len(personas),
        "areas": len(areas),
        "activos_aprox": activos,
        "inactivos_aprox": inactivos,
        "con_observaciones": con_obs,
    }, None


def ranking_areas() -> tuple[dict, str | None]:
    """
    Ranking global de TODAS las áreas (sin filtrar por una sola ni por contexto previo).
    Orden: más artículos → menos.
    """
    rows, error, _ = read_inventario()
    if error:
        return {}, error
    by_area: dict[str, dict[str, object]] = {}
    for row in rows:
        area = str(row.get("area") or "").strip() or "Sin área"
        bucket = by_area.get(area)
        if bucket is None:
            bucket = {"area": area, "articulos": 0, "personas": set()}
            by_area[area] = bucket
        bucket["articulos"] = int(bucket["articulos"]) + 1  # type: ignore[arg-type]
        persona = str(row.get("persona") or "").strip()
        if persona:
            personas_set = bucket["personas"]
            if isinstance(personas_set, set):
                personas_set.add(persona)
    ranking = sorted(
        (
            {
                "area": str(v["area"]),
                "articulos": int(v["articulos"]),  # type: ignore[arg-type]
                "personas": len(v["personas"]) if isinstance(v["personas"], set) else 0,
            }
            for v in by_area.values()
        ),
        key=lambda x: (-int(x["articulos"]), str(x["area"]).casefold()),
    )
    return {
        "total_areas": len(ranking),
        "total_articulos": len(rows),
        "ranking": ranking,
    }, None


_COMPARE_COLORS = ("#2dd4bf", "#38bdf8", "#a78bfa", "#fbbf24")


def comparar_inventarios(
    origenes: list[str] | None = None,
) -> tuple[dict, str | None]:
    """
    Comparación rápida entre orígenes (excel N / Inventario N).
    origenes=None → todos los orígenes distintos de la BD.
    Estructura normalizada para el visor (sin nulls en áreas).
    """
    rows, error, _ = read_inventario()
    if error:
        return {}, error

    all_labels: list[str] = []
    seen_fold: set[str] = set()
    for row in rows:
        label = str(row.get("origen") or "").strip() or "S/O"
        folded = _origen_fold(label)
        if folded in seen_fold:
            continue
        seen_fold.add(folded)
        all_labels.append(label)

    wanted: list[str] = []
    if origenes:
        import re as _re
        import unicodedata as _ud

        def _fold_alias(s: str) -> str:
            t = "".join(
                c
                for c in _ud.normalize("NFD", str(s or "").lower())
                if _ud.category(c) != "Mn"
            )
            return _re.sub(r"\s+", " ", t).strip()

        for raw in origenes:
            needle = str(raw or "").strip()
            if not needle:
                continue
            folded_alias = _fold_alias(needle)
            # “inventario actual / más reciente” → Inventario N mayor.
            if folded_alias in {
                "mas reciente",
                "el mas reciente",
                "inventario mas reciente",
                "el inventario mas reciente",
                "inventario actual",
                "el inventario actual",
                "actual",
                "el actual",
                "reciente",
                "ultimo",
                "el ultimo",
                "ultimo inventario",
                "el ultimo inventario",
            } or _re.search(
                r"\b(mas reciente|inventario actual|ultimo inventario)\b",
                folded_alias,
            ):
                needle = latest_inventario_origen(rows)
            else:
                # Alias xlsx/ecel → excel antes de resolver.
                low = folded_alias
                m_alias = _re.match(
                    r"^(xlsx|xls|csv|ecel|exel|excel)e?s?\s*(\d+)$", low
                )
                if m_alias:
                    needle = f"excel {int(m_alias.group(2))}"
            resolved = resolve_origen_label(needle, rows) or needle
            folded = _origen_fold(resolved)
            if any(_origen_fold(w) == folded for w in wanted):
                continue
            wanted.append(resolved)
    else:
        wanted = list(all_labels)

    if len(wanted) < 2:
        return {
            "ok": False,
            "error": (
                "Se necesitan al menos 2 inventarios/orígenes para comparar. "
                f"Disponibles: {', '.join(all_labels) or 'ninguno'}."
            ),
            "origenes_disponibles": all_labels,
        }, None

    by_origen: dict[str, list[dict]] = {o: [] for o in wanted}
    want_folds = {_origen_fold(o): o for o in wanted}
    for row in rows:
        label = str(row.get("origen") or "").strip() or "S/O"
        canon = want_folds.get(_origen_fold(label))
        if not canon:
            continue
        by_origen[canon].append(row)

    def _is_activo(estado: object) -> bool:
        v = str(estado or "").strip().lower()
        return v not in {"inactivo", "baja", "no", "inactive"}

    inventarios: list[dict[str, object]] = []
    etq_sets: dict[str, set[str]] = {}
    area_counts: dict[str, dict[str, int]] = {}

    for idx, origen in enumerate(wanted):
        bucket = by_origen.get(origen) or []
        personas: set[str] = set()
        etqs: set[str] = set()
        activos = 0
        for row in bucket:
            etq = str(row.get("etiqueta") or "").strip().lower()
            if etq:
                etqs.add(etq)
            persona = str(row.get("persona") or "").strip()
            if persona:
                personas.add(persona)
            area = str(row.get("area") or "").strip() or "Sin área"
            if _is_activo(row.get("estado")):
                activos += 1
            area_counts.setdefault(area, {})
            area_counts[area][origen] = area_counts[area].get(origen, 0) + 1
        etq_sets[origen] = etqs
        total = len(bucket)
        inventarios.append(
            {
                "nombre": origen,
                "total_articulos": total,
                "activos": activos,
                "inactivos": max(0, total - activos),
                "total_personas": len(personas),
                "etiquetas_unicas": len(etqs),
                "color": _COMPARE_COLORS[idx % len(_COMPARE_COLORS)],
                # Alias retrocompatibles (chat / builder local).
                "origen": origen,
                "registros": total,
                "personas": len(personas),
                "etiquetas": len(etqs),
            }
        )

    if not etq_sets:
        compartidas: set[str] = set()
    else:
        compartidas = set.intersection(*etq_sets.values()) if etq_sets else set()
    exclusivas: dict[str, int] = {}
    for origen, etqs in etq_sets.items():
        others: set[str] = set()
        for o2, s2 in etq_sets.items():
            if o2 != origen:
                others |= s2
        exclusivas[origen] = len(etqs - others)

    # TODAS las áreas; faltantes = 0 (nunca null).
    comparativa_areas = sorted(
        (
            {
                "area": area,
                "valores": {o: int(counts.get(o, 0)) for o in wanted},
                # Alias.
                "totales": {o: int(counts.get(o, 0)) for o in wanted},
                "suma": sum(int(counts.get(o, 0)) for o in wanted),
            }
            for area, counts in area_counts.items()
        ),
        key=lambda x: (-int(x["suma"]), str(x["area"]).casefold()),
    )

    titulo = (
        "Comparativa General"
        if origenes is None or len(wanted) > 2
        else f"Comparativa: {wanted[0]} vs {wanted[1]}"
    )
    resumen_cruces = {
        "etiquetas_compartidas": len(compartidas),
        "exclusivas_por_inventario": exclusivas,
    }
    payload = {
        "ok": True,
        "titulo": titulo,
        "general": origenes is None or len(wanted) > 2,
        "origenes": wanted,
        "inventarios": inventarios,
        "comparativa_areas": comparativa_areas,
        "resumen_cruces": resumen_cruces,
        # Alias retrocompatibles.
        "cruces": {
            "compartidas": resumen_cruces["etiquetas_compartidas"],
            "solo_en": exclusivas,
        },
        "por_area": comparativa_areas,
        "resumen_llm": {
            "titulo": titulo,
            "inventarios": [
                {
                    "nombre": i["nombre"],
                    "total_articulos": i["total_articulos"],
                    "activos": i["activos"],
                    "total_personas": i["total_personas"],
                }
                for i in inventarios
            ],
            "etiquetas_compartidas": resumen_cruces["etiquetas_compartidas"],
            "etiquetas_exclusivas": exclusivas,
            "areas_top": [
                {"area": a["area"], "valores": a["valores"]}
                for a in comparativa_areas[:5]
            ],
        },
    }
    return payload, None


def update_inventario_row(row_id: int, fields: dict) -> tuple[dict | None, str | None]:
    clean = {k: v for k, v in fields.items() if k in WRITABLE_FIELDS}
    if not clean:
        return None, "No hay campos válidos para actualizar."
    if "cantidad" in clean and clean["cantidad"] is not None:
        try:
            clean["cantidad"] = int(clean["cantidad"])
        except (TypeError, ValueError):
            return None, "cantidad debe ser un número entero."

    env = get_env()
    base, attempts = _supabase_base_and_keys(env)
    if not base or not attempts:
        return None, "Supabase no configurado."

    last_error = "No se pudo actualizar"
    for name, key, send_bearer in attempts:
        url, headers, _ = _with_key(
            base, f"inventario?id=eq.{int(row_id)}", name, key, send_bearer
        )
        headers["Prefer"] = "return=representation"
        payload, error, _resp = _request_json("PATCH", url, headers=headers, body=clean)
        if error:
            last_error = error
            continue
        invalidate_inventario_cache()
        if isinstance(payload, list) and payload:
            return payload[0], None
        if isinstance(payload, dict):
            return payload, None
        return clean, None
    return None, last_error


def update_inventario_embedding(
    row_id: int, vector: list[float]
) -> tuple[bool, str | None]:
    """Escribe el vector en inventario.embedding (pgvector)."""
    from inventario.ai.embeddings import vector_literal

    env = get_env()
    base, attempts = _supabase_base_and_keys(env)
    if not base or not attempts:
        return False, "Supabase no configurado."
    body = {"embedding": vector_literal(vector)}
    last_error = "No se pudo guardar embedding"
    for name, key, send_bearer in attempts:
        url, headers, _ = _with_key(
            base, f"inventario?id=eq.{int(row_id)}", name, key, send_bearer
        )
        headers["Prefer"] = "return=minimal"
        _payload, error, _resp = _request_json(
            "PATCH", url, headers=headers, body=body
        )
        if error:
            last_error = error
            continue
        return True, None
    return False, last_error


def search_semantico(
    query: str,
    limit: int = 15,
    threshold: float = 0.25,
) -> tuple[list[dict], str | None]:
    """Búsqueda por significado vía RPC match_inventario (pgvector)."""
    q = (query or "").strip()
    if not q:
        return [], "Falta el texto a buscar"
    try:
        from inventario.ai.embeddings import (
            embeddings_configured,
            embed_query,
            vector_literal,
        )
    except Exception as exc:  # noqa: BLE001
        return [], f"embeddings no disponibles: {exc}"

    if not embeddings_configured():
        rows, err = search_inventario(q, limit=limit)
        if err:
            return [], err
        return rows, None

    try:
        vec = embed_query(q)
    except Exception as exc:  # noqa: BLE001
        return [], f"error al embeddear query: {exc}"

    env = get_env()
    base, attempts = _supabase_base_and_keys(env)
    if not base or not attempts:
        return [], "Supabase no configurado."

    body = {
        "query_embedding": vector_literal(vec),
        "match_count": max(1, min(int(limit or 15), 50)),
        "match_threshold": float(threshold),
    }
    last_error = "RPC match_inventario falló"
    for name, key, send_bearer in attempts:
        url, headers, _ = _with_key(base, "rpc/match_inventario", name, key, send_bearer)
        payload, error, _resp = _request_json(
            "POST", url, headers=headers, body=body
        )
        if error:
            last_error = error
            continue
        if isinstance(payload, list):
            return dedupe_by_etiqueta(
                payload, max(1, min(int(limit or 15), 50))
            ), None
        return [], "Respuesta inesperada de match_inventario"
    # Fallback léxico+fuzzy si la RPC aún no existe.
    rows, err = search_inventario(q, limit=limit)
    if err:
        return [], f"{last_error}; fallback: {err}"
    return rows, None


def create_inventario_row(fields: dict) -> tuple[dict | None, str | None]:
    required = ("etiqueta", "articulo", "area")
    missing = [k for k in required if not str(fields.get(k) or "").strip()]
    if missing:
        return None, f"Faltan campos obligatorios: {', '.join(missing)}"

    clean: dict = {}
    for k, v in fields.items():
        if k not in WRITABLE_FIELDS:
            continue
        clean[k] = v
    clean["etiqueta"] = str(clean["etiqueta"]).strip()
    clean["articulo"] = str(clean["articulo"]).strip()
    clean["area"] = str(clean.get("area") or "").strip() or "General"
    clean["origen"] = str(clean.get("origen") or "S/O").strip() or "S/O"
    if clean.get("cantidad") is not None:
        try:
            clean["cantidad"] = int(clean["cantidad"])
        except (TypeError, ValueError):
            clean["cantidad"] = 1
    else:
        clean["cantidad"] = 1
    if not clean.get("estado"):
        clean["estado"] = "Activo"

    env = get_env()
    base, attempts = _supabase_base_and_keys(env)
    if not base or not attempts:
        return None, "Supabase no configurado."

    last_error = "No se pudo crear el artículo"
    for name, key, send_bearer in attempts:
        url, headers, _ = _with_key(base, "inventario", name, key, send_bearer)
        headers["Prefer"] = "return=representation"
        payload, error, _resp = _request_json("POST", url, headers=headers, body=clean)
        if error:
            last_error = error
            continue
        invalidate_inventario_cache()
        if isinstance(payload, list) and payload:
            return payload[0], None
        if isinstance(payload, dict):
            return payload, None
        return clean, None
    return None, last_error


def _origen_fold(raw: str) -> str:
    return _fold_text(raw)


def resolve_origen_label(needle: str, rows: list[dict] | None = None) -> str | None:
    """Empareja 'excel 1' / 'Inventario 3' con el valor real de columna origen."""
    want = _origen_fold(needle)
    if not want:
        return None
    if rows is None:
        rows, error, _ = read_inventario()
        if error or not rows:
            return None
    catalog = sorted(
        {
            str(r.get("origen") or "").strip()
            for r in rows
            if str(r.get("origen") or "").strip()
        },
        key=len,
        reverse=True,
    )
    for label in catalog:
        if _origen_fold(label) == want:
            return label
    for label in catalog:
        folded = _origen_fold(label)
        if want in folded or folded in want:
            return label
    return None


def is_excel_origen_label(label: str) -> bool:
    """True si el origen es un archivo excel N (o legado csv/xls/xlsx N)."""
    import re

    return bool(
        re.match(
            r"(?i)^(excel|csv|xls|xlsx)\s*(\d+)\s*$",
            str(label or "").strip(),
        )
    )


def is_inventario_origen_label(label: str) -> bool:
    import re

    return bool(
        re.match(r"(?i)^inventario\s+(\d+)\s*$", str(label or "").strip())
    )


def excel_origen_number(label: str) -> int | None:
    import re

    m = re.match(
        r"(?i)^(excel|csv|xls|xlsx)\s*(\d+)\s*$",
        str(label or "").strip(),
    )
    if not m:
        return None
    try:
        return int(m.group(2))
    except ValueError:
        return None


def inventario_origen_number(label: str) -> int | None:
    import re

    m = re.match(r"(?i)^inventario\s+(\d+)\s*$", str(label or "").strip())
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def next_inventario_origen(rows: list[dict] | None = None) -> str:
    """Siguiente 'Inventario N' según orígenes que empiecen con 'Inventario '."""
    if rows is None:
        rows, error, _ = read_inventario()
        if error:
            logger.warning("next_inventario_origen read: %s", error)
            rows = []

    highest = 0
    for r in rows or []:
        n = inventario_origen_number(str(r.get("origen") or ""))
        if n is not None:
            highest = max(highest, n)
    return f"Inventario {highest + 1}"


def latest_inventario_origen(rows: list[dict] | None = None) -> str:
    """
    Inventario N con el número más alto (más reciente).
    Si no hay ninguno → 'Inventario 1'.
    """
    if rows is None:
        rows, error, _ = read_inventario()
        if error:
            logger.warning("latest_inventario_origen read: %s", error)
            rows = []

    highest = 0
    label = "Inventario 1"
    for r in rows or []:
        raw = str(r.get("origen") or "").strip()
        n = inventario_origen_number(raw)
        if n is not None and n >= highest:
            highest = n
            label = raw
    return label if highest > 0 else "Inventario 1"


def _row_chrono_key(row: dict) -> tuple:
    created = str(row.get("created_at") or "")
    try:
        rid = int(row.get("id"))
    except (TypeError, ValueError):
        rid = 10**12
    return (created or "9999", rid)


def list_excel_origenes_chronological(
    rows: list[dict] | None = None,
) -> list[str]:
    """Etiquetas excel N únicas, del más viejo al más reciente (created_at/id)."""
    if rows is None:
        rows, error, _ = read_inventario()
        if error:
            rows = []
    buckets: dict[str, list[dict]] = {}
    for r in rows or []:
        raw = str(r.get("origen") or "").strip()
        if not is_excel_origen_label(raw):
            continue
        # Normalizar legado csv/xls → etiqueta canónica excel N
        num = excel_origen_number(raw)
        if num is None:
            continue
        canon = f"excel {num}"
        buckets.setdefault(canon, []).append(r)
    ordered = sorted(
        buckets.items(),
        key=lambda kv: min(_row_chrono_key(r) for r in kv[1]),
    )
    return [label for label, _ in ordered]


def rename_origen_label(
    old_label: str, new_label: str
) -> tuple[int, str | None]:
    """Renombra origen (PATCH masivo por igualdad exacta)."""
    old_l = str(old_label or "").strip()
    new_l = str(new_label or "").strip()
    if not old_l or not new_l:
        return 0, "Faltan etiquetas de origen."
    if _origen_fold(old_l) == _origen_fold(new_l):
        return 0, None

    env = get_env()
    base, attempts = _supabase_base_and_keys(env)
    if not base or not attempts:
        return 0, "Supabase no configurado."

    last_error = "No se pudo renombrar origen"
    for name, key, send_bearer in attempts:
        path = f"inventario?origen=eq.{quote(old_l, safe='')}"
        url, headers, _ = _with_key(base, path, name, key, send_bearer)
        headers["Prefer"] = "return=representation"
        payload, error, _resp = _request_json(
            "PATCH", url, headers=headers, body={"origen": new_l}
        )
        if error:
            last_error = error
            continue
        invalidate_inventario_cache()
        if isinstance(payload, list):
            return len(payload), None
        return 0, None
    return 0, last_error


def renumber_excel_origenes(
    rows: list[dict] | None = None,
) -> tuple[list[dict[str, str]], str | None]:
    """
    Reasigna excel 1..N en orden cronológico (más viejo → 1).
    Usa nombres temporales para evitar colisiones.
    """
    if rows is None:
        rows, error, _ = read_inventario(force=True)
        if error:
            return [], error

    current = list_excel_origenes_chronological(rows)
    if not current:
        return [], None

    desired = [f"excel {i}" for i in range(1, len(current) + 1)]
    if current == desired:
        return [], None

    changes: list[dict[str, str]] = []
    # Fase 1: a temporales
    for idx, old in enumerate(current):
        tmp = f"__tmp_excel_{idx + 1}__"
        n, err = rename_origen_label(old, tmp)
        if err:
            return changes, err
        if n:
            changes.append({"from": old, "to": tmp, "phase": "tmp"})

    # Fase 2: temporales → excel N limpio
    for idx in range(len(current)):
        tmp = f"__tmp_excel_{idx + 1}__"
        final = f"excel {idx + 1}"
        n, err = rename_origen_label(tmp, final)
        if err:
            return changes, err
        if n:
            changes.append({"from": tmp, "to": final, "phase": "final"})

    return changes, None


def repair_excel3_mal_creado() -> dict:
    """
    Corrige el contenedor 'excel 3' creado por chat (debe ser Inventario N)
    y renumerar exceles restantes 1..N.
    """
    rows, err, _ = read_inventario(force=True)
    if err:
        return {"ok": False, "error": err}

    has_excel3 = any(
        _origen_fold(str(r.get("origen") or "")) == _origen_fold("excel 3")
        for r in rows
    )
    actions: list[str] = []
    if has_excel3:
        dest = next_inventario_origen(rows)
        # Si next sería Inventario 1 pero ya existe, next_inventario ya suma.
        n, ren_err = rename_origen_label("excel 3", dest)
        if ren_err:
            return {"ok": False, "error": ren_err, "actions": actions}
        actions.append(f"Renombrado excel 3 → {dest} ({n} filas)")
        rows, err, _ = read_inventario(force=True)
        if err:
            return {"ok": False, "error": err, "actions": actions}

    changes, ren_err = renumber_excel_origenes(rows)
    if ren_err:
        return {"ok": False, "error": ren_err, "actions": actions}
    if changes:
        finals = [c for c in changes if c.get("phase") == "final"]
        actions.append(
            "Renumeración excel: "
            + ", ".join(f"{c['from']}→{c['to']}" for c in finals)
            if finals
            else "Renumeración excel aplicada"
        )

    rows2, _, _ = read_inventario(force=True)
    from collections import Counter

    counts = Counter(
        str(r.get("origen") or "").strip() for r in (rows2 or [])
    )
    return {
        "ok": True,
        "actions": actions,
        "origenes": dict(counts),
    }


def etiquetas_en_origen(origen: str) -> tuple[set[str], str | None]:
    """Set de etiquetas (lower) ya presentes en el origen destino."""
    rows, error, _ = read_inventario()
    if error:
        return set(), error
    label = resolve_origen_label(origen, rows) or str(origen or "").strip()
    want = _origen_fold(label)
    out: set[str] = set()
    for r in rows:
        if _origen_fold(str(r.get("origen") or "")) != want:
            continue
        etq = str(r.get("etiqueta") or "").strip().lower()
        if etq:
            out.add(etq)
    return out, None


def list_rows_por_origen(
    origen: str, limit: int | None = None
) -> tuple[list[dict], str | None]:
    """Filas de un origen (orden por id). limit=None → todas."""
    rows, error, _ = read_inventario()
    if error:
        return [], error
    label = resolve_origen_label(origen, rows)
    if not label:
        return [], f"No encontré el origen «{origen}»."
    want = _origen_fold(label)
    matched = [
        r
        for r in rows
        if _origen_fold(str(r.get("origen") or "")) == want
        and str(r.get("etiqueta") or "").strip()
    ]

    def _id_key(row: dict) -> int:
        try:
            return int(row.get("id") or 0)
        except (TypeError, ValueError):
            return 0

    matched.sort(key=_id_key)
    if limit is not None:
        matched = matched[: max(0, int(limit))]
    return matched, None


def create_inventario_rows_bulk(
    rows: list[dict],
) -> tuple[list[dict], str | None]:
    """Inserta varias filas (misma forma que create_inventario_row)."""
    if not rows:
        return [], None
    cleaned: list[dict] = []
    for fields in rows:
        required = ("etiqueta", "articulo", "area")
        missing = [k for k in required if not str(fields.get(k) or "").strip()]
        if missing:
            return [], f"Faltan campos obligatorios: {', '.join(missing)}"
        clean: dict = {}
        for k, v in fields.items():
            if k not in WRITABLE_FIELDS:
                continue
            clean[k] = v
        clean["etiqueta"] = str(clean["etiqueta"]).strip()
        clean["articulo"] = str(clean["articulo"]).strip()
        clean["area"] = str(clean.get("area") or "").strip() or "General"
        clean["origen"] = str(clean.get("origen") or "S/O").strip() or "S/O"
        if clean.get("cantidad") is not None:
            try:
                clean["cantidad"] = int(clean["cantidad"])
            except (TypeError, ValueError):
                clean["cantidad"] = 1
        else:
            clean["cantidad"] = 1
        if not clean.get("estado"):
            clean["estado"] = "Activo"
        cleaned.append(clean)

    env = get_env()
    base, attempts = _supabase_base_and_keys(env)
    if not base or not attempts:
        return [], "Supabase no configurado."

    last_error = "No se pudo insertar el lote"
    chunk_size = 200
    for name, key, send_bearer in attempts:
        saved: list[dict] = []
        ok = True
        for i in range(0, len(cleaned), chunk_size):
            chunk = cleaned[i : i + chunk_size]
            url, headers, _ = _with_key(base, "inventario", name, key, send_bearer)
            headers["Prefer"] = "return=representation"
            payload, error, _resp = _request_json(
                "POST", url, headers=headers, body=chunk
            )
            if error:
                last_error = error
                ok = False
                break
            if isinstance(payload, list):
                saved.extend(payload)
            elif isinstance(payload, dict):
                saved.append(payload)
        if ok:
            invalidate_inventario_cache()
            return saved, None
    return [], last_error


def delete_inventario_by_ids(ids: list[int]) -> tuple[int, str | None]:
    """Elimina filas por id interno (para mover)."""
    clean_ids: list[int] = []
    for raw in ids:
        try:
            clean_ids.append(int(raw))
        except (TypeError, ValueError):
            continue
    clean_ids = sorted(set(clean_ids))
    if not clean_ids:
        return 0, None

    env = get_env()
    base, attempts = _supabase_base_and_keys(env)
    if not base or not attempts:
        return 0, "Supabase no configurado."

    last_error = "No se pudo eliminar"
    chunk_size = 100
    for name, key, send_bearer in attempts:
        deleted = 0
        ok = True
        for i in range(0, len(clean_ids), chunk_size):
            chunk = clean_ids[i : i + chunk_size]
            id_list = ",".join(str(x) for x in chunk)
            path = f"inventario?id=in.({id_list})"
            url, headers, _ = _with_key(base, path, name, key, send_bearer)
            headers["Prefer"] = "return=representation"
            payload, error, _resp = _request_json(
                "DELETE", url, headers=headers, body=None
            )
            if error:
                last_error = error
                ok = False
                break
            if isinstance(payload, list):
                deleted += len(payload)
            else:
                deleted += len(chunk)
        if ok:
            invalidate_inventario_cache()
            return deleted, None
    return 0, last_error
