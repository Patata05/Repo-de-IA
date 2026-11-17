/**
 * Continuidad del hilo: lee mensajes de arriba para saber de qué hablamos
 * y completar turns cortos / afirmaciones / acotaciones.
 */
import {
  looksLikeTransferVerb,
  normalizeChatSpelling,
} from "@/lib/chat-spell";

export type ChatTopicKind =
  | "duplicates"
  | "compare"
  | "fill_inventario"
  | "create_inventario"
  | "etiqueta_origen"
  | "area"
  | "person"
  | "unknown";

export type ChatHistoryMsg = {
  from: string;
  text: string;
};

export type ResolvedChatTurn = {
  /** Texto enriquecido con contexto del hilo (para detectores locales). */
  effectiveText: string;
  topic: ChatTopicKind;
  /** Primer mensaje de usuario de este chat. */
  isFirstUserTurn: boolean;
  fromContext: boolean;
  /** Pista corta para el LLM. */
  threadHint: string;
  /** Etiquetas vistas en el hilo (arriba). */
  threadEtiquetas: string[];
};

function fold(raw: string): string {
  return normalizeChatSpelling(raw);
}

function inventariosInText(text: string): string[] {
  const n = fold(text);
  const out: string[] = [];
  const re =
    /\b(?:(?:al)?inventari[oa]?s?|alnventario)\s*(\d+|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/g;
  const wordNum: Record<string, number> = {
    uno: 1,
    una: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
    siete: 7,
    ocho: 8,
    nueve: 9,
    diez: 10,
  };
  for (const m of n.matchAll(re)) {
    const raw = m[1];
    const num = /^\d+$/.test(raw) ? Number(raw) : wordNum[raw];
    if (!num || !Number.isFinite(num)) continue;
    const label = `Inventario ${num}`;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

/** Etiquetas citadas en texto (markdown **283586**, “etiqueta 283586”, códigos). */
export function extractEtiquetasFromThreadText(text: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const tag = String(raw || "").trim();
    if (!tag || /^\d{1,3}$/.test(tag)) return;
    if (/^inventario/i.test(tag)) return;
    const key = tag.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(tag);
  };
  for (const m of String(text || "").matchAll(
    /etiqueta\s+\*{0,2}([A-Za-z0-9/_-]{3,})\*{0,2}/gi,
  )) {
    push(m[1]);
  }
  for (const m of String(text || "").matchAll(
    /\*\*([A-Za-z]{0,10}[-_/]?[A-Za-z0-9]*\d{3,10})\*\*/g,
  )) {
    push(m[1]);
  }
  for (const m of String(text || "").matchAll(
    /\b([A-Za-z]{1,8}[-_/][A-Za-z0-9]{2,}|[A-Za-z]{1,6}\d{3,10}|\d{4,12})\b/g,
  )) {
    // Solo si el entorno habla de etiqueta / inventario / ficha
    if (/\betiqueta|ficha|inventario|copiad|import/i.test(text)) {
      push(m[1]);
    }
  }
  return tags;
}

function etiquetasFromMessages(messages: ChatHistoryMsg[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // De más reciente a más viejo (sin el user actual).
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    for (const t of extractEtiquetasFromThreadText(m.text || "")) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function detectTopicFromText(text: string): ChatTopicKind {
  const n = fold(text);
  if (!n) return "unknown";
  if (/\b(duplicadas?|duplicados?|repetidas?|repetidos?)\b/.test(n)) {
    return "duplicates";
  }
  if (/\b(compara|comparar|comparacion|diff|diferencia)\b/.test(n)) {
    return "compare";
  }
  if (
    /\b(crea|crear|haz|hacer|has|abre|abrir)\b/.test(n) &&
    /\bnuevo\s+inventario\b|\binventari[oa]?s?\s*\d+\b/.test(n)
  ) {
    return "create_inventario";
  }
  if (
    (/\betiqueta/.test(n) || /\b\d{4,}\b/.test(n)) &&
    (/\b(origen|fuente|venia|vino|antes|de que inventario|que inventario|en que inventario)\b/.test(
      n,
    ) ||
      (/\binventari/.test(n) &&
        /\b(encuentra|aparece|esta|estan|donde|ubicad)\b/.test(n)))
  ) {
    return "etiqueta_origen";
  }
  // “pasa / importa / agrega … inventario …”
  if (
    looksLikeTransferVerb(n) &&
    (/\binventari/.test(n) || /\balnventario\b/.test(n))
  ) {
    return "fill_inventario";
  }
  if (/\b(area|areas|edif)\b/.test(n)) return "area";
  if (/\b(persona|personas|quien|quienes)\b/.test(n)) return "person";
  return "unknown";
}

function isAffirm(text: string): boolean {
  const n = fold(text);
  return (
    /^(si|sí|yes|ok|okay|vale|dale|claro|listo|de acuerdo|hazlo|adelante|por favor|please|aver|a ver|okey)\b/.test(
      n,
    ) || /^(si|sí|ok|dale|claro)\s*[,.]?\s*$/.test(n)
  );
}

function isNarrowOnly(text: string): boolean {
  const n = fold(text);
  return (
    /\b(solo|solamente|unicamente|únicamente|nada mas|nada más)\b/.test(n) &&
    /\binventarios?\s*\d+\b/.test(n)
  );
}

function looksLikeEtiquetaAnaphora(text: string): boolean {
  const n = fold(text);
  return (
    /\b(esa|ese|eso|esta|este|esa etiqueta|ese etiqueta|la etiqueta|el registro|esa ficha|agregala|agregalo|pasala|pasalo|copiala|metela|añadela|añadelo)\b/.test(
      n,
    ) || /\b(la|lo)\s+(misma|mismo)\b/.test(n)
  );
}

function lastBotMessage(messages: ChatHistoryMsg[]): ChatHistoryMsg | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].from === "bot" && String(messages[i].text || "").trim()) {
      return messages[i];
    }
  }
  return null;
}

