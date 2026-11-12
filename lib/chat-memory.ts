export type ChatMemoryEventKind =
  | "import"
  | "create"
  | "update"
  | "delete"
  | "total_snapshot";

export type ChatMemoryEvent = {
  id: string;
  at: string;
  kind: ChatMemoryEventKind;
  summary: string;
  totalBefore?: number;
  totalAfter?: number;
  count?: number;
  ids?: number[];
  chatId?: string | null;
};

export type ChatFieldChange = {
  at: string;
  id?: number | null;
  etiqueta?: string | null;
  articulo?: string | null;
  field: string;
  oldValue: string;
  newValue: string;
  chatId?: string | null;
};

export type ChatMemory = {
  updatedAt: string;
  lastTotal?: number;
  previousTotal?: number;
  events: ChatMemoryEvent[];
  facts: string[];
  lastFieldChange?: ChatFieldChange | null;
};

const MEMORY_KEY = "inventario-chat-memory";
const MAX_EVENTS = 40;
const MAX_FACTS = 24;

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function loadChatMemory(): ChatMemory {
  try {
    const raw = window.localStorage.getItem(MEMORY_KEY);
    if (!raw) {
      return { updatedAt: nowIso(), events: [], facts: [] };
    }
    const parsed = JSON.parse(raw) as ChatMemory;
    return {
      updatedAt: parsed.updatedAt || nowIso(),
      lastTotal:
        typeof parsed.lastTotal === "number" ? parsed.lastTotal : undefined,
      previousTotal:
        typeof parsed.previousTotal === "number"
          ? parsed.previousTotal
          : undefined,
      events: Array.isArray(parsed.events) ? parsed.events.slice(0, MAX_EVENTS) : [],
      facts: Array.isArray(parsed.facts) ? parsed.facts.slice(0, MAX_FACTS) : [],
      lastFieldChange: parsed.lastFieldChange || null,
    };
  } catch {
    return { updatedAt: nowIso(), events: [], facts: [] };
  }
}

export function saveChatMemory(memory: ChatMemory) {
  try {
    window.localStorage.setItem(
      MEMORY_KEY,
      JSON.stringify({
        ...memory,
        updatedAt: nowIso(),
        events: memory.events.slice(0, MAX_EVENTS),
        facts: memory.facts.slice(0, MAX_FACTS),
      }),
    );
  } catch {
    /* quota / private mode */
  }
}

function pushFact(facts: string[], fact: string): string[] {
  const clean = fact.trim();
  if (!clean) return facts;
  const next = [clean, ...facts.filter((f) => f !== clean)];
  return next.slice(0, MAX_FACTS);
}

export function rememberTotalSnapshot(
  total: number,
  opts?: { chatId?: string | null; note?: string },
): ChatMemory {
  const mem = loadChatMemory();
  if (mem.lastTotal === total) {
    return mem;
  }
  const previousTotal =
    typeof mem.lastTotal === "number" ? mem.lastTotal : mem.previousTotal;
  const event: ChatMemoryEvent = {
    id: makeId(),
    at: nowIso(),
    kind: "total_snapshot",
    summary: opts?.note || `Total inventario registrado: ${total}`,
    totalBefore: previousTotal,
    totalAfter: total,
    chatId: opts?.chatId ?? null,
  };
  const next: ChatMemory = {
    ...mem,
    updatedAt: nowIso(),
    previousTotal,
    lastTotal: total,
    events: [event, ...mem.events].slice(0, MAX_EVENTS),
    facts: pushFact(
      mem.facts,
      `Último total conocido: ${total}${
        typeof previousTotal === "number" ? ` (antes ${previousTotal})` : ""
      }`,
    ),
  };
  saveChatMemory(next);
  return next;
}

