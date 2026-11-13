/**
 * Ortografía del chat:
 * 1) Backend Python: RapidFuzz + TheFuzz + pyspellchecker + Autocorrect
 * 2) Fallback local (Fuse.js) si el backend no responde
 */
import Fuse from "fuse.js";
import { getChatApiBaseUrl } from "@/lib/chat-api";

const INTENT_VOCAB = [
  "agrega",
  "agregar",
  "agregala",
  "agregalo",
  "agregues",
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
] as const;

const VOCAB_SET = new Set<string>(INTENT_VOCAB);

let fuse: Fuse<string> | null = null;

function getFuse(): Fuse<string> {
  if (!fuse) {
    fuse = new Fuse([...INTENT_VOCAB], {
      includeScore: true,
      threshold: 0.38,
      ignoreLocation: true,
      minMatchCharLength: 3,
      isCaseSensitive: false,
    });
  }
  return fuse;
}

function foldToken(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function typoBudget(word: string): number {
  if (word.length <= 3) return 0;
  if (word.length <= 5) return 1;
  if (word.length <= 8) return 2;
  return 3;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) row[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
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

export function correctSpellToken(token: string): string {
  const t = foldToken(token);
  if (!t) return token;
  if (/^\d+$/.test(t)) return t;
  if (VOCAB_SET.has(t)) return t;
  for (const canon of INTENT_VOCAB) {
    if (canon.length >= 4 && t.startsWith(canon) && t.length - canon.length <= 3) {
      return canon;
    }
    if (t.length >= 4 && canon.startsWith(t) && canon.length - t.length <= 2) {
      return canon;
    }
  }

  const hits = getFuse().search(t);
  if (hits.length) {
    const best = hits[0];
    const score = best.score ?? 1;
    const cand = best.item;
    const dist = levenshtein(t, cand);
    if (score <= 0.38 && dist <= Math.max(typoBudget(t), typoBudget(cand))) {
      return cand;
    }
  }

  let best = t;
  let bestDist = Infinity;
  const budget = typoBudget(t);
  if (budget > 0) {
    for (const canon of INTENT_VOCAB) {
      if (Math.abs(canon.length - t.length) > budget) continue;
      const d = levenshtein(t, canon);
      if (d < bestDist && d <= budget) {
        bestDist = d;
        best = canon;
        if (d === 1) break;
      }
    }
  }
  return best;
}

/** Fallback síncrono (Fuse) si RapidFuzz del backend no está disponible. */
export function normalizeChatSpelling(raw: string): string {
  const base = String(raw || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!base) return "";
  return base
    .split(" ")
    .map((tok) => {
      if (!tok) return tok;
      if (/^\d+$/.test(tok)) return tok;
      if (/^[a-z]{0,10}\d{2,}$/i.test(tok)) return tok;
      return correctSpellToken(tok);
    })
    .join(" ");
}

export function looksLikeTransferVerb(text: string): boolean {
  const n = normalizeChatSpelling(text);
  return /\b(agrega\w*|pasa\w*|copia\w*|mete\w*|mueve\w*|mover\w*|traslad\w*|traspas\w*|importa\w*|trae\w*|traer\w*|pon\w*|llena\w*|continua\w*|contin\w*)\b/.test(
    n,
  );
}

export type SpellNormalizeResult = {
  original: string;
  normalized: string;
  changed: boolean;
  engines?: Record<string, boolean>;
};

/**
 * Llama al backend (RapidFuzz + TheFuzz + pyspellchecker + Autocorrect).
 * Si falla, usa Fuse local.
 */
export async function normalizeChatSpellingAsync(
  raw: string,
  signal?: AbortSignal,
): Promise<SpellNormalizeResult> {
  const original = String(raw || "").trim();
  if (!original) {
    return { original: "", normalized: "", changed: false };
  }

  const base = getChatApiBaseUrl();
  const url = base ? `${base}/api/chat/normalize/` : "/api/chat/normalize";

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: original }),
      signal,
      cache: "no-store",
    });
    if (response.ok) {
      const data = (await response.json()) as SpellNormalizeResult;
      const normalized = String(data.normalized || "").trim();
      if (normalized) {
        return {
          original,
          normalized,
          changed: Boolean(data.changed) || normalized !== original.toLowerCase(),
          engines: data.engines,
        };
      }
    }
  } catch {
    /* fallback local */
  }

  const local = normalizeChatSpelling(original);
  return {
    original,
    normalized: local || original,
    changed: local !== original.toLowerCase(),
    engines: { fuse_local: true },
  };
}
