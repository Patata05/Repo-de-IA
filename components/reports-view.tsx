"use client";

import { startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Boxes,
  Check,
  CheckSquare,
  ChevronDown,
  Copy,
  Download,
  FileText,
  Layers,
  MapPin,
  MinusCircle,
  Package,
  PackageCheck,
  Plus,
  PlusCircle,
  Printer,
  RotateCcw,
  Search,
  Square,
  UserCheck,
  Users,
  X,
} from "lucide-react";
import type { InventarioRow } from "@/lib/supabase";
import ModalPortal from "@/components/modal-portal";
import {
  buildSearchIndex,
  indexMatchesPrepared,
  prepareSearch,
} from "@/lib/inventario-search";

interface ReportsViewProps {
  items: InventarioRow[];
  onSelectProduct?: (item: InventarioRow) => void;
}

type ViewMode = "todos" | "incluidos";

function buildReportTitle(filterArea: string, filterPerson: string, filterOrigen: string) {
  const parts: string[] = [];
  if (filterArea !== "ALL") parts.push(`Área: ${filterArea}`);
  if (filterPerson === "__UNASSIGNED__") parts.push("Solo disponibles (sin asignar)");
  else if (filterPerson === "__ASSIGNED__") parts.push("Solo asignados");
  else if (filterPerson !== "ALL") parts.push(`Asignado a: ${filterPerson}`);
  if (filterOrigen !== "ALL") parts.push(`Origen: ${filterOrigen}`);
  return parts.length ? `Reporte de Inventario · ${parts.join(" · ")}` : "Reporte de Inventario";
}

type ReportSelectOption = {
  value: string;
  label: string;
};

function textOf(val: unknown) {
  return String(val ?? "").trim();
}

function formatNumber(num: number) {
  return new Intl.NumberFormat("es-MX").format(num);
}

function getRowKey(r: InventarioRow, fallbackIndex?: number): string {
  if (r.id !== undefined && r.id !== null) return String(r.id);
  if (r.etiqueta) return `etq-${textOf(r.etiqueta)}::${textOf(r.origen)}`;
  return `idx-${fallbackIndex ?? 0}`;
}

function rowTimestamp(row: InventarioRow): number {
  return (
    Date.parse(String(row.updated_at ?? "")) ||
    Date.parse(String(row.created_at ?? "")) ||
    0
  );
}

/**
 * Conserva una fila por etiqueta+origen (como en BD / Excel).
 * La misma etiqueta en otro origen cuenta aparte.
 */
