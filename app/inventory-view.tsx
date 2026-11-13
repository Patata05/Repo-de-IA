"use client";

import {
  ArrowUpRight,
  BarChart3,
  Bell,
  Boxes,
  Check,
  ChevronDown,
  Clock3,
  Layers,
  LayoutDashboard,
  CircleDot,
  Lightbulb,
  Loader2,
  Copy,
  FileSpreadsheet,
  ImagePlus,
  ListChecks,
  MapPin,
  MessageSquare,
  Mic,
  Moon,
  MoreVertical,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings,
  Share2,
  Sun,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Undo2,
  Users,
  X,
} from "lucide-react";
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type MutableRefObject,
  lazy,
  Suspense,
} from "react";
import { createPortal } from "react-dom";
import type { InventarioRow, NewInventarioItem } from "@/lib/supabase";
import {
  addInventarioBulkAction,
  deleteInventarioAction,
  deleteInventarioManyAction,
  restoreInventarioManyAction,
  updateInventarioAction,
  updateInventarioManyAction,
} from "@/app/actions";
import AddProductModal from "@/components/add-product-modal";
import ChatViewer from "@/components/chat-viewer";
import ProductDetailModal from "@/components/product-detail-modal";
import {
  askInventoryChat,
  fetchChatHealth,
  type ChatApiItem,
  type ChatModelOption,
  type ChatQrPayload,
  type ChatTokenUsage,
} from "@/lib/chat-api";
import { parseInventarioImportFile } from "@/lib/import-inventario-file";
import {
  detectCompareInventariosAsk,
  diffInventarios,
  formatInventarioDiffReply,
  listExistingOrigens,
  matchOrigenFromPrompt,
  normalizeOrigenLabel,
  planImportOrigen,
  ORIGEN_SIN_ORIGEN,
} from "@/lib/inventario-origen";
import { formatInventarioQrCompact } from "@/lib/inventario-qr";
import {
  answerFromMemoryAboutBefore,
  buildCrossChatHistorySnippet,
  buildRevertProposalReply,
  formatChatMemoryForPrompt,
  hydrateMemoryFromChatSessions,
  ensureLastFieldChangeFromMessages,
  looksLikeRevertPreviousValue,
  rememberFieldChange,
  rememberMutation,
  rememberTotalSnapshot,
  loadChatMemory,
  type ChatFieldChange,
} from "@/lib/chat-memory";
import {
  buildSearchIndex,
  formatDidYouMeanReply,
  indexMatchesPrepared,
  prepareSearch,
  rowMatchesPrepared,
  suggestDidYouMean,
} from "@/lib/inventario-search";
import {
  buildInventarioExcelFile,
  buildInventarioExcelFiles,
  detectExcelExportAsk,
  type ChatExportFile,
} from "@/lib/export-inventario-excel";
import {
  buildBulkTransferConfirmReply,
  buildBulkTransferDoneReply,
  detectBulkTransferAsk,
  isNegativeChat,
  type BulkTransferField,
  type PendingBulkTransfer,
} from "@/lib/bulk-transfer";
const ReportsView = lazy(() => import("@/components/reports-view"));

const CHAT_QUICK_ACTIONS = [
  {
    label: "Buscar por persona",
    hint: "Consulta qué artículos tiene asignados alguien.",
    prompt: "Dame lo que tiene Juan Pérez",
    icon: Users,
  },
  {
    label: "Equipos por área",
    hint: "Lista el equipo registrado en un área concreta.",
    prompt: "Dame los equipos de Sistemas",
    icon: MapPin,
  },
  {
    label: "Últimos registros",
    hint: "Revisa las altas más recientes del inventario.",
    prompt: "Dame los últimos registros",
    icon: ListChecks,
  },
  {
    label: "Comparar inventarios",
    hint: "Diff real: faltan / sobran / cambiaron vs S/O.",
    prompt: "Compara el último inventario vs S/O",
    icon: Layers,
  },
  {
    label: "Ideas de consulta",
    hint: "Descubre qué puedes preguntarle al asistente.",
    prompt: "¿Qué puedo preguntarte del inventario?",
    icon: Lightbulb,
  },
] as const;

type ViewerOverview =
  | "full"
  | "stats"
  | "areas"
  | "areaTotal"
  | "areaMatches"
  | "personTotal"
  | "personMatches"
  | "recent"
  | "personas"
  | "estado"
  | "marcas";

type ChatMessage = {
  id: number;
  from: "bot" | "user";
  text: string;
  at?: number;
  resultItems?: ChatApiItem[];
  qr?: ChatQrPayload[];
  /** Excel/CSV generados en el chat (tarjetas descargables). */
  exportFiles?: ChatExportFile[];
  /** Resumen del visor (solo si el usuario lo pide en el chat). */
  viewerOverview?: ViewerOverview;
  /** Foco de la incidencia (ej. nombre de área en areaTotal). */
  viewerFocus?: string;
  /** Progreso visual al importar Excel/CSV. */
  importProgress?: {
    label: string;
    done: number;
    total: number;
  };
};
type ChatQrCard = ChatQrPayload & { dataUrl: string };
type ChatSession = {
  id: string;
  title: string;
  updatedAt: string;
  messages: ChatMessage[];
  starred?: boolean;
  resultItems?: ChatApiItem[];
  qr?: ChatQrPayload[];
};

const CHAT_SESSIONS_KEY = "inventario-chat-sessions";
const CHAT_ACTIVE_KEY = "inventario-chat-active";
const CHAT_TOKEN_METERS_KEY = "inventario-chat-token-meters";
const CHAT_SELECTED_MODEL_PREFIX = "inventario-selected-model:";
const MAX_CHAT_SESSIONS = 50;
const CHAT_USER_COLLAPSE_AT = 160;
const PERSONA_SIN_ASIGNAR_ID = "__SIN_ASIGNAR__";
const PERSONA_SIN_ASIGNAR_NAME = "Sin asignar";

function loadSelectedModelForKey(keyFingerprint: string): string | null {
  try {
    if (!keyFingerprint) return null;
    return window.localStorage.getItem(`${CHAT_SELECTED_MODEL_PREFIX}${keyFingerprint}`);
  } catch {
    return null;
  }
}

function saveSelectedModelForKey(keyFingerprint: string, modelId: string) {
  try {
    if (!keyFingerprint || !modelId) return;
    window.localStorage.setItem(`${CHAT_SELECTED_MODEL_PREFIX}${keyFingerprint}`, modelId);
  } catch {
    /* quota */
  }
}

type TokenMeterEntry = {
  used: number;
  promptUsed: number;
  completionUsed: number;
  budget: number;
  provider: string;
  model: string;
  keyFingerprint: string;
  lastTurnTokens: number;
  updatedAt: number;
};

function loadTokenMeters(): Record<string, TokenMeterEntry> {
  try {
    const raw = window.localStorage.getItem(CHAT_TOKEN_METERS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, TokenMeterEntry>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveTokenMeters(meters: Record<string, TokenMeterEntry>) {
  try {
    window.localStorage.setItem(CHAT_TOKEN_METERS_KEY, JSON.stringify(meters));
  } catch {
    /* quota */
  }
}

function estimateTextTokens(text: string): number {
  const s = String(text || "").trim();
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 3.8));
}

function formatCompactTokens(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function loadChatSessions(): ChatSession[] {
  try {
    const raw = window.localStorage.getItem(CHAT_SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatSession[];
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const sessions = parsed.filter((session) => {
      if (!session?.id || !Array.isArray(session.messages) || seen.has(session.id)) {
        return false;
      }
      seen.add(session.id);
      return true;
    });
    sessions.sort((a, b) => {
      const ta = Date.parse(a.updatedAt) || 0;
      const tb = Date.parse(b.updatedAt) || 0;
      return tb - ta;
    });
    return sessions.slice(0, MAX_CHAT_SESSIONS);
  } catch {
    return [];
  }
}

function saveChatSessions(sessions: ChatSession[]) {
  try {
    const cleaned = sessions
      .filter((session) => session?.id && Array.isArray(session.messages) && session.messages.length > 0)
      .slice(0, MAX_CHAT_SESSIONS);
    window.localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(cleaned));
  } catch {
    /* quota / private mode */
  }
}

/** Une memoria + localStorage para no pisar historial en carreras de hydrate. */
function mergeChatSessions(
  memory: ChatSession[],
  ...extra: ChatSession[]
): ChatSession[] {
  const byId = new Map<string, ChatSession>();
  for (const session of loadChatSessions()) {
    if (session?.id) byId.set(session.id, session);
  }
  for (const session of memory) {
    if (session?.id) byId.set(session.id, session);
  }
  for (const session of extra) {
    if (session?.id) byId.set(session.id, session);
  }
  return Array.from(byId.values())
    .filter((session) => Array.isArray(session.messages) && session.messages.length > 0)
    .sort((a, b) => {
      const ta = Date.parse(a.updatedAt) || 0;
      const tb = Date.parse(b.updatedAt) || 0;
      return tb - ta;
    })
    .slice(0, MAX_CHAT_SESSIONS);
}

function loadActiveChatId(): string | null {
  try {
    return window.localStorage.getItem(CHAT_ACTIVE_KEY);
  } catch {
    return null;
  }
}

function saveActiveChatId(id: string | null) {
  try {
    if (id) window.localStorage.setItem(CHAT_ACTIVE_KEY, id);
    else window.localStorage.removeItem(CHAT_ACTIVE_KEY);
  } catch {
    /* quota / private mode */
  }
}

function buildChatQrCards(payloads: ChatQrPayload[]): ChatQrCard[] {
  // El visor solo lista + abre ficha; no genera imágenes QR aquí.
  return payloads
    .map((qr) => {
      const text =
        formatInventarioQrCompact({
          etiqueta: qr.etiqueta,
          origen: qr.origen,
        }) ||
        String(qr.text || qr.etiqueta || "").trim();
      if (!text) return null;
      return { ...qr, text, dataUrl: "" };
    })
    .filter((card): card is ChatQrCard => Boolean(card));
}

function rowToChatApiItem(row: InventarioRow): ChatApiItem {
  return {
    id: row.id,
    etiqueta: row.etiqueta,
    articulo: row.articulo,
    marca: row.marca,
    modelo: row.modelo,
    serie: row.serie,
    area: row.area,
    persona: row.persona,
    cantidad: row.cantidad,
    estado: row.estado,
    origen: row.origen,
    observaciones: row.observaciones,
  };
}

function isQrBotMessage(message: ChatMessage) {
  if (message.from !== "bot") return false;
  if (Array.isArray(message.qr) && message.qr.length > 0) return true;
  return /\bqr\b|c[oó]digos?\s*qr|qr\s*generado|imagen del qr/i.test(
    message.text || "",
  );
}

const SPANISH_COUNT_WORDS: Record<string, number> = {
  un: 1,
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
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
};

const MAX_ETIQUETA_LIST = 50;

/** Número pedido en el texto (dígito o palabra: trece, diez…). */
function parseRequestedCount(userText: string): number | null {
  const n = normalizeChatIntent(userText);
  if (!n) return null;
  const digit =
    n.match(
      /\b(\d{1,3})\s*(?:etiquet|registros?|articulos?|equipos?|qr|codigos?)\b/,
    ) ||
    n.match(
      /\b(?:etiquet\w*|registros?|articulos?|equipos?)\s*(\d{1,3})\b/,
    ) ||
    n.match(
      /\b(?:dame|muestra|mostrar|ensename|ensenar|ensena|ver|trae|genera|crea|haz)\s+(?:las?\s+|los?\s+)?(\d{1,3})\b/,
    );
  if (digit) {
    const value = Number(digit[1]);
    return Number.isFinite(value) ? value : null;
  }
  const words = Object.keys(SPANISH_COUNT_WORDS)
    .sort((a, b) => b.length - a.length)
    .join("|");
  const word =
    n.match(
      new RegExp(
        `\\b(${words})\\s*(?:etiquet|registros?|articulos?|equipos?|qr|codigos?)\\b`,
      ),
    ) ||
    n.match(
      new RegExp(
        `\\b(?:dame|muestra|mostrar|ensename|ver|trae)\\s+(?:las?\\s+|los?\\s+)?(${words})\\b`,
      ),
    );
  if (word) return SPANISH_COUNT_WORDS[word[1]] ?? null;
  return null;
}

/**
 * "dame N etiquetas" / "trece etiquetas de [área]" (sin QR).
 * null = no forzar recorte; número = tope pedido (o todas si dijo "todas").
 * No aplica a anáfora ("esas etiquetas" → contexto previo).
 */
function parseEtiquetaListAsk(userText: string): number | null {
  const n = normalizeChatIntent(userText);
  if (!n || !/\betiquet/.test(n)) return null;
  if (/\bqr\b/.test(n)) return null;
  if (looksLikeResultAnaphora(userText)) return null;
  // "sus etiquetas" / "de esa persona" → contexto de persona, no lote genérico de 50.
  if (looksLikePersonAnaphora(userText)) return null;
  const count = parseRequestedCount(userText);
  if (count != null) {
    return Math.max(1, Math.min(MAX_ETIQUETA_LIST, count));
  }
  if (
    intentHas(n, "todas", "todos") ||
    /\betiquet\w*\s+(de|del|en)\b/.test(n) ||
    (intentHas(
      n,
      "dame",
      "muestra",
      "mostrar",
      "ensename",
      "ensenar",
      "ensena",
      "ver",
      "trae",
      "lista",
      "listar",
    ) &&
      /\betiquet/.test(n))
  ) {
    return MAX_ETIQUETA_LIST;
  }
  return null;
}

/** "esas / esos / las de arriba / las anteriores" → resultados del mensaje previo. */
function looksLikeResultAnaphora(userText: string) {
  const n = normalizeChatIntent(userText);
  if (!n) return false;
  if (
    /\b(esas|esos|estas|estos|esa|ese|este|esta)\b/.test(n) ||
    /\b(las|los)\s+(de\s+arriba|anteriores?|previas?|mismas?|mismos|anteriores)\b/.test(
      n,
    ) ||
    /\b(arriba|anteriores?|previas?)\b/.test(n)
  ) {
    return true;
  }
  return false;
}

/** Refiere al área/persona del chat anterior sin volver a nombrarla. */
function looksLikeContextAnaphora(userText: string) {
  const n = normalizeChatIntent(userText);
  if (!n) return false;
  if (
    /\b(el|la|esa|este|esta|ese)\s+areas?\b/.test(n) ||
    /\bdel\s+areas?\b/.test(n) ||
    /\b(esa|esta)\s+areas?\b/.test(n) ||
    /\bmisma\s+areas?\b/.test(n) ||
    /\b(en|de)\s+(esa|esta|la)\s+areas?\b/.test(n) ||
    /\b(ahi|alla|alli|aqui)\b/.test(n) ||
    /\bde\s+que\s+tiene\b/.test(n) ||
    /\bque\s+tiene\s+(el|la|esa|esta)\b/.test(n) ||
    /\b(esa|este|esta|ese)\s+persona\b/.test(n) ||
    /\b(su|sus)\s+(inventario|registros?|etiquetas?|equipos?)\b/.test(n)
  ) {
    return true;
  }
  return false;
}

/**
 * Follow-up genérico: usa el foco del mensaje anterior (área/persona)
 * cuando el usuario dice “el área”, “ahí”, “dame los N registros”, etc.
 */
function detectContextFollowUpAsk(
  userText: string,
  inventory: InventarioRow[],
  recentMessages: Array<{
    from: string;
    text: string;
    viewerFocus?: string;
    viewerOverview?: ViewerOverview;
  }>,
):
  | {
      kind: "area";
      area: AreaCandidateSummary;
      intent: "list" | "total" | "people";
      limit: number | null;
    }
  | {
      kind: "person";
      person: PersonCandidateSummary;
      intent: "list" | "total";
      limit: number | null;
    }
  | undefined {
  if (!inventory.length || !recentMessages.length) return undefined;
  const n = normalizeChatIntent(userText);
  if (!n) return undefined;
  if (isNonConcreteChatAsk(userText) || isExploratoryChatAsk(userText)) {
    return undefined;
  }
  if (looksLikeDeleteRecordAsk(userText) || userAskedQr(userText)) {
    return undefined;
  }

  // Si ya nombró un área/persona de forma clara, no usar solo el contexto.
  const namedArea = findMatchingAreasForPrompt(userText, inventory);
  if (
    namedArea &&
    !namedArea.uncertain &&
    namedArea.candidates.length === 1 &&
    !looksLikeContextAnaphora(userText)
  ) {
    return undefined;
  }
  const namedPerson = findMatchingPeopleForPrompt(userText, inventory);
  if (
    namedPerson &&
    namedPerson.candidates.length === 1 &&
    !looksLikeContextAnaphora(userText) &&
    !looksLikePersonAnaphora(userText)
  ) {
    return undefined;
  }

  const wantsData = intentHas(
    n,
    "dame",
    "muestra",
    "mostrar",
    "ver",
    "trae",
    "lista",
    "listar",
    "cuantos",
    "cuantas",
    "cuanto",
    "cuanta",
    "total",
    "totales",
    "hay",
    "tiene",
    "tienen",
    "registro",
    "registros",
    "etiqueta",
    "etiquetas",
    "equipo",
    "equipos",
    "articulo",
    "articulos",
    "persona",
    "personas",
    "detalle",
    "info",
  );
  if (!wantsData && !looksLikeContextAnaphora(userText)) return undefined;

  const useContext =
    looksLikeContextAnaphora(userText) ||
    // “dame los 32 registros” sin nombrar área nueva → del foco previo
    (wantsData &&
      intentHas(
        n,
        "registro",
        "registros",
        "etiqueta",
        "etiquetas",
        "equipo",
        "equipos",
        "articulo",
        "articulos",
        "persona",
        "personas",
        "total",
        "totales",
      ) &&
      !(namedArea && !namedArea.uncertain && namedArea.candidates.length === 1));

  if (!useContext) return undefined;

  let focusName = "";
  let focusKind: "area" | "person" | "" = "";
  for (let i = recentMessages.length - 1; i >= 0; i -= 1) {
    const message = recentMessages[i];
    if (message.from !== "bot") continue;
    const focus = String(message.viewerFocus || "").trim();
    if (!focus) continue;
    if (
      message.viewerOverview === "areaTotal" ||
      message.viewerOverview === "areaMatches"
    ) {
      focusName = focus.includes("::")
        ? focus.slice(0, focus.indexOf("::")).trim() || focus
        : focus;
      // areaMatches focus is query label; prefer candidate from encode
      if (focus.includes("::")) {
        const parsed = parseMatchesFocusFromMessage(focus);
        focusName = parsed?.candidates[0] || focusName;
      }
      focusKind = "area";
      break;
    }
    if (
      message.viewerOverview === "personTotal" ||
      message.viewerOverview === "personMatches"
    ) {
      focusName = focus.includes("::")
        ? (() => {
            const parsed = parseMatchesFocusFromMessage(focus);
            return parsed?.candidates[0] || focus;
          })()
        : focus;
      focusKind = "person";
      break;
    }
    // Bot habló de un área en texto aunque no haya overview
    focusName = focus;
    const areaHit = getAllAreaCatalog(inventory).find(
      (c) => c.name === focus || areaMatchesNeedle(c.name, focus),
    );
    if (areaHit) {
      focusKind = "area";
      focusName = areaHit.name;
      break;
    }
    const personHit = getAllPersonCatalog(inventory).find(
      (c) => c.name === focus || normalizePlain(c.name).includes(normalizePlain(focus)),
    );
    if (personHit) {
      focusKind = "person";
      focusName = personHit.name;
      break;
    }
  }

  // También del lastConcreteSide si no hubo viewerFocus
  if (!focusKind) {
    // Buscar en el último bot mención de área conocida en el reply
    for (let i = recentMessages.length - 1; i >= 0; i -= 1) {
      const message = recentMessages[i];
      if (message.from !== "bot" || !message.text) continue;
      const catalog = getAllAreaCatalog(inventory);
      for (const area of catalog) {
        if (
          message.text.includes(area.name) ||
          normalizePlain(message.text).includes(area.norm)
        ) {
          focusKind = "area";
          focusName = area.name;
          break;
        }
      }
      if (focusKind) break;
    }
  }

  if (!focusKind || !focusName) return undefined;

  const limit = parseRequestedCount(userText);
  const wantsPeople =
    intentHas(n, "persona", "personas", "quien", "quienes") &&
    !intentHas(n, "registro", "registros", "etiqueta", "etiquetas", "equipo", "equipos");
  const wantsTotalOnly =
    intentHas(n, "total", "totales", "cuantos", "cuantas") &&
    !intentHas(
      n,
      "dame",
      "muestra",
      "mostrar",
      "ver",
      "lista",
      "listar",
      "etiqueta",
      "etiquetas",
      "registro",
      "registros",
    );

  if (focusKind === "area") {
    const area =
      getAllAreaCatalog(inventory).find((c) => c.name === focusName) ||
      getAllAreaCatalog(inventory).find((c) =>
        areaMatchesNeedle(c.name, focusName),
      );
    if (!area) return undefined;
    if (wantsPeople) {
      return { kind: "area", area, intent: "people", limit: null };
    }
    return {
      kind: "area",
      area,
      intent: wantsTotalOnly ? "total" : "list",
      limit:
        limit != null
          ? Math.max(1, Math.min(MAX_ETIQUETA_LIST, limit))
          : null,
    };
  }

  const person =
    getAllPersonCatalog(inventory).find((c) => c.name === focusName) ||
    getAllPersonCatalog(inventory).find((c) =>
      normalizePlain(c.name).includes(normalizePlain(focusName)),
    );
  if (!person) return undefined;
  return {
    kind: "person",
    person,
    intent: wantsTotalOnly ? "total" : "list",
    limit:
      limit != null ? Math.max(1, Math.min(MAX_ETIQUETA_LIST, limit)) : null,
  };
}

/** "dame sus etiquetas/registros" de la persona del mensaje anterior. */
function looksLikePersonEtiquetasAsk(userText: string) {
  const n = normalizeChatIntent(userText);
  if (!n) return false;
  if (!looksLikePersonAnaphora(userText)) return false;
  return (
    /\betiquet/.test(n) ||
    intentHas(
      n,
      "registro",
      "registros",
      "articulo",
      "articulos",
      "equipo",
      "equipos",
      "lista",
      "listar",
      "ficha",
      "fichas",
    )
  );
}

/**
 * Seguimiento vago / queja sin verbo claro.
 * No dispara búsquedas “casi acertadas” (p. ej. “ven” → VEN).
 */
function looksLikeVagueFollowUp(userText: string) {
  const n = normalizeChatIntent(userText);
  if (!n) return false;
  if (n.split(/\s+/).length > 8) return false;
  if (
    /\bno\s+se\s+(ve|ven|veen|nota|notan|muestra|muestran)\b/.test(n) ||
    /\bno\s+(aparecen|aparece|salen|sale)\b/.test(n) ||
    /\bno\s+(los|las)\s+(veo|ve|aparecen|estan|están)\b/.test(n) ||
    /\bno\s+me\s+(los|las)?\s*(veo|aparecen)\b/.test(n) ||
    /^(eso|esa|ese|asi|así|y\s+eso|no|nada|mal|error)$/.test(n) ||
    /\b(donde|dónde)\s+(estan|están|esta|está|quedo|quedó|queda)\b/.test(n)
  ) {
    return true;
  }
  return false;
}

function lastBotResultItems(messages: ChatMessage[]): ChatApiItem[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.from !== "bot") continue;
    if (Array.isArray(message.resultItems) && message.resultItems.length) {
      return message.resultItems;
    }
  }
  return [];
}

/** Marcas acotadas a un área ("cuántas marcas en biblioteca"). */
function detectMarcasAreaAsk(
  userText: string,
  inventory: InventarioRow[],
): string | undefined {
  const n = normalizeChatIntent(userText);
  if (!n || !intentHas(n, "marca", "marcas")) return undefined;
  const asks =
    intentHas(
      n,
      "cuantas",
      "cuantos",
      "cuanta",
      "cuanto",
      "que",
      "cuales",
      "cual",
      "hay",
      "tenemos",
      "tienen",
      "dame",
      "muestra",
      "mostrar",
      "ver",
      "lista",
      "listar",
    ) || /\bproductos?\b/.test(n);
  if (!asks) return undefined;
  return matchAreaFromPrompt(userText, inventory) || undefined;
}

function buildMarcasAreaReply(area: string, rows: InventarioRow[]) {
  const marcaCounts = new Map<string, number>();
  let activos = 0;
  for (const row of rows) {
    const marca = String(row.marca ?? "").trim();
    if (marca && !/^(s\/m|sin marca|n\/a)$/i.test(marca)) {
      marcaCounts.set(marca, (marcaCounts.get(marca) || 0) + 1);
    }
    if (isRowActivo(row)) activos += 1;
  }
  const top = [...marcaCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(
      ([marca, count]) =>
        `• **${marca}:** **${count.toLocaleString("es-MX")}**`,
    );
  const shown = Math.min(50, rows.length);
  return (
    `En **${area}** hay **${marcaCounts.size.toLocaleString("es-MX")}** marca` +
    `${marcaCounts.size === 1 ? "" : "s"} distintas entre ` +
    `**${rows.length.toLocaleString("es-MX")}** registro` +
    `${rows.length === 1 ? "" : "s"} (${activos.toLocaleString("es-MX")} activos)` +
    (rows.length > shown
      ? ` (mostrando los primeros ${shown} en el visor)`
      : "") +
    `.\n\n` +
    (top.length ? `Principales marcas:\n\n${top.join("\n")}\n\n` : "") +
    `El listado interactivo está en el visor derecho. ` +
    `¿Quieres filtrar por marca, abrir una ficha o generar códigos QR?`
  );
}

function buildVagueFollowUpReply(prevCount: number) {
  if (prevCount > 0) {
    return (
      `Del mensaje anterior tengo **${prevCount.toLocaleString("es-MX")}** registro` +
      `${prevCount === 1 ? "" : "s"}, pero no capté bien la acción. ` +
      `¿Quieres que abra ese listado en el visor, filtre por área/marca/persona, ` +
      `compare inventarios o cambie un dato (con confirmación)?`
    );
  }
  return (
    `No capté bien la acción y prefiero no inventar una búsqueda. ` +
    `Dime qué necesitas: buscar, comparar inventarios, cambiar un dato o ver un listado.`
  );
}

function chatApiItemsToRows(
  items: ChatApiItem[],
  inventory: InventarioRow[],
): InventarioRow[] {
  const out: InventarioRow[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const id = item.id != null ? Number(item.id) : NaN;
    const etq = String(item.etiqueta ?? "")
      .trim()
      .toLowerCase();
    const hit =
      (Number.isFinite(id)
        ? inventory.find((row) => Number(row.id) === id)
        : undefined) ||
      (etq
        ? inventory.find(
            (row) =>
              String(row.etiqueta ?? "")
                .trim()
                .toLowerCase() === etq,
          )
        : undefined) ||
      (item as unknown as InventarioRow);
    if (!hit) continue;
    const key =
      hit.id != null
        ? `id:${hit.id}`
        : `etq:${String(hit.etiqueta ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

function lastBotViewerFocus(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.from !== "bot") continue;
    if (message.viewerFocus) return String(message.viewerFocus);
  }
  return null;
}

function resolveCanonicalPerson(
  raw: string,
  inventory: InventarioRow[],
): { name: string; rows: InventarioRow[] } | null {
  const catalog = getAllPersonCatalog(inventory);
  const n = normalizePlain(raw);
  if (!n) return null;
  let best: PersonCandidateSummary | null = null;
  let bestScore = 0;
  for (const person of catalog) {
    let score = 0;
    if (person.norm === n) score = 1000;
    else if (person.norm.includes(n) || n.includes(person.norm)) {
      score = 700 + Math.min(person.norm.length, n.length);
    } else {
      const toks = n.split(" ").filter(Boolean);
      if (toks.length && toks.every((t) => person.tokens.includes(t))) {
        score = 500 + toks.length * 20;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = person;
    }
  }
  if (!best || bestScore < 80) return null;
  return { name: best.name, rows: best.rows };
}

function resolveCanonicalArea(
  raw: string,
  inventory: InventarioRow[],
): string | null {
  const building = matchBuildingFromPrompt(raw, inventory);
  if (building) return building;
  const n = normalizePlain(raw);
  if (!n) return null;
  const areas = [
    ...new Set(
      inventory.map((row) => String(row.area ?? "").trim()).filter(Boolean),
    ),
  ];
  let best: string | null = null;
  let bestScore = 0;
  for (const area of areas) {
    const a = normalizePlain(area);
    let score = 0;
    if (a === n) score = 1000;
    else if (a.includes(n) || n.includes(a)) score = 700;
    else if (areaMatchesNeedle(area, n)) score = 400;
    if (score > bestScore) {
      bestScore = score;
      best = area;
    }
  }
  return bestScore >= 400 ? best : null;
}

function buildExcelExportReply(files: ChatExportFile[]): string {
  if (!files.length) {
    return "No pude armar el Excel: no hay registros para esa consulta.";
  }
  const cols =
    "ETIQUETA, ARTÍCULO, MARCA, MODELO, SERIE, ÁREA, PERSONA, CANTIDAD, ESTADO y ORIGEN";
  if (files.length === 1) {
    const f = files[0];
    return (
      `Aquí tienes tu archivo:\n\n` +
      `**${f.label}** con **${f.rowCount.toLocaleString("es-MX")}** registro` +
      `${f.rowCount === 1 ? "" : "s"} ` +
      `(columnas: ${cols}).\n\n` +
      `Pulsa la tarjeta para descargarlo.`
    );
  }
  const lines = files.map(
    (f) =>
      `• **${f.label}** — ${f.rowCount.toLocaleString("es-MX")} registro` +
      `${f.rowCount === 1 ? "" : "s"}`,
  );
  return (
    `Aquí tienes tus archivos:\n\n` +
    `${lines.join("\n")}\n\n` +
    `Cada libro usa las columnas: ${cols}.`
  );
}

function pickOne<T>(options: T[]): T {
  return options[Math.floor(Math.random() * options.length)]!;
}

/** Vista previa de import: mismo dato, prosa distinta cada vez. */
function buildChatImportPreviewReply(input: {
  fileName: string;
  sheetName?: string;
  origen: string;
  source:
    | "prompt"
    | "column"
    | "sheet"
    | "file"
    | "filter"
    | "default";
  count: number;
  rawValid: number;
  dups: number;
  sample: string;
  more: string;
}): string {
  const n = formatNumber(input.count);
  const sheetBit = input.sheetName ? ` (hoja “${input.sheetName}”)` : "";
  const origen = input.origen;

  const sourcePhrase =
    input.source === "sheet"
      ? pickOne([
          `la hoja “${input.sheetName}”`,
          "el nombre de la hoja",
          "cómo se llama la hoja del Excel",
        ])
      : input.source === "file"
        ? pickOne([
            "el nombre del archivo",
            "cómo se llama el Excel",
            "el título del archivo",
          ])
        : input.source === "column"
          ? pickOne([
              "la columna Origen",
              "el origen que viene en cada fila",
              "lo que marca la columna de origen",
            ])
          : input.source === "prompt"
            ? pickOne([
                "lo que me pediste",
                "tu indicación",
                "el destino que escribiste",
              ])
            : input.source === "filter"
              ? pickOne([
                  "el inventario que tienes seleccionado",
                  "el filtro activo",
                ])
              : pickOne([
                  "que no traía origen claro",
                  "que el Excel no dejaba claro el origen",
                ]);

  const open = pickOne(
    origen === "S/O" || origen === ORIGEN_SIN_ORIGEN
      ? [
          `Listo, ya leí “${input.fileName}”${sheetBit}. Como no había origen claro (${sourcePhrase}), lo dejaré en **${ORIGEN_SIN_ORIGEN}**.`,
          `Revisé “${input.fileName}”${sheetBit}. Sin un origen explícito (${sourcePhrase}), el destino será **${ORIGEN_SIN_ORIGEN}**.`,
          `Archivo cargado: “${input.fileName}”${sheetBit}. Voy con **${ORIGEN_SIN_ORIGEN}** porque ${sourcePhrase}.`,
        ]
      : [
          `Perfecto, ya leí “${input.fileName}”${sheetBit}. El destino queda en **${origen}** (según ${sourcePhrase}).`,
          `Listo con “${input.fileName}”${sheetBit}. Voy a meterlo en **${origen}**, tomando ${sourcePhrase}.`,
          `Ya revisé el Excel${sheetBit}. Origen: **${origen}** (${sourcePhrase}).`,
          `“${input.fileName}”${sheetBit} listo. Lo asociaré a **${origen}**.`,
          `Claro. Para este archivo el origen es **${origen}** (${sourcePhrase}).`,
        ],
  );

  const countLine =
    input.dups > 0
      ? pickOne([
          `Hay **${formatNumber(input.rawValid)}** filas con etiqueta y artículo; **${formatNumber(input.dups)}** etiqueta${input.dups === 1 ? "" : "s"} se repite${input.dups === 1 ? "" : "n"}, así que importaré **${n}** únicos.`,
          `Detecté **${formatNumber(input.rawValid)}** filas útiles y **${formatNumber(input.dups)}** duplicado${input.dups === 1 ? "" : "s"} de etiqueta → quedarán **${n}**.`,
          `En total **${n}** registros únicos para importar (había ${formatNumber(input.dups)} etiqueta${input.dups === 1 ? "" : "s"} repetida${input.dups === 1 ? "" : "s"}).`,
        ])
      : pickOne([
          `Encontré **${n}** registro${input.count === 1 ? "" : "s"} con etiqueta y artículo.`,
          `Son **${n}** registros listos (etiqueta + artículo).`,
          `Sale un total de **${n}** filas válidas.`,
          `Van **${n}** artículos con código legible.`,
        ]);

  const sampleIntro = pickOne([
    "Un vistazo:",
    "Por ejemplo:",
    "Algunos de ellos:",
    "Muestra rápida:",
  ]);

  const ask = pickOne([
    `¿Los importo ahora a **${origen}**? Responde **sí** o **importalos**.`,
    `¿Sigo y los cargo en **${origen}**? Dime **sí** o **importalos**.`,
    `Si te late, confirmo la carga a **${origen}** con **sí** / **importalos**.`,
    `¿Arranco la importación a **${origen}**? **sí** o **importalos**.`,
  ]);

  return (
    `${open}\n\n` +
    `${countLine}\n` +
    `${sampleIntro}\n${input.sample}${input.more}\n\n` +
    ask
  );
}

function buildChatImportMixedReply(input: {
  fileName: string;
  sheetName?: string;
  mixLines: string;
  dupNote: string;
  sample: string;
  more: string;
}): string {
  const sheetBit = input.sheetName ? ` (hoja “${input.sheetName}”)` : "";
  const open = pickOne([
    `Leí “${input.fileName}”${sheetBit}, pero el origen viene **mezclado** entre los registros.`,
    `El Excel “${input.fileName}”${sheetBit} trae **varios orígenes** a la vez.`,
    `Revisé “${input.fileName}”${sheetBit} y no es un solo inventario: hay orígenes distintos.`,
  ]);
  const pending = pickOne([
    `Dejé **todos** pendientes. Puedes responder **sí** para respetar el origen de cada fila, o decir un solo destino («importar a Inventario 1» / «a S/O»).`,
    `No los meto todavía. **sí** = importar respetando cada origen; o indícame un destino único.`,
    `Quedan en espera: confirma con **sí** (origen por fila) o elige un solo destino.`,
  ]);
  return (
    `${open}\n\n` +
    `${input.mixLines}\n` +
    `${input.dupNote}\n\n` +
    `${pending}\n\n` +
    `${input.sample}${input.more}`
  );
}

/** Parte filas en N grupos (p. ej. 3 inventarios de oficina). */
function splitRowsForExcelGroups(
  rows: InventarioRow[],
  count: number,
  theme: string | null,
): Array<{ rows: InventarioRow[]; focus?: string; kind?: string; index?: number }> {
  const n = Math.max(1, Math.min(12, count));
  if (n === 1) {
    return [
      {
        rows,
        focus: theme ? `Inventario ${theme}` : undefined,
        kind: theme || undefined,
      },
    ];
  }

  // Preferir áreas que coincidan con el tema (oficina, biblioteca…).
  const themeNeedle = theme
    ? theme
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
    : "";
  const byArea = new Map<string, InventarioRow[]>();
  for (const row of rows) {
    const area = String(row.area ?? "").trim() || "Sin área";
    const list = byArea.get(area) || [];
    list.push(row);
    byArea.set(area, list);
  }
  let areaEntries = [...byArea.entries()].sort((a, b) => b[1].length - a[1].length);
  if (themeNeedle) {
    const themed = areaEntries.filter(([area]) =>
      area
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .includes(themeNeedle),
    );
    if (themed.length) areaEntries = themed;
  }

  if (areaEntries.length >= n) {
    return areaEntries.slice(0, n).map(([area, areaRows], idx) => ({
      rows: areaRows,
      focus: theme ? `Inventario ${theme} ${idx + 1}` : area,
      index: theme ? idx + 1 : undefined,
      kind: theme || undefined,
    }));
  }

  // Si no hay suficientes áreas: repartir en N bloques con nombre temático.
  const groups: Array<{
    rows: InventarioRow[];
    focus?: string;
    kind?: string;
    index?: number;
  }> = [];
  const size = Math.ceil(rows.length / n) || 1;
  for (let i = 0; i < n; i += 1) {
    const slice = rows.slice(i * size, (i + 1) * size);
    if (!slice.length) continue;
    groups.push({
      rows: slice,
      focus: theme ? `Inventario ${theme} ${i + 1}` : `Inventario ${i + 1}`,
      kind: theme || undefined,
      index: i + 1,
    });
  }
  return groups;
}

function buildAnaphoraEtiquetasReply(items: ChatApiItem[]) {
  const n = items.length;
  const lines = items.slice(0, 8).map((item) => {
    const tag = String(item.etiqueta ?? "").trim() || "S/E";
    const art = String(item.articulo ?? "").trim() || "Artículo";
    const area = String(item.area ?? "").trim() || "Sin área";
    return `• **${tag}** — ${art} (${area})`;
  });
  const more =
    n > lines.length ? `\n… y ${n - lines.length} más en el visor.` : "";
  return (
    `Aquí tienes **${n.toLocaleString("es-MX")}** etiqueta` +
    `${n === 1 ? "" : "s"} del resultado anterior` +
    (lines.length ? `:\n\n${lines.join("\n")}${more}` : ".") +
    `\n\nEl listado está en el visor derecho. ` +
    `¿Quieres generar QR de estas etiquetas o filtrar por área?`
  );
}

const AREA_STOP_WORDS = new Set([
  "area",
  "areas",
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
  "en",
  "un",
  "una",
  "dame",
  "muestra",
  "mostrar",
  "ver",
  "trae",
  "lista",
  "listar",
  "busca",
  "buscar",
  "registro",
  "registros",
  "etiqueta",
  "etiquetas",
  "informacion",
  "infomacion",
  "info",
  "datos",
  "detalle",
  "resumen",
  "todo",
  "toda",
  "todos",
  "todas",
  "su",
  "sus",
  "articulo",
  "articulos",
  "equipo",
  "equipos",
  "por",
  "con",
  "inventario",
  "inventarios",
  "solo",
  "solamente",
  "persona",
  "personas",
  "des",
  "ahi",
  "alla",
  "alli",
  "aqui",
  "ahora",
  "quiero",
  "me",
]);

function looksLikeAreaQuery(plain: string) {
  return (
    /\b(area|areas|edif|edificio|edificios|biblioteca|registro|registros|etiqueta|etiquetas|articulo|articulos|equipo|equipos|dame|muestra|mostrar|ver|lista|listar|busca|buscar|informacion|infomacion|info|datos|detalle)\b/.test(
      plain,
    ) || /\b(de|del|en)\s+[a-z0-9]{1,}/.test(plain)
  );
}

/** "EDIF B" / "edificio B" → área canónica (ignora puntos: EDIF. B). */
function matchBuildingFromPrompt(
  userText: string,
  inventory: InventarioRow[],
): string | undefined {
  const plain = normalizePlain(userText);
  const matched = plain.match(/\b(?:edif|edifs|edificio|edificios)\s*([a-z0-9])\b/);
  if (!matched) return undefined;
  const letter = matched[1];
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const row of inventory) {
    const area = String(row.area ?? "").trim();
    if (!area || seen.has(area)) continue;
    const n = normalizePlain(area);
    if (!/\bedif(?:icio)?s?\b/.test(n)) continue;
    if (n.split(" ").includes(letter)) {
      seen.add(area);
      hits.push(area);
    }
  }
  if (!hits.length) return "edif " + letter;
  hits.sort((a, b) => a.length - b.length);
  return hits[0];
}

const AREA_ACRONYM_SKIP = new Set([
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
  "y",
  "e",
  "en",
  "a",
  "al",
  "un",
  "una",
]);

/** Siglas de un área: "recursos humanos" → "rh", "sistemas y ti" → "sti". */
function areaAcronym(normArea: string) {
  return normArea
    .split(" ")
    .filter((t) => t && !AREA_ACRONYM_SKIP.has(t))
    .map((t) => t[0] || "")
    .join("");
}

function areaMatchesNeedle(area: string, needle: string) {
  const a = normalizePlain(area);
  const n = normalizePlain(needle);
  if (!a || !n) return false;
  if (a === n || a.includes(n) || n.includes(a)) return true;
  const acro = areaAcronym(a);
  if (acro && (acro === n || (n.length >= 2 && acro.startsWith(n)))) return true;
  const aToks = a.split(" ").filter(Boolean);
  const nToks = n.split(" ").filter(Boolean);
  if (nToks.length && nToks.every((tok) => aToks.includes(tok))) return true;
  return aToks.some((tok) => {
    if (tok === n || tok.includes(n) || n.includes(tok)) return true;
    const budget = typoBudget(tok);
    return (
      budget > 0 &&
      Math.abs(tok.length - n.length) <= budget &&
      levenshtein(tok, n) <= budget
    );
  });
}

/** Aguja de área desde el texto (ej. "biblioteca" aunque digan bbliteca). */
function extractAreaNeedle(
  userText: string,
  inventory: InventarioRow[],
): string | undefined {
  const plain = normalizePlain(userText);
  if (!plain || !looksLikeAreaQuery(plain)) return undefined;
  const user = normalizeChatIntent(userText);
  if (!user) return undefined;
  const afterArea =
    user.match(/\bareas?\s+(?:de\s+|del\s+)?(.+)$/) ||
    user.match(
      /\b(?:registros?|etiquetas?|articulos?|equipos?)\s+(?:de\s+|del\s+|en\s+)(.+)$/,
    );
  const raw = (afterArea?.[1] || user)
    .split(/\s+/)
    .filter((t, i, toks) => {
      if (AREA_STOP_WORDS.has(t)) return false;
      // Abreviaturas cortas (RH, TI, TICs…) sí cuentan.
      if (t.length <= 1) return false;
      if (t.length === 2 && !/^[a-z]{2}$/.test(t)) return false;
      // "inventario general" no es el área llamada "general".
      if (t === "general" && toks[i - 1] === "inventario") return false;
      return true;
    });
  if (!raw.length) return undefined;

  // Siglas: "RH" → área cuyo acrónimo coincida.
  const catalog = getAllAreaCatalog(inventory);
  for (const cand of raw) {
    if (cand.length > 6) continue;
    const hits = catalog.filter((area) => {
      const acro = areaAcronym(area.norm);
      return acro === cand || (cand.length >= 2 && acro.startsWith(cand));
    });
    if (hits.length === 1) return hits[0].name;
  }

  const { tokens: areaTokens } = getAreaSearchIndex(inventory);
  // Solo matches seguros aquí (exacto / prefijo único). Los typos los confirma
  // findMatchingAreasForPrompt preguntando “¿te referías a…?”.
  for (const cand of raw) {
    for (const tok of areaTokens) {
      if (cand === tok) return tok;
    }
    const prefixHits = areaTokens.filter(
      (tok) => tok.length >= 4 && cand.length >= 3 && tok.startsWith(cand),
    );
    if (prefixHits.length === 1) return prefixHits[0];
  }
  return undefined;
}

/** Área mencionada en el pedido (nombre canónico o aguja de filtro). */
function matchAreaFromPrompt(
  userText: string,
  inventory: InventarioRow[],
): string | undefined {
  const building = matchBuildingFromPrompt(userText, inventory);
  if (building) return building;
  if (!looksLikeAreaQuery(normalizePlain(userText))) return undefined;
  return extractAreaNeedle(userText, inventory);
}

function rowsForAreaNeedle(
  inventory: InventarioRow[],
  needle: string,
  limit: number,
): InventarioRow[] {
  const n = normalizePlain(needle);
  if (!n) return [];
  const out: InventarioRow[] = [];
  for (const row of inventory) {
    if (out.length >= limit) break;
    if (!String(row.etiqueta ?? "").trim()) continue;
    if (areaMatchesNeedle(String(row.area ?? ""), n)) out.push(row);
  }
  return out;
}

/** "dame los registros/etiquetas del área X" → lista local sin LLM. */
function detectAreaListAsk(
  userText: string,
  inventory: InventarioRow[],
): { area: string; limit: number } | undefined {
  const n = normalizeChatIntent(userText);
  if (!n) return undefined;
  if (detectAreaTotalAsk(userText, inventory)) return undefined;
  const wantsList = intentHas(
    n,
    "dame",
    "muestra",
    "mostrar",
    "ensename",
    "ensenar",
    "ensena",
    "ver",
    "trae",
    "lista",
    "listar",
    "busca",
    "buscar",
    "informacion",
    "infomacion",
    "info",
    "datos",
    "detalle",
    "resumen",
  );
  const hasTarget = intentHas(
    n,
    "registro",
    "registros",
    "etiqueta",
    "etiquetas",
    "articulo",
    "articulos",
    "equipo",
    "equipos",
    "informacion",
    "infomacion",
    "info",
    "datos",
    "detalle",
    "todo",
    "toda",
    "todos",
    "todas",
  );
  const areaCue =
    intentHas(n, "area", "areas", "edif", "edificio", "edificios") ||
    /\b(de|del|en)\b/.test(n) ||
    /\bedif\s*[a-z0-9]\b/.test(n);
  if (!wantsList || (!hasTarget && !areaCue)) return undefined;
  // Ranking de áreas (todas) ≠ registros de un área.
  if (
    intentHas(n, "areas") &&
    intentHas(n, "todas", "todos", "ranking", "por") &&
    !hasTarget
  ) {
    return undefined;
  }
  // Inventario de una persona ("su inventario general") ≠ área "general".
  if (
    !intentHas(n, "area", "areas", "edif", "edificio", "edificios") &&
    (intentHas(n, "inventario", "inventarios") ||
      /\b(su|sus)\b/.test(n) ||
      /\bde el\b/.test(n) ||
      /\bde ella\b/.test(n))
  ) {
    return undefined;
  }
  const area = matchAreaFromPrompt(userText, inventory);
  if (!area) return undefined;
  const count = parseRequestedCount(userText);
  return {
    area,
    limit: Math.max(1, Math.min(MAX_ETIQUETA_LIST, count ?? MAX_ETIQUETA_LIST)),
  };
}

function buildAreaListReply(area: string, rows: InventarioRow[]) {
  const n = rows.length;
  if (!n) {
    return `No encontré registros en **${area}**. ¿Quieres revisar el nombre del área o ver el ranking de áreas?`;
  }
  const label = area.length <= 40 ? area : `${area.slice(0, 37)}…`;
  const personas = new Set(
    rows.map((row) => String(row.persona ?? "").trim()).filter(Boolean),
  );
  const sample = rows
    .slice(0, 4)
    .map((row) => {
      const tag = String(row.etiqueta ?? "").trim();
      const art = String(row.articulo ?? "").trim();
      return tag && art ? `${tag}: ${art}` : tag || art;
    })
    .filter(Boolean);
  return (
    `En **${label}** hay **${n}** registro${n === 1 ? "" : "s"} y **${personas.size}** persona${personas.size === 1 ? "" : "s"}.\n\n` +
    (sample.length ? `Ejemplos: ${sample.join(" · ")}\n\n` : "") +
    `El detalle completo está en el panel derecho.\n\n` +
    `¿Quieres filtrar por persona, generar QR de un lote o ver otra área?`
  );
}

type AreaCandidateSummary = {
  name: string;
  norm: string;
  tokens: string[];
  rows: InventarioRow[];
  personas: number;
  activos: number;
};

type PersonCandidateSummary = {
  name: string;
  norm: string;
  tokens: string[];
  rows: InventarioRow[];
  areas: number;
  activos: number;
};

type PendingDisambiguationState = {
  kind: "area" | "person";
  queryLabel: string;
  candidates: string[];
  intent: "list" | "total";
  limit: number | null;
};

function encodeMatchesFocus(label: string, candidates: string[]): string {
  return `${label.trim()}::${candidates.join("||")}`;
}

function parseMatchesFocusFromMessage(rawFocus?: string): {
  label: string;
  candidates: string[];
} | null {
  const raw = String(rawFocus ?? "").trim();
  const sep = raw.indexOf("::");
  if (sep === -1) return null;
  const label = raw.slice(0, sep).trim();
  const candidates = raw
    .slice(sep + 2)
    .split("||")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!candidates.length) return null;
  return { label: label || "Consulta", candidates };
}

const AREA_QUERY_STOP_WORDS = new Set([
  ...AREA_STOP_WORDS,
  "dime",
  "decirme",
  "digame",
  "muestrame",
  "ensename",
  "ensenar",
  "ensena",
  "traeme",
  "listame",
  "buscame",
  "consulta",
  "consultar",
  "consultame",
  "quiero",
  "necesito",
  "deseo",
  "saber",
  "conocer",
  "cual",
  "cuales",
  "que",
  "quien",
  "quienes",
  "esta",
  "estan",
  "este",
  "esten",
  "hay",
  "tiene",
  "tienen",
  "existe",
  "existen",
  "ubicado",
  "ubicados",
  "des",
  "ahi",
  "alla",
  "alli",
  "aqui",
  "ahora",
  "ubicada",
  "ubicadas",
  "pertenece",
  "pertenecen",
  "asignado",
  "asignados",
  "asignada",
  "asignadas",
  "total",
  "totales",
  "conteo",
  "cantidad",
  "cuantos",
  "cuantas",
  "cuanto",
  "cuanta",
  "incidencia",
  "incidencias",
  "opcion",
  "opciones",
  "favor",
  "para",
  "sobre",
  "acerca",
  "al",
  "lo",
  "me",
  "te",
  "se",
  "nos",
  "puedes",
  "podrias",
  "activo",
  "activos",
  "cosa",
  "cosas",
  "mobiliario",
  "bien",
  "bienes",
]);

const ORDINAL_INDEX_MAP: Record<string, number> = {
  primero: 1,
  primera: 1,
  primer: 1,
  uno: 1,
  una: 1,
  segundo: 2,
  segunda: 2,
  dos: 2,
  tercero: 3,
  tercera: 3,
  tercer: 3,
  tres: 3,
  cuarto: 4,
  cuarta: 4,
  cuatro: 4,
  quinto: 5,
  quinta: 5,
  cinco: 5,
  sexto: 6,
  sexta: 6,
  seis: 6,
  septimo: 7,
  septima: 7,
  siete: 7,
  octavo: 8,
  octava: 8,
  ocho: 8,
};

function stripRequestedCountPhrases(plainText: string): string {
  const countWords = Object.keys(SPANISH_COUNT_WORDS)
    .sort((a, b) => b.length - a.length)
    .join("|");
  return plainText
    .replace(
      new RegExp(
        `\\b(\\d{1,3}|${countWords})\\s*(?:etiquetas?|etiquet\\w*|registros?|articulos?|equipos?|codigos?|qr)\\b`,
        "g",
      ),
      " ",
    )
    .replace(
      /\b(?:etiquetas?|registros?|articulos?|equipos?)\s+\d{1,3}\b/g,
      " ",
    )
    .replace(
      new RegExp(
        `\\b(dame|dime|muestra|mostrar|muestrame|ensename|ensenar|ensena|ver|trae|lista|listar)\\s+(?:las?\\s+|los?\\s+)?(\\d{1,3}|${countWords})\\s+(?=de\\b|del\\b|en\\b|area\\b|areas\\b)`,
        "g",
      ),
      "$1 ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function getAllAreaCatalog(inventory: InventarioRow[]): AreaCandidateSummary[] {
  const byArea = new Map<string, InventarioRow[]>();
  for (const row of inventory) {
    const area = String(row.area ?? "").trim();
    if (!area) continue;
    const list = byArea.get(area);
    if (list) list.push(row);
    else byArea.set(area, [row]);
  }
  const out: AreaCandidateSummary[] = [];
  for (const [name, rows] of byArea.entries()) {
    const norm = normalizePlain(name).replace(/\b(?:edificios?|edifs)\b/g, "edif");
    const tokens = norm.split(" ").filter(Boolean);
    const people = new Set(
      rows.map((r) => String(r.persona ?? "").trim()).filter(Boolean),
    );
    const activos = rows.filter(isRowActivo).length;
    out.push({
      name,
      norm,
      tokens,
      rows,
      personas: people.size,
      activos,
    });
  }
  out.sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));
  return out;
}

function getAllPersonCatalog(inventory: InventarioRow[]): PersonCandidateSummary[] {
  const byPerson = new Map<string, InventarioRow[]>();
  for (const row of inventory) {
    const persona = String(row.persona ?? "").trim();
    if (!persona) continue;
    const normCheck = normalizePlain(persona);
    if (
      !normCheck ||
      normCheck === "sin asignar" ||
      normCheck === "no asignado" ||
      normCheck === "n a" ||
      normCheck === "na"
    ) {
      continue;
    }
    const list = byPerson.get(persona);
    if (list) list.push(row);
    else byPerson.set(persona, [row]);
  }
  const out: PersonCandidateSummary[] = [];
  for (const [name, rows] of byPerson.entries()) {
    const norm = normalizePlain(name);
    const tokens = norm.split(" ").filter(Boolean);
    const areas = new Set(
      rows.map((r) => String(r.area ?? "").trim()).filter(Boolean),
    );
    const activos = rows.filter(isRowActivo).length;
    out.push({
      name,
      norm,
      tokens,
      rows,
      areas: areas.size,
      activos,
    });
  }
  out.sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));
  return out;
}

type AreaTokenMatch = { token: string; confidence: "exact" | "fuzzy" };

function matchSingleAreaVocabularyToken(
  rawTok: string,
  allAreaTokens: Set<string>,
): AreaTokenMatch | null {
  if (!rawTok) return null;
  if (allAreaTokens.has(rawTok)) return { token: rawTok, confidence: "exact" };
  // Prefijo o singular/plural simple (ej. "cubiculos" -> "cubiculo", "salas" -> "sala")
  if (rawTok.endsWith("s") && rawTok.length > 3) {
    const sing = rawTok.slice(0, -1);
    if (allAreaTokens.has(sing)) return { token: sing, confidence: "exact" };
  }
  // Prefijo exacto: "mark" → "marketing" (seguro si el usuario escribió bien el inicio)
  let prefixHit: string | null = null;
  let prefixCount = 0;
  for (const vocabTok of allAreaTokens) {
    if (vocabTok.length < 4) continue;
    if (vocabTok.startsWith(rawTok) && rawTok.length >= 3) {
      prefixCount += 1;
      if (!prefixHit || vocabTok.length < prefixHit.length) prefixHit = vocabTok;
    }
  }
  if (prefixHit && prefixCount === 1) {
    return { token: prefixHit, confidence: "exact" };
  }
  if (prefixHit && prefixCount > 1) {
    // Varias áreas comparten el prefijo → no auto-elegir; el caller desambigua.
    return { token: prefixHit, confidence: "fuzzy" };
  }

  // Typos difíciles (venbtas, merke, contablidad…) → fuzzy; el caller pregunta si duda.
  const fuzzyBudget =
    rawTok.length >= 4 ? Math.max(1, typoBudget(rawTok)) : typoBudget(rawTok);
  if (fuzzyBudget <= 0) return null;
  const variants = spellingVariants(rawTok);
  let best: { tok: string; dist: number } | null = null;
  for (const vocabTok of allAreaTokens) {
    if (vocabTok.length <= 2) continue;
    for (const cand of variants) {
      if (allAreaTokens.has(cand)) {
        return { token: cand, confidence: "fuzzy" };
      }
      if (vocabTok.startsWith(cand) && cand.length >= 3) {
        const dist = Math.abs(vocabTok.length - cand.length) > 0 ? 1 : 0;
        if (!best || dist < best.dist) best = { tok: vocabTok, dist };
      }
      if (Math.abs(vocabTok.length - cand.length) <= fuzzyBudget + 1) {
        const dist = levenshtein(cand, vocabTok);
        if (dist <= fuzzyBudget && (!best || dist < best.dist)) {
          best = { tok: vocabTok, dist };
        }
      }
      if (cand.length >= 4 && vocabTok.length > cand.length) {
        const dist = levenshtein(cand, vocabTok.slice(0, cand.length));
        if (dist <= fuzzyBudget && (!best || dist < best.dist)) {
          best = { tok: vocabTok, dist };
        }
      }
    }
  }
  return best ? { token: best.tok, confidence: "fuzzy" } : null;
}

function extractAreaQueryTokens(
  userText: string,
  catalog: AreaCandidateSummary[],
): {
  rawLabel: string;
  matchedTokens: string[];
  confidence: "exact" | "fuzzy";
  rawNeedles: string[];
} | null {
  // normalizeChatIntent aplica aliases (venbtas→ventas, peronas→personas).
  const plain0 = normalizeChatIntent(userText) || normalizePlain(userText);
  if (!plain0 || /\b\d{4,}\b/.test(plain0)) return null;
  const stripped = stripRequestedCountPhrases(plain0).replace(
    /\b(?:edificios?|edifs)\b/g,
    "edif",
  );
  const rawTokens = stripped
    .split(" ")
    .filter((tok, idx, arr) => {
      if (!tok) return false;
      if (AREA_QUERY_STOP_WORDS.has(tok)) return false;
      if (tok === "general" && arr[idx - 1] === "inventario") return false;
      return true;
    });
  if (!rawTokens.length) return null;

  // Alias semántico: "biblioteca vieja" / "biblioteca antigua" -> EDIF. B BIBLIOTECA
  if (
    rawTokens.some((t) => t.startsWith("bibliotec") || t === "bblioteca") &&
    rawTokens.some((t) => t === "vieja" || t === "antigua" || t === "viejo")
  ) {
    return {
      rawLabel: "biblioteca vieja (Edif. B Biblioteca)",
      matchedTokens: ["edif", "b", "biblioteca"],
      confidence: "exact",
      rawNeedles: rawTokens,
    };
  }

  const allAreaTokens = new Set<string>();
  for (const item of catalog) {
    for (const t of item.tokens) allAreaTokens.add(t);
  }

  const matchedTokens: string[] = [];
  let confidence: "exact" | "fuzzy" = "exact";
  let skippedNoise = 0;
  for (const rt of rawTokens) {
    const matched = matchSingleAreaVocabularyToken(rt, allAreaTokens);
    if (matched) {
      if (matched.confidence === "fuzzy") confidence = "fuzzy";
      if (!matchedTokens.includes(matched.token)) matchedTokens.push(matched.token);
      continue;
    }
    // Abreviatura / siglas (RH, TI): una sola área clara → seguro.
    if (/^[a-z]{2,6}$/.test(rt)) {
      const byAcro = catalog.filter((c) => {
        const acro = areaAcronym(c.norm);
        return acro === rt || (rt.length >= 2 && acro.startsWith(rt));
      });
      if (byAcro.length === 1) {
        for (const t of byAcro[0].tokens) {
          if (!matchedTokens.includes(t)) matchedTokens.push(t);
        }
        continue;
      }
      if (byAcro.length > 1) {
        confidence = "fuzzy";
        for (const t of byAcro[0].tokens) {
          if (!matchedTokens.includes(t)) matchedTokens.push(t);
        }
        continue;
      }
      // Prefijo exacto único ("cont" → Contabilidad)
      if (rt.length >= 3) {
        const byPrefix = catalog.filter((c) =>
          c.tokens.some((t) => t.startsWith(rt)),
        );
        if (byPrefix.length === 1) {
          for (const t of byPrefix[0].tokens) {
            if (!matchedTokens.includes(t)) matchedTokens.push(t);
          }
          continue;
        }
        if (byPrefix.length > 1) {
          confidence = "fuzzy";
          for (const t of byPrefix[0].tokens) {
            if (!matchedTokens.includes(t)) matchedTokens.push(t);
          }
          continue;
        }
      }
    }
    // Ruido de la frase (“equipos”, “raros”, “dell”…): no tumbar el match del área.
    skippedNoise += 1;
    if (skippedNoise > 4) return null;
  }

  if (!matchedTokens.length) return null;
  return {
    rawLabel: matchedTokens.join(" "),
    matchedTokens,
    confidence,
    rawNeedles: rawTokens,
  };
}

function buildAreaConfirmAskReply(
  rawNeedle: string,
  candidates: AreaCandidateSummary[],
): string {
  if (candidates.length === 1) {
    return (
      `No estoy seguro de “${rawNeedle}”. ¿Te referías al área **${candidates[0].name}**? ` +
      `Responde **sí** o escribe el nombre correcto.`
    );
  }
  const names = candidates
    .slice(0, 5)
    .map((c, i) => `**${i + 1}. ${c.name}**`)
    .join(", ");
  return (
    `No estoy seguro de “${rawNeedle}”. ¿Te referías a alguna de estas áreas: ${names}? ` +
    `Dime el **número**, el nombre, o reformula.`
  );
}

function areaCandidateMatchesTokens(
  cand: AreaCandidateSummary,
  queryTokens: string[],
): boolean {
  if (!queryTokens.length) return false;
  return queryTokens.every(
    (qt) =>
      cand.tokens.includes(qt) ||
      cand.tokens.some((ct) => ct.length >= 4 && qt.length >= 4 && ct.includes(qt)),
  );
}

function findMatchingAreasForPrompt(
  userText: string,
  inventory: InventarioRow[],
): {
  queryLabel: string;
  queryTokens: string[];
  candidates: AreaCandidateSummary[];
  intent: "list" | "total";
  limit: number | null;
  /** Typo / ambigüedad: preguntar antes de abrir visor. */
  uncertain: boolean;
  rawNeedle: string;
} | undefined {
  if (!inventory.length) return undefined;
  if (isNonConcreteChatAsk(userText) || isExploratoryChatAsk(userText)) {
    return undefined;
  }
  if (looksLikeDeleteRecordAsk(userText) || userAskedQr(userText)) {
    return undefined;
  }
  const n = normalizeChatIntent(userText);
  if (!n) return undefined;
  // Mutaciones / ediciones no son consultas de área
  if (
    intentHas(
      n,
      "cambia",
      "cambiar",
      "actualiza",
      "actualizar",
      "agrega",
      "agregar",
      "sube",
      "subir",
      "importa",
      "importar",
    )
  ) {
    return undefined;
  }
  // Ranking general de todas las áreas ("todas las áreas", "qué áreas hay")
  if (
    intentHas(n, "areas", "area") &&
    (intentHas(n, "todas", "todos", "ranking", "distribucion", "desglose") ||
      /^(que|cuales|cuantas)\s+areas\s+(hay|existen|tiene)/.test(n) ||
      /^(areas|por areas)$/.test(n))
  ) {
    return undefined;
  }
  // Anáfora de persona ("su inventario general")
  if (
    !intentHas(n, "area", "areas", "edif", "edificio", "edificios") &&
    looksLikePersonAnaphora(userText)
  ) {
    return undefined;
  }

  const catalog = getAllAreaCatalog(inventory);
  const extracted = extractAreaQueryTokens(userText, catalog);
  if (!extracted) return undefined;

  let candidates = catalog.filter((cand) =>
    areaCandidateMatchesTokens(cand, extracted.matchedTokens),
  );

  // Si el match fue fuzzy, ampliar a todas las áreas cercanas al needle crudo.
  if (extracted.confidence === "fuzzy" && extracted.rawNeedles.length) {
    const needle = extracted.rawNeedles[extracted.rawNeedles.length - 1];
    const allAreaTokens = new Set<string>();
    for (const item of catalog) {
      for (const t of item.tokens) allAreaTokens.add(t);
    }
    const near = new Set<string>();
    for (const tok of allAreaTokens) {
      if (tok.length < 3) continue;
      if (tok.startsWith(needle) || needle.startsWith(tok)) {
        near.add(tok);
        continue;
      }
      if (needle.length >= 4 && tok.length >= needle.length) {
        if (levenshtein(needle, tok.slice(0, needle.length)) <= 1) near.add(tok);
      }
      if (
        Math.abs(tok.length - needle.length) <= 1 &&
        levenshtein(needle, tok) <= 1
      ) {
        near.add(tok);
      }
    }
    if (near.size) {
      candidates = catalog.filter((cand) =>
        cand.tokens.some((t) => near.has(t)),
      );
    }
  }

  if (!candidates.length) return undefined;

  const requestedCount = parseRequestedCount(userText);
  const onlyTotalVerb =
    (intentHas(n, "cuantos", "cuantas", "cuanto", "cuanta", "total", "totales", "conteo") &&
      !intentHas(
        n,
        "dame",
        "muestra",
        "mostrar",
        "ver",
        "lista",
        "listar",
        "cuales",
        "que",
      )) &&
    requestedCount == null;

  const rawNeedle =
    extracted.rawNeedles[extracted.rawNeedles.length - 1] || extracted.rawLabel;

  return {
    queryLabel: extracted.rawLabel,
    queryTokens: extracted.matchedTokens,
    candidates,
    intent: onlyTotalVerb ? "total" : "list",
    limit:
      requestedCount != null
        ? Math.max(1, Math.min(MAX_ETIQUETA_LIST, requestedCount))
        : null,
    uncertain: extracted.confidence === "fuzzy",
    rawNeedle,
  };
}

function findMatchingPeopleForPrompt(
  userText: string,
  inventory: InventarioRow[],
): {
  queryLabel: string;
  candidates: PersonCandidateSummary[];
  intent: "list" | "total";
  limit: number | null;
} | undefined {
  if (!inventory.length) return undefined;
  if (isNonConcreteChatAsk(userText) || isExploratoryChatAsk(userText)) {
    return undefined;
  }
  if (looksLikeDeleteRecordAsk(userText) || userAskedQr(userText)) {
    return undefined;
  }
  const n = normalizeChatIntent(userText);
  if (!n || /\b\d{4,}\b/.test(n)) return undefined;
  if (
    intentHas(
      n,
      "area",
      "areas",
      "edif",
      "edificio",
      "edificios",
      "cambia",
      "cambiar",
      "actualiza",
      "actualizar",
    )
  ) {
    return undefined;
  }
  // Ranking global de personas
  if (
    intentHas(n, "personas", "persona") &&
    (intentHas(n, "todas", "todos", "ranking", "quien", "mas") ||
      /^(que|cuales|cuantas)\s+personas/.test(n) ||
      /^(personas|por personas)$/.test(n))
  ) {
    return undefined;
  }
  // "dame sus etiquetas" → anáfora (paso 4), no buscar persona por tokens sueltos.
  if (looksLikePersonAnaphora(userText) || looksLikePersonEtiquetasAsk(userText)) {
    return undefined;
  }

  const plain0 = stripRequestedCountPhrases(normalizePlain(userText));
  const rawTokens = plain0
    .split(" ")
    .filter(
      (t) =>
        t.length > 2 &&
        !PERSON_STOP_WORDS.has(t) &&
        !AREA_QUERY_STOP_WORDS.has(t),
    );
  if (!rawTokens.length) return undefined;

  const catalog = getAllPersonCatalog(inventory);
  const allPersonTokens = new Set<string>();
  for (const p of catalog) {
    for (const t of p.tokens) allPersonTokens.add(t);
  }

  const matchedPersonTokens: string[] = [];
  for (const rt of rawTokens) {
    const m = matchSingleAreaVocabularyToken(rt, allPersonTokens);
    if (!m || m.confidence === "fuzzy") return undefined;
    if (!matchedPersonTokens.includes(m.token)) matchedPersonTokens.push(m.token);
  }
  if (!matchedPersonTokens.length) return undefined;

  const candidates = catalog.filter((cand) =>
    matchedPersonTokens.every((pt) => cand.tokens.includes(pt)),
  );
  if (!candidates.length) return undefined;

  const requestedCount = parseRequestedCount(userText);
  return {
    queryLabel: matchedPersonTokens.join(" ").toUpperCase(),
    candidates,
    intent: requestedCount != null ? "list" : "total",
    limit:
      requestedCount != null
        ? Math.max(1, Math.min(MAX_ETIQUETA_LIST, requestedCount))
        : null,
  };
}

function buildAreaDisambiguationReply(
  queryLabel: string,
  candidates: AreaCandidateSummary[],
  intent: "list" | "total",
  limit: number | null,
): string {
  const totalRows = candidates.reduce((acc, c) => acc + c.rows.length, 0);
  const allPeople = new Set<string>();
  for (const c of candidates) {
    for (const r of c.rows) {
      const p = String(r.persona ?? "").trim();
      if (p) allPeople.add(p);
    }
  }
  const lines = candidates.map(
    (c, idx) =>
      `• **${idx + 1}. ${c.name}** — **${c.rows.length.toLocaleString("es-MX")}** registro${c.rows.length === 1 ? "" : "s"} (${c.personas} persona${c.personas === 1 ? "" : "s"} · ${c.activos} activo${c.activos === 1 ? "" : "s"})`,
  );
  const askTarget =
    limit != null
      ? `los **${limit} registros** solicitados`
      : intent === "total"
        ? "el total y detalle"
        : "los registros";

  return (
    `Encontré **${candidates.length} áreas** en el inventario que coinciden con **«${queryLabel}»** (**${totalRows.toLocaleString("es-MX")} registros** y **${allPeople.size} persona${allPeople.size === 1 ? "" : "s"}** en conjunto):\n\n` +
    `${lines.join("\n")}\n\n` +
    `Para evitar ambigüedad, ¿a cuál de estas **${candidates.length} áreas** deseas consultar ${askTarget}? ` +
    `Indícame el **número de opción (1 al ${candidates.length})**, el **nombre específico del área**, o selecciónala directamente en el panel derecho.`
  );
}

function buildPersonDisambiguationReply(
  queryLabel: string,
  candidates: PersonCandidateSummary[],
  limit: number | null,
): string {
  const totalRows = candidates.reduce((acc, c) => acc + c.rows.length, 0);
  const lines = candidates.map(
    (c, idx) =>
      `• **${idx + 1}. ${c.name}** — **${c.rows.length.toLocaleString("es-MX")}** registro${c.rows.length === 1 ? "" : "s"} (${c.areas} área${c.areas === 1 ? "" : "s"} · ${c.activos} activo${c.activos === 1 ? "" : "s"})`,
  );
  const askTarget =
    limit != null ? `los **${limit} registros**` : "el inventario asignado";

  return (
    `Encontré **${candidates.length} personas** que coinciden con **«${queryLabel}»** (**${totalRows.toLocaleString("es-MX")} registros** en conjunto):\n\n` +
    `${lines.join("\n")}\n\n` +
    `¿De cuál de ellas deseas consultar ${askTarget}? ` +
    `Puedes escribir el **número de opción (1 al ${candidates.length})**, el **nombre completo**, o elegirla en el panel derecho.`
  );
}

function buildExactAreaReply(
  areaSummary: AreaCandidateSummary,
  limit: number | null,
): {
  reply: string;
  shownRows: InventarioRow[];
} {
  const total = areaSummary.rows.length;
  const effectiveLimit =
    limit != null
      ? Math.min(total, Math.max(1, limit))
      : Math.min(total, MAX_ETIQUETA_LIST);
  const shownRows = areaSummary.rows.slice(0, effectiveLimit);
  const samples = shownRows.slice(0, 5).map((row) => {
    const tag = String(row.etiqueta ?? "").trim() || "S/E";
    const art = String(row.articulo ?? "").trim() || "Artículo";
    const per = String(row.persona ?? "").trim() || "Sin asignar";
    return `**${tag}** (${art}, ${per})`;
  });
  let sampleProse = "";
  if (samples.length === 1) {
    sampleProse = ` Por ejemplo: ${samples[0]}.`;
  } else if (samples.length > 1) {
    const head = samples.slice(0, -1).join(", ");
    sampleProse = ` Algunos ejemplos: ${head} y ${samples[samples.length - 1]}.`;
  }

  const scopeNote =
    limit != null && limit < total
      ? ` Te muestro los **${shownRows.length}** que pediste (de **${total}** en el área).`
      : shownRows.length < total
        ? ` El detalle completo de los **${total}** está en el panel derecho.`
        : ` El detalle está en el panel derecho.`;

  const reply =
    `En el área **${areaSummary.name}** hay **${total.toLocaleString("es-MX")}** registro${total === 1 ? "" : "s"} en total ` +
    `(**${areaSummary.personas}** persona${areaSummary.personas === 1 ? "" : "s"} · **${areaSummary.activos}** activo${areaSummary.activos === 1 ? "" : "s"}).` +
    sampleProse +
    scopeNote +
    ` ¿Quieres filtrar por persona, consultar otra área o generar códigos QR?`;

  return { reply, shownRows };
}

function buildExactPersonReply(
  personSummary: PersonCandidateSummary,
  limit: number | null,
): {
  reply: string;
  shownRows: InventarioRow[];
} {
  const total = personSummary.rows.length;
  const effectiveLimit =
    limit != null
      ? Math.min(total, Math.max(1, limit))
      : Math.min(total, MAX_ETIQUETA_LIST);
  const shownRows = personSummary.rows.slice(0, effectiveLimit);
  const areas = [
    ...new Set(
      personSummary.rows
        .map((row) => String(row.area ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const areaLine =
    areas.length === 0
      ? "sin área registrada"
      : areas.length <= 3
        ? areas.join(", ")
        : `${areas.slice(0, 3).join(", ")} y ${areas.length - 3} más`;

  const samples = shownRows.slice(0, 5).map((row) => {
    const tag = String(row.etiqueta ?? "").trim() || "S/E";
    const art = String(row.articulo ?? "").trim() || "Artículo";
    const ar = String(row.area ?? "").trim() || "Sin área";
    return `**${tag}** (${art}, ${ar})`;
  });
  let sampleProse = "";
  if (samples.length === 1) {
    sampleProse = ` Por ejemplo: ${samples[0]}.`;
  } else if (samples.length > 1) {
    const head = samples.slice(0, -1).join(", ");
    sampleProse = ` Algunos ejemplos: ${head} y ${samples[samples.length - 1]}.`;
  }

  const reply =
    `**${personSummary.name}** tiene **${total.toLocaleString("es-MX")}** registro${total === 1 ? "" : "s"} ` +
    `(**${personSummary.activos}** activo${personSummary.activos === 1 ? "" : "s"}) en **${areas.length}** área${areas.length === 1 ? "" : "s"} (${areaLine}).` +
    sampleProse +
    ` El detalle está en el panel derecho. ¿Quieres generar QR o filtrar por un área?`;

  return { reply, shownRows };
}

function resolvePendingDisambiguation(
  userText: string,
  pending: PendingDisambiguationState,
  inventory: InventarioRow[],
):
  | {
      status: "resolved_area";
      area: AreaCandidateSummary;
      limit: number | null;
    }
  | {
      status: "resolved_person";
      person: PersonCandidateSummary;
      limit: number | null;
    }
  | {
      status: "narrowed_area";
      queryLabel: string;
      candidates: AreaCandidateSummary[];
      intent: "list" | "total";
      limit: number | null;
    }
  | {
      status: "narrowed_person";
      queryLabel: string;
      candidates: PersonCandidateSummary[];
      limit: number | null;
    }
  | { status: "unrelated" } {
  const plain = normalizePlain(userText);
  if (!plain) return { status: "unrelated" };

  const newRequestedCount = parseRequestedCount(userText);
  const effectiveLimit = newRequestedCount ?? pending.limit;
  const strippedPlain = stripRequestedCountPhrases(plain);

  // 1. Verificar selección por número de opción ("1", "la 2", "opción 3", "la primera")
  // Evitar confundir números de sala/salón ("sala 2", "computo 1", "salon 5", "cubiculo 2") con opción 1/2
  const hasRoomNumber =
    /\b(?:sala|computo|salon|cubiculo|edif|edificio|f|lab|laboratorio)\s*(?:de\s+computo\s*)?\d+\b/.test(
      strippedPlain,
    );

  let chosenIndex: number | null = null;
  const directNumMatch =
    strippedPlain.match(
      /^(?:la|el|opcion|incidencia|numero|num|area|persona)?\s*(\d{1,2})$/,
    ) ||
    strippedPlain.match(
      /\b(?:opcion|incidencia|numero|num)\s*(\d{1,2})\b/,
    ) ||
    (!hasRoomNumber
      ? strippedPlain.match(
          /^(?:quiero|dame|muestra|muestrame|ver|consultar|consulta|elijo|selecciono)\s+(?:la|el|opcion|incidencia)?\s*(\d{1,2})$/,
        )
      : null);

  if (directNumMatch) {
    const nVal = Number(directNumMatch[1]);
    if (Number.isFinite(nVal) && nVal >= 1 && nVal <= pending.candidates.length) {
      chosenIndex = nVal - 1;
    }
  } else if (!hasRoomNumber) {
    const words = strippedPlain.split(" ").filter(Boolean);
    if (words.length <= 4) {
      for (const w of words) {
        const ord = ORDINAL_INDEX_MAP[w];
        if (ord && ord >= 1 && ord <= pending.candidates.length) {
          chosenIndex = ord - 1;
          break;
        }
      }
    }
  }

  if (pending.kind === "area") {
    const catalog = getAllAreaCatalog(inventory);
    const pendingCatalog = pending.candidates
      .map((name) => catalog.find((c) => c.name === name))
      .filter((c): c is AreaCandidateSummary => Boolean(c));

    if (!pendingCatalog.length) return { status: "unrelated" };

    if (chosenIndex != null && pendingCatalog[chosenIndex]) {
      return {
        status: "resolved_area",
        area: pendingCatalog[chosenIndex],
        limit: effectiveLimit,
      };
    }

    // Confirmación corta (“sí”, “dale”) cuando solo hay una opción sugerida.
    if (
      pendingCatalog.length === 1 &&
      /^(si|sip|sep|dale|ok|okay|okey|vale|claro|correcto|esa|ese|eso|afirmativo)$/.test(
        strippedPlain,
      )
    ) {
      return {
        status: "resolved_area",
        area: pendingCatalog[0],
        limit: effectiveLimit,
      };
    }

    // 2. Coincidencia exacta por nombre de área completo (ej. clic en "BIBLIOTECA NUEVA" o escribir "biblioteca nueva")
    const fullNorm = plain.replace(/\b(?:edificios?|edifs)\b/g, "edif");
    const exactFull = pendingCatalog.find((c) => c.norm === fullNorm);
    if (exactFull) {
      return {
        status: "resolved_area",
        area: exactFull,
        limit: effectiveLimit,
      };
    }

    // 3. Extraer tokens de área del mensaje de seguimiento
    let extracted = extractAreaQueryTokens(userText, catalog);
    // Abreviatura corta suelta ("RH", "TI") si el extractor no armó tokens.
    if (!extracted || !extracted.matchedTokens.length) {
      const abbrHit = matchAreaFromPrompt(userText, inventory);
      if (abbrHit) {
        const hitCand =
          pendingCatalog.find((c) => c.name === abbrHit) ||
          pendingCatalog.find((c) => areaMatchesNeedle(c.name, abbrHit));
        if (hitCand) {
          return {
            status: "resolved_area",
            area: hitCand,
            limit: effectiveLimit,
          };
        }
      }
      return { status: "unrelated" };
    }
    const qPhrase = extracted.matchedTokens.join(" ");

    // Si los tokens extraídos coinciden exactamente con el nombre canónico de uno de los candidatos
    // (ej. el usuario escribió "dame los de biblioteca nueva" -> tokens ["biblioteca", "nueva"] == "BIBLIOTECA NUEVA")
    const exactByExtracted = pendingCatalog.find((c) => c.norm === qPhrase);
    if (exactByExtracted) {
      return {
        status: "resolved_area",
        area: exactByExtracted,
        limit: effectiveLimit,
      };
    }

    // 4. Filtrar entre los candidatos pendientes los que cumplan todos los tokens nuevos (ej. "sala 2" -> solo Sala 2)
    const narrowed = pendingCatalog.filter((c) =>
      areaCandidateMatchesTokens(c, extracted.matchedTokens),
    );
    if (narrowed.length === 1) {
      return {
        status: "resolved_area",
        area: narrowed[0],
        limit: effectiveLimit,
      };
    }
    if (narrowed.length > 1) {
      return {
        status: "narrowed_area",
        queryLabel: extracted.rawLabel,
        candidates: narrowed,
        intent: pending.intent,
        limit: effectiveLimit,
      };
    }

    // 5. ¿Y si el usuario mencionó una combinación de tokens donde los candidatos pendientes no tenían el prefijo
    // (ej. dijo solo "general" refiriéndose al área base sin sufijo)?
    if (
      strippedPlain.includes("general") ||
      strippedPlain.includes("principal") ||
      strippedPlain.includes("solo")
    ) {
      const shortest = [...pendingCatalog].sort(
        (a, b) => a.tokens.length - b.tokens.length,
      )[0];
      if (shortest) {
        return {
          status: "resolved_area",
          area: shortest,
          limit: effectiveLimit,
        };
      }
    }

    return { status: "unrelated" };
  }

  // kind === "person"
  const personCatalog = getAllPersonCatalog(inventory);
  const pendingPeople = pending.candidates
    .map((name) => personCatalog.find((c) => c.name === name))
    .filter((c): c is PersonCandidateSummary => Boolean(c));

  if (!pendingPeople.length) return { status: "unrelated" };

  if (chosenIndex != null && pendingPeople[chosenIndex]) {
    return {
      status: "resolved_person",
      person: pendingPeople[chosenIndex],
      limit: effectiveLimit,
    };
  }

  const exactPersonFull = pendingPeople.find((c) => c.norm === plain);
  if (exactPersonFull) {
    return {
      status: "resolved_person",
      person: exactPersonFull,
      limit: effectiveLimit,
    };
  }

  const personMatched = findMatchingPeopleForPrompt(userText, inventory);
  if (!personMatched) return { status: "unrelated" };

  const inPending = pendingPeople.filter((p) =>
    personMatched.candidates.some((mc) => mc.name === p.name),
  );
  if (inPending.length === 1) {
    return {
      status: "resolved_person",
      person: inPending[0],
      limit: effectiveLimit,
    };
  }
  if (inPending.length > 1) {
    return {
      status: "narrowed_person",
      queryLabel: personMatched.queryLabel,
      candidates: inPending,
      limit: effectiveLimit,
    };
  }

  return { status: "unrelated" };
}

/** Pedido de borrar un registro del inventario (no chats). */
function looksLikeDeleteRecordAsk(userText: string) {
  const n = normalizeChatIntent(userText);
  if (!n || isNonConcreteChatAsk(userText)) return false;
  const deleteVerb =
    /\b(elimina|eliminar|elimine|eliminaras|borra|borrar|borre|quita|quitar|suprimir)\b/.test(
      n,
    );
  if (!deleteVerb) return false;
  if (/\b(chat|busqueda|conversacion|mensaje)\b/.test(n)) return false;
  return (
    /\b(registro|registros|etiqueta|etiquetas|articulo|articulos|equipo|equipos|este|esta|ese|esa|uno|un)\b/.test(
      n,
    ) || /\b\d{3,}\b/.test(n)
  );
}

function userAskedQr(userText: string): boolean {
  if (parseEtiquetaListAsk(userText) != null) return false;
  const n = normalizeChatIntent(userText);
  return (
    /\bqr\b/.test(n) ||
    /\bcodigos?\s*qr\b/.test(n) ||
    /\bqr\s*codigos?\b/.test(n) ||
    (/\bcodigos?\b/.test(n) && !/\betiquet/.test(n))
  );
}

function messageHasSideData(message: ChatMessage) {
  return (
    message.from === "bot" &&
    ((Array.isArray(message.resultItems) && message.resultItems.length > 0) ||
      (Array.isArray(message.qr) && message.qr.length > 0) ||
      Boolean(message.viewerOverview))
  );
}

/** Distancia de edición para corregir faltas de ortografía. */
function levenshtein(a: string, b: string) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  // Typos difíciles: permitir hasta 4 letras de diferencia de largo.
  if (Math.abs(a.length - b.length) > 4) return 99;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cur = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = cur;
    }
  }
  return row[b.length];
}

function typoBudget(word: string) {
  if (word.length <= 3) return 0;
  if (word.length <= 5) return 1;
  if (word.length <= 8) return 2;
  return 3;
}

/** Variantes típicas ES: b/v, s/z/c, g/j, h muda, dobles. */
function spellingVariants(token: string): string[] {
  const out = new Set<string>([token]);
  const push = (s: string) => {
    if (s && s !== token) out.add(s);
  };
  push(token.replace(/v/g, "b"));
  push(token.replace(/b/g, "v"));
  push(token.replace(/z/g, "s"));
  push(token.replace(/s(?=[aeiou])/g, "z"));
  push(token.replace(/c(?=[ei])/g, "s"));
  push(token.replace(/g(?=[ei])/g, "j"));
  push(token.replace(/j(?=[aeiou])/g, "g"));
  push(token.replace(/h/g, ""));
  push(token.replace(/(.)\1+/g, "$1"));
  // Inserción/omisión simple de una vocal repetida frecuente
  if (token.length >= 5) {
    for (let i = 0; i < token.length; i += 1) {
      push(token.slice(0, i) + token.slice(i + 1));
    }
  }
  return [...out];
}

/** Solo minúsculas/acentos — NO corre ortografía (rápido para áreas del inventario). */
function normalizePlain(raw: string) {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRowActivo(row: { estado?: string | null }) {
  const v = String(row.estado ?? "")
    .trim()
    .toLowerCase();
  return !(
    v === "inactivo" ||
    v === "baja" ||
    v === "no" ||
    v === "inactive"
  );
}

type AreaSearchIndex = {
  tokens: string[];
  byToken: Map<string, string[]>;
  size: number;
};

let areaIndexCache: AreaSearchIndex | null = null;
let areaIndexSize = -1;

function getAreaSearchIndex(inventory: InventarioRow[]): AreaSearchIndex {
  if (areaIndexCache && areaIndexSize === inventory.length) {
    return areaIndexCache;
  }
  const tokenSet = new Set<string>();
  const byToken = new Map<string, string[]>();
  for (const row of inventory) {
    const area = String(row.area ?? "").trim();
    if (!area) continue;
    const norm = normalizePlain(area);
    if (!norm) continue;
    for (const tok of norm.split(" ")) {
      if (tok.length < 2) continue;
      tokenSet.add(tok);
      const list = byToken.get(tok);
      if (list) {
        if (list.length < 8 && !list.includes(area)) list.push(area);
      } else {
        byToken.set(tok, [area]);
      }
    }
    const acro = areaAcronym(norm);
    if (acro.length >= 2) {
      tokenSet.add(acro);
      const list = byToken.get(acro);
      if (list) {
        if (list.length < 8 && !list.includes(area)) list.push(area);
      } else {
        byToken.set(acro, [area]);
      }
    }
  }
  areaIndexCache = {
    tokens: Array.from(tokenSet),
    byToken,
    size: inventory.length,
  };
  areaIndexSize = inventory.length;
  return areaIndexCache;
}

const PERSON_STOP_WORDS = new Set([
  ...AREA_STOP_WORDS,
  "general",
  "completo",
  "completa",
  "total",
  "totales",
  "conteo",
  "cuantos",
  "cuantas",
  "cuanto",
  "cuanta",
  "tiene",
  "tienen",
  "hay",
  "cosas",
  "cosa",
  "nombre",
  "nombres",
  "lo",
  "le",
  "me",
  "te",
  "ese",
  "esa",
  "eso",
  "este",
  "esta",
  "aqui",
  "alli",
  "mismo",
  "misma",
  "nada",
  "mas",
]);

type PersonSearchIndex = {
  people: Array<{ raw: string; norm: string; tokens: string[] }>;
  size: number;
};

let personIndexCache: PersonSearchIndex | null = null;
let personIndexSize = -1;

function getPersonSearchIndex(inventory: InventarioRow[]): PersonSearchIndex {
  if (personIndexCache && personIndexSize === inventory.length) {
    return personIndexCache;
  }
  const seen = new Set<string>();
  const people: PersonSearchIndex["people"] = [];
  for (const row of inventory) {
    const raw = String(row.persona ?? "").trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const norm = normalizePlain(raw);
    people.push({
      raw,
      norm,
      tokens: norm.split(" ").filter((t) => t.length > 2),
    });
  }
  personIndexCache = { people, size: inventory.length };
  personIndexSize = inventory.length;
  return personIndexCache;
}

function findPersonInText(
  userText: string,
  inventory: InventarioRow[],
): string | undefined {
  const user = normalizeChatIntent(userText);
  if (!user) return undefined;
  const tokens = user
    .split(/\s+/)
    .filter((t) => t.length > 2 && !PERSON_STOP_WORDS.has(t));
  if (!tokens.length) return undefined;
  const phrase = tokens.join(" ");
  const idx = getPersonSearchIndex(inventory);
  let best: { raw: string; score: number } | null = null;
  for (const person of idx.people) {
    if (!person.tokens.length) continue;
    let score = 0;
    if (person.norm === user) score = 1200;
    else if (tokens.length && tokens.every((t) => person.tokens.includes(t))) {
      score = 700 + tokens.length * 40;
    } else {
      for (const tok of tokens) {
        if (person.tokens.includes(tok)) {
          score += tok.length >= 4 ? 90 : 55;
          continue;
        }
        const budget = typoBudget(tok);
        if (budget <= 0) continue;
        for (const pTok of person.tokens) {
          if (Math.abs(pTok.length - tok.length) > budget) continue;
          const dist = levenshtein(tok, pTok);
          if (dist <= budget) {
            score += 40 - dist;
            break;
          }
        }
      }
    }
    if (person.norm.includes(phrase) && phrase.length >= 4) {
      score = Math.max(score, 650);
    }
    if (score < 80) continue;
    if (!best || score > best.score) best = { raw: person.raw, score };
  }
  return best?.raw;
}

function looksLikePersonAnaphora(userText: string) {
  const n = normalizeChatIntent(userText);
  if (!n) return false;
  return (
    /\b(su|sus)\b/.test(n) ||
    /\bde el\b/.test(n) ||
    /\bde ella\b/.test(n) ||
    /\besa persona\b/.test(n) ||
    /\bde esa persona\b/.test(n)
  );
}

function resolvePersonFocus(
  userText: string,
  inventory: InventarioRow[],
  recentMessages?: Array<{
    from: string;
    text: string;
    resultItems?: ChatApiItem[];
    viewerFocus?: string;
    viewerOverview?: ViewerOverview;
  }>,
): string | undefined {
  const named = findPersonInText(userText, inventory);
  if (named) return named;
  if (!looksLikePersonAnaphora(userText) || !recentMessages?.length) {
    return undefined;
  }
  const current = normalizeChatIntent(userText);
  // 1) Foco del último bot con persona (panel) — evita mezclar otra persona.
  for (let i = recentMessages.length - 1; i >= 0; i -= 1) {
    const message = recentMessages[i];
    if (message.from !== "bot") continue;
    const focus = String(message.viewerFocus || "").trim();
    if (!focus) continue;
    if (
      message.viewerOverview === "areaTotal" ||
      message.viewerOverview === "areaMatches"
    ) {
      continue;
    }
    const catalog = getAllPersonCatalog(inventory);
    const hit =
      catalog.find((p) => p.name === focus) ||
      catalog.find((p) =>
        normalizeChatIntent(p.name).includes(normalizeChatIntent(focus)),
      );
    if (hit) return hit.name;
    if (rowsForPersonName(inventory, focus).length) return focus;
  }
  // 2) Nombre en el texto del mensaje previo / única persona en resultItems.
  for (let i = recentMessages.length - 1; i >= 0; i -= 1) {
    const message = recentMessages[i];
    if (normalizeChatIntent(message.text || "") === current) continue;
    const fromText = findPersonInText(message.text || "", inventory);
    if (fromText) return fromText;
    const people = [
      ...new Set(
        (message.resultItems || [])
          .map((item) => String(item.persona ?? "").trim())
          .filter(Boolean),
      ),
    ];
    if (people.length === 1) return people[0];
  }
  return undefined;
}

/** Inventario / totales de una persona concreta (p. ej. Martín). */
function detectPersonTotalAsk(
  userText: string,
  inventory: InventarioRow[],
  recentMessages?: Array<{ from: string; text: string; resultItems?: ChatApiItem[] }>,
): string | undefined {
  const user = normalizeChatIntent(userText);
  if (!user) return undefined;
  if (parseEtiquetaListAsk(userText) != null) return undefined;
  if (userAskedQr(userText)) return undefined;
  const wantsPersonView =
    intentHas(
      user,
      "inventario",
      "inventarios",
      "resumen",
      "total",
      "totales",
      "general",
      "registros",
      "registro",
      "articulos",
      "articulo",
      "equipos",
      "equipo",
      "cosas",
      "persona",
      "personas",
    ) ||
    /\b(tiene|tienen|asignad)\b/.test(user) ||
    intentHas(user, "dame", "muestra", "mostrar", "ver", "ensename");
  if (!wantsPersonView && !looksLikePersonAnaphora(userText)) {
    const onlyName = findPersonInText(userText, inventory);
    if (onlyName && user.split(/\s+/).length <= 4) return onlyName;
    return undefined;
  }
  return resolvePersonFocus(userText, inventory, recentMessages);
}

function rowsForPersonName(inventory: InventarioRow[], person: string) {
  const n = normalizePlain(person);
  if (!n) return [] as InventarioRow[];
  return inventory.filter((row) => {
    const p = normalizePlain(String(row.persona ?? ""));
    if (!p) return false;
    if (p === n || p.includes(n) || n.includes(p)) return true;
    const pToks = p.split(" ").filter(Boolean);
    const nToks = n.split(" ").filter(Boolean);
    return nToks.length > 0 && nToks.every((tok) => pToks.includes(tok));
  });
}

function buildPersonTotalReply(person: string, inventory: InventarioRow[]) {
  const rows = rowsForPersonName(inventory, person);
  const n = rows.length;
  if (!n) {
    return `No encontré registros asignados a **${person}**. ¿Quieres buscar con otro nombre?`;
  }
  const areas = [
    ...new Set(
      rows.map((row) => String(row.area ?? "").trim()).filter(Boolean),
    ),
  ];
  const activos = rows.filter(isRowActivo).length;
  const areaLine =
    areas.length === 0
      ? "sin área registrada"
      : areas.length <= 3
        ? areas.join(", ")
        : `${areas.slice(0, 3).join(", ")} y ${areas.length - 3} más`;
  return (
    `**${person}** tiene **${n}** registro${n === 1 ? "" : "s"} ` +
    `(**${activos}** activo${activos === 1 ? "" : "s"}) en **${areas.length || 0}** ` +
    `área${areas.length === 1 ? "" : "s"}: ${areaLine}.\n\n` +
    `El detalle está en el visor derecho.\n\n` +
    `¿Quieres ver las etiquetas, generar QR o filtrar por un área?`
  );
}

const INTENT_BY_PREFIX = new Map<string, string[]>();
function intentCandidatesFor(token: string): string[] {
  if (!INTENT_BY_PREFIX.size) {
    for (const canon of INTENT_CANONICAL) {
      const key = canon.slice(0, 1);
      const list = INTENT_BY_PREFIX.get(key);
      if (list) list.push(canon);
      else INTENT_BY_PREFIX.set(key, [canon]);
    }
  }
  const budget = typoBudget(token);
  if (budget <= 0) return [];
  const same = INTENT_BY_PREFIX.get(token.slice(0, 1)) || [];
  // Prefijo distinto: solo palabras de largo parecido (pocas).
  const out = same.filter((c) => Math.abs(c.length - token.length) <= budget);
  if (out.length) return out;
  return (INTENT_CANONICAL as readonly string[]).filter(
    (c) => Math.abs(c.length - token.length) <= budget,
  );
}

/** Vocabulario del detector (formas canónicas). */
const INTENT_CANONICAL = [
  "area",
  "areas",
  "persona",
  "personas",
  "marca",
  "marcas",
  "estado",
  "activo",
  "activos",
  "inactivo",
  "inactivos",
  "reciente",
  "recientes",
  "inventario",
  "inventarios",
  "general",
  "completo",
  "resumen",
  "total",
  "totales",
  "todo",
  "conteo",
  "panorama",
  "dashboard",
  "etiqueta",
  "etiquetas",
  "codigo",
  "codigos",
  "qr",
  "dame",
  "muestra",
  "mostrar",
  "ver",
  "quiero",
  "lista",
  "listar",
  "desglose",
  "todas",
  "todos",
  "cuantos",
  "cuantas",
  "cuanto",
  "cuanta",
  "articulo",
  "articulos",
  "registro",
  "registros",
  "ultimo",
  "ultimos",
  "equipo",
  "equipos",
  "top",
  "por",
  "ensename",
  "ensenar",
  "ensena",
  "crea",
  "crear",
  "genera",
  "generar",
  "haz",
  "hacer",
  "abre",
  "abrir",
  "trae",
  "sube",
  "subir",
  "importa",
  "importar",
  "carga",
  "cargar",
  "cambia",
  "cambiar",
  "actualiza",
  "actualizar",
] as const;

const INTENT_ALIAS: Record<string, string> = {
  // faltas frecuentes / acentos ya quitados
  areea: "area",
  areaz: "areas",
  aresa: "areas",
  ares: "areas",
  areass: "areas",
  persnas: "personas",
  perssonas: "personas",
  personsa: "personas",
  peronas: "personas",
  peronasas: "personas",
  personass: "personas",
  perosnas: "personas",
  venbtas: "ventas",
  ventass: "ventas",
  ventasa: "ventas",
  evantas: "ventas",
  ventaas: "ventas",
  marketin: "marketing",
  marketng: "marketing",
  merke: "marketing",
  markering: "marketing",
  cuandtas: "cuantas",
  marcaa: "marca",
  marcass: "marcas",
  inventaro: "inventario",
  inventrio: "inventario",
  invetario: "inventario",
  inventaroio: "inventario",
  generla: "general",
  genral: "general",
  jeneral: "general",
  resmen: "resumen",
  resumne: "resumen",
  recietes: "recientes",
  recintes: "recientes",
  etiqetas: "etiquetas",
  etiqeutas: "etiquetas",
  etiqutas: "etiquetas",
  regsitros: "registros",
  regsitro: "registro",
  registtros: "registros",
  bblioteca: "biblioteca",
  bbliteca: "biblioteca",
  bibliioteca: "biblioteca",
  codgos: "codigos",
  codgio: "codigo",
  activso: "activos",
  inactivso: "inactivos",
  ensename: "muestra",
  ensenarme: "muestra",
  muestrame: "muestra",
  dime: "dame",
  decirme: "dame",
  digame: "dame",
  dimelos: "dame",
  dimelo: "dame",
  consulta: "busca",
  consultar: "busca",
  consultame: "busca",
  gsuatria: "gustaria",
  gustaria: "gustaria",
  resgittos: "registros",
  resgitto: "registro",
  resgistro: "registro",
  eliminaras: "eliminar",
  elimnar: "eliminar",
  elminar: "eliminar",
};

const INTENT_CANONICAL_SET = new Set<string>(INTENT_CANONICAL as readonly string[]);
const normalizeIntentCache = new Map<string, string>();

function correctIntentToken(token: string) {
  if (!token) return token;
  if (INTENT_ALIAS[token]) return INTENT_ALIAS[token];
  if (INTENT_CANONICAL_SET.has(token)) return token;
  const budget = typoBudget(token);
  if (budget <= 0) return token;
  let best = token;
  let bestDist = Infinity;
  for (const canon of intentCandidatesFor(token)) {
    const dist = levenshtein(token, canon);
    if (dist < bestDist && dist <= budget) {
      bestDist = dist;
      best = canon;
      if (dist === 1) break;
    }
  }
  return best;
}

/** Normaliza + corrige typos de intención (áreas, personas, inventario…). */
function normalizeChatIntent(raw: string) {
  const key = String(raw || "");
  const cached = normalizeIntentCache.get(key);
  if (cached !== undefined) return cached;
  const base = key
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const result = !base
    ? ""
    : base
        .split(" ")
        .map((tok) => correctIntentToken(tok))
        .join(" ");
  if (normalizeIntentCache.size > 400) normalizeIntentCache.clear();
  normalizeIntentCache.set(key, result);
  return result;
}

function intentHas(user: string, ...words: string[]) {
  const set = new Set(user.split(/\s+/));
  return words.some((w) => set.has(w));
}

/** Total de un área concreta → cuadro de totales con el nombre del área. */
function detectAreaTotalAsk(
  userText: string,
  inventory: InventarioRow[],
): string | undefined {
  const user = normalizeChatIntent(userText);
  if (!user) return undefined;
  // "todas las areas" es ranking, no total de una.
  if (
    intentHas(user, "todas", "todos") &&
    intentHas(user, "areas", "area")
  ) {
    return undefined;
  }
  if (
    !intentHas(user, "area", "areas", "edif", "edificio", "edificios") &&
    (looksLikePersonAnaphora(userText) ||
      (intentHas(user, "inventario", "inventarios") &&
        intentHas(user, "general")))
  ) {
    return undefined;
  }
  const wantsTotal =
    intentHas(
      user,
      "cuantos",
      "cuantas",
      "cuanto",
      "cuanta",
      "total",
      "totales",
      "conteo",
    ) || /\bhay\b/.test(user);
  if (!wantsTotal) return undefined;

  const hasAreaCue =
    intentHas(user, "area", "areas", "edif", "edificio", "edificios") ||
    /\b(en|del|de)\b/.test(user) ||
    /\bedif\s*[a-z0-9]\b/.test(user);
  if (!hasAreaCue) return undefined;

  const needle = extractAreaNeedle(userText, inventory);
  if (!needle) return undefined;
  // Nombre legible: primer área real que contenga la aguja.
  const hit = inventory.find((row) =>
    normalizePlain(String(row.area ?? "")).includes(normalizePlain(needle)),
  );
  return hit?.area?.trim() || needle;
}

/** Confirmaciones / muletillas: no abrir incidencia (no pidieron dato concreto). */
function isNonConcreteChatAsk(userText: string) {
  const n = normalizeChatIntent(userText);
  if (!n) return true;
  if (
    /^(ok|okay|okey|oke|vale|va|sale|bueno|bien|gracias|thanks|thank you|de acuerdo|perfecto|listo|entendido|claro|dale|jaj+|jaja+|jeje+|xd|sip|nop|nel|mmm+|ah+|eh+|si|no)$/.test(
      n,
    )
  ) {
    return true;
  }
  // Frases cortas de acuse sin pedido de dato.
  if (
    n.split(/\s+/).length <= 3 &&
    /^(ok|okay|okey|vale|gracias|perfecto|listo|entendido|claro|de acuerdo|esta bien|está bien)\b/.test(
      n,
    )
  ) {
    return true;
  }
  return false;
}

/** Saludos / “qué se puede hacer”: conversación en texto; incidencia solo si aporta. */
function isExploratoryChatAsk(userText: string) {
  const n = normalizeChatIntent(userText);
  if (!n) return true;
  if (isNonConcreteChatAsk(userText)) return true;
  if (
    /\b(que se puede|que puedes|que puedo|que hacemos|que hay para|que hay de nuevo|el dia de hoy|para que sirves|como te uso|como funciona|en que me ayudas|opciones|gustaria saber|quisiera saber|me ayudas)\b/.test(
      n,
    )
  ) {
    return true;
  }
  const greetingLed =
    /^(hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches|hey|saludos)\b/.test(
      n,
    );
  if (!greetingLed) return false;
  const hasDataAsk = intentHas(
    n,
    "etiqueta",
    "etiquetas",
    "qr",
    "codigo",
    "codigos",
    "area",
    "areas",
    "persona",
    "personas",
    "marca",
    "marcas",
    "inventario",
    "recientes",
    "total",
    "totales",
    "cuantos",
    "cuantas",
    "activo",
    "activos",
    "estado",
  );
  return !hasDataAsk;
}

/**
 * El usuario pide VER el resultado (panel derecho obligatorio).
 * No aplica a instrucciones puras (sube/importa/cambia) donde la IA decide.
 */
function wantsSidePanelShow(userText: string) {
  const n = normalizeChatIntent(userText);
  if (!n || isNonConcreteChatAsk(userText)) return false;
  if (
    /\b(lado derecho|panel derecho|visor|a la derecha|en el panel|en el visor)\b/.test(
      n,
    )
  ) {
    return true;
  }

  const showVerb = intentHas(
    n,
    "muestra",
    "mostrar",
    "ensena",
    "ensenar",
    "ensename",
    "ver",
    "dame",
    "trae",
    "abre",
    "abrir",
    "crea",
    "crear",
    "genera",
    "generar",
    "haz",
    "hacer",
  );
  if (!showVerb) return false;

  // Instrucción de escritura/carga sin verbo de ver → la IA decide el panel.
  const actionOnly =
    intentHas(
      n,
      "sube",
      "subir",
      "importa",
      "importar",
      "carga",
      "cargar",
      "cambia",
      "cambiar",
      "actualiza",
      "actualizar",
      "corrige",
      "corregir",
      "restaura",
      "restaurar",
    ) &&
    !intentHas(
      n,
      "muestra",
      "mostrar",
      "ensename",
      "ensenar",
      "ensena",
      "dame",
      "ver",
      "trae",
      "crea",
      "crear",
      "genera",
      "generar",
    );
  if (actionOnly) return false;

  if (/\b\d{3,}\b/.test(n)) return true;
  if (
    intentHas(
      n,
      "registro",
      "registros",
      "etiqueta",
      "etiquetas",
      "ficha",
      "detalle",
      "articulo",
      "articulos",
      "qr",
      "codigo",
      "codigos",
      "resultado",
      "resultados",
      "inventario",
      "area",
      "areas",
      "persona",
      "personas",
      "recientes",
      "resumen",
      "totales",
      "este",
      "esta",
      "ese",
      "esa",
      "eso",
      "aqui",
    )
  ) {
    return true;
  }
  // "muéstrame" / "enséñame" / "dame" corto → contexto reciente al panel.
  return /^(muestra|mostrar|ensename|ensenar|ensena|dame|ver|trae|crea|crear|genera|generar)\b/.test(
    n,
  );
}

/** Pedido de un registro / etiqueta / ficha concreta. */
function looksLikeRecordLookup(userText: string) {
  const n = normalizeChatIntent(userText);
  if (!n || isNonConcreteChatAsk(userText)) return false;
  if (wantsSidePanelShow(userText)) return true;
  const hasCode = /\b\d{3,}\b/.test(n) || /\betiqueta\b/.test(n);
  const asksRecord = intentHas(
    n,
    "registro",
    "registros",
    "etiqueta",
    "etiquetas",
    "articulo",
    "articulos",
    "detalle",
    "ficha",
    "dame",
    "ver",
    "busca",
    "buscar",
    "muestra",
    "mostrar",
    "ensena",
    "ensenar",
    "ensename",
    "trae",
    "encuentra",
    "abre",
    "abrir",
    "este",
    "esta",
    "ese",
    "esa",
  );
  if (hasCode && asksRecord) return true;
  if (
    intentHas(n, "detalle", "ficha", "registro") &&
    (hasCode ||
      intentHas(n, "etiqueta", "articulo", "este", "esta", "ese", "esa"))
  ) {
    return true;
  }
  return false;
}

function hasConcreteInventoryAsk(
  userText: string,
  inventory: InventarioRow[],
  recentMessages?: Array<{ from: string; text: string; resultItems?: ChatApiItem[] }>,
) {
  if (detectPersonTotalAsk(userText, inventory, recentMessages)) return true;
  if (detectAreaTotalAsk(userText, inventory)) return true;
  if (detectViewerOverview(userText)) return true;
  if (parseEtiquetaListAsk(userText) != null) return true;
  if (userAskedQr(userText)) return true;
  if (looksLikeRecordLookup(userText)) return true;
  if (wantsSidePanelShow(userText)) return true;
  return false;
}

function resolveRecordRowsFromPrompt(
  userText: string,
  botText: string,
  inventory: InventarioRow[],
  max = 8,
): InventarioRow[] {
  if (!inventory.length) return [];
  const tags = [
    ...extractEtiquetasFromText(botText),
    ...extractEtiquetasFromText(userText),
  ];
  for (const match of String(userText).matchAll(/\b(\d{3,})\b/g)) {
    tags.push(match[1]);
  }
  for (const match of String(botText).matchAll(
    /(?:etiqueta|id)\s+\*{0,2}(\d{3,})\*{0,2}/gi,
  )) {
    tags.push(match[1]);
  }

  const rows: InventarioRow[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (rows.length >= max) break;
    const needle = String(tag || "")
      .trim()
      .toLowerCase();
    if (!needle) continue;
    const byEtiqueta = inventory.find(
      (row) =>
        String(row.etiqueta ?? "")
          .trim()
          .toLowerCase() === needle,
    );
    if (byEtiqueta) {
      const key =
        byEtiqueta.id != null
          ? `id:${byEtiqueta.id}`
          : `etq:${needle}`;
      if (!seen.has(key)) {
        seen.add(key);
        rows.push(byEtiqueta);
      }
      continue;
    }
    if (/^\d+$/.test(needle)) {
      const id = Number(needle);
      const byId = inventory.find((row) => Number(row.id) === id);
      if (byId) {
        const key = `id:${byId.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          rows.push(byId);
        }
      }
    }
  }
  return rows;
}

/** Registro del contexto reciente (memoria / mensajes) cuando no hay código en el prompt. */
function resolveContextualRecordRows(
  inventory: InventarioRow[],
  recentMessages: Array<{ from: string; text: string }>,
  max = 4,
): InventarioRow[] {
  if (!inventory.length) return [];
  const tags: string[] = [];
  try {
    const change = loadChatMemory().lastFieldChange;
    if (change?.etiqueta) tags.push(String(change.etiqueta));
    if (change?.id != null) tags.push(String(change.id));
  } catch {
    /* noop */
  }
  for (let i = recentMessages.length - 1; i >= 0 && tags.length < 8; i -= 1) {
    const message = recentMessages[i];
    if (!message.text) continue;
    tags.push(...extractEtiquetasFromText(message.text));
    for (const match of message.text.matchAll(/\b(\d{3,})\b/g)) {
      tags.push(match[1]);
    }
  }
  const fakePrompt = tags.join(" ");
  if (!fakePrompt.trim()) return [];
  return resolveRecordRowsFromPrompt(fakePrompt, fakePrompt, inventory, max);
}

/**
 * Tip interactivo opcional (desactivado: el visor solo abre si el usuario lo pide).
 */
function pickDiscoveryTip(
  _userText: string,
): ViewerOverview | undefined {
  return undefined;
}

/** Visor derecho solo con pedido explícito (dame/muestra/QR/persona/área/etiquetas). */
function shouldAttachSidePanel(
  userText: string,
  inventory: InventarioRow[],
  recentMessages?: Array<{ from: string; text: string; resultItems?: ChatApiItem[] }>,
) {
  if (wantsSidePanelShow(userText)) return true;
  if (detectCompareInventariosAsk(userText, listExistingOrigens(inventory))) {
    return true;
  }
  if (userAskedQr(userText)) return true;
  if (parseEtiquetaListAsk(userText) != null) return true;
  if (detectMarcasAreaAsk(userText, inventory)) return true;
  if (
    looksLikeResultAnaphora(userText) &&
    (/\betiquet/.test(normalizeChatIntent(userText)) ||
      intentHas(
        normalizeChatIntent(userText),
        "dame",
        "muestra",
        "mostrar",
        "ver",
        "trae",
        "lista",
      ))
  ) {
    return true;
  }
  if (detectPersonTotalAsk(userText, inventory, recentMessages)) return true;
  if (detectAreaTotalAsk(userText, inventory)) return true;
  if (detectAreaListAsk(userText, inventory)) return true;
  return false;
}

/** Pausa mínima para transición visual suave (muy breve para no frenar la respuesta). */
function assistantTypingDelayMs(reply: string) {
  const len = String(reply || "").trim().length;
  return Math.min(180, Math.max(80, 60 + Math.min(len, 80)));
}

function buildAreaTotalReply(area: string, inventory: InventarioRow[]) {
  const rows = inventory.filter((row) =>
    areaMatchesNeedle(String(row.area ?? ""), area),
  );
  const personas = new Set(
    rows.map((row) => String(row.persona ?? "").trim()).filter(Boolean),
  );
  const activos = rows.filter(isRowActivo).length;
  const n = rows.length;
  return (
    `En **${area}** hay **${n}** registro${n === 1 ? "" : "s"}: ` +
    `**${personas.size}** persona${personas.size === 1 ? "" : "s"} y ` +
    `**${activos}** activo${activos === 1 ? "" : "s"}.\n\n` +
    `El detalle está en el visor derecho.\n\n` +
    `¿Quieres ver los artículos del área, filtrar por persona o generar QR de un lote?`
  );
}

/**
 * "cuántas personas hay en ventas / en la de venbtas / ahí"
 * Usa typo + foco del visor anterior; si duda, pregunta sin abrir panel.
 */
function detectAreaPersonasAsk(
  userText: string,
  inventory: InventarioRow[],
  recentFocus?: string | null,
): {
  status: "ok" | "ask";
  area?: AreaCandidateSummary;
  candidates?: AreaCandidateSummary[];
  rawNeedle: string;
} | undefined {
  const n = normalizeChatIntent(userText);
  if (!n || !inventory.length) return undefined;
  if (
    !intentHas(n, "persona", "personas", "quien", "quienes", "nombre", "nombres")
  ) {
    return undefined;
  }
  if (
    !intentHas(
      n,
      "cuantas",
      "cuantos",
      "cuanta",
      "cuanto",
      "tiene",
      "tienen",
      "hay",
      "dame",
      "muestra",
      "lista",
      "ver",
      "dime",
      "quien",
      "quienes",
    ) &&
    !/\bquien(es)?\b/.test(n)
  ) {
    return undefined;
  }
  // Inventario N lo maneja detectOrigenPersonasAsk.
  if (/\binventarios?\s*\d+\b/.test(n) || matchOrigenFromPrompt(userText, listExistingOrigens(inventory))) {
    return undefined;
  }

  const catalog = getAllAreaCatalog(inventory);
  const areaQuery = findMatchingAreasForPrompt(userText, inventory);
  const usesContext =
    /\b(ahi|alla|alli|aqui|esa|ese|eso|la de|del area|de esa)\b/.test(n) ||
    intentHas(n, "ahi", "alla", "alli", "aqui");

  if (areaQuery?.uncertain) {
    return {
      status: "ask",
      candidates: areaQuery.candidates,
      rawNeedle: areaQuery.rawNeedle,
    };
  }
  if (areaQuery && areaQuery.candidates.length === 1 && !areaQuery.uncertain) {
    return {
      status: "ok",
      area: areaQuery.candidates[0],
      rawNeedle: areaQuery.rawNeedle,
    };
  }
  if (areaQuery && areaQuery.candidates.length > 1) {
    return {
      status: "ask",
      candidates: areaQuery.candidates,
      rawNeedle: areaQuery.rawNeedle,
    };
  }

  // Anáfora: "cuántas personas hay ahí" tras haber visto Ventas.
  if (usesContext && recentFocus) {
    const hit =
      catalog.find((c) => c.name === recentFocus) ||
      catalog.find((c) => areaMatchesNeedle(c.name, recentFocus));
    if (hit) {
      return { status: "ok", area: hit, rawNeedle: recentFocus };
    }
  }

  // Needle suelto con typo aunque findMatchingAreas falló por tokens basura.
  const plain = normalizePlain(userText);
  const toks = plain
    .split(" ")
    .filter((t) => t.length >= 3 && !AREA_QUERY_STOP_WORDS.has(t) && !PERSON_STOP_WORDS.has(t));
  const allAreaTokens = new Set<string>();
  for (const c of catalog) for (const t of c.tokens) allAreaTokens.add(t);
  const fuzzyHits: AreaCandidateSummary[] = [];
  let rawNeedle = "";
  for (const tok of toks) {
    const m = matchSingleAreaVocabularyToken(tok, allAreaTokens);
    if (!m) continue;
    rawNeedle = tok;
    const areas = catalog.filter((c) => c.tokens.includes(m.token));
    for (const a of areas) {
      if (!fuzzyHits.some((x) => x.name === a.name)) fuzzyHits.push(a);
    }
    if (m.confidence === "fuzzy" || fuzzyHits.length > 1) {
      return {
        status: "ask",
        candidates: fuzzyHits.length ? fuzzyHits : areas,
        rawNeedle: tok,
      };
    }
    if (fuzzyHits.length === 1) {
      return { status: "ok", area: fuzzyHits[0], rawNeedle: tok };
    }
  }

  if (usesContext && recentFocus) {
    const hit =
      catalog.find((c) => c.name === recentFocus) ||
      catalog.find((c) => areaMatchesNeedle(c.name, recentFocus));
    if (hit) return { status: "ok", area: hit, rawNeedle: recentFocus };
  }

  return undefined;
}

function buildAreaPersonasReply(area: AreaCandidateSummary): string {
  const people = [
    ...new Set(
      area.rows
        .map((row) => String(row.persona ?? "").trim())
        .filter((p) => {
          if (!p) return false;
          const np = normalizePlain(p);
          return (
            np &&
            np !== "sin asignar" &&
            np !== "no asignado" &&
            np !== "n a" &&
            np !== "na"
          );
        }),
    ),
  ].sort((a, b) => a.localeCompare(b, "es"));
  const fmt = (x: number) => x.toLocaleString("es-MX");
  if (!people.length) {
    return (
      `En **${area.name}** hay **${fmt(area.rows.length)}** registro` +
      `${area.rows.length === 1 ? "" : "s"}, pero sin personas asignadas.`
    );
  }
  const showAll = people.length <= 40;
  const shown = showAll ? people : people.slice(0, 30);
  const namesProse =
    shown.length === 1
      ? `**${shown[0]}**`
      : `${shown
          .slice(0, -1)
          .map((name) => `**${name}**`)
          .join(", ")} y **${shown[shown.length - 1]}**`;
  return (
    `En **${area.name}** hay **${fmt(people.length)}** persona` +
    `${people.length === 1 ? "" : "s"} ` +
    `(en **${fmt(area.rows.length)}** registro${area.rows.length === 1 ? "" : "s"}): ${namesProse}` +
    (showAll ? "" : `, y **${fmt(people.length - shown.length)}** más`) +
    `. ¿Quieres el inventario de alguna?`
  );
}

/** "cuántas personas tiene el Inventario 1" / "quiénes hay en inventario 2". */
function detectOrigenPersonasAsk(
  userText: string,
  inventory: InventarioRow[],
): string | undefined {
  const n = normalizeChatIntent(userText);
  if (!n || !inventory.length) return undefined;
  if (
    !intentHas(n, "persona", "personas", "quien", "quienes", "nombre", "nombres")
  ) {
    return undefined;
  }
  if (
    !intentHas(
      n,
      "cuantas",
      "cuantos",
      "cuanta",
      "cuanto",
      "tiene",
      "tienen",
      "hay",
      "dame",
      "muestra",
      "lista",
      "listar",
      "ver",
      "dime",
      "quien",
      "quienes",
    ) &&
    !/\bquien(es)?\b/.test(n)
  ) {
    return undefined;
  }
  // Ranking global de personas (sin inventario concreto).
  if (
    intentHas(n, "todas", "todos", "ranking", "top") &&
    !/\binventarios?\s*\d+\b/.test(n)
  ) {
    return undefined;
  }
  const existing = listExistingOrigens(inventory);
  return matchOrigenFromPrompt(userText, existing);
}

function buildOrigenPersonasReply(
  origen: string,
  inventory: InventarioRow[],
): string {
  const rows = inventory.filter(
    (row) => String(row.origen ?? "").trim() === origen,
  );
  if (!rows.length) {
    return (
      `No encontré registros en **${origen}**. ` +
      `¿Quieres probar con otro inventario (Inventario 1, Inventario 2…) o con S/O?`
    );
  }
  const people = [
    ...new Set(
      rows
        .map((row) => String(row.persona ?? "").trim())
        .filter((p) => {
          if (!p) return false;
          const np = normalizePlain(p);
          return (
            np &&
            np !== "sin asignar" &&
            np !== "no asignado" &&
            np !== "n a" &&
            np !== "na"
          );
        }),
    ),
  ].sort((a, b) => a.localeCompare(b, "es"));
  const fmt = (x: number) => x.toLocaleString("es-MX");
  if (!people.length) {
    return (
      `En **${origen}** hay **${fmt(rows.length)}** registro` +
      `${rows.length === 1 ? "" : "s"}, pero ninguno tiene persona asignada.`
    );
  }
  const showAll = people.length <= 40;
  const shown = showAll ? people : people.slice(0, 30);
  const namesProse =
    shown.length === 1
      ? `**${shown[0]}**`
      : `${shown
          .slice(0, -1)
          .map((n) => `**${n}**`)
          .join(", ")} y **${shown[shown.length - 1]}**`;
  return (
    `En **${origen}** hay **${fmt(people.length)}** persona` +
    `${people.length === 1 ? "" : "s"} ` +
    `(sobre **${fmt(rows.length)}** registro${rows.length === 1 ? "" : "s"}): ${namesProse}` +
    (showAll ? "" : `, y **${fmt(people.length - shown.length)}** más`) +
    `. Si quieres el inventario de alguna, dime su nombre.`
  );
}

/** "dame el total de solo una área" sin nombrar cuál → preguntar. */
function detectUnspecifiedAreaAsk(
  userText: string,
  inventory: InventarioRow[],
): boolean {
  const n = normalizeChatIntent(userText);
  if (!n || !inventory.length) return false;
  if (!intentHas(n, "area", "areas")) return false;
  if (intentHas(n, "todas", "todos", "ranking", "por", "distribucion")) {
    return false;
  }
  if (matchAreaFromPrompt(userText, inventory)) return false;
  if (findMatchingAreasForPrompt(userText, inventory)) return false;
  const wantsOne = intentHas(
    n,
    "una",
    "un",
    "solo",
    "solamente",
    "alguna",
    "cualquier",
    "especifica",
    "especifico",
  );
  const wantsInfo = intentHas(
    n,
    "total",
    "totales",
    "dame",
    "muestra",
    "ver",
    "cuantos",
    "cuantas",
    "detalle",
    "registros",
  );
  return wantsOne && wantsInfo;
}

function buildUnspecifiedAreaAskReply(inventory: InventarioRow[]) {
  const areas = getAllAreaCatalog(inventory)
    .slice(0, 8)
    .map((a) => a.name);
  const hint =
    areas.length > 0
      ? ` Por ejemplo: ${areas
          .slice(0, 4)
          .map((a) => `**${a}**`)
          .join(", ")}… o una abreviatura como **RH** / **TI**.`
      : "";
  return (
    `Claro. ¿De **qué área** quieres el total?` +
    ` Puedes escribir el nombre completo o algo corto (siglas).` +
    hint
  );
}

/** Respuestas locales exactas para overview (áreas, totales, etc.). */
function buildLocalOverviewReply(
  overview: ViewerOverview,
  inventory: InventarioRow[],
): string | null {
  if (!inventory.length) return null;
  const total = inventory.length;
  const areaCounts = new Map<string, number>();
  const personCounts = new Map<string, number>();
  const marcaCounts = new Map<string, number>();
  let activos = 0;
  for (const row of inventory) {
    const area = String(row.area ?? "").trim() || "Sin área";
    areaCounts.set(area, (areaCounts.get(area) || 0) + 1);
    const persona = String(row.persona ?? "").trim();
    if (persona) personCounts.set(persona, (personCounts.get(persona) || 0) + 1);
    const marca = String(row.marca ?? "").trim();
    if (marca && !/^(s\/m|sin marca|n\/a)$/i.test(marca)) {
      marcaCounts.set(marca, (marcaCounts.get(marca) || 0) + 1);
    }
    if (isRowActivo(row)) activos += 1;
  }
  const inactivos = Math.max(0, total - activos);
  const topAreas = [...areaCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const fmt = (n: number) => n.toLocaleString("es-MX");

  if (overview === "areas") {
    const topProse =
      topAreas.length === 0
        ? ""
        : topAreas.length === 1
          ? ` La de mayor concentración es **${topAreas[0][0]}** con **${fmt(topAreas[0][1])}** registro${topAreas[0][1] === 1 ? "" : "s"}.`
          : ` Las de mayor concentración son ${topAreas
              .slice(0, -1)
              .map(
                ([area, count]) =>
                  `**${area}** (${fmt(count)})`,
              )
              .join(", ")} y **${topAreas[topAreas.length - 1][0]}** (${fmt(topAreas[topAreas.length - 1][1])}).`;
    return (
      `Este inventario tiene **${fmt(areaCounts.size)}** área` +
      `${areaCounts.size === 1 ? "" : "s"} distintas ` +
      `(**${fmt(total)}** registros en total).` +
      topProse +
      ` Si quieres el detalle de un área, dime su nombre. También puedo filtrar por persona o generar QR.`
    );
  }

  if (overview === "stats" || overview === "full") {
    const topFull =
      overview === "full" && topAreas.length
        ? ` Las áreas con más equipo: ${topAreas
            .slice(0, 3)
            .map(([a, c]) => `**${a}** (${fmt(c)})`)
            .join(", ")}.`
        : "";
    return (
      `Inventario general: **${fmt(total)}** registros, ` +
      `**${fmt(personCounts.size)}** persona${personCounts.size === 1 ? "" : "s"} y ` +
      `**${fmt(areaCounts.size)}** área${areaCounts.size === 1 ? "" : "s"}. ` +
      `Hay **${fmt(activos)}** activos y **${fmt(inactivos)}** inactivos.` +
      topFull +
      ` ¿Seguimos con un área, una persona, últimos registros o códigos QR?`
    );
  }

  if (overview === "personas") {
    return (
      `Hay **${fmt(personCounts.size)}** persona${personCounts.size === 1 ? "" : "s"} ` +
      `con equipo asignado (**${fmt(total)}** registros). ` +
      `Dime un nombre para ver su inventario, o pide «dame las personas» para el ranking.`
    );
  }

  if (overview === "estado") {
    const pct = total ? Math.round((activos / total) * 100) : 0;
    return (
      `Salud del inventario (**${fmt(total)}** registros): ` +
      `**${fmt(activos)}** activos (${pct}%) y **${fmt(inactivos)}** inactivos. ` +
      `¿Quieres listar los inactivos o revisar un área?`
    );
  }

  if (overview === "marcas") {
    return (
      `Hay **${fmt(marcaCounts.size)}** marca${marcaCounts.size === 1 ? "" : "s"} ` +
      `registradas en el inventario.\n\n` +
      `Puedo mostrarte el top de marcas o filtrar por una concreta.`
    );
  }

  if (overview === "recent") {
    return (
      `Puedo mostrarte los **últimos registros** del inventario.\n\n` +
      `Di «dame los últimos registros» para verlos en el visor, ` +
      `o indica un área/persona si quieres acotar.`
    );
  }

  return null;
}

function detectViewerOverview(userText: string): ViewerOverview | undefined {
  // Solo incidencia visual/contable (estilo Google): no en cada mensaje.
  const user = normalizeChatIntent(userText);
  if (!user || /^(hola|buenas|hey|hi|hello)\b/.test(user)) return undefined;

  // "cuántos tiene GARCIA…" → lista de esa persona, no overview global.
  const stop = new Set([
    "cuantos",
    "cuantas",
    "cuanto",
    "cuanta",
    "registros",
    "registro",
    "articulos",
    "articulo",
    "equipos",
    "equipo",
    "tiene",
    "tienen",
    "hay",
    "del",
    "de",
    "la",
    "el",
    "los",
    "las",
    "un",
    "una",
    "me",
    "dame",
    "muestra",
    "mostrar",
    "ver",
    "quiero",
    "lista",
    "listar",
    "persona",
    "personas",
    "area",
    "areas",
    "marca",
    "marcas",
    "estado",
    "activo",
    "activos",
    "inactivo",
    "inactivos",
    "todas",
    "todos",
    "top",
    "por",
  ]);
  const extraTokens = user
    .split(/\s+/)
    .filter((t) => t.length > 1 && !stop.has(t));
  const asksSpecificOwner =
    (/\b(tiene|tienen)\b/.test(user) && intentHas(user, "cuantos", "cuantas", "cuanto", "cuanta")) ||
    (intentHas(user, "cuantos", "cuantas", "cuanto", "cuanta") &&
      extraTokens.length >= 2);

  const askVerb = intentHas(
    user,
    "dame",
    "muestra",
    "mostrar",
    "ver",
    "quiero",
    "lista",
    "listar",
    "ensename",
    "ensenar",
  );

  if (
    intentHas(user, "recientes", "reciente") ||
    (intentHas(user, "ultimos", "ultimo") &&
      intentHas(user, "registros", "registro", "articulos", "articulo"))
  ) {
    return "recent";
  }

  // Ranking de áreas ≠ "registros/etiquetas del área X" (eso es lista de fichas).
  const wantsRecordsOfArea = intentHas(
    user,
    "registro",
    "registros",
    "etiqueta",
    "etiquetas",
    "articulo",
    "articulos",
    "equipo",
    "equipos",
  );
  if (
    !wantsRecordsOfArea &&
    intentHas(user, "areas", "area") &&
    (askVerb ||
      intentHas(user, "por", "top", "desglose", "cuantas", "cuantos", "todas", "todos") ||
      /^(areas?|por\s+areas?)$/.test(user))
  ) {
    // "total de solo una área" → preguntar cuál (no ranking).
    if (
      intentHas(user, "una", "un", "solo", "solamente", "alguna") &&
      !intentHas(user, "todas", "todos", "ranking", "por")
    ) {
      return undefined;
    }
    return "areas";
  }

  if (
    !asksSpecificOwner &&
    intentHas(user, "personas", "persona") &&
    (askVerb ||
      intentHas(user, "por", "top", "desglose", "cuantas", "cuantos", "todas", "todos") ||
      /^(personas?|por\s+personas?)$/.test(user))
  ) {
    // "personas del inventario 1" lo resuelve el detector de origen, no el ranking.
    if (/\binventarios?\s*\d+\b/.test(user) || /\binventario\b/.test(user)) {
      return undefined;
    }
    return "personas";
  }

  if (
    intentHas(user, "estado", "activos", "activo", "inactivos", "inactivo") &&
    (askVerb ||
      intentHas(user, "por", "desglose", "cuantos", "cuantas") ||
      /^(estado|activos|inactivos|por\s+estado)$/.test(user))
  ) {
    return "estado";
  }

  if (
    intentHas(user, "marcas", "marca") &&
    (askVerb ||
      intentHas(user, "por", "top", "desglose", "cuantas", "cuantos", "todas", "todos") ||
      /^(marcas?|por\s+marcas?)$/.test(user))
  ) {
    return "marcas";
  }

  if (
    !looksLikePersonAnaphora(userText) &&
    (intentHas(user, "resumen", "panorama", "dashboard") ||
      (intentHas(user, "inventario", "inventarios") &&
        intentHas(user, "general", "completo", "total", "totales", "todo", "todos")) ||
      /^(dame|muestra|ver|quiero)\s+(el\s+)?inventarios?\s*$/.test(user))
  ) {
    return "full";
  }

  if (
    !asksSpecificOwner &&
    (intentHas(user, "conteo") ||
      (intentHas(user, "total", "totales") &&
        intentHas(user, "inventario", "inventarios")) ||
      (intentHas(user, "cuantos", "cuantas") &&
        intentHas(user, "articulos", "registros", "hay") &&
        extraTokens.length === 0))
  ) {
    return "stats";
  }
  return undefined;
}

function findQrOwnerMessage(messages: ChatMessage[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (messageHasSideData(message) || isQrBotMessage(message)) return message;
  }
  return null;
}

function extractEtiquetasFromText(text: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const tag = String(raw || "").trim();
    if (!tag) return;
    const key = tag.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tags.push(tag);
  };
  for (const match of text.matchAll(/\|\s*([A-Za-z0-9/_-]{3,})\s*\|/g)) {
    if (/^(etiqueta|art[ií]culo|area|área|persona|estado)$/i.test(match[1])) continue;
    push(match[1]);
  }
  for (const match of text.matchAll(/etiqueta\s+\*{0,2}([A-Za-z0-9/_-]+)\*{0,2}/gi)) {
    push(match[1]);
  }
  return tags;
}

function buildQrSideFromRows(rows: InventarioRow[]): {
  resultItems: ChatApiItem[];
  qr: ChatQrPayload[];
} {
  const resultItems: ChatApiItem[] = [];
  const qr: ChatQrPayload[] = [];
  for (const row of rows) {
    const text = formatInventarioQrCompact(row);
    if (!text) continue;
    resultItems.push(rowToChatApiItem(row));
    qr.push({
      text,
      etiqueta: row.etiqueta,
      articulo: row.articulo,
      id: row.id,
      persona: row.persona,
      area: row.area,
      origen: row.origen,
    });
  }
  return { resultItems, qr };
}

function resolveQrRowsFromPrompt(
  userText: string,
  botText: string,
  inventory: InventarioRow[],
  max = 7,
): InventarioRow[] {
  const fromBot = extractEtiquetasFromText(botText);
  if (fromBot.length) {
    const rows: InventarioRow[] = [];
    for (const tag of fromBot.slice(0, max)) {
      const row = inventory.find(
        (item) =>
          String(item.etiqueta ?? "")
            .trim()
            .toLowerCase() === tag.toLowerCase(),
      );
      if (row) rows.push(row);
    }
    if (rows.length) return rows;
  }

  const limitMatch =
    userText.match(
      /(?:dame|genera|quiero|necesito)?\s*(\d{1,2})\s*(?:c[oó]digos?\s*)?qr/i,
    ) || userText.match(/(\d{1,2})\s*c[oó]digos?/i);
  const limit = Math.max(1, Math.min(max, Number(limitMatch?.[1] || 5) || 5));
  const queryMatch =
    userText.match(
      /(?:de|del|en)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9][\wÁÉÍÓÚÜÑáéíóúüñ ./-]{1,40})/i,
    ) ||
    botText.match(
      /de\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][\wÁÉÍÓÚÜÑáéíóúüñ ./-]{1,40})/i,
    );
  const query = String(queryMatch?.[1] || "")
    .replace(/\s*\(.*$/, "")
    .trim();
  if (!query) return [];

  const needle = prepareSearch(query);
  if (!needle) return [];
  return inventory
    .filter((row) => rowMatchesPrepared(row, needle))
    .slice(0, limit);
}

function recoverSideFromChat(
  messages: ChatMessage[],
  inventory: InventarioRow[],
): { resultItems: ChatApiItem[]; qr: ChatQrPayload[] } | null {
  const attachedOwner = [...messages]
    .reverse()
    .find(
      (message) =>
        message.from === "bot" &&
        ((Array.isArray(message.resultItems) && message.resultItems.length > 0) ||
          (Array.isArray(message.qr) && message.qr.length > 0)),
    );
  if (attachedOwner) {
    return {
      resultItems: attachedOwner.resultItems || [],
      qr: attachedOwner.qr || [],
    };
  }

  const qrOwner = findQrOwnerMessage(messages);
  if (!qrOwner || !inventory.length) return null;

  const ownerIndex = messages.findIndex((message) => message.id === qrOwner.id);
  const prevUser = [...messages.slice(0, Math.max(ownerIndex, 0))]
    .reverse()
    .find((message) => message.from === "user");
  const rows = resolveQrRowsFromPrompt(
    prevUser?.text || "",
    qrOwner.text || "",
    inventory,
  );
  if (!rows.length) return null;
  const side = buildQrSideFromRows(rows);
  if (!side.qr.length) return null;
  return side;
}

function resolveSessionSide(
  session: ChatSession,
  inventory: InventarioRow[],
): { resultItems: ChatApiItem[]; qr: ChatQrPayload[] } {
  if (
    (Array.isArray(session.resultItems) && session.resultItems.length) ||
    (Array.isArray(session.qr) && session.qr.length)
  ) {
    return {
      resultItems: session.resultItems || [],
      qr: session.qr || [],
    };
  }
  const recovered = recoverSideFromChat(session.messages, inventory);
  return recovered
    ? { resultItems: recovered.resultItems, qr: recovered.qr }
    : { resultItems: [], qr: [] };
}

function chatTitleFromMessages(messages: ChatMessage[]) {
  const firstUser = messages.find((message) => message.from === "user");
  const text = firstUser?.text?.trim() || "Nueva consulta";
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}

function formatChatTime(at?: number) {
  const date = new Date(at || Date.now());
  return date.toLocaleTimeString("es-MX", { hour: "numeric", minute: "2-digit" });
}

async function copyChatText(text: string) {
  const value = String(text ?? "");
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fallback abajo */
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

type ChoiceCard = {
  title: string;
  body: string;
  action: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
};

function ChatChoiceModal({
  titleId,
  title,
  subtitle,
  onDismiss,
  keep,
  drop,
}: {
  titleId: string;
  title: string;
  subtitle: string;
  onDismiss: () => void;
  keep: ChoiceCard;
  drop: ChoiceCard;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="product-modal-overlay"
      role="presentation"
      onClick={onDismiss}
    >
      <div
        className="product-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="product-modal-header">
          <div className="product-modal-title-group">
            <div>
              <h2 id={titleId}>{title}</h2>
              <p>{subtitle}</p>
            </div>
          </div>
          <div className="product-modal-header-actions">
            <button
              type="button"
              className="product-modal-close"
              onClick={onDismiss}
              aria-label="Cerrar"
            >
              <X size={19} />
            </button>
          </div>
        </header>
        <div className="product-modal-body">
          <div className="choose-options-grid">
            {(
              [
                ["keep", keep],
                ["delete", drop],
              ] as const
            ).map(([kind, card]) => (
              <button
                key={kind}
                type="button"
                className={`choose-card choose-card-${kind === "keep" ? "keep" : "delete"}`}
                disabled={card.disabled}
                onClick={card.onClick}
              >
                <div className="choose-card-badge">
                  {kind === "keep" ? "Conservar" : "Permanente"}
                </div>
                <div className="choose-card-icon" aria-hidden="true">
                  {kind === "keep" ? (
                    <Undo2 size={36} strokeWidth={1.8} />
                  ) : (
                    <Trash2 size={36} strokeWidth={1.8} />
                  )}
                </div>
                <h3>{card.title}</h3>
                <p>{card.body}</p>
                <span className="choose-card-action">
                  <span>{card.action}</span>
                  <span className="arrow-pill">→</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ChatUserEditBox({
  initialText,
  onChange,
  onSubmit,
  onCancel,
}: {
  initialText: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(initialText);
  const [canSend, setCanSend] = useState(() => Boolean(initialText.trim()));

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.textContent = initialText;
    valueRef.current = initialText;
    setCanSend(Boolean(initialText.trim()));
    el.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    // solo al montar el editor
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="chat-user-edit">
      <div
        ref={editorRef}
        className="chat-bubble chat-user-edit-input"
        contentEditable
        role="textbox"
        aria-label="Editar mensaje"
        suppressContentEditableWarning
        onInput={(event) => {
          const next = event.currentTarget.textContent ?? "";
          valueRef.current = next;
          setCanSend(Boolean(next.trim()));
          onChange(next);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) {
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit(valueRef.current);
          }
        }}
      />
      <div className="chat-user-edit-actions">
        <button type="button" className="chat-user-edit-cancel" onClick={onCancel}>
          Cancelar
        </button>
        <button
          type="button"
          className="chat-user-edit-send"
          disabled={!canSend}
          onClick={() => onSubmit(valueRef.current)}
        >
          Enviar
        </button>
      </div>
    </div>
  );
}

/** Separa prosa y tablas markdown: primero el texto, tabla al final. */
function reorderChatProseThenTable(text: string) {
  const lines = String(text || "").split(/\r?\n/);
  const prose: string[] = [];
  const table: string[] = [];
  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const isTableRow =
      /^\|/.test(trimmed) || /^[\|\s:\-]+$/.test(trimmed);
    if (isTableRow) {
      inTable = true;
      table.push(line);
      continue;
    }
    if (inTable && trimmed === "") {
      table.push(line);
      continue;
    }
    inTable = false;
    prose.push(line);
  }
  const head = prose.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const tail = table.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!tail) return head;
  if (!head) return tail;
  return `${head}\n\n${tail}`;
}

/** Si el detalle va al visor, quita tablas del chat (deja solo la incidencia). */
function stripChatMarkdownTables(text: string) {
  const lines = String(text || "").split(/\r?\n/);
  const out: string[] = [];
  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const isTableRow =
      /^\|/.test(trimmed) || /^[\|\s:\-]+$/.test(trimmed);
    if (isTableRow) {
      inTable = true;
      continue;
    }
    if (inTable && trimmed === "") {
      inTable = false;
      continue;
    }
    inTable = false;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function renderChatInlineText(text: string) {
  const parts = String(text || "")
    .split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*)/g)
    .filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={index} className="chat-inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (
      part.startsWith("*") &&
      part.endsWith("*") &&
      !part.startsWith("**") &&
      part.length > 2
    ) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return <span key={index}>{part}</span>;
  });
}

function renderChatRichText(text: string) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let keyCounter = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // 1. Markdown table block
    if (/^\|.*\|$/.test(trimmed)) {
      const tableLines: string[] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        tableLines.push(lines[i].trim());
        i += 1;
      }
      const rows = tableLines
        .filter((row) => !/^\|[\s:\-\|]+\|$/.test(row))
        .map((row) =>
          row
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((cell) => cell.trim()),
        );
      if (rows.length > 0) {
        const [header, ...body] = rows;
        blocks.push(
          <div key={`tbl-${keyCounter++}`} className="chat-rich-table-wrap">
            <table className="chat-rich-table">
              <thead>
                <tr>
                  {header.map((cell, cIdx) => (
                    <th key={cIdx}>{renderChatInlineText(cell)}</th>
                  ))}
                </tr>
              </thead>
              {body.length > 0 ? (
                <tbody>
                  {body.map((r, rIdx) => (
                    <tr key={rIdx}>
                      {r.map((cell, cIdx) => (
                        <td key={cIdx}>{renderChatInlineText(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              ) : null}
            </table>
          </div>,
        );
        continue;
      }
    }

    // 2. Heading line (### / ##)
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      blocks.push(
        <h4 key={`hd-${keyCounter++}`} className="chat-rich-heading">
          {renderChatInlineText(headingMatch[2])}
        </h4>,
      );
      i += 1;
      continue;
    }

    // 3. Unordered list (•, -, *) → prosa (sin bolitas verdes)
    if (/^[•\-\*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[•\-\*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[•\-\*]\s+/, ""));
        i += 1;
      }
      const prose =
        items.length <= 1
          ? items[0] || ""
          : `${items.slice(0, -1).join("; ")}; y ${items[items.length - 1]}`;
      if (prose) {
        blocks.push(
          <p key={`p-${keyCounter++}`} className="chat-rich-paragraph">
            {renderChatInlineText(prose)}
          </p>,
        );
      }
      continue;
    }

    // 4. Ordered list (1. / 1))
    if (/^\d+[\.\)]\s+/.test(trimmed)) {
      const items: Array<{ num: string; content: string }> = [];
      while (i < lines.length && /^\d+[\.\)]\s+/.test(lines[i].trim())) {
        const m = lines[i].trim().match(/^(\d+)[\.\)]\s+(.+)$/);
        if (m) {
          items.push({ num: m[1], content: m[2] });
        }
        i += 1;
      }
      blocks.push(
        <ol key={`ol-${keyCounter++}`} className="chat-rich-list is-ordered">
          {items.map((item, idx) => (
            <li key={idx} className="chat-rich-list-item">
              <span className="chat-rich-order-badge" aria-hidden="true">
                {item.num}
              </span>
              <span className="chat-rich-list-content">
                {renderChatInlineText(item.content)}
              </span>
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    // 5. Regular paragraph (group consecutive non-special lines)
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(\|.*\|$|#{1,4}\s+|[•\-\*]\s+|\d+[\.\)]\s+)/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i].trim());
      i += 1;
    }
    blocks.push(
      <p key={`p-${keyCounter++}`} className="chat-rich-p">
        {paraLines.map((pLine, pIdx) => (
          <span key={pIdx}>
            {pIdx > 0 ? <br /> : null}
            {renderChatInlineText(pLine)}
          </span>
        ))}
      </p>,
    );
  }

  return blocks.length > 0 ? blocks : renderChatInlineText(text);
}

type FilterSelectOption = {
  value: string;
  label: string;
};

function inventarioShortLabel(name: string) {
  const match = name.match(/(\d+)\s*$/);
  if (match) return match[1];
  return name.replace(/^Inventario\s*/i, "").trim() || name;
}

function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: FilterSelectOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: globalThis.MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`report-select ${open ? "is-open" : ""}`} ref={rootRef}>
      <label htmlFor={id}>{label}</label>
      <button
        id={id}
        type="button"
        className="report-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected?.label ?? "Seleccionar"}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open ? (
        <ul className="report-select-menu" role="listbox" aria-labelledby={id}>
          {options.map((option) => {
            const active = option.value === value;
            return (
              <li key={option.value} role="option" aria-selected={active}>
                <button
                  type="button"
                  className={active ? "report-select-option is-active" : "report-select-option"}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span>{option.label}</span>
                  {active ? <Check size={14} aria-hidden="true" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function MultiFilterSelect({
  id,
  label,
  values,
  options,
  onChange,
  allLabel,
}: {
  id: string;
  label: string;
  values: string[];
  options: FilterSelectOption[];
  onChange: (values: string[]) => void;
  allLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const triggerLabel = (() => {
    if (!values.length) return allLabel;
    if (values.length === 1) return values[0];
    if (values.length === 2) {
      return `Inv. ${values.map(inventarioShortLabel).join(" · ")}`;
    }
    return `${values.length} inventarios`;
  })();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: globalThis.MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggleValue = (value: string) => {
    if (values.includes(value)) {
      onChange(values.filter((item) => item !== value));
      return;
    }
    onChange([...values, value].sort((a, b) => a.localeCompare(b, "es")));
  };

  const allActive = values.length === 0;

  return (
    <div className={`report-select report-select-multi ${open ? "is-open" : ""}`} ref={rootRef}>
      <label htmlFor={id}>{label}</label>
      <button
        id={id}
        type="button"
        className="report-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{triggerLabel}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open ? (
        <ul className="report-select-menu" role="listbox" aria-multiselectable="true" aria-labelledby={id}>
          <li role="option" aria-selected={allActive}>
            <button
              type="button"
              className={allActive ? "report-select-option is-check is-active" : "report-select-option is-check"}
              onClick={() => onChange([])}
            >
              <span
                className={allActive ? "rep-checkbox-btn is-checked" : "rep-checkbox-btn"}
                aria-hidden="true"
              >
                {allActive ? <Check size={12} strokeWidth={3} /> : null}
              </span>
              <span>{allLabel}</span>
            </button>
          </li>
          {options.map((option) => {
            const active = values.includes(option.value);
            return (
              <li key={option.value} role="option" aria-selected={active}>
                <button
                  type="button"
                  className={active ? "report-select-option is-check is-active" : "report-select-option is-check"}
                  onClick={() => toggleValue(option.value)}
                >
                  <span
                    className={active ? "rep-checkbox-btn is-checked" : "rep-checkbox-btn"}
                    aria-hidden="true"
                  >
                    {active ? <Check size={12} strokeWidth={3} /> : null}
                  </span>
                  <span>{option.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

const COLUMNS = [
  ["etiqueta", "Etiqueta"],
  ["articulo", "Artículo"],
  ["marca", "Marca"],
  ["modelo", "Modelo"],
  ["serie", "Serie"],
  ["area", "Área"],
  ["persona", "Persona"],
  ["cantidad", "Cantidad"],
  ["estado", "Estado"],
  ["origen", "Origen"],
] as const;

function columnClassName(key: (typeof COLUMNS)[number][0]) {
  switch (key) {
    case "etiqueta":
      return "etiqueta col-etiqueta";
    case "articulo":
      return "col-articulo";
    case "marca":
      return "col-marca";
    case "modelo":
      return "col-modelo";
    case "serie":
      return "col-serie";
    case "area":
      return "col-area";
    case "persona":
      return "col-persona";
    case "cantidad":
      return "col-cantidad";
    case "estado":
      return "col-estado";
    case "origen":
      return "col-origen";
    default:
      return undefined;
  }
}

const AVATAR_COLORS = [
  "#536fd0",
  "#238d84",
  "#9d7040",
  "#815bb1",
  "#b45468",
  "#3e788e",
  "#c47a3a",
  "#4a8f5c",
  "#7a5cbf",
  "#b85c8a",
  "#2f7a9c",
  "#a36b3d",
];

const RAIL_ITEMS = [
  { id: "inventario", label: "Inventario", icon: LayoutDashboard },
  { id: "personas", label: "Personas", icon: Users },
  { id: "reportes", label: "Reportes", icon: BarChart3 },
  { id: "estado", label: "Estado", icon: CircleDot },
  { id: "areas", label: "Áreas", icon: MapPin },
  { id: "archivos", label: "Chat", icon: MessageSquare },
] as const;

const RAIL_STORAGE_KEY = "inventario-apartado";
const VALID_RAILS = new Set<string>([
  ...RAIL_ITEMS.map((item) => item.id),
  "avisos",
]);

function loadSavedRail() {
  if (typeof window === "undefined") return "inventario";
  const saved = window.localStorage.getItem(RAIL_STORAGE_KEY);
  if (saved === "equipos") return "estado";
  return saved && VALID_RAILS.has(saved) ? saved : "inventario";
}

function estadoLabel(value: unknown) {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (v === "inactivo" || v === "baja" || v === "no" || v === "inactive") return "Inactivo";
  return "Activo";
}

type FolderCard = {
  id: string;
  name: string;
  people: string[];
  rows: InventarioRow[];
};

function textOf(value: InventarioRow[keyof InventarioRow]) {
  return String(value ?? "").trim();
}

function initials(name: string) {
  const parts = name.split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? "").concat(parts[1]?.[0] ?? "").toUpperCase();
}

function colorFor(name: string) {
  const total = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return AVATAR_COLORS[total % AVATAR_COLORS.length];
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("es-MX").format(value);
}

function articulosHint(count: number, inventariosCount: number) {
  const articulos =
    count === 1 ? "1 artículo" : `${formatNumber(count)} artículos`;
  if (inventariosCount <= 0) return articulos;
  const inventarios =
    inventariosCount === 1 ? "1 inventario" : `${formatNumber(inventariosCount)} inventarios`;
  return `${articulos} · ${inventarios}`;
}

function inventarioCardCopy(
  selected: string[],
  totalInventarios: number,
  articulosCount: number,
  inventariosEnVista: number,
) {
  if (!selected.length || selected.length === totalInventarios) {
    return {
      title: "Inventario Total",
      hint: articulosHint(articulosCount, inventariosEnVista),
    };
  }
  if (selected.length === 1) {
    return {
      title: selected[0],
      hint: articulosCount === 1 ? "1 artículo" : `${formatNumber(articulosCount)} artículos`,
    };
  }
  const shorts = selected.map(inventarioShortLabel);
  if (selected.length === 2) {
    return {
      title: `Inv. ${shorts.join(" · ")}`,
      hint: articulosHint(articulosCount, 2),
    };
  }
  return {
    title: `${selected.length} inventarios`,
    hint: articulosHint(articulosCount, selected.length),
  };
}

function buildFolders(rows: InventarioRow[], by: "persona" | "area"): FolderCard[] {
  const groups = new Map<string, InventarioRow[]>();
  for (const row of rows) {
    const name = by === "persona" ? textOf(row.persona) : textOf(row.area) || "General";
    if (!name) continue;
    const bucket = groups.get(name);
    if (bucket) bucket.push(row);
    else groups.set(name, [row]);
  }

  return [...groups.entries()]
    .sort((a, b) =>
      by === "persona"
        ? a[0].localeCompare(b[0], "es")
        : b[1].length - a[1].length || a[0].localeCompare(b[0], "es"),
    )
    .map(([name, group]) => ({
      id: name,
      name,
      people: [...new Set(group.map((row) => textOf(row.persona)).filter(Boolean))],
      rows:
        by === "persona"
          ? [...group].sort((a, b) =>
              textOf(a.etiqueta).localeCompare(textOf(b.etiqueta), "es"),
            )
          : group,
    }));
}

const TABLE_FIRST_ROWS = 64;
const TABLE_CHUNK_ROWS = 96;

const InventoryTableRow = memo(function InventoryTableRow({
  row,
  selectMode,
  isChecked,
  onToggle,
  onOpen,
}: {
  row: InventarioRow;
  selectMode: boolean;
  isChecked: boolean;
  onToggle: (id: number) => void;
  onOpen: (row: InventarioRow) => void;
}) {
  const rowId = Number(row.id);
  const hasId = Number.isFinite(rowId);

  return (
    <tr
      className={
        selectMode
          ? isChecked
            ? "table-row-selectable is-selected"
            : "table-row-selectable"
          : "table-row-clickable"
      }
      onClick={() => {
        if (selectMode) {
          if (hasId) onToggle(rowId);
          return;
        }
        onOpen(row);
      }}
      title={
        selectMode
          ? "Haz clic para seleccionar o deseleccionar"
          : "Haz clic para ver detalles y opciones de este artículo"
      }
    >
      {COLUMNS.map(([key, label]) => (
        <td
          key={label}
          className={columnClassName(key)}
          title={
            key === "articulo" ||
            key === "marca" ||
            key === "modelo" ||
            key === "serie" ||
            key === "area" ||
            key === "persona" ||
            key === "origen"
              ? textOf(row[key]) || undefined
              : undefined
          }
        >
          {key === "etiqueta" && selectMode ? (
            <span className="table-select-cell">
              <span
                className={isChecked ? "rep-checkbox-btn is-checked" : "rep-checkbox-btn"}
                aria-hidden="true"
              >
                {isChecked ? <Check size={12} strokeWidth={3} /> : null}
              </span>
              <span>{textOf(row.etiqueta) || "—"}</span>
            </span>
          ) : key === "persona" && textOf(row.persona) ? (
            <span className="person-cell">
              <span
                className="avatar"
                style={{ backgroundColor: colorFor(textOf(row.persona)) }}
                aria-hidden="true"
              >
                {initials(textOf(row.persona))}
              </span>
              <span>{textOf(row.persona)}</span>
            </span>
          ) : key === "cantidad" ? (
            textOf(row.cantidad) || "—"
          ) : key === "estado" ? (
            <span
              className={
                estadoLabel(row.estado) === "Activo"
                  ? "estado-badge is-activo"
                  : "estado-badge is-inactivo"
              }
            >
              {estadoLabel(row.estado)}
            </span>
          ) : (
            textOf(row[key]) || "—"
          )}
        </td>
      ))}
    </tr>
  );
});

function Avatars({ people }: { people: string[] }) {
  const shown = people.slice(0, 4);
  const extra = people.length - shown.length;

  if (!people.length) {
    return (
      <span className="avatar-stack" aria-label="Sin personas asignadas">
        <span className="avatar avatar-empty">—</span>
      </span>
    );
  }

  return (
    <span className="avatar-stack" aria-label={`${people.length} personas asignadas`}>
      {shown.map((person) => (
        <span
          className="avatar"
          key={person}
          style={{ backgroundColor: colorFor(person) }}
          title={person}
        >
          {initials(person)}
        </span>
      ))}
      {extra > 0 ? <span className="avatar avatar-extra">+{extra}</span> : null}
    </span>
  );
}

const SideRail = memo(function SideRail({
  active,
  onChange,
  expanded,
  onExpandedChange,
  chatSessions,
  activeChatId,
  onOpenHistory: _onOpenHistory,
  onBackToWorkspace,
  onStartNewChat,
  onOpenChat,
  onDeleteChat,
  collapseRef,
}: {
  active: string;
  onChange: (id: string) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  chatSessions: ChatSession[];
  activeChatId: string | null;
  onOpenHistory: () => void;
  onBackToWorkspace: () => void;
  onStartNewChat: () => void;
  onOpenChat: (sessionId: string) => void;
  onDeleteChat: (sessionId: string) => void;
  collapseRef?: MutableRefObject<(() => void) | null>;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [compactNav, setCompactNav] = useState(false);
  const [menuChatId, setMenuChatId] = useState<string | null>(null);
  const isChat = active === "archivos";
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 980px)");
    const sync = () => setCompactNav(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!menuChatId) return;
    const close = () => {
      setMenuChatId(null);
      setMenuPos(null);
    };
    const onPointer = (event: globalThis.MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".sidebar-history-menu")) return;
      if (target?.closest(".sidebar-history-more")) return;
      close();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuChatId]);

  useEffect(() => {
    if (!deleteConfirmId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDeleteConfirmId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteConfirmId]);

  useEffect(() => {
    onExpandedChange(!collapsed);
  }, [collapsed, onExpandedChange]);

  useEffect(() => {
    if (isChat) return;
    setMenuChatId(null);
    setMenuPos(null);
    setDeleteConfirmId(null);
  }, [isChat]);

  useEffect(() => {
    if (!collapseRef) return;
    collapseRef.current = () => {
      if (collapsed) return;
      setCollapsed(true);
      window.localStorage.setItem("inventario-sidebar", "collapsed");
    };
    return () => {
      collapseRef.current = null;
    };
  }, [collapseRef, collapsed]);

  const collapseSidebar = () => {
    setCollapsed(true);
    window.localStorage.setItem("inventario-sidebar", "collapsed");
  };

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem("inventario-sidebar", next ? "collapsed" : "expanded");
      return next;
    });
  };

  return (
    <aside
      className={`sidebar ${expanded ? "is-expanded" : "is-collapsed"}${
        isChat ? " is-history is-chat-mode" : ""
      }`}
      aria-label="Navegación principal"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="sidebar-top">
        <div className="sidebar-header">
          <a className="brand" href="#inicio" aria-label="Inventario, inicio" title="Inventario">
            <span className="brand-mark" aria-hidden="true">
              <Boxes size={21} strokeWidth={1.8} />
            </span>
            <span className="brand-copy">
              <strong>Inventario</strong>
              <span>Gestión de oficina</span>
            </span>
          </a>
          <button
            type="button"
            className={
              collapsed ? "sidebar-rail-toggle is-closed" : "sidebar-rail-toggle is-open"
            }
            aria-label={collapsed ? "Abrir barra lateral" : "Cerrar barra lateral"}
            aria-expanded={!collapsed}
            title={collapsed ? "Abrir barra lateral" : "Cerrar barra lateral"}
            onClick={toggleCollapsed}
          >
            {collapsed ? (
              <svg
                className="sidebar-rail-lines"
                width="18"
                height="12"
                viewBox="0 0 18 12"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M1.5 2.75h15M1.5 9.25h15"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg
                className="sidebar-rail-close"
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <rect
                  x="3"
                  y="4"
                  width="14"
                  height="12"
                  rx="2.2"
                  stroke="currentColor"
                  strokeWidth="1.55"
                />
                <path
                  d="M7.35 4v12"
                  stroke="currentColor"
                  strokeWidth="1.55"
                  strokeLinecap="round"
                />
                <path
                  className="sidebar-rail-arrow"
                  d="M13.6 7.15 L10.85 10 L13.6 12.85"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        </div>
        {isChat ? (
          <button
            type="button"
            className="sidebar-new-chat"
            aria-label="Empezar consulta nueva"
            title="Empezar consulta nueva"
            onClick={() => {
              onStartNewChat();
              if (compactNav) collapseSidebar();
            }}
          >
            <Plus size={18} strokeWidth={1.8} aria-hidden="true" />
            <span className="sidebar-new-chat-label">Empezar nueva</span>
          </button>
        ) : (
          <button
            type="button"
            className="sidebar-new-chat"
            aria-label="Nueva consulta"
            title="Nueva consulta"
            onClick={() => {
              onStartNewChat();
              if (compactNav) collapseSidebar();
            }}
          >
            <svg
              className="sidebar-new-chat-icon"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <rect
                x="3.5"
                y="3.5"
                width="17"
                height="17"
                rx="4"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <path
                d="M12.2 8.4 15.6 11.8M8 16.2l1.1-3.9 5.5-5.5a1.7 1.7 0 0 1 2.4 2.4l-5.5 5.5-3.9 1.1Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="sidebar-new-chat-label">Nueva consulta</span>
          </button>
        )}
      </div>

      {isChat && !collapsed ? (
        <div className="sidebar-history">
          <div className="nav-caption">Reciente</div>
          {chatSessions.length ? (
            <div className="sidebar-history-list" role="list">
              {chatSessions.map((session) => {
                const selected = session.id === activeChatId;
                const menuOpen = menuChatId === session.id;
                return (
                  <div
                    key={session.id}
                    role="listitem"
                    className={
                      selected || menuOpen
                        ? "sidebar-history-item is-active"
                        : "sidebar-history-item"
                    }
                  >
                    <button
                      type="button"
                      className="sidebar-history-open"
                      onClick={() => {
                        setMenuChatId(null);
                        setMenuPos(null);
                        onOpenChat(session.id);
                        if (compactNav) collapseSidebar();
                      }}
                      title={session.title}
                    >
                      <span>{session.title}</span>
                    </button>
                    <button
                      type="button"
                      className="sidebar-history-more"
                      aria-label={`Opciones de ${session.title}`}
                      aria-expanded={menuOpen}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (menuChatId === session.id) {
                          setMenuChatId(null);
                          setMenuPos(null);
                          return;
                        }
                        const rect = event.currentTarget.getBoundingClientRect();
                        setMenuPos({
                          top: rect.top,
                          left: Math.min(rect.right + 8, window.innerWidth - 180),
                        });
                        setMenuChatId(session.id);
                      }}
                    >
                      <MoreVertical size={16} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
              {menuChatId && menuPos && typeof document !== "undefined"
                ? createPortal(
                    <div
                      className="sidebar-history-menu is-floating"
                      role="menu"
                      style={{ top: menuPos.top, left: menuPos.left }}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setDeleteConfirmId(menuChatId);
                          setMenuChatId(null);
                          setMenuPos(null);
                        }}
                      >
                        <Trash2 size={18} strokeWidth={1.6} aria-hidden="true" />
                        <span>Borrar</span>
                      </button>
                    </div>,
                    document.body,
                  )
                : null}
            </div>
          ) : (
            <div className="sidebar-history-empty">
              <span className="sidebar-history-empty-icon" aria-hidden="true">
                <Clock3 size={22} strokeWidth={1.6} />
              </span>
              <strong>No tienes ninguna conversación</strong>
              <p>Empieza una consulta nueva y aparecerá aquí en Reciente.</p>
            </div>
          )}
        </div>
      ) : !isChat ? (
        <>
          <div className="nav-caption">Espacio de trabajo</div>
          <nav className="rail-nav">
            {RAIL_ITEMS.map(({ id, label, icon: Icon }) => {
              const selected = id === active;
              return (
                <button
                  type="button"
                  key={id}
                  className={selected ? "rail-btn is-active" : "rail-btn"}
                  aria-label={label}
                  title={label}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => {
                    if (id === "archivos") {
                      onStartNewChat();
                    } else {
                      onChange(id);
                    }
                    if (compactNav) collapseSidebar();
                  }}
                >
                  <span className="rail-icon" aria-hidden="true">
                    <Icon size={18} strokeWidth={1.8} />
                  </span>
                  <span className="rail-label">{label}</span>
                </button>
              );
            })}
          </nav>
          <div className="sidebar-footer" title="Consulta de inventario">
            <span className="sidebar-footer-icon" aria-hidden="true">
              <Settings size={17} strokeWidth={1.8} />
            </span>
            <span className="sidebar-footer-copy">
              <strong>Consulta de inventario</strong>
              <small>Datos de oficina</small>
            </span>
          </div>
        </>
      ) : null}

      {isChat ? (
        <div className="sidebar-pinned">
          <button
            type="button"
            className="rail-btn"
            aria-label="Espacio de trabajo"
            title="Espacio de trabajo"
            onClick={() => {
              onBackToWorkspace();
              if (compactNav) collapseSidebar();
            }}
          >
            <span className="rail-icon" aria-hidden="true">
              <LayoutDashboard size={18} strokeWidth={1.8} />
            </span>
            <span className="rail-label">Espacio de trabajo</span>
          </button>
        </div>
      ) : null}

      {deleteConfirmId ? (
        <ChatChoiceModal
          titleId="sidebar-delete-title"
          title="Eliminar búsqueda"
          subtitle="Elige cómo quieres continuar con esta conversación"
          onDismiss={() => setDeleteConfirmId(null)}
          keep={{
            title: "Cancelar",
            body: "Mantén esta búsqueda en Reciente. No se borra nada y puedes seguir consultando.",
            action: "Volver al chat",
            onClick: () => setDeleteConfirmId(null),
          }}
          drop={{
            title: "Borrar",
            body: "No podrás regresar a esta respuesta ni a su historial en Reciente.",
            action: "Eliminar conversación",
            onClick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              const id = deleteConfirmId;
              setDeleteConfirmId(null);
              onDeleteChat(id);
            },
          }}
        />
      ) : null}
    </aside>
  );
});

export default function InventoryView({ rows }: { rows: InventarioRow[] }) {
  const [items, setItems] = useState<InventarioRow[]>(rows);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<InventarioRow | null>(null);
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const collapseSidebarRef = useRef<(() => void) | null>(null);

  const handleProductUpdated = (updated: InventarioRow) => {
    setItems((prev) =>
      prev.map((item) => (item.id === updated.id ? updated : item))
    );
    setSelectedProduct(updated);
  };

  const handleProductDeleted = (deletedId: number) => {
    setItems((prev) => prev.filter((item) => item.id !== deletedId));
    setSelectedProduct(null);
  };
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedInventarios, setSelectedInventarios] = useState<string[]>([]);
  const [inventarioSearch, setInventarioSearch] = useState("");
  const [debouncedInventarioSearch, setDebouncedInventarioSearch] = useState("");
  const [peopleAreaFilter, setPeopleAreaFilter] = useState("ALL");
  const [peopleOrigenFilter, setPeopleOrigenFilter] = useState("ALL");
  const [peopleSearch, setPeopleSearch] = useState("");
  const [debouncedPeopleSearch, setDebouncedPeopleSearch] = useState("");
  const [rail, setRail] = useState("inventario");
  const [railReady, setRailReady] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedRowIds, setSelectedRowIds] = useState<number[]>([]);
  const [undoStack, setUndoStack] = useState<InventarioRow[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [draft, setDraft] = useState("");
  const [expandedUserMsgs, setExpandedUserMsgs] = useState<number[]>([]);
  const [editingUserMsgId, setEditingUserMsgId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [pendingAttach, setPendingAttach] = useState<{
    kind: "image" | "file";
    name: string;
    file?: File;
  } | null>(null);
  const [pendingChatImport, setPendingChatImport] = useState<NewInventarioItem[] | null>(
    null,
  );
  const [pendingFieldRevert, setPendingFieldRevert] = useState<ChatFieldChange | null>(
    null,
  );
  const [pendingBulkTransfer, setPendingBulkTransfer] =
    useState<PendingBulkTransfer | null>(null);
  const [pendingChatDeleteRow, setPendingChatDeleteRow] =
    useState<InventarioRow | null>(null);
  const [chatDeleteBusy, setChatDeleteBusy] = useState(false);
  const [chatDropActive, setChatDropActive] = useState(false);
  const [chatQrByMsg, setChatQrByMsg] = useState<Record<number, ChatQrCard[]>>({});
  const [infoOpen, setInfoOpen] = useState(false);
  const [dark, setDark] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [tokenMeters, setTokenMeters] = useState<Record<string, TokenMeterEntry>>({});
  const [availableModels, setAvailableModels] = useState<ChatModelOption[]>([]);
  const [activeLlmMeta, setActiveLlmMeta] = useState<{
    provider: string;
    providerLabel: string;
    model: string;
    keyFingerprint: string;
    budget: number;
  }>({
    provider: "nvidia",
    providerLabel: "NVIDIA NIM",
    model: "nvidia/nemotron-3.5-bolt-e4b",
    keyFingerprint: "default",
    budget: 128_000,
  });
  const [tokenPopoverOpen, setTokenPopoverOpen] = useState(false);
  const tokenMeterWrapRef = useRef<HTMLDivElement>(null);
  const chatHydratedRef = useRef(false);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const chatStageRef = useRef<HTMLDivElement>(null);
  const viewerRailRef = useRef<HTMLElement>(null);
  const viewPanelRef = useRef<HTMLElement>(null);
  const chatAttachRef = useRef<HTMLDivElement>(null);
  const chatImageInputRef = useRef<HTMLInputElement>(null);
  const chatFileInputRef = useRef<HTMLInputElement>(null);
  const chatId = useRef(1);
  const messagesRef = useRef<ChatMessage[]>([]);
  const activeChatIdRef = useRef<string | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatRequestGenRef = useRef(0);
  const pendingChatImportRef = useRef<NewInventarioItem[] | null>(null);
  const pendingFieldRevertRef = useRef<ChatFieldChange | null>(null);
  const pendingBulkTransferRef = useRef<PendingBulkTransfer | null>(null);
  const pendingDisambiguationRef = useRef<PendingDisambiguationState | null>(null);
  /** Último listado concreto (aunque el visor no se haya abierto) para follow-ups tipo "no se ven". */
  const lastConcreteSideRef = useRef<{
    resultItems: ChatApiItem[];
    qr: ChatQrPayload[];
    viewerOverview?: ViewerOverview;
    viewerFocus?: string;
  } | null>(null);
  const chatStarted = messages.some((message) => message.from === "user");
  const chatComposerBusy = useMemo(
    () =>
      messages.some((message) => {
        if (message.from !== "bot") return false;
        const text = String(message.text || "").trim();
        return /^(consultando el inventario|importando)\b/i.test(text);
      }),
    [messages],
  );
  /** Solo el último bot abre el visor; si el nuevo no lo pidió, desaparece. */
  const activeSideCompanion = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.from !== "bot") continue;
      if (!messageHasSideData(message)) return null;
      return {
        messageId: message.id,
        resultItems: Array.isArray(message.resultItems)
          ? message.resultItems
          : [],
        qrCards: chatQrByMsg[message.id] || [],
        overview: message.viewerOverview,
        overviewFocus: message.viewerFocus,
      };
    }
    return null;
  }, [messages, chatQrByMsg]);

  const showSideViewer = Boolean(activeSideCompanion);

  const chatTurns = useMemo(() => {
    const turns: Array<
      | { kind: "single"; message: ChatMessage }
      | { kind: "pair"; user: ChatMessage; bot: ChatMessage }
    > = [];
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      const next = messages[i + 1];
      if (message.from === "user" && next?.from === "bot") {
        turns.push({ kind: "pair", user: message, bot: next });
        i += 1;
        continue;
      }
      turns.push({ kind: "single", message });
    }
    return turns;
  }, [messages]);

  // Marca lotes QR del chat una sola vez (sin miniaturas ni bucle de regen).
  useEffect(() => {
    const updates: Record<number, ChatQrCard[]> = {};
    for (const message of messages) {
      if (
        !messageHasSideData(message) ||
        !Array.isArray(message.qr) ||
        !message.qr.length
      ) {
        continue;
      }
      if (chatQrByMsg[message.id]?.length) continue;
      const cards = buildChatQrCards(message.qr);
      if (cards.length) updates[message.id] = cards;
    }
    if (!Object.keys(updates).length) return;
    setChatQrByMsg((prev) => ({ ...prev, ...updates }));
  }, [messages, chatQrByMsg]);

  useLayoutEffect(() => {
    setRail(loadSavedRail());
    // Doble rAF: deja pintar layout antes del fade-in (recarga más suave)
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => setRailReady(true));
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, []);

  useEffect(() => {
    setTokenMeters(loadTokenMeters());
    let alive = true;
    void fetchChatHealth().then((llm) => {
      if (!alive || !llm) return;
      const modelsList = Array.isArray(llm.available_models) ? llm.available_models : [];
      if (modelsList.length) {
        setAvailableModels(modelsList);
      }
      const keyFingerprint = String(
        llm.key_fingerprint ||
          modelsList[0]?.key_fingerprint ||
          llm.providers?.[0]?.key_fingerprint ||
          "default",
      );
      const savedModelId = loadSelectedModelForKey(keyFingerprint);
      const matchedSaved = savedModelId
        ? modelsList.find((m) => m.id === savedModelId)
        : undefined;
      const bestDefault =
        modelsList.find((m) => m.recommended) || modelsList[0];
      const chosen = matchedSaved || bestDefault;

      const provider = String(
        chosen?.provider || llm.active_provider || llm.providers?.[0]?.name || "nvidia",
      );
      const providerLabel = String(
        chosen?.provider_label ||
          llm.active_provider_label ||
          llm.providers?.[0]?.label ||
          provider.toUpperCase(),
      );
      const model = String(
        chosen?.id ||
          llm.default_model ||
          llm.active_model ||
          llm.preferred_model ||
          llm.providers?.[0]?.models?.[0] ||
          "nvidia/nemotron-3.5-bolt-e4b",
      );
      const budget = Number(
        chosen?.token_budget ||
          llm.token_budget ||
          llm.providers?.[0]?.token_budget ||
          128_000,
      );
      setActiveLlmMeta({
        provider,
        providerLabel,
        model,
        keyFingerprint: String(chosen?.key_fingerprint || keyFingerprint),
        budget: Number.isFinite(budget) && budget > 0 ? budget : 128_000,
      });
    });
    return () => {
      alive = false;
    };
  }, [rail]);

  const selectLlmModel = useCallback((option: ChatModelOption) => {
    saveSelectedModelForKey(option.key_fingerprint, option.id);
    setActiveLlmMeta({
      provider: option.provider,
      providerLabel: option.provider_label || option.provider.toUpperCase(),
      model: option.id,
      keyFingerprint: option.key_fingerprint,
      budget:
        Number.isFinite(option.token_budget) && option.token_budget > 0
          ? option.token_budget
          : 128_000,
    });
  }, []);

  useEffect(() => {
    if (!tokenPopoverOpen) return;
    const onPointer = (event: globalThis.MouseEvent) => {
      if (!tokenMeterWrapRef.current?.contains(event.target as Node)) {
        setTokenPopoverOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTokenPopoverOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [tokenPopoverOpen]);

  const recordTokenConsumption = useCallback(
    (usage?: ChatTokenUsage | null, fallbackPrompt = "", fallbackReply = "") => {
      const provider = String(usage?.provider || activeLlmMeta.provider || "nvidia");
      const model = String(usage?.model || activeLlmMeta.model || "nvidia/nemotron-3.5-bolt-e4b");
      const keyFingerprint = String(
        usage?.key_fingerprint || activeLlmMeta.keyFingerprint || "default",
      );
      const budget =
        Number(usage?.token_budget) > 0
          ? Number(usage?.token_budget)
          : activeLlmMeta.budget || 128_000;
      const promptTokens =
        usage && typeof usage.prompt_tokens === "number"
          ? usage.prompt_tokens
          : estimateTextTokens(fallbackPrompt);
      const completionTokens =
        usage && typeof usage.completion_tokens === "number"
          ? usage.completion_tokens
          : estimateTextTokens(fallbackReply);
      const turnTotal =
        usage && typeof usage.total_tokens === "number" && usage.total_tokens > 0
          ? usage.total_tokens
          : promptTokens + completionTokens;

      const matchedCatalog = availableModels.find((m) => m.id === model);
      setActiveLlmMeta((prev) => ({
        provider,
        providerLabel:
          matchedCatalog?.provider_label ||
          prev.providerLabel ||
          provider.toUpperCase(),
        model,
        keyFingerprint,
        budget,
      }));

      const meterId = `${provider}:${model}:${keyFingerprint}`;
      setTokenMeters((prev) => {
        const current = prev[meterId];
        const nextEntry: TokenMeterEntry = {
          used: (current?.used || 0) + turnTotal,
          promptUsed: (current?.promptUsed || 0) + promptTokens,
          completionUsed: (current?.completionUsed || 0) + completionTokens,
          budget,
          provider,
          model,
          keyFingerprint,
          lastTurnTokens: turnTotal,
          updatedAt: Date.now(),
        };
        const updated = { ...prev, [meterId]: nextEntry };
        saveTokenMeters(updated);
        return updated;
      });
    },
    [activeLlmMeta],
  );

  const activeTokenMeter = useMemo(() => {
    const meterId = `${activeLlmMeta.provider}:${activeLlmMeta.model}:${activeLlmMeta.keyFingerprint}`;
    const stored = tokenMeters[meterId];
    const draftTokens = draft.trim() ? estimateTextTokens(draft) : 0;
    const baseUsed = stored?.used || 0;
    const budget = stored?.budget || activeLlmMeta.budget || 128_000;
    const totalUsed = Math.min(budget, baseUsed + draftTokens);
    const remaining = Math.max(0, budget - totalUsed);
    const pctUsed = Math.min(100, Math.max(0, (totalUsed / Math.max(1, budget)) * 100));
    const pctRemaining = Math.max(0, 100 - pctUsed);
    const shortModel = activeLlmMeta.model.includes("/")
      ? activeLlmMeta.model.split("/").pop() || activeLlmMeta.model
      : activeLlmMeta.model;
    const matchedOption = availableModels.find(
      (m) => m.id === activeLlmMeta.model,
    );
    return {
      meterId,
      provider: activeLlmMeta.provider.toUpperCase(),
      providerLabel:
        matchedOption?.provider_label ||
        activeLlmMeta.providerLabel ||
        activeLlmMeta.provider.toUpperCase(),
      model: activeLlmMeta.model,
      modelLabel: matchedOption?.label || shortModel,
      shortModel,
      keyFingerprint: activeLlmMeta.keyFingerprint,
      used: totalUsed,
      baseUsed,
      draftTokens,
      promptUsed: stored?.promptUsed || 0,
      completionUsed: stored?.completionUsed || 0,
      lastTurnTokens: stored?.lastTurnTokens || 0,
      budget,
      remaining,
      pctUsed,
      pctRemaining,
    };
  }, [activeLlmMeta, availableModels, tokenMeters, draft]);

  useEffect(() => {
    const loaded = loadChatSessions();
    setChatSessions(loaded);
    chatHydratedRef.current = true;
    hydrateMemoryFromChatSessions(loaded, rows.length || items.length);
    const activeId = loadActiveChatId();
    if (!activeId) return;
    const session = loaded.find((item) => item.id === activeId);
    if (!session?.messages?.length) {
      // Activo vacío o huérfano: no borres el historial, solo limpia el puntero.
      saveActiveChatId(null);
      return;
    }
    activeChatIdRef.current = session.id;
    messagesRef.current = session.messages;
    setActiveChatId(session.id);
    setMessages(session.messages);
    const maxId = session.messages.reduce((max, message) => Math.max(max, message.id), 0);
    chatId.current = maxId + 1;
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => {
      startTransition(() => setDebouncedQuery(query));
    }, 200);
    return () => window.clearTimeout(id);
  }, [query]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      startTransition(() => setDebouncedInventarioSearch(inventarioSearch));
    }, 200);
    return () => window.clearTimeout(id);
  }, [inventarioSearch]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      startTransition(() => setDebouncedPeopleSearch(peopleSearch));
    }, 200);
    return () => window.clearTimeout(id);
  }, [peopleSearch]);

  // Índice estable por `items`: no se reconstruye al cambiar de apartado
  const searchIndex = useMemo(() => buildSearchIndex(items), [items]);
  const searchIndexById = useMemo(() => {
    const map = new Map<string, (typeof searchIndex)[number]>();
    for (const entry of searchIndex) {
      const key =
        entry.row.id != null
          ? `id:${entry.row.id}`
          : `etq:${String(entry.row.etiqueta ?? "").toLowerCase()}::${String(entry.row.origen ?? "").toLowerCase()}`;
      map.set(key, entry);
    }
    return map;
  }, [searchIndex]);

  useEffect(() => {
    if (!railReady) return;
    window.localStorage.setItem(RAIL_STORAGE_KEY, rail);
  }, [rail, railReady]);

  const tableRef = useRef<HTMLDivElement>(null);
  const peopleStripRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef(items);
  const navFromPopRef = useRef(false);
  const navSkipPushRef = useRef(true);
  const navSnapshotRef = useRef({
    rail: "inventario",
    selectedId: null as string | null,
    addOpen: false,
    detailId: null as number | null,
  });

  itemsRef.current = items;
  navSnapshotRef.current = {
    rail,
    selectedId,
    addOpen: isAddModalOpen,
    detailId: selectedProduct?.id != null ? Number(selectedProduct.id) : null,
  };

  // Memoria compartida entre chats: snapshot del total actual.
  useEffect(() => {
    if (!items.length) return;
    rememberTotalSnapshot(items.length, {
      chatId: activeChatIdRef.current,
      note: `Total inventario en app: ${items.length}`,
    });
  }, [items.length]);

  // Fusiona props del servidor sin pisar ediciones locales más recientes
  useEffect(() => {
    startTransition(() => {
      setItems((prev) => {
        if (!prev.length) return rows;
        const byId = new Map<number, InventarioRow>();
        for (const row of rows) {
          if (row.id == null) continue;
          byId.set(Number(row.id), row);
        }
        for (const row of prev) {
          if (row.id == null) continue;
          const id = Number(row.id);
          const incoming = byId.get(id);
          if (!incoming) {
            byId.set(id, row);
            continue;
          }
          const tLocal =
            Date.parse(String(row.updated_at ?? "")) ||
            Date.parse(String(row.created_at ?? "")) ||
            0;
          const tIn =
            Date.parse(String(incoming.updated_at ?? "")) ||
            Date.parse(String(incoming.created_at ?? "")) ||
            0;
          if (tLocal >= tIn) byId.set(id, row);
        }
        return Array.from(byId.values());
      });
    });
  }, [rows]);

  // Historial interno: atrás del navegador cambia de sección/carpeta/modal, no sale de la app
  useEffect(() => {
    if (!railReady) return;

    window.history.replaceState(
      { appNav: true as const, ...navSnapshotRef.current },
      "",
      window.location.href,
    );

    const onPopState = (event: PopStateEvent) => {
      const state = event.state as (typeof navSnapshotRef.current & { appNav?: boolean }) | null;
      if (!state?.appNav) {
        const snap = navSnapshotRef.current;
        const atHome =
          snap.rail === "inventario" &&
          !snap.selectedId &&
          !snap.addOpen &&
          snap.detailId == null;
        // Si aún está en otra sección/modal, reponer estado y no salir de la página
        if (!atHome) {
          window.history.pushState(
            { appNav: true as const, ...snap },
            "",
            window.location.href,
          );
        }
        return;
      }

      navFromPopRef.current = true;
      setRail(state.rail || "inventario");
      setSelectedId(state.selectedId);
      setIsAddModalOpen(Boolean(state.addOpen));
      setSelectMode(false);
      setSelectedRowIds([]);
      setConfirmBulkDelete(false);
      setBulkError(null);
      setInfoOpen(false);

      if (state.detailId != null) {
        const found = itemsRef.current.find((row) => Number(row.id) === Number(state.detailId));
        setSelectedProduct(found ?? null);
      } else {
        setSelectedProduct(null);
      }
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [railReady]);

  const lastNavKeyRef = useRef("");

  useEffect(() => {
    if (!railReady) return;

    const detailId = selectedProduct?.id != null ? Number(selectedProduct.id) : null;
    const key = `${rail}|${selectedId ?? ""}|${isAddModalOpen ? 1 : 0}|${detailId ?? ""}`;

    if (navSkipPushRef.current) {
      navSkipPushRef.current = false;
      lastNavKeyRef.current = key;
      return;
    }
    if (navFromPopRef.current) {
      navFromPopRef.current = false;
      lastNavKeyRef.current = key;
      return;
    }
    if (lastNavKeyRef.current === key) return;
    lastNavKeyRef.current = key;

    window.history.pushState(
      {
        appNav: true as const,
        rail,
        selectedId,
        addOpen: isAddModalOpen,
        detailId,
      },
      "",
      window.location.href,
    );
  }, [rail, railReady, selectedId, isAddModalOpen, selectedProduct?.id]);

  const needsPersonFolders = rail === "personas";
  const needsAreaFolders = rail === "areas";
  const needsTableData =
    rail === "inventario" ||
    rail === "personas" ||
    rail === "areas" ||
    rail === "estado";

  const personFolders = useMemo(
    () => (needsPersonFolders ? buildFolders(items, "persona") : []),
    [items, needsPersonFolders],
  );
  const areaFolders = useMemo(
    () => (needsAreaFolders ? buildFolders(items, "area") : []),
    [items, needsAreaFolders],
  );
  const folders = needsAreaFolders ? areaFolders : personFolders;

  const needsModalLookups = isAddModalOpen || selectedProduct != null;
  const existingAreas = useMemo(() => {
    if (!needsModalLookups) return [] as string[];
    return [...new Set(items.map((r) => textOf(r.area)).filter(Boolean))].sort();
  }, [items, needsModalLookups]);

  const existingPeople = useMemo(() => {
    if (!needsModalLookups) return [] as string[];
    return [...new Set(items.map((r) => textOf(r.persona)).filter(Boolean))].sort();
  }, [items, needsModalLookups]);

  const peopleOrigenOptions = useMemo(() => {
    if (rail !== "personas") return [] as string[];
    return [
      ...new Set(items.map((row) => textOf(row.origen)).filter(Boolean)),
    ].sort();
  }, [items, rail]);

  const peopleAreaOptions = useMemo(() => {
    if (rail !== "personas") return [] as string[];
    return [
      ...new Set(
        items
          .filter((row) => {
            if (peopleOrigenFilter !== "ALL" && textOf(row.origen) !== peopleOrigenFilter) {
              return false;
            }
            return Boolean(textOf(row.area));
          })
          .map((row) => textOf(row.area)),
      ),
    ].sort();
  }, [items, peopleOrigenFilter, rail]);

  const peoplePersonOptions = useMemo(() => {
    if (rail !== "personas") return [] as string[];
    return [
      ...new Set(
        items
          .filter((row) => {
            if (!textOf(row.persona)) return false;
            if (peopleAreaFilter !== "ALL" && textOf(row.area) !== peopleAreaFilter) return false;
            if (peopleOrigenFilter !== "ALL" && textOf(row.origen) !== peopleOrigenFilter) {
              return false;
            }
            return true;
          })
          .map((row) => textOf(row.persona)),
      ),
    ].sort((a, b) => a.localeCompare(b, "es"));
  }, [items, peopleAreaFilter, peopleOrigenFilter, rail]);

  const preparedPeopleSearch = useMemo(
    () => prepareSearch(debouncedPeopleSearch),
    [debouncedPeopleSearch],
  );
  const preparedTopQuery = useMemo(() => prepareSearch(debouncedQuery), [debouncedQuery]);
  const preparedInventarioSearch = useMemo(
    () => prepareSearch(debouncedInventarioSearch),
    [debouncedInventarioSearch],
  );

  const rowKeyOf = (row: InventarioRow) =>
    row.id != null
      ? `id:${row.id}`
      : `etq:${textOf(row.etiqueta).toLowerCase()}::${textOf(row.origen).toLowerCase()}`;

  const rowMatchesIndex = (row: InventarioRow, prepared: NonNullable<ReturnType<typeof prepareSearch>>) => {
    const entry = searchIndexById.get(rowKeyOf(row));
    if (entry) return indexMatchesPrepared(entry, prepared);
    return indexMatchesPrepared(buildSearchIndex([row])[0], prepared);
  };

  const visiblePersonFolders = useMemo(() => {
    if (rail !== "personas") return personFolders;

    const groups = new Map<string, { id: string; name: string; rows: InventarioRow[] }>();
    for (const entry of searchIndex) {
      const row = entry.row;
      if (peopleAreaFilter !== "ALL" && textOf(row.area) !== peopleAreaFilter) continue;
      if (peopleOrigenFilter !== "ALL" && textOf(row.origen) !== peopleOrigenFilter) continue;
      if (preparedPeopleSearch && !indexMatchesPrepared(entry, preparedPeopleSearch)) continue;

      const persona = textOf(row.persona);
      const id = persona ? persona : PERSONA_SIN_ASIGNAR_ID;
      const name = persona ? persona : PERSONA_SIN_ASIGNAR_NAME;
      const bucket = groups.get(id);
      if (bucket) bucket.rows.push(row);
      else groups.set(id, { id, name, rows: [row] });
    }

    return [...groups.values()]
      .map((folder) => ({
        ...folder,
        people: folder.id === PERSONA_SIN_ASIGNAR_ID ? [] : [folder.name],
      }))
      .sort((a, b) => {
        if (a.id === PERSONA_SIN_ASIGNAR_ID) return 1;
        if (b.id === PERSONA_SIN_ASIGNAR_ID) return -1;
        return a.name.localeCompare(b.name, "es");
      });
  }, [rail, personFolders, peopleAreaFilter, peopleOrigenFilter, preparedPeopleSearch, searchIndex]);

  const inventarioOptions = useMemo(() => {
    if (rail !== "inventario") return [] as string[];
    return [
      ...new Set(items.map((row) => textOf(row.origen)).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b, "es"));
  }, [items, rail]);

  const inventarioOptionCounts = useMemo(() => {
    if (rail !== "inventario") return new Map<string, number>();
    const counts = new Map<string, number>();
    for (const row of items) {
      const origen = textOf(row.origen);
      if (!origen) continue;
      counts.set(origen, (counts.get(origen) ?? 0) + 1);
    }
    return counts;
  }, [items, rail]);

  const visible = useMemo(() => {
    if (!needsTableData) return [] as InventarioRow[];

    if (rail === "personas") {
      const selected = visiblePersonFolders.find((folder) => folder.id === selectedId);
      let base = selected
        ? selected.rows
        : visiblePersonFolders.flatMap((folder) => folder.rows);
      if (preparedTopQuery) {
        base = base.filter((row) => rowMatchesIndex(row, preparedTopQuery));
      }
      const seen = new Set<string>();
      base = base.filter((row) => {
        const key = rowKeyOf(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return [...base].sort(
        (a, b) =>
          textOf(a.persona).localeCompare(textOf(b.persona), "es") ||
          textOf(a.etiqueta).localeCompare(textOf(b.etiqueta), "es"),
      );
    }

    const selected = folders.find((folder) => folder.id === selectedId);
    let scoped = items;
    if (rail === "inventario" && selectedInventarios.length > 0) {
      const selectedSet = new Set(selectedInventarios);
      scoped = items.filter((row) => selectedSet.has(textOf(row.origen)));
    }
    let base = selected
      ? selected.rows.filter((row) => {
          if (rail === "inventario" && selectedInventarios.length > 0) {
            return selectedInventarios.includes(textOf(row.origen));
          }
          return true;
        })
      : scoped;
    if (rail === "inventario" && preparedInventarioSearch) {
      base = base.filter((row) => rowMatchesIndex(row, preparedInventarioSearch));
    }
    if (preparedTopQuery) {
      base = base.filter((row) => rowMatchesIndex(row, preparedTopQuery));
    }
    return base;
  }, [
    folders,
    preparedTopQuery,
    preparedInventarioSearch,
    rail,
    items,
    selectedId,
    visiblePersonFolders,
    selectedInventarios,
    needsTableData,
    searchIndexById,
  ]);

  // Tabla progresiva: primeras filas ya; el resto en idle (evita freír el cambio de apartado)
  const [tableRenderLimit, setTableRenderLimit] = useState(TABLE_FIRST_ROWS);

  useEffect(() => {
    setTableRenderLimit(TABLE_FIRST_ROWS);
  }, [
    rail,
    selectedId,
    selectedInventarios,
    debouncedQuery,
    debouncedInventarioSearch,
    peopleAreaFilter,
    peopleOrigenFilter,
    debouncedPeopleSearch,
  ]);

  useEffect(() => {
    if (!needsTableData) return;
    if (tableRenderLimit >= visible.length) return;
    let cancelled = false;
    const grow = () => {
      if (cancelled) return;
      setTableRenderLimit((n) => Math.min(n + TABLE_CHUNK_ROWS, visible.length));
    };

    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(grow, { timeout: 48 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(idleId);
      };
    }

    const timeoutId = window.setTimeout(grow, 16);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [needsTableData, tableRenderLimit, visible.length]);

  const displayedRows = useMemo(
    () => (visible.length <= tableRenderLimit ? visible : visible.slice(0, tableRenderLimit)),
    [visible, tableRenderLimit],
  );

  useEffect(() => {
    if (rail !== "personas") return;
    if (selectedId && !peoplePersonOptions.includes(selectedId)) {
      setSelectedId(null);
    }
  }, [rail, selectedId, peoplePersonOptions]);

  useEffect(() => {
    if (peopleAreaFilter !== "ALL" && !peopleAreaOptions.includes(peopleAreaFilter)) {
      setPeopleAreaFilter("ALL");
    }
  }, [peopleAreaFilter, peopleAreaOptions]);

  useLayoutEffect(() => {
    const savedDark = window.localStorage.getItem("inventario-tema") !== "claro";
    document.documentElement.classList.toggle("theme-dark", savedDark);
    setDark(savedDark);
  }, []);

  useEffect(() => {
    if (!infoOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInfoOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [infoOpen]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 981px)");
    const onChange = () => {
      if (media.matches) setInfoOpen(false);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;

    const header = table.querySelector("thead");
    if (!header) return;
    let target = table.scrollLeft;
    let frame = 0;

    const tick = () => {
      const diff = target - table.scrollLeft;
      if (Math.abs(diff) < 0.6) {
        table.scrollLeft = target;
        frame = 0;
        return;
      }
      table.scrollLeft += diff * 0.14;
      frame = window.requestAnimationFrame(tick);
    };

    const onWheel = (event: WheelEvent) => {
      if (table.scrollWidth <= table.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      const max = table.scrollWidth - table.clientWidth;
      if (!frame) target = table.scrollLeft;
      const next = Math.min(max, Math.max(0, target + delta));
      if (next === target && next === table.scrollLeft) return;
      target = next;
      if (!frame) frame = window.requestAnimationFrame(tick);
      event.preventDefault();
    };

    header.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      header.removeEventListener("wheel", onWheel);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [rail]);

  useEffect(() => {
    const strip = peopleStripRef.current;
    if (!strip) return;

    let target = strip.scrollLeft;
    let frame = 0;

    const tick = () => {
      const diff = target - strip.scrollLeft;
      if (Math.abs(diff) < 0.6) {
        strip.scrollLeft = target;
        frame = 0;
        return;
      }
      strip.scrollLeft += diff * 0.14;
      frame = window.requestAnimationFrame(tick);
    };

    const onWheel = (event: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      const max = strip.scrollWidth - strip.clientWidth;
      if (!frame) target = strip.scrollLeft;
      const next = Math.min(max, Math.max(0, target + delta));
      if (next === target && next === strip.scrollLeft) return;
      target = next;
      if (!frame) frame = window.requestAnimationFrame(tick);
      event.preventDefault();
    };

    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      strip.removeEventListener("wheel", onWheel);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [rail, folders.length]);

  // Pin 1 sola vez en layout (sin RAF/timeout → sin parpadeo).
  useLayoutEffect(() => {
    if (rail !== "archivos") return;
    const logEl = chatLogRef.current;
    const scrollRoot = chatStageRef.current || logEl;
    if (logEl) {
      logEl.querySelectorAll<HTMLElement>("[data-side-msg]").forEach((el) => {
        el.style.minHeight = "";
      });
    }
    if (!scrollRoot || !logEl) return;

    const PIN_GAP = 28;
    const anchor = logEl.querySelector<HTMLElement>(
      "[data-chat-latest='true']",
    );
    const spacer = logEl.querySelector<HTMLElement>(".chat-log-spacer");
    if (!anchor) return;

    const topbar = document.querySelector<HTMLElement>(".topbar");
    const rootRect = scrollRoot.getBoundingClientRect();
    const topbarBottom = topbar?.getBoundingClientRect().bottom ?? 0;
    const ceilingInset = Math.max(0, topbarBottom - rootRect.top) + PIN_GAP;

    if (spacer) {
      const usableH = Math.max(160, rootRect.height - ceilingInset);
      const anchorH = Math.ceil(anchor.getBoundingClientRect().height);
      const needed = Math.max(32, Math.round(usableH - anchorH - 24));
      spacer.style.height = `${needed}px`;
      spacer.style.minHeight = `${needed}px`;
      void spacer.offsetHeight; // reflow antes del scroll
    }

    const rootRect2 = scrollRoot.getBoundingClientRect();
    const anchorOffset =
      anchor.getBoundingClientRect().top -
      rootRect2.top +
      scrollRoot.scrollTop;
    let target = Math.max(0, Math.round(anchorOffset - ceilingInset));
    scrollRoot.scrollTop = target;

    const afterTop = anchor.getBoundingClientRect().top;
    const ceilingY = rootRect2.top + ceilingInset;
    if (afterTop < ceilingY - 1) {
      target = Math.max(0, scrollRoot.scrollTop - Math.ceil(ceilingY - afterTop));
      scrollRoot.scrollTop = target;
    }
    scrollRoot.dataset.chatScrollMax = String(target);

    const clampScroll = () => {
      const maxRaw = Number(scrollRoot.dataset.chatScrollMax || "");
      if (!Number.isFinite(maxRaw)) return;
      if (scrollRoot.scrollTop > maxRaw + 1) {
        scrollRoot.scrollTop = maxRaw;
      }
    };

    const onResize = () => {
      // Resize: un solo re-pin (sin cascada).
      const rect = scrollRoot.getBoundingClientRect();
      const tb = topbar?.getBoundingClientRect().bottom ?? 0;
      const inset = Math.max(0, tb - rect.top) + PIN_GAP;
      if (spacer) {
        const usableH = Math.max(160, rect.height - inset);
        const ah = Math.ceil(anchor.getBoundingClientRect().height);
        spacer.style.height = `${Math.max(32, Math.round(usableH - ah - 24))}px`;
        spacer.style.minHeight = spacer.style.height;
        void spacer.offsetHeight;
      }
      const off =
        anchor.getBoundingClientRect().top -
        scrollRoot.getBoundingClientRect().top +
        scrollRoot.scrollTop;
      const next = Math.max(0, Math.round(off - inset));
      scrollRoot.scrollTop = next;
      scrollRoot.dataset.chatScrollMax = String(next);
    };

    scrollRoot.addEventListener("scroll", clampScroll, { passive: true });
    window.addEventListener("resize", onResize);

    return () => {
      scrollRoot.removeEventListener("scroll", clampScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [
    messages,
    rail,
    showSideViewer,
    activeSideCompanion?.messageId,
    chatComposerBusy,
  ]);

  const toggleDark = () => {
    setDark((current) => {
      const next = !current;
      document.documentElement.classList.toggle("theme-dark", next);
      window.localStorage.setItem("inventario-tema", next ? "oscuro" : "claro");
      return next;
    });
  };

  const upsertChatSession = (
    sessionId: string,
    nextMessages: ChatMessage[],
    side?: { resultItems?: ChatApiItem[]; qr?: ChatQrPayload[] },
  ) => {
    // No persistir chats vacíos (p. ej. "Empezar nueva" sin mensajes).
    if (!nextMessages.length) {
      setChatSessions((prev) => {
        const next = mergeChatSessions(prev).filter((session) => session.id !== sessionId);
        saveChatSessions(next);
        return next;
      });
      return;
    }
    setChatSessions((prev) => {
      const base = mergeChatSessions(prev);
      const prevSession = base.find((session) => session.id === sessionId);
      const nextSession: ChatSession = {
        id: sessionId,
        title: chatTitleFromMessages(nextMessages),
        updatedAt: new Date().toISOString(),
        messages: nextMessages,
        starred: prevSession?.starred,
        resultItems:
          side && "resultItems" in side
            ? side.resultItems || []
            : prevSession?.resultItems || [],
        qr: side && "qr" in side ? side.qr || [] : prevSession?.qr || [],
      };
      const next = mergeChatSessions(base, nextSession);
      saveChatSessions(next);
      return next;
    });
  };

  // Recupera overview / QR faltantes según lo que pidió el usuario.
  // "etiquetas" nunca se recupera como QR.
  useEffect(() => {
    if (!activeChatId || !messages.length) return;
    let changed = false;
    const clearQrMsgIds: number[] = [];
    let lastSide:
      | {
          resultItems: ChatApiItem[];
          qr: ChatQrPayload[];
          viewerOverview?: ViewerOverview;
          viewerFocus?: string;
        }
      | undefined;
    const nextMessages = messages.map((message, index) => {
      if (message.from !== "bot") return message;
      const prevUser = [...messages.slice(0, index)]
        .reverse()
        .find((item) => item.from === "user");
      const userText = prevUser?.text || "";
      const etiquetaLimit = parseEtiquetaListAsk(userText);

      // Pedido de etiquetas: quitar QR si el bot lo mandó por error.
      if (etiquetaLimit != null && Array.isArray(message.qr) && message.qr.length) {
        const fromQr = message.qr.map((qr) => ({
          id: qr.id ?? null,
          etiqueta: qr.etiqueta ?? null,
          articulo: qr.articulo ?? null,
          persona: qr.persona ?? null,
          area: qr.area ?? null,
          origen: qr.origen ?? null,
          marca: null,
          modelo: null,
          serie: null,
          cantidad: null,
          estado: null,
          observaciones: null,
        }));
        const base =
          Array.isArray(message.resultItems) && message.resultItems.length
            ? message.resultItems
            : fromQr;
        const resultItems = base.slice(0, etiquetaLimit);
        changed = true;
        clearQrMsgIds.push(message.id);
        lastSide = { resultItems, qr: [] };
        return {
          ...message,
          resultItems,
          qr: undefined,
          viewerOverview: undefined,
          viewerFocus: undefined,
        };
      }

      // Resumen / inventario general: solo tras la respuesta real (no en "Consultando…").
      const botPending = /^consultando el inventario/i.test(
        String(message.text || "").trim(),
      );
      // Acuses / exploración: no forzar incidencia (salvo tip ya guardado).
      if (
        !hasConcreteInventoryAsk(userText, items, messages) &&
        isExploratoryChatAsk(userText)
      ) {
        // No recuperar QR/items basura; deja overview solo si ya venía de tip.
        if (
          (Array.isArray(message.qr) && message.qr.length) ||
          (Array.isArray(message.resultItems) &&
            message.resultItems.length > 0 &&
            !message.viewerOverview)
        ) {
          changed = true;
          clearQrMsgIds.push(message.id);
          lastSide = {
            resultItems: [],
            qr: [],
            viewerOverview: message.viewerOverview,
            viewerFocus: message.viewerFocus,
          };
          return {
            ...message,
            resultItems: undefined,
            qr: undefined,
          };
        }
        return message;
      }

      if (
        !botPending &&
        !message.viewerOverview &&
        !(Array.isArray(message.qr) && message.qr.length) &&
        !(Array.isArray(message.resultItems) && message.resultItems.length) &&
        etiquetaLimit == null &&
        shouldAttachSidePanel(userText, items, messages)
      ) {
        const overview = detectViewerOverview(userText);
        if (overview) {
          changed = true;
          lastSide = {
            resultItems: [],
            qr: [],
            viewerOverview: overview,
            viewerFocus: undefined,
          };
          return {
            ...message,
            resultItems: [],
            qr: undefined,
            viewerOverview: overview,
            viewerFocus: undefined,
          };
        }
      }

      if (etiquetaLimit != null) return message;
      if (!items.length) return message;
      if (!isQrBotMessage(message)) return message;
      if (Array.isArray(message.qr) && message.qr.length > 0) return message;
      if (message.viewerOverview) return message;
      if (!userAskedQr(userText)) return message;
      const rows = resolveQrRowsFromPrompt(userText, message.text || "", items);
      if (!rows.length) return message;
      const side = buildQrSideFromRows(rows);
      if (!side.qr.length) return message;
      changed = true;
      lastSide = side;
      return { ...message, resultItems: side.resultItems, qr: side.qr };
    });
    if (!changed) return;
    if (clearQrMsgIds.length) {
      setChatQrByMsg((prev) => {
        let touched = false;
        const next = { ...prev };
        for (const id of clearQrMsgIds) {
          if (id in next) {
            delete next[id];
            touched = true;
          }
        }
        return touched ? next : prev;
      });
    }
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    upsertChatSession(activeChatId, nextMessages, lastSide);
  }, [activeChatId, messages, items]);

  useEffect(() => {
    if (!attachMenuOpen) return;
    const onPointer = (event: globalThis.MouseEvent) => {
      if (!chatAttachRef.current?.contains(event.target as Node)) {
        setAttachMenuOpen(false);
      }
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setAttachMenuOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [attachMenuOpen]);

  const isSpreadsheetName = (name: string) =>
    /\.(xlsx|xls|csv|txt)$/i.test(name);

  const isAffirmativeChat = (value: string) =>
    /^(sí|si|yes|confirma|confirmo|adelante|ok|okay|okey|vale|dale|claro|listo|de acuerdo|hazlo|procede|proceder)\b/i.test(
      value.trim(),
    );

  /** “sí”, “importar”, “importalos”, “cárgalos”, etc. → sigue el import del chat. */
  const isChatImportConfirm = (value: string) => {
    const t = value.trim();
    if (!t) return false;
    if (isAffirmativeChat(t)) return true;
    return /^(importa(?:r|los|las|me|lo|la|nos)?|carga(?:r|los|las|lo|la)?|sube(?:r|los|las|lo|la)?|súbe(?:los|las|lo|la)?)\b/i.test(
      t,
    );
  };

  const asksChatFileImport = (value: string) =>
    /\b(importar|subir|cargar|pasa(?:rme)?|adjunt(?:ar|a)?)\b[\s\S]{0,40}\b(excel|csv|archivo|xlsx|xls)\b|\b(excel|csv|xlsx|xls)\b[\s\S]{0,40}\b(importar|subir|cargar|pasar|adjunt)/i.test(
      value.trim(),
    );

  const CHAT_IMPORT_CHUNK = 100;

  const setPendingChatImportSafe = (items: NewInventarioItem[] | null) => {
    pendingChatImportRef.current = items;
    setPendingChatImport(items);
  };

  const setPendingFieldRevertSafe = (change: ChatFieldChange | null) => {
    pendingFieldRevertRef.current = change;
    setPendingFieldRevert(change);
  };

  const setPendingBulkTransferSafe = (transfer: PendingBulkTransfer | null) => {
    pendingBulkTransferRef.current = transfer;
    setPendingBulkTransfer(transfer);
  };

  const confirmChatDeleteRecord = async () => {
    const target = pendingChatDeleteRow;
    if (!target?.id || chatDeleteBusy) return;
    setChatDeleteBusy(true);
    try {
      const result = await deleteInventarioAction(Number(target.id));
      if (!result.success) {
        setChatDeleteBusy(false);
        setPendingChatDeleteRow(null);
        const sessionId = activeChatIdRef.current;
        if (sessionId) {
          const botId = chatId.current++;
          const fail =
            result.error || "No se pudo eliminar el registro.";
          const next = [
            ...messagesRef.current,
            {
              id: botId,
              from: "bot" as const,
              text: fail,
              at: Date.now(),
            },
          ];
          messagesRef.current = next;
          setMessages(next);
          upsertChatSession(sessionId, next);
        }
        return;
      }
      const totalBefore = items.length;
      setItems((prev) => prev.filter((row) => Number(row.id) !== Number(target.id)));
      if (selectedProduct?.id != null && Number(selectedProduct.id) === Number(target.id)) {
        setSelectedProduct(null);
      }
      rememberMutation({
        kind: "delete",
        summary: `Eliminé etiqueta ${target.etiqueta || target.id}`,
        totalBefore,
        totalAfter: Math.max(0, totalBefore - 1),
        count: 1,
        ids: [Number(target.id)],
        chatId: activeChatIdRef.current,
        fact: `Eliminado: ${target.etiqueta || target.id} (${target.articulo || "sin artículo"})`,
      });
      const label =
        String(target.etiqueta ?? "").trim() || `ID ${target.id}`;
      const ok =
        `Listo: eliminé **${label}**${
          target.articulo ? ` — ${target.articulo}` : ""
        } del inventario.`;
      const sessionId = activeChatIdRef.current;
      if (sessionId) {
        const botId = chatId.current++;
        const next = [
          ...messagesRef.current,
          {
            id: botId,
            from: "bot" as const,
            text: ok,
            at: Date.now(),
            resultItems: [],
            qr: [],
          },
        ];
        messagesRef.current = next;
        setMessages(next);
        upsertChatSession(sessionId, next);
      }
    } finally {
      setChatDeleteBusy(false);
      setPendingChatDeleteRow(null);
    }
  };

  const finishBotReply = (
    sessionId: string,
    botId: number,
    reply: string,
    side?: {
      resultItems?: ChatApiItem[];
      qr?: ChatQrPayload[];
      viewerOverview?: ViewerOverview;
      viewerFocus?: string;
      exportFiles?: ChatExportFile[];
    },
  ) => {
    const finalMessages = messagesRef.current.map((m) =>
      m.id === botId
        ? {
            ...m,
            text: reply,
            at: Date.now(),
            importProgress: undefined,
            ...(side
              ? {
                  resultItems: side.resultItems || [],
                  qr: side.qr || [],
                  viewerOverview: side.viewerOverview,
                  viewerFocus: side.viewerFocus,
                  exportFiles: side.exportFiles || [],
                }
              : null),
          }
        : m,
    );
    messagesRef.current = finalMessages;
    setMessages(finalMessages);
    if (
      side &&
      ((side.resultItems && side.resultItems.length) ||
        (side.qr && side.qr.length) ||
        side.viewerOverview)
    ) {
      lastConcreteSideRef.current = {
        resultItems: side.resultItems || [],
        qr: side.qr || [],
        viewerOverview: side.viewerOverview,
        viewerFocus: side.viewerFocus,
      };
    }
    upsertChatSession(sessionId, finalMessages, side);
  };

  const submitUserEdit = (messageId: number, nextText: string) => {
    const text = nextText.trim();
    if (!text) return;
    const idx = messagesRef.current.findIndex((message) => message.id === messageId);
    if (idx < 0) return;
    const removedIds = new Set(
      messagesRef.current.slice(idx).map((message) => message.id),
    );
    const kept = messagesRef.current.slice(0, idx);
    messagesRef.current = kept;
    setMessages(kept);
    setChatQrByMsg((prev) => {
      const next: Record<number, ChatQrCard[]> = {};
      for (const [key, cards] of Object.entries(prev)) {
        const id = Number(key);
        if (!removedIds.has(id)) next[id] = cards;
      }
      return next;
    });
    setEditingUserMsgId(null);
    setEditDraft("");
    const sessionId = activeChatIdRef.current;
    if (sessionId) upsertChatSession(sessionId, kept);
    void sendChat(text);
  };

  const sendChat = async (
    value: string,
    attachOverride?: {
      kind: "image" | "file";
      name: string;
      file?: File;
    } | null,
  ) => {
    const text = value.trim();
    const attach =
      attachOverride !== undefined ? attachOverride : pendingAttach;
    if (!text && !attach) return;
    const userId = chatId.current++;
    const botId = chatId.current++;
    setDraft("");
    setPendingAttach(null);
    const now = Date.now();
    let sessionId = activeChatIdRef.current;
    if (!sessionId) {
      sessionId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `chat-${Date.now()}`;
      activeChatIdRef.current = sessionId;
      saveActiveChatId(sessionId);
      setActiveChatId(sessionId);
    } else {
      saveActiveChatId(sessionId);
    }

    const attachNote = attach
      ? attach.kind === "image"
        ? `[Imagen: ${attach.name}]`
        : `[Archivo: ${attach.name}]`
      : "";
    const userText = [attachNote, text].filter(Boolean).join("\n");

    // Si ya había una respuesta en curso: cancelar y quitar el “escribiendo…”.
    // Los mensajes del usuario se conservan; el modelo responde a ambos.
    chatAbortRef.current?.abort();
    const controller = new AbortController();
    chatAbortRef.current = controller;
    const requestGen = ++chatRequestGenRef.current;

    const isTypingBot = (m: ChatMessage) =>
      m.from === "bot" &&
      /^consultando el inventario/i.test(String(m.text || "").trim());

    const cleaned = messagesRef.current.filter((m) => !isTypingBot(m));
    const removedTypingIds = messagesRef.current
      .filter(isTypingBot)
      .map((m) => m.id);
    if (removedTypingIds.length) {
      setChatQrByMsg((prev) => {
        let touched = false;
        const next = { ...prev };
        for (const id of removedTypingIds) {
          if (id in next) {
            delete next[id];
            touched = true;
          }
        }
        return touched ? next : prev;
      });
    }

    const currentHistory = cleaned
      .filter((m) => m.text.trim() && !isTypingBot(m))
      .slice(-8)
      .map((m) => ({
        role: (m.from === "user" ? "user" : "assistant") as "user" | "assistant",
        content:
          m.text.length > 500 ? `${m.text.slice(0, 499)}…` : m.text,
      }));
    const crossHistory = buildCrossChatHistorySnippet(
      chatSessions,
      sessionId,
      2,
      2,
    );
    const history = [...crossHistory, ...currentHistory].slice(-10);

    const pendingMessages: ChatMessage[] = [
      ...cleaned,
      { id: userId, from: "user", text: userText, at: now },
      {
        id: botId,
        from: "bot",
        at: now + 1,
        text: "Consultando el inventario…",
      },
    ];
    messagesRef.current = pendingMessages;
    setMessages(pendingMessages);
    upsertChatSession(sessionId, pendingMessages);
    const typingStartedAt = Date.now();
    const ensureTypingPause = async (replyText: string) => {
      const wait =
        assistantTypingDelayMs(replyText) - (Date.now() - typingStartedAt);
      if (wait > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(resolve, wait);
          const onAbort = () => {
            window.clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (controller.signal.aborted) {
            onAbort();
            return;
          }
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (
        requestGen !== chatRequestGenRef.current ||
        controller.signal.aborted
      ) {
        throw new DOMException("Aborted", "AbortError");
      }
    };

    const runBulkChatImport = async (
      rows: NewInventarioItem[],
      sourceLabel: string,
    ) => {
      setPendingChatImportSafe(null);
      const saved: InventarioRow[] = [];
      let lastError = "";
      const total = rows.length;
      for (let i = 0; i < rows.length; i += CHAT_IMPORT_CHUNK) {
        if (
          requestGen !== chatRequestGenRef.current ||
          controller.signal.aborted
        ) {
          throw new DOMException("Aborted", "AbortError");
        }
        const chunk = rows.slice(i, i + CHAT_IMPORT_CHUNK);
        const done = Math.min(i + chunk.length, total);
        const progressing = messagesRef.current.map((m) =>
          m.id === botId
            ? {
                ...m,
                text: `Importando “${sourceLabel}”… ${done}/${total}`,
                at: Date.now(),
                importProgress: { label: sourceLabel, done, total },
              }
            : m,
        );
        messagesRef.current = progressing;
        setMessages(progressing);

        const result = await addInventarioBulkAction(chunk);
        if (result.success && result.data?.length) {
          saved.push(...result.data);
        } else if (result.error) {
          lastError = result.error;
          if (!saved.length) break;
        }
      }

      if (!saved.length) {
        const failText = lastError || "No se pudo importar el archivo.";
        await ensureTypingPause(failText);
        finishBotReply(sessionId, botId, failText);
        return;
      }

      const totalBefore = items.length;
      const stamp = new Date().toISOString();
      setItems((prev) => [
        ...saved.map((row) => ({ ...row, updated_at: stamp })),
        ...prev,
      ]);
      const totalAfter = totalBefore + saved.length;
      rememberMutation({
        kind: "import",
        summary: `Importé ${saved.length} artículo${saved.length === 1 ? "" : "s"} desde “${sourceLabel}”`,
        totalBefore,
        totalAfter,
        count: saved.length,
        ids: saved.map((row) => row.id).filter((id): id is number => id != null),
        chatId: sessionId,
        fact: `Import “${sourceLabel}”: +${saved.length} (antes ${totalBefore} → ahora ${totalAfter})`,
      });
      const skipped = total - saved.length;
      const skipNote =
        skipped > 0
          ? `\n${skipped} fila${skipped === 1 ? "" : "s"} no se importaron (duplicados u error).`
          : "";
      const dest = String(rows[0]?.origen ?? "").trim();
      const destNote = dest ? ` en **${dest}**` : "";
      const finalReply =
        `Listo: importé **${formatNumber(saved.length)}** artículo${saved.length === 1 ? "" : "s"} desde “${sourceLabel}”${destNote}.\n` +
        `Inventario: **${formatNumber(totalBefore)}** → **${formatNumber(totalAfter)}** registros.${skipNote}`;

      // Efecto “escribiendo…” al cerrar (el import largo ya gastó la pausa inicial).
      const wrapping = messagesRef.current.map((m) =>
        m.id === botId
          ? { ...m, text: "Consultando el inventario…", at: Date.now() }
          : m,
      );
      messagesRef.current = wrapping;
      setMessages(wrapping);
      await new Promise<void>((resolve, reject) => {
        const wait = assistantTypingDelayMs(finalReply);
        const timer = window.setTimeout(resolve, wait);
        const onAbort = () => {
          window.clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (controller.signal.aborted) {
          onAbort();
          return;
        }
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      if (
        requestGen !== chatRequestGenRef.current ||
        controller.signal.aborted
      ) {
        throw new DOMException("Aborted", "AbortError");
      }

      finishBotReply(sessionId, botId, finalReply);
    };

    // Confirmar / cancelar traspaso masivo pendiente
    {
      const pendingTransfer =
        pendingBulkTransferRef.current || pendingBulkTransfer;
      if (pendingTransfer) {
        if (isNegativeChat(text)) {
          setPendingBulkTransferSafe(null);
          const cancelReply = "Listo, cancelé el traspaso. No toqué ningún registro.";
          try {
            await ensureTypingPause(cancelReply);
            finishBotReply(sessionId, botId, cancelReply);
          } catch {
            /* abort */
          }
          return;
        }
        if (isAffirmativeChat(text)) {
          try {
            const patch: Partial<NewInventarioItem> =
              pendingTransfer.field === "persona"
                ? { persona: pendingTransfer.toValue }
                : { area: pendingTransfer.toValue };
            const result = await updateInventarioManyAction(
              pendingTransfer.ids,
              patch,
            );
            setPendingBulkTransferSafe(null);
            if (!result.success || !result.data?.length) {
              finishBotReply(
                sessionId,
                botId,
                result.error || "No se pudo aplicar el traspaso masivo.",
              );
              return;
            }
            const updated = result.data;
            const byId = new Map(
              updated.map((row) => [Number(row.id), row] as const),
            );
            const stamp = new Date().toISOString();
            setItems((prev) =>
              prev.map((row) => {
                const next = byId.get(Number(row.id));
                return next ? { ...row, ...next, updated_at: stamp } : row;
              }),
            );
            const total = items.length;
            rememberMutation({
              kind: "update",
              summary: `Traspaso ${pendingTransfer.field}: ${pendingTransfer.fromLabel} → ${pendingTransfer.toValue}`,
              totalBefore: total,
              totalAfter: total,
              count: updated.length,
              ids: updated
                .map((row) => Number(row.id))
                .filter((id) => Number.isFinite(id)),
              chatId: sessionId,
              fact: `Traspaso ${pendingTransfer.field} ${pendingTransfer.fromLabel} → ${pendingTransfer.toValue} (${updated.length})`,
            });
            const finalReply = buildBulkTransferDoneReply({
              field: pendingTransfer.field,
              fromLabel: pendingTransfer.fromLabel,
              toValue: pendingTransfer.toValue,
              count: updated.length,
            });
            await ensureTypingPause(finalReply);
            finishBotReply(sessionId, botId, finalReply, {
              resultItems: updated.map((row) => rowToChatApiItem(row)),
              qr: [],
              viewerOverview:
                pendingTransfer.field === "persona"
                  ? "personTotal"
                  : "areaTotal",
              viewerFocus: pendingTransfer.toValue,
            });
          } catch (err: unknown) {
            if (err instanceof DOMException && err.name === "AbortError") return;
            setPendingBulkTransferSafe(null);
            finishBotReply(
              sessionId,
              botId,
              err instanceof Error
                ? err.message
                : "Error al aplicar el traspaso masivo.",
            );
          }
          return;
        }
      }
    }

    // Confirmar restauración del valor anterior de un campo
    const pendingRevert =
      pendingFieldRevertRef.current || pendingFieldRevert;
    if (pendingRevert && isAffirmativeChat(text)) {
      try {
        let targetId = pendingRevert.id != null ? Number(pendingRevert.id) : null;
        if (targetId == null && pendingRevert.etiqueta) {
          const row = items.find(
            (item) =>
              String(item.etiqueta ?? "")
                .trim()
                .toLowerCase() ===
              String(pendingRevert.etiqueta)
                .trim()
                .toLowerCase(),
          );
          targetId = row?.id != null ? Number(row.id) : null;
        }
        if (targetId == null) {
          setPendingFieldRevertSafe(null);
          finishBotReply(
            sessionId,
            botId,
            "No pude ubicar el registro para restaurar el valor. Dime la etiqueta exacta.",
          );
          return;
        }
        const patch: Partial<NewInventarioItem> = {
          [pendingRevert.field]: pendingRevert.oldValue,
        } as Partial<NewInventarioItem>;
        const result = await updateInventarioAction(targetId, patch);
        setPendingFieldRevertSafe(null);
        if (!result.success || !result.data) {
          finishBotReply(
            sessionId,
            botId,
            result.error || "No se pudo restaurar el valor anterior.",
          );
          return;
        }
        const stamp = new Date().toISOString();
        setItems((prev) =>
          prev.map((row) =>
            Number(row.id) === targetId
              ? { ...row, ...result.data!, updated_at: stamp }
              : row,
          ),
        );
        rememberFieldChange({
          id: result.data.id,
          etiqueta: result.data.etiqueta,
          articulo: result.data.articulo,
          field: pendingRevert.field,
          oldValue: pendingRevert.newValue,
          newValue: pendingRevert.oldValue,
          chatId: sessionId,
        });
        const label =
          result.data.etiqueta || String(result.data.id ?? targetId);
        const finalReply =
          `Listo: restauré **${pendingRevert.field}** de “**${pendingRevert.newValue}**” a “**${pendingRevert.oldValue}**” en **${label}**.`;
        await ensureTypingPause(finalReply);
        finishBotReply(sessionId, botId, finalReply, {
          resultItems: [rowToChatApiItem(result.data)],
          qr: [],
        });
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setPendingFieldRevertSafe(null);
        finishBotReply(
          sessionId,
          botId,
          err instanceof Error ? err.message : "Error al restaurar el valor.",
        );
      }
      return;
    }

    // Eliminar registro → aviso modal (mismo estilo que borrar chat)
    if (looksLikeDeleteRecordAsk(userText || text)) {
      try {
        let target =
          resolveRecordRowsFromPrompt(userText || text, "", items, 1)[0] ||
          resolveContextualRecordRows(
            items,
            messagesRef.current.map((m) => ({
              from: m.from,
              text: m.text || "",
            })),
            1,
          )[0] ||
          null;
        if (!target) {
          const ask =
            "Claro. Para eliminar necesito la **etiqueta** (o el id) del registro.\n\n" +
            "Ejemplo: `elimina la etiqueta 310285`.\n\n" +
            "Siempre te pediré confirmación antes de borrarlo.";
          await ensureTypingPause(ask);
          finishBotReply(sessionId, botId, ask);
          return;
        }
        setPendingChatDeleteRow(target);
        const label =
          String(target.etiqueta ?? "").trim() ||
          (target.id != null ? `ID ${target.id}` : "el registro");
        const art = String(target.articulo ?? "").trim();
        const replyText =
          `Voy a eliminar **${label}**${art ? ` — ${art}` : ""}.\n\n` +
          `Confirma en el aviso: **Borrar** para continuar o **Cancelar** para dejarlo.`;
        await ensureTypingPause(replyText);
        finishBotReply(sessionId, botId, replyText, {
          resultItems: [rowToChatApiItem(target)],
          qr: [],
        });
      } catch {
        /* abort */
      }
      return;
    }

    // Pedir restaurar el nombre/valor de antes → propuesta con memoria
    if (looksLikeRevertPreviousValue(text)) {
      const mem = ensureLastFieldChangeFromMessages(
        messagesRef.current.map((m) => ({
          from: m.from,
          text: m.text || "",
        })),
      );
      const proposal = buildRevertProposalReply(mem);
      if (mem.lastFieldChange) {
        setPendingFieldRevertSafe(mem.lastFieldChange);
      }
      try {
        await ensureTypingPause(proposal || "");
        finishBotReply(sessionId, botId, proposal || "No tengo ese cambio en memoria.");
      } catch {
        /* abort */
      }
      return;
    }

    // Confirmar importación Excel/CSV pendiente
    const pendingRows = pendingChatImportRef.current?.length
      ? pendingChatImportRef.current
      : pendingChatImport;
    // Pendiente + destino explícito (“importar a Inventario 1” / “a S/O”).
    if (pendingRows?.length) {
      const existingOrigens = [
        ...new Set(
          items.map((row) => String(row.origen ?? "").trim()).filter(Boolean),
        ),
      ];
      const forceOrigen = matchOrigenFromPrompt(
        text || userText,
        existingOrigens,
      );
      const forcesDest =
        Boolean(forceOrigen) &&
        /\b(importa(?:r|los|las)?|pasa|poner|pon|deja|dejar|a|en)\b/i.test(
          text || userText,
        ) &&
        !isChatImportConfirm(text);
      if (forcesDest && forceOrigen) {
        const remapped = pendingRows.map((row) => ({
          ...row,
          origen: forceOrigen,
        }));
        setPendingChatImportSafe(remapped);
        finishBotReply(
          sessionId,
          botId,
          `Listo: reasigné los **${formatNumber(remapped.length)}** registros pendientes a **${forceOrigen}**.\n\n` +
            `¿Confirmas la importación? Responde **sí** o **importalos**.`,
        );
        return;
      }
    }
    if (pendingRows?.length && isChatImportConfirm(text)) {
      try {
        await runBulkChatImport(pendingRows, "archivo pendiente");
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setPendingChatImportSafe(null);
        finishBotReply(
          sessionId,
          botId,
          err instanceof Error ? err.message : "Error al importar el archivo.",
        );
      }
      return;
    }

    // Adjuntar Excel/CSV → parsear; importar ya o pedir confirmación
    if (attach?.file && isSpreadsheetName(attach.name)) {
      try {
        const existingOrigens = [
          ...new Set(
            items.map((row) => String(row.origen ?? "").trim()).filter(Boolean),
          ),
        ];
        const parsed = await parseInventarioImportFile(
          attach.file,
          ORIGEN_SIN_ORIGEN,
        );
        if (!parsed.items.length) {
          setPendingChatImportSafe(null);
          finishBotReply(
            sessionId,
            botId,
            "No encontré filas válidas en el archivo (faltan Etiqueta o Artículo).",
          );
          return;
        }

        const plan = planImportOrigen({
          promptText: text || userText,
          fileName: attach.name,
          sheetName: parsed.sheetName,
          columnOrigens: parsed.hasOrigenColumn
            ? parsed.columnOrigens
            : undefined,
          selectedFilter:
            selectedInventarios[0] && selectedInventarios[0] !== "ALL"
              ? selectedInventarios[0]
              : null,
          existing: existingOrigens,
        });

        const nBase = parsed.items.length;
        const rawValid = parsed.rawValid || nBase;
        const dups = parsed.skippedDupEtiqueta || 0;
        const sheetNote = parsed.sheetName
          ? ` (hoja “${parsed.sheetName}”)`
          : "";
        const dupNote =
          dups > 0
            ? `\nVi **${formatNumber(rawValid)}** filas con etiqueta y artículo; **${formatNumber(dups)}** etiqueta${dups === 1 ? "" : "s"} repetida${dups === 1 ? "" : "s"} → **${formatNumber(nBase)}** únicos.`
            : `\nEncontré **${formatNumber(nBase)}** registro${nBase === 1 ? "" : "s"} con etiqueta y artículo.`;

        // Orígenes mezclados en columna → pendiente, sin forzar un solo destino.
        if (plan.kind === "mixed") {
          const mixedItems = parsed.items.map((item) => {
            const fromCol = normalizeOrigenLabel(
              String(item.origen ?? ""),
              existingOrigens,
            );
            return {
              ...item,
              origen: fromCol || ORIGEN_SIN_ORIGEN,
            };
          });
          setPendingChatImportSafe(mixedItems);
          const mixLines = plan.counts
            .slice(0, 8)
            .map(
              (c) =>
                `• **${c.origen}:** ${formatNumber(c.count)} registro${c.count === 1 ? "" : "s"}`,
            )
            .join("\n");
          const sample = mixedItems
            .slice(0, 5)
            .map(
              (item) =>
                `• ${item.etiqueta} — ${item.articulo} (${item.origen})`,
            )
            .join("\n");
          const more =
            nBase > 5 ? `\n…y ${formatNumber(nBase - 5)} más.` : "";
          finishBotReply(
            sessionId,
            botId,
            buildChatImportMixedReply({
              fileName: attach.name,
              sheetName: parsed.sheetName,
              mixLines,
              dupNote,
              sample,
              more,
            }),
          );
          return;
        }

        const origen = plan.origen;
        const wantsNew =
          /\b(crear|nuevo|nueva|abre|abrir)\b/i.test(text || userText) &&
          /\b(inventario)\b/i.test(text || userText);
        if (
          wantsNew &&
          plan.alreadyExists &&
          origen !== ORIGEN_SIN_ORIGEN
        ) {
          setPendingChatImportSafe(null);
          finishBotReply(
            sessionId,
            botId,
            pickOne([
              `**${origen}** ya existe. No creo otro igual.\n\nSi quieres cargar “${attach.name}” ahí, escribe «importar a ${origen}».`,
              `Ese inventario (**${origen}**) ya está en la app.\n\nPuedo importar “${attach.name}” sobre ese origen si me dices «importar a ${origen}», o elige otro nombre nuevo.`,
              `No duplico **${origen}**: ya lo tienes.\n\n¿Lo importamos a ese mismo? Dime «importar a ${origen}».`,
            ]),
          );
          return;
        }

        const itemsForImport = parsed.items.map((item) => ({
          ...item,
          origen,
        }));
        setPendingChatImportSafe(itemsForImport);
        const sample = itemsForImport
          .slice(0, 5)
          .map((item) => `• ${item.etiqueta} — ${item.articulo}`)
          .join("\n");
        const more =
          nBase > 5 ? `\n…y ${formatNumber(nBase - 5)} más.` : "";
        finishBotReply(
          sessionId,
          botId,
          buildChatImportPreviewReply({
            fileName: attach.name,
            sheetName: parsed.sheetName,
            origen,
            source: plan.source,
            count: nBase,
            rawValid,
            dups,
            sample,
            more,
          }),
        );
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setPendingChatImportSafe(null);
        finishBotReply(
          sessionId,
          botId,
          err instanceof Error
            ? err.message
            : "No pude leer el Excel/CSV. Usa .xlsx, .xls o .csv.",
        );
      }
      return;
    }

    // Pedir Excel/CSV sin adjunto → guía del clip en este chat
    if (!attach && asksChatFileImport(userText || text)) {
      finishBotReply(
        sessionId,
        botId,
        "Para subir el Excel o CSV aquí en el chat: pulsa + → «Excel / CSV» (o arrástralo al cuadro). El archivo se queda adjunto; cuando quieras, pulsa enviar. Luego te muestro la vista previa y pido confirmación antes de cargar todas las filas.",
      );
      return;
    }

    let reply = "Sin respuesta del asistente.";
    let sideItems: ChatApiItem[] = [];
    let mutated = false;
    let qrPayloads: ChatQrPayload[] = [];

    // Memoria compartida: “cuántos había antes”, continuidad entre chats.
    const memoryBeforeReply = answerFromMemoryAboutBefore(userText || text);
    if (memoryBeforeReply) {
      try {
        await ensureTypingPause(memoryBeforeReply);
        finishBotReply(sessionId, botId, memoryBeforeReply);
      } catch {
        /* abort / nuevo mensaje */
      }
      return;
    }

    const chatHistory = messagesRef.current.map((message) => ({
      from: message.from,
      text: message.text || "",
      resultItems: message.resultItems,
      viewerFocus: message.viewerFocus,
      viewerOverview: message.viewerOverview,
    }));

    // 1. Resolver desambiguación pendiente (en memoria o reconstruida del último mensaje del bot)
    let activePending = pendingDisambiguationRef.current;
    if (!activePending && cleaned.length) {
      const lastBotIdx = [...cleaned]
        .map((m, idx) => ({ m, idx }))
        .reverse()
        .find((entry) => entry.m.from === "bot");
      if (
        lastBotIdx &&
        (lastBotIdx.m.viewerOverview === "areaMatches" ||
          lastBotIdx.m.viewerOverview === "personMatches")
      ) {
        const parsed = parseMatchesFocusFromMessage(lastBotIdx.m.viewerFocus);
        if (parsed) {
          const prevUserBeforeBot = [...cleaned.slice(0, lastBotIdx.idx)]
            .reverse()
            .find((m) => m.from === "user");
          const prevLimit = prevUserBeforeBot
            ? parseRequestedCount(prevUserBeforeBot.text)
            : null;
          activePending = {
            kind:
              lastBotIdx.m.viewerOverview === "areaMatches"
                ? "area"
                : "person",
            queryLabel: parsed.label,
            candidates: parsed.candidates,
            intent: "list",
            limit:
              prevLimit != null
                ? Math.max(1, Math.min(MAX_ETIQUETA_LIST, prevLimit))
                : null,
          };
        }
      }
    }

    if (activePending) {
      const resolved = resolvePendingDisambiguation(
        userText || text,
        activePending,
        items,
      );
      if (resolved.status === "resolved_area") {
        pendingDisambiguationRef.current = null;
        try {
          const { reply: localReply, shownRows } = buildExactAreaReply(
            resolved.area,
            resolved.limit,
          );
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: shownRows.map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: "areaTotal",
            viewerFocus: resolved.area.name,
          });
        } catch {
          /* abort / nuevo mensaje */
        }
        return;
      }
      if (resolved.status === "resolved_person") {
        pendingDisambiguationRef.current = null;
        try {
          const { reply: localReply, shownRows } = buildExactPersonReply(
            resolved.person,
            resolved.limit,
          );
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: shownRows.map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: "personTotal",
            viewerFocus: resolved.person.name,
          });
        } catch {
          /* abort / nuevo mensaje */
        }
        return;
      }
      if (resolved.status === "narrowed_area") {
        const candidateNames = resolved.candidates.map((c) => c.name);
        pendingDisambiguationRef.current = {
          kind: "area",
          queryLabel: resolved.queryLabel,
          candidates: candidateNames,
          intent: resolved.intent,
          limit: resolved.limit,
        };
        try {
          const localReply = buildAreaDisambiguationReply(
            resolved.queryLabel,
            resolved.candidates,
            resolved.intent,
            resolved.limit,
          );
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: [],
            qr: [],
            viewerOverview: "areaMatches",
            viewerFocus: encodeMatchesFocus(
              resolved.queryLabel,
              candidateNames,
            ),
          });
        } catch {
          /* abort / nuevo mensaje */
        }
        return;
      }
      if (resolved.status === "narrowed_person") {
        const candidateNames = resolved.candidates.map((c) => c.name);
        pendingDisambiguationRef.current = {
          kind: "person",
          queryLabel: resolved.queryLabel,
          candidates: candidateNames,
          intent: "list",
          limit: resolved.limit,
        };
        try {
          const localReply = buildPersonDisambiguationReply(
            resolved.queryLabel,
            resolved.candidates,
            resolved.limit,
          );
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: [],
            qr: [],
            viewerOverview: "personMatches",
            viewerFocus: encodeMatchesFocus(
              resolved.queryLabel,
              candidateNames,
            ),
          });
        } catch {
          /* abort / nuevo mensaje */
        }
        return;
      }
      // Si el usuario cambió de tema, limpiar la desambiguación pendiente
      pendingDisambiguationRef.current = null;
    }

    // 1b. Personas de un inventario concreto (Inventario 1…) — texto, sin visor.
    {
      const origenPeople = detectOrigenPersonasAsk(userText || text, items);
      if (origenPeople) {
        try {
          const localReply = buildOrigenPersonasReply(origenPeople, items);
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply);
          return;
        } catch {
          /* abort / nuevo mensaje */
        }
      }
    }

    // 1b1. Follow-up con contexto del chat (“el área”, “ahí”, “dame los N registros”).
    {
      const ctxAsk = detectContextFollowUpAsk(
        userText || text,
        items,
        chatHistory,
      );
      if (ctxAsk) {
        try {
          if (ctxAsk.kind === "area" && ctxAsk.intent === "people") {
            const localReply = buildAreaPersonasReply(ctxAsk.area);
            recordTokenConsumption(null, userText || text, localReply);
            await ensureTypingPause(localReply);
            finishBotReply(sessionId, botId, localReply, {
              resultItems: [],
              qr: [],
              viewerOverview: "areaTotal",
              viewerFocus: ctxAsk.area.name,
            });
            return;
          }
          if (ctxAsk.kind === "area") {
            const { reply: localReply, shownRows } = buildExactAreaReply(
              ctxAsk.area,
              ctxAsk.intent === "total" ? null : ctxAsk.limit,
            );
            recordTokenConsumption(null, userText || text, localReply);
            await ensureTypingPause(localReply);
            finishBotReply(sessionId, botId, localReply, {
              resultItems: shownRows.map((row) => rowToChatApiItem(row)),
              qr: [],
              viewerOverview: "areaTotal",
              viewerFocus: ctxAsk.area.name,
            });
            return;
          }
          if (ctxAsk.kind === "person") {
            const { reply: localReply, shownRows } = buildExactPersonReply(
              ctxAsk.person,
              ctxAsk.intent === "total" ? null : ctxAsk.limit,
            );
            recordTokenConsumption(null, userText || text, localReply);
            await ensureTypingPause(localReply);
            finishBotReply(sessionId, botId, localReply, {
              resultItems: shownRows.map((row) => rowToChatApiItem(row)),
              qr: [],
              viewerOverview: "personTotal",
              viewerFocus: ctxAsk.person.name,
            });
            return;
          }
        } catch {
          /* abort / nuevo mensaje */
        }
      }
    }

    // 1b2. Personas de un área (typos + “ahí” / foco previo).
    {
      const recentFocus =
        lastBotViewerFocus(messagesRef.current) ||
        lastConcreteSideRef.current?.viewerFocus ||
        null;
      const areaPeople = detectAreaPersonasAsk(
        userText || text,
        items,
        recentFocus,
      );
      if (areaPeople) {
        if (areaPeople.status === "ask" && areaPeople.candidates?.length) {
          pendingDisambiguationRef.current = {
            kind: "area",
            queryLabel: areaPeople.rawNeedle,
            candidates: areaPeople.candidates.map((c) => c.name),
            intent: "total",
            limit: null,
          };
          try {
            const localReply = buildAreaConfirmAskReply(
              areaPeople.rawNeedle,
              areaPeople.candidates,
            );
            recordTokenConsumption(null, userText || text, localReply);
            await ensureTypingPause(localReply);
            finishBotReply(sessionId, botId, localReply);
            return;
          } catch {
            /* abort */
          }
        }
        if (areaPeople.status === "ok" && areaPeople.area) {
          try {
            const localReply = buildAreaPersonasReply(areaPeople.area);
            recordTokenConsumption(null, userText || text, localReply);
            await ensureTypingPause(localReply);
            finishBotReply(sessionId, botId, localReply, {
              resultItems: [],
              qr: [],
              viewerOverview: "areaTotal",
              viewerFocus: areaPeople.area.name,
            });
            return;
          } catch {
            /* abort */
          }
        }
      }
    }

    // 1c. "Total de solo una área" sin nombre → preguntar (abreviado vale: RH, TI…).
    if (detectUnspecifiedAreaAsk(userText || text, items)) {
      const catalog = getAllAreaCatalog(items);
      pendingDisambiguationRef.current = {
        kind: "area",
        queryLabel: "área",
        candidates: catalog.map((c) => c.name),
        intent: "total",
        limit: null,
      };
      try {
        const localReply = buildUnspecifiedAreaAskReply(items);
        recordTokenConsumption(null, userText || text, localReply);
        await ensureTypingPause(localReply);
        finishBotReply(sessionId, botId, localReply);
        return;
      } catch {
        /* abort / nuevo mensaje */
      }
    }

    // 2. Consulta de área (segura → visor; dudosa/typo → preguntar sin visor)
    const areaQuery = findMatchingAreasForPrompt(userText || text, items);
    if (areaQuery) {
      const candidateNames = areaQuery.candidates.map((c) => c.name);
      // Typo o ambigüedad: no inventar resultado; confirmar primero.
      if (areaQuery.uncertain || areaQuery.candidates.length > 1) {
        pendingDisambiguationRef.current = {
          kind: "area",
          queryLabel: areaQuery.rawNeedle || areaQuery.queryLabel,
          candidates: candidateNames,
          intent: areaQuery.intent,
          limit: areaQuery.limit,
        };
        try {
          const localReply = areaQuery.uncertain
            ? buildAreaConfirmAskReply(
                areaQuery.rawNeedle || areaQuery.queryLabel,
                areaQuery.candidates,
              )
            : buildAreaDisambiguationReply(
                areaQuery.queryLabel,
                areaQuery.candidates,
                areaQuery.intent,
                areaQuery.limit,
              );
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          // Solo abre visor de opciones si hay varias y el match era exacto.
          finishBotReply(
            sessionId,
            botId,
            localReply,
            !areaQuery.uncertain && areaQuery.candidates.length > 1
              ? {
                  resultItems: [],
                  qr: [],
                  viewerOverview: "areaMatches",
                  viewerFocus: encodeMatchesFocus(
                    areaQuery.queryLabel,
                    candidateNames,
                  ),
                }
              : undefined,
          );
        } catch {
          /* abort / nuevo mensaje */
        }
        return;
      }
      if (areaQuery.candidates.length === 1) {
        const singleArea = areaQuery.candidates[0];
        try {
          const { reply: localReply, shownRows } = buildExactAreaReply(
            singleArea,
            areaQuery.limit,
          );
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: shownRows.map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: "areaTotal",
            viewerFocus: singleArea.name,
          });
        } catch {
          /* abort / nuevo mensaje */
        }
        return;
      }
    }

    // 3. Consulta de persona (con desambiguación si existen 2 o más personas que coinciden)
    const personQuery = findMatchingPeopleForPrompt(userText || text, items);
    if (personQuery) {
      if (personQuery.candidates.length > 1) {
        const candidateNames = personQuery.candidates.map((c) => c.name);
        pendingDisambiguationRef.current = {
          kind: "person",
          queryLabel: personQuery.queryLabel,
          candidates: candidateNames,
          intent: personQuery.intent,
          limit: personQuery.limit,
        };
        try {
          const localReply = buildPersonDisambiguationReply(
            personQuery.queryLabel,
            personQuery.candidates,
            personQuery.limit,
          );
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: [],
            qr: [],
            viewerOverview: "personMatches",
            viewerFocus: encodeMatchesFocus(
              personQuery.queryLabel,
              candidateNames,
            ),
          });
        } catch {
          /* abort / nuevo mensaje */
        }
        return;
      }
      if (personQuery.candidates.length === 1) {
        const singlePerson = personQuery.candidates[0];
        try {
          const { reply: localReply, shownRows } = buildExactPersonReply(
            singlePerson,
            personQuery.limit,
          );
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: shownRows.map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: "personTotal",
            viewerFocus: singlePerson.name,
          });
        } catch {
          /* abort / nuevo mensaje */
        }
        return;
      }
    }

    // 4. Anáfora de persona ("su inventario", "dame sus etiquetas")
    const wantsPersonEtiquetas = looksLikePersonEtiquetasAsk(userText || text);
    const earlyPerson = wantsPersonEtiquetas
      ? resolvePersonFocus(userText || text, items, chatHistory)
      : detectPersonTotalAsk(userText || text, items, chatHistory);
    if (earlyPerson) {
      const personCatalog = getAllPersonCatalog(items);
      const exactP =
        personCatalog.find((p) => p.name === earlyPerson) ||
        personCatalog.find((p) =>
          normalizeChatIntent(p.name).includes(
            normalizeChatIntent(earlyPerson),
          ),
        );
      try {
        if (exactP) {
          // Etiquetas de ESA persona: todas sus filas, sin mezclar otras.
          if (wantsPersonEtiquetas) {
            const allRows = exactP.rows;
            const localReply =
              `**${exactP.name}** tiene **${allRows.length.toLocaleString("es-MX")}** etiqueta` +
              `${allRows.length === 1 ? "" : "s"} en total.\n\n` +
              allRows
                .slice(0, 5)
                .map((row) => {
                  const tag = String(row.etiqueta ?? "").trim() || "S/E";
                  const art = String(row.articulo ?? "").trim() || "Artículo";
                  const ar = String(row.area ?? "").trim() || "Sin área";
                  return `• **${tag}** — ${art} (${ar})`;
                })
                .join("\n") +
              (allRows.length > 5
                ? `\n\nEl listado completo de **${allRows.length}** etiquetas está en el visor derecho.`
                : `\n\nEl detalle está en el visor derecho.`);
            recordTokenConsumption(null, userText || text, localReply);
            await ensureTypingPause(localReply);
            finishBotReply(sessionId, botId, localReply, {
              resultItems: allRows.map((row) => rowToChatApiItem(row)),
              qr: [],
              viewerFocus: exactP.name,
            });
            return;
          }
          const { reply: localReply, shownRows } = buildExactPersonReply(
            exactP,
            parseRequestedCount(userText || text),
          );
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: shownRows.map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: "personTotal",
            viewerFocus: exactP.name,
          });
        } else {
          const localReply = buildPersonTotalReply(earlyPerson, items);
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: [],
            qr: [],
            viewerOverview: "personTotal",
            viewerFocus: earlyPerson,
          });
        }
      } catch {
        /* abort / nuevo mensaje */
      }
      return;
    }

    // 5a0-. Traspaso masivo persona/área (propuesta + confirmación).
    {
      const transferAsk = detectBulkTransferAsk(userText || text);
      if (transferAsk) {
        try {
          const toPerson = resolveCanonicalPerson(transferAsk.toRaw, items);
          const toArea = resolveCanonicalArea(transferAsk.toRaw, items);
          let field: BulkTransferField | null = null;
          let toValue = "";

          if (toPerson && toArea) {
            const n = normalizeChatIntent(userText || text);
            if (/\b(area|areas)\b/.test(n)) {
              field = "area";
              toValue = toArea;
            } else {
              field = "persona";
              toValue = toPerson.name;
            }
          } else if (toPerson) {
            field = "persona";
            toValue = toPerson.name;
          } else if (toArea) {
            field = "area";
            toValue = toArea;
          }

          if (!field || !toValue) {
            const ask =
              `No identifiqué el destino “${transferAsk.toRaw}”. ` +
              `Dime la persona o el área exacta (ej. «pasa estos a María» o «mueve todo de Sistemas a Biblioteca»).`;
            recordTokenConsumption(null, userText || text, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }

          let sourceRows: InventarioRow[] = [];
          let fromLabel = "selección";

          if (transferAsk.fromRaw) {
            if (field === "persona") {
              const fromPerson = resolveCanonicalPerson(
                transferAsk.fromRaw,
                items,
              );
              if (fromPerson?.rows.length) {
                sourceRows = fromPerson.rows;
                fromLabel = fromPerson.name;
              }
            } else {
              const fromArea =
                resolveCanonicalArea(transferAsk.fromRaw, items) ||
                transferAsk.fromRaw;
              sourceRows = items.filter((row) =>
                areaMatchesNeedle(String(row.area ?? ""), fromArea),
              );
              fromLabel =
                resolveCanonicalArea(transferAsk.fromRaw, items) ||
                transferAsk.fromRaw;
            }
          }

          if (!sourceRows.length && transferAsk.fromContext) {
            const prevItems =
              lastBotResultItems(messagesRef.current).length > 0
                ? lastBotResultItems(messagesRef.current)
                : lastConcreteSideRef.current?.resultItems || [];
            sourceRows = chatApiItemsToRows(prevItems, items);
            fromLabel =
              lastBotViewerFocus(messagesRef.current) ||
              lastConcreteSideRef.current?.viewerFocus ||
              "listado actual";
          }

          if (!sourceRows.length && transferAsk.fromRaw) {
            // Reintento cruzado: origen persona aunque el destino sea área (o al revés).
            const fromPerson = resolveCanonicalPerson(
              transferAsk.fromRaw,
              items,
            );
            const fromArea = resolveCanonicalArea(transferAsk.fromRaw, items);
            if (fromPerson?.rows.length) {
              sourceRows = fromPerson.rows;
              fromLabel = fromPerson.name;
            } else if (fromArea) {
              sourceRows = items.filter((row) =>
                areaMatchesNeedle(String(row.area ?? ""), fromArea),
              );
              fromLabel = fromArea;
            }
          }

          // Solo filas que realmente cambian.
          sourceRows = sourceRows.filter((row) => {
            const current =
              field === "persona"
                ? String(row.persona ?? "").trim()
                : String(row.area ?? "").trim();
            return normalizePlain(current) !== normalizePlain(toValue);
          });

          const ids = [
            ...new Set(
              sourceRows
                .map((row) => Number(row.id))
                .filter((id) => Number.isFinite(id)),
            ),
          ];

          if (!ids.length) {
            const ask = transferAsk.fromContext
              ? "No hay registros en el listado actual para traspasar (o ya tienen ese destino). Consulta primero una persona/área o dime «mueve todo de X a Y»."
              : `No encontré registros de **${fromLabel}** que deban pasar a **${toValue}**.`;
            recordTokenConsumption(null, userText || text, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }

          const sampleEtiquetas = sourceRows
            .map((row) => String(row.etiqueta ?? "").trim())
            .filter(Boolean)
            .slice(0, 6);

          const pending: PendingBulkTransfer = {
            ids,
            field,
            fromLabel,
            toValue,
            sampleEtiquetas,
          };
          setPendingBulkTransferSafe(pending);
          const localReply = buildBulkTransferConfirmReply({
            field,
            fromLabel,
            toValue,
            count: ids.length,
            sampleEtiquetas,
          });
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply);
          return;
        } catch {
          /* abort / nuevo mensaje */
        }
      }
    }

    // 5a0. Excel/CSV descargable con nombre referente a la consulta.
    {
      const excelAsk = detectExcelExportAsk(userText || text);
      if (excelAsk) {
        try {
          const prevItems =
            lastBotResultItems(messagesRef.current).length > 0
              ? lastBotResultItems(messagesRef.current)
              : lastConcreteSideRef.current?.resultItems || [];
          const prevFocus =
            lastBotViewerFocus(messagesRef.current) ||
            lastConcreteSideRef.current?.viewerFocus ||
            null;
          let sourceRows = chatApiItemsToRows(prevItems, items);
          let focusName = prevFocus;

          // Persona explícita o “esta persona” (usa foco del mensaje anterior).
          {
            const catalog = getAllPersonCatalog(items);
            const named =
              detectPersonTotalAsk(userText || text, items, chatHistory) ||
              findPersonInText(userText || text, items);
            const focusCandidate = named || (excelAsk.fromContext ? prevFocus : null);
            if (focusCandidate) {
              const exact =
                catalog.find((p) => p.name === focusCandidate) ||
                catalog.find((p) =>
                  normalizeChatIntent(p.name).includes(
                    normalizeChatIntent(focusCandidate),
                  ),
                ) ||
                catalog.find((p) =>
                  normalizeChatIntent(focusCandidate).includes(
                    normalizeChatIntent(p.name),
                  ),
                );
              if (exact?.rows?.length) {
                sourceRows = exact.rows;
                focusName = exact.name;
              }
            }
          }

          // Área si aplica.
          if (!sourceRows.length) {
            const areaHit = matchAreaFromPrompt(userText || text, items);
            if (areaHit) {
              sourceRows = items.filter((row) =>
                areaMatchesNeedle(String(row.area ?? ""), areaHit),
              );
              focusName = areaHit;
            }
          }

          // Sin contexto previo: usar inventario filtrado por tema o general.
          if (!sourceRows.length) {
            if (excelAsk.theme) {
              const needle = normalizeChatIntent(excelAsk.theme);
              sourceRows = items.filter((row) =>
                normalizeChatIntent(String(row.area ?? "")).includes(needle),
              );
            }
            if (!sourceRows.length) sourceRows = items.slice(0, 500);
          }

          if (!sourceRows.length) {
            const ask =
              "No hay registros para armar el Excel. Primero consulta una persona/área o dime qué inventario quieres exportar.";
            recordTokenConsumption(null, userText || text, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }

          let files: ChatExportFile[] = [];
          if (excelAsk.count <= 1) {
            files = [
              await buildInventarioExcelFile(sourceRows, {
                focus: focusName || excelAsk.theme || "consulta",
              }),
            ];
          } else {
            const groups = splitRowsForExcelGroups(
              sourceRows,
              excelAsk.count,
              excelAsk.theme,
            );
            // Si el tema es Oficina y no hay focus por persona, forzar nombres Oficina N.
            files = await buildInventarioExcelFiles(
              groups.map((g, idx) => ({
                rows: g.rows,
                focus:
                  g.focus ||
                  (excelAsk.theme
                    ? `Inventario ${excelAsk.theme} ${idx + 1}`
                    : focusName
                      ? `${focusName} ${idx + 1}`
                      : `Inventario ${idx + 1}`),
                index: idx + 1,
              })),
            );
          }

          const localReply = buildExcelExportReply(files);
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          // Solo tarjeta Excel: no abrir/actualizar el visor derecho.
          finishBotReply(sessionId, botId, localReply, {
            exportFiles: files,
          });
          return;
        } catch {
          /* abort / nuevo mensaje */
        }
      }
    }

    // 5a. Seguimiento vago → preguntar acción (no buscar “casi acertado”).
    if (looksLikeVagueFollowUp(userText || text)) {
      const prevItems =
        lastBotResultItems(messagesRef.current).length > 0
          ? lastBotResultItems(messagesRef.current)
          : lastConcreteSideRef.current?.resultItems || [];
      try {
        const ask = buildVagueFollowUpReply(prevItems.length);
        recordTokenConsumption(null, userText || text, ask);
        await ensureTypingPause(ask);
        finishBotReply(sessionId, botId, ask);
        return;
      } catch {
        /* abort / nuevo mensaje */
      }
    }

    // 5a2. Diff real entre inventarios (faltan / sobran / cambiaron).
    {
      const compare = detectCompareInventariosAsk(
        userText || text,
        listExistingOrigens(items),
      );
      if (compare && items.length) {
        try {
          const diff = diffInventarios(items, compare.left, compare.right);
          const localReply = formatInventarioDiffReply(diff);
          const sideRows = [
            ...diff.onlyLeft,
            ...diff.onlyRight,
            ...diff.changed
              .map((c) =>
                items.find(
                  (row) =>
                    Number(row.id) === Number(c.rightId) ||
                    Number(row.id) === Number(c.leftId),
                ),
              )
              .filter(Boolean),
          ] as InventarioRow[];
          const seen = new Set<number | string>();
          const uniqueSide: InventarioRow[] = [];
          for (const row of sideRows) {
            const key = row.id != null ? Number(row.id) : String(row.etiqueta);
            if (seen.has(key)) continue;
            seen.add(key);
            uniqueSide.push(row);
            if (uniqueSide.length >= 50) break;
          }
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: uniqueSide.map((row) => rowToChatApiItem(row)),
            qr: [],
          });
          return;
        } catch {
          /* abort / nuevo mensaje */
        }
      }
    }

    // 5b. Marcas acotadas a un área → listado en visor (no overview global).
    {
      const marcasArea = detectMarcasAreaAsk(userText || text, items);
      if (marcasArea && items.length) {
        const areaRows = items.filter((row) =>
          areaMatchesNeedle(String(row.area ?? ""), marcasArea),
        );
        try {
          if (!areaRows.length) {
            const ask =
              `No encontré registros en **${marcasArea}**. ` +
              `¿Quieres probar con otro nombre de área o el inventario general?`;
            recordTokenConsumption(null, userText || text, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }
          const shownRows = areaRows.slice(0, 50);
          const localReply = buildMarcasAreaReply(marcasArea, areaRows);
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: shownRows.map((row) => rowToChatApiItem(row)),
            qr: [],
          });
          return;
        } catch {
          /* abort / nuevo mensaje */
        }
      }
    }

    // 5. Anáfora: "dame esas etiquetas" / "las de arriba" → resultado anterior.
    if (looksLikeResultAnaphora(userText || text)) {
      const prevItems =
        lastBotResultItems(messagesRef.current).length > 0
          ? lastBotResultItems(messagesRef.current)
          : lastConcreteSideRef.current?.resultItems || [];
      const n = normalizeChatIntent(userText || text);
      const wantsThose =
        /\betiquet/.test(n) ||
        intentHas(n, "dame", "muestra", "mostrar", "ver", "trae", "lista", "qr") ||
        intentHas(n, "esas", "esos", "estas", "estos");
      if (wantsThose && prevItems.length) {
        try {
          const localReply = userAskedQr(userText || text)
            ? `Tomo las **${prevItems.length}** etiqueta${prevItems.length === 1 ? "" : "s"} del resultado anterior para QR. El detalle está en el visor.`
            : buildAnaphoraEtiquetasReply(prevItems);
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          if (userAskedQr(userText || text)) {
            const recovered = buildQrSideFromRows(
              prevItems
                .map((item) => {
                  const id = item.id != null ? Number(item.id) : NaN;
                  const etq = String(item.etiqueta ?? "")
                    .trim()
                    .toLowerCase();
                  return (
                    (Number.isFinite(id)
                      ? items.find((row) => Number(row.id) === id)
                      : undefined) ||
                    items.find(
                      (row) =>
                        String(row.etiqueta ?? "")
                          .trim()
                          .toLowerCase() === etq,
                    ) ||
                    (item as unknown as InventarioRow)
                  );
                })
                .filter(Boolean) as InventarioRow[],
            );
            finishBotReply(sessionId, botId, localReply, {
              resultItems: recovered.resultItems,
              qr: recovered.qr,
            });
          } else {
            finishBotReply(sessionId, botId, localReply, {
              resultItems: prevItems,
              qr: [],
            });
          }
          return;
        } catch {
          /* abort / nuevo mensaje */
        }
      }
      if (wantsThose && !prevItems.length) {
        try {
          const ask =
            "No tengo un listado previo en este chat para “esas etiquetas”. " +
            "Primero busca algo (por ejemplo «cuántas tarjas tenemos») y luego dime «dame esas etiquetas».";
          recordTokenConsumption(null, userText || text, ask);
          await ensureTypingPause(ask);
          finishBotReply(sessionId, botId, ask);
          return;
        } catch {
          /* abort */
        }
      }
    }

    // 6. Overview local (áreas / totales / personas…) sin depender del LLM.
    // Si ya acotó marcas a un área, no caer al ranking global de marcas.
    const earlyOverview = detectMarcasAreaAsk(userText || text, items)
      ? undefined
      : detectViewerOverview(userText || text);
    if (earlyOverview && items.length) {
      try {
        const localReply = buildLocalOverviewReply(earlyOverview, items);
        if (localReply) {
          const openPanel = shouldAttachSidePanel(
            userText || text,
            items,
            chatHistory,
          );
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(
            sessionId,
            botId,
            localReply,
            openPanel
              ? {
                  resultItems: [],
                  qr: [],
                  viewerOverview: earlyOverview,
                }
              : undefined,
          );
          return;
        }
      } catch {
        /* abort / nuevo mensaje */
      }
    }

    const data = await askInventoryChat(userText || text, history, {
      signal: controller.signal,
      memory: formatChatMemoryForPrompt(),
      model: activeLlmMeta.model,
    });
    if (
      requestGen !== chatRequestGenRef.current ||
      controller.signal.aborted ||
      data.error === "aborted"
    ) {
      return;
    }
    reply = (data.reply || "").trim() || reply;
    recordTokenConsumption(data.usage, userText || text, reply);
    sideItems = data.items || [];
    mutated = Boolean(data.mutated);
    qrPayloads = data.qr || [];

    // Conservar listado para follow-ups aunque el panel no abra aún.
    if (sideItems.length || qrPayloads.length) {
      lastConcreteSideRef.current = {
        resultItems: sideItems,
        qr: qrPayloads,
      };
    }

    // Visor solo si el usuario lo pidió (dame/muestra/QR/persona/área) o hubo escritura.
    const forceSidePanel = wantsSidePanelShow(userText || text);
    let openSidePanel =
      shouldAttachSidePanel(userText || text, items, chatHistory) || mutated;
    // Si el backend ya dice que el listado está en el visor, abrirlo de verdad.
    if (
      !openSidePanel &&
      sideItems.length > 0 &&
      /\b(visor|panel derecho|lado derecho|listado interactivo)\b/i.test(reply)
    ) {
      openSidePanel = true;
    }
    const concreteAsk =
      hasConcreteInventoryAsk(userText || text, items, chatHistory) ||
      forceSidePanel;

    const replySaysNotFound =
      /no se encontraron|no encontr[eé]|sin coincidencias|no hay registros para/i.test(
        reply,
      );

    // Sin resultados en una búsqueda concreta → “¿quisiste decir…?” (sin visor)
    if (
      !sideItems.length &&
      !qrPayloads.length &&
      !mutated &&
      concreteAsk &&
      items.length &&
      !/quisiste decir|te refer[ií]as/i.test(reply)
    ) {
      const suggestions = suggestDidYouMean(userText || text, items);
      if (suggestions.length) {
        reply = formatDidYouMeanReply(userText || text, suggestions);
        const areaCatalog = getAllAreaCatalog(items);
        const areaHits = suggestions
          .map(
            (s) =>
              areaCatalog.find((c) => c.name === s) ||
              areaCatalog.find((c) => areaMatchesNeedle(c.name, s)),
          )
          .filter((c): c is AreaCandidateSummary => Boolean(c));
        if (areaHits.length) {
          pendingDisambiguationRef.current = {
            kind: "area",
            queryLabel: normalizePlain(userText || text).slice(0, 40) || "consulta",
            candidates: areaHits.map((c) => c.name),
            intent: "list",
            limit: null,
          };
        }
      }
    }
    const exploratoryAsk =
      !concreteAsk && !mutated && isExploratoryChatAsk(userText || text);
    if (!openSidePanel || replySaysNotFound) {
      // “No encontrado” → no reusar etiquetas del mensaje anterior en el visor.
      sideItems = [];
      qrPayloads = [];
    } else if (
      !sideItems.length &&
      !qrPayloads.length &&
      (looksLikeRecordLookup(userText || text) ||
        forceSidePanel ||
        mutated) &&
      items.length
    ) {
      // Recuperar ficha en el visor (prompt o reply). Nunca el lote previo ajeno.
      const recovered = resolveRecordRowsFromPrompt(
        userText || text,
        reply,
        items,
      );
      sideItems = recovered.map((row) => rowToChatApiItem(row));
    }

    // Pedido de VER: si aún no hay items, armar overview acertado (inventario/áreas…).
    let forcedOverview: ViewerOverview | undefined;
    if (
      forceSidePanel &&
      !sideItems.length &&
      !qrPayloads.length &&
      !userAskedQr(userText || text)
    ) {
      forcedOverview =
        detectPersonTotalAsk(userText || text, items, chatHistory)
          ? "personTotal"
          : detectViewerOverview(userText || text) ||
            (intentHas(
              normalizeChatIntent(userText || text),
              "inventario",
              "resumen",
              "totales",
              "general",
            ) && !looksLikePersonAnaphora(userText || text)
              ? "full"
              : undefined);
    }

    // Etiquetas ≠ QR: listar exactamente lo pedido (o todas las del filtro si hay menos).
    const etiquetaLimit = concreteAsk
      ? parseEtiquetaListAsk(userText || text)
      : null;
    const wantsQr = concreteAsk && userAskedQr(userText || text);

    if (etiquetaLimit != null) {
      if (!sideItems.length && qrPayloads.length) {
        sideItems = qrPayloads.map((qr) => ({
          id: qr.id ?? null,
          etiqueta: qr.etiqueta ?? null,
          articulo: qr.articulo ?? null,
          persona: qr.persona ?? null,
          area: qr.area ?? null,
          origen: qr.origen ?? null,
          marca: null,
          modelo: null,
          serie: null,
          cantidad: null,
          estado: null,
          observaciones: null,
        }));
      }
      qrPayloads = [];
      const areaFilter = matchAreaFromPrompt(userText || text, items);
      const areaNorm = areaFilter ? normalizeChatIntent(areaFilter) : "";
      const pool = areaFilter
        ? items.filter(
            (row) =>
              normalizeChatIntent(String(row.area ?? "")) === areaNorm ||
              normalizeChatIntent(String(row.area ?? "")).includes(areaNorm) ||
              areaNorm.includes(normalizeChatIntent(String(row.area ?? ""))),
          )
        : items;
      // Preferir coincidencias del área: reconstruir lista limpia desde el pool.
      if (pool.length) {
        const seen = new Set<string>();
        const filled: ChatApiItem[] = [];
        for (const item of sideItems) {
          if (filled.length >= etiquetaLimit) break;
          const key =
            item.id != null
              ? `id:${item.id}`
              : `etq:${String(item.etiqueta ?? "").toLowerCase()}`;
          if (seen.has(key)) continue;
          if (areaFilter) {
            const itemArea = normalizeChatIntent(String(item.area ?? ""));
            if (
              itemArea !== areaNorm &&
              !itemArea.includes(areaNorm) &&
              !areaNorm.includes(itemArea)
            ) {
              continue;
            }
          }
          seen.add(key);
          filled.push(item);
        }
        for (const row of pool) {
          if (filled.length >= etiquetaLimit) break;
          const key =
            row.id != null
              ? `id:${row.id}`
              : `etq:${String(row.etiqueta ?? "").toLowerCase()}`;
          if (seen.has(key)) continue;
          if (!String(row.etiqueta ?? "").trim()) continue;
          seen.add(key);
          filled.push(rowToChatApiItem(row));
        }
        // Sentido común: si pidió 13 y hay 10, entrega las 10.
        sideItems = filled.slice(
          0,
          Math.min(etiquetaLimit, filled.length || etiquetaLimit),
        );
      } else {
        sideItems = sideItems.slice(0, etiquetaLimit);
      }
    }

    // Si el usuario pidió QR/códigos y el backend no mandó payloads, armarlos.
    if (!qrPayloads.length && wantsQr && items.length) {
      const rows = resolveQrRowsFromPrompt(userText || text, reply, items);
      if (rows.length) {
        const recovered = buildQrSideFromRows(rows);
        qrPayloads = recovered.qr;
        sideItems = recovered.resultItems;
      }
    }

    // Si hay QR, el visor lista exactamente esos (no el lote de búsqueda previo).
    if (qrPayloads.length) {
      sideItems = qrPayloads.map((qr) => {
        const match =
          (qr.id != null
            ? sideItems.find((item) => Number(item.id) === Number(qr.id))
            : undefined) ||
          sideItems.find(
            (item) =>
              String(item.etiqueta || "")
                .trim()
                .toLowerCase() ===
              String(qr.etiqueta || "")
                .trim()
                .toLowerCase(),
          ) ||
          (qr.id != null
            ? items.find((row) => Number(row.id) === Number(qr.id))
            : undefined) ||
          items.find(
            (row) =>
              String(row.etiqueta || "")
                .trim()
                .toLowerCase() ===
              String(qr.etiqueta || "")
                .trim()
                .toLowerCase(),
          );
        return {
          id: qr.id ?? match?.id ?? null,
          etiqueta: qr.etiqueta ?? match?.etiqueta ?? null,
          articulo: qr.articulo ?? match?.articulo ?? null,
          persona: qr.persona ?? match?.persona ?? null,
          area: qr.area ?? match?.area ?? null,
          origen: qr.origen ?? match?.origen ?? null,
          marca: match?.marca ?? null,
          modelo: match?.modelo ?? null,
          serie: match?.serie ?? null,
          cantidad: match?.cantidad ?? null,
          estado: match?.estado ?? null,
          observaciones: match?.observaciones ?? null,
        };
      });
    }

    // Incidencias: concreto → panel pedido; mutación → etiqueta; VER → obligatorio; tip si explora.
    const areaListAsk = detectAreaListAsk(userText || text, items);
    if (areaListAsk && !sideItems.length && !qrPayloads.length) {
      sideItems = rowsForAreaNeedle(
        items,
        areaListAsk.area,
        areaListAsk.limit,
      ).map((row) => rowToChatApiItem(row));
    }
    const focusPerson = concreteAsk
      ? detectPersonTotalAsk(userText || text, items, chatHistory)
      : undefined;
    const focusArea = concreteAsk && !focusPerson
      ? detectAreaTotalAsk(userText || text, items)
      : undefined;
    let askedOverview: ViewerOverview | undefined =
      !openSidePanel || mutated || areaListAsk
        ? undefined
        : focusPerson
          ? "personTotal"
          : focusArea
            ? "areaTotal"
            : detectViewerOverview(userText || text) || forcedOverview;
    // Si ya hay listado concreto (API / área / QR), no taparlo con ranking overview.
    const overview =
      !openSidePanel
        ? undefined
        : sideItems.length > 0 ||
            qrPayloads.length ||
            Boolean(areaListAsk && sideItems.length) ||
            (sideItems.length &&
              (forceSidePanel || looksLikeRecordLookup(userText || text)) &&
              !forcedOverview)
          ? undefined
          : askedOverview || forcedOverview;
    const viewerFocus =
      overview === "personTotal" && focusPerson
        ? focusPerson
        : overview === "areaTotal" && focusArea
          ? focusArea
          : undefined;
    if (
      overview &&
      overview !== "areaTotal" &&
      overview !== "personTotal"
    ) {
      sideItems = [];
      qrPayloads = [];
    }
    if (mutated || exploratoryAsk) {
      reply = reply
        .replace(
          /\n*\s*Te dejé un vistazo rápido en el panel derecho por si quieres explorar\.?\s*/gi,
          "\n",
        )
        .trim();
    }
    const hasNewSide =
      openSidePanel &&
      (sideItems.length > 0 || qrPayloads.length > 0 || Boolean(overview));

    if (hasNewSide) {
      if (qrPayloads.length) {
        const cards = buildChatQrCards(qrPayloads);
        setChatQrByMsg((prev) => ({ ...prev, [botId]: cards }));
      }
    }

    if (mutated && sideItems.length) {
      const stamp = new Date().toISOString();
      const totalBefore = items.length;
      const existingIds = new Set(
        items
          .map((row) => (row.id != null ? Number(row.id) : null))
          .filter((id): id is number => id != null),
      );
      const createdIds: number[] = [];
      const updatedIds: number[] = [];
      for (const item of sideItems) {
        if (item.id == null) continue;
        const id = Number(item.id);
        if (existingIds.has(id)) updatedIds.push(id);
        else createdIds.push(id);
      }
      setItems((prev) => {
        const next = [...prev];
        for (const item of sideItems) {
          if (item.id == null) continue;
          const id = Number(item.id);
          const patch: InventarioRow = {
            id,
            etiqueta: item.etiqueta ?? null,
            articulo: item.articulo ?? null,
            marca: item.marca ?? null,
            modelo: item.modelo ?? null,
            serie: item.serie ?? null,
            area: item.area ?? null,
            persona: item.persona ?? null,
            cantidad: item.cantidad ?? null,
            estado: item.estado ?? null,
            origen: item.origen ?? null,
            observaciones: item.observaciones ?? null,
            updated_at: stamp,
          };
          const idx = next.findIndex((row) => Number(row.id) === id);
          if (idx >= 0) next[idx] = { ...next[idx], ...patch };
          else next.unshift(patch);
        }
        return next;
      });
      if (createdIds.length) {
        rememberMutation({
          kind: "create",
          summary: `Alta de ${createdIds.length} artículo${createdIds.length === 1 ? "" : "s"} por chat`,
          totalBefore,
          totalAfter: totalBefore + createdIds.length,
          count: createdIds.length,
          ids: createdIds,
          chatId: sessionId,
        });
      } else if (updatedIds.length) {
        rememberMutation({
          kind: "update",
          summary: `Actualicé ${updatedIds.length} registro${updatedIds.length === 1 ? "" : "s"} por chat`,
          totalBefore,
          totalAfter: totalBefore,
          count: updatedIds.length,
          ids: updatedIds,
          chatId: sessionId,
        });
        for (const id of updatedIds) {
          const before = items.find((row) => Number(row.id) === id);
          const after = sideItems.find((item) => Number(item.id) === id);
          if (!before || !after) continue;
          const fields: Array<keyof InventarioRow> = [
            "persona",
            "area",
            "articulo",
            "marca",
            "modelo",
            "serie",
            "estado",
            "etiqueta",
            "observaciones",
          ];
          for (const field of fields) {
            const oldValue = String(before[field] ?? "").trim();
            const afterRec = after as Record<string, unknown>;
            const newValue = String(afterRec[field] ?? "").trim();
            if (oldValue === newValue) continue;
            rememberFieldChange({
              id,
              etiqueta: after.etiqueta ?? before.etiqueta,
              articulo: after.articulo ?? before.articulo,
              field,
              oldValue: oldValue || "(vacío)",
              newValue: newValue || "(vacío)",
              chatId: sessionId,
            });
            break;
          }
        }
      }
    }

    // Chat: primero la incidencia (texto); la tabla va al visor o al final del mensaje.
    const chatReply = overview
      ? stripChatMarkdownTables(reply)
      : reorderChatProseThenTable(reply);
    const finalReply = chatReply || reply;

    try {
      await ensureTypingPause(finalReply);
    } catch {
      return;
    }

    finishBotReply(
      sessionId,
      botId,
      finalReply,
      hasNewSide
        ? {
            // Si hay resumen/overview, no mandar items: el visor muestra la tabla.
            resultItems: overview ? [] : sideItems,
            qr: qrPayloads,
            viewerOverview: overview,
            viewerFocus,
          }
        : undefined,
    );
  };

  const scrollApartadoToTop = useCallback(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    const panel = viewPanelRef.current;
    if (panel) panel.scrollTop = 0;
    if (tableRef.current) tableRef.current.scrollTop = 0;
    if (peopleStripRef.current) peopleStripRef.current.scrollLeft = 0;
  }, []);

  // Tras pintar el apartado nuevo, siempre al inicio (no a mitad de tabla)
  useLayoutEffect(() => {
    if (!railReady) return;
    scrollApartadoToTop();
  }, [rail, railReady, scrollApartadoToTop]);

  const changeRail = useCallback((id: string) => {
    // Cambio de apartado inmediato (UI snappy); resets pesados en transition
    setRail(id);
    startTransition(() => {
      setSelectedId(null);
      setSelectMode(false);
      setSelectedRowIds([]);
      setConfirmBulkDelete(false);
      setBulkError(null);
      setInfoOpen(false);
      if (id === "inventario") {
        setSelectedInventarios([]);
        setInventarioSearch("");
        setDebouncedInventarioSearch("");
      }
      if (id === "personas") {
        setPeopleAreaFilter("ALL");
        setPeopleOrigenFilter("ALL");
        setPeopleSearch("");
        setDebouncedPeopleSearch("");
      }
    });
    requestAnimationFrame(() => {
      requestAnimationFrame(scrollApartadoToTop);
    });
  }, [scrollApartadoToTop]);

  const handleExpandedChange = useCallback((next: boolean) => {
    setSidebarExpanded(next);
  }, []);

  const openConsultasApartado = useCallback(() => {
    // Solo abre el apartado de chat/historial; no borra la conversación activa.
    setDraft("");
    setPendingAttach(null);
    setAttachMenuOpen(false);
    changeRail("archivos");
  }, [changeRail]);

  const startNewChat = useCallback(() => {
    chatAbortRef.current?.abort();
    chatRequestGenRef.current += 1;
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `chat-${Date.now()}`;
    activeChatIdRef.current = id;
    messagesRef.current = [];
    saveActiveChatId(null);
    setActiveChatId(id);
    setMessages([]);
    setDraft("");
    setPendingAttach(null);
    setAttachMenuOpen(false);
    setChatQrByMsg({});
    setPendingChatImport(null);
    setPendingChatImportSafe(null);
    setPendingBulkTransferSafe(null);
    changeRail("archivos");
  }, [changeRail]);

  const chatSessionsRef = useRef(chatSessions);
  chatSessionsRef.current = chatSessions;

  const openChatSession = useCallback(
    (sessionId: string) => {
      const session = chatSessionsRef.current.find((item) => item.id === sessionId);
      if (!session) return;
      const side = resolveSessionSide(session, items);
      let nextMessages = session.messages;
      if (
        (side.resultItems.length || side.qr.length) &&
        !nextMessages.some((message) => messageHasSideData(message))
      ) {
        const owner =
          findQrOwnerMessage(nextMessages) ||
          [...nextMessages].reverse().find((message) => message.from === "bot");
        if (owner) {
          nextMessages = nextMessages.map((message) =>
            message.id === owner.id
              ? { ...message, resultItems: side.resultItems, qr: side.qr }
              : message,
          );
        }
      }
      activeChatIdRef.current = session.id;
      messagesRef.current = nextMessages;
      saveActiveChatId(session.id);
      setActiveChatId(session.id);
      setMessages(nextMessages);
      setChatQrByMsg({});
      const maxId = nextMessages.reduce((max, message) => Math.max(max, message.id), 0);
      chatId.current = maxId + 1;
      setDraft("");
      changeRail("archivos");
    },
    [changeRail, items],
  );

  const deleteChatSession = useCallback((sessionId: string) => {
    chatAbortRef.current?.abort();
    chatRequestGenRef.current += 1;
    const stored = loadChatSessions().filter((session) => session.id !== sessionId);
    saveChatSessions(stored);
    setChatSessions(stored);
    if (activeChatIdRef.current === sessionId) {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `chat-${Date.now()}`;
      activeChatIdRef.current = id;
      messagesRef.current = [];
      saveActiveChatId(null);
      setActiveChatId(id);
      setMessages([]);
      setDraft("");
      setChatQrByMsg({});
      setPendingAttach(null);
    }
  }, []);

  const backToWorkspace = useCallback(() => {
    startTransition(() => {
      setRail((current) => (current === "archivos" ? "inventario" : current));
    });
  }, []);

  const visibleRowIds = useMemo(
    () =>
      visible
        .map((row) => Number(row.id))
        .filter((id) => Number.isFinite(id)),
    [visible],
  );

  const allVisibleSelected =
    visibleRowIds.length > 0 && visibleRowIds.every((id) => selectedRowIds.includes(id));

  const toggleSelectMode = () => {
    setSelectMode((current) => {
      if (current) {
        setSelectedRowIds([]);
        setConfirmBulkDelete(false);
        setBulkError(null);
      }
      return !current;
    });
  };

  const toggleRowSelection = useCallback((id: number) => {
    setSelectedRowIds((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }, []);

  const openProductRow = useCallback((row: InventarioRow) => {
    setSelectedProduct(row);
  }, []);

  const selectAllVisible = () => {
    setSelectedRowIds((current) => {
      const merged = new Set([...current, ...visibleRowIds]);
      return [...merged];
    });
  };

  const clearRowSelection = () => {
    setSelectedRowIds([]);
    setConfirmBulkDelete(false);
  };

  const handleBulkDelete = async () => {
    if (!selectedRowIds.length || bulkBusy) return;
    setBulkBusy(true);
    setBulkError(null);
    const snapshot = items.filter((row) => selectedRowIds.includes(Number(row.id)));
    try {
      const res = await deleteInventarioManyAction(selectedRowIds);
      if (!res.success || !res.deletedIds?.length) {
        setBulkError(res.error || "No se pudieron eliminar los artículos.");
        return;
      }
      const deletedSet = new Set(res.deletedIds);
      const removed = snapshot.filter((row) => deletedSet.has(Number(row.id)));
      setItems((prev) => prev.filter((row) => !deletedSet.has(Number(row.id))));
      setUndoStack(removed);
      setSelectedRowIds([]);
      setConfirmBulkDelete(false);
      setSelectedProduct((current) =>
        current && deletedSet.has(Number(current.id)) ? null : current,
      );
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Error al eliminar.");
    } finally {
      setBulkBusy(false);
    }
  };

  const handleUndoDelete = async () => {
    if (!undoStack.length || bulkBusy) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      const res = await restoreInventarioManyAction(undoStack);
      if (!res.success || !res.data?.length) {
        setBulkError(res.error || "No se pudieron restaurar los artículos.");
        return;
      }
      setItems((prev) => [...res.data!, ...prev]);
      setUndoStack([]);
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : "Error al restaurar.");
    } finally {
      setBulkBusy(false);
    }
  };

  const resetInventarioFilters = () => {
    setSelectedInventarios([]);
    setInventarioSearch("");
    setDebouncedInventarioSearch("");
  };

  const resetPeopleFilters = () => {
    setSelectedId(null);
    setPeopleAreaFilter("ALL");
    setPeopleOrigenFilter("ALL");
    setPeopleSearch("");
    setDebouncedPeopleSearch("");
  };

  const showFullInventory = () => {
    setSelectedId(null);
    setQuery("");
    setDebouncedQuery("");
    setInfoOpen(false);
    setRail("inventario");
  };

  const handleProductCreated = (created: InventarioRow | InventarioRow[]) => {
    const batch = Array.isArray(created) ? created : [created];
    setItems((prev) => {
      let next = prev.slice();
      for (const newItem of batch) {
        const id = Number(newItem.id);
        if (Number.isFinite(id)) {
          const idx = next.findIndex((row) => Number(row.id) === id);
          if (idx >= 0) {
            next[idx] = newItem;
            continue;
          }
        }
        next = [newItem, ...next];
      }
      return next;
    });
  };

  const inventariosCount = inventarioOptions.length;
  const inventariosDisplayCount =
    selectedInventarios.length > 0 && selectedInventarios.length < inventariosCount
      ? selectedInventarios.length
      : inventariosCount;
  const articulosInventarioCount = (() => {
    if (!selectedInventarios.length || selectedInventarios.length >= inventariosCount) {
      return items.length;
    }
    const selected = new Set(selectedInventarios);
    return items.filter((row) => selected.has(textOf(row.origen))).length;
  })();
  const inventarioCard = inventarioCardCopy(
    selectedInventarios,
    inventariosCount,
    articulosInventarioCount,
    inventariosDisplayCount,
  );
  const title =
    rail === "avisos" ? "Avisos" : (RAIL_ITEMS.find((item) => item.id === rail)?.label ?? "Inventario");

  const selectedFolder = folders.find((folder) => folder.id === selectedId) ?? null;

  return (
    <div
      className={`app-shell ${sidebarExpanded ? "is-sidebar-expanded" : "is-sidebar-collapsed"}${
        railReady ? "" : " is-booting"
      }${rail === "archivos" ? " is-chat-rail" : ""}`}
      id="inicio"
    >
      <div className="workspace">
        <header className="topbar">
          <form className="searchbar" role="search" onSubmit={(event) => event.preventDefault()}>
            <Search size={18} strokeWidth={1.8} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar artículos, etiquetas, personas..."
              aria-label="Buscar en el inventario"
            />
          </form>
          <div className="topbar-actions">
            <button
              type="button"
              className={rail === "avisos" ? "btn-avisos is-active" : "btn-avisos"}
              aria-label="Avisos"
              aria-pressed={rail === "avisos"}
              onClick={() => changeRail("avisos")}
              title="Ver avisos"
            >
              <Bell size={17} strokeWidth={2.2} aria-hidden="true" />
              <span>Avisos</span>
            </button>

            <button
              type="button"
              className="btn-add-product"
              aria-label="Añadir nuevo artículo"
              onClick={() => setIsAddModalOpen(true)}
              title="Registrar nuevo artículo"
            >
              <Plus size={17} strokeWidth={2.4} aria-hidden="true" />
              <span>Nuevo artículo</span>
            </button>

            {/* Conmutador de modo claro / oscuro (icono/texto vía CSS = sin salto al cargar) */}
            <button
              type="button"
              className="theme-switch"
              aria-pressed={dark}
              aria-label={dark ? "Activar modo claro" : "Activar modo oscuro"}
              onClick={toggleDark}
            >
              <span className="theme-switch-icons" aria-hidden="true">
                <Moon size={16} className="theme-icon-dark" />
                <Sun size={16} className="theme-icon-light" />
              </span>
              <span className="theme-switch-labels">
                <span className="theme-label-dark">Oscuro</span>
                <span className="theme-label-light">Claro</span>
              </span>
            </button>
          </div>
        </header>

        <SideRail
          active={rail}
          onChange={changeRail}
          expanded={sidebarExpanded}
          onExpandedChange={handleExpandedChange}
          chatSessions={chatSessions}
          activeChatId={activeChatId}
          onOpenHistory={openConsultasApartado}
          onBackToWorkspace={backToWorkspace}
          onStartNewChat={startNewChat}
          onOpenChat={openChatSession}
          onDeleteChat={deleteChatSession}
          collapseRef={collapseSidebarRef}
        />

        {sidebarExpanded ? (
          <button
            type="button"
            className="sidebar-backdrop"
            aria-label="Cerrar menú"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              collapseSidebarRef.current?.();
            }}
          />
        ) : null}

        <main
          ref={viewPanelRef}
          className={rail === "archivos" ? "view-panel is-chat" : "view-panel"}
        >
          <div className="page-heading">
            <div>
              <h1>{rail === "inventario" ? "Inventario" : title}</h1>
              <p>
                {rail === "inventario"
                  ? "Consulta artículos, asignaciones y áreas."
                  : rail === "personas"
                    ? "Explora los artículos asignados a cada persona."
                    : rail === "areas"
                      ? "Consulta el inventario organizado por área."
                      : rail === "archivos"
                        ? "Pregunta por artículos, personas o áreas."
                        : rail === "reportes"
                          ? "Genera, filtra y exporta reportes detallados de existencias, resguardos y áreas."
                          : rail === "avisos"
                            ? "Revisa las novedades del inventario."
                            : rail === "estado"
                              ? "Consulta si cada artículo está activo en la universidad."
                              : "Consulta los artículos registrados."}
              </p>
            </div>
            {rail !== "archivos" && rail !== "avisos" && rail !== "reportes" ? (
              <span className="record-count">
                {formatNumber(visible.length)} {visible.length === 1 ? "registro" : "registros"}
              </span>
            ) : null}
          </div>

          {rail === "inventario" ? (
            <section className="inventario-summary-row" aria-label="Inventarios y filtros">
              <article
                className="stat-card stat-purple inventario-summary-card"
                title={selectedInventarios.length ? selectedInventarios.join(", ") : "Todos los inventarios"}
              >
                <div className="stat-topline">
                  <span>{inventarioCard.title}</span>
                  <span className="stat-icon"><Layers size={18} aria-hidden="true" /></span>
                </div>
                <strong>{formatNumber(articulosInventarioCount)}</strong>
                <small>{inventarioCard.hint}</small>
              </article>

              <section
                className="reports-filter-panel inventario-filter-panel"
                aria-label="Filtro por inventarios"
              >
                <div className="reports-filter-grid inventario-filter-grid">
                  <MultiFilterSelect
                    id="inventario-filter-origen"
                    label="Inventario"
                    values={selectedInventarios}
                    onChange={setSelectedInventarios}
                    allLabel={`Todos los inventarios (${formatNumber(items.length)} ${
                      items.length === 1 ? "artículo" : "artículos"
                    })`}
                    options={inventarioOptions.map((origen) => {
                      const count = inventarioOptionCounts.get(origen) ?? 0;
                      return {
                        value: origen,
                        label: `${origen} (${formatNumber(count)} ${
                          count === 1 ? "artículo" : "artículos"
                        })`,
                      };
                    })}
                  />
                  <div className="report-filter-item report-filter-search">
                    <label htmlFor="inventario-filter-search">Búsqueda rápida</label>
                    <div className="report-search-wrap">
                      <Search size={15} />
                      <input
                        id="inventario-filter-search"
                        placeholder="Ej. Biblioteca, Martinez, mesa, 471776…"
                        value={inventarioSearch}
                        onChange={(e) => setInventarioSearch(e.target.value)}
                      />
                      {inventarioSearch ? (
                        <button
                          type="button"
                          className="report-search-clear"
                          onClick={() => {
                            setInventarioSearch("");
                            setDebouncedInventarioSearch("");
                          }}
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="reports-top-actions">
                  <button
                    type="button"
                    className="btn-rep-action"
                    onClick={resetInventarioFilters}
                    title="Restablecer filtros de inventarios"
                  >
                    <RotateCcw size={15} />
                    <span>Restablecer</span>
                  </button>
                </div>
              </section>
            </section>
          ) : null}

          {rail === "avisos" ? (
            <section className="panel notice" aria-labelledby="notice-title">
              <span className="notice-icon" aria-hidden="true"><Bell size={20} /></span>
              <div>
                <h2 id="notice-title">Bandeja de avisos</h2>
                <p>No hay avisos disponibles con los datos actuales.</p>
              </div>
            </section>
          ) : null}

          {rail === "personas" ? (
            <section className="quick-access" aria-label="Personas">
              <div className="section-heading people-toolbar">
                <div>
                  <h2>Personas</h2>
                  <span>{formatNumber(visiblePersonFolders.length)} grupos</span>
                </div>
              </div>

              <section className="reports-filter-panel people-reports-filter" aria-label="Filtros de personas">
                <div className="reports-filter-grid">
                  <FilterSelect
                    id="people-filter-person"
                    label="Persona"
                    value={selectedId ?? "ALL"}
                    onChange={(value) => setSelectedId(value === "ALL" ? null : value)}
                    options={[
                      {
                        value: "ALL",
                        label: `Todas las personas (${peoplePersonOptions.length})`,
                      },
                      ...peoplePersonOptions.map((person) => ({
                        value: person,
                        label: person,
                      })),
                    ]}
                  />
                  <FilterSelect
                    id="people-filter-area"
                    label="Área / Ubicación"
                    value={peopleAreaFilter}
                    onChange={setPeopleAreaFilter}
                    options={[
                      {
                        value: "ALL",
                        label: `Todas las áreas (${peopleAreaOptions.length})`,
                      },
                      ...peopleAreaOptions.map((area) => ({ value: area, label: area })),
                    ]}
                  />
                  <FilterSelect
                    id="people-filter-origen"
                    label="Origen"
                    value={peopleOrigenFilter}
                    onChange={setPeopleOrigenFilter}
                    options={[
                      {
                        value: "ALL",
                        label: `Todos los orígenes (${peopleOrigenOptions.length})`,
                      },
                      ...peopleOrigenOptions.map((origen) => ({
                        value: origen,
                        label: origen,
                      })),
                    ]}
                  />
                  <div className="report-filter-item report-filter-search">
                    <label htmlFor="people-filter-search">Búsqueda rápida</label>
                    <div className="report-search-wrap">
                      <Search size={15} />
                      <input
                        id="people-filter-search"
                        placeholder="Ej. Biblioteca, Martinez, mesa, 471776…"
                        value={peopleSearch}
                        onChange={(e) => setPeopleSearch(e.target.value)}
                      />
                      {peopleSearch ? (
                        <button
                          type="button"
                          className="report-search-clear"
                          onClick={() => {
                            setPeopleSearch("");
                            setDebouncedPeopleSearch("");
                          }}
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="reports-top-actions">
                  <button
                    type="button"
                    className="btn-rep-action"
                    onClick={resetPeopleFilters}
                    title="Restablecer filtros de personas"
                  >
                    <RotateCcw size={15} />
                    <span>Restablecer</span>
                  </button>
                  <button
                    type="button"
                    className="btn-rep-action"
                    onClick={showFullInventory}
                    title="Volver al inventario completo"
                  >
                    <span>Ver todo el inventario</span>
                  </button>
                </div>
              </section>

              {selectedFolder && rail === "personas" ? (
                <div className="people-filter-bar" role="status">
                  <div>
                    <strong>Persona: {selectedFolder.name}</strong>
                    <small>
                      {formatNumber(
                        visiblePersonFolders.find((folder) => folder.id === selectedId)?.rows
                          .length ?? 0,
                      )}{" "}
                      {(visiblePersonFolders.find((folder) => folder.id === selectedId)?.rows
                        .length ?? 0) === 1
                        ? "artículo"
                        : "artículos"}
                    </small>
                  </div>
                  <div className="people-filter-actions">
                    <button type="button" className="btn-clear-filter" onClick={() => setSelectedId(null)}>
                      Quitar filtro
                    </button>
                  </div>
                </div>
              ) : null}

              {visiblePersonFolders.length ? (
                <div className="people-strip" role="list" ref={peopleStripRef}>
                  {visiblePersonFolders.map((folder) => {
                    const selected = selectedId === folder.id;
                    return (
                      <button
                        key={folder.id}
                        type="button"
                        role="listitem"
                        className={selected ? "people-chip is-active" : "people-chip"}
                        aria-pressed={selected}
                        onClick={() =>
                          setSelectedId((current) => (current === folder.id ? null : folder.id))
                        }
                      >
                        <span
                          className="people-chip-avatar"
                          aria-hidden="true"
                          style={{ backgroundColor: colorFor(folder.name) }}
                        >
                          {initials(folder.name)}
                        </span>
                        <span className="people-chip-copy">
                          <strong>{folder.name}</strong>
                          <small>
                            {formatNumber(folder.rows.length)}{" "}
                            {folder.rows.length === 1 ? "artículo" : "artículos"}
                          </small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="empty-groups">No hay personas para mostrar con estos filtros.</p>
              )}
            </section>
          ) : null}

          {rail === "areas" ? (
            <section className="quick-access" aria-label="Áreas">
              <div className="section-heading people-toolbar">
                <div>
                  <h2>Áreas</h2>
                  <span>{formatNumber(folders.length)} grupos</span>
                </div>
              </div>

              {selectedFolder ? (
                <div className="people-filter-bar" role="status">
                  <div>
                    <strong>Área: {selectedFolder.name}</strong>
                    <small>
                      {formatNumber(selectedFolder.rows.length)}{" "}
                      {selectedFolder.rows.length === 1 ? "artículo" : "artículos"}
                    </small>
                  </div>
                  <div className="people-filter-actions">
                    <button type="button" className="btn-clear-filter" onClick={() => setSelectedId(null)}>
                      Quitar filtro
                    </button>
                    <button type="button" className="btn-full-inventory is-solid" onClick={showFullInventory}>
                      Ver todo el inventario
                    </button>
                  </div>
                </div>
              ) : null}

              {folders.length ? (
                <div className="people-strip" role="list" ref={peopleStripRef}>
                  {folders.map((folder) => {
                    const selected = selectedId === folder.id;
                    return (
                      <button
                        key={folder.id}
                        type="button"
                        role="listitem"
                        className={selected ? "people-chip is-active" : "people-chip"}
                        aria-pressed={selected}
                        onClick={() =>
                          setSelectedId((current) => (current === folder.id ? null : folder.id))
                        }
                      >
                        <span className="people-chip-avatar" aria-hidden="true">
                          <MapPin size={14} />
                        </span>
                        <span className="people-chip-copy">
                          <strong>{folder.name}</strong>
                          <small>
                            {formatNumber(folder.rows.length)}{" "}
                            {folder.rows.length === 1 ? "artículo" : "artículos"}
                          </small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="empty-groups">No hay grupos para mostrar.</p>
              )}
            </section>
          ) : null}

          {rail === "archivos" ? (
            <div
              ref={chatStageRef}
              className={
                chatStarted
                  ? "chat-stage is-conversation has-viewer"
                  : "chat-stage is-home"
              }
            >
              <section className="chat-shell" aria-label="Chat del inventario">
                <div className="chat-main">
                  {!chatStarted ? (
                    <div className="chat-home">
                      <div className="chat-home-hero">
                        <h2 className="chat-home-title">
                          Hola. ¿Qué quieres consultar del inventario?
                        </h2>
                        <p className="chat-home-sub">
                          Elige una idea o escribe tu pregunta abajo
                        </p>
                      </div>
                      <div className="chat-quick-actions">
                        {CHAT_QUICK_ACTIONS.map(({ label, hint, prompt, icon: Icon }) => (
                          <button
                            key={label}
                            type="button"
                            className="chat-quick-action"
                            onClick={() => sendChat(prompt)}
                            title={hint}
                          >
                            <span className="chat-quick-action-head">
                              <span className="chat-quick-action-icon" aria-hidden="true">
                                <Icon size={13} strokeWidth={1.9} />
                              </span>
                              <strong>{label}</strong>
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="chat-log" ref={chatLogRef} aria-live="polite">
                      {(() => {
                        let latestAnchorIndex = Math.max(chatTurns.length - 1, 0);
                        for (let i = chatTurns.length - 1; i >= 0; i -= 1) {
                          const item = chatTurns[i];
                          if (item.kind === "pair") {
                            latestAnchorIndex = i;
                            break;
                          }
                          if (item.kind === "single" && item.message.from === "user") {
                            latestAnchorIndex = i;
                            break;
                          }
                        }
                        return chatTurns.map((turn, turnIndex) => {
                        const isLatest = turnIndex === latestAnchorIndex;
                        const renderUser = (message: ChatMessage) => {
                          const canCollapse =
                            message.text.trim().length > CHAT_USER_COLLAPSE_AT;
                          const expanded = expandedUserMsgs.includes(message.id);
                          const isEditing = editingUserMsgId === message.id;
                          if (isEditing) {
                            return (
                              <ChatUserEditBox
                                key={`edit-${message.id}`}
                                initialText={editDraft || message.text}
                                onChange={setEditDraft}
                                onCancel={() => {
                                  setEditingUserMsgId(null);
                                  setEditDraft("");
                                }}
                                onSubmit={(value) =>
                                  submitUserEdit(message.id, value)
                                }
                              />
                            );
                          }
                          return (
                            <>
                              <div className="chat-user-row">
                                <div
                                  className="chat-user-actions"
                                  aria-label="Acciones del mensaje"
                                >
                                  <button
                                    type="button"
                                    className="chat-user-action"
                                    title="Copiar"
                                    aria-label="Copiar mensaje"
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => {
                                      void copyChatText(message.text);
                                    }}
                                  >
                                    <Copy size={15} strokeWidth={1.8} />
                                  </button>
                                  <button
                                    type="button"
                                    className="chat-user-action"
                                    title="Editar"
                                    aria-label="Editar mensaje"
                                    onClick={() => {
                                      setEditingUserMsgId(message.id);
                                      setEditDraft(message.text);
                                    }}
                                  >
                                    <Pencil size={15} strokeWidth={1.8} />
                                  </button>
                                </div>
                                <div className="chat-user-card">
                                  <p
                                    className={
                                      canCollapse && !expanded
                                        ? "chat-bubble is-collapsed"
                                        : "chat-bubble"
                                    }
                                  >
                                    {message.text}
                                  </p>
                                  {canCollapse ? (
                                    <button
                                      type="button"
                                      className="chat-expand-btn"
                                      aria-label={
                                        expanded ? "Mostrar menos" : "Mostrar más"
                                      }
                                      onClick={() =>
                                        setExpandedUserMsgs((prev) =>
                                          expanded
                                            ? prev.filter((id) => id !== message.id)
                                            : [...prev, message.id],
                                        )
                                      }
                                    >
                                      <ChevronDown
                                        size={16}
                                        className={expanded ? "is-open" : undefined}
                                        aria-hidden="true"
                                      />
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                              <time
                                className="chat-time"
                                dateTime={new Date(message.at || Date.now()).toISOString()}
                              >
                                {formatChatTime(message.at)}
                              </time>
                            </>
                          );
                        };

                        const renderBot = (message: ChatMessage) => {
                          const isTyping = /^consultando el inventario/i.test(
                            String(message.text || "").trim(),
                          );
                          if (isTyping) {
                            return (
                              <div className="chat-response-block is-typing">
                                <div className="chat-response-head">
                                  <span className="chat-response-brand">
                                    <span
                                      className="chat-response-brand-dot is-pulse"
                                      aria-hidden="true"
                                    />
                                    <span>Procesando consulta…</span>
                                  </span>
                                </div>
                                <div
                                  className="chat-typing"
                                  role="status"
                                  aria-label="Escribiendo"
                                >
                                  <span className="chat-typing-dot" />
                                  <span className="chat-typing-dot" />
                                  <span className="chat-typing-dot" />
                                </div>
                              </div>
                            );
                          }
                          if (message.importProgress) {
                            const { label, done, total } = message.importProgress;
                            const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
                            return (
                              <div className="chat-response-block">
                                <div
                                  className="chat-import-card"
                                  role="status"
                                  aria-live="polite"
                                  aria-label={`Importando ${label}, ${done} de ${total}`}
                                >
                                  <div className="chat-import-card-head">
                                    <span className="chat-import-card-icon" aria-hidden="true">
                                      <FileSpreadsheet size={18} strokeWidth={1.8} />
                                    </span>
                                    <div className="chat-import-card-copy">
                                      <strong>Importando tabla</strong>
                                      <span>{label}</span>
                                    </div>
                                    <Loader2
                                      className="chat-import-card-spin"
                                      size={16}
                                      strokeWidth={2}
                                      aria-hidden="true"
                                    />
                                  </div>
                                  <div className="chat-import-card-bar" aria-hidden="true">
                                    <span style={{ width: `${pct}%` }} />
                                  </div>
                                  <div className="chat-import-card-meta">
                                    <span>
                                      {done.toLocaleString("es-MX")} / {total.toLocaleString("es-MX")} registros
                                    </span>
                                    <span>{pct}%</span>
                                  </div>
                                </div>
                              </div>
                            );
                          }
                          return (
                            <div className="chat-response-block">
                              <div className="chat-response-head">
                                <span className="chat-response-brand">
                                  <span
                                    className="chat-response-brand-dot"
                                    aria-hidden="true"
                                  />
                                  <span>Asistente de Inventario</span>
                                </span>
                              </div>
                              <div className="chat-response">
                                {renderChatRichText(message.text)}
                              </div>
                              {Array.isArray(message.exportFiles) &&
                              message.exportFiles.length > 0 ? (
                                <div
                                  className="chat-export-files"
                                  aria-label="Archivos generados"
                                >
                                  {message.exportFiles.map((file) => (
                                    <a
                                      key={`${message.id}-${file.name}`}
                                      className="chat-export-card"
                                      href={file.dataUrl}
                                      download={file.name}
                                      title={`Descargar ${file.name}`}
                                    >
                                      <span className="chat-export-card-title">
                                        {file.label}
                                      </span>
                                      <span className="chat-export-card-meta">
                                        <span
                                          className="chat-export-card-badge"
                                          aria-hidden="true"
                                        >
                                          X
                                        </span>
                                        <span>XLSX</span>
                                        <span className="chat-export-card-count">
                                          {file.rowCount.toLocaleString("es-MX")}{" "}
                                          reg.
                                        </span>
                                      </span>
                                    </a>
                                  ))}
                                </div>
                              ) : null}
                              <div
                                className="chat-response-actions"
                                aria-label="Acciones de la respuesta"
                              >
                                <button
                                  type="button"
                                  className="chat-response-action"
                                  title="Copiar"
                                  aria-label="Copiar respuesta"
                                  onClick={() => {
                                    void copyChatText(message.text);
                                  }}
                                >
                                  <Copy size={14} strokeWidth={1.8} />
                                </button>
                                <button
                                  type="button"
                                  className="chat-response-action"
                                  title="Compartir"
                                  aria-label="Compartir respuesta"
                                >
                                  <Share2 size={14} strokeWidth={1.8} />
                                </button>
                                <button
                                  type="button"
                                  className="chat-response-action"
                                  title="Me gusta"
                                  aria-label="Me gusta"
                                >
                                  <ThumbsUp size={14} strokeWidth={1.8} />
                                </button>
                                <button
                                  type="button"
                                  className="chat-response-action"
                                  title="No me gusta"
                                  aria-label="No me gusta"
                                >
                                  <ThumbsDown size={14} strokeWidth={1.8} />
                                </button>
                              </div>
                              <time
                                className="chat-time is-bot-foot"
                                dateTime={new Date(
                                  message.at || Date.now(),
                                ).toISOString()}
                              >
                                {formatChatTime(message.at)}
                              </time>
                            </div>
                          );
                        };

                        if (turn.kind === "pair") {
                          const hasSide = messageHasSideData(turn.bot);
                          return (
                            <section
                              className="chat-turn"
                              key={`pair-${turn.user.id}-${turn.bot.id}`}
                              data-chat-latest={isLatest ? "true" : undefined}
                              data-side-msg={hasSide ? turn.bot.id : undefined}
                            >
                              <div className="chat-turn-main">
                                <div className="chat-turn-query">
                                  {renderUser(turn.user)}
                                </div>
                                <div className="chat-turn-body">
                                  {renderBot(turn.bot)}
                                </div>
                              </div>
                            </section>
                          );
                        }

                        const message = turn.message;
                        const isUser = message.from === "user";
                        return (
                          <div
                            className={isUser ? "chat-row is-user" : "chat-row is-bot"}
                            key={message.id}
                            data-chat-latest={isLatest ? "true" : undefined}
                          >
                            {isUser ? renderUser(message) : renderBot(message)}
                          </div>
                        );
                      });
                      })()}
                      <div className="chat-log-spacer" aria-hidden="true" />
                    </div>
                  )}
                </div>
                <div
                  className={
                    chatDropActive
                      ? "chat-composer-dock is-drop-active"
                      : "chat-composer-dock"
                  }
                  onDragEnter={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setChatDropActive(true);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setChatDropActive(true);
                  }}
                  onDragLeave={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (
                      !event.currentTarget.contains(event.relatedTarget as Node)
                    ) {
                      setChatDropActive(false);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setChatDropActive(false);
                    const file = event.dataTransfer.files?.[0];
                    if (!file) return;
                    if (file.type.startsWith("image/")) {
                      setPendingAttach({
                        kind: "image",
                        name: file.name,
                        file,
                      });
                      return;
                    }
                    setPendingAttach({
                      kind: "file",
                      name: file.name,
                      file,
                    });
                  }}
                >
                  <form
                    className={[
                      "chat-composer",
                      "is-docked",
                      pendingAttach ? "has-attach" : "",
                      chatComposerBusy ? "is-loading" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!draft.trim() && !pendingAttach) return;
                      void sendChat(draft);
                    }}
                  >
                    {pendingAttach ? (
                      <div className="chat-attach-preview">
                        <span
                          className={
                            pendingAttach.kind === "image"
                              ? "chat-attach-preview-icon is-image"
                              : "chat-attach-preview-icon is-sheet"
                          }
                          aria-hidden="true"
                        >
                          {pendingAttach.kind === "image" ? (
                            <ImagePlus size={18} strokeWidth={1.8} />
                          ) : (
                            <FileSpreadsheet size={18} strokeWidth={1.8} />
                          )}
                        </span>
                        <div className="chat-attach-preview-meta">
                          <span className="chat-attach-preview-name">
                            {pendingAttach.name}
                          </span>
                          <span className="chat-attach-preview-kind">
                            {pendingAttach.kind === "image"
                              ? "Imagen · lista para enviar"
                              : /\.csv$/i.test(pendingAttach.name)
                                ? "CSV · listo para enviar"
                                : "Excel · listo para enviar"}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="chat-attach-preview-remove"
                          aria-label="Quitar archivo"
                          onClick={() => setPendingAttach(null)}
                        >
                          <X size={15} strokeWidth={2} />
                        </button>
                      </div>
                    ) : null}
                    <div className="chat-composer-row">
                      <div className="chat-attach-wrap" ref={chatAttachRef}>
                        <input
                          ref={chatImageInputRef}
                          type="file"
                          accept="image/*"
                          hidden
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) {
                              setPendingAttach({
                                kind: "image",
                                name: file.name,
                                file,
                              });
                              setAttachMenuOpen(false);
                            }
                            event.target.value = "";
                          }}
                        />
                        <input
                          ref={chatFileInputRef}
                          type="file"
                          accept=".csv,.txt,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                          hidden
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) {
                              setPendingAttach({
                                kind: "file",
                                name: file.name,
                                file,
                              });
                              setAttachMenuOpen(false);
                            }
                            event.target.value = "";
                          }}
                        />
                        <button
                          type="button"
                          className={
                            attachMenuOpen
                              ? "chat-composer-icon is-active"
                              : "chat-composer-icon"
                          }
                          aria-label="Adjuntar Excel o CSV"
                          aria-expanded={attachMenuOpen}
                          aria-haspopup="menu"
                          title="Adjuntar Excel / CSV"
                          onClick={() => setAttachMenuOpen((open) => !open)}
                        >
                          <Plus size={18} strokeWidth={2} />
                        </button>
                        {attachMenuOpen ? (
                          <div className="chat-attach-menu" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              className="chat-attach-option"
                              onClick={() => chatImageInputRef.current?.click()}
                            >
                              <ImagePlus size={18} strokeWidth={1.8} aria-hidden="true" />
                              <span>Agregar imágenes</span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="chat-attach-option"
                              onClick={() => chatFileInputRef.current?.click()}
                            >
                              <Paperclip size={18} strokeWidth={1.8} aria-hidden="true" />
                              <span>Excel / CSV</span>
                            </button>
                          </div>
                        ) : null}
                      </div>
                      <input
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={
                          pendingAttach
                            ? "Añade un mensaje o envía el archivo…"
                            : "Pregunta o arrastra un Excel/CSV"
                        }
                        aria-label="Mensaje para el asistente"
                      />
                      <div
                        className="chat-token-meter-wrap"
                        ref={tokenMeterWrapRef}
                      >
                        <button
                          type="button"
                          className={[
                            "chat-token-meter-btn",
                            activeTokenMeter.pctUsed >= 85
                              ? "is-danger"
                              : activeTokenMeter.pctUsed >= 60
                                ? "is-warn"
                                : "is-ok",
                            tokenPopoverOpen ? "is-open" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          onClick={() => setTokenPopoverOpen((open) => !open)}
                          aria-label={`Uso de tokens: ${formatCompactTokens(activeTokenMeter.remaining)} restantes (${activeTokenMeter.shortModel})`}
                          aria-expanded={tokenPopoverOpen}
                          title={`${formatCompactTokens(activeTokenMeter.remaining)} tokens restantes · ${activeTokenMeter.provider} (${activeTokenMeter.shortModel})`}
                        >
                          <svg
                            className="chat-token-ring-svg"
                            width="22"
                            height="22"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <circle
                              className="chat-token-ring-track"
                              cx="12"
                              cy="12"
                              r="9"
                              fill="none"
                              strokeWidth="2.4"
                            />
                            <circle
                              className="chat-token-ring-fill"
                              cx="12"
                              cy="12"
                              r="9"
                              fill="none"
                              strokeWidth="2.4"
                              strokeLinecap="round"
                              strokeDasharray={56.5487}
                              strokeDashoffset={
                                56.5487 *
                                (1 -
                                  Math.min(
                                    1,
                                    Math.max(
                                      activeTokenMeter.used > 0 ? 0.04 : 0,
                                      activeTokenMeter.pctUsed / 100,
                                    ),
                                  ))
                              }
                            />
                          </svg>
                          <span className="chat-token-meter-badge">
                            {formatCompactTokens(activeTokenMeter.remaining)}
                          </span>
                        </button>
                        {tokenPopoverOpen ? (
                          <div
                            className="chat-token-popover"
                            role="dialog"
                            aria-label="Detalle de uso de tokens"
                          >
                            <div className="chat-token-popover-head">
                              <span className="chat-token-popover-title">
                                Contexto y Tokens
                              </span>
                              <span className="chat-token-popover-pill">
                                {activeTokenMeter.providerLabel}
                              </span>
                            </div>
                            <div className="chat-token-popover-model">
                              <strong>{activeTokenMeter.modelLabel}</strong>
                              <span>Key #{activeTokenMeter.keyFingerprint.slice(0, 6)}</span>
                            </div>
                            <div className="chat-token-popover-bar">
                              <span
                                style={{
                                  width: `${Math.max(
                                    activeTokenMeter.used > 0 ? 3 : 0,
                                    Math.min(100, activeTokenMeter.pctUsed),
                                  )}%`,
                                }}
                              />
                            </div>
                            <div className="chat-token-popover-grid">
                              <div>
                                <span>Restantes</span>
                                <strong>
                                  {formatNumber(activeTokenMeter.remaining)} (
                                  {activeTokenMeter.pctRemaining.toFixed(1)}%)
                                </strong>
                              </div>
                              <div>
                                <span>Usados</span>
                                <strong>
                                  {formatNumber(activeTokenMeter.used)} /{" "}
                                  {formatCompactTokens(activeTokenMeter.budget)}
                                </strong>
                              </div>
                              <div>
                                <span>Prompt / Resp.</span>
                                <strong>
                                  {formatCompactTokens(activeTokenMeter.promptUsed)} /{" "}
                                  {formatCompactTokens(activeTokenMeter.completionUsed)}
                                </strong>
                              </div>
                              <div>
                                <span>En borrador</span>
                                <strong>
                                  +{formatNumber(activeTokenMeter.draftTokens)} tok
                                </strong>
                              </div>
                            </div>
                            {availableModels.length > 0 ? (
                              <div className="chat-token-models-section">
                                <div className="chat-token-models-head">
                                  <span>Modelos disponibles (según tu API Key)</span>
                                </div>
                                <div
                                  className="chat-token-models-list"
                                  role="listbox"
                                  aria-label="Seleccionar modelo de IA"
                                >
                                  {availableModels.map((opt) => {
                                    const isSelected = opt.id === activeTokenMeter.model;
                                    return (
                                      <button
                                        key={`${opt.provider}:${opt.id}`}
                                        type="button"
                                        role="option"
                                        aria-selected={isSelected}
                                        className={
                                          isSelected
                                            ? "chat-token-model-item is-selected"
                                            : "chat-token-model-item"
                                        }
                                        onClick={() => selectLlmModel(opt)}
                                      >
                                        <div className="chat-token-model-main">
                                          <span className="chat-token-model-name">
                                            {opt.label}
                                          </span>
                                          <span
                                            className={
                                              opt.recommended
                                                ? "chat-token-model-badge is-best"
                                                : "chat-token-model-badge"
                                            }
                                          >
                                            {opt.badge}
                                          </span>
                                        </div>
                                        <div className="chat-token-model-right">
                                          <span className="chat-token-model-cap">
                                            {formatCompactTokens(opt.token_budget)}
                                          </span>
                                          {isSelected ? (
                                            <Check
                                              size={13}
                                              strokeWidth={2.4}
                                              className="chat-token-model-check"
                                            />
                                          ) : null}
                                        </div>
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            ) : null}
                            <div className="chat-token-popover-foot">
                              <span>
                                Último turno:{" "}
                                {formatNumber(activeTokenMeter.lastTurnTokens)} tok
                              </span>
                              <button
                                type="button"
                                className="chat-token-reset-btn"
                                onClick={() => {
                                  setTokenMeters((prev) => {
                                    const next = { ...prev };
                                    delete next[activeTokenMeter.meterId];
                                    saveTokenMeters(next);
                                    return next;
                                  });
                                }}
                              >
                                Reiniciar
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      {draft.trim() || pendingAttach ? (
                        <button
                          type="submit"
                          className="chat-composer-send is-icon"
                          aria-label="Enviar"
                        >
                          <ArrowUpRight size={17} aria-hidden="true" />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="chat-composer-icon"
                          aria-label="Dictar"
                          title="Dictar"
                        >
                          <Mic size={18} strokeWidth={1.8} />
                        </button>
                      )}
                    </div>
                  </form>
                </div>
              </section>
              {chatStarted ? (
                <aside
                  className={`chat-viewer${
                    showSideViewer && activeSideCompanion
                      ? " is-filled is-docked"
                      : " is-slot is-docked"
                  }`}
                  ref={viewerRailRef}
                  aria-label="Visor del chatbot"
                  aria-hidden={!showSideViewer}
                >
                  {showSideViewer && activeSideCompanion ? (
                    <div
                      key={activeSideCompanion.messageId}
                      className="chat-viewer-dock-item"
                    >
                      <ChatViewer
                        inventory={items}
                        resultItems={activeSideCompanion.resultItems}
                        qrCards={activeSideCompanion.qrCards}
                        overview={activeSideCompanion.overview}
                        overviewFocus={activeSideCompanion.overviewFocus}
                        onSelectAreaOption={(areaName) => {
                          void sendChat(areaName);
                        }}
                        onSelectPersonOption={(personName) => {
                          void sendChat(personName);
                        }}
                        onSelectItem={(item) => {
                          const rawId = item.id;
                          const id =
                            rawId == null || String(rawId) === ""
                              ? NaN
                              : Number(rawId);
                          const etq = String(item.etiqueta ?? "")
                            .trim()
                            .toLowerCase();
                          const origen = String(item.origen ?? "").trim();
                          const match =
                            (Number.isFinite(id) && id > 0
                              ? items.find((row) => Number(row.id) === id)
                              : undefined) ||
                            (etq
                              ? items.find((row) => {
                                  const sameEtq =
                                    String(row.etiqueta ?? "")
                                      .trim()
                                      .toLowerCase() === etq;
                                  if (!sameEtq) return false;
                                  if (!origen) return true;
                                  return (
                                    String(row.origen ?? "").trim() === origen
                                  );
                                })
                              : undefined) ||
                            (etq
                              ? items.find(
                                  (row) =>
                                    String(row.etiqueta ?? "")
                                      .trim()
                                      .toLowerCase() === etq,
                                )
                              : undefined);

                          setSelectedProduct(
                            match || (item as InventarioRow),
                          );
                        }}
                      />
                    </div>
                  ) : null}
                </aside>
              ) : null}
            </div>
          ) : null}

          {rail === "reportes" ? (
            <Suspense fallback={<div className="panel notice">Cargando reportes…</div>}>
              <ReportsView items={items} onSelectProduct={setSelectedProduct} />
            </Suspense>
          ) : null}

          {rail !== "avisos" && rail !== "archivos" && rail !== "reportes" ? (
            <section className="panel sheet" aria-labelledby="table-title">
              <div className="sheet-heading">
                <div>
                  <h2 id="table-title">
                    {rail === "personas"
                      ? selectedFolder
                        ? `Artículos de ${selectedFolder.name}`
                        : peopleSearch.trim()
                          ? "Artículos encontrados"
                          : "Artículos (asignados y sin asignar)"
                      : rail === "areas"
                        ? selectedFolder
                          ? `Artículos de ${selectedFolder.name}`
                          : "Artículos por área"
                        : rail === "estado"
                          ? "Estado del artículo"
                          : "Todos los artículos"}
                  </h2>
                  <p>
                    {formatNumber(visible.length)}{" "}
                    {visible.length === 1 ? "artículo" : "artículos"}
                    {selectMode && selectedRowIds.length
                      ? ` · ${formatNumber(selectedRowIds.length)} seleccionados`
                      : ""}
                  </p>
                </div>
                <div className="sheet-heading-actions">
                  {query ? <span className="filter-indicator">Filtrado por búsqueda</span> : null}
                  {selectedFolder ? (
                    <button type="button" className="btn-full-inventory is-solid" onClick={showFullInventory}>
                      Ver todo el inventario
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={selectMode ? "btn-select-mode is-active" : "btn-select-mode"}
                    onClick={toggleSelectMode}
                    aria-pressed={selectMode}
                  >
                    <ListChecks size={15} />
                    <span>{selectMode ? "Cancelar selección" : "Seleccionar"}</span>
                  </button>
                </div>
              </div>

              {selectMode || undoStack.length ? (
                <div className="bulk-toolbar" role="toolbar" aria-label="Acciones de selección">
                  {selectMode ? (
                    <>
                      <button
                        type="button"
                        className="btn-bulk"
                        onClick={allVisibleSelected ? clearRowSelection : selectAllVisible}
                        disabled={!visibleRowIds.length || bulkBusy}
                      >
                        <Check size={14} />
                        <span>{allVisibleSelected ? "Quitar todo" : "Seleccionar todo"}</span>
                      </button>
                      <button
                        type="button"
                        className="btn-bulk is-danger"
                        onClick={() => setConfirmBulkDelete(true)}
                        disabled={!selectedRowIds.length || bulkBusy}
                      >
                        <Trash2 size={14} />
                        <span>
                          Eliminar
                          {selectedRowIds.length ? ` (${selectedRowIds.length})` : ""}
                        </span>
                      </button>
                    </>
                  ) : null}
                  {undoStack.length ? (
                    <button
                      type="button"
                      className="btn-bulk is-undo"
                      onClick={handleUndoDelete}
                      disabled={bulkBusy}
                      title="Restaurar los últimos artículos eliminados"
                    >
                      <Undo2 size={14} />
                      <span>
                        Deshacer ({undoStack.length}{" "}
                        {undoStack.length === 1 ? "artículo" : "artículos"})
                      </span>
                    </button>
                  ) : null}
                  {bulkError ? <p className="bulk-error">{bulkError}</p> : null}
                </div>
              ) : null}

              {confirmBulkDelete ? (
                <div className="bulk-confirm" role="alertdialog" aria-labelledby="bulk-delete-title">
                  <div>
                    <h3 id="bulk-delete-title">
                      ¿Eliminar {selectedRowIds.length}{" "}
                      {selectedRowIds.length === 1 ? "artículo" : "artículos"}?
                    </h3>
                    <p>
                      Se borrarán de la base de datos. Podrás usar <strong>Deshacer</strong> justo
                      después si fue un error.
                    </p>
                  </div>
                  <div className="bulk-confirm-actions">
                    <button
                      type="button"
                      className="btn-bulk"
                      onClick={() => setConfirmBulkDelete(false)}
                      disabled={bulkBusy}
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      className="btn-bulk is-danger"
                      onClick={handleBulkDelete}
                      disabled={bulkBusy}
                    >
                      <Trash2 size={14} />
                      <span>{bulkBusy ? "Eliminando..." : "Sí, eliminar"}</span>
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="table-wrap" ref={tableRef} tabIndex={0} aria-label="Tabla de artículos">
                <table>
                  <thead>
                    <tr>
                      {COLUMNS.map(([key, label]) => (
                        <th key={label} scope="col" className={columnClassName(key)}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayedRows.map((row, index) => {
                      const rowId = Number(row.id);
                      const hasId = Number.isFinite(rowId);
                      return (
                        <InventoryTableRow
                          key={row.id ?? `${textOf(row.etiqueta)}-${textOf(row.origen)}-${index}`}
                          row={row}
                          selectMode={selectMode}
                          isChecked={hasId && selectedRowIds.includes(rowId)}
                          onToggle={toggleRowSelection}
                          onOpen={openProductRow}
                        />
                      );
                    })}
                    {!visible.length ? (
                      <tr>
                        <td className="table-empty" colSpan={COLUMNS.length}>
                          {query
                            ? "No se encontraron artículos con esa búsqueda."
                            : "No hay artículos para mostrar."}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </main>
      </div>

      {/* Modal para añadir nuevo producto (QR o Manual) */}
      <AddProductModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onCreated={handleProductCreated}
        existingAreas={existingAreas}
        existingPeople={existingPeople}
        items={items}
      />

      {/* Modal de Detalle y Modificación / Eliminación de Producto */}
      <ProductDetailModal
        product={selectedProduct}
        isOpen={Boolean(selectedProduct)}
        onClose={() => setSelectedProduct(null)}
        onUpdated={handleProductUpdated}
        onDeleted={handleProductDeleted}
        existingAreas={existingAreas}
        existingPeople={existingPeople}
        existingOrigens={inventarioOptions}
      />

      {pendingChatDeleteRow ? (
        <ChatChoiceModal
          titleId="chat-delete-record-title"
          title="Eliminar registro"
          subtitle={`${String(pendingChatDeleteRow.etiqueta ?? "").trim() || `ID ${pendingChatDeleteRow.id}`}${
            pendingChatDeleteRow.articulo
              ? ` — ${pendingChatDeleteRow.articulo}`
              : ""
          }`}
          onDismiss={() => {
            if (!chatDeleteBusy) setPendingChatDeleteRow(null);
          }}
          keep={{
            title: "Cancelar",
            body: "El registro se queda en el inventario. No se borra nada.",
            action: "Volver al chat",
            disabled: chatDeleteBusy,
            onClick: () => setPendingChatDeleteRow(null),
          }}
          drop={{
            title: chatDeleteBusy ? "Eliminando…" : "Borrar",
            body: "No podrás deshacerlo desde el chat. El artículo sale del inventario.",
            action: "Eliminar registro",
            disabled: chatDeleteBusy,
            onClick: () => {
              void confirmChatDeleteRecord();
            },
          }}
        />
      ) : null}
    </div>
  );
}