export function rememberMutation(input: {
  kind: Exclude<ChatMemoryEventKind, "total_snapshot">;
  summary: string;
  totalBefore: number;
  totalAfter: number;
  count?: number;
  ids?: number[];
  chatId?: string | null;
  fact?: string;
}): ChatMemory {
  const mem = loadChatMemory();
  const event: ChatMemoryEvent = {
    id: makeId(),
    at: nowIso(),
    kind: input.kind,
    summary: input.summary,
    totalBefore: input.totalBefore,
    totalAfter: input.totalAfter,
    count: input.count,
    ids: input.ids?.slice(0, 20),
    chatId: input.chatId ?? null,
  };
  let facts = pushFact(
    mem.facts,
    input.fact ||
      `${input.summary} · antes ${input.totalBefore} → ahora ${input.totalAfter}`,
  );
  facts = pushFact(facts, `Último total conocido: ${input.totalAfter}`);
  const next: ChatMemory = {
    ...mem,
    updatedAt: nowIso(),
    previousTotal: input.totalBefore,
    lastTotal: input.totalAfter,
    events: [event, ...mem.events].slice(0, MAX_EVENTS),
    facts,
  };
  saveChatMemory(next);
  return next;
}

export function rememberFieldChange(input: {
  id?: number | null;
  etiqueta?: string | null;
  articulo?: string | null;
  field: string;
  oldValue: string;
  newValue: string;
  chatId?: string | null;
}): ChatMemory {
  const mem = loadChatMemory();
  const change: ChatFieldChange = {
    at: nowIso(),
    id: input.id ?? null,
    etiqueta: input.etiqueta ?? null,
    articulo: input.articulo ?? null,
    field: input.field,
    oldValue: input.oldValue,
    newValue: input.newValue,
    chatId: input.chatId ?? null,
  };
  const label = input.etiqueta || (input.id != null ? `id ${input.id}` : "registro");
  const fact = `Último cambio de campo: ${label} · ${input.field}: “${input.oldValue}” → “${input.newValue}”`;
  const event: ChatMemoryEvent = {
    id: makeId(),
    at: change.at,
    kind: "update",
    summary: fact,
    ids: input.id != null ? [Number(input.id)] : undefined,
    chatId: input.chatId ?? null,
  };
  const next: ChatMemory = {
    ...mem,
    updatedAt: nowIso(),
    lastFieldChange: change,
    events: [event, ...mem.events].slice(0, MAX_EVENTS),
    facts: pushFact(mem.facts, fact),
  };
  saveChatMemory(next);
  return next;
}

/** Texto corto para el LLM / respuestas locales (válido entre chats). */
export function formatChatMemoryForPrompt(memory?: ChatMemory | null): string {
  const mem = memory || (typeof window !== "undefined" ? loadChatMemory() : null);
  if (!mem) return "";
  const lines: string[] = [];

  if (mem.lastFieldChange) {
    const c = mem.lastFieldChange;
    const label = c.etiqueta || (c.id != null ? `id ${c.id}` : "registro");
    lines.push(
      `ÚLTIMO CAMBIO DE CAMPO (prioridad alta): ${label}${c.articulo ? ` — ${c.articulo}` : ""}.`,
    );
    lines.push(
      `Campo ${c.field}: valor ANTERIOR “${c.oldValue}” → valor ACTUAL “${c.newValue}”.`,
    );
    lines.push(
      `Si piden volver / restaurar / “el nombre de antes” / “como estaba”: usa el valor ANTERIOR “${c.oldValue}” en ese registro.`,
    );
  }

  if (typeof mem.lastTotal === "number") {
    lines.push(`Total actual recordado: ${mem.lastTotal}.`);
  }
  if (typeof mem.previousTotal === "number") {
    lines.push(`Total de inventario anterior (tras import/alta): ${mem.previousTotal}.`);
  }
  for (const fact of mem.facts.slice(0, 8)) {
    lines.push(`• ${fact}`);
  }
  for (const ev of mem.events.slice(0, 6)) {
    const when = ev.at ? ev.at.slice(0, 16).replace("T", " ") : "";
    const delta =
      typeof ev.totalBefore === "number" && typeof ev.totalAfter === "number"
        ? ` (${ev.totalBefore}→${ev.totalAfter})`
        : "";
    lines.push(`• [${when}] ${ev.summary}${delta}`);
  }
  if (!lines.length) return "";
  return [
    "Memoria persistente del inventario (compartida entre chats):",
    ...lines,
    "No confundas “nombre/persona de antes” (cambio de campo) con “cuántos registros había” (totales).",
    "El total ACTUAL del sistema se confirma con tools si piden un número oficial.",
  ].join("\n");
}

