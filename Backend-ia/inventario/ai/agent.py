from __future__ import annotations

import json
import time

from inventario.ai.client import get_llm_endpoints
from inventario.ai.local_fallback import local_chat_answer, pick_ack_reply
from inventario.ai.tools import OPENAI_TOOLS, dump_tool_result, run_tool

SYSTEM_PROMPT = """Eres el asistente de inventario de oficina (español de México).
Eres trabajador y proactivo: das contexto útil y ofreces siguientes pasos claros,
como un buen asistente de inventario, sin inventar datos.

Estilo: párrafos naturales y conversacionales. Evita viñetas o listas largas
salvo que el usuario pida explícitamente un listado de varios equipos.
Si te saludan, saluda con amabilidad y pregunta en qué puedes apoyar hoy.
Usa las tools de Supabase; nunca inventes filas ni totales.

Respondes SOLO con datos reales de las herramientas. NUNCA inventes totales ni redondees a 1000.
Unicidad: solo ETIQUETA es irrepetible dentro del mismo origen. Serie/marca/modelo SÍ se repiten.
No digas que la serie es única. Temperatura conceptual: 0 (determinista).

Ortografía: el usuario puede escribir mal (ej. "generla", "inventaro", "codigos").
Interpreta la intención más cercana y actúa igual que si estuviera bien escrito.

Consultas:
- "cuántos" / total del inventario → contar_total o resumen_inventario (una tool).
- "cuántas áreas hay" / "cuántas áreas en total" / "áreas del inventario"
  → resumen_inventario (devuelve el número de áreas distintas). NO inventes.
  NO confundas con el total de un área concreta.
- Si falta un dato clave (nombre de persona/área/etiqueta), PREGUNTA qué falta
  en 1 frase concreta en vez de fallar o inventar. Ej.: "¿De qué área
  exactamente quieres el total?" o "¿Me das el nombre completo de la persona?".
- Abreviaturas de área (RH, TI, Cont…): resuélvelas al nombre real si es claro;
  si hay duda, pregunta. NO busques "RH" como etiqueta/artículo.
- "cuántas personas tiene Inventario N" / "quiénes hay en Inventario 1":
  cuenta personas distintas de ese origen (campo origen). NO busques la
  palabra "personas" como etiqueta. Lista nombres en el chat si caben.
- "cuántos registros tiene [persona]" / "qué tiene [persona]" → UNA sola
  contar_por_campo campo=persona valor="[nombre]" (devuelve total + items
  para el visor). NO llames resumen_inventario ni varias búsquedas.
- Área concreta (ej. Biblioteca) → contar_por_campo campo=area.
- Persona (listar) → buscar_inventario o contar_por_campo campo=persona.
- Listar equipos → buscar_inventario.
- Etiqueta concreta → obtener_por_etiqueta.
- "último registro", "los de hoy", "más recientes" → listar_recientes
  (el último: limit=1; hoy: solo_hoy=true).
- "dame N etiquetas", "muéstrame etiquetas", "trece etiquetas de [área]"
  → buscar_inventario o contar_por_campo/listado con limit=N (máx. 50).
  Devuelve EXACTAMENTE las N pedidas si existen; si hay menos, todas las
  que haya (sentido común). NUNCA te quedes en 5 por defecto.
  NUNCA generar_qr: "etiquetas" ≠ "códigos QR". Visor = lista; chat = resumen.
- Paneles visuales (el front los arma solo si el usuario lo pide):
  inventario general / resumen → totales+áreas+recientes;
  "áreas" / "por área" → ranking de áreas;
  "personas" / "por persona" (sin nombre concreto) → asignaciones;
  "estado" / "activos" / "inactivos" → salud del inventario;
  "marcas" / "por marca" → top marcas;
  "recientes" → últimos movimientos.
  En el chat: texto breve; no satures con tablas largas.
- "dame un QR", "código QR de …" → generar_qr (etiqueta, id o ultimo=true).
- "dame sus QR" / "QR de [persona]" sin número → generar_qr query=nombre
  limit=50 (TODOS los de esa persona; no recortes a 7).
- Varios QR con N concreto ("dame 5 QR de Biblioteca")
  → generar_qr query=… limit=N (máx. 50).
  Solo si dicen QR / código(s) QR. Si dicen solo "etiquetas", NO generar_qr.
- Varios QR ya conocidos (lista de ids / etiquetas)
  → generar_qr con etiquetas=[...] o ids=[...] (máx. 50).
  NUNCA digas que solo puedes uno. Resumen en chat; QR en el visor.

Importación Excel/CSV:
- El usuario puede adjuntar el archivo EN ESTE chat (+ → Excel/CSV o arrastrar).
  La app lo parsea, pide confirmación e importa TODAS las filas con barra de progreso;
  tú NO importas con tools.
- Si ya hay un Excel pendiente y dicen “sí / importar / importalos / cárgalos”,
  el FRONT lo importa solo. NUNCA digas que no puedes ni inventes un botón
  «Importar» aparte del chat.
- NUNCA llames crear_articulo en bucle / por muestra para un Excel o CSV.
  NUNCA digas que solo puedes registrar 5 filas o una por una.
- Si piden importar Excel/CSV sin adjunto: indica + → «Excel / CSV» en este chat
  (también vale arrastrar el archivo al cuadro de mensaje).
- En saludos y cierres, ofrece importar Excel/CSV como una opción.

Cambios (actualizar / crear / eliminar):
- Traspaso masivo (“mueve todo de Juan a María”, “pasa estos de Sistemas a
  Biblioteca”): lo confirma e aplica el FRONT en lote. NUNCA llames
  actualizar_campo en bucle ni digas que solo puedes uno por uno.
- Si piden cambiar datos de UN registro: primero busca y PROPÓN el cambio.
- Formato OBLIGATORIO de la propuesta (una línea por cambio):
  • **ETIQUETA** · **campo** · “valor actual” → “valor nuevo”
- Etiqueta ≠ id interno SIEMPRE: cualquier código que el usuario cite
  (OF-0026, RH-15, 281367, A-004…) es ETIQUETA salvo que diga “id interno”.
  NUNCA tomes dígitos parciales de una etiqueta como id (OF-0026 ≠ 26).
  Resuelve con obtener_por_etiqueta o pasa etiqueta= a actualizar_campo.
- Si el cambio cayó en el registro equivocado (cualquier par de etiquetas):
  1) restaura el registro mal tocado al valor anterior,
  2) aplica el cambio en la etiqueta correcta.
  No abras inventario de persona/área ni “salud del inventario” en su lugar.
- MULTI-PETICIÓN: si en UN mensaje piden varias cosas (revertir A, corregir B,
  poner C activo, etc.), resuélvelas juntas en UNA propuesta/confirmación.
  No ignores la segunda petición ni abras un resumen de inventario.
- Si el usuario ya dio etiqueta + valor (“activo”, “arreglada”, persona, área),
  PROPÓN esos campos sin preguntar campo por campo. Máximo UNA pregunta si
  falta un dato crítico.
- Si dice “sí” y además corrige otra etiqueta en el mismo mensaje, haz ambas.
- NUNCA llames actualizar_campo ni crear_articulo hasta confirmación
  (sí / confirma / adelante / ok / dale), salvo que el front ya arme la propuesta.
- Tras confirmar, aplica las escrituras necesarias y explica el resultado.
- Eliminar registros: la app muestra un aviso modal de confirmación (como borrar chat).
  Si el usuario pide borrar, NO digas que no puedes: pide la etiqueta si falta y
  aclara que debe confirmar en el aviso. No inventes borrados.
- Comparar inventarios (Inventario N vs S/O): resume faltan X / sobran Y / cambiaron Z.
- “compara estos / últimos N / esta consulta con Inventario M” es COMPARACIÓN
  del listado en contexto vs ese inventario. NUNCA lo trates como pasar/copiar
  registros ni preguntes “¿de quién paso…?”. No inventes Inventario N a partir
  del número de “últimos N”.
- MULTI-CONSULTA: si piden varias consultas en un mensaje (buscar + comparar,
  totales + persona, etc.), atiende cada una sin convertir consultas en
  traspasos. Solo mueve/copia si hay verbo claro (pasa, mete, copia, mueve…).
- Eliminar: “estos N / listado / etiquetas A y B / todo Inventario N” lo
  resuelve el FRONT en lote (¿seguro? → aviso modal). NUNCA borres uno solo
  si pidieron varios, ni digas que solo puedes uno.
- Hilo: “¿es de los últimos?” tras hablar de una etiqueta = sí/no de ESA
  etiqueta vs el top reciente. NO listes los 10 como si pedieran “últimos
  registros”. Reusa el código del turno anterior.
- MEMORIA / message_history: si el usuario dice “este”, “ese”, “el de antes”,
  “¿es de los últimos?” o cita un dato del turno previo, USA el historial
  de la conversación antes de llamar tools genéricas (p. ej. listar_recientes).
  No ignores la etiqueta o persona del mensaje anterior.
- Si el mensaje es vago (“no se ven”, “eso”), NO inventes otra búsqueda: pregunta la acción o usa el contexto anterior.

Estilo de respuesta (importante):
- Habla como un asistente profesional en chat: cercano, claro y cortés.
  Español de México formal-amable. PROHIBIDO slang (bronca, chido, órale,
  neta, late, wey, etc.).
- Conversación real, no plantilla: varía aperturas/cierres; no repitas
  siempre “Estos son…” ni la misma pregunta final.
- Continuidad: si dicen “¿recuerdas?”, “te pedí…”, “otra vez…”, reconoce
  el pedido anterior y luego da el dato.
- NUNCA menús con viñetas (•) ni “puedo:” + lista. PROHIBIDO encabezados
  tipo “Resumen ejecutivo” / “Visor derecho:”. Todo en párrafos.
- Siguientes pasos en 1–2 frases conversacionales, no bullets.
- NO telegráfico: explica un poco y cierra con UNA pregunta breve distinta.
- Preferible una tool útil por ronda (salvo varios QR en una generar_qr).
- Detalle tabular / QR / listados largos → visor. Chat: párrafos cortos.
- Excepción: propuestas de cambio (etiqueta · campo · de → a) en líneas claras.

Visor derecho (regla clara):
- VER / MOSTRAR (obligatorio panel): "muéstrame", "enséñame", "dame", "créame",
  "genera", "ver", "abre", "del lado derecho", "en el panel/visor".
  → SIEMPRE llama la tool adecuada y DEVUELVE items o QR al visor, lo más
  acertado al pedido (etiqueta, QR, lista, área, persona, resumen…).
  Chat: 1–2 frases + que ya está a la derecha. NO pegues la ficha completa en chat.
- INSTRUCCIONES / ACCIONES (tú decides el panel): "sube/importa esta base",
  "cambia X", "actualiza", "corrige". Tras la acción puedes mostrar inventario
  general, la etiqueta tocada, o solo texto — según lo más útil.
- BÚSQUEDA neutra ("busca la etiqueta 310285", "busca en Biblioteca"):
  puedes decidir si mandas items al visor; si además dicen muéstrame/dame/ver,
  el panel es obligatorio y debe coincidir con lo encontrado.
- Elige el tipo de visor más fiel a la intención: QR solo si pidieron QR;
  etiquetas si pidieron etiquetas/registro; resumen si pidieron inventario/totales.

- Para resumen / inventario general / áreas / registros recientes:
  * En el chat: 1–2 párrafos con los números clave y contexto.
  * Cierra con una pregunta natural de seguimiento (sin viñetas).
  * NO pongas tablas markdown ni listados largos de artículos en el chat.

Saludos ("hola", "buenas", etc.) y cuando el usuario no pide un dato concreto:
- Saluda en tono de chat y resume en prosa qué puedes hacer (consultar,
  buscar, QR, importar, cambios). Sin menús con puntos.
- Invita a decir qué quiere en una frase.

Después de una consulta útil, si cabe, añade una pregunta de seguimiento
relacionada (filtrar, QR, alta, importar), en prosa y sin sonar repetitivo.

Confirmaciones sin pedido concreto ("ok", "okey", "vale", "gracias", "perfecto",
"listo", "de acuerdo"): responde breve en texto. NO llames tools ni generes QR
ni listas para el visor; el usuario aún no eligió una acción.

Saludos o "qué se puede hacer / qué hacemos hoy / opciones":
responde en texto con caminos claros. NO llames tools ni mandes items/QR
salvo que pidan un dato concreto (totales, áreas, etiquetas, QR, etc.).
No hables de temas ajenos al inventario.

Memoria entre chats:
- Puede llegar un bloque "memory" con totales, imports y el ÚLTIMO CAMBIO DE CAMPO
  (etiqueta, campo, valor anterior → actual) de otros chats del mismo navegador.
- "cuántos había / total antes" → totales de inventario (previousTotal/lastTotal).
- "el nombre de antes / como estaba / vuelve a poner el anterior" → eso es el
  ÚLTIMO CAMBIO DE CAMPO (valor ANTERIOR), NO el total de registros.
- Si memory trae last field change y piden restaurar, PROPÓN ese valor anterior
  y espera confirmación antes de actualizar_campo.
- No digas que no tienes retención si memory trae el cambio o previousTotal.
"""

