"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { InventarioRow } from "../../Database/supabase";

const COLUMNS = [
  ["etiqueta", "Etiqueta"],
  ["articulo", "Articulo"],
  ["marca", "Marca"],
  ["modelo", "Modelo"],
  ["serie", "Serie"],
  ["area", "Area"],
  ["persona", "Persona"],
  ["cantidad", "Cantidad"],
  ["observaciones", "Observaciones"],
  ["origen", "Origen"],
] as const;

const AVATAR_COLORS = ["#5b7cfa", "#f08a4b", "#7d6adf", "#3aa88a", "#d4567a", "#3d8bfd"];

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

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="9" r="3.2" />
      <path d="M6.2 18.2c1.2-2.5 3.2-3.7 5.8-3.7s4.6 1.2 5.8 3.7" />
    </svg>
  );
}

const RAIL_ITEMS = [
  { id: "inventario", label: "Inventario" },
  { id: "personas", label: "Personas" },
  { id: "archivos", label: "Chat" },
  { id: "avisos", label: "Avisos" },
  { id: "equipos", label: "Equipos" },
  { id: "areas", label: "Areas" },
] as const;

function RailIcon({ id }: { id: (typeof RAIL_ITEMS)[number]["id"] }) {
  if (id === "personas") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="8" r="3" />
        <path d="M6.5 18.5c1.1-2.6 3-3.8 5.5-3.8s4.4 1.2 5.5 3.8" />
      </svg>
    );
  }
  if (id === "inventario") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="4" width="6.5" height="6.5" rx="1.4" />
        <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4" />
        <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4" />
        <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4" />
      </svg>
    );
  }
  if (id === "archivos") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4.5" y="7" width="15" height="12.5" rx="3.5" />
        <path d="M12 7V4" />
        <circle cx="12" cy="3.1" r="1.35" />
        <circle cx="9" cy="12" r="1.25" />
        <circle cx="15" cy="12" r="1.25" />
        <path d="M8.7 16.1c.9.8 2 1.2 3.3 1.2s2.4-.4 3.3-1.2" />
      </svg>
    );
  }
  if (id === "avisos") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 16.5V10a6 6 0 0 1 12 0v6.5l1.2 1.5H4.8z" />
        <path d="M10 19a2 2 0 0 0 4 0" />
      </svg>
    );
  }
  if (id === "equipos") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3.5" y="5" width="17" height="11" rx="2" />
        <path d="M9 19.5h6M12 16v3.5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20.5s6-5.1 6-9.2A6 6 0 0 0 6 11.3c0 4.1 6 9.2 6 9.2z" />
      <circle cx="12" cy="11" r="1.7" />
    </svg>
  );
}

const RAIL_SLOT = 72;

function SideRail({
  active,
  onChange,
}: {
  active: string;
  onChange: (id: string) => void;
}) {
  const index = Math.max(0, RAIL_ITEMS.findIndex((item) => item.id === active));
  const [gliding, setGliding] = useState(false);
  const previousIndex = useRef(index);
  const glideTimer = useRef<number | null>(null);

  useEffect(() => {
    const from = previousIndex.current;
    if (from === index) return;
    previousIndex.current = index;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setGliding(true);
    if (glideTimer.current) window.clearTimeout(glideTimer.current);
    glideTimer.current = window.setTimeout(() => setGliding(false), 460);
  }, [index]);

  return (
    <div className="rail-wrap">
      <aside className="rail" aria-label="Navegacion">
        <nav className="rail-nav">
          <span
            className={gliding ? "rail-indicator is-gliding" : "rail-indicator"}
            style={{ transform: `translateY(${index * RAIL_SLOT}px)` }}
            aria-hidden="true"
          >
            <span className="rail-notch-clip">
              <svg className="rail-notch" viewBox="0 0 76 108" preserveAspectRatio="none">
                <path fill="#ffffff" />
              </svg>
            </span>
            <span className="rail-bubble" />
          </span>
          {RAIL_ITEMS.map((item) => {
            const selected = item.id === active;
            return (
              <div key={item.id} className="rail-slot">
                <button
                  type="button"
                  className={selected ? "rail-btn is-active" : "rail-btn"}
                  aria-label={item.label}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => onChange(item.id)}
                >
                  <RailIcon id={item.id} />
                </button>
              </div>
            );
          })}
        </nav>
        <button type="button" className="rail-avatar" aria-label="Perfil">
          <PersonIcon />
        </button>
      </aside>
    </div>
  );
}

function Avatars({ people, empty = 3 }: { people: string[]; empty?: number }) {
  if (people.length === 0) {
    return (
      <span className="avatars">
        {Array.from({ length: empty }, (_, index) => (
          <span className="avatar ghost" key={index}>
            <PersonIcon />
          </span>
        ))}
      </span>
    );
  }

  const shown = people.slice(0, 4);
  const extra = people.length - shown.length;

  return (
    <span className="avatars">
      {shown.map((person) => (
        <span className="avatar" key={person} style={{ background: colorFor(person) }} title={person}>
          {initials(person)}
        </span>
      ))}
      {extra > 0 ? <span className="avatar extra">+{extra}</span> : null}
    </span>
  );
}

