"use client";

import { memo, useLayoutEffect, useMemo, useState } from "react";
import { ChevronRight, Layers, QrCode } from "lucide-react";
import type { ChatApiItem, ChatQrPayload } from "@/lib/chat-api";
import type { InventarioRow } from "@/lib/supabase";

export type ChatViewerQr = ChatQrPayload & { dataUrl?: string };

const QR_PREVIEW_LIMIT = 7;
/** Preview en el recuadro: llena el alto colapsado; Ver más muestra el resto. */
const RESULT_PREVIEW_LIMIT = 8;

export type ChatViewerOverview =
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

/** Avisa al sync del chat que el panel cambió de tamaño (Mostrar más/menos). */
function notifyViewerLayout() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("chat-viewer-layout"));
}

type ChatViewerProps = {
  inventory: InventarioRow[];
  resultItems?: ChatApiItem[];
  qrCards?: ChatViewerQr[];
  /** Resumen pedido en el chat (no se muestra en la bienvenida). */
  overview?: ChatViewerOverview;
  /** Nombre de área (u otro foco) para incidencias concretas. */
  overviewFocus?: string;
  onSelectItem?: (item: ChatApiItem | InventarioRow) => void;
  onSelectAreaOption?: (areaName: string) => void;
  onSelectPersonOption?: (personName: string) => void;
};

function textOf(value: unknown) {
  return String(value ?? "").trim();
}

