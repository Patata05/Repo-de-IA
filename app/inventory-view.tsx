"use client";

import {
  ArrowUpRight,
  Bell,
  Boxes,
  LayoutDashboard,
  Laptop,
  MapPin,
  MessageCircle,
  Moon,
  Package,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Sun,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { InventarioRow } from "@/lib/supabase";
import AddProductModal from "@/components/add-product-modal";
import ProductDetailModal from "@/components/product-detail-modal";
import ReportsView from "@/components/reports-view";
import { BarChart3 } from "lucide-react";

const COLUMNS = [
  ["etiqueta", "Etiqueta"],
  ["articulo", "Artículo"],
  ["marca", "Marca"],
  ["modelo", "Modelo"],
  ["serie", "Serie"],
  ["area", "Área"],
  ["persona", "Persona"],
  ["cantidad", "Cantidad"],
  ["observaciones", "Observaciones"],
  ["origen", "Origen"],
] as const;

const AVATAR_COLORS = ["#536fd0", "#238d84", "#9d7040", "#815bb1", "#b45468", "#3e788e"];

const RAIL_ITEMS = [
  { id: "inventario", label: "Inventario", icon: LayoutDashboard },
  { id: "personas", label: "Personas", icon: Users },
  { id: "reportes", label: "Reportes", icon: BarChart3 },
  { id: "archivos", label: "Chat", icon: MessageCircle },
  { id: "avisos", label: "Avisos", icon: Bell },
  { id: "equipos", label: "Equipos", icon: Laptop },
  { id: "areas", label: "Áreas", icon: MapPin },
] as const;

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

function buildFolders(rows: InventarioRow[], by: "persona" | "area"): FolderCard[] {
  const groups = new Map<string, InventarioRow[]>();
  for (const row of rows) {
    const name = by === "persona" ? textOf(row.persona) : textOf(row.area) || "General";
    if (!name) continue;
    groups.set(name, [...(groups.get(name) ?? []), row]);
  }

  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "es"))
    .map(([name, group]) => ({
      id: name,
      name,
      people: [...new Set(group.map((row) => textOf(row.persona)).filter(Boolean))],
      rows: group,
    }));
}

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

function SideRail({
  active,
  onChange,
}: {
  active: string;
  onChange: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const leaveTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Ocultar / colapsar automáticamente tras un breve momento inicial (2.2s)
  useEffect(() => {
    const timer = setTimeout(() => {
      setCollapsed(true);
    }, 2200);
    return () => clearTimeout(timer);
  }, []);

  const handleMouseEnter = () => {
    if (leaveTimerRef.current) {
      clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = null;
    }
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    // Tras un breve momento tras quitar el ratón, colapsar de nuevo
    leaveTimerRef.current = setTimeout(() => {
      setIsHovered(false);
    }, 450);
  };

  const isExpanded = !collapsed || isHovered;

  return (
    <aside
      className={`sidebar ${isExpanded ? "is-expanded" : "is-collapsed"}`}
      aria-label="Navegación principal"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleMouseEnter}
      onBlur={handleMouseLeave}
    >
      <a className="brand" href="#inicio" aria-label="Inventario, inicio" title="Inventario">
        <span className="brand-mark" aria-hidden="true">
          <Boxes size={21} strokeWidth={1.8} />
        </span>
        <span className="brand-copy">
          <strong>Inventario</strong>
          <span>Gestión de oficina</span>
        </span>
      </a>
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
                onChange(id);
                if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
                leaveTimerRef.current = setTimeout(() => {
                  setIsHovered(false);
                }, 550);
              }}
            >
              <span className="rail-icon">
                <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
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
    </aside>
  );
}

