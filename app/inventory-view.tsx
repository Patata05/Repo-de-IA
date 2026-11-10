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
} from "@/app/actions";
import AddProductModal from "@/components/add-product-modal";
import ChatViewer from "@/components/chat-viewer";
import ProductDetailModal from "@/components/product-detail-modal";
import {
  askInventoryChat,
  type ChatApiItem,
  type ChatQrPayload,
} from "@/lib/chat-api";
import { parseInventarioImportFile } from "@/lib/import-inventario-file";
import {
  matchOrigenFromPrompt,
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
  indexMatchesPrepared,
  prepareSearch,
  rowMatchesPrepared,
} from "@/lib/inventario-search";
const ReportsView = lazy(() => import("@/components/reports-view"));

const CHAT_QUICK_ACTIONS = [
  { label: "Buscar por persona", prompt: "¿Qué tiene Juan Pérez?", icon: Users },
  { label: "Equipos por área", prompt: "Equipos de Sistemas", icon: MapPin },
  { label: "Últimos registros", prompt: "Últimos registros", icon: ListChecks },
  { label: "Ideas de consulta", prompt: "¿Qué puedo preguntarte del inventario?", icon: Lightbulb },
] as const;

type ViewerOverview =
  | "full"
  | "stats"
  | "areas"
  | "areaTotal"
  | "personTotal"
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
const MAX_CHAT_SESSIONS = 50;
const CHAT_USER_COLLAPSE_AT = 160;
const PERSONA_SIN_ASIGNAR_ID = "__SIN_ASIGNAR__";
const PERSONA_SIN_ASIGNAR_NAME = "Sin asignar";

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
 */
