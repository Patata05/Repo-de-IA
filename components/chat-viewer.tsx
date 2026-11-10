"use client";

import { useLayoutEffect, useState } from "react";
import { ChevronRight, Layers, QrCode } from "lucide-react";
import type { ChatApiItem, ChatQrPayload } from "@/lib/chat-api";
import type { InventarioRow } from "@/lib/supabase";

export type ChatViewerQr = ChatQrPayload & { dataUrl?: string };

const QR_PREVIEW_LIMIT = 3;
const RESULT_PREVIEW_LIMIT = 3;

export type ChatViewerOverview = "full" | "stats" | "areas" | "recent";

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
  onSelectItem?: (item: ChatApiItem | InventarioRow) => void;
};

function textOf(value: unknown) {
  return String(value ?? "").trim();
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

export default function ChatViewer({
  inventory,
  resultItems = [],
  qrCards = [],
  overview,
  onSelectItem,
}: ChatViewerProps) {
  const hasQr = qrCards.some((card) => card.dataUrl || card.text);
  const showOverview = Boolean(overview) && !hasQr;
  const hasResults = !showOverview && (resultItems.length > 0 || hasQr);
  const showStats = overview === "full" || overview === "stats";
  const showAreas = overview === "full" || overview === "areas";
  const showRecent = overview === "full" || overview === "recent";
  const [qrExpanded, setQrExpanded] = useState(false);
  const [overviewExpanded, setOverviewExpanded] = useState(false);

  // Antes del paint: evita el parpadeo al expandir en el tope final.
  useLayoutEffect(() => {
    notifyViewerLayout();
  }, [overviewExpanded, qrExpanded]);

  const areaCounts = new Map<string, number>();
  for (const row of inventory) {
    const area = textOf(row.area) || "Sin área";
    areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
  }
  const areasSorted = [...areaCounts.entries()].sort((a, b) => b[1] - a[1]);
  const areaPreviewLimit = 5;
  const maxArea = areasSorted[0]?.[1] || 1;

  const personas = new Set(
    inventory.map((row) => textOf(row.persona)).filter(Boolean),
  );
  const activos = inventory.filter((row) => {
    const v = textOf(row.estado).toLowerCase();
    return !(v === "inactivo" || v === "baja" || v === "no" || v === "inactive");
  }).length;
  const recentPreviewLimit = 5;
  const recentLimit = 10;
  const recentAll = [...inventory]
    .sort((a, b) => {
      const ta = Date.parse(String(a.updated_at || a.created_at || "")) || 0;
      const tb = Date.parse(String(b.updated_at || b.created_at || "")) || 0;
      return tb - ta;
    })
    .slice(0, recentLimit);

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

  const contextLabel = hasResults
    ? hasQr
      ? personLabel ||
        inventoryLabel(
          resultItems.length
            ? resultItems
            : qrCards.map((card) => ({ origen: null, ...card })),
        )
      : personLabel || "Etiquetas"
    : overview === "areas"
      ? "Áreas"
      : overview === "recent"
        ? "Recientes"
        : overview === "stats"
          ? "Inventario"
          : "En el inventario";

  const contextSub = hasResults
    ? hasQr
      ? `${qrCards.length} código${qrCards.length === 1 ? "" : "s"} QR`
      : `${listItems.length} etiqueta${listItems.length === 1 ? "" : "s"}`
    : overview === "areas"
      ? "Distribución por área"
    : overview === "recent"
      ? `${recentAll.length} últimos registros`
      : overview === "stats"
          ? "Totales"
          : "Resumen en vivo";

  return (
    <div className="chat-viewer-sync-body">
      <header className="chat-viewer-head">
        <h2 className="chat-viewer-title">{contextLabel}</h2>
        <p className="chat-viewer-sub">{contextSub}</p>
      </header>

      {showOverview ? (
        (() => {
          const areasOnly = overview === "areas";
          const recentOnly = overview === "recent";
          // Cerrado: stats + preview (llena el cuadro). Abierto: más detalle.
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
          const canCollapseOverview =
            canCollapseFull || canCollapseAreas || canCollapseRecent;
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
          const moreCount = canCollapseFull
            ? Math.max(0, recentAll.length - collapsedRecentLimit) +
              Math.max(0, areasSorted.length - collapsedAreaLimit)
            : canCollapseRecent
              ? recentAll.length - recentPreviewLimit
              : canCollapseAreas
                ? areasSorted.length - areaPreviewLimit
                : 0;
          return (
            <>
              <div className="chat-viewer-scroll">
                <div
                  className={`chat-viewer-expandable${
                    overviewExpanded ? " is-expanded" : ""
                  }`}
                >
                  {showStats ? (
                    <section
                      className="chat-viewer-card chat-viewer-stats"
                      aria-label="Totales"
                    >
                      <div className="chat-viewer-stat">
                        <span className="chat-viewer-stat-label">Registros</span>
                        <strong>{formatNumber(inventory.length)}</strong>
                      </div>
                      <div className="chat-viewer-stat">
                        <span className="chat-viewer-stat-label">Áreas</span>
                        <strong>{formatNumber(areaCounts.size)}</strong>
                      </div>
                      <div className="chat-viewer-stat">
                        <span className="chat-viewer-stat-label">Personas</span>
                        <strong>{formatNumber(personas.size)}</strong>
                      </div>
                      <div className="chat-viewer-stat">
                        <span className="chat-viewer-stat-label">Activos</span>
                        <strong>{formatNumber(activos)}</strong>
                      </div>
                    </section>
                  ) : null}

                  {showAreas && visibleAreas.length ? (
                    <section className="chat-viewer-card" aria-label="Áreas">
                      <h3 className="chat-viewer-section-title">Áreas</h3>
                      <ul className="chat-viewer-bars">
                        {visibleAreas.map(([area, count]) => (
                          <li key={area} className="chat-viewer-bar-row">
                            <div className="chat-viewer-bar-meta">
                              <span>{area}</span>
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

                  {visibleRecent.length ? (
                    <section className="chat-viewer-card" aria-label="Recientes">
                      <h3 className="chat-viewer-section-title">Recientes</h3>
                      <ul className="chat-viewer-list">
                        {visibleRecent.map((row, index) => {
                          const etiqueta =
                            textOf(row.etiqueta) || `ID-${row.id ?? index}`;
                          const articulo = textOf(row.articulo) || "Artículo";
                          const persona = textOf(row.persona) || "Sin asignar";
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
                                  <strong>{articulo}</strong>
                                  <span>{persona}</span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ) : null}
                </div>
              </div>
              {canCollapseOverview ? (
                <button
                  type="button"
                  className="chat-viewer-show-more"
                  onClick={() => setOverviewExpanded((open) => !open)}
                >
                  {overviewExpanded
                    ? "Mostrar menos"
                    : moreCount > 0
                      ? `Mostrar más (${moreCount})`
                      : "Mostrar más"}
                </button>
              ) : null}
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
              <div className="chat-viewer-scroll">
                <section
                  className="chat-viewer-card"
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
                                    <strong>{articulo}</strong>
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
                                  <strong>{articulo}</strong>
                                  <span>{persona}</span>
                                </span>
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </section>
              </div>
              {canCollapse ? (
                <button
                  type="button"
                  className="chat-viewer-show-more"
                  onClick={() => setQrExpanded((open) => !open)}
                >
                  {qrExpanded
                    ? "Mostrar menos"
                    : `Mostrar más (${listItems.length - previewLimit})`}
                </button>
              ) : null}
            </>
          );
        })()
      ) : null}
    </div>
  );
}