export default function InventoryView({ rows }: { rows: InventarioRow[] }) {
  const [items, setItems] = useState<InventarioRow[]>(rows);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<InventarioRow | null>(null);

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rail, setRail] = useState("inventario");
  const [draft, setDraft] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [dark, setDark] = useState(true);
  const [messages, setMessages] = useState<
    Array<{ id: number; from: "bot" | "user"; text: string }>
  >([
    {
      id: 1,
      from: "bot",
      text: "Hola. Soy el asistente del inventario. Pregúntame por un equipo, una persona o un área.",
    },
  ]);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const chatId = useRef(2);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setItems(rows);
  }, [rows]);

  const personFolders = useMemo(() => buildFolders(items, "persona"), [items]);
  const areaFolders = useMemo(() => buildFolders(items, "area"), [items]);
  const folders = rail === "areas" ? areaFolders : personFolders;

  const existingAreas = useMemo(() => {
    return [...new Set(items.map((r) => textOf(r.area)).filter(Boolean))].sort();
  }, [items]);

  const existingPeople = useMemo(() => {
    return [...new Set(items.map((r) => textOf(r.persona)).filter(Boolean))].sort();
  }, [items]);

  const visible = useMemo(() => {
    const selected = folders.find((folder) => folder.id === selectedId);
    const scoped = rail === "personas" ? items.filter((row) => textOf(row.persona)) : items;
    const base = selected ? selected.rows.filter((row) => scoped.includes(row)) : scoped;
    const text = query.trim().toLowerCase();
    if (!text) return base;
    return base.filter((row) =>
      COLUMNS.some(([key]) => textOf(row[key]).toLowerCase().includes(text)),
    );
  }, [folders, query, rail, items, selectedId]);

  useEffect(() => {
    const saved = window.localStorage.getItem("inventario-tema") !== "claro";
    document.documentElement.classList.toggle("theme-dark", saved);
    setDark(saved);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("theme-dark", dark);
  }, [dark]);

  useEffect(() => {
    const root = document.documentElement;
    const pauseWhenHidden = () => {
      root.classList.toggle("ambient-paused", document.hidden);
    };

    pauseWhenHidden();
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden);
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
    const log = chatLogRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages, rail]);

  const toggleDark = () => {
    setDark((current) => {
      const next = !current;
      window.localStorage.setItem("inventario-tema", next ? "oscuro" : "claro");
      return next;
    });
  };

  const sendChat = (value: string) => {
    const text = value.trim();
    if (!text) return;
    const userId = chatId.current++;
    const botId = chatId.current++;
    setDraft("");
    setMessages((current) => [
      ...current,
      { id: userId, from: "user", text },
      {
        id: botId,
        from: "bot",
        text: "Anotado. En cuanto esté conectado, voy a buscar eso en el inventario.",
      },
    ]);
  };

  const changeRail = (id: string) => {
    setRail(id);
    setSelectedId(null);
    setInfoOpen(false);
  };

  const handleProductCreated = (newItem: InventarioRow) => {
    setItems((prev) => [newItem, ...prev]);
  };

  const totalUnits = items.reduce(
    (total, row) =>
      total + (typeof row.cantidad === "number" && Number.isFinite(row.cantidad) ? row.cantidad : 0),
    0,
  );
  const assignedCount = items.filter((row) => Boolean(textOf(row.persona))).length;
  const title = RAIL_ITEMS.find((item) => item.id === rail)?.label ?? "Inventario";

  return (
    <div className="app-shell" id="inicio">
      <SideRail active={rail} onChange={changeRail} />
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
            {rail === "archivos" ? (
              <button
                type="button"
                className="chat-info-toggle"
                aria-label={infoOpen ? "Cerrar resumen del inventario" : "Abrir resumen del inventario"}
                aria-expanded={infoOpen}
                aria-controls="inventario-info"
                onClick={() => setInfoOpen((open) => !open)}
              >
                {infoOpen ? <X size={18} /> : <SlidersHorizontal size={18} />}
              </button>
            ) : null}

            {/* Botón para añadir nuevo producto al lado del modo oscuro */}
            <button
              type="button"
              className="btn-add-product"
              aria-label="Añadir nuevo producto"
              onClick={() => setIsAddModalOpen(true)}
              title="Registrar nuevo producto en Supabase"
            >
              <Plus size={17} strokeWidth={2.4} aria-hidden="true" />
              <span>Nuevo producto</span>
            </button>

            {/* Conmutador de modo claro / oscuro */}
            <button
              type="button"
              className="theme-switch"
              aria-pressed={dark}
              aria-label={dark ? "Activar modo claro" : "Activar modo oscuro"}
              onClick={toggleDark}
            >
              {dark ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />}
              <span>{dark ? "Oscuro" : "Claro"}</span>
            </button>
          </div>
        </header>

        <main className="view-panel">
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
                            : "Consulta los equipos registrados."}
              </p>
            </div>
            {rail !== "archivos" && rail !== "avisos" && rail !== "reportes" ? (
              <span className="record-count">
                {formatNumber(visible.length)} {visible.length === 1 ? "registro" : "registros"}
              </span>
            ) : null}
          </div>

          {rail === "inventario" ? (
            <>
              <section className="stats-grid" aria-label="Resumen del inventario">
                <article className="stat-card stat-blue">
                  <div className="stat-topline">
                    <span>Artículos</span>
                    <span className="stat-icon"><Package size={18} aria-hidden="true" /></span>
                  </div>
                  <strong>{formatNumber(items.length)}</strong>
                  <small>Registros en el inventario</small>
                </article>
                <article className="stat-card stat-teal">
                  <div className="stat-topline">
                    <span>Unidades</span>
                    <span className="stat-icon"><Boxes size={18} aria-hidden="true" /></span>
                  </div>
                  <strong>{formatNumber(totalUnits)}</strong>
                  <small>Suma de cantidades registradas</small>
                </article>
                <article className="stat-card stat-amber">
                  <div className="stat-topline">
                    <span>Áreas</span>
                    <span className="stat-icon"><MapPin size={18} aria-hidden="true" /></span>
                  </div>
                  <strong>{formatNumber(areaFolders.length)}</strong>
                  <small>Áreas con artículos</small>
                </article>
                <article className="stat-card stat-purple">
                  <div className="stat-topline">
                    <span>Asignaciones</span>
                    <span className="stat-icon"><Users size={18} aria-hidden="true" /></span>
                  </div>
                  <strong>{formatNumber(assignedCount)}</strong>
                  <small>Artículos con persona asignada</small>
                </article>
              </section>
            </>
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

          {rail === "personas" || rail === "areas" ? (
            <section className="quick-access" aria-label={rail === "areas" ? "Áreas" : "Personas"}>
              <div className="section-heading">
                <h2>{rail === "areas" ? "Áreas" : "Personas"}</h2>
                <span>{formatNumber(folders.length)} grupos</span>
              </div>
              {folders.length ? (
                <div className="quick-grid">
                  {folders.map((folder) => {
                    const selected = selectedId === folder.id;
                    return (
                      <button
                        key={folder.id}
                        type="button"
                        className={selected ? "folder is-active" : "folder"}
                        aria-pressed={selected}
                        onClick={() =>
                          setSelectedId((current) => (current === folder.id ? null : folder.id))
                        }
                      >
                        <span className="folder-icon" aria-hidden="true">
                          {rail === "areas" ? <MapPin size={18} /> : <Users size={18} />}
                        </span>
                        <span className="folder-copy">
                          <strong>{folder.name}</strong>
                          <small>
                            {formatNumber(folder.rows.length)}{" "}
                            {folder.rows.length === 1 ? "artículo" : "artículos"}
                          </small>
                        </span>
                        <Avatars people={folder.people} />
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
            <div className={infoOpen ? "chat-stage is-info-open" : "chat-stage"}>
              <section className="panel chat" aria-label="Chat del inventario">
                <div className="chat-panel-heading">
                  <div className="assistant-mark" aria-hidden="true"><Boxes size={19} /></div>
                  <div>
                    <h2>Asistente de inventario</h2>
                    <p>Consulta la información disponible</p>
                  </div>
                </div>
                <div className="chat-log" ref={chatLogRef} aria-live="polite">
                  {messages.map((message) => (
                    <div
                      className={message.from === "user" ? "chat-row is-user" : "chat-row"}
                      key={message.id}
                    >
                      {message.from === "bot" ? (
                        <span className="chat-mark" aria-hidden="true"><Boxes size={16} /></span>
                      ) : null}
                      <p className="chat-bubble">{message.text}</p>
                    </div>
                  ))}
                </div>
                {messages.length === 1 ? (
                  <div className="chat-suggestions">
                    {["¿Qué tiene Juan Pérez?", "Equipos de Sistemas", "Últimos registros"].map(
                      (idea) => (
                        <button key={idea} type="button" onClick={() => sendChat(idea)}>
                          {idea}
                        </button>
                      ),
                    )}
                  </div>
                ) : null}
                <form
                  className="chat-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    sendChat(draft);
                  }}
                >
                  <input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="Escribe tu pregunta..."
                    aria-label="Mensaje para el asistente"
                  />
                  <button type="submit" aria-label="Enviar mensaje">
                    <ArrowUpRight size={19} aria-hidden="true" />
                  </button>
                </form>
              </section>
              <button
                type="button"
                className="chat-info-backdrop"
                aria-label="Cerrar resumen del inventario"
                onClick={() => setInfoOpen(false)}
              />
              <aside className="panel chat-board" id="inventario-info" aria-label="Resumen del inventario">
                <div className="chat-board-head">
                  <div>
                    <h2>En el inventario</h2>
                    <p>Datos disponibles</p>
                  </div>
                  <button
                    type="button"
                    className="chat-board-close"
                    aria-label="Cerrar resumen del inventario"
                    onClick={() => setInfoOpen(false)}
                  >
                    <X size={17} />
                  </button>
                </div>
                <div className="chat-stats">
                  <article><span>Registros</span><strong>{formatNumber(items.length)}</strong></article>
                  <article><span>Áreas</span><strong>{formatNumber(areaFolders.length)}</strong></article>
                  <article><span>Personas</span><strong>{formatNumber(personFolders.length)}</strong></article>
                </div>
                <section className="chat-block">
                  <h3>Áreas</h3>
                  <ul className="chat-areas">
                    {areaFolders.map((folder) => {
                      const maxArea = Math.max(...areaFolders.map((item) => item.rows.length), 1);
                      return (
                        <li key={folder.id}>
                          <div className="chat-area-top">
                            <strong>{folder.name}</strong>
                            <span>{formatNumber(folder.rows.length)}</span>
                          </div>
                          <span className="chat-meter" aria-hidden="true">
                            <i style={{ width: `${(folder.rows.length / maxArea) * 100}%` }} />
                          </span>
                        </li>
                      );
                    })}
                    {!areaFolders.length ? <li className="chat-empty">No hay áreas registradas.</li> : null}
                  </ul>
                </section>
                <section className="chat-block">
                  <h3>Registros recientes</h3>
                  <ul className="chat-recent">
                    {items.slice(0, 4).map((row, index) => (
                      <li
                        key={row.id ?? row.etiqueta ?? index}
                        className="chat-recent-clickable"
                        onClick={() => setSelectedProduct(row)}
                        title="Ver detalle del producto"
                      >
                        <span>{textOf(row.etiqueta) || "—"}</span>
                        <div>
                          <strong>{textOf(row.articulo) || "Registro"}</strong>
                          <em>{textOf(row.persona) || textOf(row.area) || "—"}</em>
                        </div>
                      </li>
                    ))}
                    {!items.length ? <li className="chat-empty">No hay registros recientes.</li> : null}
                  </ul>
                </section>
              </aside>
            </div>
          ) : null}

          {rail === "reportes" ? (
            <ReportsView items={items} onSelectProduct={setSelectedProduct} />
          ) : null}

          {rail !== "avisos" && rail !== "archivos" && rail !== "reportes" ? (
            <section className="panel sheet" aria-labelledby="table-title">
              <div className="sheet-heading">
                <div>
                  <h2 id="table-title">
                    {rail === "personas"
                      ? "Artículos asignados"
                      : rail === "equipos"
                        ? "Equipos registrados"
                        : "Todos los artículos"}
                  </h2>
                  <p>
                    {formatNumber(visible.length)}{" "}
                    {visible.length === 1 ? "resultado" : "resultados"}
                  </p>
                </div>
                {query ? <span className="filter-indicator">Filtrado por búsqueda</span> : null}
              </div>
              <div className="table-wrap" ref={tableRef} tabIndex={0} aria-label="Tabla de artículos">
                <table>
                  <thead>
                    <tr>
                      {COLUMNS.map(([, label]) => <th key={label} scope="col">{label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row, index) => (
                      <tr
                        key={row.id ?? row.etiqueta ?? index}
                        className="table-row-clickable"
                        onClick={() => setSelectedProduct(row)}
                        title="Haz clic para ver detalles y opciones de este producto"
                      >
                        {COLUMNS.map(([key, label]) => (
                          <td key={label} className={key === "etiqueta" ? "etiqueta" : undefined}>
                            {key === "persona" && textOf(row.persona) ? (
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
                            ) : (
                              textOf(row[key]) || "—"
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
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
      />
    </div>
  );
}
