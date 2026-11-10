import json
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from dotenv import load_dotenv
import os

BASE_DIR = Path(__file__).resolve().parents[1]
DB_ENV_PATH = BASE_DIR.parent / "Database" / ".env.local"
BACKEND_ENV_PATH = BASE_DIR / ".env"

_CACHE: dict[str, object] = {"rows": None, "at": 0.0, "used": None, "error": None}
_CACHE_TTL_SEC = 60.0
_PAGE_SIZE = 1000

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
        "GEMINI_API_KEY",
        "GEMINI_MODEL",
        "GROQ_API_KEY",
        "GROQ_MODEL",
        "LLM_MODEL",
        "LLM_PROVIDERS",
        "OLLAMA_BASE_URL",
        "OLLAMA_MODEL",
        "OLLAMA_API_KEY",
        "DEEPSEEK_API_KEY",
        "DEEPSEEK_MODEL",
        "DEEPSEEK_BASE_URL",
        "MODEL_API_KEY",
        "META_API_KEY",
        "MUSE_API_KEY",
        "MUSE_MODEL",
        "META_MODEL",
        "META_BASE_URL",
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
    data = None
    req_headers = dict(headers)
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req_headers["Content-Type"] = "application/json"
        req_headers.setdefault("Prefer", "return=representation")
    request = Request(url, data=data, headers=req_headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            resp_headers = {k.lower(): v for k, v in response.headers.items()}
            if not raw:
                return None, None, resp_headers
            return json.loads(raw), None, resp_headers
    except HTTPError as error:
        # PostgREST a veces responde 206/416 con body; HTTPError también en 416
        err_body = error.read().decode("utf-8", errors="replace")
        resp_headers = {k.lower(): v for k, v in error.headers.items()} if error.headers else {}
        if error.code in (206, 416) and err_body:
            try:
                return json.loads(err_body), None, resp_headers
            except json.JSONDecodeError:
                pass
        return None, err_body or f"HTTP {error.code}", resp_headers
    except URLError as error:
        return None, str(error.reason), {}


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


def count_por_campo(campo: str, valor: str) -> tuple[int | None, str | None]:
    """Cuenta filas donde campo contiene valor (ilike)."""
    campo = campo.strip().lower()
    if campo not in WRITABLE_FIELDS and campo != "id":
        return None, f"Campo no permitido: {campo}"
    valor = valor.strip()
    if not valor:
        return None, "Falta el valor a buscar"
    # escape comas/parens mínimos para PostgREST
    safe = valor.replace(",", " ").replace(")", " ").replace("(", " ")
    return count_inventario(f"{campo}=ilike.*{safe}*")


def list_por_campo(
    campo: str, valor: str, limit: int = 20
) -> tuple[list[dict], str | None]:
    """Lista filas donde campo contiene valor (desde caché local)."""
    campo = campo.strip().lower()
    if campo not in WRITABLE_FIELDS and campo != "id":
        return [], f"Campo no permitido: {campo}"
    valor = valor.strip().lower()
    if not valor:
        return [], "Falta el valor a buscar"
    rows, error, _ = read_inventario()
    if error:
        return [], error
    tokens = [t for t in valor.split() if len(t) > 1] or [valor]
    matched: list[dict] = []
    for row in rows:
        blob = str(row.get(campo) or "").lower()
        if not blob:
            continue
        if all(t in blob for t in tokens):
            matched.append(row)
            if len(matched) >= max(1, min(limit, 50)):
                break
    return matched, None


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
                "inventario?select=*&order=id.asc",
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

    path_qs = f"inventario?id=eq.{int(row_id)}&select=*&limit=1"
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
    return matches, None


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
    filters = ["select=*", "order=created_at.desc,id.desc", f"limit={n}"]
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
            return payload, None
        return [], "Respuesta inesperada de Supabase"
    return [], last_error


def search_inventario(query: str, limit: int = 20) -> tuple[list[dict], str | None]:
    rows, error, _ = read_inventario()
    if error:
        return [], error
    tokens = [t for t in query.lower().split() if len(t) > 1]
    if not tokens:
        return rows[: max(1, min(limit, 50))], None

    scored: list[tuple[int, dict]] = []
    for row in rows:
        blob_parts = [
            row.get("etiqueta"),
            row.get("articulo"),
            row.get("marca"),
            row.get("modelo"),
            row.get("serie"),
            row.get("area"),
            row.get("persona"),
            row.get("origen"),
            row.get("estado"),
            row.get("observaciones"),
        ]
        blob = " ".join(str(p or "").lower() for p in blob_parts)
        score = 0
        for t in tokens:
            if t == str(row.get("etiqueta") or "").lower():
                score += 15
            elif t in str(row.get("etiqueta") or "").lower():
                score += 8
            if t in str(row.get("persona") or "").lower():
                score += 8
            if t in str(row.get("articulo") or "").lower():
                score += 6
            if t in str(row.get("area") or "").lower():
                score += 5
            if t in blob:
                score += 2
        if score > 0:
            scored.append((score, row))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [r for _, r in scored[: max(1, min(limit, 50))]], None


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
