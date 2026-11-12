import ExcelJS from "exceljs";
import type { InventarioRow } from "@/lib/supabase";

export type ChatExportFile = {
  name: string;
  mime: string;
  dataUrl: string;
  rowCount: number;
  /** Título visible en la tarjeta (sin .xlsx). */
  label: string;
};

const COLUMNS: Array<{ key: keyof InventarioRow; header: string; width: number }> = [
  { key: "etiqueta", header: "ETIQUETA", width: 14 },
  { key: "articulo", header: "ARTÍCULO", width: 32 },
  { key: "marca", header: "MARCA", width: 16 },
  { key: "modelo", header: "MODELO", width: 16 },
  { key: "serie", header: "SERIE", width: 18 },
  { key: "area", header: "ÁREA", width: 28 },
  { key: "persona", header: "PERSONA", width: 28 },
  { key: "cantidad", header: "CANTIDAD", width: 10 },
  { key: "estado", header: "ESTADO", width: 12 },
  { key: "origen", header: "ORIGEN", width: 14 },
];

export function slugExportPart(raw: string, max = 64): string {
  return (
    String(raw || "")
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_")
      .slice(0, max) || "Inventario"
  );
}

function cleanDisplayPart(raw: string, max = 72): string {
  return (
    String(raw || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max) || "Inventario"
  );
}

/** Título de tarjeta: "Inventario Valencia Camacho Cristina" / "Inventario Oficina 1". */
export function buildExportDisplayName(input: {
  focus?: string | null;
  kind?: string | null;
  index?: number | null;
}): string {
  if (input.focus) {
    const focus = cleanDisplayPart(input.focus);
    if (/^inventario\b/i.test(focus)) return focus;
    return `Inventario ${focus}`;
  }
  if (input.kind) {
    const kind = cleanDisplayPart(input.kind);
    if (input.index != null && Number.isFinite(input.index)) {
      return `Inventario ${kind} ${input.index}`;
    }
    return `Inventario ${kind}`;
  }
  if (input.index != null && Number.isFinite(input.index)) {
    return `Inventario ${input.index}`;
  }
  return "Inventario";
}

/** Nombre de archivo .xlsx a partir del título visible. */
export function buildExportFileName(input: {
  focus?: string | null;
  kind?: string | null;
  count?: number;
  suffix?: string | null;
  index?: number | null;
}): string {
  const display = buildExportDisplayName(input);
  const base = slugExportPart(display);
  const extras: string[] = [];
  if (input.count != null && Number.isFinite(input.count) && !/registros?/i.test(display)) {
    extras.push(`${input.count}_registros`);
  }
  if (input.suffix) extras.push(slugExportPart(input.suffix, 20));
  return extras.length ? `${base}_${extras.join("_")}.xlsx` : `${base}.xlsx`;
}

function cellValue(row: InventarioRow, key: keyof InventarioRow): string | number {
  const val = row[key];
  if (val == null) return "";
  if (typeof val === "number") return val;
  return String(val);
}

export async function buildInventarioExcelFile(
  rows: InventarioRow[],
  opts: {
    focus?: string | null;
    kind?: string | null;
    sheetName?: string;
    suffix?: string | null;
    index?: number | null;
  } = {},
): Promise<ChatExportFile> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Asistente de Inventario";
  workbook.created = new Date();
  const label = buildExportDisplayName({
    focus: opts.focus,
    kind: opts.kind,
    index: opts.index,
  });
  const sheet = workbook.addWorksheet(
    (opts.sheetName || label).slice(0, 31) || "Inventario",
  );
  sheet.columns = COLUMNS.map((col) => ({
    header: col.header,
    key: col.key,
    width: col.width,
  }));
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: "middle" };

  for (const row of rows) {
    const data: Record<string, string | number> = {};
    for (const col of COLUMNS) {
      data[col.key] = cellValue(row, col.key);
    }
    sheet.addRow(data);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer as ArrayBuffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const base64 =
    typeof btoa !== "undefined"
      ? btoa(binary)
      : Buffer.from(bytes).toString("base64");
  const mime =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const name = buildExportFileName({
    focus: opts.focus,
    kind: opts.kind,
    count: rows.length,
    suffix: opts.suffix,
    index: opts.index,
  });
  return {
    name,
    mime,
    dataUrl: `data:${mime};base64,${base64}`,
    rowCount: rows.length,
    label,
  };
}