export function buildCrossChatHistorySnippet(
  sessions: Array<{
    id: string;
    title?: string;
    updatedAt?: string;
    messages: Array<{ from: string; text: string }>;
  }>,
  activeChatId: string | null,
  limitSessions = 3,
  limitMsgs = 4,
): Array<{ role: "user" | "assistant"; content: string }> {
  const others = sessions
    .filter((s) => s.id && s.id !== activeChatId && Array.isArray(s.messages))
    .slice(0, limitSessions);

  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const session of others) {
    const title = (session.title || "Chat previo").slice(0, 60);
    const useful = session.messages
      .filter((m) => m.text?.trim() && !/^consultando el inventario/i.test(m.text))
      .slice(-limitMsgs);
    if (!useful.length) continue;
    out.push({
      role: "user",
      content: `[Contexto de otro chat: “${title}”]`,
    });
    for (const m of useful) {
      const role = m.from === "user" ? "user" : "assistant";
      const content =
        m.text.length > 280 ? `${m.text.slice(0, 279)}…` : m.text;
      out.push({ role, content });
    }
  }
  return out.slice(0, 14);
}

function parseFieldChangeFromBotText(text: string): ChatFieldChange | null {
  const fieldMatch = text.match(
    /(Persona|Área|Area|Artículo|Articulo|Marca|Modelo|Serie|Estado|Etiqueta|Observaciones)\s*:\s*(?:~~([^~]+)~~|([^→\n*]+))\s*(?:→|->)\s*\*{0,2}([^*\n]+)\*{0,2}/i,
  );
  if (!fieldMatch) return null;
  const fieldRaw = fieldMatch[1].toLowerCase();
  const fieldMap: Record<string, string> = {
    persona: "persona",
    área: "area",
    area: "area",
    artículo: "articulo",
    articulo: "articulo",
    marca: "marca",
    modelo: "modelo",
    serie: "serie",
    estado: "estado",
    etiqueta: "etiqueta",
    observaciones: "observaciones",
  };
  const field = fieldMap[fieldRaw] || fieldRaw;
  const oldValue = String(fieldMatch[2] || fieldMatch[3] || "")
    .replace(/\*+/g, "")
    .trim();
  const newValue = String(fieldMatch[4] || "")
    .replace(/\*+/g, "")
    .trim();
  if (!oldValue || !newValue || oldValue === newValue) return null;

  const etiquetaMatch =
    text.match(/etiqueta\s+\*{0,2}([A-Za-z0-9/_-]+)\*{0,2}/i) ||
    text.match(/Registro\s+(\d+)/i);
  const idMatch = text.match(/\(ID\s+(\d+)\)/i);
  const articuloMatch = text.match(/[—\-–]\s*([^\n]+)/);

  return {
    at: nowIso(),
    id: idMatch ? Number(idMatch[1]) : null,
    etiqueta: etiquetaMatch?.[1] || null,
    articulo: articuloMatch?.[1]?.trim() || null,
    field,
    oldValue,
    newValue,
  };
}