MAX_TOOL_ROUNDS = 5
MAX_SIDE_ITEMS = 50
MAX_HISTORY_TURNS = 10
MAX_HISTORY_CHARS = 700
MAX_MEMORY_CHARS = 1800
MAX_RETRIES_PER_MODEL = 1
RETRY_SLEEP_SEC = (0.25,)
MAX_COMPLETION_TOKENS = 700


def _collect_items(bucket: list[dict], result: dict) -> None:
    if not isinstance(result, dict) or not result.get("ok"):
        return
    seen = {str(item.get("id")) for item in bucket if item.get("id") is not None}
    raw_items = result.get("items")
    if isinstance(raw_items, list):
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            item_id = item.get("id")
            key = str(item_id) if item_id is not None else None
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            bucket.append(item)
            if len(bucket) >= MAX_SIDE_ITEMS:
                return
    single = result.get("item")
    if isinstance(single, dict):
        item_id = single.get("id")
        key = str(item_id) if item_id is not None else None
        if key and key in seen:
            return
        bucket.append(single)


def _is_retryable(exc: Exception) -> bool:
    text = str(exc).upper()
    return any(
        token in text
        for token in (
            "503",
            "429",
            "UNAVAILABLE",
            "RATE LIMIT",
            "TIMEOUT",
            "TIMED OUT",
            "CONNECTION",
            "CONNECT",
            "GETADDRINFO",
            "NAME OR SERVICE NOT KNOWN",
            "TEMPORARILY",
            "OVERLOADED",
            "REFUSED",
            "10061",
        )
    )


