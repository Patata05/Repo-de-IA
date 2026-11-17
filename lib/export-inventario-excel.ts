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
  /**
   * Origen concreto: “excel del inventario 3” → Inventario 3.
   * Si viene, NO usar el visor/ficha previa (evita exportar 1 registro).
   */
  origen: string | null;
};

/**
 * Detecta pedidos explícitos de DESCARGAR/EXPORTAR Excel (solo clasificación).
 * La vista previa + confirmación viven en el backend (preparar/confirmar_exportacion_excel).
 * Panorama/resumen con alias xlsx|excel N → NO exportar.
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

  // Panorama / resumen ≠ exportar (aunque digan xlsx 2).
  if (
    /\b(panorama|panorma|resumen|dashboard|totales?|conteo|cuantos?|cuantas?)\b/.test(
      n,
    ) &&
    !/\b(exportar?|descargar?|bajar|descarga)\b/.test(n)
  ) {
    return null;
  }

  if (!/\b(excel|xlsx|xls|csv|hoja de calculo|spreadsheet|archivo)\b/.test(n)) {
    return null;
  }

  const wantsImport =
    /\b(import\w*|subir\w*|subo|subire|cargar\w*|carga|adjunt\w*|pasarte|mandarte|enviarte|traerte)\b/.test(
      n,
    ) ||
    /\b(como|como)\s+(subo|subir|importo|importar|cargo|cargar|adjunto)\b/.test(n) ||
    /\b(te\s+voy\s+a|voy\s+a|quiero)\b[\s\S]{0,40}\b(subir|importar|cargar|adjuntar|pasar|mandar|enviar)\b/.test(
      n,
    );
  const wantsExportExplicit =
    /\b(exportar?|descargar?|bajar|descarga)\b/.test(n) ||
    /\b(genera|generar|dame|crea|crear|haz|armar|darme)\b[\s\S]{0,32}\b(archivo\s+)?(excel|xlsx|xls|csv)\b/.test(
      n,
    ) ||
    /\b(excel|xlsx|xls|csv)\b[\s\S]{0,32}\b(para\s+descargar|descargable|de\s+descarga)\b/.test(
      n,
    );
  if (wantsImport && !wantsExportExplicit) {
    return null;
  }
  if (!wantsExportExplicit) {
    return null;
  }

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
  let origen: string | null = null;
  // xlsx/xls/csv/ecel N → excel N (origen real), no “N archivos”.
  const fileOrigenMatch = n.match(
    /\b(excel|xlsx|xls|csv|ecel|exel)e?s?\s*(\d+|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/,
  );
  if (fileOrigenMatch) {
    const rawNum = fileOrigenMatch[2];
    const num = /^\d+$/.test(rawNum) ? Number(rawNum) : wordNum[rawNum];
    if (num && Number.isFinite(num)) origen = `excel ${num}`;
  }
  const origenMatch = n.match(
    /\b(?:al)?(?:inventari[oa]?s?|invenatrio|invetario|inevtario|inventar[ioa]*)\s*(\d+|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\b/,
  );
  if (!origen && origenMatch) {
    const rawNum = origenMatch[1];
    const num = /^\d+$/.test(rawNum) ? Number(rawNum) : wordNum[rawNum];
    if (num && Number.isFinite(num)) origen = `Inventario ${num}`;
  }

  let count = 1;
  if (!origen) {
    const countMatch = n.match(
      /\b(\d{1,2})\s*(excel|xlsx|xls|csv|archivos?|inventarios?)\b/,
    );
    if (countMatch) {
      const num = Number(countMatch[1]);
      if (Number.isFinite(num) && num >= 1) count = Math.min(12, num);
    } else if (/\b(tres)\s+(excel|xlsx|archivos|inventarios)\b/.test(n)) {
      count = 3;
    } else if (/\b(dos)\s+(excel|xlsx|archivos|inventarios)\b/.test(n)) {
      count = 2;
    }
  }

  const fromContext =
    !origen &&
    (/\b(su|sus)\s+(excel|xlsx|xls|csv|archivo|hoja)\b/.test(n) ||
      /\b(excel|xlsx|xls|csv)\s+(de\s+)?(el|ella|su|sus)\b/.test(n) ||
      /\b(esta|este|esa|ese|estos|estas|esa persona|esta persona|esos|esas|anteriores?|de arriba|consulta|resultado)\b/.test(
        n,
      ) ||
      /\b(de\s+esa|de\s+esta|de\s+ese|de\s+este)\b/.test(n));

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

  return { count, theme, fromContext, origen };
}

/** @deprecated Pendiente local eliminado: la confirmación es del backend. */
export function hasPendingExcelExport(): boolean {
  return false;
}

/** @deprecated Pendiente local eliminado: la confirmación es del backend. */
export function clearPendingExcelExport(): void {
  /* no-op */
}