/** Recupera “antes/después” desde historiales ya guardados (una sola vez si falta). */
export function hydrateMemoryFromChatSessions(
  sessions: Array<{
    id: string;
    messages: Array<{ from: string; text: string; at?: number }>;
  }>,
  currentTotal: number,
): ChatMemory {
  let mem = loadChatMemory();

  if (!mem.lastFieldChange) {
    for (const session of sessions) {
      for (let i = session.messages.length - 1; i >= 0; i -= 1) {
        const message = session.messages[i];
        if (message.from !== "bot" || !message.text) continue;
        if (!/(→|->|~~)/.test(message.text)) continue;
        const change = parseFieldChangeFromBotText(message.text);
        if (change) {
          mem = rememberFieldChange({
            ...change,
            chatId: session.id,
          });
          break;
        }
      }
      if (loadChatMemory().lastFieldChange) break;
    }
  }

  mem = loadChatMemory();
  if (
    typeof mem.previousTotal === "number" &&
    mem.events.some((e) => e.kind === "import" || e.kind === "create")
  ) {
    if (typeof mem.lastTotal !== "number" && currentTotal > 0) {
      const next = { ...mem, lastTotal: currentTotal };
      saveChatMemory(next);
      return next;
    }
    return mem;
  }

  let inferredBefore: number | undefined;
  let inferredCount = 0;
  let inferredSummary = "";
  let chatId: string | null = null;

  for (const session of sessions) {
    for (const message of session.messages) {
      if (message.from !== "bot" || !message.text) continue;
      const text = message.text;
      const importMatch = text.match(/import[eé]\s+(\d+)\s+art[ií]culo/i);
      const createMatch = text.match(
        /(?:registr|cre)\w*\s+(\d+)\s+(?:registros?|art[ií]culos?|filas?)/i,
      );
      const idsMatch = text.match(/ids?\s+(\d+)\s*[–\-—]\s*(\d+)/i);
      const count = Number(importMatch?.[1] || createMatch?.[1] || 0);
      if (count > 0 && currentTotal >= count) {
        inferredBefore = currentTotal - count;
        inferredCount = count;
        inferredSummary = importMatch
          ? `Importación recuperada del historial: +${count}`
          : `Altas recuperadas del historial: +${count}`;
        chatId = session.id;
        if (idsMatch) {
          inferredSummary += ` (ids ${idsMatch[1]}–${idsMatch[2]})`;
        }
      }
    }
  }

  if (inferredBefore == null && currentTotal > 0) {
    const next: ChatMemory = {
      ...mem,
      lastTotal: currentTotal,
      updatedAt: nowIso(),
      facts: pushFact(mem.facts, `Último total conocido: ${currentTotal}`),
    };
    saveChatMemory(next);
    return next;
  }

  if (inferredBefore == null) return mem;

  return rememberMutation({
    kind: inferredSummary.toLowerCase().includes("import")
      ? "import"
      : "create",
    summary: inferredSummary || `Cambio recuperado del historial (+${inferredCount})`,
    totalBefore: inferredBefore,
    totalAfter: currentTotal,
    count: inferredCount,
    chatId,
    fact: `Recuperado entre chats: antes ${inferredBefore} → ahora ${currentTotal} (+${inferredCount})`,
  });
}

/** ¿Pide restaurar el valor/nombre anterior de un campo? */
export function looksLikeRevertPreviousValue(question: string): boolean {
  const q = question.trim().toLowerCase();
  if (!q) return false;
  if (
    /\b(cu[aá]ntos?|total|totales|registros?|inventario)\b/.test(q) &&
    /\b(antes|hab[ií]a|anterior)\b/.test(q) &&
    !/\b(nombre|persona|campo|valor|como estaba|conten[ií]a)\b/.test(q)
  ) {
    return false;
  }
  return (
    /\b(vuelve|volver|regresa|regresar|restaura|restaurar|revierte|revertir|deshaz|deshacer|cambia|cambiar|pon|poner|deja|dejar)\b/.test(
      q,
    ) &&
    /\b(antes|anterior|previo|original|conten[ií]a|ten[ií]a|como estaba|el de antes|la de antes)\b/.test(
      q,
    )
  );
}

export function answerFromMemoryAboutBefore(
  question: string,
  memory?: ChatMemory | null,
): string | null {
  const q = question.trim().toLowerCase();
  // No interceptar pedidos de restaurar nombre/persona/campo.
  if (looksLikeRevertPreviousValue(q)) return null;
  if (
    /\b(nombre|persona|campo|valor|conten[ií]a|ten[ií]a|como estaba)\b/.test(q) &&
    /\b(antes|anterior|previo)\b/.test(q)
  ) {
    return null;
  }

  const asksTotalBefore =
    /\b(cu[aá]ntos?\s+(hab[ií]a|habia)|qu[eé]\s+hab[ií]a|total(es)?\s+(antes|anterior|previo)|antes\s+del\s+(import|cambio|alta)|hab[ií]a\s+antes|registros?\s+antes)\b/i.test(
      q,
    ) ||
    (/^\s*(y\s+)?(antes|el\s+anterior|totales?\s+anteriores?)\s*\??\s*$/i.test(q) &&
      !/\b(nombre|persona)\b/.test(q));

  if (!asksTotalBefore) return null;

  const mem = memory || (typeof window !== "undefined" ? loadChatMemory() : null);
  if (!mem) return null;

  const lastImport = mem.events.find((e) => e.kind === "import" || e.kind === "create");
  const parts: string[] = [];

  if (typeof mem.previousTotal === "number" && typeof mem.lastTotal === "number") {
    parts.push(
      `Según la memoria compartida entre chats, antes del último cambio de inventario había **${mem.previousTotal}** registros y ahora hay **${mem.lastTotal}**.`,
    );
  } else if (typeof mem.previousTotal === "number") {
    parts.push(
      `El total anterior que tengo registrado es **${mem.previousTotal}**.`,
    );
  } else if (typeof mem.lastTotal === "number") {
    parts.push(
      `Tengo el total actual en memoria (**${mem.lastTotal}**), pero aún no guardé un “antes” verificable de un cambio previo.`,
    );
  }

  if (lastImport) {
    const when = lastImport.at?.slice(0, 16).replace("T", " ") || "";
    parts.push(
      `Último movimiento de inventario: ${lastImport.summary}${when ? ` (${when})` : ""}.`,
    );
  }

  if (!parts.length) {
    return "Todavía no tengo memoria de un total anterior entre chats. Cuando importes o registres algo, guardaré el “antes” y el “después” para la próxima vez.";
  }

  parts.push(
    "Esta memoria se comparte entre chats de este navegador. Si quieres, también puedo volver a contar el total actual en la base.",
  );
  return parts.join("\n\n");
}