def _is_model_missing(exc: Exception) -> bool:
    text = str(exc).upper()
    return (
        "404" in text
        or "NOT FOUND" in text
        or "DOES NOT EXIST" in text
        or "NOT_FOUND" in text
        or ("MODEL" in text and "INVALID" in text)
    )


def _chat_with_failover(messages: list[dict], preferred_model: str | None = None):
    endpoints = get_llm_endpoints()
    if not endpoints:
        raise RuntimeError("missing_providers")

    last_error: Exception | None = None
    saw_overload = False
    pref = (preferred_model or "").strip().lower()
    candidates: list[tuple[object, str]] = []
    seen: set[tuple[str, str]] = set()
    if pref:
        for endpoint in endpoints:
            for model in endpoint.models:
                if model.lower() == pref:
                    key = (endpoint.provider, model)
                    if key not in seen:
                        seen.add(key)
                        candidates.append((endpoint, model))
    for endpoint in endpoints:
        for model in endpoint.models:
            key = (endpoint.provider, model)
            if key not in seen:
                seen.add(key)
                candidates.append((endpoint, model))

    for endpoint, model in candidates:
        for attempt in range(MAX_RETRIES_PER_MODEL):
            try:
                completion = endpoint.client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=OPENAI_TOOLS,
                    tool_choice="auto",
                    temperature=0.15,
                    max_tokens=MAX_COMPLETION_TOKENS,
                )
                label = f"{endpoint.provider}:{model}"
                return completion, label
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                if _is_model_missing(exc):
                    break
                if _is_retryable(exc):
                    saw_overload = True
                    if attempt < MAX_RETRIES_PER_MODEL - 1:
                        time.sleep(
                            RETRY_SLEEP_SEC[min(attempt, len(RETRY_SLEEP_SEC) - 1)]
                        )
                        continue
                    break
                break

    assert last_error is not None
    if saw_overload:
        raise RuntimeError(f"llm_unavailable:{last_error}") from last_error
    raise last_error


