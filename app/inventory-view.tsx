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
import { readInventario } from "@/lib/supabase";
import {
  addInventarioBulkAction,
  deleteInventarioAction,
  deleteInventarioByOrigensAction,
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
  resetChatSession,
  type ChatApiItem,
  type ChatApiResponse,
  type ChatComparacionVista,
  type ChatContextoVista,
  type ChatModelOption,
  type ChatQrPayload,
  type ChatTokenUsage,
} from "@/lib/chat-api";
import {
  enviarMensajeN8n,
  ejecutarAcciones,
  pickMostrarPanelAccion,
  type Accion,
  type N8nThreadFocus,
} from "@/lib/asistente";
import { parseInventarioImportFile } from "@/lib/import-inventario-file";
import {
  buildCreateInventarioAskReply,
  detectBulkCopyAllOthersToInventarioAsk,
  detectBulkCopyBetweenInventariosAsk,
  buildInventarioComparacion,
  detectCompareInventariosAsk,
  detectCompareScopedListAsk,
  detectCopyEtiquetaNeedsDestAsk,
  detectCopyEtiquetasToInventarioAsk,
  detectCopyPersonRecordsToInventarioAsk,
  diffRowsAgainstInventario,
  detectCreateInventarioAsk,
  detectDuplicateEtiquetasAsk,
  detectExcludedEtiquetasAsk,
  detectFillNewInventarioAsk,
  canonicalizeOrigenLabel,
  detectListInventariosAsk,
  diffInventarios,
  displayOrigenLabel,
  findDuplicateEtiquetas,
  formatDuplicateEtiquetasReply,
  formatInventarioDiffReply,
  listExistingOrigens,
  looksLikeNonFillInventarioAsk,
  matchOrigenFromPrompt,
  nextFileOrigenFromFileName,
  nextInventarioName,
  normalizeOrigenLabel,
  origenCurrencyRank,
  origensMatch,
  pickSourceRowsForEtiquetas,
  planImportOrigen,
  resolveFuenteOrigen,
  rowToNewInventarioItem,
  inventarioNumber,
  ORIGEN_SIN_ORIGEN,
  type PendingNewInventario,
} from "@/lib/inventario-origen";
import { normalizeChatSpellingAsync } from "@/lib/chat-spell";
import {
  detectInventarioMultiPlan,
  looksLikeInventarioMultiAsk,
} from "@/lib/chat-multi-plan";
import {
  detectChatDeleteIntent,
  formatDeleteDoneFallback,
  formatDeleteModalPrompt,
  formatDeleteSoftConfirm,
  formatOrigensListEs,
  looksLikeDeleteInventoryAsk,
  looksLikeWipeAllInventariosAsk,
  planDeleteOrigens,
  resolveChatDeleteRows,
  type ChatDeletePlan,
} from "@/lib/chat-delete-plan";
import { formatInventarioQrCompact } from "@/lib/inventario-qr";
import {
  answerFromMemoryAboutBefore,
  buildCrossChatHistorySnippet,
  buildMutationConfirmReply,
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
  analyzeChatTurn,
  rowsByEtiquetaPrefix,
  type ChatTurnAnalysis,
} from "@/lib/chat-intent";
import { resolveChatTurnContext } from "@/lib/chat-turn-context";
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
import { composeChatReply } from "@/lib/chat-compose";

/**
 * Redacción conversacional vía Backend (OpenAI gpt-4o-mini).
 * Los "fallback" son solo hechos crudos si el compose no responde.
 */
async function polishInventoryReply(opts: {
  userText: string;
  kind: string;
  fallback: string;
  threadHint?: string;
  facts: Record<string, unknown>;
  sessionId?: string | null;
}): Promise<{ reply: string; followUps?: ChatFollowUp[] }> {
  const polished = await composeChatReply({
    userText: opts.userText,
    kind: opts.kind,
    threadHint: opts.threadHint || "",
    fallback: opts.fallback,
    facts: {
      ...opts.facts,
      // Evita que el modelo copie plantillas locales literales.
      plantilla_sugerida: undefined,
      tono: "conversacional_natural",
      prohibido_copiar_plantilla: true,
    },
    sessionId: opts.sessionId,
  });
  const reply = String(polished.reply || opts.fallback || "").trim();
  const followUps =
    polished.followUps.length > 0
      ? polished.followUps.map((label) => ({ label, prompt: label }))
      : undefined;
  return { reply, followUps };
}

/** Lote autorizado por confirmar_exportacion_excel → tarjeta .xlsx. */
async function buildExportFilesFromApiItems(
  apiItems: ChatApiItem[],
  focus: string,
): Promise<ChatExportFile[]> {
  const rows = apiItems.map((item) => ({
    id: item.id ?? null,
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
    updated_at: null,
  })) as InventarioRow[];
  if (!rows.length) return [];
  return [
    await buildInventarioExcelFile(rows, {
      focus: focus || "Inventario",
    }),
  ];
}

const ReportsView = lazy(() => import("@/components/reports-view"));

const CHAT_QUICK_ACTIONS = [
  {
    label: "Buscar por persona",
    hint: "Consulta qué artículos tiene asignados alguien.",
    prompt: "Búsqueda por persona",
    icon: Users,
  },
  {
    label: "Equipos por área",
    hint: "Lista el equipo registrado en un área concreta.",
    prompt: "Equipos por área",
    icon: MapPin,
  },
  {
    label: "Últimos registros",
    hint: "Revisa las altas más recientes del inventario.",
    prompt: "Últimos registros",
    icon: ListChecks,
  },
  {
    label: "Comparar inventarios",
    hint: "Diff real: faltan / sobran / cambiaron vs S/O.",
    prompt: "Comparar inventarios",
    icon: Layers,
  },
  {
    label: "Ideas de consulta",
    hint: "Descubre qué puedes preguntarle al asistente.",
    prompt: "Ideas de consulta",
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
  | "marcas"
  | "comparacion";

type ChatFollowUp = { label: string; prompt: string };

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
  /** Métricas del visor de comparación. */
  viewerComparacion?: ChatComparacionVista | null;
  /** Foco de la incidencia (ej. nombre de área en areaTotal). */
  viewerFocus?: string;
  /** Chips clicables bajo la respuesta. */
  followUps?: ChatFollowUp[];
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
/** Visor derecho: no truncar a 80 en copias/importaciones masivas. */
const CHAT_SIDE_RESULT_CAP = 2000;
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
  costUsd: number;
  updatedAt: number;
};

const DEFAULT_TOKEN_BUDGET = 128_000;

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
  return Math.max(1, Math.ceil(s.length / 4));
}

function formatCompactTokens(value: number): string {
  const raw = Number(value);
  // 0 es válido (sin uso); solo NaN/negativos caen al presupuesto por defecto.
  const n =
    Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : DEFAULT_TOKEN_BUDGET;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function normalizeModelTokenBudget(
  value: unknown,
  fallback = DEFAULT_TOKEN_BUDGET,
): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function formatUsd(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
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

/** Tope del visor: lo pedido (5/40/200…). Sin N → inventario completo. */
const MAX_ETIQUETA_LIST = CHAT_SIDE_RESULT_CAP;

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
  // “todo lo que está en el inventario 2…” ≠ anáfora de listado.
  if (
    /\binventari/.test(n) &&
    /\b(mete\w*|pasa\w*|copia\w*|importa\w*|mueve\w*|continua\w*|omite\w*|todo|faltantes?)\b/.test(
      n,
    )
  ) {
    return false;
  }
  if (/\besta\s+en\b/.test(n) || /\blo\s+que\s+esta\b/.test(n)) {
    return false;
  }
  if (
    /\b(esas|esos|estas|estos)\b/.test(n) ||
    /\b(esa|ese|este|esta)\s+(etiqueta|etiquetas|ficha|fichas|consulta|resultado|persona|area)\b/.test(
      n,
    ) ||
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

/** “último registro / recién metido / más recientes” (global, no del área previa). */
/**
 * “¿es de los últimos?” / “¿está entre los recientes?” → sí/no del hilo,
 * no listar los 10.
 */
function detectIsAmongRecentAsk(userText: string): boolean {
  const n = normalizeChatIntent(userText);
  if (!n) return false;
  if (
    /\b(dame|muestra|mostrar|lista|listar|trae|traer|ensena|enseñame|ensename|abr[e]?|abrir|genera)\b/.test(
      n,
    )
  ) {
    return false;
  }
  const aboutRecent =
    /\b(ultimos?|recientes?)\b/.test(n) ||
    /\bde\s+los\s+ultimos?\b/.test(n) ||
    /\bentre\s+los\s+(ultimos?|recientes?)\b/.test(n);
  if (!aboutRecent) return false;
  return (
    /\b(es|esta|estan|sera|fue|pertenece|pertenecen|aparece|aparecen|sale|salen|viene|vienen|incluye|incluido|incluida)\b/.test(
      n,
    ) ||
    /\b(es\s+de|esta\s+entre|esta\s+en|forma\s+parte|es\s+parte|de\s+los\s+ultimos|de\s+los\s+recientes)\b/.test(
      n,
    )
  );
}

/** Etiqueta del mensaje o del hilo (último registro del que hablamos). */
function resolveThreadFocusEtiqueta(
  userText: string,
  recentMessages: Array<{ from: string; text?: string; resultItems?: ChatApiItem[] }>,
  sideItems?: ChatApiItem[] | null,
): string | undefined {
  const pickMeaningful = (tags: string[]) => {
    for (const t of tags) {
      const s = String(t || "").trim();
      if (!s) continue;
      if (/^\d+$/.test(s) && s.length <= 2) continue;
      if (/^\d+$/.test(s) && Number(s) <= 20) continue;
      return s;
    }
    return undefined;
  };

  const fromText = (raw: string) => {
    const tags: string[] = [];
    for (const m of String(raw || "").matchAll(/\b(\d{3,12})\b/g)) {
      tags.push(m[1]);
    }
    for (const m of String(raw || "").matchAll(
      /\b([A-Za-z]{1,6}[-_]?\d{2,8})\b/g,
    )) {
      tags.push(m[1]);
    }
    tags.push(...extractEtiquetasFromText(raw));
    return pickMeaningful(tags);
  };

  const direct = fromText(userText);
  if (direct) return direct;

  if (sideItems?.length) {
    const uniq = [
      ...new Set(
        sideItems
          .map((it) => String(it.etiqueta ?? "").trim())
          .filter(Boolean),
      ),
    ];
    if (uniq.length >= 1 && uniq.length <= 6) {
      return uniq[0];
    }
  }

  for (let i = recentMessages.length - 1; i >= 0; i -= 1) {
    const m = recentMessages[i];
    if (m.from === "user") {
      const hit = fromText(m.text || "");
      if (hit) return hit;
    }
  }
  for (let i = recentMessages.length - 1; i >= 0; i -= 1) {
    const m = recentMessages[i];
    if (m.from !== "bot") continue;
    if (Array.isArray(m.resultItems) && m.resultItems.length) {
      const uniq = [
        ...new Set(
          m.resultItems
            .map((it) => String(it.etiqueta ?? "").trim())
            .filter(Boolean),
        ),
      ];
      if (uniq.length >= 1 && uniq.length <= 6) return uniq[0];
    }
    const hit = fromText(m.text || "");
    if (hit) return hit;
  }
  return undefined;
}

/**
 * “esos 10 / estos últimos: ¿en qué áreas / personas / inventarios?”
 * → agrega del listado del hilo; no volver a listar “últimos registros”.
 */
function detectScopedListFieldAsk(
  userText: string,
): { field: "area" | "persona" | "origen" | "estado" } | undefined {
  const n = normalizeChatIntent(userText);
  if (!n) return undefined;
  // “qué inventarios tenemos / cuál crear” = catálogo global, no orígenes del listado.
  if (
    /\b(inventarios?)\b/.test(n) &&
    /\b(tenemos|hay|existen|hechos|creados|cual|cuales|nuevo|crear|creamos|podremos|podemos)\b/.test(
      n,
    ) &&
    !/\b(esos|esas|este\s+listado|esta\s+consulta|de\s+arriba|ultimos?|recientes?)\b/.test(
      n,
    )
  ) {
    return undefined;
  }
  // Pedido puro de listar recientes (sin pregunta de campo).
  if (
    /\b(dame|muestra|mostrar|lista|listar|trae|traer|ensena|ensename)\b/.test(
      n,
    ) &&
    !/\b(area|areas|persona|personas|origen|inventari|estado|donde|encuentran|ubican)\b/.test(
      n,
    )
  ) {
    return undefined;
  }
  // No usar “esto/esta” sueltos (“antes de hacer esto”) como anáfora del listado.
  const scoped =
    /\b(estos|estas|esos|esas|ese|esa|este\s+listado|esta\s+consulta|los\s+de\s+arriba)\b/.test(
      n,
    ) ||
    /\b(ultimos?|recientes?)\s+\d*\s*registros?\b/.test(n) ||
    /\b\d+\s+(ultimos?|recientes?)\s+registros?\b/.test(n) ||
    /\besos?\s+(diez|10|\d+)\b/.test(n) ||
    // Anáfora corta: “en qué áreas están” (el listado ya está en el hilo/visor).
    /\b(en\s+que|de\s+que|donde|se\s+encuentran|se\s+ubican)\s+(areas?|personas?|estan|estan)\b/.test(
      n,
    ) ||
    /\b(areas?|personas?)\s+(estan|tienen|hay)\b/.test(n) ||
    /^en\s+que\s+areas?\b/.test(n) ||
    /^donde\s+estan\b/.test(n);

  if (!scoped) return undefined;

  const asksWhere =
    /\b(en\s+que|de\s+que|que|cuales?|donde|en\s+donde|se\s+encuentran|se\s+ubican|pertenecen|tienen|tienen?\s+cada|estan)\b/.test(
      n,
    ) || /\?\s*$/.test(String(userText).trim());

  if (/\b(areas?|departamento|departamentos|zona|zonas)\b/.test(n)) {
    return asksWhere || /\bareas?\b/.test(n) ? { field: "area" } : undefined;
  }
  // “dame los nombres de esas 16 personas” = ranking global, NO campo del listado.
  if (
    /\b(nombres?|listado\s+de\s+personas|esas?\s+\d+\s+personas|cuantas?\s+personas|todas\s+las\s+personas)\b/.test(
      n,
    ) ||
    (/\b(dame|muestra|mostrar|lista|listar|trae)\b/.test(n) &&
      /\bpersonas?\b/.test(n) &&
      !/\b(estan|encuentran|ubican|en\s+que|de\s+que)\b/.test(n))
  ) {
    return undefined;
  }
  if (/\b(personas?|asignad|responsable|quien|quienes)\b/.test(n)) {
    // Solo “¿en qué personas están estos?” / “personas de ese listado”.
    if (
      !asksWhere &&
      !/\b(estan|encuentran|ubican|tienen\s+cada|del\s+listado)\b/.test(n)
    ) {
      return undefined;
    }
    return { field: "persona" };
  }
  // “origen/fuente de esos” sí; “inventario 1/nuevo” no (catálogo / browse).
  if (/\b(origen|fuente)\b/.test(n)) {
    return { field: "origen" };
  }
  if (
    /\binventari\w*\b/.test(n) &&
    /\b(esos|esas|este\s+listado|del\s+listado|de\s+arriba)\b/.test(n)
  ) {
    return { field: "origen" };
  }
  if (/\b(estado|activos?|inactivos?)\b/.test(n)) {
    return { field: "estado" };
  }
  // “dónde están esos” sin campo → áreas (lo más útil).
  if (
    asksWhere &&
    /\b(donde|encuentran|ubican|estan|estan\s+ubicados)\b/.test(n)
  ) {
    return { field: "area" };
  }
  return undefined;
}

function aggregateFieldCounts(
  rows: InventarioRow[],
  field: "area" | "persona" | "origen" | "estado",
): Array<{ name: string; count: number; samples: string[] }> {
  const map = new Map<string, { count: number; samples: string[] }>();
  for (const row of rows) {
    const name =
      String(
        field === "area"
          ? row.area
          : field === "persona"
            ? row.persona
            : field === "origen"
              ? row.origen
              : row.estado,
      )
        .trim() || "(sin dato)";
    const et = String(row.etiqueta ?? "").trim();
    const prev = map.get(name) || { count: 0, samples: [] };
    prev.count += 1;
    if (et && prev.samples.length < 2) prev.samples.push(et);
    map.set(name, prev);
  }
  return [...map.entries()]
    .map(([name, v]) => ({ name, count: v.count, samples: v.samples }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "es"));
}

function formatScopedListFieldReply(
  rows: InventarioRow[],
  field: "area" | "persona" | "origen" | "estado",
): string {
  const label =
    field === "area"
      ? "área"
      : field === "persona"
        ? "persona"
        : field === "origen"
          ? "inventario/origen"
          : "estado";
  const plural =
    field === "area"
      ? "áreas"
      : field === "persona"
        ? "personas"
        : field === "origen"
          ? "orígenes"
          : "estados";
  if (!rows.length) {
    return `No tengo el listado a mano. Pide primero los últimos registros (o una búsqueda) y luego pregunta en qué ${plural} están.`;
  }
  const groups = aggregateFieldCounts(rows, field);
  const n = rows.length;
  const bits = groups
    .slice(0, 8)
    .map((g) => {
      const sample =
        g.samples.length > 0
          ? ` (ej. ${g.samples.map((s) => `**${s}**`).join(", ")})`
          : "";
      return `**${g.name}** (${g.count})${sample}`;
    })
    .join("; ");
  const more =
    groups.length > 8
      ? ` y ${groups.length - 8} ${plural} más`
      : "";
  const panel =
    field === "area"
      ? "plantilla de áreas"
      : field === "persona"
        ? "plantilla de personas"
        : field === "estado"
          ? "plantilla de estado"
          : "panel";
  return pickChatVariant(
    [
      `De esos **${n}** registros, las ${plural} son: ${bits}${more}. Te abrí el cuadro de incidencias con la **${panel}**. ¿Filtramos una ${label} o exportamos Excel?`,
      `Esos **${n}** están repartidos así: ${bits}${more}. Mira la **${panel}** a la derecha. ¿Vemos una ${label} o generamos QR?`,
      `En el listado (${n}) hay **${groups.length}** ${plural}: ${bits}${more}. El detalle está en el cuadro de incidencias. ¿Otra consulta?`,
    ],
    `${field}:${n}:${groups.map((g) => g.name).join("|")}`,
  );
}

function detectRecentRecordsAsk(
  userText: string,
): { limit: number; soloHoy: boolean } | undefined {
  const n = normalizeChatIntent(userText);
  if (!n) return undefined;
  // “que no sea recientes” ≠ pedir últimos.
  if (detectExcludeRecentRefineAsk(userText)) return undefined;
  // Pregunta de pertenencia al hilo ≠ “dame los últimos”.
  if (detectIsAmongRecentAsk(userText)) return undefined;
  // “esos 10 en qué áreas…” ≠ listar de nuevo.
  if (detectScopedListFieldAsk(userText)) return undefined;
  // “mete este registro al nuevo inventario” ≠ últimos registros.
  if (
    /\bnuevo\s+inventario\b/.test(n) ||
    (/\b(crea|crear|haz|hacer|has|abre|abrir)\b/.test(n) &&
      /\binventarios?\b/.test(n)) ||
    (/\b(mete|meter|pon|poner|pasa|pasar|copia|copiar|traslada)\b/.test(n) &&
      /\binventarios?\b/.test(n))
  ) {
    return undefined;
  }
  const soloHoy = /\bhoy\b/.test(n);
  const wantsNoun = intentHas(
    n,
    "registro",
    "registros",
    "articulo",
    "articulos",
    "equipo",
    "equipos",
    "alta",
    "altas",
    "entrada",
    "entradas",
  );
  const wantsRecentWord = intentHas(
    n,
    "ultimo",
    "ultimos",
    "reciente",
    "recientes",
    "nuevo",
    "nueva",
    "nuevos",
    "nuevas",
  );
  const wantsRecentPhrase =
    /\b(se\s+metio|se\s+agrego|acabo\s+de|recien\s+(met|agreg|registr)|mas\s+nuev|mas\s+recient|base\s+de\s+datos)\b/.test(
      n,
    );
  if (!wantsRecentWord && !wantsRecentPhrase) return undefined;
  if (!wantsNoun && !wantsRecentPhrase && !soloHoy) return undefined;
  // “nuevo/nueva” solo cuenta si también hay señal temporal (últimos/recientes/hoy).
  if (
    intentHas(n, "nuevo", "nueva", "nuevos", "nuevas") &&
    !intentHas(n, "ultimo", "ultimos", "reciente", "recientes") &&
    !wantsRecentPhrase &&
    !soloHoy
  ) {
    return undefined;
  }
  // Singular “el último registro” → 1; plural / hoy / recientes → varios.
  const singular =
    intentHas(n, "ultimo") &&
    !intentHas(n, "ultimos", "recientes") &&
    !soloHoy;
  return { limit: singular ? 1 : 10, soloHoy };
}

function rowRecencyTs(row: InventarioRow): number {
  return (
    Date.parse(String(row.created_at ?? "")) ||
    Date.parse(String(row.updated_at ?? "")) ||
    Number(row.id ?? 0) ||
    0
  );
}

function getRecentInventoryRows(
  inventory: InventarioRow[],
  limit: number,
  soloHoy = false,
) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  return [...inventory]
    .filter((row) => {
      if (!soloHoy) return true;
      const ts = rowRecencyTs(row);
      return ts >= todayMs;
    })
    .sort((a, b) => rowRecencyTs(b) - rowRecencyTs(a))
    .slice(0, Math.max(1, Math.min(50, limit)));
}

/**
 * N registros que NO están entre los más recientes
 * (omite el bloque reciente del hilo / top reciente).
 */
function getNonRecentInventoryRows(
  inventory: InventarioRow[],
  limit: number,
  excludeRecent = 10,
) {
  const sorted = [...inventory].sort(
    (a, b) => rowRecencyTs(b) - rowRecencyTs(a),
  );
  const skip = Math.max(excludeRecent, limit);
  const rest = sorted.slice(skip);
  const pool = rest.length >= limit ? rest : sorted.slice().reverse();
  return pool.slice(0, Math.max(1, Math.min(50, limit)));
}

/** “que no sea recientes” / “no los últimos” → refinar el listado del hilo. */
function detectExcludeRecentRefineAsk(userText: string): {
  limit: number;
} | undefined {
  const n = normalizeChatIntent(userText);
  if (!n) return undefined;
  const negatesRecent =
    /\b(no|sin|excepto|menos|fuera)\b/.test(n) &&
    /\b(recientes?|ultimos?|nuevos?|nuevas?|recien)\b/.test(n);
  const otherThanRecent =
    /\b(otros?|otras?|distintos?|diferentes?)\b/.test(n) &&
    /\b(recientes?|ultimos?)\b/.test(n);
  const notRecentPhrase =
    /\bque\s+no\s+sea(?:n)?\s+(los\s+)?(recientes?|ultimos?)\b/.test(n) ||
    /\bno\s+(los\s+)?(recientes?|ultimos?)\b/.test(n) ||
    /\bno\s+sean?\s+(los\s+)?(recientes?|ultimos?)\b/.test(n);
  if (!negatesRecent && !otherThanRecent && !notRecentPhrase) {
    return undefined;
  }
  const count = parseRequestedCount(userText);
  return { limit: count != null ? Math.max(1, Math.min(50, count)) : 10 };
}

/** Últimas variantes usadas por “bolsa” (evita repetir la misma respuesta). */
const chatVariantRecent = new Map<string, string[]>();

/**
 * Elige prosa distinta en cada turno (bolsa sin repetición inmediata).
 * `salt` agrupa el tipo de mensaje (p. ej. "compare-empty").
 */
function pickChatVariant(variants: string[], salt = ""): string {
  const list = variants.map((v) => String(v || "").trim()).filter(Boolean);
  if (!list.length) return "";
  if (list.length === 1) return list[0];

  const bagKey = salt.trim() || `bag:${list.join("|").slice(0, 80)}`;
  const recent = chatVariantRecent.get(bagKey) || [];
  const avoid = new Set(recent.slice(-Math.min(3, list.length - 1)));
  const pool = list.filter((v) => !avoid.has(v));
  const choices = pool.length ? pool : list;

  let h = (Date.now() + choices.length * 17) % 1009;
  for (let i = 0; i < bagKey.length; i += 1) {
    h = (h + bagKey.charCodeAt(i) * (i + 2)) % 1009;
  }
  const picked = choices[Math.abs(h) % choices.length];
  const nextRecent = [...recent, picked].slice(-8);
  chatVariantRecent.set(bagKey, nextRecent);
  if (chatVariantRecent.size > 80) {
    const first = chatVariantRecent.keys().next().value;
    if (first != null) chatVariantRecent.delete(first);
  }
  return picked;
}

/** “¿recuerdas…?”, “te pedí…”, “otra vez…” → reconocer el hilo. */
function looksLikeThreadRecall(userText: string): boolean {
  const n = normalizeChatIntent(userText);
  return /\b(recuerd|acord|te pedi|te pregunte|lo de antes|otra vez|de nuevo|como te dije|me dijiste|habiamos|volvamos|repetir|repiteme|repitemelo)\b/.test(
    n,
  );
}

function formatRowBrief(row: InventarioRow): string {
  const et = String(row.etiqueta ?? "").trim() || "S/E";
  const art = String(row.articulo ?? "").trim() || "Artículo";
  return `**${et}** (${art})`;
}

/** Una línea en prosa por artículo (sin viñetas). */
function formatRowProseLine(row: InventarioRow): string {
  const et = String(row.etiqueta ?? "").trim() || "S/E";
  const art = String(row.articulo ?? "").trim() || "Artículo";
  const marca = String(row.marca ?? "").trim();
  const modelo = String(row.modelo ?? "").trim();
  const product = [art, marca, modelo].filter(Boolean).join(" ");
  const per = String(row.persona ?? "").trim();
  const area = String(row.area ?? "").trim();
  const est = String(row.estado ?? "").trim();
  let line = `Etiqueta **${et}** — **${product}**`;
  if (per) line += ` asignada a **${per}**`;
  if (area) line += ` en **${area}**`;
  if (est) line += `, estado **${est}**`;
  return `${line}.`;
}

function buildRecentRecordsReply(
  rows: InventarioRow[],
  ask: { limit: number; soloHoy: boolean },
  opts?: { userText?: string },
) {
  const userText = opts?.userText || "";
  const recall = looksLikeThreadRecall(userText);
  if (!rows.length) {
    return ask.soloHoy
      ? pickChatVariant(
          [
            "Por ahora no veo altas de **hoy**. ¿Revisamos los más recientes en general?",
            "Hoy todavía no hay movimientos nuevos. ¿Te muestro los últimos del inventario?",
          ],
          userText,
        )
      : pickChatVariant(
          [
            "No encontré registros recientes para mostrar. ¿Probamos con un área o una persona?",
            "Aún no tengo movimientos recientes que listar. ¿Qué te gustaría consultar?",
          ],
          userText,
        );
  }
  const fmt = (n: number) => n.toLocaleString("es-MX");
  const sample = rows[0];
  const et = String(sample.etiqueta ?? "").trim() || "S/E";
  const art =
    [sample.articulo, sample.marca].map((v) => String(v ?? "").trim()).filter(Boolean).join(" — ") ||
    "Artículo";
  const per = String(sample.persona ?? "").trim() || "Sin asignar";
  const area = String(sample.area ?? "").trim() || "Sin área";
  if (ask.limit === 1 || rows.length === 1) {
    const open = recall
      ? pickChatVariant(
          [
            `Claro, me acuerdo: el último registro que pediste es **${et}**.`,
            `Sí, lo recuerdo. El más reciente sigue siendo **${et}**.`,
          ],
          userText + et,
        )
      : pickChatVariant(
          [
            `El movimiento más reciente es **${et}**.`,
            `Acabo de ubicar el último alta: **${et}**.`,
          ],
          et,
        );
    return (
      `${open} Es **${art}** (${area} · ${per}). ` +
      pickChatVariant(
        [
          `El detalle está a la derecha; si quieres generamos su QR o vemos más recientes.`,
          `Lo tienes en el panel. ¿Abrimos la ficha, armamos QR o seguimos con otra consulta?`,
        ],
        open,
      )
    );
  }
  const n = fmt(rows.length);
  const hoy = ask.soloHoy ? " de hoy" : "";
  const open = recall
    ? pickChatVariant(
        [
          `Claro que sí: me pediste los últimos **${n}** y aquí te los traigo otra vez${hoy}.`,
          `Sí, lo recuerdo. Volvemos a esos **${n}** registros más recientes${hoy}.`,
          `Por supuesto. Como me pediste, te muestro de nuevo los **${n}** movimientos recientes${hoy}.`,
        ],
        userText + n,
      )
    : pickChatVariant(
        [
          `Listo: te comparto los **${n}** registros más recientes${hoy}.`,
          `Aquí tienes los **${n}** movimientos más nuevos${hoy}.`,
          `Encontré **${n}** registros recientes${hoy} para ti.`,
        ],
        n + hoy,
      );
  const proseLines = rows
    .slice(0, Math.min(rows.length, 12))
    .map((row) => formatRowProseLine(row))
    .join("\n\n");
  const more =
    rows.length > 12
      ? `\n\nY ${fmt(rows.length - 12)} más en el panel derecho.`
      : "";
  const close = pickChatVariant(
    [
      `El detalle completo está a la derecha; si quieres abrimos uno o generamos QR.`,
      `¿Revisamos alguna ficha, armamos QR o seguimos con otra consulta?`,
      `Puedes explorarlos en el visor o decirme qué hacemos después.`,
    ],
    open,
  );
  return `${open}\n\n${proseLines}${more}\n\n${close}`;
}

function buildNonRecentRecordsReply(
  rows: InventarioRow[],
  ask: { limit: number },
  opts?: { userText?: string },
) {
  const userText = opts?.userText || "";
  const fmt = (n: number) => n.toLocaleString("es-MX");
  if (!rows.length) {
    return pickChatVariant(
      [
        "No encontré otros registros fuera de los más recientes. ¿Probamos con un área o una persona?",
        "Con el filtro de no-recientes no me quedan filas que mostrar. ¿Quieres otro criterio?",
      ],
      userText,
    );
  }
  const n = fmt(rows.length);
  const open = pickChatVariant(
    [
      `De acuerdo: te traigo **${n}** registros que no son los más recientes.`,
      `Listo, sin los últimos: aquí van **${n}** registros de más atrás.`,
      `Perfecto — omití los recientes y te dejé **${n}** del resto del inventario.`,
    ],
    userText + n,
  );
  const proseLines = rows
    .slice(0, Math.min(rows.length, 12))
    .map((row) => formatRowProseLine(row))
    .join("\n\n");
  const more =
    rows.length > 12
      ? `\n\nY ${fmt(rows.length - 12)} más en el panel derecho.`
      : "";
  const close = pickChatVariant(
    [
      `El detalle está en el panel; si quieres filtro por área o generamos QR, dímelo.`,
      `A la derecha tienes el resto. ¿Seguimos con otra consulta?`,
    ],
    open,
  );
  return `${open}\n\n${proseLines}${more}\n\n${close}`;
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
  // “último registro / recién metido” es global: no reusar el área del turno anterior.
  if (detectRecentRecordsAsk(userText)) {
    return undefined;
  }
  if (looksLikeRecordMutationAsk(userText)) {
    return undefined;
  }
  // Copia / import entre Inventario N → M: no reusar Contabilidad u otra área previa.
  if (
    detectBulkCopyBetweenInventariosAsk(
      userText,
      listExistingOrigens(inventory),
    ) ||
    (/\b(importa\w*|pasa\w*|copia\w*|mueve\w*|traslad\w*|traspas\w*|mete\w*|trae\w*)\b/.test(
      n,
    ) &&
      /\binventari/.test(n) &&
      /\b(?:a|al|hacia)\b/.test(n))
  ) {
    return undefined;
  }
  // “etiqueta 283586 de qué inventario…” ≠ reabrir Contabilidad.
  if (
    detectEtiquetaOrigenAsk(userText, inventory) ||
    (/\betiqueta/.test(n) &&
      /\b\d{3,}\b/.test(n) &&
      /\b(inventari|origen|fuente|venia|venía|antes)\b/.test(n))
  ) {
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

  // Solo el ÚLTIMO bot cuenta. Remontar historial reabría Contabilidad
  // aunque el hilo actual fuera de inventarios/etiquetas.
  let lastBot:
    | {
        from: string;
        text: string;
        viewerFocus?: string;
        viewerOverview?: ViewerOverview;
      }
    | undefined;
  for (let i = recentMessages.length - 1; i >= 0; i -= 1) {
    if (recentMessages[i].from === "bot") {
      lastBot = recentMessages[i];
      break;
    }
  }
  if (!lastBot) return undefined;

  let focusName = "";
  let focusKind: "area" | "person" | "" = "";
  const focus = String(lastBot.viewerFocus || "").trim();
  if (focus) {
    if (
      lastBot.viewerOverview === "areaTotal" ||
      lastBot.viewerOverview === "areaMatches"
    ) {
      focusName = focus.includes("::")
        ? focus.slice(0, focus.indexOf("::")).trim() || focus
        : focus;
      if (focus.includes("::")) {
        const parsed = parseMatchesFocusFromMessage(focus);
        focusName = parsed?.candidates[0] || focusName;
      }
      focusKind = "area";
    } else if (
      lastBot.viewerOverview === "personTotal" ||
      lastBot.viewerOverview === "personMatches"
    ) {
      focusName = focus.includes("::")
        ? (() => {
            const parsed = parseMatchesFocusFromMessage(focus);
            return parsed?.candidates[0] || focus;
          })()
        : focus;
      focusKind = "person";
    } else {
      const areaHit = getAllAreaCatalog(inventory).find(
        (c) => c.name === focus || areaMatchesNeedle(c.name, focus),
      );
      if (areaHit) {
        focusKind = "area";
        focusName = areaHit.name;
      } else {
        const personHit = getAllPersonCatalog(inventory).find(
          (c) =>
            c.name === focus ||
            normalizePlain(c.name).includes(normalizePlain(focus)),
        );
        if (personHit) {
          focusKind = "person";
          focusName = personHit.name;
        }
      }
    }
  }

  // Sin viewerFocus: solo el texto del último bot (no chats viejos).
  if (!focusKind && lastBot.text) {
    const catalog = getAllAreaCatalog(inventory);
    for (const area of catalog) {
      if (
        lastBot.text.includes(area.name) ||
        normalizePlain(lastBot.text).includes(area.norm)
      ) {
        focusKind = "area";
        focusName = area.name;
        break;
      }
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
  const wantsList =
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
    );
  if (!wantsList) return false;
  // Anáfora: “sus etiquetas”
  if (looksLikePersonAnaphora(userText)) return true;
  // Nombrada: “dame las etiquetas de Fernanda Vargas”
  if (
    /\b(etiquet\w*|registros?|articulos?|equipos?)\s+de\b/.test(n) ||
    /\bde\s+[a-z]{2,}(?:\s+[a-z]{2,}){0,3}\b/.test(n)
  ) {
    return (
      intentHas(n, "dame", "muestra", "mostrar", "ver", "lista", "listar", "trae") ||
      /\betiquet/.test(n)
    );
  }
  return false;
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

function lastBotViewerOverview(
  messages: ChatMessage[],
): ViewerOverview | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.from !== "bot") continue;
    if (message.viewerOverview) return message.viewerOverview;
  }
  return undefined;
}

/**
 * Filas para Excel: origen → persona/área del hilo (todas) → listado previo.
 * Nunca cae en dump genérico si hay anáfora/foco de persona.
 */
function resolveExcelExportSource(opts: {
  userText: string;
  excelAsk: {
    origen: string | null;
    theme: string | null;
    fromContext: boolean;
  };
  inventory: InventarioRow[];
  chatHistory: Array<{
    from: string;
    text: string;
    resultItems?: ChatApiItem[];
    viewerFocus?: string;
    viewerOverview?: ViewerOverview;
  }>;
  messages: ChatMessage[];
  lastConcrete?: {
    resultItems?: ChatApiItem[];
    viewerFocus?: string | null;
    viewerOverview?: ViewerOverview;
  } | null;
}): { rows: InventarioRow[]; focusName: string | null; usedThread: boolean } {
  const {
    userText,
    excelAsk,
    inventory,
    chatHistory,
    messages,
    lastConcrete,
  } = opts;
  const foldOrig = (o: string) =>
    o
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/\s+/g, " ")
      .trim();

  if (excelAsk.origen) {
    const want = foldOrig(excelAsk.origen);
    const existing = listExistingOrigens(inventory);
    const canon =
      existing.find((o) => foldOrig(o) === want) ||
      existing.find((o) => foldOrig(o).includes(want)) ||
      excelAsk.origen;
    const rows = inventory.filter(
      (row) => foldOrig(String(row.origen ?? "")) === foldOrig(canon),
    );
    return { rows, focusName: canon, usedThread: false };
  }

  const catalog = getAllPersonCatalog(inventory);
  const named =
    detectPersonTotalAsk(userText, inventory, chatHistory) ||
    findPersonInText(userText, inventory) ||
    resolvePersonFocus(userText, inventory, chatHistory);
  const prevFocus =
    lastBotViewerFocus(messages) || lastConcrete?.viewerFocus || null;
  const prevOverview =
    lastBotViewerOverview(messages) || lastConcrete?.viewerOverview;
  const focusCandidate =
    named ||
    (excelAsk.fromContext ||
    prevOverview === "personTotal" ||
    prevOverview === "personMatches"
      ? prevFocus
      : null);

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
      return { rows: exact.rows, focusName: exact.name, usedThread: true };
    }
  }

  const areaHit =
    matchAreaFromPrompt(userText, inventory) ||
    (excelAsk.fromContext &&
    (prevOverview === "areaTotal" || prevOverview === "areaMatches")
      ? prevFocus
      : null);
  if (areaHit) {
    const rows = inventory.filter((row) =>
      areaMatchesNeedle(String(row.area ?? ""), areaHit),
    );
    if (rows.length) {
      return { rows, focusName: areaHit, usedThread: Boolean(prevFocus) };
    }
  }

  if (excelAsk.theme) {
    const needle = normalizeChatIntent(excelAsk.theme);
    const rows = inventory.filter((row) =>
      normalizeChatIntent(String(row.area ?? "")).includes(needle),
    );
    if (rows.length) {
      return { rows, focusName: excelAsk.theme, usedThread: false };
    }
  }

  if (excelAsk.fromContext || prevOverview === "personTotal") {
    // Preferir TODAS las filas de la persona del foco, no el sample del panel.
    if (prevFocus) {
      const byFocus = rowsForPersonName(inventory, prevFocus);
      if (byFocus.length) {
        return { rows: byFocus, focusName: prevFocus, usedThread: true };
      }
    }
    const prevItems =
      lastBotResultItems(messages).length > 0
        ? lastBotResultItems(messages)
        : lastConcrete?.resultItems || [];
    if (prevItems.length) {
      return {
        rows: chatApiItemsToRows(prevItems, inventory),
        focusName: prevFocus,
        usedThread: true,
      };
    }
    return { rows: [], focusName: prevFocus, usedThread: true };
  }

  return { rows: [], focusName: null, usedThread: false };
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

/** Separa `[Archivo: x.xlsx]` del texto libre del mensaje de usuario. */
function parseUserAttachDisplay(text: string): {
  attach?: { kind: "file" | "image"; name: string };
  body: string;
} {
  const raw = String(text || "");
  const m = raw.match(
    /^\[(Archivo|Imagen):\s*([^\]]+)\](?:\n([\s\S]*))?$/i,
  );
  if (!m) return { body: raw };
  return {
    attach: {
      kind: /^imagen$/i.test(m[1]) ? "image" : "file",
      name: m[2].trim(),
    },
    body: String(m[3] || "").trim(),
  };
}

function isSpreadsheetFileName(name: string) {
  return /\.(xlsx|xls|csv)$/i.test(String(name || "").trim());
}

const CHAT_PENDING_IMPORT_KEY = "inventario-chat-pending-import";
/** Excel pendiente caduca a los 3 minutos. */
const PENDING_IMPORT_TTL_MS = 3 * 60 * 1000;

type PendingImportPayload = {
  items: NewInventarioItem[];
  askedAt: number;
};

function looksLikeImportPreviewAsk(text: string) {
  const t = String(text || "");
  return (
    /\b(import(?:o|ar|aci[oó]n|alos|alas)?|cargar|carga|excel|archivo)\b/i.test(
      t,
    ) &&
    /\b(confirm|importalo|destino|origen|filas|registros|visto|revis|le[ií]|¿|prepar|listo)\b/i.test(
      t,
    )
  );
}

/** Confirmación explícita de carga (NO ok/okey/vale/dale/perfecto). */
function isExplicitImportConfirm(value: string): boolean {
  const t = String(value || "").trim();
  if (!t) return false;
  if (
    /\b(compara\w*|diff|diferencia|borra|elimina|pasa|copia|lista|muestra|dame|panorama|inventario\s+total|busca)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  // Chips / verbos de carga
  if (
    /^(importa(?:r|los|las|me|lo|la|nos)?|carga(?:r|los|las|lo|la)?|sube(?:r|los|las|lo|la)?|súbe(?:los|las|lo|la)?)([.!\s]*)$/i.test(
      t,
    )
  ) {
    return true;
  }
  // “sí” / “confirma” cortos — solo válidos si el turno previo fue el preview
  return /^(sí|si|yes|confirma|confirmo)([.!\s]*)$/i.test(t);
}

/** Chips fijos tras preview de Excel (prompt dispara confirm/cancel). */
const IMPORT_CONFIRM_FOLLOW_UPS: ChatFollowUp[] = [
  { label: "Confirmar e importar", prompt: "importalos" },
  { label: "Cancelar carga", prompt: "cancelar" },
];

function chatApiItemToNewInventario(it: ChatApiItem): NewInventarioItem | null {
  const etiqueta = String(it.etiqueta ?? "").trim();
  const articulo = String(it.articulo ?? "").trim();
  if (!etiqueta || !articulo) return null;
  return {
    etiqueta,
    articulo,
    marca: it.marca ?? null,
    modelo: it.modelo ?? null,
    serie: it.serie ?? null,
    area: String(it.area ?? "").trim() || "Sin área",
    persona: it.persona ?? null,
    cantidad: it.cantidad ?? 1,
    observaciones: it.observaciones ?? null,
    estado: it.estado ?? null,
    origen: it.origen ?? null,
  };
}

function savePendingImportToSession(
  sessionId: string | null | undefined,
  items: NewInventarioItem[] | null,
  askedAt: number = Date.now(),
) {
  if (typeof window === "undefined" || !sessionId) return;
  try {
    const key = `${CHAT_PENDING_IMPORT_KEY}:${sessionId}`;
    if (!items?.length) {
      window.sessionStorage.removeItem(key);
      return;
    }
    const payload: PendingImportPayload = { items, askedAt };
    window.sessionStorage.setItem(key, JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
}

function loadPendingImportFromSession(
  sessionId: string | null | undefined,
): PendingImportPayload | null {
  if (typeof window === "undefined" || !sessionId) return null;
  try {
    const raw = window.sessionStorage.getItem(
      `${CHAT_PENDING_IMPORT_KEY}:${sessionId}`,
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    // Formato nuevo { items, askedAt }
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as PendingImportPayload).items)
    ) {
      const payload = parsed as PendingImportPayload;
      if (!payload.items.length) return null;
      const askedAt = Number(payload.askedAt) || 0;
      if (askedAt && Date.now() - askedAt > PENDING_IMPORT_TTL_MS) {
        window.sessionStorage.removeItem(
          `${CHAT_PENDING_IMPORT_KEY}:${sessionId}`,
        );
        return null;
      }
      return { items: payload.items, askedAt: askedAt || Date.now() };
    }
    // Legado: array plano → caducar (no reactivar Excel viejo)
    if (Array.isArray(parsed)) {
      window.sessionStorage.removeItem(
        `${CHAT_PENDING_IMPORT_KEY}:${sessionId}`,
      );
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** NewInventarioItem → tarjeta del visor (misma UI que consultas). */
function importItemsToChatApi(items: NewInventarioItem[]): ChatApiItem[] {
  return items.map((item, i) => ({
    id: -(i + 1),
    etiqueta: item.etiqueta,
    articulo: item.articulo,
    marca: item.marca ?? null,
    modelo: item.modelo ?? null,
    serie: item.serie ?? null,
    area: item.area ?? null,
    persona: item.persona ?? null,
    cantidad: item.cantidad ?? null,
    estado: item.estado ?? null,
    origen: item.origen ?? null,
    observaciones: item.observaciones ?? null,
  }));
}

/** Hechos crudos de vista previa (la prosa la redacta OpenAI vía compose). */
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
}): string {
  const bits = [
    `archivo=${input.fileName}`,
    input.sheetName ? `hoja=${input.sheetName}` : null,
    `destino=${input.origen}`,
    `fuente_destino=${input.source}`,
    `registros=${input.count}`,
    `filas_validas=${input.rawValid}`,
    input.dups > 0 ? `duplicados=${input.dups}` : null,
    "accion=pedir_confirmacion_importar",
  ].filter(Boolean);
  return bits.join("; ");
}

function buildChatImportMixedReply(input: {
  fileName: string;
  sheetName?: string;
  mixSummary: string;
  dupNote: string;
}): string {
  return [
    `archivo=${input.fileName}`,
    input.sheetName ? `hoja=${input.sheetName}` : null,
    "origen_mezclado=true",
    input.mixSummary,
    input.dupNote,
    "accion=pedir_confirmacion_o_destino_unico",
  ]
    .filter(Boolean)
    .join("; ");
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
  "compara",
  "comparar",
  "comparacion",
  "diff",
  "diferencia",
  "diferencias",
  "versus",
  "vs",
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
  if (a === n) return true;
  const aToks = a.split(" ").filter(Boolean);
  const nToks = n.split(" ").filter(Boolean);
  // Agujas cortas (ti, rh): solo token completo o acrónimo — nunca "%ti%" en marketing.
  if (n.length <= 3 && nToks.length === 1) {
    if (aToks.includes(n)) return true;
    const acro = areaAcronym(a);
    if (acro && (acro === n || (n.length >= 2 && acro === n))) return true;
    return false;
  }
  if (a.includes(n) || (n.length >= 5 && n.includes(a))) return true;
  const acro = areaAcronym(a);
  if (acro && (acro === n || (n.length >= 2 && acro.startsWith(n)))) return true;
  if (nToks.length && nToks.every((tok) => aToks.includes(tok))) return true;
  return aToks.some((tok) => {
    if (tok === n) return true;
    if (n.length >= 4 && (tok.includes(n) || n.includes(tok))) return true;
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
  if (looksLikeRecordMutationAsk(userText)) return undefined;
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

/** Qué ve el usuario en el panel derecho → contexto para «de aquí». */
function buildContextoVista(input: {
  overview?: ViewerOverview | null;
  overviewFocus?: string | null;
  resultItems?: ChatApiItem[] | null;
}): ChatContextoVista | null {
  const overview = input.overview || undefined;
  let focus = String(input.overviewFocus || "").trim();
  const parsed = parseMatchesFocusFromMessage(focus);
  if (parsed?.candidates?.length === 1) {
    focus = parsed.candidates[0];
  } else if (parsed?.label) {
    focus = parsed.label;
  }
  const items = Array.isArray(input.resultItems) ? input.resultItems : [];

  const majority = (key: "persona" | "area" | "origen") => {
    const counts = new Map<string, number>();
    for (const it of items) {
      const v = String(it[key] ?? "").trim();
      if (!v) continue;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    let best = "";
    let n = 0;
    for (const [k, c] of counts) {
      if (c > n) {
        best = k;
        n = c;
      }
    }
    return best;
  };

  // Ranking / comparación: no arrastrar un filtro puntual como «de aquí».
  if (overview === "areas" || overview === "comparacion") {
    return null;
  }
  if (
    overview === "personTotal" ||
    overview === "personMatches" ||
    overview === "personas"
  ) {
    const valor = focus || majority("persona");
    if (valor) return { tipo: "persona", valor };
  }
  if (overview === "areaTotal" || overview === "areaMatches") {
    const valor = focus || majority("area");
    if (valor) return { tipo: "area", valor };
  }
  if (overview === "full" || overview === "stats" || overview === "recent") {
    if (focus && /^(inventario|excel|csv|xls|xlsx)\s*\d+$/i.test(focus)) {
      return { tipo: "origen", valor: focus };
    }
    const origen = majority("origen");
    const persona = majority("persona");
    const area = majority("area");
    if (persona && items.every((it) => !it.persona || it.persona === persona)) {
      return { tipo: "persona", valor: persona };
    }
    if (area && items.every((it) => !it.area || it.area === area)) {
      return { tipo: "area", valor: area };
    }
    if (origen && items.every((it) => !it.origen || it.origen === origen)) {
      return { tipo: "origen", valor: origen };
    }
    if (focus) {
      if (/inventario|excel|csv/i.test(focus)) {
        return { tipo: "origen", valor: focus };
      }
      return { tipo: "persona", valor: focus };
    }
  }
  if (focus) {
    if (/^(inventario|excel|csv|xls|xlsx)\s*\d+$/i.test(focus)) {
      return { tipo: "origen", valor: focus };
    }
    // Lista acotada sin overview: inferir persona/área desde los items del turno.
    const areaFromItems = majority("area");
    const personaFromItems = majority("persona");
    if (
      areaFromItems &&
      items.length > 0 &&
      items.every((it) => !it.area || it.area === areaFromItems)
    ) {
      return { tipo: "area", valor: areaFromItems };
    }
    if (
      personaFromItems &&
      items.length > 0 &&
      items.every((it) => !it.persona || it.persona === personaFromItems)
    ) {
      return { tipo: "persona", valor: personaFromItems };
    }
    if (areaFromItems && focus === areaFromItems) {
      return { tipo: "area", valor: areaFromItems };
    }
    return { tipo: "persona", valor: focus };
  }
  const persona = majority("persona");
  if (persona) return { tipo: "persona", valor: persona };
  const area = majority("area");
  if (area) return { tipo: "area", valor: area };
  const origen = majority("origen");
  if (origen) return { tipo: "origen", valor: origen };
  return null;
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
  // Temporal / hilo: “que no sea recientes” ≠ área “Atención a Clientes”.
  "reciente",
  "recientes",
  "ultimo",
  "ultimos",
  "nueva",
  "nuevo",
  "nuevas",
  "nuevos",
  "hoy",
  "ayer",
  "antes",
  "despues",
  "sea",
  "sean",
  "sino",
  "menos",
  "excepto",
  "fuera",
  "sin",
  "no",
  "ni",
  "o",
  "u",
  "otro",
  "otra",
  "otros",
  "otras",
  "aver",
  "mismo",
  "misma",
  "mismos",
  "mismas",
  "listado",
  "visor",
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
  // “que no sea recientes” / filtro temporal ≠ área fuzzy (“Atención a Clientes”).
  if (detectExcludeRecentRefineAsk(userText)) return undefined;
  if (looksLikeDeleteRecordAsk(userText) || userAskedQr(userText)) {
    return undefined;
  }
  if (looksLikeRecordMutationAsk(userText)) return undefined;
  // “Comparar inventarios” ≠ área “Compras”.
  const origensForSkip = listExistingOrigens(inventory);
  if (detectCompareInventariosAsk(userText, origensForSkip)) {
    return undefined;
  }
  // “Importa Inventario 1 a 3” ≠ área Contabilidad (ni foco previo).
  if (detectBulkCopyBetweenInventariosAsk(userText, origensForSkip)) {
    return undefined;
  }
  if (detectEtiquetaOrigenAsk(userText, inventory)) {
    return undefined;
  }
  // “qué hay en el Inventario 1” ≠ área Atención a Clientes.
  if (
    /\binventarios?\s*\d+\b/.test(normalizeChatIntent(userText)) ||
    matchOrigenFromPrompt(userText, origensForSkip)
  ) {
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
      "corrige",
      "corregir",
      "modifica",
      "modificar",
      "agrega",
      "agregar",
      "sube",
      "subir",
      "importa",
      "importar",
      "importaras",
      "importame",
      "importalos",
      "importemos",
    ) ||
    /\bimporta\w*\b/.test(n)
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
  // “inventario (general) de Héctor” → persona, no área fuzzy.
  if (
    !intentHas(n, "area", "areas", "edif", "edificio", "edificios") &&
    (/\binventario\s+(general\s+)?de\b/.test(n) ||
      /\b(inventario|registros?|equipos?)\s+(general\s+)?de\s+[a-z]{2,}/.test(n))
  ) {
    return undefined;
  }
  if (
    !intentHas(n, "area", "areas") &&
    findPersonInText(userText, inventory)
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
  if (looksLikeRecordMutationAsk(userText)) return undefined;
  // “Inventario 1” es origen, no nombre de persona.
  if (
    /\binventarios?\s*\d+\b/.test(normalizeChatIntent(userText)) &&
    !/\b(persona|personas|quien|quienes)\b/.test(normalizeChatIntent(userText))
  ) {
    return undefined;
  }
  const turn = analyzeTurnQuick(userText, inventory);
  if (turn.isWriteTurn || turn.discourseOnly) return undefined;
  // Solo buscar persona si hay señal de consulta o nombre de catálogo.
  const nGate = normalizeChatIntent(userText);
  const looksPersonInventory =
    /\binventario\s+(general\s+)?de\b/.test(nGate) ||
    /\b(inventario|registros?|equipos?|etiquetas?|articulos?)\s+(general\s+)?de\s+[a-z]{2,}/.test(
      nGate,
    );
  if (
    turn.primaryAction !== "query_person" &&
    !turn.personas.length &&
    !/\b(persona|personas|quien|quienes|inventario\s+de)\b/.test(turn.normalized) &&
    !looksPersonInventory
  ) {
    return undefined;
  }
  const n = nGate;
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
      "corrige",
      "corregir",
      "modifica",
      "modificar",
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
  // "dame sus etiquetas" → anáfora (paso 4). Si nombra a alguien, sí buscar aquí.
  if (looksLikePersonAnaphora(userText) && !findPersonInText(userText, inventory)) {
    return undefined;
  }

  // Si el clasificador ya resolvió personas del catálogo, úsalas.
  if (turn.personas.length === 1) {
    const catalog = getAllPersonCatalog(inventory);
    const hit = catalog.find((p) => p.name === turn.personas[0]);
    if (hit) {
      return {
        queryLabel: hit.name,
        candidates: [hit],
        intent: "total",
        limit: null,
      };
    }
  }

  const plain0 = stripRequestedCountPhrases(normalizePlain(userText));
  const rawTokens = plain0
    .split(" ")
    .filter(
      (t) =>
        t.length > 2 &&
        !PERSON_STOP_WORDS.has(t) &&
        !AREA_QUERY_STOP_WORDS.has(t) &&
        !INTENT_DISCOURSE_LOCK.has(t),
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
  const examples = shownRows
    .slice(0, 3)
    .map((row) => formatRowBrief(row))
    .join(", ");
  const totalLabel = total.toLocaleString("es-MX");
  const open = pickChatVariant(
    [
      `En **${areaSummary.name}** hay **${totalLabel}** registro${total === 1 ? "" : "s"}`,
      `El área **${areaSummary.name}** concentra **${totalLabel}** ficha${total === 1 ? "" : "s"}`,
      `Para **${areaSummary.name}** localicé **${totalLabel}** registro${total === 1 ? "" : "s"}`,
    ],
    areaSummary.name + totalLabel,
  );
  const stats =
    ` (**${areaSummary.personas}** persona${areaSummary.personas === 1 ? "" : "s"} · **${areaSummary.activos}** activo${areaSummary.activos === 1 ? "" : "s"}).`;
  const mid = examples
    ? pickChatVariant(
        [
          ` Por ejemplo: ${examples}.`,
          ` Entre ellos: ${examples}.`,
          ` Algunos son ${examples}.`,
        ],
        examples,
      )
    : "";
  const scopeNote =
    limit != null && limit < total
      ? pickChatVariant(
          [
            ` Te muestro los **${shownRows.length}** que pediste.`,
            ` Aquí van los **${shownRows.length}** que solicitaste.`,
          ],
          String(shownRows.length),
        )
      : pickChatVariant(
          [
            ` El detalle completo está en el panel derecho.`,
            ` A la derecha tienes el listado completo.`,
          ],
          areaSummary.name,
        );
  const close = pickChatVariant(
    [
      ` ¿Filtramos por persona, generamos QR o vemos otra área?`,
      ` Si quieres, seguimos con una persona, QR o otra consulta.`,
    ],
    open,
  );
  const reply = `${open}${stats}${mid}${scopeNote}${close}`;

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

  const sampleSeen = new Set<string>();
  const samples: string[] = [];
  for (const row of shownRows) {
    if (samples.length >= 3) break;
    const tag = String(row.etiqueta ?? "").trim() || "S/E";
    const key = tag.toLowerCase();
    if (sampleSeen.has(key)) continue;
    sampleSeen.add(key);
    samples.push(formatRowBrief(row));
  }
  const totalLabel = total.toLocaleString("es-MX");
  const open = pickChatVariant(
    [
      `**${personSummary.name}** tiene **${totalLabel}** registro${total === 1 ? "" : "s"}`,
      `Encontré **${totalLabel}** ficha${total === 1 ? "" : "s"} a nombre de **${personSummary.name}**`,
      `El inventario de **${personSummary.name}** suma **${totalLabel}** registro${total === 1 ? "" : "s"}`,
    ],
    personSummary.name + totalLabel,
  );
  const stats =
    ` (**${personSummary.activos}** activo${personSummary.activos === 1 ? "" : "s"}) en **${areas.length}** área${areas.length === 1 ? "" : "s"} (${areaLine}).`;
  const mid = samples.length
    ? pickChatVariant(
        [
          ` Por mencionar algunos: ${samples.join(", ")}.`,
          ` Entre ellos están ${samples.join(", ")}.`,
          ` Empiezan con ${samples.join(", ")}.`,
        ],
        samples.join("|"),
      )
    : "";
  const close = pickChatVariant(
    [
      ` El detalle está en el panel derecho. ¿Generamos QR, filtramos por área o seguimos con otra consulta?`,
      ` A la derecha tienes el listado. Si quieres, vemos etiquetas, QR o un área en particular.`,
      ` ¿Revisamos sus etiquetas, armamos QR o pasamos algo a otro inventario?`,
    ],
    open,
  );
  const reply = `${open}${stats}${mid}${close}`;

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
      Boolean(message.viewerOverview) ||
      Boolean(message.viewerComparacion))
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
  // “su id / su código / su etiqueta” puntual ≠ listado.
  // “sus etiquetas / sus registros” SÍ es anáfora (no mandar a n8n).
  if (/\bsu\s+(id|ids|etiqueta|codigo|codigos|folio)\b/.test(n)) {
    return false;
  }
  if (/\bsus\s+(id|ids|codigo|codigos|folio)\b/.test(n)) {
    return false;
  }
  return (
    /\b(su|sus)\s+(inventario|registros?|etiquetas?|equipos?|articulos?|cosas|ficha|fichas|excel|xlsx|csv|archivo)\b/.test(
      n,
    ) ||
    /\bde el\b/.test(n) ||
    /\bde ella\b/.test(n) ||
    /\besa persona\b/.test(n) ||
    /\bde esa persona\b/.test(n)
  );
}

/** Cualquier etiqueta mencionada (patrón libre o coincidencia en inventario). */
function extractEtiquetaMentions(
  userText: string,
  inventory: InventarioRow[],
): string[] {
  const raw = String(userText || "");
  const found = new Set<string>();
  const push = (value: string) => {
    const tag = String(value || "").trim();
    if (!tag || tag.length < 2) return;
    found.add(tag);
  };
  for (const tag of extractEtiquetasFromText(raw)) push(tag);
  // Prefijo-letra + dígitos (OF-0026, RH-12, A1-003…) y códigos numéricos largos
  for (const match of raw.matchAll(
    /\b([A-Za-z]{1,10}[-_/]?[A-Za-z0-9]*\d{2,8}|\d{4,10})\b/g,
  )) {
    push(match[1]);
  }
  // “etiqueta X” / “id interno N” (id solo si lo dicen explícito)
  for (const match of raw.matchAll(
    /(?:etiqueta|tag|folio|codigo)\s*[:=]?\s*\*{0,2}([A-Za-z0-9/_-]{2,})\*{0,2}/gi,
  )) {
    push(match[1]);
  }

  if (!inventory.length) return [...found];

  const byNorm = new Map<string, string>();
  for (const row of inventory) {
    const et = String(row.etiqueta ?? "").trim();
    if (!et) continue;
    byNorm.set(et.toLowerCase(), et);
  }
  // También: etiqueta del inventario que aparezca completa en el texto
  const rawLower = raw.toLowerCase();
  const plain = normalizePlain(raw);
  for (const [norm, et] of byNorm) {
    if (norm.length < 3) continue;
    if (
      rawLower.includes(norm) ||
      plain.includes(normalizePlain(et))
    ) {
      found.add(et);
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const hit of found) {
    const exact = byNorm.get(hit.toLowerCase()) || hit;
    const key = exact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(exact);
  }
  // Preferir etiquetas más largas / con letras (OF-0026 antes que 0026)
  return out.sort((a, b) => {
    const aScore = (/[a-z]/i.test(a) ? 100 : 0) + a.length;
    const bScore = (/[a-z]/i.test(b) ? 100 : 0) + b.length;
    return bScore - aScore;
  });
}

function looksLikeMutationVerb(userText: string) {
  const n = normalizeChatIntent(userText);
  if (!n) return false;
  return intentHas(
    n,
    "corrige",
    "corregir",
    "cambia",
    "cambiar",
    "actualiza",
    "actualizar",
    "modifica",
    "modificar",
    "aplica",
    "aplicar",
    "arregla",
    "arreglar",
    "edita",
    "editar",
    "pon",
    "poner",
    "restaura",
    "restaurar",
    "revierte",
    "revertir",
    "deshaz",
    "deshacer",
  );
}

function looksLikeWrongRecordRepairAsk(userText: string) {
  const n = normalizeChatIntent(userText);
  if (!n) return false;
  return (
    /\b(al otro|el otro|la otra|ese otro|esa otra|el equivocado|la equivocada|el incorrecto|el error)\b/.test(
      n,
    ) ||
    /\b(te equivoc|se equivoc|aplicaste mal|cambio mal|registro equivoc|no era (ese|esa|ese id|esa etiqueta)|era (este|esta|el otro))\b/.test(
      n,
    ) ||
    /\b(el correcto|la correcta|el que quiero|la que quiero|este es (el|su|la)|esta es (la|su))\b/.test(
      n,
    )
  );
}

/** Prefijo de etiqueta: “el de CF”, “empieza con OF”, “código RH”. */
function extractEtiquetaPrefixAsk(userText: string): string | undefined {
  const turn = analyzeTurnQuick(userText);
  if (turn.etiquetaPrefix) return turn.etiquetaPrefix;
  const raw = String(userText || "");
  const n = normalizeChatIntent(userText);
  const m =
    raw.match(/\b(?:codigo|código|etiqueta|tag|folio)\s+de\s+([A-Za-z]{1,6})\b/i) ||
    raw.match(/\b(?:codigo|código|etiqueta|tag|folio)\s+([A-Za-z]{2,6})\b/i) ||
    n.match(
      /\b(?:empieza(?:n)?\s+con|comienza(?:n)?\s+con|que\s+empieza?\s+con|prefijo|empiece\s+con)\s+([a-z]{1,6})\b/,
    ) ||
    raw.match(/\b([A-Za-z]{2,4})\s+o\s+que\s+empieza/i) ||
    raw.match(/\bempieza(?:n)?\s+con\s+([A-Za-z]{1,6})\b/i);
  const prefix = String(m?.[1] || "").trim().toLowerCase();
  if (!prefix || prefix.length < 1 || prefix.length > 6) return undefined;
  if (
    /^(el|la|los|las|de|un|una|con|por|que|como|antes|activo|area|id|lo|te|me|se|ya|en|al|codigo|etiqueta)$/i.test(
      prefix,
    )
  ) {
    return undefined;
  }
  return prefix;
}

function looksLikeEtiquetaOnlyReply(userText: string) {
  const t = String(userText || "").trim();
  if (!t || t.length > 40) return false;
  return /^(?:etiqueta\s+)?[A-Za-z]{0,10}[-_/]?[A-Za-z0-9]*\d{2,10}$/i.test(t);
}

type InferredFieldPatch = { field: string; value: string };

type PendingFixContext = {
  revert: ChatFieldChange | null;
  patches: InferredFieldPatch[];
  askedAt: number;
};

function buildApplyChangesForRow(
  targetRow: InventarioRow,
  patches: InferredFieldPatch[],
  sessionId: string | null,
): ChatFieldChange[] {
  return patches.map((p) => {
    const currentVal = String(
      (targetRow as Record<string, unknown>)[p.field] ?? "",
    ).trim();
    return {
      at: new Date().toISOString(),
      id: targetRow.id,
      etiqueta: String(targetRow.etiqueta ?? ""),
      articulo: String(targetRow.articulo ?? ""),
      field: p.field,
      oldValue: currentVal || "(vacío)",
      newValue: p.value,
      chatId: sessionId,
    };
  });
}

/** Intención de escribir / corregir / revertir — delega al clasificador. */
function looksLikeRecordMutationAsk(userText: string) {
  const turn = analyzeTurnQuick(userText);
  if (turn.isWriteTurn) return true;
  if (turn.primaryAction === "mutate" || turn.primaryAction === "revert") {
    return true;
  }
  // Compat con heurísticas previas (multi-petición / typos).
  const n = normalizeChatIntent(userText);
  if (!n) return false;
  if (looksLikeRevertPreviousValue(userText)) return true;
  if (looksLikeWrongRecordRepairAsk(userText)) return true;
  if (/\b(como antes|como estaba|valor anterior)\b/.test(n)) return true;
  if (extractEtiquetaPrefixAsk(userText) || turn.etiquetaPrefix) return true;
  return false;
}

/**
 * Consultas → n8n; estas intenciones siguen el pipeline local
 * (Excel, merge, crear, mutar, borrar, QR, formulario).
 */
function shouldKeepLocalWritePipeline(
  userText: string,
  inventory: InventarioRow[],
  opts?: { pendingNewInventario?: boolean; pendingCopyEtiquetaDest?: boolean },
): boolean {
  if (opts?.pendingNewInventario) return true;
  if (opts?.pendingCopyEtiquetaDest) return true;
  if (looksLikeRecordMutationAsk(userText)) return true;
  if (looksLikeDeleteRecordAsk(userText) || looksLikeDeleteInventoryAsk(userText)) {
    return true;
  }
  if (userAskedQr(userText)) return true;
  // Export Excel → siempre backend (preparar/confirmar_exportacion_excel).
  if (detectChatDeleteIntent(userText, listExistingOrigens(inventory))) {
    return true;
  }
  const n = normalizeChatIntent(userText);
  if (
    /\b(nuevo\s+registro|subir(le)?\s+(un\s+)?registro|opciones\s+a\s+llenar|como\s+crear|alta\s+(de\s+)?registro|llenar\s+(el\s+)?formulario)\b/.test(
      n,
    )
  ) {
    return true;
  }
  const origens = listExistingOrigens(inventory);
  if (detectCreateInventarioAsk(userText, origens)) return true;
  if (detectCompareInventariosAsk(userText, origens)) return true;
  if (detectCompareScopedListAsk(userText, origens)) return true;
  if (
    /\b(compara|comparar|comparacion|diff|diferencia|diferencias)\b/i.test(
      userText,
    )
  ) {
    return true;
  }
  if (detectBulkCopyBetweenInventariosAsk(userText, origens)) return true;
  if (detectBulkCopyAllOthersToInventarioAsk(userText, origens)) return true;
  if (detectCopyEtiquetasToInventarioAsk(userText, origens)) return true;
  if (detectCopyEtiquetaNeedsDestAsk(userText, origens)) return true;
  if (detectCopyPersonRecordsToInventarioAsk(userText, origens)) return true;
  if (detectListInventariosAsk(userText)) return true;
  if (detectBulkTransferAsk(userText)) return true;
  if (looksLikeInventarioMultiAsk(userText)) return true;
  return false;
}

const N8N_OVERVIEWS = new Set<ViewerOverview>([
  "full",
  "stats",
  "areas",
  "personas",
  "recent",
  "marcas",
  "estado",
  "personTotal",
  "areaTotal",
  "areaMatches",
  "personMatches",
]);

function resolveN8nMostrarPanel(
  accion: Accion | null,
  inventory: InventarioRow[],
): {
  resultItems: ChatApiItem[];
  viewerOverview?: ViewerOverview;
  viewerFocus?: string;
} | null {
  if (!accion || accion.tipo !== "mostrar_panel") return null;
  const limitRaw = Number(accion.limit);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), MAX_ETIQUETA_LIST)
      : MAX_ETIQUETA_LIST;
  const overviewRaw = String(accion.overview || "").trim() as ViewerOverview;
  const overview = N8N_OVERVIEWS.has(overviewRaw) ? overviewRaw : undefined;
  const persona = String(accion.persona || "").trim();
  const area = String(accion.area || "").trim();
  const origen = String(accion.origen || accion.filtros?.origen || "").trim();
  const focus = String(accion.focus || persona || area || origen || "").trim();

  const fold = (s: string) => normalizeChatIntent(s);
  let rows: InventarioRow[] = [];

  if (persona) {
    rows = rowsForPersonName(inventory, persona);
    if (!rows.length) {
      const hit = getAllPersonCatalog(inventory).find(
        (p) =>
          fold(p.name) === fold(persona) ||
          fold(p.name).includes(fold(persona)) ||
          fold(persona).includes(fold(p.name)),
      );
      if (hit) rows = hit.rows;
    }
  } else if (area) {
    const catalog = getAllAreaCatalog(inventory);
    const hit =
      catalog.find((c) => fold(c.name) === fold(area)) ||
      catalog.find(
        (c) =>
          fold(c.name).includes(fold(area)) ||
          fold(area).includes(fold(c.name)),
      );
    rows = hit ? hit.rows : [];
  } else if (origen) {
    const want = fold(origen);
    rows = inventory.filter((row) => fold(String(row.origen ?? "")) === want);
  }

  if (!rows.length && overview === "recent") {
    rows = [...inventory]
      .sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0))
      .slice(0, Math.min(limit, 10));
  }

  const sliced = rows.slice(0, limit);
  const viewerOverview =
    overview ||
    (persona
      ? sliced.length
        ? undefined
        : "personTotal"
      : area
        ? "areaTotal"
        : origen
          ? "recent"
          : undefined);
  const viewerFocus = focus || undefined;

  if (!sliced.length && !viewerOverview) return null;

  return {
    resultItems: sliced.map((row) => rowToChatApiItem(row)),
    viewerOverview: sliced.length && !overview && persona ? undefined : viewerOverview,
    viewerFocus:
      persona && sliced.length && !overview
        ? persona
        : viewerFocus,
  };
}

function stripLeadingAffirmative(userText: string) {
  return String(userText || "")
    .trim()
    .replace(
      /^(sí|si|yes|ok|okay|okey|vale|dale|claro|listo|de acuerdo|confirma|confirmo|adelante|hazlo|procede|proceder)([\s,.:;!-]+|$)/i,
      "",
    )
    .replace(/^(y|tambien|además|ademas)\s+/i, "")
    .trim();
}

/** Infiera estado/observaciones/etc. desde lenguaje natural (cualquier registro). */
function inferFieldPatchesFromText(userText: string): InferredFieldPatch[] {
  const n = normalizeChatIntent(userText);
  if (!n) return [];
  const patches: InferredFieldPatch[] = [];

  if (
    /\b(inactivo|inactiva|dar\s+de\s+baja|dado\s+de\s+baja)\b/.test(n)
  ) {
    patches.push({ field: "estado", value: "Inactivo" });
  } else if (
    /\b(activo|activa|reactivar|activar)\b/.test(n) &&
    !/\b(cuantos|cuantas|totales?|salud|porcentaje)\b/.test(n)
  ) {
    patches.push({ field: "estado", value: "Activo" });
  }

  const quoted =
    userText.match(/["“«]([^"”»]{3,200})["”»]/)?.[1] ||
    userText.match(/'([^']{3,200})'/)?.[1];
  if (quoted && quoted.trim().length >= 3) {
    patches.push({ field: "observaciones", value: quoted.trim() });
  } else if (
    /\b(arreglad|reparad|ya\s+funciona|funciona\s+correct|equipo\s+reparad|computadora\s+arreg|pc\s+arreg|laptop\s+arreg)\b/.test(
      n,
    )
  ) {
    patches.push({
      field: "observaciones",
      value: "Equipo reparado, ya funciona correctamente",
    });
  } else {
    const obs =
      userText.match(
        /observaciones?\s*[:=]\s*["“]?([^"”\n]+)["”]?/i,
      )?.[1] ||
      userText.match(
        /(?:nota|comentario)\s*[:=]\s*["“]?([^"”\n]+)["”]?/i,
      )?.[1];
    if (obs && obs.trim().length >= 3) {
      patches.push({ field: "observaciones", value: obs.trim() });
    }
  }

  // Solo asignar persona con señal clara (evitar “por lo que…” / falsos positivos).
  const persona = userText.match(
    /(?:\bpersona\s*[:=]\s*|\basignar(?:lo|la)?\s+a\s+|\bponer(?:lo|la)?\s+a\s+)([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ .]{2,40})/i,
  )?.[1];
  if (
    persona &&
    !/^(activo|inactivo|el|la|los|las|lo|que|te|dije|antes)\b/i.test(
      persona.trim(),
    )
  ) {
    patches.push({ field: "persona", value: persona.trim() });
  }

  const area = userText.match(
    /(?:\barea|\bárea)\s*[:=]\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9][A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 ./-]{1,40})/i,
  )?.[1];
  if (area) patches.push({ field: "area", value: area.trim() });

  return patches;
}

/** Resuelve etiqueta citada contra inventario (typos OF/CF, mayúsculas…). */
function resolveEtiquetaAgainstInventory(
  rawEtiqueta: string,
  inventory: InventarioRow[],
): InventarioRow | undefined {
  const needle = String(rawEtiqueta || "").trim();
  if (!needle || !inventory.length) return undefined;
  const lower = needle.toLowerCase();
  const exact = inventory.find(
    (row) => String(row.etiqueta ?? "").trim().toLowerCase() === lower,
  );
  if (exact) return exact;

  // Prefijo letra confuso (CF-0026 vs OF-0026): mismo sufijo numérico
  const m = needle.match(/^([A-Za-z]{1,6})([-_/]?)(\d{2,8})$/);
  if (m) {
    const suffix = m[3];
    const sep = m[2] || "-";
    const candidates = inventory.filter((row) => {
      const et = String(row.etiqueta ?? "").trim();
      const em = et.match(/^([A-Za-z]{1,6})([-_/]?)(\d{2,8})$/i);
      return Boolean(em && em[3] === suffix);
    });
    if (candidates.length === 1) return candidates[0];
    const swapped = inventory.find((row) => {
      const et = String(row.etiqueta ?? "").trim().toLowerCase();
      return (
        et === `o${lower.slice(1)}` ||
        et === `c${lower.slice(1)}` ||
        et === `${m[1].toLowerCase() === "cf" ? "of" : "cf"}${sep}${suffix}`.toLowerCase()
      );
    });
    if (swapped) return swapped;
  }
  return undefined;
}

type RecordMutationPlan =
  | {
      action: "multi";
      revert?: ChatFieldChange | null;
      applies: Array<{
        etiqueta: string;
        row: InventarioRow;
        patches: InferredFieldPatch[];
      }>;
      ask?: string;
    }
  | {
      action: "fix_and_revert";
      fixEtiqueta: string;
      last: ChatFieldChange;
      patches?: InferredFieldPatch[];
    }
  | { action: "revert_only"; last: ChatFieldChange }
  | {
      action: "propose_patches";
      fixEtiqueta: string;
      patches: InferredFieldPatch[];
    }
  | {
      action: "ask_fix_etiqueta";
      last: ChatFieldChange | null;
      hint?: string;
    }
  | { action: "pass_to_llm" };

type EtiquetaSpan = {
  raw: string;
  etiqueta: string;
  row?: InventarioRow;
  start: number;
  end: number;
};

/** Localiza cada etiqueta citada con su posición (para multi-petición). */
function extractEtiquetaSpans(
  userText: string,
  inventory: InventarioRow[],
): EtiquetaSpan[] {
  const raw = String(userText || "");
  if (!raw.trim()) return [];
  const spans: EtiquetaSpan[] = [];
  const seen = new Set<string>();
  const pushSpan = (value: string, start: number, end: number) => {
    const cleaned = String(value || "").trim();
    if (!cleaned) return;
    const row = resolveEtiquetaAgainstInventory(cleaned, inventory);
    const etiqueta = String(row?.etiqueta ?? cleaned);
    const key = `${etiqueta.toLowerCase()}@${start}`;
    if (seen.has(key)) return;
    seen.add(key);
    spans.push({ raw: cleaned, etiqueta, row, start, end });
  };

  for (const match of raw.matchAll(
    /\b([A-Za-z]{1,10}[-_/]?[A-Za-z0-9]*\d{2,8}|\d{4,10})\b/g,
  )) {
    if (match.index == null) continue;
    pushSpan(match[1], match.index, match.index + match[1].length);
  }
  for (const match of raw.matchAll(
    /(?:etiqueta|tag|folio|codigo|id)\s*[:=]?\s*\*{0,2}([A-Za-z0-9/_-]{2,})\*{0,2}/gi,
  )) {
    if (match.index == null) continue;
    pushSpan(match[1], match.index, match.index + match[0].length);
  }

  // Etiquetas del inventario presentes en texto (cualquier formato)
  for (const row of inventory) {
    const et = String(row.etiqueta ?? "").trim();
    if (!et || et.length < 3) continue;
    const idx = raw.toLowerCase().indexOf(et.toLowerCase());
    if (idx >= 0) pushSpan(et, idx, idx + et.length);
  }

  return spans.sort((a, b) => a.start - b.start);
}

function clauseForSpan(
  userText: string,
  span: EtiquetaSpan,
  all: EtiquetaSpan[],
): string {
  const idx = all.findIndex((s) => s.start === span.start && s.end === span.end);
  const prevEnd = idx > 0 ? all[idx - 1].end : 0;
  const nextStart = idx >= 0 && idx < all.length - 1 ? all[idx + 1].start : userText.length;
  // Un poco antes de la etiqueta para capturar “deja … como antes”
  const start = Math.max(prevEnd, span.start - 48);
  return userText.slice(start, nextStart).trim();
}

function clauseWantsRevert(clause: string) {
  const n = normalizeChatIntent(clause);
  return (
    looksLikeRevertPreviousValue(clause) ||
    /\b(como antes|como estaba|valor anterior|restaura|restaurar|deshaz|deshacer|revierte)\b/.test(
      n,
    )
  );
}

function clauseWantsChange(clause: string) {
  return (
    looksLikeMutationVerb(clause) ||
    inferFieldPatchesFromText(clause).length > 0 ||
    /\b(cambialo|cambiala|corrigelo|corrigela|ponlo|ponla|actualizalo|modificalo)\b/.test(
      normalizeChatIntent(clause),
    )
  );
}

/**
 * Multi-petición genérica: un mensaje puede pedir varias acciones
 * sobre distintas etiquetas (revertir A + corregir B + …).
 */
function detectMultiRecordMutationPlan(
  userText: string,
  inventory: InventarioRow[],
  lastChange: ChatFieldChange | null | undefined,
): RecordMutationPlan | undefined {
  if (!looksLikeRecordMutationAsk(userText)) return undefined;
  const n = normalizeChatIntent(userText);
  let spans = extractEtiquetaSpans(userText, inventory);
  const globalPatches = inferFieldPatchesFromText(userText);
  const globalRevert =
    looksLikeRevertPreviousValue(userText) ||
    looksLikeWrongRecordRepairAsk(userText) ||
    /\b(como antes|como estaba|valor anterior)\b/.test(n);

  // “el código CF / empieza con CF” → etiquetas por prefijo (cualquier serie).
  const turnGate = analyzeTurnQuick(userText, inventory);
  const prefix = turnGate.etiquetaPrefix || extractEtiquetaPrefixAsk(userText);
  if (prefix && !spans.some((s) => s.etiqueta.toLowerCase().startsWith(prefix))) {
    const prefixed = rowsByEtiquetaPrefix(prefix, inventory);
    if (prefixed.length === 1) {
      const row = prefixed[0];
      const et = String(row.etiqueta ?? "");
      spans = [
        ...spans,
        {
          raw: et,
          etiqueta: et,
          row,
          start: userText.toLowerCase().indexOf(prefix),
          end: userText.toLowerCase().indexOf(prefix) + prefix.length,
        },
      ].sort((a, b) => a.start - b.start);
    } else if (prefixed.length > 1 && globalPatches.length) {
      // Varias CF-*: pedir cuál, sin abrir personas/áreas.
      return {
        action: "ask_fix_etiqueta",
        last: lastChange || null,
        hint: prefixed
          .slice(0, 6)
          .map((r) => String(r.etiqueta ?? ""))
          .filter(Boolean)
          .join(", "),
      };
    }
  }

  const applies: Array<{
    etiqueta: string;
    row: InventarioRow;
    patches: InferredFieldPatch[];
  }> = [];
  let revert: ChatFieldChange | null | undefined;
  const unresolved: string[] = [];

  for (const span of spans) {
    const clause = clauseForSpan(userText, span, spans);
    const localPatches = inferFieldPatchesFromText(clause);
    const wantRevert = clauseWantsRevert(clause);
    const wantChange = clauseWantsChange(clause);
    const row =
      span.row || resolveEtiquetaAgainstInventory(span.etiqueta, inventory);

    if (wantRevert) {
      if (
        lastChange &&
        String(lastChange.etiqueta ?? "")
          .trim()
          .toLowerCase() === span.etiqueta.trim().toLowerCase()
      ) {
        revert = lastChange;
      } else if (lastChange && spans.length >= 2 && !revert) {
        // “deja E1 como antes” aunque el lastChange sea E1
        const lastEt = String(lastChange.etiqueta ?? "")
          .trim()
          .toLowerCase();
        if (lastEt === span.etiqueta.trim().toLowerCase() || lastEt === span.raw.toLowerCase()) {
          revert = lastChange;
        } else if (
          String(lastChange.id ?? "") === span.raw ||
          String(lastChange.id ?? "") === span.etiqueta
        ) {
          revert = lastChange;
        }
      }
      // Si piden revertir una etiqueta concreta igual al último cambio
      if (
        !revert &&
        lastChange &&
        String(lastChange.etiqueta ?? "").trim().toLowerCase() ===
          String(row?.etiqueta ?? span.etiqueta)
            .trim()
            .toLowerCase()
      ) {
        revert = lastChange;
      }
    }

    if (wantChange) {
      if (!row?.id) {
        unresolved.push(span.raw || span.etiqueta);
        continue;
      }
      let patches = localPatches.length ? localPatches : [];
      // Sin patches locales: hereda globales o el valor del último cambio movido
      if (!patches.length && globalPatches.length && spans.length === 1) {
        patches = globalPatches;
      }
      if (
        !patches.length &&
        lastChange &&
        String(lastChange.etiqueta ?? "")
          .trim()
          .toLowerCase() !==
          String(row.etiqueta ?? "")
            .trim()
            .toLowerCase()
      ) {
        // “cámbialo / corrígelo” sin detalle → reutilizar el valor del cambio previo
        patches = [{ field: lastChange.field, value: lastChange.newValue }];
      }
      if (!patches.length && globalPatches.length) {
        patches = globalPatches;
      }
      if (patches.length) {
        applies.push({
          etiqueta: String(row.etiqueta ?? span.etiqueta),
          row,
          patches,
        });
      } else {
        unresolved.push(String(row.etiqueta ?? span.etiqueta));
      }
    }
  }

  // “al otro déjalo como antes” sin repetir la etiqueta mala
  if (!revert && globalRevert && lastChange) {
    const lastEt = String(lastChange.etiqueta ?? "")
      .trim()
      .toLowerCase();
    const appliesOther = applies.some(
      (a) => a.etiqueta.trim().toLowerCase() !== lastEt,
    );
    if (appliesOther || looksLikeWrongRecordRepairAsk(userText) || spans.length === 0) {
      revert = lastChange;
    }
    // Una sola etiqueta mencionada + revert global → esa es la a restaurar si coincide
    if (
      !revert &&
      spans.length === 1 &&
      lastEt === spans[0].etiqueta.trim().toLowerCase()
    ) {
      revert = lastChange;
    }
    if (!revert && spans.length === 1 && lastChange) {
      // “deja 281367 como antes” aunque digan id
      const only = spans[0];
      if (
        lastEt === only.etiqueta.toLowerCase() ||
        lastEt === only.raw.toLowerCase() ||
        String(lastChange.id) === only.raw
      ) {
        revert = lastChange;
      }
    }
    if (!revert && lastChange && (globalRevert || spans.length === 0)) {
      revert = lastChange;
    }
  }

  // Una etiqueta + patches globales (sin verbo de revert)
  if (!applies.length && spans.length === 1 && globalPatches.length) {
    const span = spans[0];
    const row =
      span.row || resolveEtiquetaAgainstInventory(span.etiqueta, inventory);
    if (row?.id) {
      applies.push({
        etiqueta: String(row.etiqueta ?? span.etiqueta),
        row,
        patches: globalPatches,
      });
    }
  }

  if (revert || applies.length) {
    return {
      action: "multi",
      revert: revert || null,
      applies,
      ask: unresolved.length
        ? `No pude resolver: ${unresolved.map((u) => `**${u}**`).join(", ")}. ¿Me confirmas la etiqueta exacta?`
        : undefined,
    };
  }

  if (unresolved.length) {
    return {
      action: "ask_fix_etiqueta",
      last: lastChange || null,
      hint: unresolved[0],
    };
  }

  if (globalRevert && !lastChange) {
    return { action: "ask_fix_etiqueta", last: null, hint: "" };
  }

  return { action: "pass_to_llm" };
}

/** Compat: delega al plan multi genérico. */
function detectRecordMutationPlan(
  userText: string,
  inventory: InventarioRow[],
  lastChange: ChatFieldChange | null | undefined,
): RecordMutationPlan | undefined {
  return detectMultiRecordMutationPlan(userText, inventory, lastChange);
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

/** Inventario / totales de una persona concreta (p. ej. Martín / Eduardo). */
function detectPersonTotalAsk(
  userText: string,
  inventory: InventarioRow[],
  recentMessages?: Array<{ from: string; text: string; resultItems?: ChatApiItem[] }>,
): string | undefined {
  const user = normalizeChatIntent(userText);
  if (!user) return undefined;
  if (parseEtiquetaListAsk(userText) != null) return undefined;
  if (userAskedQr(userText)) return undefined;
  const turn = analyzeTurnQuick(userText, inventory);
  if (turn.isWriteTurn || turn.discourseOnly || looksLikeRecordMutationAsk(userText)) {
    return undefined;
  }
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
    intentHas(user, "dame", "muestra", "mostrar", "ver", "ensename", "lista", "listar", "todos", "todas");
  // Nombre del catálogo (también “Eduardo” → “Eduardo Delgado”).
  const named = resolvePersonFocus(userText, inventory, recentMessages);
  if (named && (wantsPersonView || looksLikePersonAnaphora(userText))) {
    return named;
  }
  // Persona solo si el clasificador vio consulta de persona o un nombre real del catálogo.
  if (
    turn.primaryAction !== "query_person" &&
    !turn.personas.length &&
    !named &&
    !/\b(persona|personas|quien|quienes)\b/.test(turn.normalized)
  ) {
    return undefined;
  }
  if (!wantsPersonView && !looksLikePersonAnaphora(userText)) {
    if (named && user.split(/\s+/).length <= 4) return named;
    return undefined;
  }
  return named || resolvePersonFocus(userText, inventory, recentMessages);
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
  cmabialo: "cambia",
  cmabiaro: "cambia",
  cambialo: "cambia",
  cambiala: "cambia",
  crrigelo: "corrige",
  crrigeló: "corrige",
  corrigelo: "corrige",
  corrigela: "corrige",
  corrijelo: "corrige",
  arrgelada: "arreglada",
  arrgelado: "arreglado",
  arregada: "arreglada",
  reparada: "reparada",
  // No convertir “perdón/perdon” → persona (revuelve overview de personas).
  perdon: "perdon",
  perdón: "perdon",
  eja: "deja",
  ejalo: "dejalo",
  dejal: "deja",
  dejalo: "dejalo",
  dejala: "dejala",
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

/** Muletillas: nunca “corregir” a persona/área/registro por distancia. */
const INTENT_DISCOURSE_LOCK = new Set([
  "perdon",
  "perdona",
  "perdoname",
  "disculpa",
  "disculpe",
  "gracias",
  "hola",
  "hey",
  "ok",
  "okay",
  "vale",
  "bueno",
  "bien",
  "claro",
  "listo",
  "ahora",
  "entonces",
  "pues",
  "mira",
  "favor",
  "por",
  "que",
  "te",
  "me",
  "lo",
  "la",
  "de",
  "dije",
  "dicho",
]);

function correctIntentToken(token: string) {
  if (!token) return token;
  if (INTENT_DISCOURSE_LOCK.has(token)) return token;
  if (INTENT_ALIAS[token]) return INTENT_ALIAS[token];
  if (INTENT_CANONICAL_SET.has(token)) return token;
  const budget = typoBudget(token);
  if (budget <= 0) return token;
  let best = token;
  let bestDist = Infinity;
  for (const canon of intentCandidatesFor(token)) {
    // No mapear muletillas hacia entidades de dominio.
    if (canon === "persona" || canon === "personas" || canon === "area" || canon === "areas") {
      if (token.length <= 7 && !token.startsWith(canon.slice(0, 3))) continue;
    }
    const dist = levenshtein(token, canon);
    // Prefijo distinto (Vargas→marcas): solo dist 1. Evita apellidos→keywords.
    const samePrefix = token.slice(0, 1) === canon.slice(0, 1);
    const maxDist = samePrefix ? budget : Math.min(1, budget);
    if (dist < bestDist && dist <= maxDist) {
      bestDist = dist;
      best = canon;
      if (dist === 1) break;
    }
  }
  return best;
}

function analyzeTurnQuick(
  userText: string,
  inventory: InventarioRow[] = [],
): ChatTurnAnalysis {
  const personNames = inventory.length
    ? [
        ...new Set(
          inventory
            .map((r) => String(r.persona ?? "").trim())
            .filter(Boolean),
        ),
      ]
    : [];
  const areaNames = inventory.length
    ? [
        ...new Set(
          inventory
            .map((r) => String(r.area ?? "").trim())
            .filter(Boolean),
        ),
      ]
    : [];
  return analyzeChatTurn({
    text: userText,
    inventory,
    personNames,
    areaNames,
  });
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
  if (looksLikeRecordMutationAsk(userText)) return undefined;
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
  // Acuse conversacional (“bien me parece perfecto”) sin verbo de consulta.
  const hasInventoryAsk =
    /\b(dame|muestra|mostrar|ver|lista|listar|cuant|busca|buscar|etiqueta|etiquetas|inventario|inventarios|area|areas|persona|personas|qr|exporta|importa|compara|duplicad|crea|crear|pasa|pasar|copia|borra|elimina|cambia|actualiza|ultimos?|recientes?)\b/.test(
      n,
    );
  if (
    !hasInventoryAsk &&
    /\b(me parece|esta bien|esta perfecto|todo bien|muy bien|que bien|de acuerdo|perfecto|excelente|genial|gracias|entendido|listo|claro que si)\b/.test(
      n,
    )
  ) {
    return true;
  }
  // Frase corta solo con muletillas de acuse.
  const ackTok =
    /^(ok|okay|okey|vale|va|sale|bueno|bien|gracias|perfecto|perfecta|excelente|genial|super|listo|entendido|entiendo|claro|dale|sip|si|de|acuerdo|esta|muy|todo|me|parece|correcto|jaj+|jaja+|jeje+|xd)$/;
  const toks = n.split(/\s+/).filter(Boolean);
  if (toks.length > 0 && toks.length <= 8 && toks.every((t) => ackTok.test(t))) {
    return true;
  }
  return false;
}

/** Respuesta corta de acuse (sin plantilla de área). */
function buildConversationalAckReply(userText: string): string {
  return pickChatVariant(
    [
      "Perfecto. Cuando quieras seguimos con otra consulta del inventario.",
      "De acuerdo. ¿Revisamos algo más: persona, área, últimos registros o QR?",
      "Me alegra que te sirva. Dime qué quieres ver o ajustar a continuación.",
      "Listo. Estoy aquí para la siguiente consulta cuando la necesites.",
      "Entendido. Si quieres, vemos etiquetas, un área o exportamos a Excel.",
    ],
    userText,
  );
}

/** Saludos / “qué se puede hacer”: conversación en texto; incidencia solo si aporta. */
function isExploratoryChatAsk(userText: string) {
  const n = normalizeChatIntent(userText);
  if (!n) return true;
  if (isNonConcreteChatAsk(userText)) return true;
  if (
    /\b(que se puede|que puedes|que puedo|que hacemos|que hay para|que hay de nuevo|el dia de hoy|para que sirves|como te uso|como funciona|en que me ayudas|opciones|gustaria saber|quisiera saber|me ayudas|ideas?\s+(de\s+)?consultas?)\b/.test(
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
  const explicitInternalId = /\b(id\s*interno|id\s*#|primary\s*key)\b/i.test(
    `${userText}\n${botText}`,
  );
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
    // Solo caer a id interno si lo pidieron explícito o el número es largo
    // y no parece una etiqueta parcial. Evita OF-0026 → id 26.
    if (/^\d+$/.test(needle) && (explicitInternalId || needle.length >= 4)) {
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
  if (detectRecentRecordsAsk(userText)) return true;
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
  if (looksLikeRecordMutationAsk(userText)) return undefined;
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
  if (looksLikeRecordMutationAsk(userText)) return undefined;
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

/**
 * “qué hay en el Inventario 1” / “dame registros del inventario 2”
 * (contenido por origen, no área).
 */
function detectOrigenBrowseAsk(
  userText: string,
  inventory: InventarioRow[],
): { origen: string; limit: number | null } | undefined {
  const n = normalizeChatIntent(userText);
  if (!n || !inventory.length) return undefined;
  if (detectOrigenPersonasAsk(userText, inventory)) return undefined;
  if (detectCompareInventariosAsk(userText, listExistingOrigens(inventory))) {
    return undefined;
  }
  if (detectBulkCopyBetweenInventariosAsk(userText, listExistingOrigens(inventory))) {
    return undefined;
  }
  if (looksLikeDeleteRecordAsk(userText) || looksLikeRecordMutationAsk(userText)) {
    return undefined;
  }
  // Crear inventario / alta / copiar ≠ “qué hay en Inventario N”.
  if (
    /\b(crea|crear|crealo|creala|creame|crees|creas|haz|hacer|abre|abrir|genera|generar|nuevo\s+registro|subir(le)?\s+un\s+registro|opciones\s+a\s+llenar|como\s+crear|mete\w*|pasa\w*|copia\w*|importa\w*|mueve\w*|traslad\w*)\b/.test(
      n,
    )
  ) {
    return undefined;
  }
  // “dame el excel…” / “áreas del Inventario 5” → otros detectores.
  if (
    /\b(excel|xlsx|xls|csv|spreadsheet|hoja\s+de\s+calculo)\b/.test(n) ||
    /\b(exportar|descargar|exporta|descarga)\b/.test(n)
  ) {
    return undefined;
  }
  if (/\b(areas?|personas?|estados?)\b/.test(n)) {
    return undefined;
  }
  const origen = matchOrigenFromPrompt(userText, listExistingOrigens(inventory));
  if (!origen || !/\binventarios?\s*\d+\b/.test(n)) return undefined;
  // Solo listado/contenido del origen (no “dame” suelto ni campos).
  const wantsBrowse =
    /\b(que\s+hay|que\s+tiene|cuantos?|cuantas?|muestra|mostrar|ver|lista|listar|trae|contenido|articulos?|equipos?|todo|toda|todos|todas|resumen|detalle)\b/.test(
      n,
    ) ||
    (/\bregistros?\b/.test(n) &&
      !/\b(nuevo|crear|crea|subir|llenar|alta|areas?|excel)\b/.test(n)) ||
    (/\bdame\b/.test(n) &&
      /\b(registros?|articulos?|equipos?|contenido|listado)\b/.test(n)) ||
    /\ben\s+el\s+inventario\s*\d+\b/.test(n);
  if (!wantsBrowse) return undefined;
  const count = parseRequestedCount(userText);
  return {
    origen,
    limit: count != null ? Math.max(1, Math.min(50, count)) : null,
  };
}

/** “áreas / personas / estado del Inventario 5”. */
function detectOrigenFieldAsk(
  userText: string,
  inventory: InventarioRow[],
): { origen: string; field: "area" | "persona" | "estado" } | undefined {
  const n = normalizeChatIntent(userText);
  if (!n || !inventory.length) return undefined;
  if (
    /\b(excel|xlsx|xls|csv|exportar|descargar)\b/.test(n) ||
    /\b(crea|crear|crealo|nuevo\s+registro)\b/.test(n)
  ) {
    return undefined;
  }
  if (!/\binventarios?\s*\d+\b/.test(n)) return undefined;
  const origen = matchOrigenFromPrompt(
    userText,
    listExistingOrigens(inventory),
  );
  if (!origen) return undefined;
  if (/\b(areas?|departamento|departamentos)\b/.test(n)) {
    return { origen, field: "area" };
  }
  if (/\b(personas?|asignad|responsable)\b/.test(n)) {
    return { origen, field: "persona" };
  }
  if (/\b(estados?|activos?|inactivos?)\b/.test(n)) {
    return { origen, field: "estado" };
  }
  return undefined;
}

function buildOrigenBrowseReply(
  origen: string,
  inventory: InventarioRow[],
  limit: number | null,
): { reply: string; shownRows: InventarioRow[] } {
  const label = canonicalizeOrigenLabel(origen);
  const rows = inventory.filter((row) =>
    origensMatch(String(row.origen ?? ""), origen),
  );
  if (!rows.length) {
    return {
      reply:
        `No encontré registros en **${label}**. ` +
        `¿Quieres probar con otro inventario (Inventario 1, Inventario 2…) o con S/O?`,
      shownRows: [],
    };
  }
  const total = rows.length;
  const personas = new Set(
    rows.map((r) => String(r.persona ?? "").trim()).filter(Boolean),
  ).size;
  const activos = rows.filter(isRowActivo).length;
  const effectiveLimit =
    limit != null
      ? Math.min(total, Math.max(1, limit))
      : Math.min(total, MAX_ETIQUETA_LIST);
  const shownRows = rows.slice(0, effectiveLimit);
  const examples = shownRows
    .slice(0, 3)
    .map((row) => formatRowBrief(row))
    .join(", ");
  const totalLabel = total.toLocaleString("es-MX");
  const open = pickChatVariant(
    [
      `En **${label}** hay **${totalLabel}** registro${total === 1 ? "" : "s"}`,
      `**${label}** concentra **${totalLabel}** ficha${total === 1 ? "" : "s"}`,
      `Para **${label}** localicé **${totalLabel}** registro${total === 1 ? "" : "s"}`,
    ],
    label + totalLabel,
  );
  const stats = ` (**${personas}** persona${personas === 1 ? "" : "s"} · **${activos}** activo${activos === 1 ? "" : "s"}).`;
  const mid = examples
    ? pickChatVariant(
        [
          ` Por ejemplo: ${examples}.`,
          ` Entre ellos: ${examples}.`,
          ` Algunos son ${examples}.`,
        ],
        examples,
      )
    : "";
  const close = pickChatVariant(
    [
      ` El detalle está en el panel. ¿Filtramos por área, persona o exportamos Excel?`,
      ` A la derecha tienes el listado de **${label}**. ¿Seguimos con otra consulta?`,
    ],
    open,
  );
  return { reply: `${open}${stats}${mid}${close}`, shownRows };
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

/** Foco del panel según la petición: Inventario 3, Tickets, todo el inventario… */
function resolveOverviewFocus(
  userText: string,
  inventory: InventarioRow[],
): string | undefined {
  const n = normalizeChatIntent(userText);
  if (!n) return undefined;
  const origens = listExistingOrigens(inventory);
  const origen = matchOrigenFromPrompt(userText, origens);
  if (origen) return origen;
  const typoInv = n.match(
    /\b(?:al)?inventari[oa]?s?\s*(\d+|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/,
  );
  if (typoInv) {
    const wordMap: Record<string, number> = {
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
    const raw = typoInv[1];
    const num = /^\d+$/.test(raw) ? Number(raw) : wordMap[raw];
    if (num && num > 0) {
      const hit = origens.find((o) => {
        const m = String(o).match(/(\d+)/);
        return m && Number(m[1]) === num;
      });
      return hit || `Inventario ${num}`;
    }
  }
  // Área concreta: “totales de tickets”, “panorama de contabilidad”
  const area = matchAreaFromPrompt(userText, inventory);
  if (area) return area;
  const areas = getAllAreaCatalog(inventory);
  for (const a of areas) {
    const an = normalizeChatIntent(a.name);
    if (an.length >= 3 && n.includes(an)) return a.name;
  }
  if (
    /\b(todo|toda|todos|todas|completo|completa|general)\b/.test(n) &&
    /\b(inventario|inventarios|registros)\b/.test(n)
  ) {
    return "Todo el inventario";
  }
  return undefined;
}

function filterInventoryByOverviewFocus(
  inventory: InventarioRow[],
  focus: string | undefined,
): InventarioRow[] {
  const label = String(focus || "").trim();
  if (!label || /^(todo el inventario|en el inventario)$/i.test(label)) {
    return inventory;
  }
  const fold = normalizeChatIntent(label);
  const byOrigen = inventory.filter(
    (row) => normalizeChatIntent(String(row.origen ?? "")) === fold,
  );
  if (byOrigen.length) return byOrigen;
  const byArea = inventory.filter(
    (row) => normalizeChatIntent(String(row.area ?? "")) === fold,
  );
  if (byArea.length) return byArea;
  return inventory;
}

/** Respuestas locales exactas para overview (áreas, totales, etc.). */
function buildLocalOverviewReply(
  overview: ViewerOverview,
  inventory: InventarioRow[],
  focusLabel?: string,
  userText?: string,
): string | null {
  if (!inventory.length) return null;
  const scoped = filterInventoryByOverviewFocus(inventory, focusLabel);
  const total = scoped.length;
  const areaCounts = new Map<string, number>();
  const personCounts = new Map<string, number>();
  const marcaCounts = new Map<string, number>();
  let activos = 0;
  for (const row of scoped) {
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
  const focus = String(focusLabel || "").trim();
  const ask = normalizeChatIntent(userText || "");
  const wantsPanorama = /\b(panorama|resumen|dashboard)\b/.test(ask);
  const scopeTitle = focus
    ? focus
    : wantsPanorama
      ? "Inventario general"
      : "Inventario general";

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
      `En **${scopeTitle}** hay **${fmt(areaCounts.size)}** área` +
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
    const lead = wantsPanorama
      ? `Panorama de **${scopeTitle}**`
      : overview === "stats"
        ? `Totales de **${scopeTitle}**`
        : `**${scopeTitle}**`;
    return (
      `${lead}: **${fmt(total)}** registros, ` +
      `**${fmt(personCounts.size)}** persona${personCounts.size === 1 ? "" : "s"} y ` +
      `**${fmt(areaCounts.size)}** área${areaCounts.size === 1 ? "" : "s"}. ` +
      `Hay **${fmt(activos)}** activos y **${fmt(inactivos)}** inactivos.` +
      topFull +
      ` ¿Seguimos con un área, una persona, últimos registros o códigos QR?`
    );
  }

  if (overview === "personas") {
    const topPeople = [...personCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    const namesProse = topPeople.length
      ? topPeople
          .map(([name, count]) => `**${name}** (${fmt(count)})`)
          .join(", ")
      : "";
    const more =
      personCounts.size > topPeople.length
        ? ` y **${fmt(personCounts.size - topPeople.length)}** más`
        : "";
    const wantsNames =
      /\b(nombres?|esas?\s+\d+\s+personas|quienes|listar?|dame|muestra)\b/.test(
        ask,
      );
    if (wantsNames && namesProse) {
      return pickChatVariant(
        [
          `Estas son las **${fmt(personCounts.size)}** personas de **${scopeTitle}**: ${namesProse}${more}. El ranking completo está en el cuadro de incidencias. ¿Abrimos el inventario de alguien?`,
          `Hay **${fmt(personCounts.size)}** personas con equipo (**${fmt(total)}** registros). Empiezan: ${namesProse}${more}. Mira la plantilla de personas a la derecha o dime un nombre.`,
          `Listo: **${fmt(personCounts.size)}** asignaciones en **${scopeTitle}**. ${namesProse}${more}. ¿Ver más en el panel o filtrar a una persona?`,
        ],
        `personas:${personCounts.size}`,
      );
    }
    return (
      `En **${scopeTitle}** hay **${fmt(personCounts.size)}** persona${personCounts.size === 1 ? "" : "s"} ` +
      `con equipo asignado (**${fmt(total)}** registros). ` +
      `Te abrí la plantilla de personas; dime un nombre para ver su inventario.`
    );
  }

  if (overview === "estado") {
    const pct = total ? Math.round((activos / total) * 100) : 0;
    return (
      `Salud de **${scopeTitle}** (**${fmt(total)}** registros): ` +
      `**${fmt(activos)}** activos (${pct}%) y **${fmt(inactivos)}** inactivos. ` +
      `¿Quieres listar los inactivos o revisar un área?`
    );
  }

  if (overview === "marcas") {
    return (
      `Hay **${fmt(marcaCounts.size)}** marca${marcaCounts.size === 1 ? "" : "s"} ` +
      `registradas en **${scopeTitle}**.\n\n` +
      `Puedo mostrarte el top de marcas o filtrar por una concreta.`
    );
  }

  if (overview === "recent") {
    const ask = { limit: 10, soloHoy: false };
    const rows = getRecentInventoryRows(scoped, ask.limit, ask.soloHoy);
    return buildRecentRecordsReply(rows, ask, { userText: "" });
  }

  return null;
}

/** Pedido de ranking global de áreas (todas / en general / qué áreas hay). */
function wantsGlobalAreasRanking(userText: string): boolean {
  const user = normalizeChatIntent(userText);
  if (!user) return false;
  // Un área concreta (“de TI”, “área Contabilidad”) no es ranking global.
  if (
    /\b(de|del|en)\s+(ti|rh|rrhh|sistemas|marketing|contabilidad|recursos)\b/.test(
      user,
    ) &&
    !/\b(todas|todos|general|ranking|hay|existen)\b/.test(user)
  ) {
    return false;
  }
  if (/\b(registro|registros|etiqueta|etiquetas)\s+(de|del|en)\b/.test(user)) {
    return false;
  }
  return (
    /^(equipos?|articulos?|registros?)\s+por\s+areas?$/.test(user) ||
    /\bareas?\s+en\s+general\b/.test(user) ||
    /\ben\s+general\s+(las?\s+)?areas?\b/.test(user) ||
    /\branking\s+(de\s+)?areas?\b/.test(user) ||
    /\b(todas|todos)\s+(las?\s+)?areas?\b/.test(user) ||
    /^(que|cuales|cuantas)\s+areas\s+(hay|existen|tiene)/.test(user) ||
    /\bareas?\s+(hay|existen|tiene|distintas?)\b/.test(user) ||
    /^(areas?|por\s+areas?)$/.test(user) ||
    (/\bareas?\b/.test(user) &&
      /\b(general|ranking|distribucion|desglose|panorama)\b/.test(user))
  );
}

function detectViewerOverview(userText: string): ViewerOverview | undefined {
  // Solo incidencia visual/contable (estilo Google): no en cada mensaje.
  const user = normalizeChatIntent(userText);
  if (!user || /^(hola|buenas|hey|hi|hello)\b/.test(user)) return undefined;
  // Atajos del home (sin nombres inventados tipo “Juan Pérez”).
  if (/^(busqueda|buscar)\s+por\s+personas?$/.test(user)) return "personas";
  if (/^(equipos?|articulos?|registros?)\s+por\s+areas?$/.test(user)) return "areas";
  // “areas en general” / “ranking de áreas” (también sin verbo dame).
  if (wantsGlobalAreasRanking(userText)) return "areas";
  const turn = analyzeTurnQuick(userText);
  // Escritura / corrección / muletillas: nunca ranking personas/áreas/estado.
  if (turn.isWriteTurn || turn.discourseOnly || looksLikeRecordMutationAsk(userText)) {
    return undefined;
  }
  if (!turn.isCatalogQuery && turn.primaryAction === "unknown") {
    // Sin verbo de consulta de catálogo, no inventar overview.
    if (
      !/\b(dame|muestra|ver|lista|cuant|ranking|todas|todos|resumen|total|busqueda|buscar|equipos|ultimos|areas?|general)\b/.test(
        user,
      )
    ) {
      return undefined;
    }
  }

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

  if (detectRecentRecordsAsk(userText)) {
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
      intentHas(
        user,
        "por",
        "top",
        "desglose",
        "cuantas",
        "cuantos",
        "todas",
        "todos",
        "total",
        "totales",
        "ranking",
        "general",
      ) ||
      /^(areas?|por\s+areas?)$/.test(user) ||
      /\b(?:total(?:es)?|cuant[oa]s?)\s+(?:de\s+|del\s+)?areas?\b/.test(user) ||
      /\bareas?\s+(?:hay|existen|tiene|en\s+total|distintas?|en\s+general)\b/.test(
        user,
      ) ||
      /\branking\s+(?:de\s+)?areas?\b/.test(user) ||
      /\b(?:todas|todos)\s+(?:las?\s+)?areas?\b/.test(user))
  ) {
    // "total de solo una área" → preguntar cuál (no ranking).
    if (
      intentHas(user, "una", "un", "solo", "solamente", "alguna") &&
      !intentHas(user, "todas", "todos", "ranking", "por", "total", "totales")
    ) {
      return undefined;
    }
    return "areas";
  }

  if (
    !asksSpecificOwner &&
    intentHas(user, "personas", "persona") &&
    (askVerb ||
      intentHas(user, "top", "desglose", "cuantas", "cuantos", "todas", "todos", "ranking") ||
      /\bpor\s+personas?\b/.test(user) ||
      /\b(nombres?\s+de\s+(esas?\s+)?(las\s+)?personas|esas?\s+\d+\s+personas|quienes\s+son)\b/.test(
        user,
      ) ||
      /^(personas?|por\s+personas?)$/.test(user))
  ) {
    // "personas del inventario 1" lo resuelve el detector de origen, no el ranking.
    if (/\binventarios?\s*\d+\b/.test(user) && !/\bgeneral\b/.test(user)) {
      return undefined;
    }
    // “perdón…” u otras frases no son ranking de personas.
    if (/\bperdon\b/.test(user)) return undefined;
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

  // “etiquetas de X” / persona concreta → no ranking de marcas.
  if (
    /\betiquet/.test(user) &&
    /\bde\b/.test(user) &&
    !intentHas(user, "marca", "marcas")
  ) {
    return undefined;
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
    // “panorama/resumen de Ricardo” ≠ inventario global (plantilla personTotal).
    if (
      /\b(de|del)\s+(?!el\s+inventario|la\s+empresa|todo)[a-z0-9]{3,}/.test(
        user,
      ) ||
      (extraTokens.length >= 2 &&
        !intentHas(user, "inventario", "inventarios", "general", "completo"))
    ) {
      return undefined;
    }
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

/** “¿en qué inventario(s) está / se encuentra / aparece …?” */
function asksWhichInventarios(userText: string): boolean {
  const n = normalizeChatIntent(userText);
  if (!n) return false;
  if (
    /\b(origen|fuente|venia|vino|antes|de donde)\b/.test(n) ||
    /\b(de|en)\s+que\s+inventarios?\b/.test(n) ||
    /\b(que|cual|cuales)\s+inventarios?\b/.test(n) ||
    /\binventarios?\s+(tiene|tiene|aparece|aparecen|esta|estan|se\s+encuentra|se\s+encuentran)\b/.test(
      n,
    )
  ) {
    return true;
  }
  // “en que inventarios se encuentra la etiqueta X”
  if (
    /\binventari/.test(n) &&
    /\b(encuentra|encuentran|aparece|aparecen|esta|estan|pertenece|pertenecen|ubicad|ubicacion|donde)\b/.test(
      n,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * “la etiqueta 283586 de qué inventario venía / en qué inventarios está”.
 */
function detectEtiquetaOrigenAsk(
  userText: string,
  inventory: InventarioRow[],
): { etiqueta: string; rows: InventarioRow[] } | undefined {
  if (!inventory.length) return undefined;
  const n = normalizeChatIntent(userText);
  if (!n) return undefined;
  if (!asksWhichInventarios(userText)) return undefined;

  let tags = extractEtiquetasFromText(userText);
  if (!tags.length) {
    const bare = userText.match(/\b(\d{4,12}|[A-Za-z]{1,8}[-_/]?\d{2,10})\b/);
    if (
      bare &&
      (/\betiqueta/.test(n) ||
        /\b(siguiente|esta|esa)\s+etiqueta\b/.test(n) ||
        asksWhichInventarios(userText))
    ) {
      tags = [bare[1]];
    }
  }
  if (!tags.length) return undefined;

  const etiqueta = tags[0];
  const key = etiqueta.toLowerCase();
  const rows = inventory.filter(
    (row) => String(row.etiqueta ?? "").trim().toLowerCase() === key,
  );
  if (!rows.length) {
    return { etiqueta, rows: [] };
  }
  return { etiqueta, rows };
}

/**
 * “en qué inventarios está María Elena / esa persona”.
 */
function detectPersonInventariosAsk(
  userText: string,
  inventory: InventarioRow[],
  chatHistory?: Array<{
    from: string;
    text: string;
    resultItems?: ChatApiItem[];
    viewerFocus?: string;
    viewerOverview?: ViewerOverview;
  }>,
): { person: string; rows: InventarioRow[] } | undefined {
  if (!inventory.length) return undefined;
  if (!asksWhichInventarios(userText)) return undefined;
  const n = normalizeChatIntent(userText);
  // Si hay etiqueta explícita, prioriza el detector de etiqueta.
  if (/\betiqueta/.test(n) && /\d{3,}/.test(n)) return undefined;
  if (extractEtiquetasFromText(userText).length) return undefined;

  const person =
    findPersonInText(userText, inventory) ||
    resolvePersonFocus(userText, inventory, chatHistory) ||
    detectPersonTotalAsk(userText, inventory, chatHistory);
  if (!person) return undefined;
  const rows = rowsForPersonName(inventory, person);
  return { person, rows };
}

function buildPersonInventariosReply(ask: {
  person: string;
  rows: InventarioRow[];
}): string {
  if (!ask.rows.length) {
    return `No encontré registros de **${ask.person}** para listar inventarios.`;
  }
  const counts = new Map<string, number>();
  for (const row of ask.rows) {
    const origen = String(row.origen ?? "").trim() || "Sin origen";
    counts.set(origen, (counts.get(origen) || 0) + 1);
  }
  const entries = [...counts.entries()].sort(
    (a, b) =>
      origenCurrencyRank(a[0]) - origenCurrencyRank(b[0]) || b[1] - a[1],
  );
  const lines = entries.map(
    ([origen, count]) =>
      `• **${origen}** — **${count.toLocaleString("es-MX")}** registro${count === 1 ? "" : "s"}`,
  );
  return (
    `**${ask.person}** aparece en **${entries.length}** inventario` +
    `${entries.length === 1 ? "" : "s"} ` +
    `(**${ask.rows.length.toLocaleString("es-MX")}** registro${ask.rows.length === 1 ? "" : "s"} en total):\n` +
    lines.join("\n") +
    `\n\nEl detalle está en el panel derecho.`
  );
}

function buildEtiquetaOrigenReply(
  ask: { etiqueta: string; rows: InventarioRow[] },
  catalog: InventarioRow[],
): string {
  if (!ask.rows.length) {
    return (
      `No encontré la etiqueta **${ask.etiqueta}** en el inventario. ` +
      `¿Quieres que busque otra etiqueta o un Inventario N concreto?`
    );
  }

  const byOrigen = new Map<string, InventarioRow>();
  for (const row of ask.rows) {
    const origen = String(row.origen ?? "").trim() || "Sin origen";
    if (!byOrigen.has(origen)) byOrigen.set(origen, row);
  }
  const entries = [...byOrigen.entries()].sort(
    (a, b) => origenCurrencyRank(a[0]) - origenCurrencyRank(b[0]),
  );
  const sample = ask.rows[0];
  const art = String(sample.articulo ?? "").trim() || "—";
  const invNums = entries
    .map(([o]) => {
      const m = o.match(/\binventario\s*(\d+)\b/i);
      return m ? Number(m[1]) : null;
    })
    .filter((n): n is number => n != null);
  const oldestInv = invNums.length ? Math.min(...invNums) : null;
  const newestInv = invNums.length ? Math.max(...invNums) : null;

  const lines = entries.map(([origen]) => {
    const num = origen.match(/\binventario\s*(\d+)\b/i);
    const n = num ? Number(num[1]) : null;
    let role = "ficha en este conteo";
    if (n != null && oldestInv != null && newestInv != null && oldestInv !== newestInv) {
      if (n === oldestInv) role = "origen / venía de aquí";
      else if (n === newestInv)
        role = `también en este conteo (copiada desde Inventario ${oldestInv})`;
      else role = "también aparece aquí";
    } else if (!num) {
      const fuente = resolveFuenteOrigen(
        byOrigen.get(origen) || sample,
        catalog,
      );
      if (fuente && fuente.trim().toLowerCase() !== origen.trim().toLowerCase()) {
        role = `fuente de datos: ${fuente}`;
      }
    }
    return `• **${origen}** — ${role}`;
  });

  const beforeNote =
    oldestInv != null && newestInv != null && oldestInv !== newestInv
      ? `\n\nResumen: la etiqueta **${ask.etiqueta}** venía de **Inventario ${oldestInv}**; ` +
        `en **Inventario ${newestInv}** es la misma etiqueta (no es otra pieza). ` +
        `En el panel derecho ves **una ficha por inventario**.`
      : entries.length === 1
        ? `\n\nSolo la veo en **${entries[0][0]}** (no aparece en otro Inventario N).`
        : `\n\nEn el panel derecho ves **una ficha por origen**.`;

  return (
    `La etiqueta **${ask.etiqueta}** (**${art}**) tiene **${entries.length}** ficha` +
    `${entries.length === 1 ? "" : "s"}:\n` +
    lines.join("\n") +
    beforeNote
  );
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
  max = 50,
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

/** Campo mayoritario en items del agente (≥50%). */
function majorityItemField(
  items: ChatApiItem[],
  key: "persona" | "area" | "marca" | "origen",
): string | null {
  if (!items.length) return null;
  const counts = new Map<string, number>();
  for (const it of items) {
    const v = String(it[key] || "").trim();
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [name, n] of counts) {
    if (n > bestN) {
      best = name;
      bestN = n;
    }
  }
  if (!best || bestN < Math.max(1, Math.ceil(items.length * 0.5))) return null;
  return best;
}

/**
 * Si el agente truncó (tope 50), completa etiquetas únicas desde inventario local.
 */
function expandAgentItemsFromInventory(
  agentItems: ChatApiItem[],
  inventory: InventarioRow[],
  overview?: ViewerOverview | null,
  focus?: string | null,
): ChatApiItem[] {
  const focusVal = String(focus || "").trim();
  if (!focusVal || !inventory.length) {
    return Array.isArray(agentItems) ? agentItems : [];
  }
  let full: InventarioRow[] = [];
  if (overview === "areaTotal" || overview === "areaMatches") {
    full = inventory.filter((row) =>
      areaMatchesNeedle(String(row.area ?? ""), focusVal),
    );
  } else if (overview === "personTotal" || overview === "personMatches") {
    const fold = (s: string) =>
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .replace(/\s+/g, " ")
        .trim();
    const want = fold(focusVal);
    full = inventory.filter((row) => {
      const p = fold(String(row.persona ?? ""));
      return p === want || (want.length >= 3 && p.includes(want));
    });
  } else {
    return Array.isArray(agentItems) ? agentItems : [];
  }
  const seen = new Set<string>();
  const out: ChatApiItem[] = [];
  for (const row of full) {
    const et = String(row.etiqueta ?? "")
      .trim()
      .toLowerCase();
    if (et) {
      if (seen.has(et)) continue;
      seen.add(et);
    }
    out.push(rowToChatApiItem(row));
    if (out.length >= CHAT_SIDE_RESULT_CAP) break;
  }
  const prev = Array.isArray(agentItems) ? agentItems : [];
  return out.length > prev.length ? out : prev;
}

/**
 * Tras /api/chat/ (agente), el backend puede mandar viewer {tipo,valor}.
 * Inferimos plantilla del visor + chips según items + texto (+ hint del API).
 */
function inferSideFromAgentResult(
  userText: string,
  items: ChatApiItem[],
  qr: ChatQrPayload[] = [],
  threadFocus?: string,
  apiViewer?: { tipo?: string; valor?: string } | null,
): {
  resultItems: ChatApiItem[];
  qr: ChatQrPayload[];
  viewerOverview?: ViewerOverview;
  viewerFocus?: string;
} {
  const resultItems = Array.isArray(items) ? items : [];
  const overviewAsk = detectViewerOverview(userText);
  const n = normalizeChatIntent(userText);
  const topPerson = majorityItemField(resultItems, "persona");
  const topArea = majorityItemField(resultItems, "area");
  const topMarca = majorityItemField(resultItems, "marca");
  const focusHint = String(threadFocus || "").trim();

  // Hint explícito del backend.
  const apiTipo = String(apiViewer?.tipo || "").trim().toLowerCase();
  const apiValor = String(apiViewer?.valor || "").trim();

  // Ranking global de áreas gana sobre un área puntual del turno anterior.
  if (
    overviewAsk === "areas" ||
    apiTipo === "areas" ||
    apiTipo === "areas_general"
  ) {
    return {
      resultItems: [],
      qr,
      viewerOverview: "areas",
      viewerFocus: undefined,
    };
  }

  if (apiTipo === "persona" && apiValor) {
    return {
      resultItems,
      qr,
      viewerOverview: "personTotal",
      viewerFocus: apiValor,
    };
  }
  if (apiTipo === "area" && apiValor) {
    return {
      resultItems,
      qr,
      viewerOverview: "areaTotal",
      viewerFocus: apiValor,
    };
  }
  if (apiTipo === "origen" && apiValor) {
    return {
      resultItems,
      qr,
      viewerOverview: "full",
      viewerFocus: apiValor,
    };
  }

  if (qr.length) {
    return {
      resultItems,
      qr,
      viewerOverview: overviewAsk,
      viewerFocus: focusHint || topPerson || topArea || undefined,
    };
  }

  // Rankings de catálogo (áreas/personas/…) antes que inferir persona de items sueltos.
  if (
    overviewAsk === "personas" ||
    overviewAsk === "marcas" ||
    overviewAsk === "recent" ||
    overviewAsk === "estado" ||
    overviewAsk === "full" ||
    overviewAsk === "stats"
  ) {
    return {
      resultItems:
        overviewAsk === "personas" ||
        overviewAsk === "marcas" ||
        overviewAsk === "estado" ||
        overviewAsk === "full" ||
        overviewAsk === "stats"
          ? []
          : resultItems,
      qr,
      viewerOverview: overviewAsk,
      viewerFocus: focusHint || undefined,
    };
  }

  // ¿El texto nombra a la persona dominante? (“registros de Eduardo”)
  const personTokens = topPerson
    ? normalizeChatIntent(topPerson)
        .split(/\s+/)
        .filter((t) => t.length > 2)
    : [];
  const personAsk =
    overviewAsk === "personTotal" ||
    /\b(persona|personas|asignad[oa]s?)\b/.test(n) ||
    (personTokens.length > 0 &&
      personTokens.some((tok) => new RegExp(`\\b${tok}\\b`, "i").test(n)));

  // Área explícita (TI, Recursos Humanos…). NO usar “registros de X” a ciegas.
  const areaAskExplicit =
    overviewAsk === "areaTotal" ||
    /\b(area|areas|ti|rh|rrhh|sistemas|marketing|logistica|recursos\s+humanos)\b/.test(
      n,
    ) ||
    (topArea &&
      normalizeChatIntent(topArea)
        .split(/\s+/)
        .filter((t) => t.length > 2)
        .some((tok) => new RegExp(`\\b${tok}\\b`, "i").test(n)) &&
      !personAsk);

  if (personAsk && !areaAskExplicit && topPerson) {
    return {
      resultItems,
      qr,
      viewerOverview: "personTotal",
      viewerFocus: topPerson,
    };
  }

  const uniformArea =
    !personAsk &&
    topArea &&
    resultItems.length > 0 &&
    resultItems.every((it) => {
      const a = String(it.area || "").trim();
      return !a || a === topArea;
    });

  if (areaAskExplicit || uniformArea) {
    const areaFocus = topArea || focusHint || undefined;
    if (areaFocus) {
      return {
        resultItems,
        qr,
        viewerOverview: "areaTotal",
        viewerFocus: areaFocus,
      };
    }
  }

  // Persona dominante solo si NO es consulta de área.
  if (topPerson) {
    return {
      resultItems,
      qr,
      viewerOverview: "personTotal",
      viewerFocus: topPerson,
    };
  }

  if (topArea) {
    return {
      resultItems,
      qr,
      viewerOverview: "areaTotal",
      viewerFocus: topArea,
    };
  }
  if (topMarca && /\bmarcas?\b/.test(n)) {
    return {
      resultItems,
      qr,
      viewerOverview: "marcas",
      viewerFocus: topMarca,
    };
  }
  if (focusHint && resultItems.length) {
    return {
      resultItems,
      qr,
      viewerOverview: "personTotal",
      viewerFocus: focusHint,
    };
  }
  return { resultItems, qr, viewerOverview: overviewAsk };
}

/** Mapea acciones_sugeridas del backend a chips del chat. */
function mapAccionesSugeridas(
  raw?: Array<{ etiqueta?: string; prompt_accion?: string }> | null,
): ChatFollowUp[] {
  if (!Array.isArray(raw) || !raw.length) return [];
  const seen = new Set<string>();
  const out: ChatFollowUp[] = [];
  for (const a of raw) {
    const label = String(a?.etiqueta || "").trim();
    const prompt = String(a?.prompt_accion || "").trim();
    if (!label || !prompt) continue;
    const key = prompt.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: label.slice(0, 48), prompt: prompt.slice(0, 160) });
    if (out.length >= 3) break;
  }
  return out;
}

/** Chips contextuales desde el texto de la respuesta (fallback local). */
function buildContextualFollowUpsFromReply(
  replyText?: string,
  items?: ChatApiItem[],
): ChatFollowUp[] {
  const reply = String(replyText || "").trim();
  const rows = Array.isArray(items) ? items : [];
  if (!reply && !rows.length) return [];

  const fold = normalizeChatIntent(reply);
  if (
    /^(hola|buenas|hey|gracias|adios|hasta luego|de nada)\b/.test(fold) &&
    !/\b(\d{4,}|etiqueta|persona|area|mantenimiento|inactivo)\b/.test(fold)
  ) {
    return [];
  }

  const ups: ChatFollowUp[] = [];
  const add = (label: string, prompt: string) => {
    if (!label || !prompt || ups.length >= 3) return;
    if (ups.some((u) => u.prompt.toLowerCase() === prompt.toLowerCase())) return;
    ups.push({ label, prompt });
  };

  const boldToks = [...reply.matchAll(/\*\*([^*]{2,60})\*\*/g)].map((m) =>
    m[1].trim(),
  );
  let etq =
    boldToks.find((t) => /^\d{4,12}$/.test(t)) ||
    reply.match(/\betiqueta\s+(\d{4,12})\b/i)?.[1] ||
    rows.find((r) => String(r.etiqueta || "").trim())?.etiqueta ||
    null;
  etq = etq ? String(etq).trim() : null;

  const looksPerson = (t: string) =>
    !/\d/.test(t) &&
    t.split(/\s+/).length >= 2 &&
    t.split(/\s+/).length <= 5 &&
    !/^(inventario|excel|csv|xls|xlsx)\b/i.test(t) &&
    !/^(activo|inactivo|mantenimiento|proyector|laptop|monitor)$/i.test(t);
  const personaBold = boldToks.find(looksPerson);
  const personaFromTitle = reply.match(
    /(?:inventario|excel)\s+\*{0,2}([A-ZÁÉÍÓÚÑ][^*\n]{2,50}?)\*{0,2}/i,
  )?.[1];
  const persona =
    personaBold ||
    (personaFromTitle && looksPerson(personaFromTitle.trim())
      ? personaFromTitle.trim()
      : null) ||
    majorityItemField(rows, "persona") ||
    null;

  const estadoFold = fold;
  const estadoBad =
    /\bmantenimiento\b/.test(estadoFold) ||
    /\binactivo\b/.test(estadoFold) ||
    /\bbaja\b/.test(estadoFold);

  if (etq && rows.length <= 3) {
    add(`Exportar etiqueta ${etq}`, `exporta a excel solo la etiqueta ${etq}`);
    add(`Generar QR de ${etq}`, `genera el código QR de la etiqueta ${etq}`);
    if (estadoBad) {
      add("Cambiar estado a Activo", `cambia el estado de ${etq} a Activo`);
    } else {
      add("Reasignar equipo", `reasigna la etiqueta ${etq} a otra persona`);
    }
    return ups;
  }

  if (persona && rows.length >= 2) {
    const short = persona.split(/\s+/).slice(0, 2).join(" ");
    add(`Exportar lista de ${short}`, `exporta ${persona} a excel`);
    add("Ver desglose por área", `en qué áreas está ${persona}`);
    add(`Generar QR de ${short}`, `genera QR de ${persona}`);
    return ups;
  }

  if (estadoBad) {
    add("Cambiar estado a Activo", "cambia el estado de estos a Activo");
    add("Reasignar equipo", "reasigna estos equipos a otra persona");
    add("Exportar Excel", "exporta estos registros a excel");
    return ups;
  }

  return ups;
}

/** Chips con aparición suave 800ms tras el mensaje (solo último bot activo). */
function ChatSuggestedActions({
  messageId,
  chips,
  isLatestBot,
  onPick,
}: {
  messageId: number;
  chips: ChatFollowUp[];
  isLatestBot: boolean;
  onPick: (prompt: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const chipsKey = chips.map((c) => c.prompt).join("|");
  useEffect(() => {
    if (!isLatestBot || !chips.length) {
      setVisible(false);
      return;
    }
    setVisible(false);
    const t = window.setTimeout(() => setVisible(true), 800);
    return () => window.clearTimeout(t);
  }, [messageId, isLatestBot, chipsKey, chips.length]);

  if (!isLatestBot || !visible || !chips.length) return null;

  return (
    <div
      className="chat-follow-ups chat-follow-ups--enter"
      aria-label="Siguientes pasos"
    >
      {chips.map((chip) => (
        <button
          key={`${messageId}-${chip.prompt}`}
          type="button"
          className="chat-follow-up"
          onClick={() => onPick(chip.prompt)}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

/** Chips de siguiente paso según el tipo de respuesta. */
function buildChatFollowUps(
  side?: {
    resultItems?: ChatApiItem[];
    qr?: ChatQrPayload[];
    viewerOverview?: ViewerOverview;
    viewerFocus?: string;
  },
  userText?: string,
  replyText?: string,
): ChatFollowUp[] {
  const overview = side?.viewerOverview;
  // Rankings globales: no inferir chips de un área/persona mencionada en el texto.
  const skipContextual =
    overview === "areas" ||
    overview === "personas" ||
    overview === "marcas" ||
    overview === "estado" ||
    overview === "full" ||
    overview === "stats" ||
    wantsGlobalAreasRanking(userText || "");
  if (!skipContextual) {
    const contextual = buildContextualFollowUpsFromReply(
      replyText,
      side?.resultItems,
    );
    if (contextual.length) return contextual;
  }

  const focus = String(side?.viewerFocus || "").trim();
  const hasItems = (side?.resultItems?.length || 0) > 0;
  const hasQr = (side?.qr?.length || 0) > 0;
  const n = normalizeChatIntent(userText || "");
  const justAskedAreas = /\bare+as?\b/.test(n);
  const ups: ChatFollowUp[] = [];

  if (overview === "areas") {
    ups.push(
      { label: "Personas", prompt: "dame el ranking de personas" },
      { label: "Totales", prompt: "dame el resumen del inventario" },
      { label: "Últimos registros", prompt: "últimos registros" },
      { label: "Exportar Excel", prompt: "exporta el inventario a excel" },
    );
  } else if (overview === "recent") {
    ups.push(
      { label: "Generar QR", prompt: "genera códigos QR de estos registros" },
      { label: "Buscar por persona", prompt: "buscar por persona" },
      { label: "Equipos por área", prompt: "equipos por área" },
      { label: "Exportar Excel", prompt: "exporta estos registros a excel" },
    );
  } else if (overview === "personTotal" && focus) {
    ups.push(
      { label: "Ver etiquetas", prompt: `dame las etiquetas de ${focus}` },
      { label: "Generar QR", prompt: `genera QR de ${focus}` },
      { label: "Exportar Excel", prompt: `exporta ${focus} a excel` },
    );
    if (justAskedAreas) {
      ups.push({
        label: "Últimos registros",
        prompt: "últimos registros",
      });
    } else {
      ups.push({
        label: "Áreas",
        prompt: `en qué áreas está ${focus}`,
      });
    }
  } else if (overview === "areaTotal" && focus) {
    ups.push(
      { label: "Personas del área", prompt: `quiénes hay en ${focus}` },
      { label: "Generar QR", prompt: `genera QR de ${focus}` },
      { label: "Últimos registros", prompt: "últimos registros" },
      { label: "Exportar Excel", prompt: `exporta ${focus} a excel` },
    );
  } else if (overview === "areaMatches" || overview === "personMatches") {
    ups.push(
      { label: "Últimos registros", prompt: "últimos registros" },
      { label: "Totales", prompt: "dame el resumen del inventario" },
      { label: "Buscar por persona", prompt: "buscar por persona" },
      { label: "Equipos por área", prompt: "equipos por área" },
    );
  } else if (overview === "areas") {
    ups.push(
      { label: "Últimos registros", prompt: "últimos registros" },
      { label: "Buscar por persona", prompt: "buscar por persona" },
      { label: "Totales", prompt: "dame el resumen del inventario" },
      { label: "Exportar Excel", prompt: "exporta el inventario a excel" },
    );
  } else if (overview === "personas") {
    ups.push(
      { label: "Equipos por área", prompt: "equipos por área" },
      { label: "Últimos registros", prompt: "últimos registros" },
      { label: "Totales", prompt: "dame el resumen del inventario" },
      { label: "Buscar por persona", prompt: "buscar por persona" },
    );
  } else if (overview === "marcas") {
    ups.push(
      { label: "Equipos por área", prompt: "equipos por área" },
      { label: "Buscar por persona", prompt: "buscar por persona" },
      { label: "Últimos registros", prompt: "últimos registros" },
      { label: "Totales", prompt: "dame el resumen del inventario" },
    );
  } else if (overview === "estado") {
    ups.push(
      { label: "Activos", prompt: "muéstrame los activos" },
      { label: "Inactivos", prompt: "muéstrame los inactivos" },
      { label: "Últimos registros", prompt: "últimos registros" },
      { label: "Totales", prompt: "dame el resumen del inventario" },
    );
  } else if (hasQr) {
    ups.push(
      { label: "Más registros", prompt: "últimos registros" },
      { label: "Buscar otra etiqueta", prompt: "buscar por etiqueta" },
      { label: "Exportar Excel", prompt: "exporta esto a excel" },
    );
  } else if (hasItems) {
    const person = majorityItemField(side?.resultItems || [], "persona");
    const area = majorityItemField(side?.resultItems || [], "area");
    if (person) {
      ups.push(
        { label: "Ver etiquetas", prompt: `dame las etiquetas de ${person}` },
        { label: "Generar QR", prompt: `genera QR de ${person}` },
        { label: "Exportar Excel", prompt: `exporta ${person} a excel` },
        { label: "Áreas", prompt: `en qué áreas está ${person}` },
      );
    } else if (area) {
      ups.push(
        { label: "Personas del área", prompt: `quiénes hay en ${area}` },
        { label: "Generar QR", prompt: `genera QR de ${area}` },
        { label: "Exportar Excel", prompt: `exporta ${area} a excel` },
        { label: "Últimos registros", prompt: "últimos registros" },
      );
    } else {
      ups.push(
        { label: "Generar QR", prompt: "genera QR de estas etiquetas" },
        { label: "Exportar Excel", prompt: "exporta esto a excel" },
        { label: "Últimos registros", prompt: "últimos registros" },
        { label: "Buscar por persona", prompt: "buscar por persona" },
      );
    }
  } else {
    ups.push(
      { label: "Últimos registros", prompt: "últimos registros" },
      { label: "Buscar por persona", prompt: "buscar por persona" },
      { label: "Equipos por área", prompt: "equipos por área" },
      { label: "Ideas de consulta", prompt: "ideas de consulta" },
    );
  }

  const seen = new Set<string>();
  return ups
    .filter((u) => {
      const key = u.prompt.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

/** Solo códigos reales (OF-0026, 283586). No títulos tipo “Reportes”. */
function extractEtiquetaFromListItem(raw: string): string | null {
  const text = String(raw || "").trim();
  const bold = text.match(/^\*\*([^*]+)\*\*/);
  if (bold) {
    const et = bold[1].trim();
    if (/^(?=.*\d)[A-Za-z0-9][A-Za-z0-9\-_/.]{2,}$/.test(et)) return et;
    if (/^[A-Za-z]{1,8}[-_/]\d{2,}$/i.test(et)) return et;
  }
  const plain = text.match(/^([A-Za-z]{1,8}[-_]?\d{2,12}|\d{4,12})\b/);
  if (plain) return plain[1];
  return null;
}

const IDEA_LIST_PROMPTS: Record<string, string> = {
  "buscar por persona": "buscar por persona",
  "equipos por area": "equipos por área",
  "ultimos registros": "últimos registros",
  "listar inventarios": "qué inventarios tenemos",
  "comparar inventarios": "comparar inventarios",
  "buscar una etiqueta": "buscar etiqueta",
  reportes: "dame el desglose por estado",
  "exportar a excel": "exporta el inventario a excel",
};

/** Título de idea conocida (**Reportes** — …) → prompt usable. */
function extractIdeaPromptFromListItem(raw: string): string | null {
  const text = String(raw || "").trim();
  const bold = text.match(/^\*\*([^*]+)\*\*/);
  if (!bold) return null;
  const title = bold[1].trim();
  if (!title || extractEtiquetaFromListItem(`**${title}**`)) return null;
  return IDEA_LIST_PROMPTS[normalizeChatIntent(title)] || null;
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

function renderChatRichText(
  text: string,
  opts?: { onAsk?: (prompt: string) => void },
) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let keyCounter = 0;
  const onAsk = opts?.onAsk;

  const renderListRow = (content: string, key: string, badge?: string) => {
    const et = extractEtiquetaFromListItem(content);
    const ideaPrompt = !et ? extractIdeaPromptFromListItem(content) : null;
    const askPrompt = et ? `etiqueta ${et}` : ideaPrompt;
    const canAsk = Boolean(onAsk && askPrompt);
    const inner = (
      <>
        {badge ? (
          <span className="chat-rich-order-badge" aria-hidden="true">
            {badge}
          </span>
        ) : null}
        <span className="chat-rich-list-content">
          {renderChatInlineText(content)}
        </span>
      </>
    );
    if (!canAsk || !askPrompt || !onAsk) {
      return (
        <li key={key} className="chat-rich-list-item">
          {inner}
        </li>
      );
    }
    return (
      <li key={key} className="chat-rich-list-item">
        <button
          type="button"
          className="chat-rich-list-action"
          title={et ? `Consultar etiqueta ${et}` : `Consultar: ${askPrompt}`}
          onClick={() => onAsk(askPrompt)}
        >
          {inner}
        </button>
      </li>
    );
  };

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

    // 3. Unordered list (•, -, *) → párrafos (sin viñetas verdes)
    if (/^[•\-\*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[•\-\*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[•\-\*]\s+/, ""));
        i += 1;
      }
      for (const item of items) {
        const et = extractEtiquetaFromListItem(item);
        const ideaPrompt = !et ? extractIdeaPromptFromListItem(item) : null;
        const askPrompt = et ? `etiqueta ${et}` : ideaPrompt;
        const canAsk = Boolean(onAsk && askPrompt);
        if (canAsk && askPrompt && onAsk) {
          blocks.push(
            <p key={`up-${keyCounter++}`} className="chat-rich-p">
              <button
                type="button"
                className="chat-rich-list-action is-paragraph"
                title={
                  et ? `Consultar etiqueta ${et}` : `Consultar: ${askPrompt}`
                }
                onClick={() => onAsk(askPrompt)}
              >
                {renderChatInlineText(item)}
              </button>
            </p>,
          );
        } else {
          blocks.push(
            <p key={`up-${keyCounter++}`} className="chat-rich-p">
              {renderChatInlineText(item)}
            </p>,
          );
        }
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
          {items.map((item, idx) =>
            renderListRow(item.content, `o-${idx}`, item.num),
          )}
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
  catalogItems,
}: {
  row: InventarioRow;
  selectMode: boolean;
  isChecked: boolean;
  onToggle: (id: number) => void;
  onOpen: (row: InventarioRow) => void;
  catalogItems: InventarioRow[];
}) {
  const rowId = Number(row.id);
  const hasId = Number.isFinite(rowId);
  const origenLabel = displayOrigenLabel(row, catalogItems);

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
            key === "persona"
              ? textOf(row[key]) || undefined
              : key === "origen"
                ? origenLabel || undefined
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
          ) : key === "origen" ? (
            origenLabel || "—"
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
  const [addModalDestino, setAddModalDestino] = useState<string | null>(null);
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
  const [areaSearch, setAreaSearch] = useState("");
  const [debouncedAreaSearch, setDebouncedAreaSearch] = useState("");
  const [estadoSearch, setEstadoSearch] = useState("");
  const [debouncedEstadoSearch, setDebouncedEstadoSearch] = useState("");
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
  const [pendingFieldApply, setPendingFieldApply] = useState<ChatFieldChange[]>(
    [],
  );
  const [pendingBulkTransfer, setPendingBulkTransfer] =
    useState<PendingBulkTransfer | null>(null);
  const [pendingChatDeletePlan, setPendingChatDeletePlan] =
    useState<ChatDeletePlan | null>(null);
  const pendingChatDeletePlanRef = useRef<ChatDeletePlan | null>(null);
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
  const [tokenDetailsOpen, setTokenDetailsOpen] = useState(false);
  const [activeLlmMeta, setActiveLlmMeta] = useState<{
    provider: string;
    providerLabel: string;
    model: string;
    keyFingerprint: string;
    budget: number;
  }>({
    provider: "openai",
    providerLabel: "OpenAI",
    model: "gpt-4o-mini",
    keyFingerprint: "default",
    budget: DEFAULT_TOKEN_BUDGET,
  });
  const [tokenPopoverOpen, setTokenPopoverOpen] = useState(false);
  const tokenMeterWrapRef = useRef<HTMLDivElement>(null);
  const chatHydratedRef = useRef(false);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const chatStageRef = useRef<HTMLDivElement>(null);
  /** Último mensaje del usuario: ancla de scroll (estilo ChatGPT). */
  const ultimoMensajeUsuarioRef = useRef<HTMLElement | null>(null);
  const lastScrolledUserMsgIdRef = useRef<number | null>(null);
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
  const pendingFieldApplyRef = useRef<ChatFieldChange[]>([]);
  const pendingFixContextRef = useRef<PendingFixContext | null>(null);
  const pendingBulkTransferRef = useRef<PendingBulkTransfer | null>(null);
  const pendingDisambiguationRef = useRef<PendingDisambiguationState | null>(null);
  const pendingNewInventarioRef = useRef<PendingNewInventario | null>(null);
  /** Confirmación: meter todos los demás inventarios → destino. */
  const pendingOrigenMergeRef = useRef<{
    dest: string;
    sources: string[];
    askedAt: number;
  } | null>(null);
  /** Tras “pásala a un inventario”: esperando destino nuevo/existente. */
  const pendingCopyEtiquetaDestRef = useRef<{
    etiquetas: string[];
    askedAt: number;
  } | null>(null);
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
  /**
   * Visor: último bot CON datos de panel.
   * La visibilidad real la controla sideViewerVisible (oculto al enviar / reiniciar;
   * visible solo si la respuesta trae contexto_vista con datos).
   */
  const [sideViewerVisible, setSideViewerVisible] = useState(false);
  const activeSideCompanion = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.from !== "bot") continue;
      // “Consultando…” no cuenta: buscar el bot concreto anterior.
      const text = String(message.text || "").trim();
      if (/^(consultando el inventario|importando)\b/i.test(text)) continue;
      if (!messageHasSideData(message)) continue;
      return {
        messageId: message.id,
        resultItems: Array.isArray(message.resultItems)
          ? message.resultItems
          : [],
        qrCards: chatQrByMsg[message.id] || [],
        overview: message.viewerOverview,
        overviewFocus: message.viewerFocus,
        comparacion: message.viewerComparacion || null,
      };
    }
    return null;
  }, [messages, chatQrByMsg]);

  const showSideViewer = Boolean(activeSideCompanion) && sideViewerVisible;

  /** Panel derecho activo → backend («de aquí»). */
  const getContextoVista = (): ChatContextoVista | null =>
    buildContextoVista({
      overview:
        activeSideCompanion?.overview ||
        lastConcreteSideRef.current?.viewerOverview,
      overviewFocus:
        activeSideCompanion?.overviewFocus ||
        lastConcreteSideRef.current?.viewerFocus,
      resultItems:
        (activeSideCompanion?.resultItems?.length
          ? activeSideCompanion.resultItems
          : lastConcreteSideRef.current?.resultItems) || [],
    });

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
      const fromCatalog = Array.isArray(llm.available_models)
        ? llm.available_models
        : [];
      // Compat: backends viejos solo mandan providers[] sin available_models.
      const fromProviders: ChatModelOption[] =
        fromCatalog.length > 0
          ? []
          : (llm.providers || []).flatMap((prov, provIdx) => {
              const provider = String(prov.name || "").trim() || "llm";
              const label =
                String(prov.label || "").trim() || provider.toUpperCase();
              const fp = String(prov.key_fingerprint || "default");
              const budget =
                Number(prov.token_budget) > 0
                  ? Number(prov.token_budget)
                  : DEFAULT_TOKEN_BUDGET;
              return (prov.models || []).map((modelId, modelIdx) => {
                const id = String(modelId || "").trim();
                if (!id) return null;
                const short = id.includes("/") ? id.split("/").pop() || id : id;
                return {
                  id,
                  label: short,
                  badge:
                    provIdx === 0 && modelIdx === 0
                      ? "Mejor · Por defecto"
                      : label,
                  provider,
                  provider_label: label,
                  key_fingerprint: fp,
                  token_budget: budget,
                  recommended: provIdx === 0 && modelIdx === 0,
                } satisfies ChatModelOption;
              });
            }).filter(Boolean) as ChatModelOption[];
      const modelsList = (fromCatalog.length ? fromCatalog : fromProviders).map(
        (m) => ({
          ...m,
          token_budget: normalizeModelTokenBudget(
            m.token_budget,
            normalizeModelTokenBudget(llm.token_budget, DEFAULT_TOKEN_BUDGET),
          ),
        }),
      );
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
        chosen?.provider ||
          llm.active_provider ||
          llm.providers?.[0]?.name ||
          "openai",
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
          "gpt-4o-mini",
      );
      const budget = normalizeModelTokenBudget(
        chosen?.token_budget ??
          llm.token_budget ??
          llm.providers?.[0]?.token_budget,
        DEFAULT_TOKEN_BUDGET,
      );
      setActiveLlmMeta({
        provider,
        providerLabel,
        model,
        keyFingerprint: String(chosen?.key_fingerprint || keyFingerprint),
        budget,
      });
    });
    return () => {
      alive = false;
    };
  }, [rail]);

  const selectLlmModel = useCallback((option: ChatModelOption) => {
    const keyFingerprint = String(
      option.key_fingerprint || activeLlmMeta.keyFingerprint || "default",
    );
    saveSelectedModelForKey(keyFingerprint, option.id);
    setActiveLlmMeta({
      provider: option.provider,
      providerLabel: option.provider_label || option.provider.toUpperCase(),
      model: option.id,
      keyFingerprint,
      budget: normalizeModelTokenBudget(
        option.token_budget,
        DEFAULT_TOKEN_BUDGET,
      ),
    });
  }, [activeLlmMeta.keyFingerprint]);

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
      const provider = String(
        usage?.provider || activeLlmMeta.provider || "openai",
      );
      const model = String(
        usage?.model || usage?.modelo || activeLlmMeta.model || "gpt-4o-mini",
      );
      const keyFingerprint = String(
        usage?.key_fingerprint || activeLlmMeta.keyFingerprint || "default",
      );
      const budget = normalizeModelTokenBudget(
        usage?.token_budget ?? usage?.limite_contexto ?? activeLlmMeta.budget,
        DEFAULT_TOKEN_BUDGET,
      );
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
      const turnCost =
        usage && typeof usage.costo_usd === "number" && usage.costo_usd >= 0
          ? usage.costo_usd
          : 0;

      const matchedCatalog = availableModels.find((m) => m.id === model);
      setActiveLlmMeta((prev) => ({
        provider,
        providerLabel:
          matchedCatalog?.provider_label ||
          usage?.proveedor ||
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
          costUsd: (current?.costUsd || 0) + turnCost,
          updatedAt: Date.now(),
        };
        const updated = { ...prev, [meterId]: nextEntry };
        saveTokenMeters(updated);
        return updated;
      });
    },
    [activeLlmMeta, availableModels],
  );

  const activeTokenMeter = useMemo(() => {
    const meterId = `${activeLlmMeta.provider}:${activeLlmMeta.model}:${activeLlmMeta.keyFingerprint}`;
    const stored = tokenMeters[meterId];
    const draftTokens = draft.trim() ? estimateTextTokens(draft) : 0;
    const baseUsed = stored?.used || 0;
    const budget = normalizeModelTokenBudget(
      stored?.budget ?? activeLlmMeta.budget,
      DEFAULT_TOKEN_BUDGET,
    );
    const totalUsed = Math.min(budget, baseUsed + draftTokens);
    const remaining = Math.max(0, budget - totalUsed);
    const pctUsed = Math.min(
      100,
      Math.max(0, (totalUsed / Math.max(1, budget)) * 100),
    );
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
      keyFingerprint: String(activeLlmMeta.keyFingerprint || "default"),
      used: totalUsed,
      baseUsed,
      draftTokens,
      promptUsed: stored?.promptUsed || 0,
      completionUsed: stored?.completionUsed || 0,
      lastTurnTokens: stored?.lastTurnTokens || 0,
      costUsd: stored?.costUsd || 0,
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

  useEffect(() => {
    const id = window.setTimeout(() => {
      startTransition(() => setDebouncedAreaSearch(areaSearch));
    }, 200);
    return () => window.clearTimeout(id);
  }, [areaSearch]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      startTransition(() => setDebouncedEstadoSearch(estadoSearch));
    }, 200);
    return () => window.clearTimeout(id);
  }, [estadoSearch]);

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

  // n8n (opt-in): acción `refrescar` → CustomEvent inventario:refrescar.
  useEffect(() => {
    const recargarTabla = () => {
      void readInventario().then(({ rows: next }) => {
        if (Array.isArray(next)) setItems(next);
      });
    };
    const h = () => recargarTabla();
    window.addEventListener("inventario:refrescar", h);
    return () => window.removeEventListener("inventario:refrescar", h);
  }, []);

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
      ...new Set(
        items
          .map((row) => canonicalizeOrigenLabel(textOf(row.origen)))
          .filter(Boolean),
      ),
    ].sort();
  }, [items, rail]);

  const peopleAreaOptions = useMemo(() => {
    if (rail !== "personas") return [] as string[];
    return [
      ...new Set(
        items
          .filter((row) => {
            if (
              peopleOrigenFilter !== "ALL" &&
              !origensMatch(textOf(row.origen), peopleOrigenFilter)
            ) {
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
            if (
              peopleOrigenFilter !== "ALL" &&
              !origensMatch(textOf(row.origen), peopleOrigenFilter)
            ) {
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
  const preparedAreaSearch = useMemo(
    () => prepareSearch(debouncedAreaSearch),
    [debouncedAreaSearch],
  );
  const preparedEstadoSearch = useMemo(
    () => prepareSearch(debouncedEstadoSearch),
    [debouncedEstadoSearch],
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
      if (
        peopleOrigenFilter !== "ALL" &&
        !origensMatch(textOf(row.origen), peopleOrigenFilter)
      ) {
        continue;
      }
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

  const visibleAreaFolders = useMemo(() => {
    if (rail !== "areas") return areaFolders;

    const groups = new Map<string, { id: string; name: string; rows: InventarioRow[] }>();
    for (const entry of searchIndex) {
      const row = entry.row;
      if (preparedAreaSearch && !indexMatchesPrepared(entry, preparedAreaSearch)) continue;
      const area = textOf(row.area);
      const id = area || "sin-area";
      const name = area || "Sin área";
      const bucket = groups.get(id);
      if (bucket) bucket.rows.push(row);
      else groups.set(id, { id, name, rows: [row] });
    }

    return [...groups.values()]
      .map((folder) => ({ ...folder, people: [] as string[] }))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [rail, areaFolders, preparedAreaSearch, searchIndex]);

  const inventarioOptions = useMemo(() => {
    if (rail !== "inventario") return [] as string[];
    return [
      ...new Set(
        items
          .map((row) => canonicalizeOrigenLabel(textOf(row.origen)))
          .filter(Boolean),
      ),
    ].sort((a, b) => a.localeCompare(b, "es"));
  }, [items, rail]);

  const inventarioOptionCounts = useMemo(() => {
    if (rail !== "inventario") return new Map<string, number>();
    const counts = new Map<string, number>();
    for (const row of items) {
      const origen = canonicalizeOrigenLabel(textOf(row.origen));
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

    if (rail === "areas") {
      const selected = visibleAreaFolders.find((folder) => folder.id === selectedId);
      let base = selected
        ? selected.rows
        : visibleAreaFolders.flatMap((folder) => folder.rows);
      if (preparedTopQuery) {
        base = base.filter((row) => rowMatchesIndex(row, preparedTopQuery));
      }
      return [...base].sort(
        (a, b) =>
          textOf(a.area).localeCompare(textOf(b.area), "es") ||
          textOf(a.etiqueta).localeCompare(textOf(b.etiqueta), "es"),
      );
    }

    let scoped = items;
    if (rail === "inventario" && selectedInventarios.length > 0) {
      scoped = items.filter((row) =>
        selectedInventarios.some(
          (sel) => sel === "ALL" || origensMatch(textOf(row.origen), sel),
        ),
      );
    }
    let base = scoped;
    if (rail === "inventario" && preparedInventarioSearch) {
      base = base.filter((row) => rowMatchesIndex(row, preparedInventarioSearch));
    }
    if (rail === "estado" && preparedEstadoSearch) {
      base = base.filter((row) => rowMatchesIndex(row, preparedEstadoSearch));
    }
    if (preparedTopQuery) {
      base = base.filter((row) => rowMatchesIndex(row, preparedTopQuery));
    }
    return base;
  }, [
    preparedTopQuery,
    preparedInventarioSearch,
    preparedEstadoSearch,
    rail,
    items,
    selectedId,
    visiblePersonFolders,
    visibleAreaFolders,
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
    debouncedAreaSearch,
    debouncedEstadoSearch,
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

  const lastUserMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].from === "user") return messages[i].id;
    }
    return null;
  }, [messages]);

  // Anclar al último mensaje del usuario (no al final de la respuesta del bot).
  useLayoutEffect(() => {
    if (rail !== "archivos") return;
    const logEl = chatLogRef.current;
    if (!logEl) {
      const stage = chatStageRef.current;
      if (stage) stage.scrollTop = 0;
      const panel = viewPanelRef.current;
      if (panel) panel.scrollTop = 0;
      return;
    }
    if (lastUserMessageId == null) return;
    // Solo al enviar un mensaje nuevo del usuario; la respuesta larga no mueve el scroll.
    if (lastScrolledUserMsgIdRef.current === lastUserMessageId) return;
    lastScrolledUserMsgIdRef.current = lastUserMessageId;
    const run = () => {
      const el = ultimoMensajeUsuarioRef.current;
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(run);
    });
  }, [lastUserMessageId, rail]);

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
          const focus = resolveOverviewFocus(userText, items);
          changed = true;
          lastSide = {
            resultItems: [],
            qr: [],
            viewerOverview: overview,
            viewerFocus: focus,
          };
          return {
            ...message,
            resultItems: [],
            qr: undefined,
            viewerOverview: overview,
            viewerFocus: focus,
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

  const isAffirmativeChat = (value: string) => {
    const t = value.trim();
    // Solo afirmaciones cortas: “okey compara…” NO confirma import.
    if (
      !/^(sí|si|yes|confirma|confirmo|adelante|ok|okay|okey|vale|dale|claro|listo|de acuerdo|hazlo|procede|proceder)([.!\s]*)$/i.test(
        t,
      )
    ) {
      return false;
    }
    return true;
  };

  /** Solo confirmación explícita de carga (no ok/okey/vale/perfecto). */
  const isChatImportConfirm = (value: string) => isExplicitImportConfirm(value);

  /** Último bot real (ignora “Consultando…” / “Importando…”). */
  const getLastConcreteBotMessage = () =>
    [...messagesRef.current]
      .reverse()
      .find((m) => {
        if (m.from !== "bot") return false;
        const t = String(m.text || "").trim();
        return !/^(consultando el inventario|importando)\b/i.test(t);
      });

  const asksChatFileImport = (value: string) => {
    const t = value.trim();
    if (!t) return false;
    // Cubre importarte/subo/cómo subo/te voy a subir…
    return (
      /\b(import\w*|subir\w*|subo|subire|cargar\w*|adjunt\w*|pasarte|mandarte|enviarte)\b[\s\S]{0,60}\b(excel|csv|archivo|xlsx|xls)\b/i.test(
        t,
      ) ||
      /\b(excel|csv|xlsx|xls|archivo)\b[\s\S]{0,60}\b(import\w*|subir\w*|subo|cargar\w*|adjunt\w*)\b/i.test(
        t,
      ) ||
      /\b(como|cómo)\s+(subo|subir|importo|importar|cargo|cargar|adjunto)\b/i.test(
        t,
      ) ||
      /\b(te\s+voy\s+a|voy\s+a|quiero)\b[\s\S]{0,40}\b(subir|importar|cargar|adjuntar|pasar|mandar)\b[\s\S]{0,40}\b(excel|csv|archivo|xlsx|xls)\b/i.test(
        t,
      )
    );
  };

  const CHAT_IMPORT_CHUNK = 100;

  const pendingImportAskedAtRef = useRef<number>(0);

  const setPendingChatImportSafe = (items: NewInventarioItem[] | null) => {
    pendingChatImportRef.current = items;
    setPendingChatImport(items);
    const askedAt = items?.length ? Date.now() : 0;
    pendingImportAskedAtRef.current = askedAt;
    savePendingImportToSession(activeChatIdRef.current, items, askedAt || Date.now());
  };

  const setPendingFieldRevertSafe = (change: ChatFieldChange | null) => {
    pendingFieldRevertRef.current = change;
    setPendingFieldRevert(change);
  };

  const setPendingFieldApplySafe = (
    change: ChatFieldChange | ChatFieldChange[] | null,
  ) => {
    const list = !change ? [] : Array.isArray(change) ? change : [change];
    pendingFieldApplyRef.current = list;
    setPendingFieldApply(list);
  };

  const setPendingFixContextSafe = (ctx: PendingFixContext | null) => {
    pendingFixContextRef.current = ctx;
  };

  const setPendingBulkTransferSafe = (transfer: PendingBulkTransfer | null) => {
    pendingBulkTransferRef.current = transfer;
    setPendingBulkTransfer(transfer);
  };

  const setPendingChatDeletePlanSafe = (plan: ChatDeletePlan | null) => {
    pendingChatDeletePlanRef.current = plan;
    setPendingChatDeletePlan(plan);
  };

  const contextRowsForDelete = (): InventarioRow[] => {
    const priorItems =
      lastConcreteSideRef.current?.resultItems ||
      [...messagesRef.current]
        .reverse()
        .find(
          (m) =>
            m.from === "bot" &&
            Array.isArray(m.resultItems) &&
            m.resultItems.length > 0,
        )?.resultItems ||
      [];
    const rows: InventarioRow[] = [];
    const seen = new Set<string>();
    for (const it of priorItems) {
      const et = String(it.etiqueta ?? "").trim().toLowerCase();
      const key =
        it.id != null && Number.isFinite(Number(it.id))
          ? `id:${it.id}`
          : et
            ? `et:${et}`
            : "";
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const hit =
        (it.id != null &&
          items.find((r) => Number(r.id) === Number(it.id))) ||
        (et &&
          items.find(
            (r) =>
              String(r.etiqueta ?? "").trim().toLowerCase() === et &&
              (!it.origen ||
                String(r.origen ?? "").trim() === String(it.origen).trim()),
          )) ||
        (et &&
          items.find(
            (r) => String(r.etiqueta ?? "").trim().toLowerCase() === et,
          ));
      if (hit) rows.push(hit);
    }
    return rows;
  };

  const confirmChatDeleteRecord = async () => {
    const plan = pendingChatDeletePlanRef.current || pendingChatDeletePlan;
    if (!plan?.rows.length || chatDeleteBusy) return;
    const targets = plan.rows.filter(
      (r) => r.id != null && Number.isFinite(Number(r.id)),
    );
    if (!targets.length) return;
    setChatDeleteBusy(true);
    try {
      const ids = targets.map((r) => Number(r.id));
      const origenes = planDeleteOrigens(plan);
      const result =
        plan.wholeOrigen && origenes.length
          ? await deleteInventarioByOrigensAction(origenes).then((res) =>
              res.success
                ? {
                    success: true as const,
                    deletedIds: res.deletedIds || ids,
                    error: null as string | null,
                  }
                : {
                    success: false as const,
                    deletedIds: [] as number[],
                    error: res.error || "No se pudo eliminar.",
                  },
            )
          : ids.length === 1
            ? await deleteInventarioAction(ids[0]).then((res) =>
                res.success
                  ? {
                      success: true as const,
                      deletedIds: [ids[0]],
                      error: null as string | null,
                    }
                  : {
                      success: false as const,
                      deletedIds: [] as number[],
                      error: res.error || "No se pudo eliminar.",
                    },
              )
            : await deleteInventarioManyAction(ids).then((res) =>
                res.success
                  ? {
                      success: true as const,
                      deletedIds: res.deletedIds || [],
                      error: null as string | null,
                    }
                  : {
                      success: false as const,
                      deletedIds: [] as number[],
                      error: res.error || "No se pudo eliminar.",
                    },
              );
      if (!result.success || !result.deletedIds?.length) {
        setChatDeleteBusy(false);
        setPendingChatDeletePlanSafe(null);
        const sessionId = activeChatIdRef.current;
        if (sessionId) {
          const botId = chatId.current++;
          const fail =
            result.error || "No se pudieron eliminar los registros.";
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
      const deletedSet = new Set(result.deletedIds);
      let deletedRows = targets.filter((r) => deletedSet.has(Number(r.id)));
      if (plan.wholeOrigen && origenes.length && !deletedRows.length) {
        deletedRows = targets;
      }
      const totalBefore = items.length;
      setItems((prev) =>
        prev.filter((row) => {
          if (deletedSet.has(Number(row.id))) return false;
          if (
            plan.wholeOrigen &&
            origenes.length &&
            origenes.some((o) =>
              origensMatch(String(row.origen ?? ""), o),
            )
          ) {
            return false;
          }
          return true;
        }),
      );
      if (
        selectedProduct?.id != null &&
        deletedSet.has(Number(selectedProduct.id))
      ) {
        setSelectedProduct(null);
      }
      const origenesLabel = formatOrigensListEs(origenes);
      rememberMutation({
        kind: "delete",
        summary:
          deletedRows.length === 1
            ? `Eliminé etiqueta ${deletedRows[0].etiqueta || deletedRows[0].id}`
            : `Eliminé ${deletedRows.length} registros${
                origenesLabel ? ` de ${origenesLabel}` : ""
              }`,
        totalBefore,
        totalAfter: Math.max(0, totalBefore - deletedRows.length),
        count: deletedRows.length,
        ids: result.deletedIds,
        chatId: activeChatIdRef.current,
        fact: `Eliminados ${deletedRows.length}: ${deletedRows
          .slice(0, 5)
          .map((r) => r.etiqueta || r.id)
          .join(", ")}`,
      });
      const fallback = formatDeleteDoneFallback({
        rows: deletedRows,
        origen: plan.origen,
        origenes,
        wholeOrigen: plan.wholeOrigen,
        deletedCount: deletedRows.length,
      });
      const polished = await polishInventoryReply({
        userText: "confirmación de eliminación",
        kind: "delete_done",
        fallback,
        sessionId: activeChatIdRef.current,
        facts: {
          deleted_count: deletedRows.length,
          origen: plan.origen || "",
          origenes,
          whole_origen: Boolean(plan.wholeOrigen),
          sample: deletedRows.slice(0, 5).map((r) => ({
            etiqueta: String(r.etiqueta ?? "").trim(),
            articulo: String(r.articulo ?? "").trim(),
          })),
          plantilla_sugerida: fallback,
          tono: "claro_conversacional",
        },
      });
      const sessionId = activeChatIdRef.current;
      if (sessionId) {
        const botId = chatId.current++;
        const next = [
          ...messagesRef.current,
          {
            id: botId,
            from: "bot" as const,
            text: polished.reply || fallback,
            at: Date.now(),
            resultItems: [],
            qr: [],
            followUps: polished.followUps,
          },
        ];
        messagesRef.current = next;
        setMessages(next);
        upsertChatSession(sessionId, next);
      }
    } finally {
      setChatDeleteBusy(false);
      setPendingChatDeletePlanSafe(null);
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
      viewerComparacion?: ChatComparacionVista | null;
      exportFiles?: ChatExportFile[];
      followUps?: ChatFollowUp[];
      /** Texto del usuario para adaptar chips a la situación. */
      userText?: string;
      /** Hint {tipo,valor} del backend (/api/chat viewer). */
      apiViewer?: { tipo?: string; valor?: string } | null;
      /** No expandir items al inventario completo (lista N / ranking). */
      skipExpand?: boolean;
    },
  ) => {
    // Inferir / corregir plantilla (p. ej. panorama de Ricardo ≠ full global).
    // No pisar preview de import (stats/full + foco origen archivo).
    const origenFocus = /^(inventario\s*\d+|excel\s*\d+|csv\s*\d+|xls\s*\d+|xlsx\s*\d+)$/i.test(
      String(side?.viewerFocus || "").trim(),
    );
    const importPreviewLocked =
      (side?.viewerOverview === "stats" || side?.viewerOverview === "full") &&
      origenFocus;
    let resolvedSide = side;
    // Comparación de inventarios: métricas, sin lista de etiquetas.
    if (
      side &&
      !importPreviewLocked &&
      (side.viewerOverview === "comparacion" ||
        side.apiViewer?.tipo === "comparacion" ||
        Boolean(side.viewerComparacion))
    ) {
      resolvedSide = {
        ...side,
        resultItems: [],
        qr: [],
        viewerOverview: "comparacion",
        viewerFocus: undefined,
        viewerComparacion: side.viewerComparacion || null,
        skipExpand: true,
      };
    } else if (
      side &&
      !importPreviewLocked &&
      (side.viewerOverview === "areas" ||
        side.apiViewer?.tipo === "areas" ||
        side.apiViewer?.tipo === "areas_general" ||
        wantsGlobalAreasRanking(side.userText || "") ||
        detectViewerOverview(side.userText || "") === "areas")
    ) {
      // Ranking global de áreas: forzar plantilla antes de inferir por items.
      resolvedSide = {
        ...side,
        resultItems: [],
        qr: [],
        viewerOverview: "areas",
        viewerFocus: undefined,
      };
    } else if (side && !importPreviewLocked && side.skipExpand) {
      // Lista acotada (“dame 8 de aquí”): respetar items del turno.
      resolvedSide = {
        ...side,
        resultItems: side.resultItems || [],
        viewerOverview: side.viewerOverview,
        viewerFocus: side.viewerFocus,
      };
    } else if (
      side &&
      !importPreviewLocked &&
      ((side.resultItems?.length || 0) > 0 || (side.qr?.length || 0) > 0)
    ) {
      const inferred = inferSideFromAgentResult(
        side.userText || "",
        side.resultItems || [],
        side.qr || [],
        side.viewerFocus,
        side.apiViewer,
      );
      const userN = normalizeChatIntent(side.userText || "");
      const topPerson = majorityItemField(side.resultItems || [], "persona");
      const personToks = topPerson
        ? normalizeChatIntent(topPerson)
            .split(/\s+/)
            .filter((t) => t.length > 2)
        : [];
      const askedAreasRanking =
        inferred.viewerOverview === "areas" ||
        side.viewerOverview === "areas" ||
        side.apiViewer?.tipo === "areas" ||
        side.apiViewer?.tipo === "areas_general" ||
        wantsGlobalAreasRanking(side.userText || "") ||
        detectViewerOverview(side.userText || "") === "areas";
      const askedPerson =
        !askedAreasRanking &&
        (inferred.viewerOverview === "personTotal" ||
          side.viewerOverview === "personTotal" ||
          side.apiViewer?.tipo === "persona" ||
          /\b(persona|personas|asignad[oa]s?)\b/.test(userN) ||
          (personToks.length > 0 &&
            personToks.some((tok) =>
              new RegExp(`\\b${tok}\\b`, "i").test(userN),
            )));
      // NO usar “registros de …” a ciegas (Eduardo ≠ área).
      const askedArea =
        !askedAreasRanking &&
        !askedPerson &&
        (inferred.viewerOverview === "areaTotal" ||
          side.viewerOverview === "areaTotal" ||
          side.apiViewer?.tipo === "area" ||
          /\b(area|areas|ti|rh|rrhh|sistemas|marketing|recursos\s+humanos)\b/.test(
            userN,
          ));
      const preferPerson =
        askedPerson ||
        (!askedArea &&
          !askedAreasRanking &&
          inferred.viewerOverview === "personTotal" &&
          (side.viewerOverview === "full" || !side.viewerOverview) &&
          !origenFocus);
      const overview = askedAreasRanking
        ? "areas"
        : askedArea
          ? "areaTotal"
          : preferPerson
            ? "personTotal"
            : side.viewerOverview || inferred.viewerOverview;
      const focus = askedAreasRanking
        ? undefined
        : askedArea
          ? inferred.viewerFocus ||
            side.viewerFocus ||
            majorityItemField(side.resultItems || [], "area")
          : (preferPerson
              ? inferred.viewerFocus || topPerson
              : null) ||
            side.viewerFocus ||
            inferred.viewerFocus;
      const expanded = askedAreasRanking
        ? []
        : expandAgentItemsFromInventory(
            side.resultItems || [],
            items,
            overview,
            focus,
          );
      resolvedSide = {
        ...side,
        resultItems: expanded,
        viewerOverview: overview,
        viewerFocus: focus,
      };
    } else if (
      side &&
      !importPreviewLocked &&
      (side.viewerOverview === "areas" ||
        side.apiViewer?.tipo === "areas" ||
        side.apiViewer?.tipo === "areas_general" ||
        detectViewerOverview(side.userText || "") === "areas")
    ) {
      // Sin items: igual abrir ranking global de áreas.
      resolvedSide = {
        ...side,
        resultItems: [],
        viewerOverview: "areas",
        viewerFocus: undefined,
      };
    }
    const followUps =
      resolvedSide?.followUps !== undefined
        ? resolvedSide.followUps
        : buildChatFollowUps(
            {
              resultItems: resolvedSide?.resultItems,
              qr: resolvedSide?.qr,
              viewerOverview: resolvedSide?.viewerOverview,
              viewerFocus: resolvedSide?.viewerFocus,
            },
            resolvedSide?.userText,
            reply,
          );
    const finalMessages = messagesRef.current.map((m) =>
      m.id === botId
        ? {
            ...m,
            text: reply,
            at: Date.now(),
            importProgress: undefined,
            followUps,
            ...(resolvedSide
              ? {
                  resultItems: resolvedSide.resultItems || [],
                  qr: resolvedSide.qr || [],
                  viewerOverview: resolvedSide.viewerOverview,
                  viewerFocus: resolvedSide.viewerFocus,
                  viewerComparacion: resolvedSide.viewerComparacion || null,
                  exportFiles: resolvedSide.exportFiles || [],
                }
              : null),
          }
        : m,
    );
    messagesRef.current = finalMessages;
    setMessages(finalMessages);
    const hasSideData = Boolean(
      resolvedSide &&
        (((resolvedSide.resultItems?.length || 0) > 0 ||
          (resolvedSide.qr?.length || 0) > 0 ||
          Boolean(resolvedSide.viewerOverview) ||
          Boolean(resolvedSide.viewerComparacion))),
    );
    // Mostrar visor solo con datos nuevos; charla (sin side) → permanece oculto.
    setSideViewerVisible(hasSideData);
    if (
      side &&
      ((side.resultItems && side.resultItems.length) ||
        (side.qr && side.qr.length) ||
        side.viewerOverview ||
        side.viewerComparacion)
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
    // Ocultar panel derecho de inmediato al enviar (espera la nueva respuesta).
    setSideViewerVisible(false);
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
      opts?: { destLabel?: string; mode?: "import" | "copy"; etiquetas?: string[] },
    ) => {
      setPendingChatImportSafe(null);
      const saved: InventarioRow[] = [];
      let lastError = "";
      const total = rows.length;
      const destLabel =
        String(opts?.destLabel || rows[0]?.origen || "").trim() || null;
      const progressLabel =
        destLabel && destLabel !== sourceLabel
          ? `${sourceLabel} → ${destLabel}`
          : sourceLabel;
      // Pintar el cuadro de importación de inmediato (antes del primer lote).
      {
        const starting = messagesRef.current.map((m) =>
          m.id === botId
            ? {
                ...m,
                text: `Importando “${progressLabel}”… 0/${total}`,
                at: Date.now(),
                importProgress: { label: progressLabel, done: 0, total },
              }
            : m,
        );
        messagesRef.current = starting;
        setMessages(starting);
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
      }
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
                text: `Importando “${progressLabel}”… ${done}/${total}`,
                at: Date.now(),
                importProgress: { label: progressLabel, done, total },
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
        summary: `Importé ${saved.length} artículo${saved.length === 1 ? "" : "s"} desde “${sourceLabel}”${
          destLabel ? ` a ${destLabel}` : ""
        }`,
        totalBefore,
        totalAfter,
        count: saved.length,
        ids: saved.map((row) => row.id).filter((id): id is number => id != null),
        chatId: sessionId,
        fact: `Import “${sourceLabel}”${destLabel ? ` → ${destLabel}` : ""}: +${saved.length} (antes ${totalBefore} → ahora ${totalAfter})`,
      });
      const skipped = total - saved.length;
      const skipNote =
        skipped > 0
          ? `\n${skipped} fila${skipped === 1 ? "" : "s"} no se importaron (duplicados u error).`
          : "";
      const destNote =
        destLabel && destLabel !== sourceLabel
          ? ` hacia **${destLabel}**`
          : destLabel
            ? ` en **${destLabel}**`
            : "";
      const etqNote =
        opts?.etiquetas?.length
          ? opts.etiquetas.map((e) => `**${e}**`).join(", ")
          : null;
      const importFallback = [
        `mode=${opts?.mode || "import"}`,
        `count=${saved.length}`,
        `source=${sourceLabel}`,
        `dest=${destLabel || sourceLabel}`,
        `total_before=${totalBefore}`,
        `total_after=${totalAfter}`,
        skipped > 0 ? `skipped=${skipped}` : null,
        etqNote ? `etiquetas=${opts?.etiquetas?.join(",")}` : null,
      ]
        .filter(Boolean)
        .join("; ");

      let finalReply = importFallback;
      try {
        const polished = await polishInventoryReply({
          userText: `importar ${sourceLabel}`,
          kind: "import_done",
          fallback: importFallback,
          facts: {
            mode: opts?.mode || "import",
            count: saved.length,
            source: sourceLabel,
            dest: destLabel || sourceLabel,
            total_before: totalBefore,
            total_after: totalAfter,
            skipped: skipped || 0,
            dest_note: destNote || "",
            skip_note: skipNote || "",
          },
          sessionId,
        });
        finalReply = polished.reply;
      } catch {
        /* fallback hechos */
      }

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
        resultItems: saved
          .slice(0, CHAT_SIDE_RESULT_CAP)
          .map((row) => rowToChatApiItem(row)),
        qr: [],
      });
    };

    // Confirmar / cancelar eliminación pendiente (sí → modal; no → cancelar)
    {
      const pendingDel =
        pendingChatDeletePlanRef.current || pendingChatDeletePlan;
      if (pendingDel?.phase === "await_yes") {
        if (isNegativeChat(text)) {
          setPendingChatDeletePlanSafe(null);
          const cancelReply =
            "Listo, cancelé el borrado. No toqué ningún registro.";
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
            const nextPlan: ChatDeletePlan = {
              ...pendingDel,
              phase: "modal",
            };
            setPendingChatDeletePlanSafe(nextPlan);
            const replyText = formatDeleteModalPrompt(nextPlan);
            await ensureTypingPause(replyText);
            finishBotReply(sessionId, botId, replyText, {
              resultItems: nextPlan.rows
                .slice(0, CHAT_SIDE_RESULT_CAP)
                .map((row) => rowToChatApiItem(row)),
              qr: [],
            });
          } catch {
            /* abort */
          }
          return;
        }
      }
    }

    // Confirmar / cancelar merge “todos los demás → Inventario N”.
    {
      const pendingMerge = pendingOrigenMergeRef.current;
      if (pendingMerge) {
        if (isNegativeChat(text)) {
          pendingOrigenMergeRef.current = null;
          const cancelReply =
            `De acuerdo, **cancelé** la carga a **${pendingMerge.dest}**. ` +
            `No moví ni copié ningún registro de ${pendingMerge.sources
              .map((s) => `**${s}**`)
              .join(", ")}. Cuando quieras lo retomamos.`;
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
            pendingOrigenMergeRef.current = null;
            const foldOrig = (o: string) =>
              o
                .toLowerCase()
                .normalize("NFD")
                .replace(/\p{M}/gu, "")
                .replace(/\s+/g, " ")
                .trim();
            const destFold = foldOrig(pendingMerge.dest);
            let destEtq = new Set(
              items
                .filter((row) => foldOrig(String(row.origen ?? "")) === destFold)
                .map((row) => String(row.etiqueta ?? "").trim().toLowerCase())
                .filter(Boolean),
            );
            const savedAll: InventarioRow[] = [];
            const skippedDup: string[] = [];
            let lastError = "";
            for (const source of pendingMerge.sources) {
              const sourceFold = foldOrig(source);
              const sourceRows = items.filter(
                (row) =>
                  foldOrig(String(row.origen ?? "")) === sourceFold &&
                  String(row.etiqueta ?? "").trim(),
              );
              const toCopy: InventarioRow[] = [];
              const seen = new Set<string>();
              for (const row of sourceRows) {
                const key = String(row.etiqueta ?? "").trim().toLowerCase();
                if (!key || seen.has(key)) continue;
                seen.add(key);
                if (destEtq.has(key)) {
                  skippedDup.push(`${key} (${source})`);
                  continue;
                }
                toCopy.push(row);
              }
              if (!toCopy.length) continue;
              const payload = toCopy.map((row) =>
                rowToNewInventarioItem(row, pendingMerge.dest),
              );
              for (let i = 0; i < payload.length; i += CHAT_IMPORT_CHUNK) {
                if (
                  requestGen !== chatRequestGenRef.current ||
                  controller.signal.aborted
                ) {
                  throw new DOMException("Aborted", "AbortError");
                }
                const chunk = payload.slice(i, i + CHAT_IMPORT_CHUNK);
                const progressing = messagesRef.current.map((m) =>
                  m.id === botId
                    ? {
                        ...m,
                        text: `Copiando **${source}** → **${pendingMerge.dest}**… ${Math.min(i + chunk.length, payload.length)}/${payload.length}`,
                        at: Date.now(),
                      }
                    : m,
                );
                messagesRef.current = progressing;
                setMessages(progressing);
                const result = await addInventarioBulkAction(chunk);
                if (result.success && result.data?.length) {
                  savedAll.push(...result.data);
                  for (const row of result.data) {
                    const k = String(row.etiqueta ?? "").trim().toLowerCase();
                    if (k) destEtq.add(k);
                  }
                } else if (result.error) {
                  lastError = result.error;
                }
              }
            }
            if (!savedAll.length) {
              const fail =
                lastError ||
                `No quedó nada nuevo que importar a **${pendingMerge.dest}**` +
                  (skippedDup.length
                    ? ` (muchas etiquetas ya estaban: p. ej. ${skippedDup
                        .slice(0, 5)
                        .join(", ")})`
                    : "") +
                  `.`;
              await ensureTypingPause(fail);
              finishBotReply(sessionId, botId, fail);
              return;
            }
            const stamp = new Date().toISOString();
            const totalBefore = items.length;
            setItems((prev) => [
              ...savedAll.map((row) => ({ ...row, updated_at: stamp })),
              ...prev,
            ]);
            rememberMutation({
              kind: "import",
              summary: `Merge → ${pendingMerge.dest}: +${savedAll.length}`,
              totalBefore,
              totalAfter: totalBefore + savedAll.length,
              count: savedAll.length,
              ids: savedAll
                .map((row) => row.id)
                .filter((id): id is number => id != null),
              chatId: sessionId,
              fact: `Merge ${pendingMerge.sources.join("+")}→${pendingMerge.dest}: +${savedAll.length}`,
            });
            const lines = pendingMerge.sources
              .map((s) => `• **${s}**`)
              .join("\n");
            const doneReply =
              `Listo, ya confirmaste y terminé la carga.\n\n` +
              `Metí en **${pendingMerge.dest}** los registros nuevos desde:\n${lines}\n\n` +
              `**${savedAll.length.toLocaleString("es-MX")}** filas nuevas` +
              (skippedDup.length
                ? `; omití **${skippedDup.length.toLocaleString("es-MX")}** etiquetas que ya existían en el destino`
                : "") +
              `.\n\n` +
              `Puedes pedir el Excel de **${pendingMerge.dest}**, ver áreas o seguir con otra consulta.`;
            await ensureTypingPause(doneReply);
            finishBotReply(sessionId, botId, doneReply, {
              resultItems: savedAll
                .slice(0, CHAT_SIDE_RESULT_CAP)
                .map((row) => rowToChatApiItem(row)),
              qr: [],
              viewerOverview: "recent",
              viewerFocus: pendingMerge.dest,
            });
          } catch (err: unknown) {
            if (err instanceof DOMException && err.name === "AbortError") return;
            pendingOrigenMergeRef.current = null;
            finishBotReply(
              sessionId,
              botId,
              err instanceof Error
                ? err.message
                : "No pude completar la carga a ese inventario.",
            );
          }
          return;
        }
      }
    }

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

    // Confirmar restauración / corrección pendiente de campo(s)
    const pendingRevert =
      pendingFieldRevertRef.current || pendingFieldRevert;
    let pendingApplyList = (
      pendingFieldApplyRef.current?.length
        ? pendingFieldApplyRef.current
        : pendingFieldApply
    ) as ChatFieldChange[];
    const hasPendingEdits = Boolean(pendingRevert) || pendingApplyList.length > 0;
    if (hasPendingEdits && isNegativeChat(text)) {
      setPendingFieldRevertSafe(null);
      setPendingFieldApplySafe(null);
      setPendingFixContextSafe(null);
      const cancelReply = "Listo, cancelé la corrección. No toqué ningún registro.";
      try {
        await ensureTypingPause(cancelReply);
        finishBotReply(sessionId, botId, cancelReply);
      } catch {
        /* abort */
      }
      return;
    }
    if (hasPendingEdits && isAffirmativeChat(text)) {
      try {
        // “sí y el CF-0026 cámbialo / con activo…” → completa el apply si faltaba
        const rest = stripLeadingAffirmative(text);
        if (rest && pendingRevert && pendingApplyList.length === 0) {
          const restMentions = extractEtiquetaMentions(rest, items);
          const wrongEtq = String(pendingRevert.etiqueta ?? "")
            .trim()
            .toLowerCase();
          const rawFix =
            restMentions.find((et) => et.trim().toLowerCase() !== wrongEtq) ||
            restMentions[0] ||
            "";
          const targetRow = rawFix
            ? resolveEtiquetaAgainstInventory(rawFix, items)
            : undefined;
          if (targetRow?.id) {
            const patches = inferFieldPatchesFromText(rest);
            const basePatches: InferredFieldPatch[] = patches.length
              ? patches
              : [
                  {
                    field: pendingRevert.field,
                    value: pendingRevert.newValue,
                  },
                ];
            pendingApplyList = basePatches.map((p) => {
              const currentVal = String(
                (targetRow as Record<string, unknown>)[p.field] ?? "",
              ).trim();
              return {
                at: new Date().toISOString(),
                id: targetRow.id,
                etiqueta: String(targetRow.etiqueta ?? rawFix),
                articulo: String(targetRow.articulo ?? ""),
                field: p.field,
                oldValue: currentVal || "(vacío)",
                newValue: p.value,
                chatId: sessionId,
              } satisfies ChatFieldChange;
            });
            setPendingFieldApplySafe(pendingApplyList);
          }
        }

        const resolveTargetId = (change: ChatFieldChange) => {
          let targetId = change.id != null ? Number(change.id) : null;
          if (targetId == null && change.etiqueta) {
            const row =
              resolveEtiquetaAgainstInventory(String(change.etiqueta), items) ||
              items.find(
                (item) =>
                  String(item.etiqueta ?? "")
                    .trim()
                    .toLowerCase() ===
                  String(change.etiqueta)
                    .trim()
                    .toLowerCase(),
              );
            targetId = row?.id != null ? Number(row.id) : null;
          }
          return targetId;
        };
        const touched: InventarioRow[] = [];
        const notes: string[] = [];
        const stamp = new Date().toISOString();

        if (pendingRevert) {
          const targetId = resolveTargetId(pendingRevert);
          if (targetId == null) {
            setPendingFieldRevertSafe(null);
            setPendingFieldApplySafe(null);
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
          if (!result.success || !result.data) {
            setPendingFieldRevertSafe(null);
            setPendingFieldApplySafe(null);
            finishBotReply(
              sessionId,
              botId,
              result.error || "No se pudo restaurar el valor anterior.",
            );
            return;
          }
          touched.push(result.data);
          notes.push(
            `restauré **${pendingRevert.field}** de “**${pendingRevert.newValue}**” a “**${pendingRevert.oldValue}**” en **${result.data.etiqueta || targetId}**`,
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
        }

        for (const pendingApply of pendingApplyList) {
          const targetId = resolveTargetId(pendingApply);
          if (targetId == null) {
            setPendingFieldRevertSafe(null);
            setPendingFieldApplySafe(null);
            finishBotReply(
              sessionId,
              botId,
              "Restauré lo anterior, pero no ubiqué la etiqueta a corregir. Dime la etiqueta exacta.",
            );
            return;
          }
          const patch: Partial<NewInventarioItem> = {
            [pendingApply.field]: pendingApply.newValue,
          } as Partial<NewInventarioItem>;
          const result = await updateInventarioAction(targetId, patch);
          if (!result.success || !result.data) {
            setPendingFieldRevertSafe(null);
            setPendingFieldApplySafe(null);
            finishBotReply(
              sessionId,
              botId,
              result.error || "No se pudo aplicar la corrección en la etiqueta indicada.",
            );
            return;
          }
          touched.push(result.data);
          notes.push(
            `apliqué **${pendingApply.field}** “**${pendingApply.newValue}**” en **${result.data.etiqueta || targetId}**`,
          );
          rememberFieldChange({
            id: result.data.id,
            etiqueta: result.data.etiqueta,
            articulo: result.data.articulo,
            field: pendingApply.field,
            oldValue: pendingApply.oldValue,
            newValue: pendingApply.newValue,
            chatId: sessionId,
          });
        }

        setPendingFieldRevertSafe(null);
        setPendingFieldApplySafe(null);
        setPendingFixContextSafe(null);
        if (touched.length) {
          const byId = new Map(
            touched.map((row) => [Number(row.id), row] as const),
          );
          setItems((prev) =>
            prev.map((row) => {
              const next = byId.get(Number(row.id));
              return next ? { ...row, ...next, updated_at: stamp } : row;
            }),
          );
        }
        const finalReply =
          notes.length === 1
            ? `Listo: ${notes[0]}.`
            : `Listo: ${notes.join("; y ")}.`;
        await ensureTypingPause(finalReply);
        finishBotReply(sessionId, botId, finalReply, {
          resultItems: touched.map((row) => rowToChatApiItem(row)),
          qr: [],
        });
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setPendingFieldRevertSafe(null);
        setPendingFieldApplySafe(null);
        setPendingFixContextSafe(null);
        finishBotReply(
          sessionId,
          botId,
          err instanceof Error ? err.message : "Error al restaurar/corregir el valor.",
        );
      }
      return;
    }

    // Eliminar 1 / N / listado / inventario entero / multi → ¿seguro? → modal
    if (
      looksLikeDeleteInventoryAsk(userText || text) ||
      looksLikeDeleteRecordAsk(userText || text)
    ) {
      try {
        const intent = detectChatDeleteIntent(
          userText || text,
          listExistingOrigens(items),
        );
        const wipeAll =
          Boolean(intent?.wipeAllOrigens) ||
          looksLikeWipeAllInventariosAsk(userText || text);
        const contextRows = contextRowsForDelete();
        let rows: InventarioRow[] = [];
        if (intent) {
          rows = resolveChatDeleteRows({
            intent,
            inventory: items,
            contextRows,
          });
        }
        // Fallback: etiquetas / “estos” — NUNCA si pediste vaciar todos los inventarios.
        if (!rows.length && !wipeAll) {
          const fromPrompt = resolveRecordRowsFromPrompt(
            userText || text,
            "",
            items,
            40,
          );
          if (fromPrompt.length) rows = fromPrompt;
          else if (contextRows.length && /\b(est[oa]s?|esos|esas)\b/i.test(userText || text)) {
            rows = contextRows;
          } else {
            const one = resolveContextualRecordRows(
              items,
              messagesRef.current.map((m) => ({
                from: m.from,
                text: m.text || "",
              })),
              1,
            )[0];
            if (one) rows = [one];
          }
        }

        // Si hay origen y etiquetas ambiguas sin match, avisar (prosa OpenAI).
        if (!rows.length) {
          const emptyLabel =
            intent?.wholeOrigen
              ? formatOrigensListEs(planDeleteOrigens(intent)) ||
                intent.origen ||
                "ese origen"
              : "";
          const clarifyKind = wipeAll
            ? "delete_empty_all"
            : intent?.wholeOrigen
              ? "delete_empty_origen"
              : intent?.includeScopedList
                ? "delete_need_list"
                : "delete_need_target";
          const clarifyFallback = [
            `kind=${clarifyKind}`,
            wipeAll ? "wipe_all=true" : null,
            emptyLabel ? `origen=${emptyLabel}` : null,
            "accion=pedir_aclaracion_borrado",
          ]
            .filter(Boolean)
            .join("; ");
          let ask = clarifyFallback;
          try {
            const polished = await polishInventoryReply({
              userText: userText || text,
              kind: "delete_clarify",
              fallback: clarifyFallback,
              facts: {
                wipe_all: wipeAll,
                whole_origen: Boolean(intent?.wholeOrigen),
                need_list: Boolean(intent?.includeScopedList),
                origen: emptyLabel || null,
                existing_origens: listExistingOrigens(items).slice(0, 12),
              },
              sessionId,
            });
            ask = polished.reply;
          } catch {
            /* hechos */
          }
          await ensureTypingPause(ask);
          finishBotReply(sessionId, botId, ask);
          return;
        }

        const planOrigens = intent
          ? planDeleteOrigens(intent)
          : [];
        const plan: ChatDeletePlan = {
          mode:
            intent?.mode ||
            (wipeAll
              ? "whole_all_origens"
              : rows.length > 1
                ? "mixed"
                : "etiquetas"),
          origen: intent?.origen || planOrigens[0],
          origenes: planOrigens.length ? planOrigens : intent?.origenes,
          etiquetas: intent?.etiquetas || [],
          includeScopedList: Boolean(intent?.includeScopedList),
          wholeOrigen: Boolean(intent?.wholeOrigen) || wipeAll,
          wipeAllOrigens: wipeAll,
          phase: "await_yes",
          rows,
          askedAt: Date.now(),
        };
        setPendingChatDeletePlanSafe(plan);
        const softFacts = {
          count: plan.rows.length,
          origenes: planDeleteOrigens(plan),
          wipe_all: Boolean(plan.wipeAllOrigens || plan.mode === "whole_all_origens"),
          whole_origen: Boolean(plan.wholeOrigen),
          mode: plan.mode,
          sample: plan.rows.slice(0, 5).map((r) => ({
            etiqueta: String(r.etiqueta ?? "").trim(),
            articulo: String(r.articulo ?? "").trim(),
            origen: String(r.origen ?? "").trim(),
          })),
        };
        const softFallback = formatDeleteSoftConfirm(plan);
        let replyText = softFallback;
        try {
          const polished = await polishInventoryReply({
            userText: userText || text,
            kind: "delete_confirm",
            fallback: softFallback,
            facts: softFacts,
            sessionId,
          });
          replyText = polished.reply;
        } catch {
          /* softFallback */
        }
        await ensureTypingPause(replyText);
        finishBotReply(sessionId, botId, replyText, {
          resultItems: rows
            .slice(0, CHAT_SIDE_RESULT_CAP)
            .map((row) => rowToChatApiItem(row)),
          qr: [],
          followUps: [
            { label: "Confirmar borrado", prompt: "sí" },
            { label: "Cancelar", prompt: "no" },
          ],
        });
      } catch {
        /* abort */
      }
      return;
    }

    // Respuesta corta con etiqueta tras “¿cuál es la etiqueta?”
    {
      const pendingFix = pendingFixContextRef.current;
      if (
        pendingFix &&
        looksLikeEtiquetaOnlyReply(userText || text)
      ) {
        const targetRow =
          resolveEtiquetaAgainstInventory(String(userText || text).trim(), items) ||
          items.find(
            (row) =>
              String(row.etiqueta ?? "")
                .trim()
                .toLowerCase() ===
              String(userText || text)
                .trim()
                .toLowerCase(),
          );
        if (!targetRow?.id) {
          try {
            const ask = `No encontré **${String(userText || text).trim()}**. ¿Me confirmas la etiqueta exacta?`;
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
          } catch {
            /* abort */
          }
          return;
        }
        const patches =
          pendingFix.patches.length > 0
            ? pendingFix.patches
            : pendingFix.revert
              ? [
                  {
                    field: pendingFix.revert.field,
                    value: pendingFix.revert.newValue,
                  },
                ]
              : [];
        if (!patches.length) {
          setPendingFixContextSafe(null);
          try {
            const ask =
              `Ubiqué **${targetRow.etiqueta}**, pero no tengo el valor a aplicar. ` +
              `Dime p. ej. «activo» y la observación entre comillas.`;
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask, {
              resultItems: [rowToChatApiItem(targetRow)],
              qr: [],
            });
          } catch {
            /* abort */
          }
          return;
        }
        const applyChanges = buildApplyChangesForRow(
          targetRow,
          patches,
          sessionId,
        );
        setPendingFieldRevertSafe(pendingFix.revert);
        setPendingFieldApplySafe(applyChanges);
        setPendingFixContextSafe(null);
        const confirmLines = [
          ...(pendingFix.revert
            ? [
                {
                  etiqueta: pendingFix.revert.etiqueta,
                  field: pendingFix.revert.field,
                  oldValue: pendingFix.revert.newValue,
                  newValue: pendingFix.revert.oldValue,
                },
              ]
            : []),
          ...applyChanges.map((c) => ({
            etiqueta: c.etiqueta,
            field: c.field,
            oldValue: c.oldValue,
            newValue: c.newValue,
          })),
        ];
        const proposal =
          `Perfecto, usaré **${targetRow.etiqueta}**.\n\n` +
          (buildMutationConfirmReply(confirmLines) || "");
        try {
          await ensureTypingPause(proposal);
          finishBotReply(sessionId, botId, proposal, {
            resultItems: [
              ...(pendingFix.revert?.etiqueta
                ? items
                    .filter(
                      (r) =>
                        String(r.etiqueta ?? "")
                          .trim()
                          .toLowerCase() ===
                        String(pendingFix.revert?.etiqueta)
                          .trim()
                          .toLowerCase(),
                    )
                    .slice(0, 1)
                    .map((r) => rowToChatApiItem(r))
                : []),
              rowToChatApiItem(targetRow),
            ],
            qr: [],
          });
        } catch {
          /* abort */
        }
        return;
      }
    }

    // Mutaciones / correcciones / revert (cualquier etiqueta o situación)
    {
      const mem = ensureLastFieldChangeFromMessages(
        messagesRef.current.map((m) => ({
          from: m.from,
          text: m.text || "",
        })),
      );
      const plan = detectRecordMutationPlan(
        userText || text,
        items,
        mem.lastFieldChange,
      );
      if (plan && plan.action !== "pass_to_llm") {
        try {
          if (plan.action === "multi") {
            const applyChanges: ChatFieldChange[] = [];
            for (const item of plan.applies) {
              for (const p of item.patches) {
                const currentVal = String(
                  (item.row as Record<string, unknown>)[p.field] ?? "",
                ).trim();
                applyChanges.push({
                  at: new Date().toISOString(),
                  id: item.row.id,
                  etiqueta: item.etiqueta,
                  articulo: String(item.row.articulo ?? ""),
                  field: p.field,
                  oldValue: currentVal || "(vacío)",
                  newValue: p.value,
                  chatId: sessionId,
                });
              }
            }
            if (!plan.revert && !applyChanges.length) {
              const ask =
                plan.ask ||
                "Entendí varias peticiones, pero me falta la etiqueta o el valor. ¿Me lo confirmas en una frase?";
              await ensureTypingPause(ask);
              finishBotReply(sessionId, botId, ask);
              return;
            }
            setPendingFieldRevertSafe(plan.revert || null);
            setPendingFieldApplySafe(applyChanges);
            setPendingFixContextSafe(null);
            const confirmLines = [
              ...(plan.revert
                ? [
                    {
                      etiqueta: plan.revert.etiqueta,
                      field: plan.revert.field,
                      oldValue: plan.revert.newValue,
                      newValue: plan.revert.oldValue,
                    },
                  ]
                : []),
              ...applyChanges.map((c) => ({
                etiqueta: c.etiqueta,
                field: c.field,
                oldValue: c.oldValue,
                newValue: c.newValue,
              })),
            ];
            const header =
              confirmLines.length > 1
                ? `Voy a aplicar **${confirmLines.length}** cambios en una sola pasada:\n\n`
                : `Voy a aplicar este cambio:\n\n`;
            const proposal =
              header +
              (buildMutationConfirmReply(confirmLines) || "") +
              (plan.ask ? `\n\n${plan.ask}` : "");
            await ensureTypingPause(proposal);
            finishBotReply(sessionId, botId, proposal, {
              resultItems: [
                ...(plan.revert?.etiqueta
                  ? items
                      .filter(
                        (r) =>
                          String(r.etiqueta ?? "")
                            .trim()
                            .toLowerCase() ===
                          String(plan.revert?.etiqueta)
                            .trim()
                            .toLowerCase(),
                      )
                      .slice(0, 1)
                      .map((r) => rowToChatApiItem(r))
                  : []),
                ...plan.applies.map((a) => rowToChatApiItem(a.row)),
              ],
              qr: [],
            });
            return;
          }

          if (plan.action === "ask_fix_etiqueta") {
            const hintList = String(plan.hint || "")
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s && !/^(de|el|la|los|las)$/i.test(s));
            const patchesFromMsg = inferFieldPatchesFromText(userText || text);
            const patches =
              patchesFromMsg.length > 0
                ? patchesFromMsg
                : plan.last
                  ? [{ field: plan.last.field, value: plan.last.newValue }]
                  : [];
            setPendingFixContextSafe({
              revert: plan.last || null,
              patches,
              askedAt: Date.now(),
            });
            const ask =
              hintList.length > 1
                ? `Encontré varias etiquetas que coinciden (${hintList
                    .slice(0, 6)
                    .map((h) => `**${h}**`)
                    .join(", ")}). ¿Cuál quieres corregir? Escríbela tal cual.` +
                  (plan.last
                    ? ` Mientras, puedo dejar **${plan.last.etiqueta || plan.last.id}** como estaba.`
                    : "")
                : plan.last
                  ? `Claro. Para corregir el registro bueno necesito su **etiqueta** exacta` +
                    (hintList[0] ? ` (p. ej. **${hintList[0]}**)` : "") +
                    `. También puedo dejar **${plan.last.etiqueta || plan.last.id}** como estaba. Responde solo con la etiqueta.`
                  : `Entendido. Dime la **etiqueta** exacta a corregir (solo el código).`;
            if (plan.last) {
              setPendingFieldRevertSafe(plan.last);
              setPendingFieldApplySafe(null);
            }
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }

          if (plan.action === "revert_only") {
            const proposal = buildRevertProposalReply(mem);
            setPendingFieldRevertSafe(plan.last);
            setPendingFieldApplySafe(null);
            await ensureTypingPause(proposal || "");
            finishBotReply(
              sessionId,
              botId,
              proposal || "No tengo ese cambio en memoria.",
            );
            return;
          }

          if (plan.action === "fix_and_revert") {
            const { fixEtiqueta, last, patches } = plan;
            const targetRow =
              resolveEtiquetaAgainstInventory(fixEtiqueta, items) ||
              items.find(
                (row) =>
                  String(row.etiqueta ?? "")
                    .trim()
                    .toLowerCase() === fixEtiqueta.trim().toLowerCase(),
              );
            if (!targetRow?.id) {
              const ask = `No encontré la etiqueta **${fixEtiqueta}** en el inventario. ¿Me confirmas cómo está escrita?`;
              await ensureTypingPause(ask);
              finishBotReply(sessionId, botId, ask);
              return;
            }
            const applyPatches: InferredFieldPatch[] = patches?.length
              ? patches
              : [{ field: last.field, value: last.newValue }];
            const applyChanges: ChatFieldChange[] = applyPatches.map((p) => {
              const currentVal = String(
                (targetRow as Record<string, unknown>)[p.field] ?? "",
              ).trim();
              return {
                at: new Date().toISOString(),
                id: targetRow.id,
                etiqueta: String(targetRow.etiqueta ?? fixEtiqueta),
                articulo: String(targetRow.articulo ?? ""),
                field: p.field,
                oldValue: currentVal || "(vacío)",
                newValue: p.value,
                chatId: sessionId,
              };
            });
            setPendingFieldRevertSafe(last);
            setPendingFieldApplySafe(applyChanges);
            const wrongLabel = last.etiqueta || String(last.id ?? "registro previo");
            const proposal =
              `Voy a deshacer el cambio en **${wrongLabel}** y corregir **${String(targetRow.etiqueta ?? fixEtiqueta)}**.\n\n` +
              (buildMutationConfirmReply([
                {
                  etiqueta: last.etiqueta,
                  field: last.field,
                  oldValue: last.newValue,
                  newValue: last.oldValue,
                },
                ...applyChanges.map((c) => ({
                  etiqueta: c.etiqueta,
                  field: c.field,
                  oldValue: c.oldValue,
                  newValue: c.newValue,
                })),
              ]) || "");
            await ensureTypingPause(proposal);
            finishBotReply(sessionId, botId, proposal, {
              resultItems: [
                ...(last.etiqueta
                  ? items
                      .filter(
                        (r) =>
                          String(r.etiqueta ?? "")
                            .trim()
                            .toLowerCase() ===
                          String(last.etiqueta)
                            .trim()
                            .toLowerCase(),
                      )
                      .slice(0, 1)
                      .map((r) => rowToChatApiItem(r))
                  : []),
                rowToChatApiItem(targetRow),
              ],
              qr: [],
            });
            return;
          }

          if (plan.action === "propose_patches") {
            const targetRow =
              resolveEtiquetaAgainstInventory(plan.fixEtiqueta, items) ||
              items.find(
                (row) =>
                  String(row.etiqueta ?? "")
                    .trim()
                    .toLowerCase() === plan.fixEtiqueta.trim().toLowerCase(),
              );
            if (!targetRow?.id) {
              const ask = `No encontré la etiqueta **${plan.fixEtiqueta}**. ¿Me confirmas la escritura exacta?`;
              await ensureTypingPause(ask);
              finishBotReply(sessionId, botId, ask);
              return;
            }
            const applyChanges: ChatFieldChange[] = plan.patches.map((p) => {
              const currentVal = String(
                (targetRow as Record<string, unknown>)[p.field] ?? "",
              ).trim();
              return {
                at: new Date().toISOString(),
                id: targetRow.id,
                etiqueta: String(targetRow.etiqueta ?? plan.fixEtiqueta),
                articulo: String(targetRow.articulo ?? ""),
                field: p.field,
                oldValue: currentVal || "(vacío)",
                newValue: p.value,
                chatId: sessionId,
              };
            });
            setPendingFieldRevertSafe(null);
            setPendingFieldApplySafe(applyChanges);
            const proposal =
              `Voy a corregir **${String(targetRow.etiqueta ?? plan.fixEtiqueta)}**:\n\n` +
              (buildMutationConfirmReply(
                applyChanges.map((c) => ({
                  etiqueta: c.etiqueta,
                  field: c.field,
                  oldValue: c.oldValue,
                  newValue: c.newValue,
                })),
              ) || "");
            await ensureTypingPause(proposal);
            finishBotReply(sessionId, botId, proposal, {
              resultItems: [rowToChatApiItem(targetRow)],
              qr: [],
            });
            return;
          }
        } catch {
          /* abort */
        }
      }
    }

    // Import Excel pendiente: solo si el turno bot inmediato fue el preview
    // y la confirmación es explícita. ok/okey/vale NUNCA disparan la carga.
    let pendingRows = pendingChatImportRef.current?.length
      ? pendingChatImportRef.current
      : pendingChatImport;
    let pendingAskedAt = pendingImportAskedAtRef.current;
    if (!pendingRows?.length) {
      const fromSession = loadPendingImportFromSession(sessionId);
      if (fromSession?.items?.length) {
        pendingRows = fromSession.items;
        pendingAskedAt = fromSession.askedAt;
        pendingChatImportRef.current = fromSession.items;
        setPendingChatImport(fromSession.items);
        pendingImportAskedAtRef.current = fromSession.askedAt;
      }
    }
    if (
      pendingRows?.length &&
      pendingAskedAt &&
      Date.now() - pendingAskedAt > PENDING_IMPORT_TTL_MS
    ) {
      setPendingChatImportSafe(null);
      pendingRows = null;
    }

    const lastConcreteBot = getLastConcreteBotMessage();
    const prevTurnIsImportPreview = Boolean(
      lastConcreteBot && looksLikeImportPreviewAsk(lastConcreteBot.text || ""),
    );

    // Excel viejo o ya hubo otra respuesta del bot → descartar pendiente
    if (pendingRows?.length && !prevTurnIsImportPreview) {
      setPendingChatImportSafe(null);
      pendingRows = null;
    }

    // Pendiente + destino explícito (“importar a Inventario 1” / “a S/O”).
    if (pendingRows?.length && prevTurnIsImportPreview) {
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
        const remapFallback =
          `Listo: reasigné los **${formatNumber(remapped.length)}** registros pendientes a **${forceOrigen}**.\n\n` +
          `¿Confirmas la importación?`;
        let remapReply = remapFallback;
        try {
          const polished = await polishInventoryReply({
            userText: text || userText,
            kind: "import_preview",
            fallback: remapFallback,
            facts: {
              count: remapped.length,
              origen: forceOrigen,
              source: "prompt",
              remapped: true,
            },
            sessionId,
          });
          remapReply = polished.reply;
        } catch {
          /* fallback */
        }
        finishBotReply(sessionId, botId, remapReply, {
          resultItems: importItemsToChatApi(
            remapped.slice(0, CHAT_SIDE_RESULT_CAP),
          ),
          viewerFocus: forceOrigen,
          followUps: IMPORT_CONFIRM_FOLLOW_UPS,
        });
        return;
      }
    }
    if (
      pendingRows?.length &&
      prevTurnIsImportPreview &&
      isNegativeChat(text)
    ) {
      setPendingChatImportSafe(null);
      const cancelFallback =
        "De acuerdo, cancelé la carga. No importé nada del Excel pendiente.";
      let cancelReply = cancelFallback;
      try {
        const polished = await polishInventoryReply({
          userText: text || userText,
          kind: "import_cancel",
          fallback: cancelFallback,
          facts: { cancelled: true },
          sessionId,
        });
        cancelReply = polished.reply;
      } catch {
        /* fallback */
      }
      try {
        await ensureTypingPause(cancelReply);
        finishBotReply(sessionId, botId, cancelReply, { followUps: [] });
      } catch {
        /* abort */
      }
      return;
    }
    if (
      pendingRows?.length &&
      prevTurnIsImportPreview &&
      isChatImportConfirm(text)
    ) {
      try {
        const origenLabel =
          String(pendingRows[0]?.origen ?? "").trim() || "archivo pendiente";
        await runBulkChatImport(pendingRows, origenLabel, {
          destLabel: origenLabel,
        });
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
    // Otra pregunta con Excel pendiente (p. ej. “okey” / panorama) → limpiar y seguir
    if (pendingRows?.length) {
      setPendingChatImportSafe(null);
      pendingRows = null;
    }

    // Adjuntar Excel/CSV → parsear; importar ya o pedir confirmación
    if (attach?.file && isSpreadsheetName(attach.name)) {
      try {
        const existingOrigens = [
          ...new Set(
            items.map((row) => String(row.origen ?? "").trim()).filter(Boolean),
          ),
        ];
        const fileOrigenGuess = nextFileOrigenFromFileName(
          attach.name,
          existingOrigens,
        );
        const parsed = await parseInventarioImportFile(
          attach.file,
          fileOrigenGuess,
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

        // Solo texto tipado (no “[Archivo: Inventario 2.xlsx]”) → evita mapear el nombre del archivo a Inventario N.
        const plan = planImportOrigen({
          promptText: text,
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

        // Todas las filas con el origen de archivo (o destino explícito del prompt).
        const itemsForImport = parsed.items.map((item) => ({
          ...item,
          origen,
        }));
        setPendingChatImportSafe(itemsForImport);
        const areasSample = [
          ...new Set(
            itemsForImport
              .map((row) => String(row.area ?? "").trim())
              .filter(Boolean),
          ),
        ].slice(0, 8);
        const fallbackPreview = buildChatImportPreviewReply({
          fileName: attach.name,
          sheetName: parsed.sheetName,
          origen,
          source: plan.source,
          count: nBase,
          rawValid,
          dups,
        });
        let previewReply = fallbackPreview;
        try {
          const polished = await polishInventoryReply({
            userText: text || userText || `Archivo: ${attach.name}`,
            kind: "import_preview",
            fallback: fallbackPreview,
            facts: {
              file_name: attach.name,
              sheet_name: parsed.sheetName || null,
              count: nBase,
              raw_valid: rawValid,
              dups,
              origen,
              source: plan.source,
              areas_count: areasSample.length,
              areas_sample: areasSample,
            },
            sessionId,
          });
          previewReply = polished.reply;
        } catch {
          /* fallback plantilla */
        }
        finishBotReply(sessionId, botId, previewReply, {
          resultItems: importItemsToChatApi(
            itemsForImport.slice(0, CHAT_SIDE_RESULT_CAP),
          ),
          viewerOverview: "full",
          viewerFocus: origen,
          followUps: IMPORT_CONFIRM_FOLLOW_UPS,
        });
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setPendingChatImportSafe(null);
        finishBotReply(
          sessionId,
          botId,
          err instanceof Error
            ? err.message
            : "No pude leer el Excel. Usa .xlsx, .xls o .csv.",
        );
      }
      return;
    }

    // Pedir Excel/CSV sin adjunto → guía conversacional (OpenAI; NO exportar).
    if (!attach && asksChatFileImport(userText || text)) {
      const guideFallback =
        "accion=guiar_adjunto_excel; columnas=ETIQUETA,ARTÍCULO,MARCA,MODELO,SERIE,ÁREA,PERSONA,CANTIDAD,ESTADO";
      let guideReply = guideFallback;
      try {
        const polished = await polishInventoryReply({
          userText: userText || text,
          kind: "import_guide",
          fallback: guideFallback,
          facts: {
            has_attachment: false,
            accept: [".xlsx", ".xls", ".csv"],
            columns: [
              "ETIQUETA",
              "ARTÍCULO",
              "MARCA",
              "MODELO",
              "SERIE",
              "ÁREA",
              "PERSONA",
              "CANTIDAD",
              "ESTADO",
            ],
          },
          sessionId,
        });
        guideReply = polished.reply;
      } catch {
        /* hechos */
      }
      finishBotReply(sessionId, botId, guideReply, { followUps: [] });
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

    // agent = pydantic-ai+tools (default). local/n8n = híbrido anterior.
    const chatConsultasMode = String(
      process.env.NEXT_PUBLIC_CHAT_CONSULTAS || "agent",
    )
      .trim()
      .toLowerCase();
    const preferAgentConsultas =
      chatConsultasMode === "agent" || chatConsultasMode === "deepseek";

    // Ortografía backend: solo híbrido local/n8n. El agente entiende typos.
    const spokenRaw = userText || text;
    let spokenText = spokenRaw;
    if (!preferAgentConsultas) {
      try {
        const spelled = await normalizeChatSpellingAsync(
          spokenRaw,
          controller.signal,
        );
        if (spelled.normalized) spokenText = spelled.normalized;
      } catch {
        /* abort / red → texto crudo */
      }
    }

    // Hilo de conversación: leer mensajes de arriba para no perder el tema.
    const resolvedTurn = resolveChatTurnContext({
      userText: spokenText,
      recentMessages: messagesRef.current.map((m) => ({
        from: m.from,
        text: m.text || "",
      })),
    });
    /** Texto enriquecido con contexto (detectores locales / IA). */
    let intentText = resolvedTurn.effectiveText || spokenText;

    // Multipetición inventarios: “mete Inv2→Inv3 y omite las que ya existan”.
    // Nunca reescribir si es comparar listado / inventarios.
    {
      const origensNow = listExistingOrigens(items);
      const isCompareAsk =
        Boolean(detectCompareScopedListAsk(intentText, origensNow)) ||
        Boolean(detectCompareInventariosAsk(intentText, origensNow)) ||
        /\bcompara\w*\b/i.test(intentText);
      if (!isCompareAsk) {
        const multi = detectInventarioMultiPlan(intentText, origensNow);
        if (multi?.steps[0]?.kind === "bulk_copy") {
          intentText = multi.primaryText;
          resolvedTurn.topic = "fill_inventario";
        }
      }
    }

    // Lecturas → agente backend (texto crudo). Writes/Excel/QR siguen locales.
    {
      const keepLocal =
        shouldKeepLocalWritePipeline(spokenRaw, items, {
          pendingNewInventario: Boolean(pendingNewInventarioRef.current),
          pendingCopyEtiquetaDest: Boolean(pendingCopyEtiquetaDestRef.current),
        }) ||
        shouldKeepLocalWritePipeline(intentText, items, {
          pendingNewInventario: Boolean(pendingNewInventarioRef.current),
          pendingCopyEtiquetaDest: Boolean(pendingCopyEtiquetaDestRef.current),
        });
      if (preferAgentConsultas && !keepLocal) {
        const memoryBlock = [
          formatChatMemoryForPrompt(),
          resolvedTurn.threadHint,
        ]
          .filter(Boolean)
          .join("\n\n");
        try {
          const data = await askInventoryChat(spokenRaw, history, {
            signal: controller.signal,
            memory: memoryBlock || undefined,
            model: activeLlmMeta.model,
            sessionId,
            contextoVista: getContextoVista(),
          });
          if (
            requestGen !== chatRequestGenRef.current ||
            controller.signal.aborted
          ) {
            return;
          }
          if (data.error === "aborted") return;
          // Prosa del agente intacta (sin polish/plantillas locales).
          const replyText =
            (data.reply || "").trim() ||
            "No obtuve respuesta del asistente.";
          recordTokenConsumption(data.usage ?? null, spokenRaw, replyText);
          await ensureTypingPause(replyText);

          const apiFollowUps = mapAccionesSugeridas(data.acciones_sugeridas);
          const ctxRaw = data.contexto_vista;
          const ctxNull = ctxRaw === null;
          const ctx =
            ctxRaw && typeof ctxRaw === "object"
              ? {
                  tipo: String(ctxRaw.tipo || "").trim().toLowerCase(),
                  valor: String(ctxRaw.valor || "").trim(),
                  lista_limitada: Boolean(ctxRaw.lista_limitada),
                  comparacion:
                    ctxRaw.comparacion &&
                    typeof ctxRaw.comparacion === "object"
                      ? ctxRaw.comparacion
                      : undefined,
                }
              : null;

          const sideItems = data.items || [];
          const exportFocus =
            (ctx?.tipo === "origen" ||
              ctx?.tipo === "persona" ||
              ctx?.tipo === "area") &&
            ctx.valor
              ? ctx.valor
              : "Inventario";
          const exportFiles = data.exportar_excel
            ? await buildExportFilesFromApiItems(sideItems, exportFocus)
            : undefined;

          if (ctxNull && !exportFiles?.length && !data.mutated) {
            finishBotReply(sessionId, botId, replyText, {
              userText: spokenRaw,
              followUps: apiFollowUps.length ? apiFollowUps : undefined,
            });
            return;
          }

          let sideOverview: ViewerOverview | undefined;
          let sideFocus: string | undefined;
          let sideComparacion: ChatComparacionVista | null = null;
          let resultItems = sideItems;

          if (ctx?.tipo === "comparacion") {
            sideOverview = "comparacion";
            sideComparacion =
              (ctx.comparacion as ChatComparacionVista | undefined) || null;
            resultItems = [];
          } else if (
            ctx?.tipo === "areas" ||
            ctx?.tipo === "areas_general"
          ) {
            sideOverview = "areas";
            resultItems = [];
          } else if (ctx?.tipo === "persona" && ctx.valor) {
            sideFocus = ctx.valor;
            sideOverview = ctx.lista_limitada ? undefined : "personTotal";
          } else if (ctx?.tipo === "area" && ctx.valor) {
            sideFocus = ctx.valor;
            sideOverview = ctx.lista_limitada ? undefined : "areaTotal";
          } else if (ctx?.tipo === "origen" && ctx.valor) {
            sideFocus = ctx.valor;
            sideOverview = "full";
          } else {
            const threadFocus = (() => {
              for (let i = chatHistory.length - 1; i >= 0; i -= 1) {
                const m = chatHistory[i];
                if (m.from !== "bot") continue;
                const f = String(m.viewerFocus || "").trim();
                if (f) return f;
              }
              return "";
            })();
            const side = inferSideFromAgentResult(
              spokenRaw,
              sideItems,
              data.qr || [],
              threadFocus,
            );
            sideOverview =
              side.viewerOverview || detectViewerOverview(spokenRaw);
            sideFocus = side.viewerFocus;
            resultItems = side.resultItems || sideItems;
          }

          finishBotReply(sessionId, botId, replyText, {
            resultItems,
            qr: data.qr || [],
            viewerOverview: sideOverview,
            viewerFocus: sideFocus,
            viewerComparacion: sideComparacion,
            exportFiles,
            apiViewer: ctx
              ? {
                  tipo:
                    ctx.tipo === "areas_general" ? "areas" : ctx.tipo,
                  valor: ctx.valor || "general",
                }
              : null,
            userText: spokenRaw,
            followUps: apiFollowUps.length
              ? apiFollowUps
              : undefined,
            skipExpand:
              Boolean(ctx?.lista_limitada) ||
              sideOverview === "areas" ||
              sideOverview === "comparacion",
          });
          return;
        } catch (err) {
          if (
            (err instanceof DOMException && err.name === "AbortError") ||
            (err instanceof Error && err.name === "AbortError")
          ) {
            return;
          }
          /* caer al híbrido local si el agente falla */
        }
      }
    }

    // Primer mensaje muy vago → orientar (solo modo local/n8n).
    if (
      !preferAgentConsultas &&
      resolvedTurn.isFirstUserTurn &&
      resolvedTurn.topic === "unknown" &&
      spokenText.trim().split(/\s+/).length <= 3 &&
      !/\d{3,}/.test(spokenText) &&
      isExploratoryChatAsk(spokenText)
    ) {
      try {
        const ask =
          `Claro. ¿Qué quieres hacer con el inventario?\n\n` +
          `• Buscar por **persona**, **área** o **etiqueta**\n` +
          `• **Comparar inventarios** o revisar **duplicados**\n` +
          `• Crear un **nuevo inventario** / meter registros\n` +
          `• Ver **últimos registros** o **ideas de consulta**\n\n` +
          `Dímelo en una frase y lo hacemos.`;
        recordTokenConsumption(null, spokenText, ask);
        await ensureTypingPause(ask);
        finishBotReply(sessionId, botId, ask);
        return;
      } catch {
        /* abort */
      }
    }

    // Acuse conversacional (“bien / perfecto / me parece…”) → chat, no buscar áreas.
    {
      const ackNorm = normalizeChatIntent(spokenText);
      const isShortConfirm =
        /^(si|sip|sep|dale|ok|okay|okey|vale|claro|correcto|esa|ese|eso|afirmativo)$/.test(
          ackNorm,
        );
      if (isNonConcreteChatAsk(spokenText) && !isShortConfirm) {
        try {
          pendingDisambiguationRef.current = null;
          const fallbackAck = buildConversationalAckReply(spokenText);
          const polished = await polishInventoryReply({
            userText: spokenText,
            sessionId: sessionId,
            kind: "ack",
            threadHint: resolvedTurn.threadHint || "",
            fallback: fallbackAck,
            facts: { tone: "acknowledgment", user_text: spokenText },
          });
          recordTokenConsumption(null, spokenText, polished.reply);
          await ensureTypingPause(polished.reply);
          finishBotReply(sessionId, botId, polished.reply, {
            followUps: polished.followUps,
          });
          return;
        } catch {
          /* abort */
        }
      }
    }

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
          const { reply: fallbackReply, shownRows } = buildExactAreaReply(
            resolved.area,
            resolved.limit,
          );
          const polished = await polishInventoryReply({
            userText: userText || text,
            sessionId: sessionId,
            kind: "areaTotal",
            threadHint: resolvedTurn.threadHint || "",
            fallback: fallbackReply,
            facts: {
              area: resolved.area.name,
              total: resolved.area.rows.length,
              personas: resolved.area.personas,
              activos: resolved.area.activos,
              samples: shownRows.slice(0, 5).map((row) => ({
                etiqueta: String(row.etiqueta ?? "").trim(),
                articulo: String(row.articulo ?? "").trim(),
                persona: String(row.persona ?? "").trim(),
              })),
            },
          });
          recordTokenConsumption(null, userText || text, polished.reply);
          await ensureTypingPause(polished.reply);
          finishBotReply(sessionId, botId, polished.reply, {
            resultItems: shownRows.map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: "areaTotal",
            viewerFocus: resolved.area.name,
            followUps: polished.followUps,
          });
        } catch {
          /* abort / nuevo mensaje */
        }
        return;
      }
      if (resolved.status === "resolved_person") {
        pendingDisambiguationRef.current = null;
        try {
          const { reply: fallbackReply, shownRows } = buildExactPersonReply(
            resolved.person,
            resolved.limit,
          );
          const polished = await polishInventoryReply({
            userText: userText || text,
            sessionId: sessionId,
            kind: "personTotal",
            threadHint: resolvedTurn.threadHint || "",
            fallback: fallbackReply,
            facts: {
              persona: resolved.person.name,
              total: resolved.person.rows.length,
              activos: resolved.person.activos,
              samples: shownRows.slice(0, 5).map((row) => ({
                etiqueta: String(row.etiqueta ?? "").trim(),
                articulo: String(row.articulo ?? "").trim(),
                area: String(row.area ?? "").trim(),
              })),
            },
          });
          recordTokenConsumption(null, userText || text, polished.reply);
          await ensureTypingPause(polished.reply);
          finishBotReply(sessionId, botId, polished.reply, {
            resultItems: shownRows.map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: "personTotal",
            viewerFocus: resolved.person.name,
            followUps: polished.followUps,
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

    // Consultas de lectura → n8n (opt-in). agent ya se resolvió arriba.
    {
      // Solo n8n-first si CHAT_CONSULTAS=n8n.
      const preferN8nConsultas =
        String(process.env.NEXT_PUBLIC_CHAT_CONSULTAS || "agent")
          .trim()
          .toLowerCase() === "n8n";
      const keepLocal = shouldKeepLocalWritePipeline(
        intentText || userText || text,
        items,
        { pendingNewInventario: Boolean(pendingNewInventarioRef.current) },
      );
      if (preferN8nConsultas && !keepLocal) {
        const memoryBlock = [
          formatChatMemoryForPrompt(),
          resolvedTurn.threadHint,
        ]
          .filter(Boolean)
          .join("\n\n");
        const threadFocus: N8nThreadFocus = {};
        for (let i = chatHistory.length - 1; i >= 0; i -= 1) {
          const m = chatHistory[i];
          if (m.from !== "bot") continue;
          const focus = String(m.viewerFocus || "").trim();
          const ov = m.viewerOverview;
          if (focus) {
            threadFocus.focus = focus;
            if (ov === "personTotal" || ov === "personMatches") {
              threadFocus.persona = focus;
            } else if (ov === "areaTotal" || ov === "areaMatches") {
              threadFocus.area = focus;
            } else if (/^inventario\b/i.test(focus)) {
              threadFocus.origen = focus;
            }
          }
          if (ov) threadFocus.overview = ov;
          break;
        }
        const recentUserBits = chatHistory
          .filter((m) => m.from === "user")
          .slice(-3)
          .map((m) => String(m.text || "").trim())
          .filter(Boolean);
        const threadSummary = recentUserBits.length
          ? recentUserBits.map((t, idx) => `${idx + 1}. ${t.slice(0, 160)}`).join(" | ")
          : null;
        const n8nMessage = memoryBlock
          ? `${memoryBlock}\n\nUsuario: ${intentText}`
          : intentText;
        try {
          const n8nRes = await enviarMensajeN8n(n8nMessage, sessionId, {
            signal: controller.signal,
            context: {
              threadFocus,
              lastUser: spokenText || userText || text,
              threadSummary,
            },
          });
          if (
            requestGen !== chatRequestGenRef.current ||
            controller.signal.aborted
          ) {
            return;
          }
          const panelAccion = pickMostrarPanelAccion(n8nRes.acciones);
          ejecutarAcciones(
            (n8nRes.acciones || []).filter((a) => a?.tipo !== "mostrar_panel"),
          );
          const panelSide = resolveN8nMostrarPanel(panelAccion, items);
          let replyText =
            (n8nRes.reply || "").trim() ||
            "No obtuve respuesta del asistente n8n.";
          recordTokenConsumption(null, userText || text, replyText);
          await ensureTypingPause(replyText);
          finishBotReply(sessionId, botId, replyText, {
            resultItems: panelSide?.resultItems || [],
            qr: [],
            viewerOverview: panelSide?.viewerOverview,
            viewerFocus: panelSide?.viewerFocus,
          });
          return;
        } catch (err) {
          if (
            (err instanceof DOMException && err.name === "AbortError") ||
            (err instanceof Error && err.name === "AbortError")
          ) {
            return;
          }
          // n8n caído → DeepSeek (sin pasar por detectores locales de lectura).
          try {
            const data = await askInventoryChat(intentText, history, {
              signal: controller.signal,
              memory: memoryBlock,
              model: activeLlmMeta.model,
              sessionId: sessionId,
              contextoVista: getContextoVista(),
            });
            if (
              requestGen !== chatRequestGenRef.current ||
              controller.signal.aborted ||
              data.error === "aborted"
            ) {
              return;
            }
            const replyText =
              (data.reply || "").trim() ||
              "No pude completar la consulta. Intenta de nuevo.";
            recordTokenConsumption(data.usage, userText || text, replyText);
            await ensureTypingPause(replyText);
            const side = inferSideFromAgentResult(
              spokenRaw || intentText,
              data.items || [],
              data.qr || [],
            );
            finishBotReply(sessionId, botId, replyText, {
              ...side,
              userText: spokenRaw || intentText,
              followUps: buildChatFollowUps(side, spokenRaw || intentText),
            });
          } catch (err2) {
            if (
              (err2 instanceof DOMException && err2.name === "AbortError") ||
              (err2 instanceof Error && err2.name === "AbortError")
            ) {
              return;
            }
            const fail =
              "No pude contactar n8n ni el asistente local. Revisa la conexión.";
            try {
              await ensureTypingPause(fail);
              finishBotReply(sessionId, botId, fail);
            } catch {
              /* abort */
            }
          }
          return;
        }
      }
    }

    // 1b0-new-record. “cómo crear un registro en Inventario 5” (con pending o nombre).
    {
      const nRec = normalizeChatIntent(userText || text);
      const wantsForm =
        /\b(nuevo\s+registro|subir(le)?\s+(un\s+)?registro|opciones\s+a\s+llenar|como\s+crear|alta\s+(de\s+)?registro|llenar\s+(el\s+)?formulario)\b/.test(
          nRec,
        );
      if (wantsForm) {
        const origensNow = listExistingOrigens(items);
        const named =
          matchOrigenFromPrompt(userText || text, origensNow) ||
          pendingNewInventarioRef.current?.name ||
          undefined;
        // “crealo” / crear inventario N en el mismo mensaje
        const createAsk = detectCreateInventarioAsk(userText || text, origensNow);
        const dest =
          createAsk?.name ||
          named ||
          (/\binventarios?\s*\d+\b/.test(nRec)
            ? matchOrigenFromPrompt(userText || text, [
                ...origensNow,
                `Inventario ${nRec.match(/\binventarios?\s*(\d+)\b/)?.[1] || ""}`,
              ])
            : undefined) ||
          nextInventarioName(origensNow);
        if (dest) {
          try {
            pendingNewInventarioRef.current = {
              name: dest,
              emptyOk: true,
              askedAt: Date.now(),
            };
            setAddModalDestino(dest);
            setIsAddModalOpen(true);
            const ask =
              `Perfecto: **${dest}** queda listo para altas. Te abrí el formulario de **nuevo registro**.\n\n` +
              `Llena al menos **etiqueta** y **artículo**; también área, persona, marca, modelo, serie, cantidad y estado. ` +
              `El destino/origen será **${dest}**. Si prefieres, escanea un QR o sube un Excel.`;
            recordTokenConsumption(null, userText || text, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          } catch {
            /* abort */
          }
        }
      }
    }

    // 1b0-catalog. “qué inventarios tenemos / dame todos los inventarios”.
    {
      const nCat = normalizeChatIntent(userText || text);
      const asksCatalog =
        detectListInventariosAsk(userText || text) ||
        (/\b(inventarios?)\b/.test(nCat) &&
          /\b(tenemos|hay|existen|hechos|creados|cual|cuales|list|muestra|dime|dame|todos)\b/.test(
            nCat,
          ) &&
          (/\b(crear|creamos|podremos|podemos|nuevo|siguiente)\b/.test(nCat) ||
            /\b(tenemos|hay|existen|hechos|creados|cuales?\s+hay|todos)\b/.test(
              nCat,
            )));
      if (asksCatalog) {
        try {
          const existing = listExistingOrigens(items);
          const counts = existing.map((origen) => ({
            origen: canonicalizeOrigenLabel(origen),
            n: items.filter((r) =>
              origensMatch(String(r.origen ?? ""), origen),
            ).length,
          }));
          const next = nextInventarioName(existing);
          const bits = counts
            .map((c) => `**${c.origen}** (${c.n.toLocaleString("es-MX")})`)
            .join(", ");
          const localReply =
            !items.length || counts.length === 0
              ? pickChatVariant(
                  [
                    `En este momento **no hay inventarios**. El primero podría ser **${next}**: ¿lo creamos o importas un Excel?`,
                    `Todavía no hay nada que listar. Si quieres, empezamos con **${next}** o subimos un archivo.`,
                    `Ahora mismo el inventario está vacío. ¿Preparo **${next}** o cargas un Excel?`,
                  ],
                  "catalog-empty",
                )
              : pickChatVariant(
                  [
                    `Estos son los inventarios: ${bits}. En total **${items.length.toLocaleString("es-MX")}** registros. El siguiente disponible sería **${next}**.`,
                    `Tienes ${bits}. **${items.length.toLocaleString("es-MX")}** fichas en total. ¿Creamos **${next}**, importamos ahí o agregamos un registro?`,
                  ],
                  "catalog-list",
                );
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply);
          return;
        } catch {
          /* abort */
        }
      }
    }

    // Export Excel: sin atajo local → backend preparar/confirmar_exportacion_excel.

    // 1b0-origen-field. “áreas / personas del Inventario 5”.
    {
      const fieldAsk = detectOrigenFieldAsk(userText || text, items);
      if (fieldAsk) {
        try {
          const sourceRows = items.filter(
            (row) => String(row.origen ?? "").trim() === fieldAsk.origen,
          );
          if (!sourceRows.length) {
            const ask = `**${fieldAsk.origen}** aún no tiene registros para desglosar.`;
            recordTokenConsumption(null, userText || text, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }
          const fallbackReply = formatScopedListFieldReply(
            sourceRows,
            fieldAsk.field,
          );
          const overviewForField: ViewerOverview =
            fieldAsk.field === "area"
              ? "areas"
              : fieldAsk.field === "persona"
                ? "personas"
                : "estado";
          recordTokenConsumption(null, userText || text, fallbackReply);
          await ensureTypingPause(fallbackReply);
          finishBotReply(sessionId, botId, fallbackReply, {
            resultItems: sourceRows
              .slice(0, CHAT_SIDE_RESULT_CAP)
              .map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: overviewForField,
            viewerFocus: fieldAsk.origen,
          });
          return;
        } catch {
          /* abort */
        }
      }
    }

    // 1b0-origen. “qué hay en el Inventario 1” → listado por origen (no área).
    {
      const origenBrowse = detectOrigenBrowseAsk(userText || text, items);
      if (origenBrowse) {
        try {
          const { reply: localReply, shownRows } = buildOrigenBrowseReply(
            origenBrowse.origen,
            items,
            origenBrowse.limit,
          );
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          const origenRows = items.filter((row) =>
            origensMatch(String(row.origen ?? ""), origenBrowse.origen),
          );
          finishBotReply(sessionId, botId, localReply, {
            resultItems: (origenRows.length ? origenRows : shownRows)
              .slice(0, CHAT_SIDE_RESULT_CAP)
              .map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: origenRows.length || shownRows.length ? "full" : undefined,
            viewerFocus: origenBrowse.origen,
          });
          return;
        } catch {
          /* abort / nuevo mensaje */
        }
      }
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

    // 1b-copy-all. “mete al Inv 5 todos los registros de todos los demás” (antes que tag/persona).
    {
      const mergeAsk = detectBulkCopyAllOthersToInventarioAsk(
        intentText,
        listExistingOrigens(items),
      );
      if (mergeAsk) {
        try {
          const foldOrig = (o: string) =>
            o
              .toLowerCase()
              .normalize("NFD")
              .replace(/\p{M}/gu, "")
              .replace(/\s+/g, " ")
              .trim();
          const destFold = foldOrig(mergeAsk.dest);
          const destEtq = new Set(
            items
              .filter((row) => foldOrig(String(row.origen ?? "")) === destFold)
              .map((row) => String(row.etiqueta ?? "").trim().toLowerCase())
              .filter(Boolean),
          );
          const breakdown = mergeAsk.sources.map((source) => {
            const sourceFold = foldOrig(source);
            const rows = items.filter(
              (row) =>
                foldOrig(String(row.origen ?? "")) === sourceFold &&
                String(row.etiqueta ?? "").trim(),
            );
            const seen = new Set<string>();
            let willCopy = 0;
            let already = 0;
            for (const row of rows) {
              const key = String(row.etiqueta ?? "").trim().toLowerCase();
              if (!key || seen.has(key)) continue;
              seen.add(key);
              if (destEtq.has(key)) already += 1;
              else willCopy += 1;
            }
            return { source, total: seen.size, willCopy, already };
          });
          const totalCopy = breakdown.reduce((a, b) => a + b.willCopy, 0);
          const totalAlready = breakdown.reduce((a, b) => a + b.already, 0);
          const lines = breakdown
            .map(
              (b) =>
                `• **${b.source}**: ${b.total.toLocaleString("es-MX")} registros` +
                (b.willCopy
                  ? ` → copiaría **${b.willCopy.toLocaleString("es-MX")}** nuevos`
                  : " → nada nuevo") +
                (b.already
                  ? ` (omite ${b.already.toLocaleString("es-MX")} que ya están en el destino)`
                  : ""),
            )
            .join("\n");
          pendingOrigenMergeRef.current = {
            dest: mergeAsk.dest,
            sources: mergeAsk.sources,
            askedAt: Date.now(),
          };
          const ask =
            `Entendido: quieres concentrar en **${mergeAsk.dest}** todo lo que hay en los demás inventarios.\n\n` +
            `Voy a meter (copiar) registros desde:\n${lines}\n\n` +
            `En total serían **${totalCopy.toLocaleString("es-MX")}** altas nuevas` +
            (totalAlready
              ? ` y **${totalAlready.toLocaleString("es-MX")}** etiquetas se omitirían porque ya existen en **${mergeAsk.dest}**`
              : "") +
            `.\n\n` +
            `No borro los inventarios de origen: solo se **copian** al destino.\n\n` +
            `¿Lo confirmo?\n` +
            `Responde **sí** / **confirmo** para ejecutarlo, o **no** para cancelar.`;
          recordTokenConsumption(null, spokenText, ask);
          await ensureTypingPause(ask);
          finishBotReply(sessionId, botId, ask);
          return;
        } catch {
          /* abort */
        }
      }
    }

    // 1b-copy-person. “pasa todos sus registros al Inventario 4” (persona del hilo).
    {
      const personCopy = detectCopyPersonRecordsToInventarioAsk(
        intentText,
        listExistingOrigens(items),
      );
      if (personCopy) {
        try {
          pendingNewInventarioRef.current = null;
          const personName =
            resolvePersonFocus(intentText, items, chatHistory) ||
            (lastConcreteSideRef.current?.viewerOverview === "personTotal"
              ? String(lastConcreteSideRef.current.viewerFocus || "").trim()
              : "") ||
            (() => {
              for (let i = messagesRef.current.length - 1; i >= 0; i -= 1) {
                const m = messagesRef.current[i];
                if (m.from !== "bot") continue;
                if (m.viewerOverview === "personTotal" && m.viewerFocus) {
                  return String(m.viewerFocus).trim();
                }
              }
              return "";
            })();
          if (!personName) {
            const ask =
              `¿De **quién** paso los registros a **${personCopy.dest}**? Dime el nombre (ej. Héctor Silva).`;
            recordTokenConsumption(null, spokenText, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }

          const personRows = rowsForPersonName(items, personName);
          if (!personRows.length) {
            const ask = `No encontré registros de **${personName}** para pasar a **${personCopy.dest}**.`;
            recordTokenConsumption(null, spokenText, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }

          // Una fila por etiqueta (la más “actual”); omitir las que ya están en destino.
          const destFold = personCopy.dest
            .toLowerCase()
            .normalize("NFD")
            .replace(/\p{M}/gu, "")
            .replace(/\s+/g, " ")
            .trim();
          const destNum = inventarioNumber(personCopy.dest);
          const sameDest = (origen: string) => {
            const o = String(origen ?? "")
              .toLowerCase()
              .normalize("NFD")
              .replace(/\p{M}/gu, "")
              .replace(/\s+/g, " ")
              .trim();
            if (o === destFold) return true;
            if (destNum != null && inventarioNumber(origen) === destNum) {
              return true;
            }
            return false;
          };
          const destEtq = new Set(
            items
              .filter((r) => sameDest(String(r.origen ?? "")))
              .map((r) => String(r.etiqueta ?? "").trim().toLowerCase())
              .filter(Boolean),
          );
          const byEtq = new Map<string, InventarioRow>();
          const already: string[] = [];
          for (const row of personRows) {
            const et = String(row.etiqueta ?? "").trim();
            const key = et.toLowerCase();
            if (!key) continue;
            if (destEtq.has(key)) {
              if (!already.includes(et)) already.push(et);
              continue;
            }
            // No copiar desde el propio destino.
            if (sameDest(String(row.origen ?? ""))) continue;
            const prev = byEtq.get(key);
            if (!prev) {
              byEtq.set(key, row);
              continue;
            }
            // Preferir origen con mayor rango / más reciente
            const rank = (r: InventarioRow) =>
              origenCurrencyRank(String(r.origen ?? ""));
            const ts = (r: InventarioRow) =>
              Date.parse(String(r.updated_at || r.created_at || "")) || 0;
            if (
              rank(row) > rank(prev) ||
              (rank(row) === rank(prev) && ts(row) > ts(prev))
            ) {
              byEtq.set(key, row);
            }
          }
          const toCopy = [...byEtq.values()];
          if (!toCopy.length) {
            const ask =
              `No importé nada nuevo a **${personCopy.dest}**: ` +
              (already.length
                ? `las **${already.length}** etiquetas de **${personName}** ya estaban ahí` +
                  (already.length <= 10
                    ? ` (${already.join(", ")})`
                    : ` (ej. ${already.slice(0, 8).join(", ")}…)`)
                : `no había etiquetas que copiar`) +
              `.`;
            recordTokenConsumption(null, spokenText, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }

          const payload = toCopy.map((row) =>
            rowToNewInventarioItem(row, personCopy.dest),
          );
          setPendingChatImportSafe(null);
          const saved: InventarioRow[] = [];
          let lastError = "";
          const total = payload.length;
          for (let i = 0; i < payload.length; i += CHAT_IMPORT_CHUNK) {
            if (
              requestGen !== chatRequestGenRef.current ||
              controller.signal.aborted
            ) {
              throw new DOMException("Aborted", "AbortError");
            }
            const chunk = payload.slice(i, i + CHAT_IMPORT_CHUNK);
            const done = Math.min(i + chunk.length, total);
            const progressing = messagesRef.current.map((m) =>
              m.id === botId
                ? {
                    ...m,
                    text: `Copiando registros de ${personName} → ${personCopy.dest}… ${done}/${total}`,
                    at: Date.now(),
                    importProgress: {
                      label: `${personName} → ${personCopy.dest}`,
                      done,
                      total,
                    },
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
            }
          }

          const attempted = total;
          const inserted = saved.length;
          const notInserted = Math.max(0, attempted - inserted);

          if (!saved.length) {
            const failText =
              (already.length
                ? `**${already.length}** ya estaban en **${personCopy.dest}**` +
                  (already.length <= 10
                    ? ` (${already.join(", ")})`
                    : ` (ej. ${already.slice(0, 8).join(", ")}…)`) +
                  `.\n\n`
                : "") +
              (lastError ||
                `No se pudo copiar los **${attempted}** registros de **${personName}** a **${personCopy.dest}**.`);
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
            summary: `Copié ${saved.length} de ${personName} a ${personCopy.dest}`,
            totalBefore,
            totalAfter,
            count: saved.length,
            ids: saved
              .map((row) => row.id)
              .filter((id): id is number => id != null),
            chatId: sessionId,
            fact: `Copia ${personName}→${personCopy.dest}: +${saved.length}`,
          });

          const skipped = already.length;
          const skipNote = skipped
            ? `\n**${skipped}** ya estaban en **${personCopy.dest}** (misma etiqueta); no se duplicaron` +
              (skipped <= 10
                ? `: ${already.join(", ")}.`
                : ` (ej. ${already.slice(0, 8).join(", ")}…).`)
            : "";
          const failNote = notInserted
            ? `\n**${notInserted}** no se insertaron` +
              (lastError ? `: ${lastError}` : ".")
            : "";
          const localReply =
            `Listo: pasé **${saved.length.toLocaleString("es-MX")}** de **${attempted.toLocaleString("es-MX")}** registro` +
            `${attempted === 1 ? "" : "s"} de **${personName}** a **${personCopy.dest}**.` +
            `\nInventario: **${totalBefore.toLocaleString("es-MX")}** → **${totalAfter.toLocaleString("es-MX")}** registros.` +
            skipNote +
            failNote;
          recordTokenConsumption(null, spokenText, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: saved
              .slice(0, CHAT_SIDE_RESULT_CAP)
              .map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: undefined,
            viewerFocus: undefined,
          });
          return;
        } catch {
          /* abort */
        }
      }
    }

    // 1b-copy-tag-ask. “pásala a un inventario” sin destino → preguntar nuevo vs existente.
    {
      const needsDest = detectCopyEtiquetaNeedsDestAsk(
        intentText,
        listExistingOrigens(items),
        resolvedTurn.threadEtiquetas || [],
      );
      if (needsDest) {
        try {
          pendingCopyEtiquetaDestRef.current = {
            etiquetas: needsDest.etiquetas,
            askedAt: Date.now(),
          };
          const existing = listExistingOrigens(items);
          const next = nextInventarioName(existing);
          const shortList = existing.slice(0, 8).join(", ");
          const etLabel = needsDest.etiquetas.slice(0, 5).join(", ");
          const localReply =
            `¿A qué inventario paso **${etLabel}**?\n\n` +
            `• **Nuevo** → crearía **${next}**\n` +
            (shortList
              ? `• **Existente** → ${shortList}${existing.length > 8 ? "…" : ""}\n\n`
              : "\n") +
            `Dime p. ej. «a uno nuevo», «a Inventario 1» o «a excel 2».`;
          recordTokenConsumption(null, spokenText, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply);
          return;
        } catch {
          /* abort */
        }
      }
    }

    // 1b-copy-tag-dest. Respuesta corta tras preguntar destino (“a uno nuevo” / “csv 2”).
    {
      const pendingDest = pendingCopyEtiquetaDestRef.current;
      if (pendingDest && Date.now() - pendingDest.askedAt < 10 * 60 * 1000) {
        if (isNegativeChat(text)) {
          pendingCopyEtiquetaDestRef.current = null;
          const cancelReply =
            "De acuerdo, no muevo la etiqueta. Cuando quieras dime el inventario destino.";
          try {
            await ensureTypingPause(cancelReply);
            finishBotReply(sessionId, botId, cancelReply);
          } catch {
            /* abort */
          }
          return;
        }
        const existing = listExistingOrigens(items);
        const nPend = normalizeChatIntent(intentText);
        const wantsNew =
          /\b(a\s+)?(uno|una)\s+nuev[oa]\b/.test(nPend) ||
          /\binventario\s+nuev[oa]\b/.test(nPend) ||
          (/\b(nuevo|nueva)\b/.test(nPend) && /\binventarios?\b/.test(nPend));
        const dest = wantsNew
          ? nextInventarioName(existing)
          : matchOrigenFromPrompt(intentText, existing);
        if (dest) {
          // Reusa el flujo de copia con destino resuelto.
          (resolvedTurn as { threadEtiquetas?: string[] }).threadEtiquetas =
            pendingDest.etiquetas;
          pendingCopyEtiquetaDestRef.current = null;
          const tagCopy = {
            etiquetas: pendingDest.etiquetas,
            dest,
          };
          try {
            pendingNewInventarioRef.current = null;
            const picked = pickSourceRowsForEtiquetas(
              items,
              tagCopy.etiquetas,
              tagCopy.dest,
            );
            if (
              picked.missing.length &&
              !picked.found.length &&
              !picked.alreadyInDest.length
            ) {
              const ask = `No encontré la etiqueta **${tagCopy.etiquetas.join(", ")}** para agregarla a **${tagCopy.dest}**.`;
              recordTokenConsumption(null, spokenText, ask);
              await ensureTypingPause(ask);
              finishBotReply(sessionId, botId, ask);
              return;
            }
            if (!picked.found.length) {
              const ask =
                `La etiqueta **${tagCopy.etiquetas.join(", ")}** ya está en **${tagCopy.dest}**` +
                (picked.alreadyInDest.length
                  ? ` (${picked.alreadyInDest.join(", ")}). No la dupliqué.`
                  : `.`);
              recordTokenConsumption(null, spokenText, ask);
              await ensureTypingPause(ask);
              finishBotReply(sessionId, botId, ask);
              return;
            }
            const payload = picked.found.map((row) =>
              rowToNewInventarioItem(row, tagCopy.dest),
            );
            setPendingChatImportSafe(null);
            const saved: InventarioRow[] = [];
            let lastError = "";
            for (let i = 0; i < payload.length; i += CHAT_IMPORT_CHUNK) {
              if (
                requestGen !== chatRequestGenRef.current ||
                controller.signal.aborted
              ) {
                throw new DOMException("Aborted", "AbortError");
              }
              const chunk = payload.slice(i, i + CHAT_IMPORT_CHUNK);
              const result = await addInventarioBulkAction(chunk);
              if (result.success && result.data?.length) {
                saved.push(...result.data);
              } else if (result.error) {
                lastError = result.error;
                if (!saved.length) break;
              }
            }
            if (!saved.length) {
              const failText =
                lastError || `No se pudo agregar a **${tagCopy.dest}**.`;
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
              summary: `Agregué ${saved.length} a ${tagCopy.dest}`,
              totalBefore,
              totalAfter,
              count: saved.length,
              ids: saved
                .map((row) => row.id)
                .filter((id): id is number => id != null),
              chatId: sessionId,
              fact: `Copia etiqueta→${tagCopy.dest}: +${saved.length}`,
            });
            const listSaved = saved
              .map((r) => {
                const et = String(r.etiqueta ?? "").trim();
                const art = String(r.articulo ?? "").trim() || "—";
                return `• **${et}** · ${art}`;
              })
              .join("\n");
            const localReply =
              `Listo: agregué a **${tagCopy.dest}**:\n${listSaved}\n` +
              `Inventario: **${totalBefore.toLocaleString("es-MX")}** → **${totalAfter.toLocaleString("es-MX")}** registros.`;
            recordTokenConsumption(null, spokenText, localReply);
            await ensureTypingPause(localReply);
            finishBotReply(sessionId, botId, localReply, {
              resultItems: saved
                .slice(0, CHAT_SIDE_RESULT_CAP)
                .map((row) => rowToChatApiItem(row)),
              qr: [],
            });
            return;
          } catch {
            /* abort */
          }
          return;
        }
      }
    }

    // 1b-copy-tag. “agrega esa / etiqueta 283586 a Inventario 2” (usa hilo de arriba).
    {
      const tagCopy = detectCopyEtiquetasToInventarioAsk(
        intentText,
        listExistingOrigens(items),
        resolvedTurn.threadEtiquetas || [],
      );
      if (tagCopy) {
        try {
          pendingCopyEtiquetaDestRef.current = null;
          pendingNewInventarioRef.current = null;
          const picked = pickSourceRowsForEtiquetas(
            items,
            tagCopy.etiquetas,
            tagCopy.dest,
          );
          if (picked.missing.length && !picked.found.length && !picked.alreadyInDest.length) {
            const ask =
              `No encontré la etiqueta **${tagCopy.etiquetas.join(", ")}** para agregarla a **${tagCopy.dest}**.`;
            recordTokenConsumption(null, spokenText, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }
          if (!picked.found.length) {
            const ask =
              `La etiqueta **${tagCopy.etiquetas.join(", ")}** ya está en **${tagCopy.dest}**` +
              (picked.alreadyInDest.length
                ? ` (${picked.alreadyInDest.join(", ")}). No la dupliqué.`
                : `.`);
            recordTokenConsumption(null, spokenText, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask, {
              resultItems: items
                .filter((r) =>
                  tagCopy.etiquetas.some(
                    (e) =>
                      String(r.etiqueta ?? "").trim().toLowerCase() ===
                        e.toLowerCase() &&
                      String(r.origen ?? "").trim() === tagCopy.dest,
                  ),
                )
                .slice(0, 20)
                .map((row) => rowToChatApiItem(row)),
              qr: [],
            });
            return;
          }

          const payload = picked.found.map((row) =>
            rowToNewInventarioItem(row, tagCopy.dest),
          );
          setPendingChatImportSafe(null);
          const saved: InventarioRow[] = [];
          let lastError = "";
          for (let i = 0; i < payload.length; i += CHAT_IMPORT_CHUNK) {
            if (
              requestGen !== chatRequestGenRef.current ||
              controller.signal.aborted
            ) {
              throw new DOMException("Aborted", "AbortError");
            }
            const chunk = payload.slice(i, i + CHAT_IMPORT_CHUNK);
            const result = await addInventarioBulkAction(chunk);
            if (result.success && result.data?.length) {
              saved.push(...result.data);
            } else if (result.error) {
              lastError = result.error;
              if (!saved.length) break;
            }
          }
          if (!saved.length) {
            const failText =
              lastError || `No se pudo agregar a **${tagCopy.dest}**.`;
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
            summary: `Agregué ${saved.length} a ${tagCopy.dest}`,
            totalBefore,
            totalAfter,
            count: saved.length,
            ids: saved
              .map((row) => row.id)
              .filter((id): id is number => id != null),
            chatId: sessionId,
            fact: `Copia etiqueta→${tagCopy.dest}: +${saved.length}`,
          });
          const listSaved = saved
            .map((r) => {
              const et = String(r.etiqueta ?? "").trim();
              const art = String(r.articulo ?? "").trim() || "—";
              const from = String(
                picked.found.find(
                  (f) =>
                    String(f.etiqueta ?? "").trim().toLowerCase() ===
                    et.toLowerCase(),
                )?.origen ?? "",
              ).trim();
              return `• **${et}** · ${art}${from ? ` (desde **${from}**)` : ""}`;
            })
            .join("\n");
          const alreadyNote = picked.alreadyInDest.length
            ? `\n\nYa estaban en **${tagCopy.dest}** (no se duplicaron): ${picked.alreadyInDest.join(", ")}.`
            : "";
          const missingNote = picked.missing.length
            ? `\n\nNo encontré: ${picked.missing.join(", ")}.`
            : "";
          const localReply =
            `Listo: agregué a **${tagCopy.dest}**:\n${listSaved}\n` +
            `Inventario: **${totalBefore.toLocaleString("es-MX")}** → **${totalAfter.toLocaleString("es-MX")}** registros.` +
            alreadyNote +
            missingNote;
          recordTokenConsumption(null, spokenText, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: saved
              .slice(0, CHAT_SIDE_RESULT_CAP)
              .map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: undefined,
            viewerFocus: undefined,
          });
          return;
        } catch {
          /* abort */
        }
      }
    }

    // 1b-copy. “Pasa todo Inventario 1 a Inventario 3; si ya existe, avísame”.
    // También: “omite esa e importa el resto Inv2 → Inv3”.
    {
      const bulkCopy = detectBulkCopyBetweenInventariosAsk(
        intentText,
        listExistingOrigens(items),
      );
      if (bulkCopy) {
        try {
          pendingNewInventarioRef.current = null;
          const foldOrig = (o: string) =>
            o
              .toLowerCase()
              .normalize("NFD")
              .replace(/\p{M}/gu, "")
              .replace(/\s+/g, " ")
              .trim();
          const sourceFold = foldOrig(bulkCopy.source);
          const destFold = foldOrig(bulkCopy.dest);
          const excludeSet = new Set(
            detectExcludedEtiquetasAsk(
              intentText,
              resolvedTurn.threadEtiquetas || [],
            ).map((e) => e.trim().toLowerCase()),
          );

          const sourceRows = items.filter(
            (row) =>
              foldOrig(String(row.origen ?? "")) === sourceFold &&
              String(row.etiqueta ?? "").trim(),
          );
          if (!sourceRows.length) {
            const ask =
              `No hay registros en **${bulkCopy.source}** para pasar a **${bulkCopy.dest}**.`;
            recordTokenConsumption(null, spokenText, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }

          const destRows = items.filter(
            (row) => foldOrig(String(row.origen ?? "")) === destFold,
          );
          // Solo ETIQUETA es irrepetible dentro del mismo origen.
          // Serie/marca/etc. sí pueden repetirse (lotes).
          const destEtq = new Set(
            destRows
              .map((row) => String(row.etiqueta ?? "").trim().toLowerCase())
              .filter(Boolean),
          );
          const already: InventarioRow[] = [];
          const omitted: InventarioRow[] = [];
          const toCopy: InventarioRow[] = [];
          const seen = new Set<string>();
          for (const row of sourceRows) {
            const key = String(row.etiqueta ?? "").trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            if (excludeSet.has(key)) {
              omitted.push(row);
              continue;
            }
            if (destEtq.has(key)) {
              already.push(row);
            } else {
              toCopy.push(row);
            }
          }

          if (!toCopy.length) {
            const sample = [...omitted, ...already]
              .slice(0, 12)
              .map((r) => {
                const et = String(r.etiqueta ?? "").trim() || "—";
                const art = String(r.articulo ?? "").trim() || "—";
                const why = excludeSet.has(et.toLowerCase())
                  ? "omitida a pedido"
                  : `ya estaba en **${bulkCopy.dest}**`;
                return `• **${et}** · ${art} — ${why}; no se importó`;
              });
            const ask =
              `No importé nada nuevo a **${bulkCopy.dest}**` +
              (omitted.length
                ? ` (omití **${omitted.length}** a pedido)`
                : "") +
              (already.length
                ? `; **${already.length}** ya existían (misma etiqueta)`
                : "") +
              `.\n\n` +
              (sample.length ? `${sample.join("\n")}` : "");
            recordTokenConsumption(null, spokenText, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask, {
              resultItems: [...omitted, ...already]
                .slice(0, CHAT_SIDE_RESULT_CAP)
                .map((row) => rowToChatApiItem(row)),
              qr: [],
            });
            return;
          }

          const payload = toCopy.map((row) =>
            rowToNewInventarioItem(row, bulkCopy.dest),
          );
          // Importa y luego, si hay “ya existían”, el mensaje de import no las lista:
          // hacemos el import y añadimos nota en un segundo finish… runBulkChatImport
          // ya cierra el bot. Pasamos detalle vía sourceLabel + después no podemos.
          // Solución: enriquecer con un reply custom tras import — refactor mínimo:
          // ejecutar import y construir reply propio.
          setPendingChatImportSafe(null);
          const saved: InventarioRow[] = [];
          let lastError = "";
          const total = payload.length;
          for (let i = 0; i < payload.length; i += CHAT_IMPORT_CHUNK) {
            if (
              requestGen !== chatRequestGenRef.current ||
              controller.signal.aborted
            ) {
              throw new DOMException("Aborted", "AbortError");
            }
            const chunk = payload.slice(i, i + CHAT_IMPORT_CHUNK);
            const done = Math.min(i + chunk.length, total);
            const progressing = messagesRef.current.map((m) =>
              m.id === botId
                ? {
                    ...m,
                    text: `Copiando ${bulkCopy.source} → ${bulkCopy.dest}… ${done}/${total}`,
                    at: Date.now(),
                    importProgress: {
                      label: `${bulkCopy.source} → ${bulkCopy.dest}`,
                      done,
                      total,
                    },
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
              // No abortar el lote entero: seguir con el resto (conflictos = saltar).
            }
          }

          if (!saved.length) {
            const failText = lastError
              ? lastError
              : `No quedó nada nuevo que importar a **${bulkCopy.dest}**` +
                (omitted.length
                  ? ` (omití **${omitted
                      .map((r) => String(r.etiqueta ?? "").trim())
                      .filter(Boolean)
                      .slice(0, 5)
                      .join(", ")}**)`
                  : "") +
                (already.length
                  ? `; **${already.length}** ya estaban (misma etiqueta)`
                  : "") +
                `.`;
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
            summary: `Copié ${saved.length} de ${bulkCopy.source} a ${bulkCopy.dest}`,
            totalBefore,
            totalAfter,
            count: saved.length,
            ids: saved
              .map((row) => row.id)
              .filter((id): id is number => id != null),
            chatId: sessionId,
            fact: `Copia ${bulkCopy.source}→${bulkCopy.dest}: +${saved.length}`,
          });

          const importedSample = saved
            .slice(0, 10)
            .map((r) => {
              const et = String(r.etiqueta ?? "").trim() || "—";
              const art = String(r.articulo ?? "").trim() || "—";
              return `• **${et}** · ${art}`;
            })
            .join("\n");
          const importedNote =
            `\n\n**Importadas a ${bulkCopy.dest} (${saved.length.toLocaleString("es-MX")})**:\n` +
            importedSample +
            (saved.length > 10
              ? `\n…y ${(saved.length - 10).toLocaleString("es-MX")} más.`
              : "");

          const omittedNote = omitted.length
            ? `\n\n**Omitidas a pedido (${omitted.length})** — no se importaron:\n` +
              omitted
                .slice(0, 10)
                .map((r) => {
                  const et = String(r.etiqueta ?? "").trim() || "—";
                  const art = String(r.articulo ?? "").trim() || "—";
                  return `• **${et}** · ${art}`;
                })
                .join("\n")
            : "";

          const alreadyNote = already.length
            ? `\n\n**No se duplicaron (${already.length})** — ya existían en **${bulkCopy.dest}** (misma etiqueta):\n` +
              already
                .slice(0, 15)
                .map((r) => {
                  const et = String(r.etiqueta ?? "").trim() || "—";
                  const art = String(r.articulo ?? "").trim() || "—";
                  return `• **${et}** · ${art} — ya estaba; no se volvió a importar`;
                })
                .join("\n") +
              (already.length > 15
                ? `\n…y ${already.length - 15} más.`
                : "")
            : omitted.length
              ? ""
              : `\n\nNinguna etiqueta de **${bulkCopy.source}** estaba ya en **${bulkCopy.dest}**.`;

          const bulkFallback = [
            `mode=bulk_copy`,
            `count=${saved.length}`,
            `source=${bulkCopy.source}`,
            `dest=${bulkCopy.dest}`,
            `total_before=${totalBefore}`,
            `total_after=${totalAfter}`,
            `omitted=${omitted.length}`,
            `already=${already.length}`,
          ].join("; ");
          let localReply = bulkFallback;
          try {
            const polished = await polishInventoryReply({
              userText: spokenText,
              kind: "import_done",
              fallback: bulkFallback,
              facts: {
                mode: "bulk_copy",
                count: saved.length,
                source: bulkCopy.source,
                dest: bulkCopy.dest,
                total_before: totalBefore,
                total_after: totalAfter,
                omitted: omitted.length,
                already: already.length,
                notes: {
                  imported: importedNote,
                  omitted: omittedNote,
                  already: alreadyNote,
                },
              },
              sessionId,
            });
            localReply = polished.reply;
          } catch {
            /* hechos */
          }

          recordTokenConsumption(null, spokenText, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: saved
              .slice(0, CHAT_SIDE_RESULT_CAP)
              .map((row) => rowToChatApiItem(row)),
            qr: [],
          });
          return;
        } catch {
          /* abort */
        }
      }
    }

    // 1b-dup. Etiquetas duplicadas (antes del relleno de inventario pendiente).
    {
      const dupAsk = detectDuplicateEtiquetasAsk(
        intentText,
        listExistingOrigens(items),
      );
      if (dupAsk) {
        try {
          // Si el usuario cambió a una consulta, no seguir pidiendo “qué meter”.
          pendingNewInventarioRef.current = null;
          const groups = findDuplicateEtiquetas(items, dupAsk);
          const localReply = formatDuplicateEtiquetasReply(dupAsk, groups);
          const sideRows = groups.flatMap((g) => g.rows).slice(0, 80);
          recordTokenConsumption(null, spokenText, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: sideRows.map((row) => rowToChatApiItem(row)),
            qr: [],
          });
          return;
        } catch {
          /* abort */
        }
      }
    }

    // 1b-new. Crear inventario / rellenar el pendiente (antes de “recientes”).
    {
      const prompt = intentText;
      const origensNow = listExistingOrigens(items);
      const createAsk = detectCreateInventarioAsk(prompt, origensNow);
      let pending = pendingNewInventarioRef.current;

      // Consultas (duplicados, comparar, listar…) cancelan el pending de relleno.
      if (pending && looksLikeNonFillInventarioAsk(prompt) && !createAsk) {
        pendingNewInventarioRef.current = null;
        pending = null;
      }

      if (createAsk) {
        pendingNewInventarioRef.current = {
          name: createAsk.name,
          askedAt: Date.now(),
        };
        pending = pendingNewInventarioRef.current;
      }

      // Solo recuperar pending si el bot pidió explícitamente qué meter / preparó inventario.
      if (!pending) {
        for (let i = messagesRef.current.length - 1; i >= 0 && i >= messagesRef.current.length - 6; i -= 1) {
          const msg = messagesRef.current[i];
          if (msg.from !== "bot") continue;
          const botText = String(msg.text || "");
          if (
            !/preparo\s+\*\*|necesito saber qu[eé] meter|puedo meterle registros|queda preparado/i.test(
              botText,
            )
          ) {
            continue;
          }
          const m = botText.match(/\*\*(Inventario\s+\d+)\*\*/i);
          if (m?.[1]) {
            pending = { name: m[1].replace(/\s+/g, " ").trim(), askedAt: Date.now() };
            pendingNewInventarioRef.current = pending;
            break;
          }
        }
      }

      // “al nuevo inventario que te pedí” sin número → usar pendiente o el siguiente.
      if (
        !pending &&
        /\b(nuevo\s+inventario|inventario\s+nuevo)\b/.test(
          normalizeChatIntent(prompt),
        ) &&
        /\b(mete|meter|pon|poner|pasa|pasar|copia|copiar|agrega|agregar)\b/.test(
          normalizeChatIntent(prompt),
        )
      ) {
        const named = matchOrigenFromPrompt(prompt, origensNow);
        pending = {
          name: named || nextInventarioName(origensNow),
          askedAt: Date.now(),
        };
        pendingNewInventarioRef.current = pending;
      }

      const fill =
        pending != null
          ? detectFillNewInventarioAsk(prompt, pending, origensNow)
          : undefined;

      // Crear + “nuevo registro / opciones a llenar” → inventario listo + modal de alta.
      const wantsNewRecordForm =
        /\b(nuevo\s+registro|subir(le)?\s+(un\s+)?registro|opciones\s+a\s+llenar|como\s+crear|alta\s+(de\s+)?registro|llenar\s+(el\s+)?formulario)\b/.test(
          normalizeChatIntent(prompt),
        );

      if (createAsk && wantsNewRecordForm) {
        try {
          pendingNewInventarioRef.current = {
            name: createAsk.name,
            emptyOk: true,
            askedAt: Date.now(),
          };
          setAddModalDestino(createAsk.name);
          setIsAddModalOpen(true);
          const ask =
            `Listo: **${createAsk.name}** queda preparado. Te abrí el formulario de **nuevo registro** con destino **${createAsk.name}**.\n\n` +
            `Campos a llenar:\n` +
            `- **Etiqueta** (obligatoria)\n` +
            `- **Artículo**, marca, modelo, serie\n` +
            `- **Área** y **persona**\n` +
            `- **Cantidad**, estado, observaciones\n\n` +
            `También puedes escanear un **QR** o importar un Excel. Al guardar, el origen será **${createAsk.name}**.`;
          recordTokenConsumption(null, prompt, ask);
          await ensureTypingPause(ask);
          finishBotReply(sessionId, botId, ask);
          return;
        } catch {
          /* abort */
        }
      }

      // Creación sin contenido en el mismo mensaje → preguntar qué meter.
      if (createAsk && (!fill || fill.kind === "unclear")) {
        try {
          const ask = createAsk.alreadyExists
            ? `**${createAsk.name}** ya existe. Puedo meterle registros ahora.\n\n` +
              `Dime etiquetas, **todo** otro inventario, o **vacío** si no quieres agregar nada.`
            : buildCreateInventarioAskReply(createAsk.name, origensNow);
          recordTokenConsumption(null, prompt, ask);
          await ensureTypingPause(ask);
          finishBotReply(sessionId, botId, ask);
          return;
        } catch {
          /* abort */
        }
      }

      if (pending && fill) {
        const dest = pending.name;
        try {
          if (fill.kind === "empty") {
            pendingNewInventarioRef.current = {
              ...pending,
              emptyOk: true,
              askedAt: Date.now(),
            };
            const ask =
              `Listo: **${dest}** queda preparado **vacío**. ` +
              `Cuando quieras, mándame etiquetas o “pasa todo Inventario N” y las meto ahí.`;
            recordTokenConsumption(null, prompt, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }

          if (fill.kind === "unclear") {
            const ask =
              `Para **${dest}** necesito saber qué meter: etiquetas (ej. \`283586\`), ` +
              `“pasa todo Inventario 1”, o **vacío**.`;
            recordTokenConsumption(null, prompt, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }

          let sourceRows: InventarioRow[] = [];
          let missing: string[] = [];
          let alreadyInDest: string[] = [];

          if (fill.kind === "copy_origen") {
            sourceRows = items.filter(
              (row) =>
                String(row.origen ?? "").trim() === fill.source &&
                String(row.etiqueta ?? "").trim(),
            );
            if (!sourceRows.length) {
              const ask =
                `No encontré registros en **${fill.source}** para copiar a **${dest}**. ` +
                `Prueba con otro inventario o con etiquetas sueltas.`;
              recordTokenConsumption(null, prompt, ask);
              await ensureTypingPause(ask);
              finishBotReply(sessionId, botId, ask);
              return;
            }
          } else if (fill.kind === "copy_etiquetas") {
            const picked = pickSourceRowsForEtiquetas(
              items,
              fill.etiquetas,
              dest,
            );
            sourceRows = picked.found;
            missing = picked.missing;
            alreadyInDest = picked.alreadyInDest;
            if (!sourceRows.length) {
              const bits: string[] = [];
              if (missing.length) {
                bits.push(
                  `no encontré ${missing.map((e) => `**${e}**`).join(", ")}`,
                );
              }
              if (alreadyInDest.length) {
                bits.push(
                  `ya estaban en **${dest}**: ${alreadyInDest
                    .map((e) => `**${e}**`)
                    .join(", ")}`,
                );
              }
              const ask =
                `No pude meter nada a **${dest}**` +
                (bits.length ? ` (${bits.join("; ")})` : "") +
                `. ¿Otra etiqueta o copiar un inventario completo?`;
              recordTokenConsumption(null, prompt, ask);
              await ensureTypingPause(ask);
              finishBotReply(sessionId, botId, ask);
              return;
            }
          }

          const payload = sourceRows.map((row) =>
            rowToNewInventarioItem(row, dest),
          );
          const fromOrigens = [
            ...new Set(
              sourceRows
                .map((row) => String(row.origen ?? "").trim())
                .filter((o) => o && o !== dest),
            ),
          ];
          const fromLabel =
            fromOrigens.length === 1
              ? fromOrigens[0]
              : fromOrigens.length > 1
                ? fromOrigens.join(", ")
                : String(sourceRows[0]?.origen ?? "").trim() || "inventario origen";
          await runBulkChatImport(payload, fromLabel, {
            destLabel: dest,
            mode: "copy",
            etiquetas: sourceRows
              .map((row) => String(row.etiqueta ?? "").trim())
              .filter(Boolean),
          });
          pendingNewInventarioRef.current = {
            name: dest,
            askedAt: Date.now(),
          };
          if (missing.length || alreadyInDest.length) {
            // runBulkChatImport already finished the bot reply; append note via soft follow-up is hard.
            // The import reply is enough; missing handled only when nothing saved above.
          }
          return;
        } catch {
          /* abort / nuevo mensaje */
        }
      }
    }

    // 1b0--. “esos 10 / últimos: ¿en qué áreas/personas?” → agregar del listado.
    {
      const fieldAsk = detectScopedListFieldAsk(userText || text);
      if (fieldAsk && items.length) {
        try {
          let sourceRows = contextRowsForDelete();
          // Si no hay listado en el hilo pero hablan de “últimos”, usa los 10 recientes.
          if (
            !sourceRows.length &&
            /\b(ultimos?|recientes?)\b/i.test(userText || text)
          ) {
            sourceRows = getRecentInventoryRows(items, 10, false);
          }
          if (!sourceRows.length) {
            const ask =
              `Para decirte en qué **${
                fieldAsk.field === "area"
                  ? "áreas"
                  : fieldAsk.field === "persona"
                    ? "personas"
                    : fieldAsk.field === "origen"
                      ? "inventarios"
                      : "estados"
              }** están, necesito el listado de arriba. Pide primero «últimos registros» (o una búsqueda) y vuelve a preguntar.`;
            recordTokenConsumption(null, spokenText, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }
          const fallbackReply = formatScopedListFieldReply(
            sourceRows,
            fieldAsk.field,
          );
          const groups = aggregateFieldCounts(sourceRows, fieldAsk.field);
          const polished = await polishInventoryReply({
            userText: userText || text,
            sessionId: sessionId,
            kind: "scoped_list_field",
            threadHint:
              resolvedTurn.threadHint ||
              `Hilo: áreas/campos del listado actual (${sourceRows.length}).`,
            fallback: fallbackReply,
            facts: {
              field: fieldAsk.field,
              list_count: sourceRows.length,
              groups: groups.slice(0, 10).map((g) => ({
                name: g.name,
                count: g.count,
                samples: g.samples,
              })),
              plantilla_sugerida: fallbackReply,
              tono: "claro_conversacional",
            },
          });
          const overviewForField: ViewerOverview =
            fieldAsk.field === "area"
              ? "areas"
              : fieldAsk.field === "persona"
                ? "personas"
                : fieldAsk.field === "estado"
                  ? "estado"
                  : "recent";
          recordTokenConsumption(null, userText || text, polished.reply);
          await ensureTypingPause(polished.reply);
          finishBotReply(sessionId, botId, polished.reply, {
            resultItems: sourceRows
              .slice(0, CHAT_SIDE_RESULT_CAP)
              .map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: overviewForField,
            followUps: polished.followUps,
          });
          return;
        } catch {
          /* abort */
        }
      }
    }

    // 1b0-. “¿es de los últimos?” → sí/no del registro del hilo (no listar 10).
    {
      if (detectIsAmongRecentAsk(userText || text) && items.length) {
        try {
          const focusEt =
            resolveThreadFocusEtiqueta(
              userText || text,
              messagesRef.current,
              lastConcreteSideRef.current?.resultItems || null,
            ) || "";
          if (!focusEt) {
            const ask =
              `¿Te refieres a alguna etiqueta en concreto? Dime el código (ej. **272949**) o pídeme primero el registro, y te digo si está entre los últimos.`;
            recordTokenConsumption(null, spokenText, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }
          const limit = 10;
          const recent = getRecentInventoryRows(items, limit, false);
          const focusKey = focusEt.toLowerCase();
          const idx = recent.findIndex(
            (r) =>
              String(r.etiqueta ?? "").trim().toLowerCase() === focusKey,
          );
          const focusRows = items.filter(
            (r) =>
              String(r.etiqueta ?? "").trim().toLowerCase() === focusKey,
          );
          const sample = focusRows[0];
          const art = String(sample?.articulo ?? "").trim();
          const label = art ? `**${focusEt}** (${art})` : `**${focusEt}**`;
          const topBrief = recent
            .slice(0, 3)
            .map((r) => {
              const et = String(r.etiqueta ?? "").trim() || "S/E";
              const a = String(r.articulo ?? "").trim() || "—";
              return `**${et}** (${a})`;
            })
            .join(", ");
          const fallbackReply =
            idx >= 0
              ? pickChatVariant(
                  [
                    `Sí: ${label} está entre los **${limit}** más recientes (lugar **${idx + 1}**). ¿Quieres ver el listado completo o generar QR?`,
                    `Correcto: ${label} sí aparece en los últimos **${limit}** movimientos (posición **${idx + 1}**). ¿Seguimos con otra consulta?`,
                    `Así es: ${label} forma parte de los registros más nuevos (puesto **${idx + 1}** de ${limit}). ¿Lo abro en el panel?`,
                  ],
                  focusEt,
                )
              : pickChatVariant(
                  [
                    `No: ${label} **no** está entre los **${limit}** registros más recientes. Ahora encabezan ${topBrief}. ¿Quieres que te muestre esos ${limit} o seguimos con ${focusEt}?`,
                    `No coincide: ${label} no sale en los últimos **${limit}**. Los más nuevos empiezan con ${topBrief}. ¿Vemos el listado reciente o algo más de esta etiqueta?`,
                    `Esa etiqueta no está en el top **${limit}** reciente. ${label} es del hilo anterior; los movimientos más nuevos son ${topBrief}. ¿Qué hacemos?`,
                  ],
                  focusEt,
                );
          const polished = await polishInventoryReply({
            userText: userText || text,
            sessionId: sessionId,
            kind: "among_recent",
            threadHint:
              resolvedTurn.threadHint ||
              `Hilo: pregunta si ${focusEt} está entre los últimos ${limit}.`,
            fallback: fallbackReply,
            facts: {
              etiqueta: focusEt,
              articulo: art,
              among_recent: idx >= 0,
              position: idx >= 0 ? idx + 1 : null,
              limit,
              top_sample: recent.slice(0, 3).map((r) => ({
                etiqueta: String(r.etiqueta ?? "").trim(),
                articulo: String(r.articulo ?? "").trim(),
              })),
              plantilla_sugerida: fallbackReply,
              tono: "claro_conversacional",
            },
          });
          recordTokenConsumption(null, userText || text, polished.reply);
          await ensureTypingPause(polished.reply);
          finishBotReply(sessionId, botId, polished.reply, {
            resultItems: (idx >= 0 ? [recent[idx]] : focusRows.length ? focusRows : recent)
              .slice(0, CHAT_SIDE_RESULT_CAP)
              .map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: idx >= 0 ? "recent" : undefined,
            followUps: polished.followUps,
          });
          return;
        } catch {
          /* abort */
        }
      }
    }

    // 1b0-excl. “que no sea recientes” / “no los últimos” → otro N del hilo.
    {
      const excludeAsk = detectExcludeRecentRefineAsk(userText || text);
      if (excludeAsk && items.length) {
        try {
          const prevCount =
            lastConcreteSideRef.current?.resultItems?.length ||
            parseRequestedCount(
              [...messagesRef.current]
                .reverse()
                .find((m) => m.from === "user" && m.id !== userId)?.text ||
                "",
            ) ||
            excludeAsk.limit;
          const limit = Math.max(
            1,
            Math.min(50, excludeAsk.limit || Number(prevCount) || 10),
          );
          const excludeN = Math.max(
            limit,
            Number(lastConcreteSideRef.current?.resultItems?.length) || 10,
          );
          const rows = getNonRecentInventoryRows(items, limit, excludeN);
          const fallbackReply = buildNonRecentRecordsReply(
            rows,
            { limit },
            { userText: userText || text },
          );
          const polished = await polishInventoryReply({
            userText: userText || text,
            sessionId: sessionId,
            kind: "recent",
            threadHint:
              (resolvedTurn.threadHint || "") +
              " | Usuario pidió registros que NO sean los más recientes; respeta el hilo.",
            fallback: fallbackReply,
            facts: {
              limit,
              exclude_recent: excludeN,
              count: rows.length,
              samples: rows.slice(0, 5).map((row) => ({
                etiqueta: String(row.etiqueta ?? "").trim(),
                articulo: String(row.articulo ?? "").trim(),
                area: String(row.area ?? "").trim(),
                persona: String(row.persona ?? "").trim(),
              })),
            },
          });
          recordTokenConsumption(null, userText || text, polished.reply);
          await ensureTypingPause(polished.reply);
          finishBotReply(sessionId, botId, polished.reply, {
            resultItems: rows.map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: limit === 1 ? undefined : "recent",
            followUps: polished.followUps,
          });
          return;
        } catch {
          /* abort / nuevo mensaje */
        }
      }
    }

    // 1b0. Último / recientes (global) — antes del follow-up de área/persona.
    {
      const recentAsk = detectRecentRecordsAsk(userText || text);
      if (recentAsk && items.length) {
        try {
          const rows = getRecentInventoryRows(
            items,
            recentAsk.limit,
            recentAsk.soloHoy,
          );
          const fallbackReply = buildRecentRecordsReply(rows, recentAsk, {
            userText: userText || text,
          });
          const polished = await polishInventoryReply({
            userText: userText || text,
            sessionId: sessionId,
            kind: "recent",
            threadHint: resolvedTurn.threadHint || "",
            fallback: fallbackReply,
            facts: {
              limit: recentAsk.limit,
              solo_hoy: recentAsk.soloHoy,
              count: rows.length,
              samples: rows.slice(0, 5).map((row) => ({
                etiqueta: String(row.etiqueta ?? "").trim(),
                articulo: String(row.articulo ?? "").trim(),
                area: String(row.area ?? "").trim(),
                persona: String(row.persona ?? "").trim(),
              })),
            },
          });
          recordTokenConsumption(null, userText || text, polished.reply);
          await ensureTypingPause(polished.reply);
          finishBotReply(sessionId, botId, polished.reply, {
            resultItems: rows.map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: recentAsk.limit === 1 ? undefined : "recent",
            followUps: polished.followUps,
          });
          return;
        } catch {
          /* abort / nuevo mensaje */
        }
      }
    }

    // 1b1-origen. “etiqueta 283586 en qué inventarios / de dónde venía”.
    {
      const origenAsk = detectEtiquetaOrigenAsk(
        intentText || userText || text,
        items,
      );
      if (origenAsk) {
        try {
          const localReply = buildEtiquetaOrigenReply(origenAsk, items);
          recordTokenConsumption(null, spokenText, localReply);
          await ensureTypingPause(localReply);
          const byOrigen = new Map<string, InventarioRow>();
          for (const row of origenAsk.rows) {
            const key = String(row.origen ?? "").trim() || "Sin origen";
            if (!byOrigen.has(key)) byOrigen.set(key, row);
          }
          const sideRows = [...byOrigen.values()].sort(
            (a, b) =>
              origenCurrencyRank(String(a.origen ?? "")) -
              origenCurrencyRank(String(b.origen ?? "")),
          );
          finishBotReply(sessionId, botId, localReply, {
            resultItems: sideRows
              .slice(0, 80)
              .map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: undefined,
            viewerFocus: undefined,
          });
          return;
        } catch {
          /* abort */
        }
      }
    }

    // 1b1-origen-persona. “en qué inventarios está María Elena / esa persona”.
    {
      const personInvAsk = detectPersonInventariosAsk(
        intentText || userText || text,
        items,
        chatHistory,
      );
      if (personInvAsk) {
        try {
          const localReply = buildPersonInventariosReply(personInvAsk);
          recordTokenConsumption(null, spokenText, localReply);
          await ensureTypingPause(localReply);
          const byOrigen = new Map<string, InventarioRow>();
          for (const row of personInvAsk.rows) {
            const key = String(row.origen ?? "").trim() || "Sin origen";
            if (!byOrigen.has(key)) byOrigen.set(key, row);
          }
          const sideRows = [...byOrigen.values()].sort(
            (a, b) =>
              origenCurrencyRank(String(a.origen ?? "")) -
              origenCurrencyRank(String(b.origen ?? "")),
          );
          finishBotReply(sessionId, botId, localReply, {
            resultItems: (sideRows.length
              ? sideRows
              : personInvAsk.rows.slice(0, 80)
            ).map((row) => rowToChatApiItem(row)),
            qr: [],
            viewerOverview: sideRows.length ? undefined : "personTotal",
            viewerFocus: personInvAsk.person,
          });
          return;
        } catch {
          /* abort */
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

    // 1b1. Diff real entre inventarios (antes de áreas: “comparar” ≠ “Compras”).
    {
      const origens = listExistingOrigens(items);
      const scopedCompare = detectCompareScopedListAsk(intentText, origens);
      if (scopedCompare) {
        try {
          const priorItems =
            lastConcreteSideRef.current?.resultItems ||
            [...messagesRef.current]
              .reverse()
              .find(
                (m) =>
                  m.from === "bot" &&
                  Array.isArray(m.resultItems) &&
                  m.resultItems.length > 0,
              )?.resultItems ||
            [];
          const sourceRows: InventarioRow[] = [];
          const seenEt = new Set<string>();
          for (const it of priorItems) {
            const et = String(it.etiqueta ?? "").trim().toLowerCase();
            if (!et || seenEt.has(et)) continue;
            seenEt.add(et);
            const hit =
              items.find(
                (r) =>
                  Number(r.id) === Number(it.id) &&
                  it.id != null &&
                  !Number.isNaN(Number(it.id)),
              ) ||
              items.find(
                (r) =>
                  String(r.etiqueta ?? "").trim().toLowerCase() === et &&
                  (!it.origen ||
                    String(r.origen ?? "").trim() === String(it.origen).trim()),
              ) ||
              items.find(
                (r) => String(r.etiqueta ?? "").trim().toLowerCase() === et,
              );
            if (hit) sourceRows.push(hit);
          }
          if (!sourceRows.length) {
            const ask =
              `Para comparar **esta consulta** con **${scopedCompare.dest}** necesito el listado de arriba. ` +
              `Pide primero unos registros (p. ej. últimos registros o una persona) y luego dime ` +
              `«compáralos con ${scopedCompare.dest}».`;
            recordTokenConsumption(null, spokenText, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }
          const diff = diffRowsAgainstInventario(
            sourceRows,
            scopedCompare.dest,
            items,
            "este listado",
          );
          const fallbackReply = formatInventarioDiffReply(diff);
          const polished = await polishInventoryReply({
            userText: userText || text,
            sessionId: sessionId,
            kind: "compare_scoped",
            threadHint: resolvedTurn.threadHint || "",
            fallback: fallbackReply,
            facts: {
              scope: "listado_actual",
              list_count: sourceRows.length,
              dest: scopedCompare.dest,
              iguales: diff.same.length,
              faltan_en_destino: diff.onlyLeft.length,
              sobran: 0,
              cambiaron: new Set(
                diff.changed.map((c) => c.etiqueta.toLowerCase()),
              ).size,
              veredicto:
                !diff.onlyLeft.length && !diff.changed.length
                  ? "todas_coinciden"
                  : diff.onlyLeft.length && !diff.same.length
                    ? "ninguna_en_destino"
                    : "parcial",
              tono: "claro_conversacional",
              plantilla_sugerida: fallbackReply,
              faltan_sample: diff.onlyLeft.slice(0, 5).map((r) => ({
                etiqueta: String(r.etiqueta ?? "").trim(),
                articulo: String(r.articulo ?? "").trim(),
              })),
            },
          });
          const sideRows = [
            ...diff.onlyLeft,
            ...diff.same,
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
          recordTokenConsumption(null, userText || text, polished.reply);
          await ensureTypingPause(polished.reply);
          finishBotReply(sessionId, botId, polished.reply, {
            resultItems: sideRows
              .slice(0, CHAT_SIDE_RESULT_CAP)
              .map((row) => rowToChatApiItem(row)),
            qr: [],
            followUps: polished.followUps,
          });
          return;
        } catch {
          /* abort */
        }
      }

      const compare = detectCompareInventariosAsk(intentText, origens);
      const wantsCompare =
        /\b(compara|comparar|comparacion|diff|diferencia|diferencias)\b/i.test(
          intentText,
        ) || /^comparar\s+inventarios?$/i.test(intentText.trim());
      if (compare || wantsCompare) {
        try {
          if (!compare || origens.length < 1) {
            const ask =
              origens.length < 1
                ? pickChatVariant(
                    [
                      "En este momento **no hay inventarios** con los que empezar a comparar. Cuando importes o crees uno (por ejemplo **Inventario 1**), lo vemos juntos.",
                      "Ahora mismo el inventario está vacío: no hay nada que comparar. ¿Importamos un Excel o creamos un inventario nuevo?",
                      "Todavía no existe un inventario para comparar. Si quieres, empezamos creando uno o cargando un archivo.",
                    ],
                    "compare-empty-none",
                  )
                : pickChatVariant(
                    [
                      `Claro. Dime los dos, por ejemplo: **compara excel 1 vs excel 2** o **Inventario 1 vs Inventario 4**. Ahora tengo: ${origens.map((o) => `**${o}**`).join(", ")}.`,
                      `Para comparar, nómbrame ambos (ej. **excel 1** y **excel 2**). Disponibles: ${origens.map((o) => `**${o}**`).join(", ")}.`,
                      `¿Cuáles quieres comparar? Puedo usar, por ejemplo, ${origens
                        .slice(0, 3)
                        .map((o) => `**${o}**`)
                        .join(" y ")}${origens.length > 3 ? "…" : ""}. También sirve «compara ambos exceles».`,
                    ],
                    "compare-empty-need-pair",
                  );
            recordTokenConsumption(null, spokenText, ask);
            await ensureTypingPause(ask);
            finishBotReply(sessionId, botId, ask);
            return;
          }
          const wantsAllCompare =
            /\b(compara\s+todo|comparar\s+todo|todos\s+los\s+inventarios|todas\s+las\s+bases)\b/i.test(
              intentText,
            ) || /^comparar\s+inventarios?$/i.test(intentText.trim());
          const compareOrigenes = wantsAllCompare
            ? origens
            : [compare.left, compare.right];
          const comparacionPayload = buildInventarioComparacion(
            items,
            wantsAllCompare ? null : compareOrigenes,
          );
          const diff = diffInventarios(items, compare.left, compare.right);
          const fallbackReply = formatInventarioDiffReply(diff);
          const polished = await polishInventoryReply({
            userText: userText || text,
            sessionId: sessionId,
            kind: "compare",
            threadHint: resolvedTurn.threadHint || "",
            fallback: fallbackReply,
            facts: {
              left: diff.left,
              right: diff.right,
              left_count: diff.leftCount,
              right_count: diff.rightCount,
              iguales: diff.same.length,
              faltan: diff.onlyLeft.length,
              sobran: diff.onlyRight.length,
              cambiaron: new Set(
                diff.changed.map((c) => c.etiqueta.toLowerCase()),
              ).size,
              veredicto:
                !diff.onlyLeft.length &&
                !diff.onlyRight.length &&
                !diff.changed.length
                  ? "todas_coinciden"
                  : "parcial",
              tono: "claro_conversacional",
              plantilla_sugerida: fallbackReply,
              faltan_sample: diff.onlyLeft.slice(0, 5).map((r) => ({
                etiqueta: String(r.etiqueta ?? "").trim(),
                articulo: String(r.articulo ?? "").trim(),
              })),
              sobran_sample: diff.onlyRight.slice(0, 5).map((r) => ({
                etiqueta: String(r.etiqueta ?? "").trim(),
                articulo: String(r.articulo ?? "").trim(),
              })),
              comparacion: comparacionPayload,
            },
          });
          recordTokenConsumption(null, userText || text, polished.reply);
          await ensureTypingPause(polished.reply);
          finishBotReply(sessionId, botId, polished.reply, {
            resultItems: [],
            qr: [],
            viewerOverview: "comparacion",
            viewerComparacion: comparacionPayload,
            skipExpand: true,
            followUps: polished.followUps,
          });
          return;
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

    // 2a. Persona ANTES que área: “inventario (general) de Héctor” no es RH.
    const personQueryEarly =
      resolvedTurn.topic === "duplicates" ||
      resolvedTurn.topic === "compare" ||
      resolvedTurn.topic === "fill_inventario" ||
      resolvedTurn.topic === "create_inventario" ||
      resolvedTurn.topic === "etiqueta_origen"
        ? undefined
        : findMatchingPeopleForPrompt(intentText, items);
    if (personQueryEarly) {
      if (personQueryEarly.candidates.length > 1) {
        const candidateNames = personQueryEarly.candidates.map((c) => c.name);
        pendingDisambiguationRef.current = {
          kind: "person",
          queryLabel: personQueryEarly.queryLabel,
          candidates: candidateNames,
          intent: personQueryEarly.intent,
          limit: personQueryEarly.limit,
        };
        try {
          const localReply = buildPersonDisambiguationReply(
            personQueryEarly.queryLabel,
            personQueryEarly.candidates,
            personQueryEarly.limit,
          );
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: [],
            qr: [],
            viewerOverview: "personMatches",
            viewerFocus: encodeMatchesFocus(
              personQueryEarly.queryLabel,
              candidateNames,
            ),
          });
        } catch {
          /* abort */
        }
        return;
      }
      if (personQueryEarly.candidates.length === 1) {
        const singlePerson = personQueryEarly.candidates[0];
        try {
          const { reply: localReply, shownRows } = buildExactPersonReply(
            singlePerson,
            personQueryEarly.limit,
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
          /* abort */
        }
        return;
      }
    }

    // 2. Consulta de área (segura → visor; dudosa/typo → preguntar sin visor)
    // No robar el hilo si estamos en duplicados / comparar / inventario nuevo.
    const areaQuery =
      resolvedTurn.topic === "duplicates" ||
      resolvedTurn.topic === "compare" ||
      resolvedTurn.topic === "fill_inventario" ||
      resolvedTurn.topic === "create_inventario" ||
      resolvedTurn.topic === "etiqueta_origen"
        ? undefined
        : findMatchingAreasForPrompt(intentText, items);
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
    const personQuery =
      resolvedTurn.topic === "duplicates" ||
      resolvedTurn.topic === "compare" ||
      resolvedTurn.topic === "fill_inventario" ||
      resolvedTurn.topic === "create_inventario" ||
      resolvedTurn.topic === "etiqueta_origen"
        ? undefined
        : findMatchingPeopleForPrompt(intentText, items);
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
          const wantsEtq = looksLikePersonEtiquetasAsk(userText || text);
          if (wantsEtq) {
            const allRows = singlePerson.rows;
            const localReply =
              `**${singlePerson.name}** tiene **${allRows.length.toLocaleString("es-MX")}** etiqueta` +
              `${allRows.length === 1 ? "" : "s"} en total.\n\n` +
              `El listado completo está en el visor derecho.`;
            recordTokenConsumption(null, userText || text, localReply);
            await ensureTypingPause(localReply);
            finishBotReply(sessionId, botId, localReply, {
              resultItems: allRows
                .slice(0, CHAT_SIDE_RESULT_CAP)
                .map((row) => rowToChatApiItem(row)),
              qr: [],
              viewerFocus: singlePerson.name,
            });
          } else {
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
          }
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

    // Export Excel: sin atajo local (confirmación + .xlsx solo tras backend).

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
          const shownRows = areaRows.slice(0, CHAT_SIDE_RESULT_CAP);
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
    // Nunca si es multipetición Inv N → Inv M.
    if (
      looksLikeResultAnaphora(userText || text) &&
      !looksLikeInventarioMultiAsk(intentText || userText || text)
    ) {
      const prevItems =
        lastBotResultItems(messagesRef.current).length > 0
          ? lastBotResultItems(messagesRef.current)
          : lastConcreteSideRef.current?.resultItems || [];
      const n = normalizeChatIntent(userText || text);
      const wantsThose =
        (/\betiquet/.test(n) &&
          /\b(esas|esos|estas|estos|de arriba|anteriores?)\b/.test(n)) ||
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
    // (recientes ya se resolvieron en 1b0)
    const turnBeforeOverview = analyzeTurnQuick(userText || text, items);
    const earlyOverview =
      turnBeforeOverview.isWriteTurn || turnBeforeOverview.discourseOnly
        ? undefined
        : detectMarcasAreaAsk(userText || text, items)
          ? undefined
          : detectViewerOverview(userText || text);
    if (earlyOverview && earlyOverview !== "recent" && items.length) {
      try {
        const overviewFocus = resolveOverviewFocus(userText || text, items);
        const localReply = buildLocalOverviewReply(
          earlyOverview,
          items,
          overviewFocus,
          userText || text,
        );
        if (localReply) {
          const openPanel =
            shouldAttachSidePanel(userText || text, items, chatHistory) ||
            earlyOverview === "personas" ||
            earlyOverview === "areas" ||
            earlyOverview === "estado" ||
            earlyOverview === "marcas" ||
            earlyOverview === "stats" ||
            earlyOverview === "full";
          recordTokenConsumption(null, userText || text, localReply);
          await ensureTypingPause(localReply);
          finishBotReply(sessionId, botId, localReply, {
            resultItems: [],
            qr: [],
            viewerOverview: earlyOverview,
            viewerFocus: overviewFocus,
          });
          return;
        }
      } catch {
        /* abort / nuevo mensaje */
      }
    }

    // Consultas abiertas: OpenAI/agent por defecto; n8n solo si FALLBACK=n8n.
    const preferN8n =
      String(process.env.NEXT_PUBLIC_CHAT_FALLBACK || "deepseek")
        .trim()
        .toLowerCase() === "n8n";
    const memoryBlock = [formatChatMemoryForPrompt(), resolvedTurn.threadHint]
      .filter(Boolean)
      .join("\n\n");
    const fallbackThreadFocus: N8nThreadFocus = {};
    for (let i = chatHistory.length - 1; i >= 0; i -= 1) {
      const m = chatHistory[i];
      if (m.from !== "bot") continue;
      const focus = String(m.viewerFocus || "").trim();
      const ov = m.viewerOverview;
      if (focus) {
        fallbackThreadFocus.focus = focus;
        if (ov === "personTotal" || ov === "personMatches") {
          fallbackThreadFocus.persona = focus;
        } else if (ov === "areaTotal" || ov === "areaMatches") {
          fallbackThreadFocus.area = focus;
        } else if (/^inventario\b/i.test(focus)) {
          fallbackThreadFocus.origen = focus;
        }
      }
      if (ov) fallbackThreadFocus.overview = ov;
      break;
    }
    let data: ChatApiResponse = {};
    let viaN8n = false;
    let n8nPanelSide: ReturnType<typeof resolveN8nMostrarPanel> = null;
    if (preferN8n) {
      try {
        const n8nMessage = memoryBlock
          ? `${memoryBlock}\n\nUsuario: ${intentText}`
          : intentText;
        const n8nRes = await enviarMensajeN8n(n8nMessage, sessionId, {
          signal: controller.signal,
          context: {
            threadFocus: fallbackThreadFocus,
            lastUser: spokenText || userText || text,
            threadSummary: chatHistory
              .filter((m) => m.from === "user")
              .slice(-3)
              .map((m) => String(m.text || "").trim())
              .filter(Boolean)
              .map((t, idx) => `${idx + 1}. ${t.slice(0, 160)}`)
              .join(" | "),
          },
        });
        if (
          requestGen !== chatRequestGenRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        const panelAccion = pickMostrarPanelAccion(n8nRes.acciones);
        ejecutarAcciones(
          (n8nRes.acciones || []).filter((a) => a?.tipo !== "mostrar_panel"),
        );
        n8nPanelSide = resolveN8nMostrarPanel(panelAccion, items);
        data = {
          reply: n8nRes.reply,
          items: n8nPanelSide?.resultItems || [],
          qr: [],
          mutated: false,
          used: "n8n",
          error: n8nRes.error || undefined,
        };
        viaN8n = true;
      } catch (err) {
        if (
          (err instanceof DOMException && err.name === "AbortError") ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          return;
        }
        // n8n caído → DeepSeek sin romper el chat
        data = await askInventoryChat(intentText, history, {
          signal: controller.signal,
          memory: memoryBlock,
          model: activeLlmMeta.model,
          sessionId: sessionId,
          contextoVista: getContextoVista(),
        });
      }
    } else {
      data = await askInventoryChat(intentText, history, {
        signal: controller.signal,
        memory: memoryBlock,
        model: activeLlmMeta.model,
        sessionId: sessionId,
        contextoVista: getContextoVista(),
      });
    }
    if (
      requestGen !== chatRequestGenRef.current ||
      controller.signal.aborted ||
      data.error === "aborted"
    ) {
      return;
    }
    reply = (data.reply || "").trim() || reply;
    // Tokens DeepSeek solo cuando el turno fue por Backend-ia LLM.
    recordTokenConsumption(viaN8n ? null : data.usage, userText || text, reply);
    sideItems = data.items || [];
    mutated = Boolean(data.mutated);
    qrPayloads = data.qr || [];
    if (
      n8nPanelSide?.resultItems?.length &&
      !sideItems.length
    ) {
      sideItems = n8nPanelSide.resultItems;
    }

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
      shouldAttachSidePanel(userText || text, items, chatHistory) ||
      mutated ||
      Boolean(n8nPanelSide?.viewerOverview) ||
      Boolean(n8nPanelSide?.resultItems?.length);
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
    let forcedOverview: ViewerOverview | undefined =
      n8nPanelSide?.viewerOverview;
    if (
      !forcedOverview &&
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
    const catalogOverviewAsk = detectViewerOverview(userText || text);
    const wantsAreasRanking =
      wantsGlobalAreasRanking(userText || text) ||
      catalogOverviewAsk === "areas" ||
      data.viewer?.tipo === "areas" ||
      data.viewer?.tipo === "areas_general";

    const focusPerson = wantsAreasRanking
      ? undefined
      : detectPersonTotalAsk(userText || text, items, chatHistory) ||
        (concreteAsk
          ? findPersonInText(userText || text, items)
          : undefined);
    const focusArea =
      !wantsAreasRanking && !focusPerson && concreteAsk
        ? detectAreaTotalAsk(userText || text, items)
        : undefined;
    let askedOverview: ViewerOverview | undefined =
      !openSidePanel || mutated || areaListAsk
        ? undefined
        : wantsAreasRanking
          ? "areas"
          : focusPerson
            ? "personTotal"
            : focusArea
              ? "areaTotal"
              : catalogOverviewAsk || forcedOverview;
    // Ranking global de áreas/personas/… NO se pisa con items de un filtro previo.
    // Persona/área con foco: mantener plantilla personTotal/areaTotal.
    let overview: ViewerOverview | undefined =
      wantsAreasRanking
        ? "areas"
        : focusPerson
          ? "personTotal"
          : focusArea
            ? "areaTotal"
            : !openSidePanel
              ? undefined
              : catalogOverviewAsk === "personas" ||
                  catalogOverviewAsk === "marcas" ||
                  catalogOverviewAsk === "estado" ||
                  catalogOverviewAsk === "full" ||
                  catalogOverviewAsk === "stats" ||
                  catalogOverviewAsk === "recent"
                ? catalogOverviewAsk
                : sideItems.length > 0 ||
                    qrPayloads.length ||
                    Boolean(areaListAsk && sideItems.length) ||
                    (sideItems.length &&
                      (forceSidePanel ||
                        looksLikeRecordLookup(userText || text)) &&
                      !forcedOverview)
                  ? undefined
                  : askedOverview || forcedOverview;
    let viewerFocus =
      wantsAreasRanking
        ? undefined
        : (focusPerson || undefined) ||
          n8nPanelSide?.viewerFocus ||
          (overview === "areaTotal" && focusArea
            ? focusArea
            : overview && overview !== "areas"
              ? resolveOverviewFocus(userText || text, items)
              : undefined);

    // Visor de persona: rellenar desde inventario local si el API no mandó items.
    if (wantsAreasRanking) {
      openSidePanel = true;
      overview = "areas";
      viewerFocus = undefined;
      // Sin items: el chat-viewer arma el ranking desde TODO el inventario.
      sideItems = [];
      qrPayloads = [];
    } else if (focusPerson) {
      openSidePanel = true;
      overview = "personTotal";
      viewerFocus = focusPerson;
      const personRows = rowsForPersonName(items, focusPerson).slice(
        0,
        CHAT_SIDE_RESULT_CAP,
      );
      if (personRows.length) {
        sideItems = personRows.map((row) => rowToChatApiItem(row));
      }
    } else if (focusArea) {
      openSidePanel = true;
      overview = "areaTotal";
      viewerFocus = focusArea;
      if (!sideItems.length) {
        sideItems = rowsForAreaNeedle(items, focusArea, CHAT_SIDE_RESULT_CAP).map(
          (row) => rowToChatApiItem(row),
        );
      }
    }

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

    const apiFollowUps = mapAccionesSugeridas(data.acciones_sugeridas);
    // Sync: contexto_vista null → visor oculto; objeto → mostrar datos nuevos.
    const ctxRaw = data.contexto_vista;
    const ctxNull = ctxRaw === null;
    const ctx =
      ctxRaw && typeof ctxRaw === "object"
        ? {
            tipo: String(ctxRaw.tipo || "").trim().toLowerCase(),
            valor: String(ctxRaw.valor || "").trim(),
            lista_limitada: Boolean(ctxRaw.lista_limitada),
            comparacion:
              ctxRaw.comparacion && typeof ctxRaw.comparacion === "object"
                ? ctxRaw.comparacion
                : undefined,
          }
        : data.viewer && typeof data.viewer === "object"
          ? {
              tipo: String(data.viewer.tipo || "").trim().toLowerCase(),
              valor: String(data.viewer.valor || "").trim(),
              lista_limitada: Boolean(
                (data.viewer as { lista_limitada?: boolean }).lista_limitada,
              ),
              comparacion:
                (data.viewer as { comparacion?: ChatComparacionVista })
                  .comparacion &&
                typeof (data.viewer as { comparacion?: ChatComparacionVista })
                  .comparacion === "object"
                  ? (data.viewer as { comparacion?: ChatComparacionVista })
                      .comparacion
                  : undefined,
            }
          : null;

    const limitedAsk =
      Boolean(ctx?.lista_limitada) ||
      parseRequestedCount(userText || text) != null ||
      parseEtiquetaListAsk(userText || text) != null;

    const forceAreasOverview =
      wantsAreasRanking ||
      ctx?.tipo === "areas" ||
      ctx?.tipo === "areas_general" ||
      overview === "areas";

    const forceComparacionOverview = ctx?.tipo === "comparacion";

    const exportFocus =
      (ctx?.tipo === "origen" ||
        ctx?.tipo === "persona" ||
        ctx?.tipo === "area") &&
      ctx.valor
        ? ctx.valor
        : "Inventario";
    const exportFiles = data.exportar_excel
      ? await buildExportFilesFromApiItems(sideItems, exportFocus)
      : undefined;

    // Charla / contexto_vista null → solo texto; visor permanece oculto.
    if (
      ctxNull &&
      !forceAreasOverview &&
      !forceComparacionOverview &&
      !qrPayloads.length &&
      !mutated &&
      !exportFiles?.length
    ) {
      finishBotReply(sessionId, botId, finalReply, {
        userText: spokenRaw || userText || text,
        followUps: apiFollowUps.length ? apiFollowUps : undefined,
      });
      return;
    }

    let sideOverview: ViewerOverview | undefined;
    let sideFocus: string | undefined;
    let sideResultItems: ChatApiItem[] = sideItems;
    let sideQr = qrPayloads;
    let sideComparacion: ChatComparacionVista | null = null;

    if (forceComparacionOverview) {
      sideOverview = "comparacion";
      sideFocus = undefined;
      sideResultItems = [];
      sideQr = [];
      sideComparacion =
        (ctx?.comparacion as ChatComparacionVista | undefined) ||
        buildInventarioComparacion(items, null);
    } else if (forceAreasOverview) {
      sideOverview = "areas";
      sideFocus = undefined;
      sideResultItems = [];
      sideQr = [];
    } else if (ctx?.tipo === "persona" && ctx.valor) {
      sideFocus = ctx.valor;
      // Lista N (dame 8) → solo esos registros; total persona → plantilla personTotal.
      sideOverview = limitedAsk ? undefined : "personTotal";
      if (!limitedAsk && !sideResultItems.length) {
        sideResultItems = rowsForPersonName(items, ctx.valor)
          .slice(0, CHAT_SIDE_RESULT_CAP)
          .map((row) => rowToChatApiItem(row));
      }
    } else if (ctx?.tipo === "area" && ctx.valor) {
      sideFocus = ctx.valor;
      sideOverview = limitedAsk ? undefined : "areaTotal";
      if (!limitedAsk && !sideResultItems.length) {
        sideResultItems = rowsForAreaNeedle(
          items,
          ctx.valor,
          CHAT_SIDE_RESULT_CAP,
        ).map((row) => rowToChatApiItem(row));
      }
    } else if (ctx?.tipo === "origen" && ctx.valor) {
      sideFocus = ctx.valor;
      sideOverview = "full";
    } else {
      sideOverview = overview;
      sideFocus = viewerFocus;
    }

    const apiViewer = ctx
      ? {
          tipo:
            ctx.tipo === "areas_general"
              ? "areas"
              : ctx.tipo === "areas"
                ? "areas"
                : ctx.tipo,
          valor: ctx.valor || "general",
        }
      : forceAreasOverview
        ? { tipo: "areas", valor: "general" }
        : forceComparacionOverview
          ? { tipo: "comparacion", valor: "general" }
          : null;

    const shouldSyncPanel =
      forceAreasOverview ||
      forceComparacionOverview ||
      Boolean(ctx) ||
      Boolean(sideOverview) ||
      sideResultItems.length > 0 ||
      sideQr.length > 0 ||
      hasNewSide ||
      Boolean(exportFiles?.length);

    finishBotReply(
      sessionId,
      botId,
      finalReply,
      shouldSyncPanel
        ? {
            resultItems:
              forceAreasOverview || forceComparacionOverview
                ? []
                : sideResultItems,
            qr:
              forceAreasOverview || forceComparacionOverview ? [] : sideQr,
            viewerOverview: sideOverview,
            viewerFocus: sideFocus,
            viewerComparacion: sideComparacion,
            exportFiles,
            apiViewer,
            userText: spokenRaw || userText || text,
            followUps:
              forceAreasOverview || forceComparacionOverview
                ? apiFollowUps.length
                  ? apiFollowUps
                  : undefined
                : apiFollowUps.length
                  ? apiFollowUps
                  : undefined,
            // Lista N o ranking/comparación: no expandir al inventario completo.
            skipExpand:
              limitedAsk || forceAreasOverview || forceComparacionOverview,
          }
        : {
            userText: spokenRaw || userText || text,
            followUps: apiFollowUps.length ? apiFollowUps : undefined,
            exportFiles,
          },
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
    lastScrolledUserMsgIdRef.current = null;
    ultimoMensajeUsuarioRef.current = null;
    lastConcreteSideRef.current = null;
    setSideViewerVisible(false);
    changeRail("archivos");
    // Evita título pegado arriba por scroll residual del chat anterior.
    requestAnimationFrame(() => {
      const stage = chatStageRef.current;
      if (stage) {
        stage.scrollTop = 0;
        delete stage.dataset.chatScrollMax;
      }
      if (chatLogRef.current) chatLogRef.current.scrollTop = 0;
    });
  }, [changeRail]);

  const resetTokenSession = useCallback(async () => {
    const prevSessionId = activeChatIdRef.current;
    if (prevSessionId) {
      try {
        await resetChatSession(prevSessionId);
      } catch {
        /* backend opcional */
      }
    }
    setTokenMeters((prev) => {
      const next = { ...prev };
      delete next[activeTokenMeter.meterId];
      saveTokenMeters(next);
      return next;
    });
    setTokenDetailsOpen(false);
    setTokenPopoverOpen(false);
    startNewChat();
  }, [activeTokenMeter.meterId, startNewChat]);

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
      lastScrolledUserMsgIdRef.current = null;
      const maxId = nextMessages.reduce((max, message) => Math.max(max, message.id), 0);
      chatId.current = maxId + 1;
      setDraft("");
      setSideViewerVisible(
        nextMessages.some((message) => messageHasSideData(message)),
      );
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
      lastConcreteSideRef.current = null;
      setSideViewerVisible(false);
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

  const resetAreaFilters = () => {
    setSelectedId(null);
    setAreaSearch("");
    setDebouncedAreaSearch("");
  };

  const resetEstadoFilters = () => {
    setEstadoSearch("");
    setDebouncedEstadoSearch("");
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

  const selectedFolder =
    (rail === "personas"
      ? visiblePersonFolders.find((folder) => folder.id === selectedId)
      : rail === "areas"
        ? visibleAreaFolders.find((folder) => folder.id === selectedId)
        : folders.find((folder) => folder.id === selectedId)) ?? null;

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
                  <span>{formatNumber(visibleAreaFolders.length)} grupos</span>
                </div>
              </div>

              <section className="reports-filter-panel people-reports-filter" aria-label="Filtros de áreas">
                <div className="reports-filter-grid">
                  <div className="report-filter-item report-filter-search">
                    <label htmlFor="area-filter-search">Búsqueda rápida</label>
                    <div className="report-search-wrap">
                      <Search size={15} />
                      <input
                        id="area-filter-search"
                        placeholder="Ej. Sistemas, OF-0026, Martinez…"
                        value={areaSearch}
                        onChange={(e) => setAreaSearch(e.target.value)}
                      />
                      {areaSearch ? (
                        <button
                          type="button"
                          className="report-search-clear"
                          onClick={() => {
                            setAreaSearch("");
                            setDebouncedAreaSearch("");
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
                    onClick={resetAreaFilters}
                    title="Restablecer filtros de áreas"
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

              {selectedFolder ? (
                <div className="people-filter-bar" role="status">
                  <div>
                    <strong>Área: {selectedFolder.name}</strong>
                    <small>
                      {formatNumber(
                        visibleAreaFolders.find((folder) => folder.id === selectedId)?.rows
                          .length ?? 0,
                      )}{" "}
                      {(visibleAreaFolders.find((folder) => folder.id === selectedId)?.rows
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

              {visibleAreaFolders.length ? (
                <div className="people-strip" role="list" ref={peopleStripRef}>
                  {visibleAreaFolders.map((folder) => {
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
                <p className="empty-groups">No hay áreas para mostrar con estos filtros.</p>
              )}
            </section>
          ) : null}

          {rail === "estado" ? (
            <section className="quick-access" aria-label="Estado">
              <section className="reports-filter-panel people-reports-filter" aria-label="Filtros de estado">
                <div className="reports-filter-grid">
                  <div className="report-filter-item report-filter-search">
                    <label htmlFor="estado-filter-search">Búsqueda rápida</label>
                    <div className="report-search-wrap">
                      <Search size={15} />
                      <input
                        id="estado-filter-search"
                        placeholder="Ej. Activo, OF-0026, Martinez…"
                        value={estadoSearch}
                        onChange={(e) => setEstadoSearch(e.target.value)}
                      />
                      {estadoSearch ? (
                        <button
                          type="button"
                          className="report-search-clear"
                          onClick={() => {
                            setEstadoSearch("");
                            setDebouncedEstadoSearch("");
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
                    onClick={resetEstadoFilters}
                    title="Restablecer filtros de estado"
                  >
                    <RotateCcw size={15} />
                    <span>Restablecer</span>
                  </button>
                </div>
              </section>
            </section>
          ) : null}

          {rail === "archivos" ? (
            <div
              key={
                chatStarted
                  ? "chat-stage-conversation"
                  : `chat-stage-home-${activeChatId || "new"}`
              }
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
                    <div className="chat-home" key={`home-hero-${activeChatId || "new"}`}>
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
                          const parsed = parseUserAttachDisplay(message.text);
                          const displayText = parsed.body;
                          const showFileCard = Boolean(
                            parsed.attach &&
                              (parsed.attach.kind === "file" ||
                                isSpreadsheetFileName(parsed.attach.name)),
                          );
                          const sheetName = parsed.attach?.name || "";
                          const isSheet = isSpreadsheetFileName(sheetName);
                          const canCollapse =
                            displayText.trim().length > CHAT_USER_COLLAPSE_AT;
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
                                  {showFileCard && parsed.attach ? (
                                    <div
                                      className="chat-export-files is-user-upload"
                                      aria-label="Archivo adjunto"
                                    >
                                      <div
                                        className="chat-export-card"
                                        role="status"
                                        title={parsed.attach.name}
                                      >
                                        <span className="chat-export-card-title">
                                          {parsed.attach.name}
                                        </span>
                                        <span className="chat-export-card-meta">
                                          <span
                                            className="chat-export-card-badge"
                                            aria-hidden="true"
                                          >
                                            X
                                          </span>
                                          <span>
                                            {isSheet ? "Excel" : "ARCHIVO"}
                                          </span>
                                          <span className="chat-export-card-count">
                                            Adjuntado
                                          </span>
                                        </span>
                                      </div>
                                    </div>
                                  ) : null}
                                  {displayText ||
                                  (!showFileCard && parsed.attach) ? (
                                    <p
                                      className={
                                        canCollapse && !expanded
                                          ? "chat-bubble is-collapsed"
                                          : "chat-bubble"
                                      }
                                    >
                                      {displayText ||
                                        (parsed.attach
                                          ? `[Imagen: ${parsed.attach.name}]`
                                          : message.text)}
                                    </p>
                                  ) : null}
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
                                {renderChatRichText(message.text, {
                                  onAsk: (prompt) => {
                                    void sendChat(prompt);
                                  },
                                })}
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
                                        <span>Excel</span>
                                        <span className="chat-export-card-count">
                                          {file.rowCount.toLocaleString("es-MX")}{" "}
                                          reg.
                                        </span>
                                      </span>
                                    </a>
                                  ))}
                                </div>
                              ) : null}
                              {(() => {
                                const chips =
                                  Array.isArray(message.followUps)
                                    ? message.followUps
                                    : buildChatFollowUps(
                                        {
                                          resultItems: message.resultItems,
                                          qr: message.qr,
                                          viewerOverview: message.viewerOverview,
                                          viewerFocus: message.viewerFocus,
                                        },
                                        undefined,
                                        message.text,
                                      );
                                return (
                                  <ChatSuggestedActions
                                    messageId={message.id}
                                    chips={chips}
                                    isLatestBot={isLatest}
                                    onPick={(prompt) => {
                                      void sendChat(prompt);
                                    }}
                                  />
                                );
                              })()}
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
                          const isLastUser = turn.user.id === lastUserMessageId;
                          return (
                            <section
                              className="chat-turn"
                              key={`pair-${turn.user.id}-${turn.bot.id}`}
                              data-chat-latest={isLatest ? "true" : undefined}
                              data-side-msg={hasSide ? turn.bot.id : undefined}
                            >
                              <div className="chat-turn-main">
                                <div
                                  className={
                                    isLastUser
                                      ? "chat-turn-query chat-user-anchor scroll-mt-[4px]"
                                      : "chat-turn-query"
                                  }
                                  ref={
                                    isLastUser
                                      ? (el) => {
                                          ultimoMensajeUsuarioRef.current = el;
                                        }
                                      : undefined
                                  }
                                >
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
                        const isLastUser = isUser && message.id === lastUserMessageId;
                        return (
                          <div
                            className={[
                              isUser ? "chat-row is-user" : "chat-row is-bot",
                              isLastUser
                                ? "chat-user-anchor scroll-mt-[4px]"
                                : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            key={message.id}
                            data-chat-latest={isLatest ? "true" : undefined}
                            ref={
                              isLastUser
                                ? (el) => {
                                    ultimoMensajeUsuarioRef.current = el;
                                  }
                                : undefined
                            }
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
                      pendingAttach.kind === "image" ? (
                        <div className="chat-attach-preview">
                          <span
                            className="chat-attach-preview-icon is-image"
                            aria-hidden="true"
                          >
                            <ImagePlus size={18} strokeWidth={1.8} />
                          </span>
                          <div className="chat-attach-preview-meta">
                            <span className="chat-attach-preview-name">
                              {pendingAttach.name}
                            </span>
                            <span className="chat-attach-preview-kind">
                              Imagen · lista para enviar
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
                      ) : (
                        <div className="chat-composer-draft-wrap">
                          <div
                            className="chat-export-files is-user-upload is-composer-draft"
                            aria-label="Archivo adjunto"
                          >
                            <div
                              className="chat-export-card"
                              role="status"
                              title={pendingAttach.name}
                            >
                              <span className="chat-export-card-title">
                                {pendingAttach.name}
                              </span>
                              <span className="chat-export-card-meta">
                                <span
                                  className="chat-export-card-badge"
                                  aria-hidden="true"
                                >
                                  X
                                </span>
                                <span>
                                  {isSpreadsheetFileName(pendingAttach.name)
                                    ? "Excel"
                                    : "ARCHIVO"}
                                </span>
                                <span className="chat-export-card-count">
                                  Listo
                                </span>
                              </span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="chat-export-card-remove"
                            aria-label="Quitar archivo"
                            onClick={() => setPendingAttach(null)}
                          >
                            <X size={14} strokeWidth={2} />
                          </button>
                        </div>
                      )
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
                          aria-label="Adjuntar Excel"
                          aria-expanded={attachMenuOpen}
                          aria-haspopup="menu"
                          title="Adjuntar Excel"
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
                              <span>Excel</span>
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
                            : "Pregunta o arrastra un Excel"
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
                              <span>
                                {formatCompactTokens(activeTokenMeter.budget)}
                              </span>
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
                            <div className="chat-token-popover-grid chat-token-popover-grid-clean">
                              <div>
                                <span>Usados</span>
                                <strong>
                                  {formatNumber(activeTokenMeter.used)} /{" "}
                                  {formatCompactTokens(activeTokenMeter.budget)}
                                </strong>
                              </div>
                              <div>
                                <span>Restantes</span>
                                <strong>
                                  {activeTokenMeter.pctRemaining.toFixed(1)}%
                                </strong>
                              </div>
                              <div>
                                <span>En borrador</span>
                                <strong>
                                  +{formatNumber(activeTokenMeter.draftTokens)} tok
                                </strong>
                              </div>
                            </div>
                            <details
                              className="chat-token-details"
                              open={tokenDetailsOpen}
                              onToggle={(e) =>
                                setTokenDetailsOpen(
                                  (e.target as HTMLDetailsElement).open,
                                )
                              }
                            >
                              <summary>Detalle técnico</summary>
                              <div className="chat-token-popover-grid">
                                <div>
                                  <span>Prompt / Resp.</span>
                                  <strong>
                                    {formatCompactTokens(
                                      activeTokenMeter.promptUsed,
                                    )}{" "}
                                    /{" "}
                                    {formatCompactTokens(
                                      activeTokenMeter.completionUsed,
                                    )}
                                  </strong>
                                </div>
                                <div>
                                  <span>Último turno</span>
                                  <strong>
                                    {formatNumber(
                                      activeTokenMeter.lastTurnTokens,
                                    )}{" "}
                                    tok
                                  </strong>
                                </div>
                                <div>
                                  <span>Costo sesión</span>
                                  <strong>
                                    {formatUsd(activeTokenMeter.costUsd)}
                                  </strong>
                                </div>
                                <div>
                                  <span>Key</span>
                                  <strong>
                                    #
                                    {(
                                      activeTokenMeter.keyFingerprint ||
                                      "default"
                                    ).slice(0, 8)}
                                  </strong>
                                </div>
                              </div>
                              {availableModels.length > 0 ? (
                                <div className="chat-token-models-section">
                                  <div className="chat-token-models-head">
                                    <span>Modelos disponibles</span>
                                  </div>
                                  <div
                                    className="chat-token-models-list"
                                    role="listbox"
                                    aria-label="Seleccionar modelo de IA"
                                  >
                                    {availableModels.map((opt) => {
                                      const isSelected =
                                        opt.id === activeTokenMeter.model;
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
                                              {formatCompactTokens(
                                                opt.token_budget,
                                              )}
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
                            </details>
                            <div className="chat-token-popover-foot">
                              <span>
                                {formatCompactTokens(activeTokenMeter.remaining)}{" "}
                                libres
                              </span>
                              <button
                                type="button"
                                className="chat-token-reset-btn"
                                onClick={() => {
                                  void resetTokenSession();
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
                        comparacion={activeSideCompanion.comparacion}
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
                          : areaSearch.trim()
                            ? "Artículos encontrados"
                            : "Artículos por área"
                        : rail === "estado"
                          ? estadoSearch.trim()
                            ? "Artículos encontrados"
                            : "Estado del artículo"
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
                  {query ||
                  (rail === "personas" && peopleSearch.trim()) ||
                  (rail === "areas" && areaSearch.trim()) ||
                  (rail === "estado" && estadoSearch.trim()) ||
                  (rail === "inventario" && inventarioSearch.trim()) ? (
                    <span className="filter-indicator">Filtrado por búsqueda</span>
                  ) : null}
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
                          catalogItems={items}
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
        onClose={() => {
          setIsAddModalOpen(false);
          setAddModalDestino(null);
        }}
        onCreated={handleProductCreated}
        existingAreas={existingAreas}
        existingPeople={existingPeople}
        items={items}
        preferredDestino={addModalDestino}
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
        catalogItems={items}
      />

      {pendingChatDeletePlan?.phase === "modal" ? (
        <ChatChoiceModal
          titleId="chat-delete-record-title"
          title={
            pendingChatDeletePlan.wholeOrigen &&
            planDeleteOrigens(pendingChatDeletePlan).length
              ? `Eliminar todo ${formatOrigensListEs(planDeleteOrigens(pendingChatDeletePlan))}`
              : pendingChatDeletePlan.rows.length > 1
                ? `Eliminar ${pendingChatDeletePlan.rows.length} registros`
                : "Eliminar registro"
          }
          subtitle={
            pendingChatDeletePlan.rows.length === 1
              ? `${String(pendingChatDeletePlan.rows[0].etiqueta ?? "").trim() || `ID ${pendingChatDeletePlan.rows[0].id}`}${
                  pendingChatDeletePlan.rows[0].articulo
                    ? ` — ${pendingChatDeletePlan.rows[0].articulo}`
                    : ""
                }`
              : pendingChatDeletePlan.wholeOrigen &&
                  planDeleteOrigens(pendingChatDeletePlan).length
                ? `${pendingChatDeletePlan.rows.length.toLocaleString("es-MX")} registros de ${formatOrigensListEs(planDeleteOrigens(pendingChatDeletePlan))}`
                : pendingChatDeletePlan.rows
                    .slice(0, 4)
                    .map(
                      (r) =>
                        String(r.etiqueta ?? "").trim() || `ID ${r.id}`,
                    )
                    .join(", ") +
                  (pendingChatDeletePlan.rows.length > 4
                    ? ` y ${pendingChatDeletePlan.rows.length - 4} más`
                    : "") +
                  (planDeleteOrigens(pendingChatDeletePlan).length
                    ? ` · ${formatOrigensListEs(planDeleteOrigens(pendingChatDeletePlan))}`
                    : "")
          }
          onDismiss={() => {
            if (!chatDeleteBusy) setPendingChatDeletePlanSafe(null);
          }}
          keep={{
            title: "Cancelar",
            body:
              pendingChatDeletePlan.rows.length > 1
                ? "Los registros se quedan en el inventario. No se borra nada."
                : "El registro se queda en el inventario. No se borra nada.",
            action: "Volver al chat",
            disabled: chatDeleteBusy,
            onClick: () => setPendingChatDeletePlanSafe(null),
          }}
          drop={{
            title: chatDeleteBusy ? "Eliminando…" : "Borrar",
            body:
              pendingChatDeletePlan.rows.length > 1
                ? "No podrás deshacerlo desde el chat. Salen del inventario."
                : "No podrás deshacerlo desde el chat. El artículo sale del inventario.",
            action:
              pendingChatDeletePlan.rows.length > 1
                ? "Eliminar registros"
                : "Eliminar registro",
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