function foldText(value: unknown) {
  return textOf(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isInactiveEstado(value: unknown) {
  const v = textOf(value).toLowerCase();
  return v === "inactivo" || v === "baja" || v === "no" || v === "inactive";
}

function matchesFocus(value: string, focusNorm: string) {
  if (!value || !focusNorm) return false;
  if (value === focusNorm || value.includes(focusNorm)) return true;
  const focusToks = focusNorm.split(" ").filter(Boolean);
  const toks = value.split(" ").filter(Boolean);
  return focusToks.length > 0 && focusToks.every((tok) => toks.includes(tok));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("es-MX").format(value);
}

function inventoryLabel(items: Array<{ origen?: string | null }>) {
  const origins = [
    ...new Set(items.map((item) => textOf(item.origen)).filter(Boolean)),
  ];
  if (origins.length === 1) return origins[0];
  if (origins.length > 1) return `${origins.length} inventarios`;
  return "Inventario";
}

function parseMatchesFocus(rawFocus: string): {
  label: string;
  explicitCandidates: string[];
} {
  const raw = textOf(rawFocus);
  const sepIdx = raw.indexOf("::");
  if (sepIdx === -1) {
    return { label: raw, explicitCandidates: [] };
  }
  const label = raw.slice(0, sepIdx).trim() || raw;
  const explicitCandidates = raw
    .slice(sepIdx + 2)
    .split("||")
    .map((s) => s.trim())
    .filter(Boolean);
  return { label, explicitCandidates };
}

function ChatViewer({
  inventory,
  resultItems = [],
  qrCards = [],
  overview,
  overviewFocus,
  onSelectItem,
  onSelectAreaOption,
  onSelectPersonOption,
}: ChatViewerProps) {
  const hasQr = qrCards.some((card) => card.dataUrl || card.text);
  const showOverview = Boolean(overview) && !hasQr;
  const hasResults = !showOverview && (resultItems.length > 0 || hasQr);
  const showStats = overview === "full" || overview === "stats";
  const showAreaTotal = overview === "areaTotal";
  const showAreaMatches = overview === "areaMatches";
  const showPersonTotal = overview === "personTotal";
  const showPersonMatches = overview === "personMatches";
  const showAreas = overview === "full" || overview === "areas";
  const showRecent = overview === "full" || overview === "recent";
  const showPersonas = overview === "personas";
  const showEstado = overview === "estado";
  const showMarcas = overview === "marcas";
  const focusArea = textOf(overviewFocus);
  const parsedFocus = useMemo(() => parseMatchesFocus(focusArea), [focusArea]);
  const [qrExpanded, setQrExpanded] = useState(false);
  const [overviewExpanded, setOverviewExpanded] = useState(false);

  // Antes del paint: evita el parpadeo al expandir en el tope final.
  useLayoutEffect(() => {
    notifyViewerLayout();
  }, [overviewExpanded, qrExpanded]);

  const areaPreviewLimit = 5;
  const personaPreviewLimit = 6;
  const marcaPreviewLimit = 8;
  const recentPreviewLimit = 5;
  const recentLimit = 10;

  const overviewData = useMemo(() => {
    const emptyPairs: Array<[string, number]> = [];
    const emptyAreaMatches: Array<{
      area: string;
      count: number;
      personas: number;
      activos: number;
    }> = [];
    const emptyPersonMatches: Array<{
      persona: string;
      count: number;
      areas: number;
      activos: number;
    }> = [];
    const base = {
      areasSorted: emptyPairs,
      maxArea: 1,
      personasSorted: emptyPairs,
      maxPersona: 1,
      marcasSorted: emptyPairs,
      personaCount: 0,
      activos: 0,
      estadoCounts: { activo: 0, inactivo: 0, otro: 0 },
      estadoTotal: 1,
      areaRows: [] as InventarioRow[],
      areaPersonas: 0,
      areaActivos: 0,
      areaMatches: emptyAreaMatches,
      areaMatchesTotalRows: 0,
      areaMatchesTotalPersonas: 0,
      personRows: [] as InventarioRow[],
      personAreasSorted: emptyPairs,
      maxPersonArea: 1,
      personActivos: 0,
      personAreaLabel: "—",
      personMatches: emptyPersonMatches,
      personMatchesTotalRows: 0,
      recentAll: [] as InventarioRow[],
    };
    if (!overview) return base;

    const focusNorm = foldText(parsedFocus.label || focusArea);

    if (overview === "areaTotal") {
      // Priorizar coincidencia exacta con el nombre canónico del área para evitar
      // sumar sub-áreas (ej. "BIBLIOTECA NUEVA" no debe sumar "BIBLIOTECA NUEVA SALA DE COMPUTO 2").
      const exactRows = focusNorm
        ? inventory.filter((row) => foldText(row.area) === focusNorm)
        : [];
      const areaRows =
        exactRows.length > 0
          ? exactRows
          : focusNorm
            ? inventory.filter((row) => matchesFocus(foldText(row.area), focusNorm))
            : [];
      const people = new Set(
        areaRows.map((row) => textOf(row.persona)).filter(Boolean),
      );
      return {
        ...base,
        areaRows,
        areaPersonas: people.size,
        areaActivos: areaRows.filter((row) => !isInactiveEstado(row.estado)).length,
      };
    }

    if (overview === "areaMatches") {
      const byArea = new Map<string, InventarioRow[]>();
      for (const row of inventory) {
        const area = textOf(row.area);
        if (!area) continue;
        const list = byArea.get(area);
        if (list) list.push(row);
        else byArea.set(area, [row]);
      }

      const candidateNames =
        parsedFocus.explicitCandidates.length > 0
          ? parsedFocus.explicitCandidates.filter((name) => byArea.has(name))
          : [...byArea.keys()]
              .filter((area) => matchesFocus(foldText(area), focusNorm))
              .sort((a, b) => (byArea.get(b)?.length ?? 0) - (byArea.get(a)?.length ?? 0));

      const allPeople = new Set<string>();
      let totalRows = 0;
      const areaMatches = candidateNames.map((area) => {
        const rows = byArea.get(area) || [];
        totalRows += rows.length;
        const people = new Set<string>();
        let activos = 0;
        for (const r of rows) {
          const p = textOf(r.persona);
          if (p) {
            people.add(p);
            allPeople.add(p);
          }
          if (!isInactiveEstado(r.estado)) activos += 1;
        }
        return {
          area,
          count: rows.length,
          personas: people.size,
          activos,
        };
      });

      return {
        ...base,
        areaMatches,
        areaMatchesTotalRows: totalRows,
        areaMatchesTotalPersonas: allPeople.size,
      };
    }

    if (overview === "personTotal") {
      const exactRows = focusNorm
        ? inventory.filter((row) => foldText(row.persona) === focusNorm)
        : [];
      const personRows =
        exactRows.length > 0
          ? exactRows
          : focusNorm
            ? inventory.filter((row) =>
                matchesFocus(foldText(row.persona), focusNorm),
              )
            : [];
      const personAreaCounts = new Map<string, number>();
      let personActivos = 0;
      for (const row of personRows) {
        const area = textOf(row.area) || "Sin área";
        personAreaCounts.set(area, (personAreaCounts.get(area) ?? 0) + 1);
        if (!isInactiveEstado(row.estado)) personActivos += 1;
      }
      const personAreasSorted = [...personAreaCounts.entries()].sort(
        (a, b) => b[1] - a[1],
      );
      return {
        ...base,
        personRows,
        personAreasSorted,
        maxPersonArea: personAreasSorted[0]?.[1] || 1,
        personActivos,
        personAreaLabel:
          personAreasSorted.length === 1
            ? personAreasSorted[0][0]
            : personAreasSorted.length
              ? String(personAreasSorted.length)
              : "—",
      };
    }

    if (overview === "personMatches") {
      const byPerson = new Map<string, InventarioRow[]>();
      for (const row of inventory) {
        const persona = textOf(row.persona);
        if (!persona) continue;
        const list = byPerson.get(persona);
        if (list) list.push(row);
        else byPerson.set(persona, [row]);
      }

      const candidateNames =
        parsedFocus.explicitCandidates.length > 0
          ? parsedFocus.explicitCandidates.filter((name) => byPerson.has(name))
          : [...byPerson.keys()]
              .filter((p) => matchesFocus(foldText(p), focusNorm))
              .sort((a, b) => (byPerson.get(b)?.length ?? 0) - (byPerson.get(a)?.length ?? 0));

      let totalRows = 0;
      const personMatches = candidateNames.map((persona) => {
        const rows = byPerson.get(persona) || [];
        totalRows += rows.length;
        const areas = new Set<string>();
        let activos = 0;
        for (const r of rows) {
          const a = textOf(r.area);
          if (a) areas.add(a);
          if (!isInactiveEstado(r.estado)) activos += 1;
        }
        return {
          persona,
          count: rows.length,
          areas: areas.size,
          activos,
        };
      });

      return {
        ...base,
        personMatches,
        personMatchesTotalRows: totalRows,
      };
    }

    if (overview === "recent") {
      return {
        ...base,
        recentAll: [...inventory]
          .sort((a, b) => {
            const ta =
              Date.parse(String(a.updated_at || a.created_at || "")) || 0;
            const tb =
              Date.parse(String(b.updated_at || b.created_at || "")) || 0;
            return tb - ta;
          })
          .slice(0, recentLimit),
      };
    }

    const needAreas = overview === "full" || overview === "areas" || overview === "stats";
    const needPersonas = overview === "personas";
    const needMarcas = overview === "marcas";
    const needEstado = overview === "full" || overview === "stats" || overview === "estado";
    const needRecent = overview === "full";
    const areaCounts = new Map<string, number>();
    const personaCounts = new Map<string, number>();
    const marcaCounts = new Map<string, number>();
    const estadoCounts = { activo: 0, inactivo: 0, otro: 0 };

    for (const row of inventory) {
      if (needAreas) {
        const area = textOf(row.area) || "Sin área";
        areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
      }
      if (needPersonas || overview === "full" || overview === "stats") {
        const persona = textOf(row.persona);
        if (persona) personaCounts.set(persona, (personaCounts.get(persona) ?? 0) + 1);
      }
      if (needMarcas) {
        const marca = textOf(row.marca) || "Sin marca";
        marcaCounts.set(marca, (marcaCounts.get(marca) ?? 0) + 1);
      }
      if (needEstado) {
        const v = textOf(row.estado).toLowerCase();
        if (!v || v === "activo" || v === "active" || v === "si" || v === "sí") {
          estadoCounts.activo += 1;
        } else if (isInactiveEstado(v)) {
          estadoCounts.inactivo += 1;
        } else {
          estadoCounts.otro += 1;
        }
      }
    }

    const areasSorted = needAreas
      ? [...areaCounts.entries()].sort((a, b) => b[1] - a[1])
      : emptyPairs;
    const personasSorted = needPersonas
      ? [...personaCounts.entries()].sort((a, b) => b[1] - a[1])
      : emptyPairs;

    return {
      ...base,
      areasSorted,
      maxArea: areasSorted[0]?.[1] || 1,
      personasSorted,
      maxPersona: personasSorted[0]?.[1] || 1,
      marcasSorted: needMarcas
        ? [...marcaCounts.entries()].sort((a, b) => b[1] - a[1])
        : emptyPairs,
      personaCount: personaCounts.size,
      activos: estadoCounts.activo,
      estadoCounts,
      estadoTotal:
        estadoCounts.activo + estadoCounts.inactivo + estadoCounts.otro || 1,
      recentAll: needRecent
        ? [...inventory]
            .sort((a, b) => {
              const ta =
                Date.parse(String(a.updated_at || a.created_at || "")) || 0;
              const tb =
                Date.parse(String(b.updated_at || b.created_at || "")) || 0;
              return tb - ta;
            })
            .slice(0, recentLimit)
        : [],
    };
  }, [inventory, overview, focusArea]);

  const {
    areasSorted,
    maxArea,
    personasSorted,
    maxPersona,
    marcasSorted,
    personaCount,
    activos,
    estadoCounts,
    estadoTotal,
    areaRows,
    areaPersonas,
    areaActivos,
    areaMatches,
    areaMatchesTotalRows,
    areaMatchesTotalPersonas,
    personRows,
    personAreasSorted,
    maxPersonArea,
    personActivos,
    personAreaLabel,
    personMatches,
    personMatchesTotalRows,
    recentAll,
  } = overviewData;

  const listItems: ChatApiItem[] = hasQr
    ? qrCards.map((card) => {
        const match =
          (card.id != null
            ? resultItems.find((item) => Number(item.id) === Number(card.id))
            : undefined) ||
          resultItems.find(
            (item) =>
              textOf(item.etiqueta).toLowerCase() ===
                textOf(card.etiqueta).toLowerCase() &&
              (!textOf(card.origen) ||
                textOf(item.origen) === textOf(card.origen)),
          ) ||
          inventory.find(
            (row) =>
              textOf(row.etiqueta).toLowerCase() ===
                textOf(card.etiqueta).toLowerCase() &&
              (!textOf(card.origen) ||
                textOf(row.origen) === textOf(card.origen)),
          );
        return {
          id: card.id ?? match?.id ?? null,
          etiqueta: card.etiqueta ?? match?.etiqueta ?? null,
          articulo: card.articulo ?? match?.articulo ?? null,
          persona: card.persona ?? match?.persona ?? null,
          area: card.area ?? match?.area ?? null,
          origen: card.origen ?? match?.origen ?? null,
          marca: match?.marca ?? null,
          modelo: match?.modelo ?? null,
          serie: match?.serie ?? null,
          cantidad: match?.cantidad ?? null,
          estado: match?.estado ?? null,
          observaciones: match?.observaciones ?? null,
        };
      })
    : resultItems.length > 0
      ? resultItems
      : [];

  const personasInResults = [
    ...new Set(listItems.map((item) => textOf(item.persona)).filter(Boolean)),
  ];
  const personLabel =
    personasInResults.length === 1 ? personasInResults[0] : "";

  const displayFocusLabel = parsedFocus.label || focusArea;

  const contextLabel = hasResults
    ? hasQr
      ? personLabel ||
        inventoryLabel(
          resultItems.length
            ? resultItems
            : qrCards.map((card) => ({ origen: null, ...card })),
        )
      : personLabel || displayFocusLabel || "Etiquetas"
    : overview === "areas"
      ? "Áreas"
      : overview === "areaTotal"
        ? displayFocusLabel || "Área"
        : overview === "areaMatches"
          ? `Coincidencias: «${displayFocusLabel || "Área"}»`
          : overview === "personTotal"
            ? displayFocusLabel || "Persona"
            : overview === "personMatches"
              ? `Coincidencias: «${displayFocusLabel || "Persona"}»`
              : overview === "recent"
                ? "Recientes"
                : overview === "stats"
                  ? "Totales"
                  : overview === "personas"
                    ? "Personas"
                    : overview === "estado"
                      ? "Estado"
                      : overview === "marcas"
                        ? "Marcas"
                        : "En el inventario";

  const contextSub = hasResults
    ? hasQr
      ? `${qrCards.length} código${qrCards.length === 1 ? "" : "s"} QR`
      : `${listItems.length} etiqueta${listItems.length === 1 ? "" : "s"}`
    : overview === "areas"
      ? `${areasSorted.length} áreas · distribución`
      : overview === "areaTotal"
        ? listItems.length > 0 && listItems.length < areaRows.length
          ? `Total del área (${formatNumber(areaRows.length)}) · mostrando ${listItems.length} registros`
          : listItems.length > 0
            ? `Total del área · ${formatNumber(areaRows.length)} registros`
            : "Total del área"
        : overview === "areaMatches"
          ? `${areaMatches.length} áreas encontradas (${formatNumber(areaMatchesTotalRows)} registros) · elige cuál consultar`
          : overview === "personTotal"
            ? listItems.length > 0 && listItems.length < personRows.length
              ? `Inventario de la persona (${formatNumber(personRows.length)}) · mostrando ${listItems.length}`
              : "Inventario de la persona"
            : overview === "personMatches"
              ? `${personMatches.length} personas encontradas (${formatNumber(personMatchesTotalRows)} registros) · elige cuál consultar`
              : overview === "recent"
                ? `${recentAll.length} últimos registros`
                : overview === "stats"
                  ? "Conteo en vivo"
                  : overview === "personas"
                    ? `${personasSorted.length} personas con equipo`
                    : overview === "estado"
                      ? "Activos vs inactivos"
                      : overview === "marcas"
                        ? `${marcasSorted.length} marcas`
                        : "Resumen en vivo";

  const renderEmbeddedResultList = (
    itemsToRender: ChatApiItem[],
    totalContextRows: number,
  ) => {
    if (!itemsToRender.length) return null;
    const previewLimit = RESULT_PREVIEW_LIMIT;
    const canCollapseItems = itemsToRender.length > previewLimit;
    const visibleEmbedded =
      canCollapseItems && !qrExpanded
        ? itemsToRender.slice(0, previewLimit)
        : itemsToRender;
    const countLabel = formatNumber(
      totalContextRows > 0 ? totalContextRows : itemsToRender.length,
    );
    const titleLabel =
      totalContextRows > 0 && itemsToRender.length < totalContextRows
        ? `Registros solicitados (${formatNumber(itemsToRender.length)} de ${countLabel})`
        : overview === "personTotal"
          ? `Registros (${countLabel})`
          : `Registros del área (${countLabel})`;
    const cardState = canCollapseItems
      ? qrExpanded
        ? " is-expanded"
        : " is-collapsed"
      : " is-expanded";
    return (
      <section
        className={`chat-viewer-card chat-viewer-records-card${cardState}`}
        aria-label="Registros de la consulta"
      >
        <h3 className="chat-viewer-section-title">{titleLabel}</h3>
        <div
          className={`chat-viewer-expandable${
            qrExpanded ? " is-expanded" : ""
          }`}
        >
          <ul className="chat-viewer-list">
            {visibleEmbedded.map((item, index) => {
              const etiqueta = textOf(item.etiqueta) || `Item ${index + 1}`;
              const articulo = textOf(item.articulo) || "Artículo";
              const marca = textOf(item.marca);
              const marcaLabel =
                marca && !/^(s\/m|sin marca|n\/a)$/i.test(marca)
                  ? ` · ${marca}`
                  : "";
              const persona = textOf(item.persona) || "Sin asignar";
              const area = textOf(item.area);
              return (
                <li key={`${item.id ?? etiqueta}-${index}`}>
                  <button
                    type="button"
                    className="chat-viewer-list-item"
                    onClick={() => onSelectItem?.(item)}
                  >
                    <span className="chat-viewer-badge">{etiqueta}</span>
                    <span className="chat-viewer-list-copy">
                      <strong>
                        {articulo}
                        {marcaLabel}
                      </strong>
                      <span>{[persona, area].filter(Boolean).join(" · ")}</span>
                    </span>
                    <span className="chat-viewer-item-arrow" aria-hidden="true">
                      <ChevronRight size={15} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        {canCollapseItems ? (
          <button
            type="button"
            className="chat-viewer-show-more"
            onClick={() => setQrExpanded((open) => !open)}
          >
            {qrExpanded
              ? "Ver menos"
              : `Ver más (${itemsToRender.length - previewLimit})`}
          </button>
        ) : null}
      </section>
    );
  };

  return (
    <div
      className={`chat-viewer-sync-body${
        overview ? ` is-overview-${overview}` : ""
      }${hasQr ? " is-qr" : ""}${hasResults && !hasQr ? " is-etiquetas" : ""}`}
    >
      <header className="chat-viewer-head">
        <h2 className="chat-viewer-title">{contextLabel}</h2>
        <p className="chat-viewer-sub">{contextSub}</p>
      </header>

      {showOverview ? (
        (() => {
          const areasOnly = overview === "areas";
          const recentOnly = overview === "recent";
          const collapsedAreaLimit = 3;
          const collapsedRecentLimit = 3;
          const canCollapseFull =
            overview === "full" &&
            ((showAreas && areasSorted.length > collapsedAreaLimit) ||
              (showRecent && recentAll.length > collapsedRecentLimit));
          const canCollapseAreas =
            areasOnly && areasSorted.length > areaPreviewLimit;
          const canCollapseRecent =
            recentOnly && recentAll.length > recentPreviewLimit;
          const canCollapsePersonas =
            showPersonas && personasSorted.length > personaPreviewLimit;
          const canCollapseMarcas =
            showMarcas && marcasSorted.length > marcaPreviewLimit;
          const canCollapseOverview =
            canCollapseFull ||
            canCollapseAreas ||
            canCollapseRecent ||
            canCollapsePersonas ||
            canCollapseMarcas;
          const visibleAreas = !showAreas
            ? []
            : areasOnly
              ? overviewExpanded
                ? areasSorted
                : areasSorted.slice(0, areaPreviewLimit)
              : overviewExpanded
                ? areasSorted.slice(0, areaPreviewLimit)
                : areasSorted.slice(0, collapsedAreaLimit);
          const visibleRecent = !showRecent
            ? []
            : recentOnly
              ? overviewExpanded
                ? recentAll
                : recentAll.slice(0, recentPreviewLimit)
              : overviewExpanded
                ? recentAll
                : recentAll.slice(0, collapsedRecentLimit);
          const visiblePersonas = showPersonas
            ? overviewExpanded
              ? personasSorted
              : personasSorted.slice(0, personaPreviewLimit)
            : [];
          const visibleMarcas = showMarcas
            ? overviewExpanded
              ? marcasSorted
              : marcasSorted.slice(0, marcaPreviewLimit)
            : [];
          const moreCount = canCollapseFull
            ? Math.max(0, recentAll.length - collapsedRecentLimit) +
              Math.max(0, areasSorted.length - collapsedAreaLimit)
            : canCollapseRecent
              ? recentAll.length - recentPreviewLimit
              : canCollapseAreas
                ? areasSorted.length - areaPreviewLimit
                : canCollapsePersonas
                  ? personasSorted.length - personaPreviewLimit
                  : canCollapseMarcas
                    ? marcasSorted.length - marcaPreviewLimit
                    : 0;
          const isPersonOrAreaShell =
            overview === "personTotal" || overview === "areaTotal";
          return (
            <>
              <div
                className={`chat-viewer-scroll${
                  isPersonOrAreaShell
                    ? qrExpanded
                      ? " is-expanded is-records-shell"
                      : " is-collapsed is-records-shell"
                    : ""
                }`}
              >
                <div
                  className={`chat-viewer-expandable${
                    overviewExpanded ? " is-expanded" : ""
                  }${isPersonOrAreaShell ? " is-records-shell" : ""}`}
                >
                  {showAreaMatches ? (
                    <>
                      <section
                        className="chat-viewer-card chat-viewer-stats is-hero-stats is-area-total"
                        aria-label={`Coincidencias de ${displayFocusLabel}`}
                      >
                        <div className="chat-viewer-stat">
                          <span className="chat-viewer-stat-label">
                            Incidencias
                          </span>
                          <strong>{formatNumber(areaMatches.length)}</strong>
                        </div>
                        <div className="chat-viewer-stat is-text-value">
                          <span className="chat-viewer-stat-label">
                            Búsqueda
                          </span>
                          <strong title={displayFocusLabel}>
                            {displayFocusLabel}
                          </strong>
                        </div>
                        <div className="chat-viewer-stat">
                          <span className="chat-viewer-stat-label">
                            Registros (suma)
                          </span>
                          <strong>
                            {formatNumber(areaMatchesTotalRows)}
                          </strong>
                        </div>
                        <div className="chat-viewer-stat">
                          <span className="chat-viewer-stat-label">
                            Personas
                          </span>
                          <strong>
                            {formatNumber(areaMatchesTotalPersonas)}
                          </strong>
                        </div>
                      </section>
                      {areaMatches.length ? (
                        <section
                          className="chat-viewer-card"
                          aria-label="Áreas encontradas para desambiguar"
                        >
                          <h3 className="chat-viewer-section-title">
                            Selecciona qué área deseas consultar
                          </h3>
                          <ul className="chat-viewer-list">
                            {areaMatches.map((item, idx) => (
                              <li key={item.area}>
                                <button
                                  type="button"
                                  className="chat-viewer-list-item"
                                  onClick={() => onSelectAreaOption?.(item.area)}
                                  title={`Consultar ${item.area}`}
                                >
                                  <span className="chat-viewer-badge">
                                    Opción {idx + 1}
                                  </span>
                                  <span className="chat-viewer-list-copy">
                                    <strong>{item.area}</strong>
                                    <span>
                                      {formatNumber(item.count)} registro
                                      {item.count === 1 ? "" : "s"} ·{" "}
                                      {formatNumber(item.personas)} persona
                                      {item.personas === 1 ? "" : "s"} ·{" "}
                                      {formatNumber(item.activos)} activo
                                      {item.activos === 1 ? "" : "s"}
                                    </span>
                                  </span>
                                  <span
                                    className="chat-viewer-item-arrow"
                                    aria-hidden="true"
                                  >
                                    <ChevronRight size={15} />
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ) : null}
                    </>
                  ) : null}

                  {showPersonMatches ? (
                    <>
                      <section
                        className="chat-viewer-card chat-viewer-stats is-hero-stats is-area-total is-person-total"
                        aria-label={`Coincidencias de ${displayFocusLabel}`}
                      >
                        <div className="chat-viewer-stat">
                          <span className="chat-viewer-stat-label">
                            Incidencias
                          </span>
                          <strong>{formatNumber(personMatches.length)}</strong>
                        </div>
                        <div className="chat-viewer-stat is-text-value">
                          <span className="chat-viewer-stat-label">
                            Búsqueda
                          </span>
                          <strong title={displayFocusLabel}>
                            {displayFocusLabel}
                          </strong>
                        </div>
                        <div className="chat-viewer-stat">
                          <span className="chat-viewer-stat-label">
                            Registros (suma)
                          </span>
                          <strong>
                            {formatNumber(personMatchesTotalRows)}
                          </strong>
                        </div>
                        <div className="chat-viewer-stat">
                          <span className="chat-viewer-stat-label">
                            Personas
                          </span>
                          <strong>{formatNumber(personMatches.length)}</strong>
                        </div>
                      </section>
                      {personMatches.length ? (
                        <section
                          className="chat-viewer-card"
                          aria-label="Personas encontradas para desambiguar"
                        >
                          <h3 className="chat-viewer-section-title">
                            Selecciona qué persona deseas consultar
                          </h3>
                          <ul className="chat-viewer-list">
                            {personMatches.map((item, idx) => (
                              <li key={item.persona}>
                                <button
                                  type="button"
                                  className="chat-viewer-list-item"
                                  onClick={() =>
                                    onSelectPersonOption?.(item.persona)
                                  }
                                  title={`Consultar ${item.persona}`}
                                >
                                  <span className="chat-viewer-badge">
                                    Opción {idx + 1}
                                  </span>
                                  <span className="chat-viewer-list-copy">
                                    <strong>{item.persona}</strong>
                                    <span>
                                      {formatNumber(item.count)} registro
                                      {item.count === 1 ? "" : "s"} ·{" "}
                                      {formatNumber(item.areas)} área
                                      {item.areas === 1 ? "" : "s"} ·{" "}
                                      {formatNumber(item.activos)} activo
                                      {item.activos === 1 ? "" : "s"}
                                    </span>
                                  </span>
                                  <span
                                    className="chat-viewer-item-arrow"
                                    aria-hidden="true"
                                  >
                                    <ChevronRight size={15} />
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ) : null}
                    </>
                  ) : null}

                  {showAreaTotal && displayFocusLabel ? (
                    <>
                      <section
                        className="chat-viewer-card chat-viewer-stats is-hero-stats is-area-total"
                        aria-label={`Total de ${displayFocusLabel}`}
                      >
                        <div className="chat-viewer-stat">
                          <span className="chat-viewer-stat-label">
                            Registros
                          </span>
                          <strong>{formatNumber(areaRows.length)}</strong>
                        </div>
                        <div className="chat-viewer-stat is-text-value">
                          <span className="chat-viewer-stat-label">Área</span>
                          <strong title={displayFocusLabel}>
                            {displayFocusLabel}
                          </strong>
                        </div>
                        <div className="chat-viewer-stat">
                          <span className="chat-viewer-stat-label">
                            Personas
                          </span>
                          <strong>{formatNumber(areaPersonas)}</strong>
                        </div>
                        <div className="chat-viewer-stat">
                          <span className="chat-viewer-stat-label">
                            Activos
                          </span>
                          <strong>{formatNumber(areaActivos)}</strong>
                        </div>
                      </section>
                      {renderEmbeddedResultList(listItems, areaRows.length)}
                    </>
                  ) : null}

                  {showPersonTotal && displayFocusLabel ? (
                    <>
                      <section
                        className="chat-viewer-card chat-viewer-stats is-hero-stats is-area-total is-person-total"
                        aria-label={`Inventario de ${displayFocusLabel}`}
                      >
                        <div className="chat-viewer-stat">
                          <span className="chat-viewer-stat-label">
                            Registros
                          </span>
                          <strong>{formatNumber(personRows.length)}</strong>
                        </div>
                        <div className="chat-viewer-stat is-text-value">
                          <span className="chat-viewer-stat-label">Persona</span>
                          <strong title={displayFocusLabel}>
                            {displayFocusLabel}
                          </strong>
                        </div>
                        <div
                          className={`chat-viewer-stat${
                            personAreasSorted.length === 1 ? " is-text-value" : ""
                          }`}
                        >
                          <span className="chat-viewer-stat-label">Áreas</span>
                          <strong title={personAreasSorted.map(([a]) => a).join(", ")}>
                            {personAreaLabel}
                          </strong>
                        </div>
                        <div className="chat-viewer-stat">
                          <span className="chat-viewer-stat-label">Activos</span>
                          <strong>{formatNumber(personActivos)}</strong>
                        </div>
                      </section>
                      {personAreasSorted.length ? (
                        <section
                          className="chat-viewer-card"
                          aria-label="Áreas de la persona"
                        >
                          <h3 className="chat-viewer-section-title">
                            Dónde están sus cosas
                          </h3>
                          <ul className="chat-viewer-bars">
                            {personAreasSorted.map(([area, count]) => (
                              <li key={area} className="chat-viewer-bar-row">
                                <div className="chat-viewer-bar-meta">
                                  <span className="chat-viewer-rank-line">
                                    <span>{area}</span>
                                  </span>
                                  <span>{formatNumber(count)}</span>
                                </div>
                                <div className="chat-viewer-bar-track">
                                  <span
                                    className="chat-viewer-bar-fill"
                                    style={{
                                      width: `${Math.max(8, (count / maxPersonArea) * 100)}%`,
                                    }}
                                  />
                                </div>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ) : null}
                      {renderEmbeddedResultList(listItems, personRows.length)}
                    </>
                  ) : null}

                  {showStats ? (
                    <section
                      className={`chat-viewer-card chat-viewer-stats${
                        overview === "stats" ? " is-hero-stats" : ""
                      }`}
                      aria-label="Totales"
                    >
                      <div className="chat-viewer-stat">
                        <span className="chat-viewer-stat-label">Registros</span>
                        <strong>{formatNumber(inventory.length)}</strong>
                      </div>
                      <div className="chat-viewer-stat">
                        <span className="chat-viewer-stat-label">Áreas</span>
                        <strong>{formatNumber(areasSorted.length)}</strong>
                      </div>
                      <div className="chat-viewer-stat">
                        <span className="chat-viewer-stat-label">Personas</span>
                        <strong>{formatNumber(personaCount)}</strong>
                      </div>
                      <div className="chat-viewer-stat">
                        <span className="chat-viewer-stat-label">Activos</span>
                        <strong>{formatNumber(activos)}</strong>
                      </div>
                    </section>
                  ) : null}

                  {showAreas && visibleAreas.length ? (
                    <section
                      className={`chat-viewer-card${
                        areasOnly ? " chat-viewer-areas-hero" : ""
                      }`}
                      aria-label="Áreas"
                    >
                      <h3 className="chat-viewer-section-title">
                        {areasOnly ? "Ranking por área" : "Áreas"}
                      </h3>
                      <ul className="chat-viewer-bars">
                        {visibleAreas.map(([area, count], index) => (
                          <li key={area} className="chat-viewer-bar-row">
                            <div className="chat-viewer-bar-meta">
                              <span className="chat-viewer-rank-line">
                                {areasOnly ? (
                                  <span className="chat-viewer-rank">
                                    {index + 1}
                                  </span>
                                ) : null}
                                <span>{area}</span>
                              </span>
                              <span>{formatNumber(count)}</span>
                            </div>
                            <div className="chat-viewer-bar-track">
                              <span
                                className="chat-viewer-bar-fill"
                                style={{
                                  width: `${Math.max(8, (count / maxArea) * 100)}%`,
                                }}
                              />
                            </div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {showPersonas && visiblePersonas.length ? (
                    <section
                      className="chat-viewer-card chat-viewer-people-hero"
                      aria-label="Personas"
                    >
                      <h3 className="chat-viewer-section-title">
                        Asignaciones
                      </h3>
                      <ul className="chat-viewer-people">
                        {visiblePersonas.map(([persona, count]) => {
                          const initials = persona
                            .split(/\s+/)
                            .filter(Boolean)
                            .slice(0, 2)
                            .map((p) => p[0]?.toUpperCase() || "")
                            .join("");
                          return (
                            <li key={persona} className="chat-viewer-people-row">
                              <span
                                className="chat-viewer-avatar"
                                aria-hidden="true"
                              >
                                {initials || "?"}
                              </span>
                              <span className="chat-viewer-people-copy">
                                <strong>{persona}</strong>
                                <span>
                                  {formatNumber(count)} artículo
                                  {count === 1 ? "" : "s"}
                                </span>
                              </span>
                              <span
                                className="chat-viewer-people-meter"
                                aria-hidden="true"
                              >
                                <span
                                  style={{
                                    width: `${Math.max(10, (count / maxPersona) * 100)}%`,
                                  }}
                                />
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ) : null}

                  {showEstado ? (
                    <section
                      className="chat-viewer-card chat-viewer-estado-hero"
                      aria-label="Estado"
                    >
                      <h3 className="chat-viewer-section-title">Salud</h3>
                      <div className="chat-viewer-estado-split">
                        <div className="chat-viewer-estado-block is-activo">
                          <span className="chat-viewer-stat-label">Activos</span>
                          <strong>
                            {formatNumber(estadoCounts.activo)}
                          </strong>
                          <span className="chat-viewer-estado-pct">
                            {Math.round(
                              (estadoCounts.activo / estadoTotal) * 100,
                            )}
                            %
                          </span>
                        </div>
                        <div className="chat-viewer-estado-block is-inactivo">
                          <span className="chat-viewer-stat-label">
                            Inactivos
                          </span>
                          <strong>
                            {formatNumber(estadoCounts.inactivo)}
                          </strong>
                          <span className="chat-viewer-estado-pct">
                            {Math.round(
                              (estadoCounts.inactivo / estadoTotal) * 100,
                            )}
                            %
                          </span>
                        </div>
                      </div>
                      <div
                        className="chat-viewer-estado-track"
                        aria-hidden="true"
                      >
                        <span
                          className="is-activo"
                          style={{
                            width: `${(estadoCounts.activo / estadoTotal) * 100}%`,
                          }}
                        />
                        <span
                          className="is-inactivo"
                          style={{
                            width: `${(estadoCounts.inactivo / estadoTotal) * 100}%`,
                          }}
                        />
                        {estadoCounts.otro ? (
                          <span
                            className="is-otro"
                            style={{
                              width: `${(estadoCounts.otro / estadoTotal) * 100}%`,
                            }}
                          />
                        ) : null}
                      </div>
                      {estadoCounts.otro ? (
                        <p className="chat-viewer-estado-note">
                          Otros estados: {formatNumber(estadoCounts.otro)}
                        </p>
                      ) : null}
                    </section>
                  ) : null}

                  {showMarcas && visibleMarcas.length ? (
                    <section
                      className="chat-viewer-card chat-viewer-marcas-hero"
                      aria-label="Marcas"
                    >
                      <h3 className="chat-viewer-section-title">Top marcas</h3>
                      <ul className="chat-viewer-chips">
                        {visibleMarcas.map(([marca, count]) => (
                          <li key={marca} className="chat-viewer-chip">
                            <strong>{marca}</strong>
                            <span>{formatNumber(count)}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {visibleRecent.length ? (
                    <section
                      className={`chat-viewer-card${
                        recentOnly ? " chat-viewer-recent-hero" : ""
                      }`}
                      aria-label="Recientes"
                    >
                      <h3 className="chat-viewer-section-title">
                        {recentOnly ? "Últimos movimientos" : "Recientes"}
                      </h3>
                      <ul className="chat-viewer-list">
                        {visibleRecent.map((row, index) => {
                          const etiqueta =
                            textOf(row.etiqueta) || `ID-${row.id ?? index}`;
                          const articulo = textOf(row.articulo) || "Artículo";
                          const marca = textOf(row.marca);
                          const marcaLabel =
                            marca && !/^(s\/m|sin marca|n\/a)$/i.test(marca)
                              ? ` · ${marca}`
                              : "";
                          const persona = textOf(row.persona) || "Sin asignar";
                          const area = textOf(row.area);
                          return (
                            <li key={`${row.id ?? etiqueta}-${index}`}>
                              <button
                                type="button"
                                className="chat-viewer-list-item"
                                onClick={() => onSelectItem?.(row)}
                              >
                                <span className="chat-viewer-badge">
                                  {etiqueta}
                                </span>
                                <span className="chat-viewer-list-copy">
                                  <strong>
                                    {articulo}
                                    {marcaLabel}
                                  </strong>
                                  <span>
                                    {[persona, area].filter(Boolean).join(" · ")}
                                  </span>
                                </span>
                                <span
                                  className="chat-viewer-item-arrow"
                                  aria-hidden="true"
                                >
                                  <ChevronRight size={15} />
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ) : null}
                  {canCollapseOverview ? (
                    <button
                      type="button"
                      className="chat-viewer-show-more"
                      onClick={() => setOverviewExpanded((open) => !open)}
                    >
                      {overviewExpanded
                        ? "Ver menos"
                        : moreCount > 0
                          ? `Ver más (${moreCount})`
                          : "Ver más"}
                    </button>
                  ) : null}
                </div>
              </div>
            </>
          );
        })()
      ) : hasResults ? (
        (() => {
          const previewLimit = hasQr ? QR_PREVIEW_LIMIT : RESULT_PREVIEW_LIMIT;
          const canCollapse = listItems.length > previewLimit;
          const visibleItems =
            canCollapse && !qrExpanded
              ? listItems.slice(0, previewLimit)
              : listItems;
          return (
            <>
              <div
                className={`chat-viewer-scroll${
                  canCollapse
                    ? qrExpanded
                      ? " is-expanded"
                      : " is-collapsed"
                    : " is-expanded"
                }`}
              >
                <section
                  className={`chat-viewer-card${
                    canCollapse
                      ? qrExpanded
                        ? " is-expanded"
                        : " is-collapsed"
                      : " is-expanded"
                  }`}
                  aria-label="Resultados de la consulta"
                >
                  {hasQr ? null : (
                    <h3 className="chat-viewer-section-title">Etiquetas</h3>
                  )}
                  <div
                    className={`chat-viewer-expandable${
                      qrExpanded ? " is-expanded" : ""
                    }`}
                  >
                    <ul className={`chat-viewer-list${hasQr ? " is-qr-links" : ""}`}>
                      {visibleItems.map((item, index) => {
                        const etiqueta =
                          textOf(item.etiqueta) || `Item ${index + 1}`;
                        const articulo = textOf(item.articulo) || "Artículo";
                        const marca = textOf(item.marca);
                        const marcaLabel =
                          marca && !/^(s\/m|sin marca|n\/a)$/i.test(marca)
                            ? ` · ${marca}`
                            : "";
                        const persona = textOf(item.persona) || "Sin asignar";
                        const area = textOf(item.area);
                        const origen = textOf(item.origen) || contextLabel;

                        return (
                          <li key={`${item.id ?? etiqueta}-${index}`}>
                            {hasQr ? (
                              <div className="chat-viewer-list-item has-qr-link">
                                <span className="chat-viewer-item-main">
                                  <span className="chat-viewer-badge">
                                    {etiqueta}
                                  </span>
                                  <span className="chat-viewer-list-copy">
                                    <strong>
                                      {articulo}
                                      {marcaLabel}
                                    </strong>
                                    <span>
                                      {[persona, area]
                                        .filter(Boolean)
                                        .join(" · ") || origen}
                                    </span>
                                    {origen ? (
                                      <span className="chat-viewer-origen">
                                        <Layers size={12} aria-hidden="true" />
                                        {origen}
                                      </span>
                                    ) : null}
                                  </span>
                                </span>
                                <button
                                  type="button"
                                  className="chat-viewer-qr-open"
                                  onClick={() => onSelectItem?.(item)}
                                  title={`Abrir ficha ${etiqueta}`}
                                >
                                  <QrCode size={14} />
                                  <span>QR</span>
                                  <ChevronRight size={16} />
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="chat-viewer-list-item"
                                onClick={() => onSelectItem?.(item)}
                              >
                                <span className="chat-viewer-badge">
                                  {etiqueta}
                                </span>
                                <span className="chat-viewer-list-copy">
                                  <strong>
                                    {articulo}
                                    {marcaLabel}
                                  </strong>
                                  <span>
                                    {[persona, area]
                                      .filter(Boolean)
                                      .join(" · ") || origen}
                                  </span>
                                </span>
                                <span
                                  className="chat-viewer-item-arrow"
                                  aria-hidden="true"
                                >
                                  <ChevronRight size={15} />
                                </span>
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  {canCollapse ? (
                    <button
                      type="button"
                      className="chat-viewer-show-more"
                      onClick={() => setQrExpanded((open) => !open)}
                    >
                      {qrExpanded
                        ? "Ver menos"
                        : `Ver más (${listItems.length - previewLimit})`}
                    </button>
                  ) : null}
                </section>
              </div>
            </>
          );
        })()
      ) : null}
    </div>
  );
}

export default memo(ChatViewer);