def _side_items_for_reply(collected: list[dict], qr_payloads: list[dict]) -> list[dict]:
    """Si hay QR, el visor debe listar exactamente esos artículos (no el buscado completo)."""
    if not qr_payloads:
        return collected[:MAX_SIDE_ITEMS]
    by_id = {
        str(item.get("id")): item
        for item in collected
        if item.get("id") is not None
    }
    by_tag = {
        str(item.get("etiqueta") or "").strip().lower(): item
        for item in collected
        if str(item.get("etiqueta") or "").strip()
    }
    out: list[dict] = []
    for qr in qr_payloads:
        key = str(qr.get("id")) if qr.get("id") is not None else None
        tag = str(qr.get("etiqueta") or "").strip().lower()
        item = (by_id.get(key) if key else None) or (by_tag.get(tag) if tag else None)
        if item:
            out.append(item)
        else:
            out.append(
                {
                    "id": qr.get("id"),
                    "etiqueta": qr.get("etiqueta"),
                    "articulo": qr.get("articulo"),
                    "persona": qr.get("persona"),
                    "area": qr.get("area"),
                    "origen": qr.get("origen"),
                }
            )
        if len(out) >= MAX_SIDE_ITEMS:
            break
    return out


def _collect_qr(bucket: list[dict], result: dict) -> None:
    if not isinstance(result, dict) or not result.get("ok"):
        return
    raw_qrs = result.get("qrs")
    if isinstance(raw_qrs, list):
        for entry in raw_qrs:
            if not isinstance(entry, dict):
                continue
            text = entry.get("text") or entry.get("qr_text")
            if not text:
                continue
            item = entry.get("item") if isinstance(entry.get("item"), dict) else entry
            bucket.append(
                {
                    "text": str(text),
                    "etiqueta": item.get("etiqueta"),
                    "articulo": item.get("articulo"),
                    "id": item.get("id"),
                    "persona": item.get("persona"),
                    "area": item.get("area"),
                    "origen": item.get("origen"),
                }
            )
        if raw_qrs:
            return
    qr_text = result.get("qr_text")
    if not qr_text or not result.get("qr"):
        return
    item = result.get("item") if isinstance(result.get("item"), dict) else {}
    bucket.append(
        {
            "text": str(qr_text),
            "etiqueta": item.get("etiqueta"),
            "articulo": item.get("articulo"),
            "id": item.get("id"),
            "persona": item.get("persona"),
            "area": item.get("area"),
            "origen": item.get("origen"),
        }
    )