function parseEtiquetaListAsk(userText: string): number | null {
  const n = normalizeChatIntent(userText);
  if (!n || !/\betiquet/.test(n)) return null;
  if (/\bqr\b/.test(n)) return null;
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

function areaMatchesNeedle(area: string, needle: string) {
  const a = normalizePlain(area);
  const n = normalizePlain(needle);
  if (!a || !n) return false;
  if (a === n || a.includes(n) || n.includes(a)) return true;
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
      if (t.length <= 2 || AREA_STOP_WORDS.has(t)) return false;
      // "inventario general" no es el área llamada "general".
      if (t === "general" && toks[i - 1] === "inventario") return false;
      return true;
    });
  if (!raw.length) return undefined;

  const { tokens: areaTokens } = getAreaSearchIndex(inventory);
  let best: { token: string; score: number } | null = null;
  for (const cand of raw) {
    // Exacto / substring primero (barato).
    for (const tok of areaTokens) {
      if (cand === tok) {
        return tok;
      }
      if (tok.includes(cand) || cand.includes(tok)) {
        const score = Math.min(tok.length, cand.length) + 20;
        if (!best || score > best.score) best = { token: tok, score };
      }
    }
    if (best && best.score >= 24) continue;
    const budget = typoBudget(cand);
    if (budget <= 0) continue;
    for (const tok of areaTokens) {
      if (Math.abs(tok.length - cand.length) > budget) continue;
      const dist = levenshtein(cand, tok);
      if (dist <= budget) {
        const score = tok.length + 10 - dist;
        if (!best || score > best.score) best = { token: tok, score };
        if (dist === 1) break;
      }
    }
  }
  return best?.token;
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
  if (Math.abs(a.length - b.length) > 2) return 99;
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
  return 2;
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
      if (tok.length <= 2) continue;
      tokenSet.add(tok);
      const list = byToken.get(tok);
      if (list) {
        if (list.length < 8 && !list.includes(area)) list.push(area);
      } else {
        byToken.set(tok, [area]);
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
  recentMessages?: Array<{ from: string; text: string; resultItems?: ChatApiItem[] }>,
): string | undefined {
  const named = findPersonInText(userText, inventory);
  if (named) return named;
  if (!looksLikePersonAnaphora(userText) || !recentMessages?.length) {
    return undefined;
  }
  const current = normalizeChatIntent(userText);
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
  dimelos: "dame",
  dimelo: "dame",
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
 * Tip interactivo opcional (no siempre): elige la incidencia más útil
 * o nada, para no saturar.
 */
function pickDiscoveryTip(
  userText: string,
): ViewerOverview | undefined {
  const n = normalizeChatIntent(userText);
  // Mayoría solo texto; a veces un tip útil a la derecha.
  if (Math.random() > 0.34) return undefined;
  if (/\b(hoy|dia|nuev|recient)\b/.test(n)) return "recent";
  const roll = Math.random();
  if (roll < 0.4) return "stats";
  if (roll < 0.7) return "areas";
  return "recent";
}

/** Pausa mínima para ver “escribiendo…” (corta; lo lento era el LLM). */
function assistantTypingDelayMs(reply: string) {
  const len = String(reply || "").trim().length;
  return Math.min(700, Math.max(280, 220 + Math.min(len, 160)));
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
    return "areas";
  }

  if (
    !asksSpecificOwner &&
    intentHas(user, "personas", "persona") &&
    (askVerb ||
      intentHas(user, "por", "top", "desglose", "cuantas", "cuantos", "todas", "todos") ||
      /^(personas?|por\s+personas?)$/.test(user))
  ) {
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

function renderChatRichText(text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
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
    return <span key={index}>{part}</span>;
  });
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
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
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
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
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
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".sidebar-history-menu")) return;
      if (target?.closest(".sidebar-history-more")) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
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
  const hasAnySidePanel = useMemo(
    () => messages.some((message) => messageHasSideData(message)),
    [messages],
  );

  const sideCompanions = useMemo(
    () =>
      messages
        .filter((message) => messageHasSideData(message))
        .map((message) => ({
          messageId: message.id,
          resultItems: Array.isArray(message.resultItems)
            ? message.resultItems
            : [],
          qrCards: chatQrByMsg[message.id] || [],
          overview: message.viewerOverview,
          overviewFocus: message.viewerFocus,
        })),
    [messages, chatQrByMsg],
  );

  const chatTurns = useMemo(() => {
    const turns: Array<
      | { kind: "single"; message: ChatMessage }
      | { kind: "pair"; user: ChatMessage; bot: ChatMessage }
    > = [];
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      const next = messages[i + 1];
      if (
        message.from === "user" &&
        next?.from === "bot" &&
        messageHasSideData(next)
      ) {
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

  useEffect(() => {
    if (rail !== "archivos") return;
    const frame = window.requestAnimationFrame(() => {
      const anchor = chatLogRef.current?.querySelector<HTMLElement>(
        "[data-chat-latest='true']",
      );
      if (!anchor) return;
      // auto: smooth + sync de layout pelean y traban el scroll
      anchor.scrollIntoView({ block: "start", behavior: "auto", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, rail, hasAnySidePanel]);

  // Columna derecha: cada cuadro sigue el Y de su mensaje.
  // El scroll general es el del stage (barra a la derecha).
  useLayoutEffect(() => {
    if (rail !== "archivos" || !hasAnySidePanel) return;
    const log = chatLogRef.current;
    const railEl = viewerRailRef.current;
    const stageEl = chatStageRef.current;
    if (!log || !railEl) return;

    const SYNC_NUDGE_PX = -10;
    const STICKY_TOP_PX = 12;
    const AFTER_GAP_PX = 28;
    // Misma reserva que --chat-viewer-slot-h (QR / etiquetas / inventario).
    const slotRaw = getComputedStyle(stageEl ?? railEl)
      .getPropertyValue("--chat-viewer-slot-h")
      .trim();
    const SIDE_SLOT_H = Math.max(300, parseInt(slotRaw, 10) || 480);
    let posRaf = 0;
    let layoutRaf = 0;
    const scrollRoot = stageEl ?? log;

    const clearSlots = () => {
      log.querySelectorAll<HTMLElement>("[data-side-msg]").forEach((el) => {
        el.style.minHeight = "";
      });
    };

    // Texto sube al scrollear; tope inicio (sticky) y tope final (arriba de acciones).
    const positionOnly = () => {
      const railTop = railEl.getBoundingClientRect().top;
      const stageTop = (stageEl ?? scrollRoot).getBoundingClientRect().top;
      const GAP = 12;
      const placed: Array<{ y: number; h: number; lo: number; hi: number }> = [];

      for (const node of railEl.querySelectorAll<HTMLElement>("[data-sync-msg]")) {
        const id = node.dataset.syncMsg;
        if (!id) continue;
        const anchor = log.querySelector<HTMLElement>(`[data-side-msg="${id}"]`);
        if (!anchor) {
          node.style.visibility = "hidden";
          continue;
        }
        node.style.visibility = "visible";
        const msg = anchor.getBoundingClientRect();
        const actionsEl = anchor.querySelector<HTMLElement>(
          ".chat-response-actions",
        );
        const textEl = anchor.querySelector<HTMLElement>(".chat-response");
        const panelH = Math.ceil(node.offsetHeight) || SIDE_SLOT_H;
        const yStart = msg.top - railTop + SYNC_NUDGE_PX;
        // Tope final = arriba de los botones (o fin del texto).
        const endBottom = actionsEl
          ? actionsEl.getBoundingClientRect().top - 8
          : textEl
            ? textEl.getBoundingClientRect().bottom
            : msg.bottom;
        const yEnd = endBottom - railTop - panelH;
        const ySticky = stageTop + STICKY_TOP_PX - railTop;
        const lo = yStart;
        const hi = yEnd >= yStart ? yEnd : yStart;

        let y = ySticky;
        if (y < lo) y = lo;
        if (y > hi) y = hi;

        // Si se traslapa con otro cuadro, mover dentro del mismo tope inicio/final.
        for (const prev of placed) {
          const overlaps =
            y < prev.y + prev.h + GAP && y + panelH > prev.y - GAP;
          if (!overlaps) continue;
          const down = prev.y + prev.h + GAP;
          const up = prev.y - panelH - GAP;
          if (down <= hi) y = Math.min(Math.max(down, lo), hi);
          else if (up >= lo) y = Math.min(Math.max(up, lo), hi);
        }

        y = Math.round(y);
        placed.push({ y, h: panelH, lo, hi });
        const next = `translate3d(0, ${y}px, 0)`;
        if (node.style.transform !== next) node.style.transform = next;
      }
    };

    const layoutSlots = () => {
      for (const node of railEl.querySelectorAll<HTMLElement>("[data-sync-msg]")) {
        const id = node.dataset.syncMsg;
        if (!id) continue;
        const anchor = log.querySelector<HTMLElement>(`[data-side-msg="${id}"]`);
        if (!anchor) continue;
        const main =
          anchor.querySelector<HTMLElement>(".chat-turn-main") ?? anchor;
        const contentH = Math.ceil(main.offsetHeight);
        const next = `${Math.max(contentH, SIDE_SLOT_H) + AFTER_GAP_PX}px`;
        if (anchor.style.minHeight !== next) {
          anchor.style.boxSizing = "border-box";
          anchor.style.minHeight = next;
        }
      }
      positionOnly();
    };

    const schedulePos = () => {
      if (posRaf) return;
      posRaf = window.requestAnimationFrame(() => {
        posRaf = 0;
        positionOnly();
      });
    };

    // Sync (antes del paint): Mostrar más / ResizeObserver del panel.
    const positionNow = () => {
      if (posRaf) {
        window.cancelAnimationFrame(posRaf);
        posRaf = 0;
      }
      positionOnly();
    };

    const scheduleLayout = () => {
      if (layoutRaf) return;
      layoutRaf = window.requestAnimationFrame(() => {
        layoutRaf = 0;
        layoutSlots();
      });
    };

    layoutSlots();
    scrollRoot.addEventListener("scroll", schedulePos, { passive: true });
    window.addEventListener("resize", scheduleLayout);
    window.addEventListener("chat-viewer-layout", positionNow);
    // Anclas del chat → layout. Paneles (Mostrar más) → reposicionar sync (sin parpadeo).
    const roAnchors = new ResizeObserver(scheduleLayout);
    for (const anchor of log.querySelectorAll<HTMLElement>("[data-side-msg]")) {
      roAnchors.observe(anchor.querySelector(".chat-turn-main") ?? anchor);
    }
    const roPanels = new ResizeObserver(positionNow);
    for (const node of railEl.querySelectorAll<HTMLElement>("[data-sync-msg]")) {
      roPanels.observe(node);
      const body = node.querySelector<HTMLElement>(".chat-viewer-sync-body");
      if (body) roPanels.observe(body);
      const scroll = node.querySelector<HTMLElement>(".chat-viewer-scroll");
      if (scroll) roPanels.observe(scroll);
    }
    return () => {
      if (posRaf) window.cancelAnimationFrame(posRaf);
      if (layoutRaf) window.cancelAnimationFrame(layoutRaf);
      scrollRoot.removeEventListener("scroll", schedulePos);
      window.removeEventListener("resize", scheduleLayout);
      window.removeEventListener("chat-viewer-layout", positionNow);
      roAnchors.disconnect();
      roPanels.disconnect();
      clearSlots();
    };
  }, [rail, hasAnySidePanel, sideCompanions, messages]);

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
        etiquetaLimit == null &&
        hasConcreteInventoryAsk(userText, items, messages)
      ) {
        const history = messages.slice(0, index).map((item) => ({
          from: item.from,
          text: item.text || "",
          resultItems: item.resultItems,
        }));
        const focusPerson = detectPersonTotalAsk(userText, items, history);
        const focusArea = focusPerson
          ? undefined
          : detectAreaTotalAsk(userText, items);
        const overview = focusPerson
          ? ("personTotal" as ViewerOverview)
          : focusArea
            ? ("areaTotal" as ViewerOverview)
            : detectViewerOverview(userText);
        const viewerFocus = focusPerson || focusArea;
        if (overview) {
          changed = true;
          lastSide = {
            resultItems: [],
            qr: [],
            viewerOverview: overview,
            viewerFocus,
          };
          return {
            ...message,
            resultItems: [],
            qr: undefined,
            viewerOverview: overview,
            viewerFocus,
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
    const onPointer = (event: MouseEvent) => {
      if (!chatAttachRef.current?.contains(event.target as Node)) {
        setAttachMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
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
    /^(sí|si|yes|confirma|confirmo|adelante|ok|okay|okey|vale|dale|claro|listo|de acuerdo|importar|hazlo|procede|proceder)\b/i.test(
      value.trim(),
    );

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
                }
              : null),
          }
        : m,
    );
    messagesRef.current = finalMessages;
    setMessages(finalMessages);
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
        `Inventario: **${formatNumber(totalBefore)}** → **${formatNumber(totalAfter)}** registros.${skipNote}\n\n` +
        `Te dejé el inventario general en el panel derecho (totales, áreas y recientes).`;

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

      finishBotReply(sessionId, botId, finalReply, {
        resultItems: [],
        qr: [],
        viewerOverview: "full",
      });
    };

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
    if (pendingRows?.length && isAffirmativeChat(text)) {
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
        const askedOrigen = matchOrigenFromPrompt(text || userText, existingOrigens);
        const origen =
          askedOrigen ||
          (selectedInventarios[0] && selectedInventarios[0] !== "ALL"
            ? selectedInventarios[0]
            : ORIGEN_SIN_ORIGEN);
        const parsed = await parseInventarioImportFile(attach.file, origen);
        if (!parsed.items.length) {
          setPendingChatImportSafe(null);
          finishBotReply(
            sessionId,
            botId,
            "No encontré filas válidas en el archivo (faltan Etiqueta o Artículo).",
          );
          return;
        }
        setPendingChatImportSafe(parsed.items);
        const n = parsed.items.length;
        const sample = parsed.items
          .slice(0, 5)
          .map((item) => `• ${item.etiqueta} — ${item.articulo}`)
          .join("\n");
        const more =
          n > 5 ? `\n…y ${formatNumber(n - 5)} más.` : "";
        const destNote = askedOrigen
          ? `Claro: **sí haré eso**. Voy a agregar este archivo a **${origen}**, no a ${ORIGEN_SIN_ORIGEN}.`
          : `Claro: leí el archivo y lo dejaré listo para importar en **${origen}**.`;
        finishBotReply(
          sessionId,
          botId,
          `${destNote}\n\n` +
            `“${attach.name}” tiene **${formatNumber(n)}** registro${n === 1 ? "" : "s"} con etiqueta y artículo.\n` +
            `${sample}${more}\n\n` +
            `¿Quieres que empiece a importarlos ahora a **${origen}**? Responde **sí** (o escribe importar).`,
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
    }));

    // Inventario de una persona: mismos totales que el general, acotados a ella.
    const earlyPerson = detectPersonTotalAsk(
      userText || text,
      items,
      chatHistory,
    );
    if (earlyPerson) {
      try {
        const localReply = buildPersonTotalReply(earlyPerson, items);
        await ensureTypingPause(localReply);
        finishBotReply(sessionId, botId, localReply, {
          resultItems: [],
          qr: [],
          viewerOverview: "personTotal",
          viewerFocus: earlyPerson,
        });
      } catch {
        /* abort / nuevo mensaje */
      }
      return;
    }

    // Total de un área: respuesta + incidencia locales (exacto, con pausa de tipeo).
    const earlyArea = detectAreaTotalAsk(userText || text, items);
    if (earlyArea) {
      try {
        const localReply = buildAreaTotalReply(earlyArea, items);
        await ensureTypingPause(localReply);
        finishBotReply(sessionId, botId, localReply, {
          resultItems: [],
          qr: [],
          viewerOverview: "areaTotal",
          viewerFocus: earlyArea,
        });
      } catch {
        /* abort / nuevo mensaje */
      }
      return;
    }

    // Lista de registros/etiquetas de un área → local (tablita, no ranking de áreas).
    const earlyAreaList = detectAreaListAsk(userText || text, items);
    if (earlyAreaList) {
      try {
        const rows = rowsForAreaNeedle(
          items,
          earlyAreaList.area,
          earlyAreaList.limit,
        );
        const localReply = buildAreaListReply(earlyAreaList.area, rows);
        await ensureTypingPause(localReply);
        finishBotReply(sessionId, botId, localReply, {
          resultItems: rows.map((row) => rowToChatApiItem(row)),
          qr: [],
          viewerOverview: "areaTotal",
          viewerFocus: earlyAreaList.area,
        });
      } catch {
        /* abort / nuevo mensaje */
      }
      return;
    }

    const data = await askInventoryChat(userText || text, history, {
      signal: controller.signal,
      memory: formatChatMemoryForPrompt(),
    });
    if (
      requestGen !== chatRequestGenRef.current ||
      controller.signal.aborted ||
      data.error === "aborted"
    ) {
      return;
    }
    reply = (data.reply || "").trim() || reply;
    sideItems = data.items || [];
    mutated = Boolean(data.mutated);
    qrPayloads = data.qr || [];

    // Solo incidencia si el pedido es concreto o hubo escritura; saludos → texto (± tip).
    const forceSidePanel = wantsSidePanelShow(userText || text);
    const concreteAsk =
      hasConcreteInventoryAsk(userText || text, items, chatHistory) ||
      forceSidePanel;
    const exploratoryAsk =
      !concreteAsk && !mutated && isExploratoryChatAsk(userText || text);
    if (!concreteAsk && !mutated) {
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
      // Recuperar ficha en el visor (prompt, reply o contexto reciente).
      let recovered = resolveRecordRowsFromPrompt(
        userText || text,
        reply,
        items,
      );
      if (!recovered.length) {
        recovered = resolveContextualRecordRows(
          items,
          messagesRef.current.map((m) => ({
            from: m.from,
            text: m.text || "",
          })),
        );
      }
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
    let askedOverview: ViewerOverview | undefined = mutated || areaListAsk
      ? undefined
      : concreteAsk
        ? focusPerson
          ? "personTotal"
          : focusArea
            ? "areaTotal"
            : detectViewerOverview(userText || text) || forcedOverview
        : exploratoryAsk
          ? pickDiscoveryTip(userText || text)
          : forcedOverview;
    // Si hay etiqueta/QR / lista de área, no tapar con ranking de Áreas.
    const overview =
      qrPayloads.length ||
      (mutated && sideItems.length) ||
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
    if (overview) {
      sideItems = [];
      qrPayloads = [];
    }
    if (
      overview &&
      exploratoryAsk &&
      !/\bvisor|panel derecho|derecha\b/i.test(reply)
    ) {
      reply =
        `${reply}\n\nTe dejé un vistazo rápido en el panel derecho por si quieres explorar.`.trim();
    }
    if (mutated) {
      reply = reply
        .replace(
          /\n*\s*Te dejé un vistazo rápido en el panel derecho por si quieres explorar\.?\s*/gi,
          "\n",
        )
        .trim();
    }
    const hasNewSide =
      sideItems.length > 0 || qrPayloads.length > 0 || Boolean(overview);

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
            const newValue = String(after[field] ?? "").trim();
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
                      <h2 className="chat-home-title">
                        Hola. ¿Qué quieres consultar del inventario?
                      </h2>
                      <div className="chat-quick-actions">
                        {CHAT_QUICK_ACTIONS.map(({ label, prompt, icon: Icon }) => (
                          <button
                            key={label}
                            type="button"
                            className="chat-quick-action"
                            onClick={() => sendChat(prompt)}
                          >
                            <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
                            <span>{label}</span>
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
                            <div className="chat-response">
                              {renderChatRichText(message.text)}
                            </div>
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
                                <Copy size={15} strokeWidth={1.8} />
                              </button>
                              <button
                                type="button"
                                className="chat-response-action"
                                title="Compartir"
                                aria-label="Compartir respuesta"
                              >
                                <Share2 size={15} strokeWidth={1.8} />
                              </button>
                              <button
                                type="button"
                                className="chat-response-action"
                                title="Me gusta"
                                aria-label="Me gusta"
                              >
                                <ThumbsUp size={15} strokeWidth={1.8} />
                              </button>
                              <button
                                type="button"
                                className="chat-response-action"
                                title="No me gusta"
                                aria-label="No me gusta"
                              >
                                <ThumbsDown size={15} strokeWidth={1.8} />
                              </button>
                              <button
                                type="button"
                                className="chat-response-action"
                                title="Más"
                                aria-label="Más opciones"
                              >
                                <MoreVertical size={15} strokeWidth={1.8} />
                              </button>
                            </div>
                          </div>
                          );
                        };

                        if (turn.kind === "pair") {
                          return (
                            <section
                              className="chat-turn"
                              key={`pair-${turn.user.id}-${turn.bot.id}`}
                              data-chat-latest={isLatest ? "true" : undefined}
                              data-side-msg={turn.bot.id}
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
                  className={`chat-viewer${hasAnySidePanel ? " is-filled is-sync" : " is-slot"}`}
                  ref={viewerRailRef}
                  aria-label="Visor del chatbot"
                  aria-hidden={!hasAnySidePanel}
                >
                  {hasAnySidePanel
                    ? sideCompanions.map((companion) => (
                        <div
                          key={companion.messageId}
                          className="chat-viewer-sync-item"
                          data-sync-msg={companion.messageId}
                        >
                          <ChatViewer
                            inventory={items}
                            resultItems={companion.resultItems}
                            qrCards={companion.qrCards}
                            overview={companion.overview}
                            overviewFocus={companion.overviewFocus}
                            onSelectItem={(item) => {
                              const rawId = item.id;
                              const id =
                                rawId == null || rawId === ""
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
                                        String(row.origen ?? "").trim() ===
                                        origen
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

                              // Sin startTransition: debe abrir la ficha al toque
                              setSelectedProduct(
                                match || (item as InventarioRow),
                              );
                            }}
                          />
                        </div>
                      ))
                    : null}
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