export default function InventoryView({ rows }: { rows: InventarioRow[] }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rail, setRail] = useState("inventario");
  const [draft, setDraft] = useState("");
  const [infoOpen, setInfoOpen] = useState(false);
  const [messages, setMessages] = useState<Array<{ id: number; from: "bot" | "user"; text: string }>>([
    {
      id: 1,
      from: "bot",
      text: "Hola. Soy el asistente del inventario. Pregúntame por un equipo, una persona o un área.",
    },
  ]);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const chatId = useRef(2);
  const quickRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const personFolders = useMemo(() => buildFolders(rows, "persona"), [rows]);
  const areaFolders = useMemo(() => buildFolders(rows, "area"), [rows]);
  const folders = rail === "areas" ? areaFolders : personFolders;
  const featuredId = selectedId ?? folders[0]?.id ?? "";

  const visible = useMemo(() => {
    const selected = folders.find((folder) => folder.id === selectedId);
    const scoped = rail === "personas" ? rows.filter((row) => textOf(row.persona)) : rows;
    const base = selected ? selected.rows.filter((row) => scoped.includes(row)) : scoped;
    const text = query.trim().toLowerCase();
    if (!text) return base;
    return base.filter((row) =>
      COLUMNS.some(([key]) => textOf(row[key]).toLowerCase().includes(text)),
    );
  }, [folders, query, rail, rows, selectedId]);

  useEffect(() => {
    const nodes = [quickRef.current, tableRef.current].filter((node): node is HTMLDivElement => Boolean(node));
    const cleanups = nodes.map((el) => {
      let target = el.scrollLeft;
      let frame = 0;

      const tick = () => {
        const diff = target - el.scrollLeft;
        if (Math.abs(diff) < 0.6) {
          el.scrollLeft = target;
          frame = 0;
          return;
        }
        el.scrollLeft += diff * 0.14;
        frame = window.requestAnimationFrame(tick);
      };

      const onWheel = (event: WheelEvent) => {
        if (el.scrollWidth <= el.clientWidth) return;
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        if (!delta) return;
        const max = el.scrollWidth - el.clientWidth;
        if (!frame) target = el.scrollLeft;
        const next = Math.min(max, Math.max(0, target + delta));
        if (next === target && next === el.scrollLeft) return;
        target = next;
        if (!frame) frame = window.requestAnimationFrame(tick);
        event.preventDefault();
      };

      el.addEventListener("wheel", onWheel, { passive: false });
      return () => {
        el.removeEventListener("wheel", onWheel);
        if (frame) window.cancelAnimationFrame(frame);
      };
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [rail]);

  useEffect(() => {
    const log = chatLogRef.current;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
  }, [messages, rail]);

  useEffect(() => {
    if (!infoOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInfoOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [infoOpen]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 980px)");
    const onChange = () => {
      if (!media.matches) setInfoOpen(false);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

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

  return (
    <div className="app-shell">
      <header className="searchbar">
        <div className="searchbar-menu">
          <button
            type="button"
            className="rail-menu"
            aria-label={infoOpen ? "Cerrar informacion" : "Menu"}
            aria-expanded={infoOpen}
            aria-controls="inventario-info"
            onClick={() => {
              if (rail !== "archivos") return;
              if (!window.matchMedia("(max-width: 980px)").matches) return;
              setInfoOpen((open) => !open);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {infoOpen ? <path d="M7 7l10 10M17 7L7 17" /> : <path d="M5 7.5h14M5 12h14M5 16.5h14" />}
            </svg>
          </button>
        </div>
        <form role="search" onSubmit={(event) => event.preventDefault()}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16 L20.5 20.5" />
          </svg>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar etiqueta, articulo, marca..."
            aria-label="Buscar en el inventario"
          />
        </form>
      </header>
      <div className="app-body">
      <SideRail
        active={rail}
        onChange={(id) => {
          setRail(id);
          setSelectedId(null);
          setInfoOpen(false);
        }}
      />
      <div className="app-main">

      <main key={rail} className="view-panel">
        <div className="heading">
          <h1>{RAIL_ITEMS.find((item) => item.id === rail)?.label ?? "Inventario"}</h1>
          <span>
            {rail === "avisos" ? "0 avisos" : rail === "archivos" ? "Asistente" : `${visible.length} registros`}
          </span>
        </div>

        {rail === "avisos" ? (
          <section className="notice">
            <h2>Bandeja</h2>
            <p>No hay avisos por ahora.</p>
          </section>
        ) : null}

        {rail === "personas" || rail === "areas" ? (
        <section className="quick-access" aria-label={rail === "areas" ? "Areas" : "Asignado a"}>
          <h2>{rail === "areas" ? "Areas" : "Asignado a"}</h2>
          <div className="quick-grid" ref={quickRef}>
            {(rail === "areas" ? areaFolders : personFolders).map((folder) => {
              const active = folder.id === featuredId;
              return (
                <button
                  key={folder.id}
                  type="button"
                  className={active ? "folder is-active" : "folder"}
                  aria-pressed={selectedId === folder.id}
                  onClick={() => setSelectedId((current) => (current === folder.id ? null : folder.id))}
                >
                  <svg className="folder-shape" viewBox="0 0 336 196" preserveAspectRatio="none" aria-hidden="true">
                    <path d="M10 36V168C10 184 24 196 40 196H308C324 196 336 184 336 168V64C336 50 324 40 308 40H158C146 40 138 34 130 26C122 18 114 12 100 12H36C20 12 10 20 10 36Z" />
                  </svg>
                  <span className="folder-body">
                    <span className="kicker">Asignado a</span>
                    <Avatars people={folder.people} />
                    <span className="folder-foot">
                      <span className="kicker">{rail === "areas" ? "Carpeta" : "Persona"}</span>
                      <strong>{folder.name}</strong>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
        ) : null}

        {rail === "archivos" ? (
          <div className={infoOpen ? "chat-stage is-info-open" : "chat-stage"}>
          <section className="chat" aria-label="Chat del inventario">
            <div className="chat-log" ref={chatLogRef}>
              {messages.map((message) => (
                <div className={message.from === "user" ? "chat-row is-user" : "chat-row"} key={message.id}>
                  {message.from === "bot" ? (
                    <span className="chat-mark" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        <rect x="4.5" y="7" width="15" height="12.5" rx="3.5" />
                        <path d="M12 7V4" />
                        <circle cx="12" cy="3.1" r="1.35" />
                        <circle cx="9" cy="12" r="1.25" />
                        <circle cx="15" cy="12" r="1.25" />
                        <path d="M8.7 16.1c.9.8 2 1.2 3.3 1.2s2.4-.4 3.3-1.2" />
                      </svg>
                    </span>
                  ) : null}
                  <p className="chat-bubble">{message.text}</p>
                </div>
              ))}
            </div>
            {messages.length === 1 ? (
              <div className="chat-suggestions">
                {["¿Qué tiene Juan Pérez?", "Equipos de Sistemas", "Últimos registros"].map((idea) => (
                  <button key={idea} type="button" onClick={() => sendChat(idea)}>
                    {idea}
                  </button>
                ))}
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
              <button type="submit" aria-label="Enviar">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 12h12M13 6l6 6-6 6" />
                </svg>
              </button>
            </form>
          </section>
          <button
            type="button"
            className="chat-info-backdrop"
            aria-label="Cerrar informacion"
            onClick={() => setInfoOpen(false)}
          />
          <aside className="chat-board" id="inventario-info" aria-label="Resumen del inventario">
            <div className="chat-board-head">
              <h2>En el inventario</h2>
              <button type="button" className="chat-board-close" aria-label="Cerrar informacion" onClick={() => setInfoOpen(false)}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M7 7l10 10M17 7L7 17" />
                </svg>
              </button>
            </div>
            <div className="chat-stats">
              <article>
                <span>Registros</span>
                <strong>{rows.length}</strong>
              </article>
              <article>
                <span>Areas</span>
                <strong>{areaFolders.length}</strong>
              </article>
              <article>
                <span>Personas</span>
                <strong>{personFolders.length}</strong>
              </article>
            </div>
            <section className="chat-block">
              <h2>Areas</h2>
              <ul className="chat-areas">
                {areaFolders.map((folder) => {
                  const maxArea = Math.max(...areaFolders.map((item) => item.rows.length), 1);
                  return (
                    <li key={folder.id}>
                      <div className="chat-area-top">
                        <strong>{folder.name}</strong>
                        <span>{folder.rows.length}</span>
                      </div>
                      <span className="chat-meter" aria-hidden="true">
                        <i style={{ width: `${Math.round((folder.rows.length / maxArea) * 100)}%` }} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
            <section className="chat-block">
              <h2>Recientes</h2>
              <ul className="chat-recent">
                {rows.slice(-4).reverse().map((row, index) => (
                  <li key={row.id ?? row.etiqueta ?? index}>
                    <span>{textOf(row.etiqueta) || "—"}</span>
                    <div>
                      <strong>{textOf(row.articulo) || "Registro"}</strong>
                      <em>{textOf(row.persona) || textOf(row.area) || "—"}</em>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
          </div>
        ) : null}

        {rail !== "avisos" && rail !== "archivos" ? (
        <section className="sheet">
          <h2>{rail === "personas" ? "Asignaciones" : rail === "equipos" ? "Equipos" : "Todos los articulos"}</h2>
          <div className="table-wrap" ref={tableRef}>
            <table>
              <thead>
                <tr>
                  {COLUMNS.map(([, label]) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((row, index) => (
                  <tr key={row.id ?? row.etiqueta ?? index}>
                    {COLUMNS.map(([key, label]) => (
                      <td key={label} className={key === "etiqueta" ? "etiqueta" : undefined}>
                        {key === "persona" && textOf(row.persona) ? (
                          <span className="person-cell">
                            <span className="avatar" style={{ background: colorFor(textOf(row.persona)) }}>
                              {initials(textOf(row.persona))}
                            </span>
                            {textOf(row.persona)}
                          </span>
                        ) : (
                          textOf(row[key])
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        ) : null}
      </main>
      </div>
      </div>
    </div>
  );
}