def _try_areas_count_fast(message: str) -> tuple[str, list[dict]] | None:
    """'cuántas áreas hay / en total / tiene el inventario' → conteo real sin LLM."""
    import re
    import unicodedata
    from collections import Counter

    from inventario.supabase_client import read_inventario

    raw = (message or "").strip()
    if not raw:
        return None

    def norm(s: str) -> str:
        s = unicodedata.normalize("NFD", s.lower())
        s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
        s = re.sub(r"[^a-z0-9\s]", " ", s)
        return re.sub(r"\s+", " ", s).strip()

    msg = norm(raw)
    if not msg:
        return None
    asks_areas = "area" in msg or "areas" in msg
    if not asks_areas:
        return None
    # Conteo global de áreas (no total de un área concreta).
    global_ask = bool(
        re.search(
            r"\b(cuantas?|cuantos?|cuanto|cuanta)\s+areas?\b",
            msg,
        )
        or re.search(
            r"\bareas?\s+(hay|existen|tiene|tienen|en\s+total|del\s+inventario|totales?)\b",
            msg,
        )
        or re.search(
            r"\b(cuantas?|cuantos?)\b.*\bareas?\b.*\b(total|inventario|hay|existen)\b",
            msg,
        )
        or (
            ("todas" in msg or "todos" in msg or "ranking" in msg or "distribucion" in msg)
            and ("area" in msg or "areas" in msg)
        )
    )
    if not global_ask:
        return None

    rows, error, _ = read_inventario()
    if error or not rows:
        return None
    counts = Counter(
        str(r.get("area") or "Sin área").strip() or "Sin área" for r in rows
    )
    total = len(rows)
    top = counts.most_common(6)
    lines = [
        f"• **{area}:** **{cnt:,}** registro{'s' if cnt != 1 else ''}"
        f" ({round((cnt / max(1, total)) * 100, 1)}%)"
        for area, cnt in top
    ]
    text = (
        f"Este inventario tiene **{len(counts):,}** área"
        f"{'' if len(counts) == 1 else 's'} distintas "
        f"(**{total:,}** registros en total).\n\n"
        "Las de mayor concentración son:\n\n"
        + "\n".join(lines)
        + "\n\nEl ranking completo está en el visor derecho. "
        "Dime el nombre de un área para ver su detalle, o pide filtrar por persona."
    )
    return text, []


