"use client";

import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronRight, Layers, QrCode } from "lucide-react";
import type {
  ChatApiItem,
  ChatComparacionVista,
  ChatQrPayload,
} from "@/lib/chat-api";
import {
  canonicalizeOrigenLabel,
  origensMatch,
} from "@/lib/inventario-origen";
import type { InventarioRow } from "@/lib/supabase";

export type ChatViewerQr = ChatQrPayload & { dataUrl?: string };

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
  | "marcas"
  | "comparacion";

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
  /** Métricas de comparar_inventarios (overview === "comparacion"). */
  comparacion?: ChatComparacionVista | null;
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
  if (value === focusNorm) return true;
  const focusToks = focusNorm.split(" ").filter(Boolean);
  const toks = value.split(" ").filter(Boolean);
  // Agujas cortas (ti, rh): solo como palabra completa, no substring de marketing.
  if (focusNorm.length <= 3 && focusToks.length === 1) {
    return toks.includes(focusNorm);
  }
  if (value.includes(focusNorm)) return true;
  return focusToks.length > 0 && focusToks.every((tok) => toks.includes(tok));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("es-MX").format(value);
}

/** Fila de etiqueta solo informativa (no abre ficha al clic). */
function StaticRecordRow(props: {
  etiqueta: string;
  title: string;
  subtitle: string;
  /** Inventario / origen de esta ficha (Inv 1 vs Inv 3…). */
  origen?: string;
}) {
  return (
    <div className="chat-viewer-list-item is-static">
      <span className="chat-viewer-badge">{props.etiqueta}</span>
      <span className="chat-viewer-list-copy">
        <strong>{props.title}</strong>
        <span>{props.subtitle}</span>
        {props.origen ? (
          <span className="chat-viewer-origen">
            <Layers size={12} aria-hidden="true" />
            {canonicalizeOrigenLabel(props.origen)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function inventoryLabel(items: Array<{ origen?: string | null }>) {
  const origins = [
    ...new Set(
      items
        .map((item) => canonicalizeOrigenLabel(textOf(item.origen)))
        .filter(Boolean),
    ),
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

/** Card con colapso por overflow real (áreas / personas / registros). */
function OverflowCollapseCard(props: {
  className?: string;
  title: ReactNode;
  ariaLabel: string;
  expanded: boolean;
  onToggle: () => void;
  measureKey: string;
  /** Si false, no pone título h3 (p. ej. QR). */
  showTitle?: boolean;
  /** Mantener altura predeterminada aunque el contenido “quepa”. */
  lockCollapsedHeight?: boolean;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [fitsAll, setFitsAll] = useState(false);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;

    if (props.expanded) {
      // Conservar overflows para “Ver menos”.
      return;
    }

    // Medir en modo colapsado (restaura Ver más/Ver menos).
    // Solo al cambiar measureKey/expanded — NO en cada tecla del draft.
    setFitsAll(false);

    let locked = false;
    const measure = () => {
      const node = bodyRef.current;
      if (!node || props.expanded || locked) return;
      const overflow = node.scrollHeight > node.clientHeight + 2;
      locked = true;
      setOverflows(overflow);
      setFitsAll(props.lockCollapsedHeight ? false : !overflow);
      if (!overflow) {
        setHiddenCount(0);
      } else {
        const list = node.querySelector("ul");
        const items = list ? (Array.from(list.children) as HTMLElement[]) : [];
        const limit = node.clientHeight;
        let hidden = 0;
        for (const kid of items) {
          if (kid.offsetTop + kid.offsetHeight > limit + 1) hidden += 1;
        }
        setHiddenCount(hidden > 0 ? hidden : Math.max(1, items.length));
      }
      // Evita bucle RO al cambiar is-fit ↔ is-collapsed.
      requestAnimationFrame(() => {
        locked = false;
      });
    };

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(measure);
    });
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [props.expanded, props.measureKey, props.lockCollapsedHeight]);

  const showToggle = overflows;
  const cardState = props.expanded
    ? " is-expanded"
    : fitsAll && !props.lockCollapsedHeight
      ? " is-fit"
      : " is-collapsed";

  return (
    <section
      className={`chat-viewer-card${props.className || ""}${cardState}`}
      aria-label={props.ariaLabel}
    >
      {props.showTitle === false ? null : (
        <h3 className="chat-viewer-section-title">{props.title}</h3>
      )}
      <div
        ref={bodyRef}
        className={`chat-viewer-expandable is-overflow-body${
          props.expanded ? " is-expanded" : ""
        }`}
      >
        {props.children}
      </div>
      {showToggle ? (
        <button
          type="button"
          className="chat-viewer-show-more"
          onClick={props.onToggle}
        >
          {props.expanded
            ? "Ver menos"
            : hiddenCount > 0
              ? `Ver más (${hiddenCount})`
              : "Ver más"}
        </button>
      ) : null}
    </section>
  );
}

function ChatViewer({
  inventory,
  resultItems = [],
  qrCards = [],
  overview,
  overviewFocus,
  comparacion = null,
  onSelectItem,
  onSelectAreaOption,
  onSelectPersonOption,
}: ChatViewerProps) {
  const hasQr = qrCards.some((card) => card.dataUrl || card.text);
  const showOverview = Boolean(overview) && !hasQr;
  const hasResults = !showOverview && (resultItems.length > 0 || hasQr);
  const showStats = overview === "stats";
  const showFull = overview === "full";
  const showAreaTotal = overview === "areaTotal";
  const showAreaMatches = overview === "areaMatches";
  const showPersonTotal = overview === "personTotal";
  const showPersonMatches = overview === "personMatches";
  const showAreas = overview === "areas";
  const showRecent = overview === "recent";
  const showPersonas = overview === "personas";
  const showEstado = overview === "estado";
  const showMarcas = overview === "marcas";
  const showComparacion = overview === "comparacion";
  const focusArea = textOf(overviewFocus);
  const parsedFocus = useMemo(() => parseMatchesFocus(focusArea), [focusArea]);
  const [qrExpanded, setQrExpanded] = useState(false);

  // Antes del paint: evita el parpadeo al expandir en el tope final.
  useLayoutEffect(() => {
    notifyViewerLayout();
  }, [qrExpanded, overview]);

  useLayoutEffect(() => {
    setQrExpanded(false);
  }, [overview, overviewFocus, resultItems.length, comparacion]);

  /** Recientes: mismos 10 que escribe el chatbot. */
  const recentLimit = 10;
  /** Overviews con scroll interno (sin botón Ver más por overflow).
   *  `full` usa el layout persona (áreas + registros, sin barra).
   *  `recent` NO: usa OverflowCollapseCard + altura fija como Etiquetas. */
  const scrollOnlyOverview =
    overview === "stats" ||
    overview === "marcas" ||
    overview === "estado" ||
    overview === "comparacion";
  // “areas”, “personas”, “recent” y etiquetas usan Ver más si no caben.

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
      scopedTotal: inventory.length,
    };
    if (!overview) return base;

    const focusNorm = foldText(parsedFocus.label || focusArea);

    // Listado del chat (preview import / “esos 10 en qué áreas”) → stats desde resultItems.
    // Ranking global overview==="areas" SIN foco: siempre TODO el inventario (no 1 área previa).
    const focusLabel = String(parsedFocus.label || focusArea || "").trim();
    const todoInventarioFocus =
      /^(todo el inventario|en el inventario|general)$/i.test(focusLabel);
    const globalAreasRanking =
      overview === "areas" && !focusLabel;
    // Panorama “Todo el inventario”: métricas del inventario real, no de la muestra (12).
    const scopedFromChat =
      !globalAreasRanking &&
      !todoInventarioFocus &&
      Array.isArray(resultItems) &&
      resultItems.length > 0 &&
      (overview === "areas" ||
        overview === "personas" ||
        overview === "estado" ||
        overview === "marcas" ||
        overview === "stats" ||
        overview === "full");

    // Inventario N / área concreta en panorama-general (no persona/área total).
    const scopeRows = (() => {
      if (scopedFromChat) {
        const byId = new Map(
          inventory
            .filter((r) => r.id != null)
            .map((r) => [Number(r.id), r] as const),
        );
        const rows: InventarioRow[] = [];
        const seen = new Set<string>();
        for (const it of resultItems) {
          const id = it.id != null ? Number(it.id) : NaN;
          const et = String(it.etiqueta ?? "").trim().toLowerCase();
          const origenWant = String(it.origen ?? "").trim();
          const key =
            Number.isFinite(id) && id > 0
              ? `id:${id}`
              : et
                ? `et:${et}:${origenWant || "_"}`
                : "";
          if (!key || seen.has(key)) continue;
          seen.add(key);
          const byExactId =
            Number.isFinite(id) && id > 0 ? byId.get(id) : undefined;
          const byEtiquetaOrigen =
            et &&
            inventory.find(
              (r) =>
                String(r.etiqueta ?? "").trim().toLowerCase() === et &&
                (!origenWant ||
                  String(r.origen ?? "").trim() === origenWant),
            );
          // Preview de import (sin id en DB): usar resultItems, no otra fila homónima.
          const hit =
            byExactId ||
            byEtiquetaOrigen ||
            (!origenWant && et
              ? inventory.find(
                  (r) => String(r.etiqueta ?? "").trim().toLowerCase() === et,
                )
              : undefined);
          if (hit) rows.push(hit);
          else if (it) {
            rows.push(it as InventarioRow);
          }
        }
        if (rows.length) return rows;
      }
      if (
        !focusNorm ||
        overview === "areaTotal" ||
        overview === "areaMatches" ||
        overview === "personTotal" ||
        overview === "personMatches"
      ) {
        return inventory;
      }
      const byOrigen = inventory.filter((row) =>
        focusNorm
          ? origensMatch(String(row.origen ?? ""), focusArea) ||
            foldText(row.origen) === focusNorm
          : false,
      );
      if (byOrigen.length) return byOrigen;
      const byArea = inventory.filter((row) => foldText(row.area) === focusNorm);
      if (byArea.length) return byArea;
      return inventory;
    })();

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
        recentAll: [...scopeRows]
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

    for (const row of scopeRows) {
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
        ? overview === "full"
          ? scopedFromChat && resultItems.length
            ? scopeRows.slice(0, Math.min(scopeRows.length, 80))
            : [...scopeRows]
                .sort((a, b) => {
                  const ta =
                    Date.parse(String(a.updated_at || a.created_at || "")) || 0;
                  const tb =
                    Date.parse(String(b.updated_at || b.created_at || "")) || 0;
                  return tb - ta;
                })
                .slice(0, Math.min(scopeRows.length, 80))
          : [...scopeRows]
              .sort((a, b) => {
                const ta =
                  Date.parse(String(a.updated_at || a.created_at || "")) || 0;
                const tb =
                  Date.parse(String(b.updated_at || b.created_at || "")) || 0;
                return tb - ta;
              })
              .slice(0, recentLimit)
        : [],
      scopedTotal: scopeRows.length,
    };
  }, [
    inventory,
    resultItems,
    overview,
    focusArea,
    parsedFocus.label,
    parsedFocus.explicitCandidates,
    recentLimit,
  ]);

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
    scopedTotal,
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
  const resultOrigins = [
    ...new Set(
      listItems
        .map((item) => canonicalizeOrigenLabel(textOf(item.origen)))
        .filter(Boolean),
    ),
  ];
  const multiInventario = resultOrigins.length > 1;
  const sameEtiquetaMulti =
    multiInventario &&
    new Set(
      listItems.map((item) => textOf(item.etiqueta).toLowerCase()).filter(Boolean),
    ).size === 1;

  const displayFocusLabel = canonicalizeOrigenLabel(
    parsedFocus.label || focusArea,
  );

  const comparacionTitulo =
    textOf(comparacion?.titulo) ||
    (Array.isArray(comparacion?.origenes) && comparacion!.origenes!.length === 2
      ? `Comparativa: ${comparacion!.origenes![0]} vs ${comparacion!.origenes![1]}`
      : "Comparativa General");
  const comparacionInvCount = Array.isArray(comparacion?.inventarios)
    ? comparacion!.inventarios!.length
    : 0;

  const contextLabel = hasResults
    ? hasQr
      ? personLabel ||
        inventoryLabel(
          resultItems.length
            ? resultItems
            : qrCards.map((card) => ({ origen: null, ...card })),
        )
      : multiInventario
        ? sameEtiquetaMulti
          ? `Etiqueta ${textOf(listItems[0]?.etiqueta) || ""} · ${resultOrigins.length} inventarios`
          : inventoryLabel(listItems)
        : personLabel || displayFocusLabel || "Etiquetas"
    : overview === "comparacion"
      ? comparacionTitulo
      : overview === "areas"
      ? resultItems.length > 0
        ? "Áreas del listado"
        : "Áreas"
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
                  ? displayFocusLabel || "Vista previa"
                  : overview === "personas"
                    ? resultItems.length > 0
                      ? "Personas del listado"
                      : "Personas"
                    : overview === "estado"
                      ? "Estado"
                      : overview === "marcas"
                        ? "Marcas"
                        : overview === "full"
                          ? displayFocusLabel || "En el inventario"
                          : displayFocusLabel || "En el inventario";

  const contextSub = hasResults
    ? hasQr
      ? `${qrCards.length} código${qrCards.length === 1 ? "" : "s"} QR`
      : multiInventario
        ? `${listItems.length} ficha${listItems.length === 1 ? "" : "s"} · ${resultOrigins.join(" · ")}`
        : `${listItems.length} etiqueta${listItems.length === 1 ? "" : "s"}`
    : overview === "comparacion"
      ? `${formatNumber(comparacionInvCount)} inventarios · métricas`
      : overview === "areas"
      ? resultItems.length > 0
        ? `${areasSorted.length} áreas · ${resultItems.length} del listado`
        : `${areasSorted.length} áreas · distribución`
      : overview === "areaTotal"
        ? listItems.length > 0 && listItems.length < areaRows.length
          ? `Total del área (${formatNumber(areaRows.length)}) · mostrando ${listItems.length} registros`
          : listItems.length > 0
            ? `Total del área · ${formatNumber(areaRows.length)} registros`
            : "Total del área"
        : overview === "areaMatches"
          ? `${areaMatches.length} áreas encontradas (${formatNumber(areaMatchesTotalRows)} registros) · elige cuál consultar`
          : overview === "personTotal"
            ? personRows.length
              ? `Inventario de la persona · ${formatNumber(personRows.length)} registros`
              : "Inventario de la persona"
            : overview === "personMatches"
              ? `${personMatches.length} personas encontradas (${formatNumber(personMatchesTotalRows)} registros) · elige cuál consultar`
              : overview === "recent"
                ? `${recentAll.length} últimos registros`
                : overview === "stats"
                  ? resultItems.length > 0
                    ? `${formatNumber(scopedTotal || resultItems.length)} registros · vista previa`
                    : "Conteo en vivo"
                  : overview === "full" && resultItems.length > 0
                    ? `${formatNumber(scopedTotal || resultItems.length)} registros · vista previa`
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
    const countLabel = formatNumber(
      totalContextRows > 0 ? totalContextRows : itemsToRender.length,
    );
    const titleLabel =
      totalContextRows > 0 && itemsToRender.length < totalContextRows
        ? `Registros solicitados (${formatNumber(itemsToRender.length)} de ${countLabel})`
        : overview === "personTotal"
          ? `Registros (${countLabel})`
          : `Registros del área (${countLabel})`;
    return (
      <OverflowCollapseCard
        className=" chat-viewer-records-card"
        title={titleLabel}
        ariaLabel="Registros de la consulta"
        expanded={qrExpanded}
        onToggle={() => setQrExpanded((open) => !open)}
        measureKey={`embed:${itemsToRender.length}:${overview || ""}`}
      >
        <ul className="chat-viewer-list">
          {itemsToRender.map((item, index) => {
            const etiqueta = textOf(item.etiqueta) || `Item ${index + 1}`;
            const articulo = textOf(item.articulo) || "Artículo";
            const marca = textOf(item.marca);
            const marcaLabel =
              marca && !/^(s\/m|sin marca|n\/a)$/i.test(marca)
                ? ` · ${marca}`
                : "";
            const persona = textOf(item.persona) || "Sin asignar";
            const area = textOf(item.area);
            const origen = canonicalizeOrigenLabel(textOf(item.origen));
            return (
              <li key={`${item.id ?? etiqueta}-${origen}-${index}`}>
                <StaticRecordRow
                  etiqueta={etiqueta}
                  title={`${articulo}${marcaLabel}`}
                  subtitle={[persona, area].filter(Boolean).join(" · ")}
                  origen={origen || undefined}
                />
              </li>
            );
          })}
        </ul>
      </OverflowCollapseCard>
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
          const visibleAreas = showAreas ? areasSorted : [];
          const visibleRecent = showRecent ? recentAll : [];
          const personasOnly = overview === "personas";
          const visiblePersonas = showPersonas ? personasSorted : [];
          const visibleMarcas = showMarcas ? marcasSorted : [];
          const isPersonOrAreaShell =
            overview === "personTotal" ||
            overview === "areaTotal" ||
            overview === "full";
          const isMatchesShell =
            overview === "areaMatches" || overview === "personMatches";
          const isScrollShell =
            isPersonOrAreaShell || isMatchesShell || scrollOnlyOverview;
          return (
            <>
              <div
                className={`chat-viewer-scroll${
                  isScrollShell
                    ? " is-expanded is-records-shell"
                    : ""
                }`}
              >
                <div
                  className={`chat-viewer-expandable is-expanded${
                    isScrollShell ? " is-records-shell" : ""
                  }${scrollOnlyOverview ? " is-overview-scroll-shell" : ""}`}
                >
                  {showComparacion && comparacion ? (
                    (() => {
                      const FALLBACK_COLORS = [
                        "#2dd4bf",
                        "#38bdf8",
                        "#a78bfa",
                        "#fbbf24",
                      ];
                      const invs = Array.isArray(comparacion.inventarios)
                        ? comparacion.inventarios
                        : [];
                      const names = invs
                        .map(
                          (i, idx) =>
                            textOf(i.nombre) ||
                            textOf(i.origen) ||
                            `Inventario ${idx + 1}`,
                        )
                        .filter(Boolean);
                      const colorByName = new Map<string, string>();
                      invs.forEach((inv, idx) => {
                        const name =
                          textOf(inv.nombre) ||
                          textOf(inv.origen) ||
                          names[idx];
                        colorByName.set(
                          name,
                          textOf(inv.color) ||
                            FALLBACK_COLORS[idx % FALLBACK_COLORS.length],
                        );
                      });
                      const compartidas = Number(
                        comparacion.resumen_cruces?.etiquetas_compartidas ??
                          comparacion.cruces?.compartidas ??
                          0,
                      );
                      const exclusivas =
                        comparacion.resumen_cruces
                          ?.exclusivas_por_inventario ||
                        comparacion.cruces?.solo_en ||
                        {};
                      const areasRaw = Array.isArray(
                        comparacion.comparativa_areas,
                      )
                        ? comparacion.comparativa_areas
                        : Array.isArray(comparacion.por_area)
                          ? comparacion.por_area
                          : [];
                      const areasNorm = areasRaw
                        .map((row) => {
                          const area = textOf(row.area) || "Sin área";
                          const raw =
                            row.valores || row.totales || ({} as Record<string, number>);
                          const valores: Record<string, number> = {};
                          for (const n of names) {
                            valores[n] = Number(raw[n] ?? 0);
                          }
                          const suma = names.reduce(
                            (acc, n) => acc + Number(valores[n] || 0),
                            0,
                          );
                          return { area, valores, suma };
                        })
                        .sort(
                          (a, b) =>
                            b.suma - a.suma ||
                            a.area.localeCompare(b.area, "es", {
                              sensitivity: "base",
                            }),
                        );
                      const maxBar = Math.max(
                        1,
                        ...areasNorm.flatMap((a) =>
                          names.map((n) => Number(a.valores[n] || 0)),
                        ),
                      );
                      const topVol = [...invs].sort(
                        (a, b) =>
                          Number(
                            b.total_articulos ?? b.registros ?? 0,
                          ) -
                          Number(a.total_articulos ?? a.registros ?? 0),
                      )[0];
                      const topName =
                        textOf(topVol?.nombre) ||
                        textOf(topVol?.origen) ||
                        "—";
                      const topCount = Number(
                        topVol?.total_articulos ?? topVol?.registros ?? 0,
                      );

                      return (
                        <div className="chat-viewer-person-layout chat-viewer-comparacion">
                          <section
                            className="chat-viewer-card is-comparacion-grid"
                            aria-label="Tarjetas de inventarios"
                          >
                            {invs.map((inv, idx) => {
                              const name =
                                textOf(inv.nombre) ||
                                textOf(inv.origen) ||
                                `Inventario ${idx + 1}`;
                              const color =
                                textOf(inv.color) ||
                                FALLBACK_COLORS[idx % FALLBACK_COLORS.length];
                              const total = Number(
                                inv.total_articulos ?? inv.registros ?? 0,
                              );
                              const activos = Number(inv.activos ?? 0);
                              const personas = Number(
                                inv.total_personas ?? inv.personas ?? 0,
                              );
                              return (
                                <div
                                  key={`${name}-${idx}`}
                                  className="chat-viewer-comparacion-card"
                                  style={{
                                    borderColor: `${color}55`,
                                    boxShadow: `inset 3px 0 0 ${color}`,
                                  }}
                                >
                                  <div className="chat-viewer-comparacion-card-head">
                                    <span
                                      className="chat-viewer-comparacion-dot"
                                      style={{ background: color }}
                                      aria-hidden
                                    />
                                    <strong
                                      className="chat-viewer-comparacion-name"
                                      title={name}
                                    >
                                      {name}
                                    </strong>
                                  </div>
                                  <div className="chat-viewer-comparacion-metrics">
                                    <div className="chat-viewer-stat">
                                      <span className="chat-viewer-stat-label">
                                        Artículos
                                      </span>
                                      <strong>{formatNumber(total)}</strong>
                                    </div>
                                    <div className="chat-viewer-stat">
                                      <span className="chat-viewer-stat-label">
                                        Activos
                                      </span>
                                      <strong>{formatNumber(activos)}</strong>
                                    </div>
                                    <div className="chat-viewer-stat">
                                      <span className="chat-viewer-stat-label">
                                        Personas
                                      </span>
                                      <strong>{formatNumber(personas)}</strong>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </section>

                          {areasNorm.length ? (
                            <section
                              className="chat-viewer-card chat-viewer-comparacion-chart-card"
                              aria-label="Gráfica comparativa por área"
                            >
                              <h3 className="chat-viewer-section-title">
                                Comparativa por área
                              </h3>
                              <ul
                                className="chat-viewer-comparacion-legend"
                                aria-label="Leyenda"
                              >
                                {names.map((n) => (
                                  <li key={`leg-${n}`}>
                                    <span
                                      className="chat-viewer-comparacion-dot"
                                      style={{
                                        background:
                                          colorByName.get(n) ||
                                          FALLBACK_COLORS[0],
                                      }}
                                    />
                                    {n}
                                  </li>
                                ))}
                              </ul>
                              <div className="chat-viewer-comparacion-chart">
                                {areasNorm.map((row) => (
                                  <div
                                    key={row.area}
                                    className="chat-viewer-comparacion-chart-row"
                                  >
                                    <div
                                      className="chat-viewer-comparacion-chart-label"
                                      title={row.area}
                                    >
                                      {row.area}
                                    </div>
                                    <div className="chat-viewer-comparacion-chart-group">
                                      {names.map((n) => {
                                        const val = Number(row.valores[n] || 0);
                                        const pct = Math.max(
                                          val > 0 ? 6 : 0,
                                          Math.round((val / maxBar) * 100),
                                        );
                                        const color =
                                          colorByName.get(n) ||
                                          FALLBACK_COLORS[0];
                                        return (
                                          <div
                                            key={`${row.area}-${n}`}
                                            className="chat-viewer-comparacion-bar-wrap"
                                          >
                                            <div
                                              className="chat-viewer-comparacion-bar"
                                              style={{
                                                width: `${pct}%`,
                                                background: color,
                                              }}
                                              aria-label={`${n}: ${val}`}
                                            >
                                              <span className="chat-viewer-comparacion-tooltip">
                                                {n}: {formatNumber(val)}
                                              </span>
                                            </div>
                                            <span className="chat-viewer-comparacion-bar-val">
                                              {formatNumber(val)}
                                            </span>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </section>
                          ) : null}

                          <section
                            className="chat-viewer-card chat-viewer-comparacion-didactic"
                            aria-label="Resumen didáctico"
                          >
                            <p>
                              Coinciden{" "}
                              <strong>{formatNumber(compartidas)}</strong>{" "}
                              etiqueta
                              {compartidas === 1 ? "" : "s"} entre los
                              inventarios
                              {names.length
                                ? ` (${names
                                    .map(
                                      (n) =>
                                        `${formatNumber(Number(exclusivas[n] || 0))} solo en ${n}`,
                                    )
                                    .join("; ")})`
                                : ""}
                              . Mayor volumen:{" "}
                              <strong>{topName}</strong> (
                              {formatNumber(topCount)} artículos).
                            </p>
                          </section>
                        </div>
                      );
                    })()
                  ) : null}

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
                                  onMouseDown={(e) => e.preventDefault()}
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
                                  onMouseDown={(e) => e.preventDefault()}
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
                    (() => {
                      const areaList: ChatApiItem[] = areaRows.length
                        ? (areaRows as ChatApiItem[])
                        : listItems;
                      return (
                        <div className="chat-viewer-person-layout">
                          <section
                            className="chat-viewer-card chat-viewer-stats is-area-total is-compact"
                            aria-label={`Total de ${displayFocusLabel}`}
                          >
                            <div className="chat-viewer-stat">
                              <span className="chat-viewer-stat-label">
                                Registros
                              </span>
                              <strong>
                                {formatNumber(
                                  areaRows.length || areaList.length,
                                )}
                              </strong>
                            </div>
                            <div className="chat-viewer-stat">
                              <span className="chat-viewer-stat-label">
                                Personas
                              </span>
                              <strong>{formatNumber(areaPersonas)}</strong>
                            </div>
                            <div className="chat-viewer-stat is-text-value">
                              <span className="chat-viewer-stat-label">
                                Área
                              </span>
                              <strong title={displayFocusLabel}>
                                {displayFocusLabel}
                              </strong>
                            </div>
                            <div className="chat-viewer-stat">
                              <span className="chat-viewer-stat-label">
                                Activos
                              </span>
                              <strong>{formatNumber(areaActivos)}</strong>
                            </div>
                          </section>

                          <section
                            className="chat-viewer-card chat-viewer-records-card"
                            aria-label="Registros del área"
                          >
                            <h3 className="chat-viewer-section-title">
                              Registros (
                              {formatNumber(
                                areaRows.length || areaList.length,
                              )}
                              )
                            </h3>
                            <div className="chat-viewer-expandable is-expanded">
                              <ul className="chat-viewer-list">
                                {areaList.map((item, index) => {
                                  const etiqueta =
                                    textOf(item.etiqueta) ||
                                    `Item ${index + 1}`;
                                  const articulo =
                                    textOf(item.articulo) || "Artículo";
                                  const marca = textOf(item.marca);
                                  const marcaLabel =
                                    marca &&
                                    !/^(s\/m|sin marca|n\/a)$/i.test(marca)
                                      ? ` · ${marca}`
                                      : "";
                                  const persona =
                                    textOf(item.persona) || "Sin asignar";
                                  return (
                                    <li
                                      key={`${item.id ?? etiqueta}-${index}`}
                                    >
                                      <StaticRecordRow
                                        etiqueta={etiqueta}
                                        title={`${articulo}${marcaLabel}`}
                                        subtitle={
                                          persona +
                                          (displayFocusLabel
                                            ? ` · ${displayFocusLabel}`
                                            : "")
                                        }
                                      />
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          </section>
                        </div>
                      );
                    })()
                  ) : null}

                  {showFull ? (
                    (() => {
                      const fullList: ChatApiItem[] =
                        recentAll.length > 0
                          ? (recentAll as ChatApiItem[])
                          : listItems;
                      const fullMaxArea = maxArea || 1;
                      return (
                        <div className="chat-viewer-person-layout">
                          <section
                            className="chat-viewer-card chat-viewer-stats is-person-total is-compact"
                            aria-label={
                              displayFocusLabel
                                ? `Resumen de ${displayFocusLabel}`
                                : "Resumen del inventario"
                            }
                          >
                            <div className="chat-viewer-stat">
                              <span className="chat-viewer-stat-label">
                                Registros
                              </span>
                              <strong>{formatNumber(scopedTotal)}</strong>
                            </div>
                            <div className="chat-viewer-stat">
                              <span className="chat-viewer-stat-label">
                                Áreas
                              </span>
                              <strong>{formatNumber(areasSorted.length)}</strong>
                            </div>
                            <div className="chat-viewer-stat">
                              <span className="chat-viewer-stat-label">
                                Personas
                              </span>
                              <strong>{formatNumber(personaCount)}</strong>
                            </div>
                            <div className="chat-viewer-stat">
                              <span className="chat-viewer-stat-label">
                                Activos
                              </span>
                              <strong>{formatNumber(activos)}</strong>
                            </div>
                          </section>

                          <div className="chat-viewer-person-split">
                            <section
                              className="chat-viewer-card chat-viewer-person-areas"
                              aria-label="Áreas"
                            >
                              <h3 className="chat-viewer-section-title">
                                Áreas
                              </h3>
                              <ul className="chat-viewer-bars">
                                {areasSorted.map(([area, count]) => (
                                  <li
                                    key={area}
                                    className="chat-viewer-bar-row"
                                  >
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
                                          width: `${Math.max(
                                            8,
                                            (count / fullMaxArea) * 100,
                                          )}%`,
                                        }}
                                      />
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            </section>

                            <section
                              className="chat-viewer-card chat-viewer-records-card"
                              aria-label="Registros"
                            >
                              <h3 className="chat-viewer-section-title">
                                Registros (
                                {formatNumber(
                                  scopedTotal > 0 ? scopedTotal : fullList.length,
                                )}
                                )
                              </h3>
                              <div className="chat-viewer-expandable is-expanded">
                                <ul className="chat-viewer-list">
                                  {fullList.map((item, index) => {
                                    const etiqueta =
                                      textOf(item.etiqueta) ||
                                      `Item ${index + 1}`;
                                    const articulo =
                                      textOf(item.articulo) || "Artículo";
                                    const marca = textOf(item.marca);
                                    const marcaLabel =
                                      marca &&
                                      !/^(s\/m|sin marca|n\/a)$/i.test(marca)
                                        ? ` · ${marca}`
                                        : "";
                                    const persona =
                                      textOf(item.persona) || "Sin asignar";
                                    const area = textOf(item.area);
                                    return (
                                      <li
                                        key={`${item.id ?? etiqueta}-${index}`}
                                      >
                                        <StaticRecordRow
                                          etiqueta={etiqueta}
                                          title={`${articulo}${marcaLabel}`}
                                          subtitle={[persona, area]
                                            .filter(Boolean)
                                            .join(" · ")}
                                        />
                                      </li>
                                    );
                                  })}
                                </ul>
                              </div>
                            </section>
                          </div>
                        </div>
                      );
                    })()
                  ) : null}

                  {showPersonTotal && displayFocusLabel ? (
                    (() => {
                      const personList: ChatApiItem[] = personRows.length
                        ? (personRows as ChatApiItem[])
                        : listItems;
                      return (
                        <div className="chat-viewer-person-layout">
                          <section
                            className="chat-viewer-card chat-viewer-stats is-person-total is-compact"
                            aria-label={`Inventario de ${displayFocusLabel}`}
                          >
                            <div className="chat-viewer-stat">
                              <span className="chat-viewer-stat-label">
                                Registros
                              </span>
                              <strong>
                                {formatNumber(personRows.length || personList.length)}
                              </strong>
                            </div>
                            <div className="chat-viewer-stat">
                              <span className="chat-viewer-stat-label">
                                Áreas
                              </span>
                              <strong
                                title={personAreasSorted
                                  .map(([a]) => a)
                                  .join(", ")}
                              >
                                {personAreaLabel}
                              </strong>
                            </div>
                            <div className="chat-viewer-stat is-text-value">
                              <span className="chat-viewer-stat-label">
                                Persona
                              </span>
                              <strong title={displayFocusLabel}>
                                {displayFocusLabel}
                              </strong>
                            </div>
                            <div className="chat-viewer-stat">
                              <span className="chat-viewer-stat-label">
                                Activos
                              </span>
                              <strong>{formatNumber(personActivos)}</strong>
                            </div>
                          </section>

                          <div className="chat-viewer-person-split">
                            <section
                              className="chat-viewer-card chat-viewer-person-areas"
                              aria-label="Áreas de la persona"
                            >
                              <h3 className="chat-viewer-section-title">
                                Áreas
                              </h3>
                              <ul className="chat-viewer-bars">
                                {personAreasSorted.map(([area, count]) => (
                                  <li
                                    key={area}
                                    className="chat-viewer-bar-row"
                                  >
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
                                          width: `${Math.max(
                                            8,
                                            (count / maxPersonArea) * 100,
                                          )}%`,
                                        }}
                                      />
                                    </div>
                                  </li>
                                ))}
                              </ul>
                            </section>

                            <section
                              className="chat-viewer-card chat-viewer-records-card"
                              aria-label="Registros de la persona"
                            >
                              <h3 className="chat-viewer-section-title">
                                Registros (
                                {formatNumber(
                                  personRows.length || personList.length,
                                )}
                                )
                              </h3>
                              <div className="chat-viewer-expandable is-expanded">
                                <ul className="chat-viewer-list">
                                  {personList.map((item, index) => {
                                    const etiqueta =
                                      textOf(item.etiqueta) ||
                                      `Item ${index + 1}`;
                                    const articulo =
                                      textOf(item.articulo) || "Artículo";
                                    const marca = textOf(item.marca);
                                    const marcaLabel =
                                      marca &&
                                      !/^(s\/m|sin marca|n\/a)$/i.test(marca)
                                        ? ` · ${marca}`
                                        : "";
                                    const area = textOf(item.area);
                                    return (
                                      <li
                                        key={`${item.id ?? etiqueta}-${index}`}
                                      >
                                        <StaticRecordRow
                                          etiqueta={etiqueta}
                                          title={`${articulo}${marcaLabel}`}
                                          subtitle={area || "Sin área"}
                                        />
                                      </li>
                                    );
                                  })}
                                </ul>
                              </div>
                            </section>
                          </div>
                        </div>
                      );
                    })()
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
                        <strong>{formatNumber(scopedTotal)}</strong>
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

                  {showAreas && areasSorted.length ? (
                    areasOnly ? (
                      <OverflowCollapseCard
                        className=" chat-viewer-areas-hero"
                        title="Ranking por área"
                        ariaLabel="Áreas"
                        expanded={qrExpanded}
                        onToggle={() => setQrExpanded((open) => !open)}
                        measureKey={`areas:${areasSorted.length}`}
                      >
                        <ul className="chat-viewer-bars">
                          {visibleAreas.map(([area, count], index) => (
                            <li key={area} className="chat-viewer-bar-row">
                              <div className="chat-viewer-bar-meta">
                                <span className="chat-viewer-rank-line">
                                  <span className="chat-viewer-rank">
                                    {index + 1}
                                  </span>
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
                      </OverflowCollapseCard>
                    ) : (
                      <section
                        className="chat-viewer-card"
                        aria-label="Áreas"
                      >
                        <h3 className="chat-viewer-section-title">Áreas</h3>
                        <ul className="chat-viewer-bars">
                          {visibleAreas.map(([area, count]) => (
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
                                    width: `${Math.max(8, (count / maxArea) * 100)}%`,
                                  }}
                                />
                              </div>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )
                  ) : null}

                  {showPersonas && personasSorted.length ? (
                    <OverflowCollapseCard
                      className=" chat-viewer-people-hero"
                      title="Asignaciones"
                      ariaLabel="Personas"
                      expanded={qrExpanded}
                      onToggle={() => setQrExpanded((open) => !open)}
                      measureKey={`personas:${personasSorted.length}`}
                    >
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
                              <button
                                type="button"
                                className="chat-viewer-people-hit"
                                onClick={() => onSelectPersonOption?.(persona)}
                              >
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
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </OverflowCollapseCard>
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
                    <OverflowCollapseCard
                      className={` chat-viewer-records-card${
                        recentOnly ? " chat-viewer-recent-hero" : ""
                      }`}
                      title={
                        recentOnly
                          ? "Últimos movimientos"
                          : resultItems.length > 0 && overview === "full"
                            ? `Registros (${formatNumber(visibleRecent.length)}${
                                scopedTotal > visibleRecent.length
                                  ? ` de ${formatNumber(scopedTotal)}`
                                  : ""
                              })`
                            : "Recientes"
                      }
                      ariaLabel="Registros"
                      expanded={qrExpanded}
                      onToggle={() => setQrExpanded((open) => !open)}
                      measureKey={`recent:${visibleRecent.length}:${overviewFocus || ""}`}
                      lockCollapsedHeight={recentOnly}
                    >
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
                              <StaticRecordRow
                                etiqueta={etiqueta}
                                title={`${articulo}${marcaLabel}`}
                                subtitle={[persona, area]
                                  .filter(Boolean)
                                  .join(" · ")}
                              />
                            </li>
                          );
                        })}
                      </ul>
                    </OverflowCollapseCard>
                  ) : null}
                </div>
              </div>
            </>
          );
        })()
      ) : hasResults ? (
        <div
          className={`chat-viewer-scroll${
            qrExpanded ? " is-expanded" : " is-collapsed"
          }`}
        >
          <OverflowCollapseCard
            className=""
            title="Etiquetas"
            ariaLabel="Resultados de la consulta"
            expanded={qrExpanded}
            onToggle={() => setQrExpanded((open) => !open)}
            measureKey={`results:${listItems.length}:${hasQr ? "qr" : "list"}`}
            showTitle={!hasQr}
            lockCollapsedHeight
          >
            <ul className={`chat-viewer-list${hasQr ? " is-qr-links" : ""}`}>
              {listItems.map((item, index) => {
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
                const origen = canonicalizeOrigenLabel(textOf(item.origen));

                return (
                  <li
                    key={`${item.id ?? etiqueta}-${origen || "x"}-${index}`}
                  >
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
                                .join(" · ") ||
                                origen ||
                                "—"}
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
                      <StaticRecordRow
                        etiqueta={etiqueta}
                        title={`${articulo}${marcaLabel}`}
                        subtitle={
                          [persona, area].filter(Boolean).join(" · ") ||
                          "—"
                        }
                        origen={origen || undefined}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </OverflowCollapseCard>
        </div>
      ) : null}
    </div>
  );
}

export default memo(ChatViewer);