function dedupeByEtiqueta(rows: InventarioRow[]): InventarioRow[] {
  const byKey = new Map<string, InventarioRow>();
  const withoutEtiqueta: InventarioRow[] = [];

  for (const row of rows) {
    const etq = textOf(row.etiqueta).toLowerCase();
    if (!etq) {
      withoutEtiqueta.push(row);
      continue;
    }
    const key = `${etq}::${textOf(row.origen).toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, row);
      continue;
    }
    const prevScore = rowTimestamp(prev) * 1_000_000 + (Number(prev.id) || 0);
    const nextScore = rowTimestamp(row) * 1_000_000 + (Number(row.id) || 0);
    if (nextScore >= prevScore) byKey.set(key, row);
  }

  const byId = new Map<number, InventarioRow>();
  for (const row of withoutEtiqueta) {
    if (row.id == null) continue;
    const id = Number(row.id);
    if (!byId.has(id)) byId.set(id, row);
  }
  const orphanNoId = withoutEtiqueta.filter((row) => row.id == null);

  return [...byKey.values(), ...byId.values(), ...orphanNoId];
}

function ReportSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: ReportSelectOption[];
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

export default function ReportsView({ items, onSelectProduct }: ReportsViewProps) {
  // Filtros dinámicos
  const [filterArea, setFilterArea] = useState<string>("ALL");
  const [filterPerson, setFilterPerson] = useState<string>("ALL");
  const [filterOrigen, setFilterOrigen] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => {
      startTransition(() => setDebouncedSearch(searchQuery));
    }, 200);
    return () => window.clearTimeout(id);
  }, [searchQuery]);

  const searchIndex = useMemo(() => buildSearchIndex(items), [items]);

  // Modo de visualización de la tabla: "todos" los filtrados o solo los "incluidos"
  const [viewMode, setViewMode] = useState<ViewMode>("todos");

  // Estado de selección individual de productos para el reporte
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => {
    return new Set(items.map((r, i) => getRowKey(r, i)));
  });

  // Modal para agregar productos adicionales
  const [isAddPickerOpen, setIsAddPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");

  // Ancla visual para no perder la posición al seleccionar/deseleccionar
  const listAnchorRef = useRef<HTMLElement | null>(null);
  const pendingAnchorTopRef = useRef<number | null>(null);

  const runKeepingListInView = (action: () => void) => {
    const anchor = listAnchorRef.current;
    pendingAnchorTopRef.current = anchor ? anchor.getBoundingClientRect().top : null;
    action();
  };

  useLayoutEffect(() => {
    if (pendingAnchorTopRef.current === null || !listAnchorRef.current) return;
    const previousTop = pendingAnchorTopRef.current;
    pendingAnchorTopRef.current = null;
    const delta = listAnchorRef.current.getBoundingClientRect().top - previousTop;
    if (Math.abs(delta) > 0.5) {
      window.scrollBy(0, delta);
    }
  });

  // Catálogos únicos existentes para los filtros
  const areasList = useMemo(() => {
    return [...new Set(items.map((i) => textOf(i.area)).filter(Boolean))].sort();
  }, [items]);

  const peopleList = useMemo(() => {
    return [
      ...new Set(
        items
          .filter((row) => {
            if (filterArea !== "ALL" && textOf(row.area) !== filterArea) return false;
            if (filterOrigen !== "ALL" && textOf(row.origen) !== filterOrigen) return false;
            return Boolean(textOf(row.persona));
          })
          .map((row) => textOf(row.persona)),
      ),
    ].sort();
  }, [items, filterArea, filterOrigen]);

  const origenesList = useMemo(() => {
    return [
      ...new Set(
        items
          .filter((row) => {
            if (filterArea !== "ALL" && textOf(row.area) !== filterArea) return false;
            return Boolean(textOf(row.origen));
          })
          .map((row) => textOf(row.origen)),
      ),
    ].sort();
  }, [items, filterArea]);

  useEffect(() => {
    if (
      filterPerson !== "ALL" &&
      filterPerson !== "__ASSIGNED__" &&
      filterPerson !== "__UNASSIGNED__" &&
      !peopleList.includes(filterPerson)
    ) {
      setFilterPerson("ALL");
    }
  }, [peopleList, filterPerson]);

  useEffect(() => {
    if (filterOrigen !== "ALL" && !origenesList.includes(filterOrigen)) {
      setFilterOrigen("ALL");
    }
  }, [origenesList, filterOrigen]);

  const preparedSearch = useMemo(() => prepareSearch(debouncedSearch), [debouncedSearch]);

  // Filtrado de candidatos según filtros de la barra superior
  const candidateItems = useMemo(() => {
    const filteredRows: InventarioRow[] = [];
    for (const entry of searchIndex) {
      const row = entry.row;
      if (filterArea !== "ALL" && textOf(row.area) !== filterArea) continue;
      if (filterPerson === "__UNASSIGNED__") {
        if (textOf(row.persona) !== "") continue;
      } else if (filterPerson === "__ASSIGNED__") {
        if (textOf(row.persona) === "") continue;
      } else if (filterPerson !== "ALL") {
        if (textOf(row.persona) !== filterPerson) continue;
      }
      if (filterOrigen !== "ALL" && textOf(row.origen) !== filterOrigen) continue;
      if (preparedSearch && !indexMatchesPrepared(entry, preparedSearch)) continue;
      filteredRows.push(row);
    }
    return dedupeByEtiqueta(filteredRows);
  }, [searchIndex, filterArea, filterPerson, filterOrigen, preparedSearch]);

  // Al filtrar, el reporte incluye solo lo que coincide con el filtro.
  // Los extras se agregan después con "Añadir productos...".
  useEffect(() => {
    setSelectedKeys(new Set(candidateItems.map((row, index) => getRowKey(row, index))));
  }, [candidateItems]);

  // PRODUCTOS EFECTIVAMENTE INCLUIDOS EN EL REPORTE FINAL
  const reportIncludedItems = useMemo(() => {
    return dedupeByEtiqueta(items.filter((r, i) => selectedKeys.has(getRowKey(r, i))));
  }, [items, selectedKeys]);

  // Items mostrados en la tabla según el modo (todos los candidatos o solo incluidos)
  const displayTableItems = useMemo(() => {
    if (viewMode === "incluidos") {
      return reportIncludedItems;
    }
    return candidateItems;
  }, [viewMode, reportIncludedItems, candidateItems]);

  // Toggle de un producto individual
  const toggleItemSelection = (r: InventarioRow, index?: number) => {
    const key = getRowKey(r, index);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Quitar específicamente del reporte
  const removeItemFromReport = (r: InventarioRow, index?: number) => {
    const key = getRowKey(r, index);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  // Agregar específicamente al reporte
  const addItemToReport = (r: InventarioRow, index?: number) => {
    const key = getRowKey(r, index);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  // Acciones masivas
  const selectAllCandidates = () => {
    runKeepingListInView(() => {
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        candidateItems.forEach((r, i) => next.add(getRowKey(r, i)));
        return next;
      });
    });
  };

  const deselectAllCandidates = () => {
    runKeepingListInView(() => {
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        candidateItems.forEach((r, i) => next.delete(getRowKey(r, i)));
        return next;
      });
    });
  };

  const clearAllReport = () => {
    setSelectedKeys(new Set());
  };

  // Métricas del reporte sobre los PRODUCTOS SELECCIONADOS
  const totalReportRecords = reportIncludedItems.length;
  const totalReportUnits = useMemo(() => {
    return reportIncludedItems.reduce(
      (sum, row) =>
        sum + (typeof row.cantidad === "number" && !isNaN(row.cantidad) ? row.cantidad : 1),
      0
    );
  }, [reportIncludedItems]);

  const assignedCount = useMemo(() => {
    return reportIncludedItems.filter((r) => Boolean(textOf(r.persona))).length;
  }, [reportIncludedItems]);

  const unassignedCount = totalReportRecords - assignedCount;

  // Distribución por Área sobre los seleccionados
  const areaBreakdown = useMemo(() => {
    const map = new Map<string, { count: number; units: number }>();
    for (const r of reportIncludedItems) {
      const area = textOf(r.area) || "Sin área";
      const u = typeof r.cantidad === "number" && !isNaN(r.cantidad) ? r.cantidad : 1;
      const prev = map.get(area) || { count: 0, units: 0 };
      map.set(area, { count: prev.count + 1, units: prev.units + u });
    }
    return [...map.entries()].sort((a, b) => b[1].units - a[1].units);
  }, [reportIncludedItems]);

  // Distribución por Origen sobre los seleccionados
  const origenBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of reportIncludedItems) {
      const orig = textOf(r.origen) || "Compra";
      map.set(orig, (map.get(orig) || 0) + (r.cantidad || 1));
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [reportIncludedItems]);

  // Resetear filtros
  const handleResetFilters = () => {
    setFilterArea("ALL");
    setFilterPerson("ALL");
    setFilterOrigen("ALL");
    setSearchQuery("");
    setDebouncedSearch("");
  };

  // Exportar reporte a CSV (SOLO LOS SELECCIONADOS)
  const handleExportCSV = () => {
    if (!reportIncludedItems.length) {
      alert("No hay ningún artículo seleccionado para exportar.");
      return;
    }

    const headers = [
      "Etiqueta",
      "Artículo",
      "Marca",
      "Modelo",
      "Serie",
      "Área",
      "Persona Asignada",
      "Cantidad",
      "Origen",
      "Observaciones",
      "Fecha Alta",
    ];

    const escapeCsv = (str: unknown) => {
      const val = String(str ?? "").replace(/"/g, '""');
      return `"${val}"`;
    };

    const rows = reportIncludedItems.map((r) => [
      escapeCsv(r.etiqueta),
      escapeCsv(r.articulo),
      escapeCsv(r.marca),
      escapeCsv(r.modelo),
      escapeCsv(r.serie),
      escapeCsv(r.area),
      escapeCsv(r.persona),
      r.cantidad ?? 1,
      escapeCsv(r.origen),
      escapeCsv(r.observaciones),
      escapeCsv(r.created_at ? new Date(r.created_at).toLocaleDateString("es-MX") : ""),
    ]);

    const csvContent =
      "\uFEFF" + [headers.join(","), ...rows.map((row) => row.join(","))].join("\r\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const dateStr = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `reporte_inventario_${dateStr}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Imprimir reporte formal (SOLO LOS SELECCIONADOS)
  const handlePrintReport = () => {
    if (!reportIncludedItems.length) {
      alert("No hay ningún artículo seleccionado para imprimir.");
      return;
    }

    const printWin = window.open("", "_blank", "width=850,height=700");
    if (!printWin) return;

    const dateFormatted = new Intl.DateTimeFormat("es-MX", {
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date());

    const titlePreset = buildReportTitle(filterArea, filterPerson, filterOrigen);

    const rowsHtml = reportIncludedItems
      .map(
        (r, idx) => `
      <tr>
        <td style="text-align:center;">${idx + 1}</td>
        <td><strong>${textOf(r.etiqueta)}</strong></td>
        <td>${textOf(r.articulo)}</td>
        <td>${[textOf(r.marca), textOf(r.modelo)].filter(Boolean).join(" ") || "—"}</td>
        <td>${textOf(r.serie) || "—"}</td>
        <td>${textOf(r.area)}</td>
        <td>${textOf(r.persona) || "<em>Sin asignar</em>"}</td>
        <td style="text-align:center;">${r.cantidad ?? 1}</td>
        <td>${textOf(r.origen) || "Compra"}</td>
      </tr>
    `
      )
      .join("");

    printWin.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>${titlePreset}</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 28px; color: #1e293b; font-size: 12px; }
            .header { border-bottom: 2px solid #334155; padding-bottom: 14px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-start; }
            .header h1 { margin: 0 0 6px 0; font-size: 20px; color: #0f172a; }
            .header p { margin: 0; color: #64748b; font-size: 12px; }
            .meta-box { display: flex; gap: 24px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 18px; margin-bottom: 20px; }
            .meta-item { display: flex; flex-direction: column; }
            .meta-item span { font-size: 10px; color: #64748b; text-transform: uppercase; font-weight: 600; }
            .meta-item strong { font-size: 15px; color: #0f172a; }
            table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
            th { background: #f1f5f9; color: #334155; text-align: left; padding: 8px 10px; font-size: 11px; border-bottom: 1px solid #cbd5e1; }
            td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; font-size: 11.5px; }
            tr:nth-child(even) td { background: #fafafa; }
            .signatures { display: flex; justify-content: space-between; margin-top: 60px; padding: 0 40px; }
            .sig-line { width: 220px; border-top: 1px solid #000; text-align: center; padding-top: 6px; font-size: 11px; }
            @media print { body { padding: 0; } }
          </style>
        </head>
        <body>
          <div class="header">
            <div>
              <h1>${titlePreset}</h1>
              <p>Control y Gestión de Activos de Oficina</p>
            </div>
            <div style="text-align:right;">
              <p><strong>Fecha de emisión:</strong> ${dateFormatted}</p>
              <p>Artículos seleccionados: ${totalReportRecords} | Unidades: ${totalReportUnits}</p>
            </div>
          </div>

          <div class="meta-box">
            <div class="meta-item"><span>Total Artículos</span><strong>${totalReportRecords}</strong></div>
            <div class="meta-item"><span>Unidades Físicas</span><strong>${totalReportUnits}</strong></div>
            <div class="meta-item"><span>Asignados</span><strong>${assignedCount}</strong></div>
            <div class="meta-item"><span>En Stock / Libres</span><strong>${unassignedCount}</strong></div>
          </div>

          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Etiqueta</th>
                <th>Artículo</th>
                <th>Marca / Modelo</th>
                <th>Serie</th>
                <th>Área</th>
                <th>Persona Asignada</th>
                <th style="text-align:center;">Cant.</th>
                <th>Origen</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>

          <div class="signatures">
            <div class="sig-line">Responsable de Inventario<br><small>Nombre y Firma</small></div>
            <div class="sig-line">Recibe / Visto Bueno<br><small>Nombre y Firma</small></div>
          </div>

          <script>
            window.onload = function() { window.print(); };
          </script>
        </body>
      </html>
    `);
    printWin.document.close();
  };

  // Copiar resumen de texto
  const handleCopySummary = async () => {
    const summary = `REPORTE DE INVENTARIO (SELECCIÓN PERSONALIZADA)
Fecha: ${new Date().toLocaleDateString("es-MX")}
Registros seleccionados: ${totalReportRecords}
Unidades físicas: ${totalReportUnits}
Asignados: ${assignedCount} | Stock: ${unassignedCount}

Desglose por área:
${areaBreakdown.map(([area, data]) => `- ${area}: ${data.units} unidades (${data.count} ${data.count === 1 ? "registro" : "registros"})`).join("\n")}
`;
    try {
      await navigator.clipboard.writeText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error(err);
    }
  };

  // Filtrado de productos para el modal "Añadir productos al reporte"
  const pickerCandidates = useMemo(() => {
    const filtered = !pickerSearch.trim()
      ? items
      : items.filter((r) => {
          const q = pickerSearch.toLowerCase().trim();
          return (
            textOf(r.articulo).toLowerCase().includes(q) ||
            textOf(r.etiqueta).toLowerCase().includes(q) ||
            textOf(r.marca).toLowerCase().includes(q) ||
            textOf(r.serie).toLowerCase().includes(q) ||
            textOf(r.area).toLowerCase().includes(q) ||
            textOf(r.persona).toLowerCase().includes(q)
          );
        });

    // Primero los que aún no están en el reporte (para añadirlos con claridad)
    return dedupeByEtiqueta(filtered).sort((a, b) => {
      const aIncluded = selectedKeys.has(getRowKey(a));
      const bIncluded = selectedKeys.has(getRowKey(b));
      if (aIncluded === bIncluded) return 0;
      return aIncluded ? 1 : -1;
    });
  }, [items, pickerSearch, selectedKeys]);

  return (
    <div className="reports-page-container">
      {/* Métricas Resumen del Reporte (Calculadas con los productos seleccionados) */}
      <section className="reports-kpi-grid">
        <article className="stat-card stat-blue">
          <div className="stat-topline">
            <span>Artículos en Reporte</span>
            <span className="stat-icon"><Package size={18} /></span>
          </div>
          <strong>{formatNumber(totalReportRecords)}</strong>
          <small>Artículos que se imprimirán/exportarán</small>
        </article>

        <article className="stat-card stat-teal">
          <div className="stat-topline">
            <span>Unidades Físicas</span>
            <span className="stat-icon"><Boxes size={18} /></span>
          </div>
          <strong>{formatNumber(totalReportUnits)}</strong>
          <small>Suma de existencias calculadas</small>
        </article>

        <article className="stat-card stat-purple">
          <div className="stat-topline">
            <span>Asignados</span>
            <span className="stat-icon"><UserCheck size={18} /></span>
          </div>
          <strong>{formatNumber(assignedCount)}</strong>
          <small>
            {totalReportRecords > 0 ? Math.round((assignedCount / totalReportRecords) * 100) : 0}% en
            resguardo
          </small>
        </article>

        <article className="stat-card stat-amber">
          <div className="stat-topline">
            <span>Disponibles (Stock)</span>
            <span className="stat-icon"><PackageCheck size={18} /></span>
          </div>
          <strong>{formatNumber(unassignedCount)}</strong>
          <small>Sin persona asignada</small>
        </article>
      </section>

      {/* Gráficos de distribución (Calculados con los productos seleccionados) */}
      {totalReportRecords > 0 ? (
        <section className="reports-distribution-grid">
          {/* Distribución por Áreas */}
          <div className="panel report-panel">
            <div className="report-panel-header">
              <h3><MapPin size={16} /> Distribución por Área (En reporte)</h3>
              <span>{areaBreakdown.length} áreas</span>
            </div>
            <div className="report-breakdown-list">
              {areaBreakdown.slice(0, 6).map(([area, data], index) => {
                const totalUnits = Math.max(
                  areaBreakdown.reduce((sum, [, item]) => sum + item.units, 0),
                  1,
                );
                const pct = Math.round((data.units / totalUnits) * 100);
                return (
                  <article key={area} className="breakdown-card tone-blue">
                    <div className="breakdown-card-top">
                      <span className="breakdown-rank">{String(index + 1).padStart(2, "0")}</span>
                      <div className="breakdown-card-copy">
                        <strong>{area}</strong>
                        <small>
                          {formatNumber(data.count)} {data.count === 1 ? "artículo" : "artículos"}
                        </small>
                      </div>
                      <span className="breakdown-pill">{pct}%</span>
                    </div>
                    <div className="breakdown-card-meta">
                      <span>
                        {formatNumber(data.units)} {data.units === 1 ? "unidad" : "unidades"}
                      </span>
                    </div>
                    <div className="breakdown-bar">
                      <div className="breakdown-bar-fill bar-blue" style={{ width: `${pct}%` }} />
                    </div>
                  </article>
                );
              })}
            </div>
          </div>

          {/* Distribución por Origen */}
          <div className="panel report-panel">
            <div className="report-panel-header">
              <h3><Layers size={16} /> Distribución por Origen</h3>
              <span>{origenBreakdown.length} categorías</span>
            </div>
            <div className="report-breakdown-list">
              {origenBreakdown.map(([orig, units], index) => {
                const totalUnits = Math.max(
                  origenBreakdown.reduce((sum, [, value]) => sum + value, 0),
                  1,
                );
                const pct = Math.round((units / totalUnits) * 100);
                return (
                  <article key={orig} className="breakdown-card tone-teal">
                    <div className="breakdown-card-top">
                      <span className="breakdown-rank">{String(index + 1).padStart(2, "0")}</span>
                      <div className="breakdown-card-copy">
                        <strong>{orig}</strong>
                        <small>Origen del inventario</small>
                      </div>
                      <span className="breakdown-pill">{pct}%</span>
                    </div>
                    <div className="breakdown-card-meta">
                      <span>
                        {formatNumber(units)} {units === 1 ? "unidad" : "unidades"}
                      </span>
                    </div>
                    <div className="breakdown-bar">
                      <div className="breakdown-bar-fill bar-teal" style={{ width: `${pct}%` }} />
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      ) : null}

      {/* Barra de Filtros y Herramientas */}
      <section className="reports-filter-panel">
        <div className="reports-filter-grid">
          <ReportSelect
            id="rep-area"
            label="Área / Ubicación"
            value={filterArea}
            onChange={setFilterArea}
            options={[
              { value: "ALL", label: `Todas las áreas (${areasList.length})` },
              ...areasList.map((area) => ({ value: area, label: area })),
            ]}
          />

          <ReportSelect
            id="rep-person"
            label="Asignado a"
            value={filterPerson}
            onChange={setFilterPerson}
            options={[
              { value: "ALL", label: "Todas las asignaciones" },
              { value: "__ASSIGNED__", label: "Solo artículos con asignación" },
              { value: "__UNASSIGNED__", label: "Solo disponibles (Sin asignar)" },
              ...peopleList.map((person) => ({ value: person, label: person })),
            ]}
          />

          <ReportSelect
            id="rep-origen"
            label="Origen"
            value={filterOrigen}
            onChange={setFilterOrigen}
            options={[
              { value: "ALL", label: "Todos los orígenes" },
              ...origenesList.map((origen) => ({ value: origen, label: origen })),
            ]}
          />

          <div className="report-filter-item report-filter-search">
            <label htmlFor="rep-search">Búsqueda rápida</label>
            <div className="report-search-wrap">
              <Search size={15} />
              <input
                id="rep-search"
                placeholder="Ej. Biblioteca, Martinez, mesa, 471776…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery ? (
                <button
                  type="button"
                  className="report-search-clear"
                  onClick={() => {
                    setSearchQuery("");
                    setDebouncedSearch("");
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {/* Acciones del Reporte: Exportar, Imprimir, Reset */}
        <div className="reports-top-actions">
          <button
            type="button"
            className="btn-rep-action"
            onClick={handleResetFilters}
            title="Restablecer todos los filtros"
          >
            <RotateCcw size={15} />
            <span>Restablecer</span>
          </button>

          <button
            type="button"
            className="btn-rep-action"
            onClick={handleCopySummary}
            disabled={totalReportRecords === 0}
            title="Copiar resumen del reporte al portapapeles"
          >
            {copied ? <Check size={15} className="text-teal" /> : <Copy size={15} />}
            <span>{copied ? "Copiado" : "Copiar resumen"}</span>
          </button>

          <button
            type="button"
            className="btn-rep-action"
            onClick={handlePrintReport}
            disabled={totalReportRecords === 0}
            title="Imprimir reporte formal con firmas o guardar como PDF"
          >
            <Printer size={15} />
            <span>Imprimir / PDF ({totalReportRecords})</span>
          </button>

          <button
            type="button"
            className="btn-rep-primary"
            onClick={handleExportCSV}
            disabled={totalReportRecords === 0}
            title="Descargar tabla en formato CSV para Microsoft Excel"
          >
            <Download size={15} />
            <span>Exportar CSV ({totalReportRecords})</span>
          </button>
        </div>
      </section>

      {/* BARRA DE COMPOSICIÓN / CONTROL DE INCLUSIÓN DEL REPORTE */}
      <section
        ref={listAnchorRef}
        className="report-composition-bar"
        aria-label="Control de inclusión de artículos"
      >
        <div className="composition-summary">
          <span className="composition-badge">
            <CheckSquare size={16} />
            <strong>{formatNumber(totalReportRecords)}</strong>
            <span>Registros seleccionados para el reporte</span>
          </span>
          <span className="composition-units-hint">
            ({formatNumber(totalReportUnits)} unidades físicas calculadas)
          </span>
        </div>

        <div className="composition-actions">
          {/* Botón para ver todos vs solo los que se van a reportar */}
          <div className="view-toggle-pill">
            <button
              type="button"
              className={viewMode === "todos" ? "is-active" : ""}
              onClick={() => runKeepingListInView(() => setViewMode("todos"))}
            >
              Todos ({candidateItems.length})
            </button>
            <button
              type="button"
              className={viewMode === "incluidos" ? "is-active" : ""}
              onClick={() => runKeepingListInView(() => setViewMode("incluidos"))}
            >
              Incluidos en reporte ({totalReportRecords})
            </button>
          </div>

          {/* Acciones de selección rápida */}
          <button
            type="button"
            className="btn-composition-tool"
            onClick={selectAllCandidates}
            title="Seleccionar todos los artículos de esta vista"
          >
            <CheckSquare size={14} />
            <span>Seleccionar todos</span>
          </button>

          <button
            type="button"
            className="btn-composition-tool"
            onClick={deselectAllCandidates}
            title="Deseleccionar los artículos de esta vista"
          >
            <Square size={14} />
            <span>Deseleccionar</span>
          </button>

          {/* Botón para agregar productos adicionales al reporte */}
          <button
            type="button"
            className="btn-composition-add"
            onClick={() => {
              setPickerSearch("");
              setIsAddPickerOpen(true);
            }}
            title="Buscar y agregar cualquier otro artículo al reporte"
          >
            <Plus size={14} strokeWidth={2.4} />
            <span>Añadir artículos...</span>
          </button>
        </div>
      </section>

      {/* Alerta si no hay ningún producto seleccionado */}
      {totalReportRecords === 0 ? (
        <div className="modal-alert modal-alert-error" style={{ margin: "0" }}>
          <AlertCircle size={16} />
          <span>
            No has seleccionado ningún artículo para el reporte. Marca las casillas de los artículos
            que deseas incluir para activar la exportación e impresión.
          </span>
        </div>
      ) : null}

      {/* Tabla detallada del reporte con Selección Activa */}
      <section className="panel sheet reports-sheet">
        <div className="sheet-heading">
          <div>
            <h2>
              {viewMode === "incluidos"
                ? `Artículos incluidos en el reporte (${totalReportRecords})`
                : `Artículos disponibles (${candidateItems.length})`}
            </h2>
            <p>
              {viewMode === "incluidos"
                ? "Esta es la lista exacta de artículos que se exportarán en CSV o se imprimirán. Puedes quitar artículos con el botón de la derecha."
                : "Marca o desmarca los artículos para agregarlos o quitarlos del reporte según lo que necesites."}
            </p>
          </div>
        </div>

        <div className="table-wrap" tabIndex={0} aria-label="Tabla de selección para reporte">
          <table>
            <thead>
              <tr>
                <th scope="col" style={{ width: "48px", textAlign: "center" }}>
                  <span className="sr-only">Incluir</span>
                </th>
                <th scope="col">Etiqueta</th>
                <th scope="col" className="col-articulo">Artículo</th>
                <th scope="col" className="col-marca">Marca</th>
                <th scope="col" className="col-modelo">Modelo</th>
                <th scope="col" className="col-serie">Serie</th>
                <th scope="col" className="col-area">Área</th>
                <th scope="col" className="col-persona">Persona Asignada</th>
                <th scope="col" style={{ textAlign: "center" }}>Cantidad</th>
                <th scope="col">Estado en reporte</th>
                <th scope="col" style={{ textAlign: "right" }}>Acción</th>
              </tr>
            </thead>
            <tbody>
              {displayTableItems.map((row, index) => {
                const key = getRowKey(row, index);
                const isIncluded = selectedKeys.has(key);

                return (
                  <tr
                    key={key}
                    className={`report-row ${isIncluded ? "is-included" : "is-excluded"}`}
                  >
                    {/* Checkbox de Inclusión */}
                    <td
                      style={{ textAlign: "center" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleItemSelection(row, index);
                      }}
                    >
                      <button
                        type="button"
                        className={`rep-checkbox-btn ${isIncluded ? "is-checked" : ""}`}
                        aria-label={
                          isIncluded
                            ? `Quitar ${row.articulo} del reporte`
                            : `Incluir ${row.articulo} al reporte`
                        }
                      >
                        {isIncluded ? <Check size={14} strokeWidth={3} /> : null}
                      </button>
                    </td>

                    <td
                      className="etiqueta table-cell-clickable"
                      onClick={() => onSelectProduct?.(row)}
                      title="Ver ficha completa"
                    >
                      {textOf(row.etiqueta) || "—"}
                    </td>

                    <td
                      className="table-cell-clickable col-articulo"
                      onClick={() => onSelectProduct?.(row)}
                      title={textOf(row.articulo) || "Ver ficha completa"}
                    >
                      <strong>{textOf(row.articulo) || "—"}</strong>
                    </td>

                    <td className="col-marca" title={textOf(row.marca) || undefined}>
                      {textOf(row.marca) || "—"}
                    </td>

                    <td className="col-modelo" title={textOf(row.modelo) || undefined}>
                      {textOf(row.modelo) || "—"}
                    </td>

                    <td
                      className="col-serie detail-code"
                      title={textOf(row.serie) || undefined}
                    >
                      {textOf(row.serie) || "—"}
                    </td>

                    <td className="col-area" title={textOf(row.area) || undefined}>
                      <span className="detail-pill pill-area" style={{ fontSize: "11px" }}>
                        {textOf(row.area) || "General"}
                      </span>
                    </td>

                    <td className="col-persona" title={textOf(row.persona) || undefined}>
                      {textOf(row.persona) ? (
                        <span className="person-cell">
                          <span>{textOf(row.persona)}</span>
                        </span>
                      ) : (
                        <span className="empty-text">Disponible / Stock</span>
                      )}
                    </td>

                    <td style={{ textAlign: "center", fontWeight: "600" }}>
                      {row.cantidad ?? 1}
                    </td>

                    <td>
                      {isIncluded ? (
                        <span className="report-status-badge badge-included">
                          <Check size={12} /> Incluido
                        </span>
                      ) : (
                        <span className="report-status-badge badge-excluded">
                          No incluido
                        </span>
                      )}
                    </td>

                    {/* Botón de Acción Directa */}
                    <td style={{ textAlign: "right" }}>
                      {isIncluded ? (
                        <button
                          type="button"
                          className="btn-toggle-row btn-remove-row"
                          onClick={() => removeItemFromReport(row, index)}
                          title="Quitar este artículo del reporte"
                        >
                          <MinusCircle size={14} />
                          <span>Quitar</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn-toggle-row btn-add-row"
                          onClick={() => addItemToReport(row, index)}
                          title="Añadir este artículo al reporte"
                        >
                          <PlusCircle size={14} />
                          <span>Añadir</span>
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}

              {!displayTableItems.length ? (
                <tr>
                  <td className="table-empty" colSpan={11}>
                    {viewMode === "incluidos"
                      ? "Aún no has incluido artículos en el reporte. Puedes seleccionar artículos de la pestaña 'Todos' o usar el botón 'Añadir artículos'."
                      : "No hay artículos que coincidan con los filtros aplicados."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {/* MODAL PARA AGREGAR PRODUCTOS ADICIONALES AL REPORTE */}
      {isAddPickerOpen ? (
        <ModalPortal>
        <div
          className="product-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="picker-title"
        >
          <div className="product-modal-card" style={{ maxWidth: "680px" }}>
            <header className="product-modal-header">
              <div className="product-modal-title-group">
                <div>
                  <h2 id="picker-title">Añadir artículos al reporte</h2>
                  <p>
                    Busca y selecciona cualquier artículo del inventario para incorporarlo al reporte
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="product-modal-close"
                onClick={() => setIsAddPickerOpen(false)}
                aria-label="Cerrar ventana"
              >
                <X size={19} />
              </button>
            </header>

            <div className="product-modal-body" style={{ padding: "18px 24px" }}>
              {/* Buscador interno */}
              <div className="report-search-wrap" style={{ marginBottom: "16px" }}>
                <Search size={15} />
                <input
                  placeholder="Buscar por artículo, etiqueta, serie, área, persona..."
                  value={pickerSearch}
                  onChange={(e) => setPickerSearch(e.target.value)}
                  autoFocus
                />
                {pickerSearch ? (
                  <button
                    type="button"
                    className="report-search-clear"
                    onClick={() => setPickerSearch("")}
                  >
                    ×
                  </button>
                ) : null}
              </div>

              {/* Lista de productos para seleccionar */}
              <div className="picker-items-list">
                {pickerCandidates.map((row, idx) => {
                  const key = getRowKey(row, idx);
                  const isChecked = selectedKeys.has(key);

                  return (
                    <div
                      key={key}
                      className={`picker-row ${isChecked ? "is-selected" : ""}`}
                      onClick={() => toggleItemSelection(row, idx)}
                    >
                      <button
                        type="button"
                        className={`rep-checkbox-btn ${isChecked ? "is-checked" : ""}`}
                      >
                        {isChecked ? <Check size={14} strokeWidth={3} /> : null}
                      </button>

                      <div className="picker-info">
                        <div className="picker-top">
                          <span className="picker-tag">{textOf(row.etiqueta) || "—"}</span>
                          <strong>{textOf(row.articulo)}</strong>
                        </div>
                        <div className="picker-sub">
                          <span>
                            <MapPin size={11} /> {textOf(row.area) || "General"}
                          </span>
                          {textOf(row.persona) ? (
                            <span>
                              <Users size={11} /> {textOf(row.persona)}
                            </span>
                          ) : (
                            <span className="empty-text">Stock</span>
                          )}
                          <span>Cant: {row.cantidad ?? 1}</span>
                        </div>
                      </div>

                      <span className="picker-status">
                        {isChecked ? "Incluido en reporte" : "Hacer clic para añadir"}
                      </span>
                    </div>
                  );
                })}

                {!pickerCandidates.length ? (
                  <p className="table-empty">No se encontraron artículos con esa búsqueda.</p>
                ) : null}
              </div>
            </div>

            <div className="form-footer">
              <span style={{ fontSize: "12px", color: "var(--muted)", marginRight: "auto" }}>
                {totalReportRecords} artículos seleccionados en total
              </span>
              <button
                type="button"
                className="btn-submit"
                onClick={() => setIsAddPickerOpen(false)}
              >
                <span>Listo, aplicar selección</span>
              </button>
            </div>
          </div>
        </div>
        </ModalPortal>
      ) : null}
    </div>
  );
}