def _try_area_total_fast(message: str) -> tuple[str, list[dict]] | None:
    """Resuelve 'total/cuántos de [área]' sin LLM cuando se puede emparejar el área."""
    import re
    import unicodedata

    from inventario.supabase_client import list_por_campo, read_inventario

    raw = (message or "").strip()
    if not raw:
        return None

    def norm(s: str) -> str:
        s = unicodedata.normalize("NFD", s.lower())
        s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
        s = re.sub(r"[^a-z0-9\s]", " ", s)
        return re.sub(r"\s+", " ", s).strip()

    msg = norm(raw)
    wants_total = any(
        k in msg
        for k in (
            "cuantos",
            "cuantas",
            "cuanto",
            "cuanta",
            "total",
            "totales",
            "conteo",
            "hay",
        )
    )
    if not wants_total:
        return None
    # No mezclar con "cuántas áreas hay / en total".
    if re.search(r"\b(cuantas?|cuantos?)\s+areas?\b", msg) or re.search(
        r"\bareas?\s+(hay|existen|en\s+total|del\s+inventario)\b",
        msg,
    ):
        return None
    if ("todas" in msg or "todos" in msg) and ("area" in msg or "areas" in msg):
        return None

    rows, error, _ = read_inventario()
    if error or not rows:
        return None

    areas = sorted(
        {
            str(r.get("area") or "").strip()
            for r in rows
            if str(r.get("area") or "").strip()
        },
        key=len,
        reverse=True,
    )
    best: str | None = None
    best_score = 0
    for area in areas:
        an = norm(area)
        if not an:
            continue
        if an in msg and len(an) >= best_score:
            best = area
            best_score = len(an)
            continue
        tokens = [t for t in an.split() if len(t) > 2]
        if tokens and all(t in msg for t in tokens) and len("".join(tokens)) > best_score:
            best = area
            best_score = len("".join(tokens))

    if not best:
        return None
    if not any(k in msg for k in ("area", "areas", " en ", " del ", " de ")):
        # Exige pista de área / preposición para no confundir totales globales.
        if "area" not in msg and "areas" not in msg:
            # "total de recursos humanos" usa "de "
            if " de " not in f" {msg} " and " en " not in f" {msg} ":
                return None

    sample, _ = list_por_campo("area", best, limit=12)
    total = sum(
        1
        for r in rows
        if str(r.get("area") or "").strip().lower() == best.strip().lower()
    )
    personas = {
        str(r.get("persona") or "").strip()
        for r in rows
        if str(r.get("area") or "").strip().lower() == best.strip().lower()
        and str(r.get("persona") or "").strip()
    }
    activos = sum(
        1
        for r in rows
        if str(r.get("area") or "").strip().lower() == best.strip().lower()
        and str(r.get("estado") or "").strip().lower()
        not in {"inactivo", "baja", "no", "inactive"}
    )
    text = (
        f"En **{best}** hay **{total}** registro{'s' if total != 1 else ''}: "
        f"**{len(personas)}** persona{'s' if len(personas) != 1 else ''} y "
        f"**{activos}** activo{'s' if activos != 1 else ''}.\n\n"
        "El detalle está en el visor derecho.\n\n"
        "¿Quieres ver los artículos del área, filtrar por persona o generar QR de un lote?"
    )
    return text, sample or []