/** Varios Excel con nombres referentes (Oficina 1, Oficina 2…). */
export async function buildInventarioExcelFiles(
  groups: Array<{
    rows: InventarioRow[];
    focus?: string;
    kind?: string;
    index?: number;
  }>,
): Promise<ChatExportFile[]> {
  const files: ChatExportFile[] = [];
  for (const group of groups) {
    if (!group.rows.length) continue;
    files.push(
      await buildInventarioExcelFile(group.rows, {
        focus: group.focus,
        kind: group.kind,
        index: group.index,
      }),
    );
  }
  return files;
}

export type ExcelExportAsk = {
  count: number;
  /** Tema libre del nombre (“oficina”, “biblioteca”…). */
  theme: string | null;
  /** Quiere el listado de la consulta / persona / área previa. */
  fromContext: boolean;
};

/**
 * Detecta pedidos tipo “dame un excel…”, “3 excel de oficinas…”.
 */
export function detectExcelExportAsk(userText: string): ExcelExportAsk | null {
  const raw = String(userText || "").trim();
  if (!raw) return null;
  const n = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/\b(excel|xlsx|xls|csv|hoja de calculo|spreadsheet)\b/.test(n)) {
    return null;
  }
  // Importar/subir no es exportar.
  if (
    /\b(importar|subir|cargar|adjuntar|pasa(?:rme)?)\b/.test(n) &&
    !/\b(exportar|descargar|genera|generar|dame|muestra|crear|crea|haz|armar)\b/.test(
      n,
    )
  ) {
    return null;
  }

  let count = 1;
  const countMatch =
    n.match(
      /\b(\d{1,2})\s*(excel|xlsx|xls|csv|archivos?|inventarios?)\b/,
    ) ||
    n.match(
      /\b(excel|xlsx|xls|csv|archivos?|inventarios?)\s*(\d{1,2})\b/,
    );
  if (countMatch) {
    const num = Number(countMatch[1] || countMatch[2]);
    if (Number.isFinite(num) && num >= 1) count = Math.min(12, num);
  } else if (
    /\b(tres)\s+(excel|xlsx|archivos|inventarios)\b/.test(n) ||
    /\b(excel|xlsx|archivos|inventarios)\s+(tres)\b/.test(n)
  ) {
    count = 3;
  } else if (
    /\b(dos)\s+(excel|xlsx|archivos|inventarios)\b/.test(n) ||
    /\b(excel|xlsx|archivos|inventarios)\s+(dos)\b/.test(n)
  ) {
    count = 2;
  }

  const fromContext =
    /\b(esta|este|esa|ese|estos|estas|esa persona|esta persona|esos|esas|anteriores?|de arriba|consulta|resultado)\b/.test(
      n,
    ) ||
    /\b(persona|personas|registros?)\b/.test(n);

  let theme: string | null = null;
  const themeMatch = n.match(
    /\b(?:de|del|para|con)\s+(?:los?\s+)?(?:inventarios?\s+(?:de\s+)?)?(oficina|oficinas|biblioteca|laboratorio|bodega|almacen|aula|salas?)\b/,
  );
  if (themeMatch) {
    const t = themeMatch[1];
    theme = t.endsWith("s") && t !== "salas" ? t.replace(/s$/, "") : t;
    if (theme === "oficina" || theme === "oficinas") theme = "Oficina";
    else theme = theme.charAt(0).toUpperCase() + theme.slice(1);
  } else if (/\boficin/.test(n)) {
    theme = "Oficina";
  }

  return { count, theme, fromContext };
}