/** Si falta lastFieldChange, intenta recuperarlo del historial del chat. */
export function ensureLastFieldChangeFromMessages(
  messages: Array<{ from: string; text: string }>,
): ChatMemory {
  const mem = loadChatMemory();
  if (mem.lastFieldChange) return mem;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.from !== "bot" && message.from !== "assistant") continue;
    if (!/(→|->|~~)/.test(message.text || "")) continue;
    const change = parseFieldChangeFromBotText(message.text || "");
    if (change) return rememberFieldChange(change);
  }
  return mem;
}

function describeLastFieldChange(
  memory?: ChatMemory | null,
): string | null {
  const mem = memory || (typeof window !== "undefined" ? loadChatMemory() : null);
  const c = mem?.lastFieldChange;
  if (!c) return null;
  const label = c.etiqueta || (c.id != null ? `id ${c.id}` : "el registro");
  return (
    `El último cambio que guardé fue en **${label}**` +
    `${c.articulo ? ` (${c.articulo})` : ""}: ` +
    `**${c.field}** pasó de “**${c.oldValue}**” a “**${c.newValue}**”.`
  );
}

/** Resumen claro antes de mutar: etiqueta · campo · de → a */
export function formatMutationConfirmLines(
  changes: Array<{
    etiqueta?: string | null;
    field: string;
    oldValue: string;
    newValue: string;
  }>,
): string {
  return changes
    .map((c) => {
      const etq = String(c.etiqueta || "S/E").trim() || "S/E";
      return `• **${etq}** · **${c.field}** · “${c.oldValue}” → “${c.newValue}”`;
    })
    .join("\n");
}

export function buildMutationConfirmReply(
  changes: Array<{
    etiqueta?: string | null;
    field: string;
    oldValue: string;
    newValue: string;
  }>,
): string {
  if (!changes.length) {
    return "No hay cambios pendientes. Indica etiqueta, campo y el valor nuevo.";
  }
  return (
    `Voy a aplicar estos cambios:\n\n` +
    `${formatMutationConfirmLines(changes)}\n\n` +
    `¿Confirmas? Responde **sí** para aplicarlos o **no** para cancelar.`
  );
}

export function buildRevertProposalReply(
  memory?: ChatMemory | null,
): string | null {
  const mem = memory || (typeof window !== "undefined" ? loadChatMemory() : null);
  const c = mem?.lastFieldChange;
  if (!c) {
    return "No tengo en memoria un cambio de campo reciente para restaurar. Indícame la etiqueta y el valor que quieres volver a poner.";
  }
  return (
    `${describeLastFieldChange(mem)}\n\n` +
    `Propuesta de restauración:\n\n` +
    `${formatMutationConfirmLines([
      {
        etiqueta: c.etiqueta,
        field: c.field,
        oldValue: c.newValue,
        newValue: c.oldValue,
      },
    ])}\n\n` +
    `¿Confirmas? Responde **sí** para aplicarlo.`
  );
}