def run_chat_agent(
    message: str,
    history: list[dict] | None = None,
    memory: str | None = None,
    preferred_model: str | None = None,
) -> tuple[str, str | None, str | None, list[dict], bool, list[dict], dict]:
    from inventario.ai.usage import empty_usage

    endpoints = get_llm_endpoints()
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

    memory_text = (memory or "").strip()
    if len(memory_text) > MAX_MEMORY_CHARS:
        memory_text = memory_text[: MAX_MEMORY_CHARS - 1] + "…"

    # Preferir agente pydantic-ai + tools (lecturas ancladas a Supabase).
    try:
        from inventario.ai.tool_agent import run_tool_agent

        reply, error, used, items, mutated, qr_list, usage = run_tool_agent(
            message,
            history,
            memory_text,
            preferred_model=preferred_model,
        )
        if error not in ("tool_agent_import", "tool_agent_build"):
            return reply, error, used, items, mutated, qr_list, usage
    except Exception:  # noqa: BLE001
        pass

    # Acuses sin pedido concreto: solo texto, sin items/QR.
    msg_l = (message or "").strip().lower().rstrip("!?.")
    if msg_l in {
        "ok",
        "okay",
        "okey",
        "oke",
        "vale",
        "va",
        "sale",
        "bueno",
        "bien",
        "gracias",
        "thanks",
        "de acuerdo",
        "perfecto",
        "listo",
        "entendido",
        "claro",
        "dale",
        "esta bien",
        "está bien",
    }:
        return (
            pick_ack_reply(),
            None,
            "local:ack",
            [],
            False,
            [],
            empty_usage(),
        )

    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    if memory_text:
        messages.append(
            {
                "role": "system",
                "content": memory_text,
            }
        )
    recent_history = (history or [])[-MAX_HISTORY_TURNS:]
    for item in recent_history:
        role = str(item.get("role") or "").strip().lower()
        text = str(item.get("content") or item.get("text") or "").strip()
        if not text:
            continue
        if len(text) > MAX_HISTORY_CHARS:
            text = text[: MAX_HISTORY_CHARS - 1] + "…"
        if role in ("assistant", "bot", "model"):
            messages.append({"role": "assistant", "content": text})
        elif role in ("user", "human"):
            messages.append({"role": "user", "content": text})
    messages.append({"role": "user", "content": message})

    collected: list[dict] = []
    qr_payloads: list[dict] = []
    used_label: str | None = None
    mutated = False

    try:
        for _ in range(MAX_TOOL_ROUNDS):
            completion, used_label = _chat_with_failover(
                messages, preferred_model=preferred_model
            )
            choice = completion.choices[0].message
            tool_calls = choice.tool_calls or []

            if not tool_calls:
                text = (choice.content or "").strip()
                side = _side_items_for_reply(collected, qr_payloads)
                if not text:
                    # Evita respuesta vacía: intenta atajos locales / fallback.
                    areas_retry = _try_areas_count_fast(message)
                    if areas_retry is not None:
                        t2, items2 = areas_retry
                        return (
                            t2,
                            None,
                            f"{used_label}+local:areas-count",
                            (items2 or side)[:MAX_SIDE_ITEMS],
                            mutated,
                            qr_payloads,
                            empty_usage(),
                        )
                    local_text, local_items = local_chat_answer(message)
                    if local_text and not local_text.startswith("No encontré coincidencias"):
                        return (
                            local_text,
                            None,
                            f"{used_label}+local_fallback",
                            (local_items or side)[:MAX_SIDE_ITEMS],
                            mutated,
                            qr_payloads,
                            empty_usage(),
                        )
                    return (
                        "Me faltó un dato para responder con precisión. "
                        "¿Me confirmas si quieres el **total de áreas del inventario**, "
                        "el detalle de un **área concreta**, o el inventario de una **persona**?",
                        "empty_text",
                        used_label,
                        side,
                        mutated,
                        qr_payloads,
                        empty_usage(),
                    )
                return (
                    text,
                    None,
                    used_label,
                    side,
                    mutated,
                    qr_payloads,
                    empty_usage(),
                )

            messages.append(
                {
                    "role": "assistant",
                    "content": choice.content or "",
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.function.name,
                                "arguments": tc.function.arguments or "{}",
                            },
                        }
                        for tc in tool_calls
                    ],
                }
            )

            for tc in tool_calls:
                name = tc.function.name
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    args = {}
                if not isinstance(args, dict):
                    args = {}
                result = run_tool(name, args)
                if isinstance(result, dict):
                    if result.get("mutated"):
                        mutated = True
                    _collect_items(collected, result)
                    _collect_qr(qr_payloads, result)
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": dump_tool_result(result),
                    }
                )

        low = (message or "").lower()
        if "inventario" in low and any(
            w in low
            for w in ("pasa", "mete", "copia", "importa", "intenta", "omit", "aver")
        ):
            return (
                "Para copiar entre inventarios prueba: "
                "«pasa todo Inventario 1 a Inventario 3 omitiendo las que ya existan». "
                "Solo la **etiqueta** es única por inventario; la **serie** sí se puede repetir.",
                None,
                used_label,
                _side_items_for_reply(collected, qr_payloads),
                mutated,
                qr_payloads,
                empty_usage(),
            )
        return (
            "No terminé esa consulta a tiempo. Reformúlala en una sola frase concreta "
            "(ej. persona, área, etiqueta o «Inventario 1 a Inventario 3»).",
            "max_tool_rounds",
            used_label,
            _side_items_for_reply(collected, qr_payloads),
            mutated,
            qr_payloads,
            empty_usage(),
        )
    except Exception as exc:  # noqa: BLE001
        text = str(exc)
        if text.startswith("llm_unavailable:") or text == "missing_providers" or _is_retryable(exc):
            return (
                "OpenAI no respondió. Reintento en unos segundos…",
                "llm_unavailable",
                used_label,
                _side_items_for_reply(collected, qr_payloads),
                mutated,
                qr_payloads,
                empty_usage(),
            )
        return (
            f"Error al consultar la IA: {exc}",
            str(exc),
            used_label,
            _side_items_for_reply(collected, qr_payloads),
            mutated,
            qr_payloads,
            empty_usage(),
        )
