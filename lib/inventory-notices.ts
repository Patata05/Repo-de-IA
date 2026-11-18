/** Avisos locales de inventario (Excel / crear / eliminar). */

export type InventoryNoticeKind =
  | "excel"
  | "inventario_creado"
  | "inventario_eliminado"
  | "inventarios_eliminados";

export type InventoryNotice = {
  id: string;
  kind: InventoryNoticeKind;
  title: string;
  body: string;
  at: number;
};

export const INVENTORY_NOTICES_KEY = "inventario-avisos";
export const MAX_INVENTORY_NOTICES = 40;

export function loadInventoryNotices(): InventoryNotice[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = window.localStorage.getItem(INVENTORY_NOTICES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (row): row is InventoryNotice =>
          Boolean(
            row &&
              typeof row === "object" &&
              typeof (row as InventoryNotice).id === "string" &&
              typeof (row as InventoryNotice).title === "string" &&
              typeof (row as InventoryNotice).body === "string",
          ),
      )
      .slice(0, MAX_INVENTORY_NOTICES);
  } catch {
    return [];
  }
}

export function saveInventoryNotices(list: InventoryNotice[]) {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      INVENTORY_NOTICES_KEY,
      JSON.stringify(list.slice(0, MAX_INVENTORY_NOTICES)),
    );
  } catch {
    /* quota / private mode */
  }
}

export function prependInventoryNotice(
  prev: InventoryNotice[],
  input: {
    kind: InventoryNoticeKind;
    title: string;
    body: string;
  },
): InventoryNotice[] {
  const next: InventoryNotice[] = [
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      kind: input.kind,
      title: String(input.title || "").trim() || "Aviso",
      body: String(input.body || "").trim(),
      at: Date.now(),
    },
    ...prev,
  ].slice(0, MAX_INVENTORY_NOTICES);
  saveInventoryNotices(next);
  return next;
}

export function formatNoticeTime(at: number): string {
  try {
    return new Date(at).toLocaleString("es-MX", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return "";
  }
}