function firstUserMessage(messages: ChatHistoryMsg[]): ChatHistoryMsg | null {
  for (const m of messages) {
    if (m.from === "user" && String(m.text || "").trim()) return m;
  }
  return null;
}

/**
 * Une el mensaje actual con el hilo (pregunta del bot / tema previo).
 * Las etiquetas solo se toman del mensaje actual del usuario (nunca del bot).
 */
export function resolveChatTurnContext(input: {
  userText: string;
  /** Mensajes YA en el chat (incluye el user actual si ya se empujó). */
  recentMessages: ChatHistoryMsg[];
}): ResolvedChatTurn {
  const raw = String(input.userText || "").trim();
  const messages = input.recentMessages || [];
  const userCount = messages.filter((m) => m.from === "user").length;
  const isFirstUserTurn = userCount <= 1;

  const historyWithoutCurrent =
    messages[messages.length - 1]?.from === "user"
      ? messages.slice(0, -1)
      : messages;

  const spelled = fold(raw);
  const directTopic = detectTopicFromText(raw);
  const lastBot = lastBotMessage(historyWithoutCurrent);
  const firstUser = firstUserMessage(historyWithoutCurrent);
  const botTopic = lastBot ? detectTopicFromText(lastBot.text) : "unknown";
  const botInvs = lastBot ? inventariosInText(lastBot.text) : [];
  const userInvs = inventariosInText(raw);
  // SOLO mensaje actual del usuario (nunca del asistente ni del hilo bot).
  const threadEtiquetas = extractEtiquetasFromThreadText(raw);

  let effectiveText = raw;
  let topic: ChatTopicKind = directTopic !== "unknown" ? directTopic : botTopic;
  let fromContext = false;

  const wantsOmit =
    /\b(omite|omitir|excluye|excluir|salta|saltar|excepto|menos)\b/.test(spelled) ||
    /\bno\s+(copies|copie|importes|importe|pases|pase|agregues|agregue)\b/.test(
      spelled,
    );

  // “omite esa e importa Inventario 2 → 3” — solo si el usuario ya citó la etiqueta.
  if (
    wantsOmit &&
    looksLikeTransferVerb(spelled) &&
    userInvs.length >= 1 &&
    threadEtiquetas[0]
  ) {
    const tag = threadEtiquetas[0];
    const dest = userInvs[userInvs.length - 1];
    const source =
      userInvs.length >= 2
        ? userInvs[0]
        : botInvs.find((i) => i !== dest) || inventariosInText(lastBot?.text || "")[0];
    if (dest && source && source !== dest) {
      effectiveText = `omite etiqueta ${tag} e importa todos los registros de ${source} a ${dest}`;
      topic = "fill_inventario";
      fromContext = true;
    } else if (dest) {
      effectiveText = `omite etiqueta ${tag} e importa el resto a ${dest}`;
      topic = "fill_inventario";
      fromContext = true;
    }
  }

  // “todos los demás inventarios / todos los registros” ≠ anáfora de 1 etiqueta.
  const wantsAllOthersMerge =
    /\b(todos?\s+los\s+demas|todas?\s+las\s+demas|todos?\s+los\s+otros|resto\s+de\s+(los\s+)?inventarios|demas\s+inventarios|otros\s+inventarios)\b/.test(
      spelled,
    ) ||
    (/\b(todos?|todas?)\b/.test(spelled) &&
      /\b(demas|otros|otras|resto)\b/.test(spelled) &&
      /\b(inventarios?|registros?|regsitros|etiquetas?)\b/.test(spelled)) ||
    (/\b(todos?\s+los\s+registros?|todas?\s+las\s+etiquetas?|todo\s+el\s+inventario)\b/.test(
      spelled,
    ) &&
      /\b(demas|otros|inventarios?)\b/.test(spelled));

  // “agrega esa etiqueta …” solo si el usuario ya escribió el código en ESTE mensaje.
  // Prohibido tomar etiquetas de mensajes del asistente.
  if (
    !fromContext &&
    !wantsOmit &&
    !wantsAllOthersMerge &&
    looksLikeTransferVerb(spelled) &&
    userInvs.length >= 1 &&
    threadEtiquetas[0] &&
    looksLikeEtiquetaAnaphora(spelled)
  ) {
    const tag = threadEtiquetas[0];
    const dest = userInvs[userInvs.length - 1];
    if (tag && dest) {
      effectiveText = `agrega etiqueta ${tag} a ${dest}`;
      topic = "fill_inventario";
      fromContext = true;
    }
  }

  // Afirmación / “a ver” / “checa” corto → reusar la pregunta del bot.
  if (
    !fromContext &&
    lastBot &&
    botTopic !== "unknown" &&
    (isAffirm(raw) ||
      /^(aver|a ver|checa|chequea|revisa|busca|ok|dale)\b/i.test(raw) ||
      (raw.split(/\s+/).length <= 6 && directTopic === "unknown"))
  ) {
    if (botTopic === "duplicates") {
      if (userInvs.length === 1) {
        effectiveText = `checa etiquetas duplicadas solo en ${userInvs[0]}`;
      } else if (botInvs.length >= 2) {
        effectiveText = `checa etiquetas duplicadas entre ${botInvs[0]} y ${botInvs[1]}`;
      } else if (botInvs.length === 1) {
        effectiveText = `checa etiquetas duplicadas solo en ${botInvs[0]}`;
      } else {
        effectiveText = `checa etiquetas duplicadas`;
      }
      topic = "duplicates";
      fromContext = true;
    } else if (botTopic === "compare" && botInvs.length >= 2) {
      effectiveText = `compara ${botInvs[0]} vs ${botInvs[1]}`;
      topic = "compare";
      fromContext = true;
    } else if (
      (botTopic === "fill_inventario" || botTopic === "create_inventario") &&
      /qu[eé] meter|preparo|meterle registros|pasa todo/i.test(lastBot.text)
    ) {
      topic = botTopic;
      fromContext = true;
    } else if (botTopic === "etiqueta_origen" && threadEtiquetas[0]) {
      effectiveText = `etiqueta ${threadEtiquetas[0]} de que inventario venia`;
      topic = "etiqueta_origen";
      fromContext = true;
    }
  }

  // Acotación: “solo en inventario 1” con hilo de duplicados.
  if (
    lastBot &&
    (botTopic === "duplicates" || directTopic === "duplicates") &&
    isNarrowOnly(raw)
  ) {
    const inv = userInvs[0] || botInvs[0];
    if (inv) {
      effectiveText = `checa etiquetas duplicadas solo en ${inv}`;
      topic = "duplicates";
      fromContext = true;
    }
  }

  if (
    directTopic === "duplicates" &&
    userInvs.length === 1 &&
    /\bsolo\b/.test(fold(raw))
  ) {
    effectiveText = `checa etiquetas duplicadas solo en ${userInvs[0]}`;
    topic = "duplicates";
  }

  const threadHint = [
    "Continúa el hilo de ESTA conversación como si hablaras con una persona.",
    lastBot
      ? `Último mensaje del asistente: “${String(lastBot.text).replace(/\s+/g, " ").slice(0, 320)}”.`
      : "",
    firstUser && !isFirstUserTurn
      ? `Primer mensaje del chat: “${String(firstUser.text).replace(/\s+/g, " ").slice(0, 160)}”.`
      : "",
    topic !== "unknown" ? `Tema activo: ${topic}.` : "",
    threadEtiquetas.length
      ? `Etiquetas citadas por el usuario en este turno: ${threadEtiquetas.slice(0, 5).join(", ")}.`
      : "",
    "No uses etiquetas inventadas ni códigos de mensajes anteriores del asistente.",
    "No cambies de tema (áreas, personas, recientes) salvo que el usuario lo pida claro.",
    "Tolera faltas de ortografía; interpreta la intención más cercana al inventario.",
    isFirstUserTurn
      ? "Es el primer mensaje del chat: responde con coherencia y una sola intención clara."
      : "Usa el contexto de inventarios del hilo; no inventes etiquetas.",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    effectiveText: effectiveText.trim() || raw,
    topic,
    isFirstUserTurn,
    fromContext,
    threadHint,
    threadEtiquetas,
  };
}
