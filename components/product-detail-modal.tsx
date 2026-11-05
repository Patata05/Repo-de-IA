"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import QRCode from "qrcode";
import { formatInventarioQrText } from "@/lib/inventario-qr";
import {
  Boxes,
  Calendar,
  Check,
  ChevronDown,
  Copy,
  Edit3,
  Laptop,
  Loader2,
  MapPin,
  Package,
  Plus,
  Printer,
  QrCode,
  Save,
  Tag,
  Trash2,
  User,
  X,
  AlertTriangle,
  RotateCcw,
} from "lucide-react";
import type { InventarioRow, NewInventarioItem } from "@/lib/supabase";
import { updateInventarioAction, deleteInventarioAction } from "@/app/actions";
import ModalPortal from "@/components/modal-portal";
import { nextInventarioName } from "@/lib/inventario-origen";

const ESTADO_OPTIONS = ["Activo", "Inactivo"] as const;

function ModernEstadoSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = value === "Inactivo" ? "Inactivo" : "Activo";

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
    <div
      className={`report-select form-modern-select estado-modern-select ${open ? "is-open" : ""}`}
      ref={rootRef}
    >
      <button
        id={id}
        type="button"
        className="report-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span
          className={
            selected === "Inactivo" ? "estado-badge is-inactivo" : "estado-badge is-activo"
          }
        >
          {selected}
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open ? (
        <ul className="report-select-menu" role="listbox" aria-labelledby={id}>
          {ESTADO_OPTIONS.map((option) => {
            const active = option === selected;
            return (
              <li key={option} role="option" aria-selected={active}>
                <button
                  type="button"
                  className={active ? "report-select-option is-active" : "report-select-option"}
                  onClick={() => {
                    onChange(option);
                    setOpen(false);
                  }}
                >
                  <span
                    className={
                      option === "Inactivo"
                        ? "estado-badge is-inactivo"
                        : "estado-badge is-activo"
                    }
                  >
                    {option}
                  </span>
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

function ModernOrigenSelect({
  id,
  value,
  options,
  createOption,
  onChange,
}: {
  id: string;
  value: string;
  options: readonly string[];
  createOption?: string | null;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const allOptions = createOption
    ? [...options.filter((o) => o !== createOption), createOption]
    : [...options];
  if (value && !allOptions.includes(value)) allOptions.unshift(value);
  const selected = allOptions.includes(value) ? value : allOptions[0] || value;

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
    <div className={`report-select form-modern-select ${open ? "is-open" : ""}`} ref={rootRef}>
      <button
        id={id}
        type="button"
        className="report-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected || "Seleccionar inventario"}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open ? (
        <ul className="report-select-menu" role="listbox" aria-labelledby={id}>
          {allOptions
            .filter((option) => option !== createOption)
            .map((option) => {
              const active = option === selected;
              return (
                <li key={option} role="option" aria-selected={active}>
                  <button
                    type="button"
                    className={active ? "report-select-option is-active" : "report-select-option"}
                    onClick={() => {
                      onChange(option);
                      setOpen(false);
                    }}
                  >
                    <span>{option}</span>
                    {active ? <Check size={14} aria-hidden="true" /> : null}
                  </button>
                </li>
              );
            })}
          {createOption ? (
            <li role="option" aria-selected={selected === createOption}>
              <button
                type="button"
                className={
                  selected === createOption
                    ? "report-select-option is-active is-create"
                    : "report-select-option is-create"
                }
                onClick={() => {
                  onChange(createOption);
                  setOpen(false);
                }}
              >
                <span>Nuevo conteo · {createOption}</span>
                {selected === createOption ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Plus size={14} aria-hidden="true" />
                )}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

interface ProductDetailModalProps {
  product: InventarioRow | null;
  isOpen: boolean;
  onClose: () => void;
  onUpdated: (updated: InventarioRow) => void;
  onDeleted: (id: number) => void;
  existingAreas: string[];
  existingPeople: string[];
  existingOrigens: string[];
}

export default function ProductDetailModal({
  product,
  isOpen,
  onClose,
  onUpdated,
  onDeleted,
  existingAreas,
  existingPeople,
  existingOrigens,
}: ProductDetailModalProps) {
  const createOrigenOption = useMemo(
    () => nextInventarioName(existingOrigens),
    [existingOrigens],
  );
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleteSubmitting, setIsDeleteSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [etiquetaCopied, setEtiquetaCopied] = useState(false);
  const [showQrExpanded, setShowQrExpanded] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");

  // Form State para edición
  const [editForm, setEditForm] = useState<NewInventarioItem>({
    etiqueta: "",
    articulo: "",
    marca: "",
    modelo: "",
    serie: "",
    area: "",
    persona: "",
    cantidad: 1,
    observaciones: "",
    estado: "Activo",
    origen: "S/O",
  });

  // Cargar datos del producto al abrir o cambiar
  useEffect(() => {
    if (product) {
      setEditForm({
        etiqueta: product.etiqueta || "",
        articulo: product.articulo || "",
        marca: product.marca || "",
        modelo: product.modelo || "",
        serie: product.serie || "",
        area: product.area || "",
        persona: product.persona || "",
        cantidad: product.cantidad ?? 1,
        observaciones: product.observaciones || "",
        estado:
          String(product.estado ?? "")
            .trim()
            .toLowerCase() === "inactivo"
            ? "Inactivo"
            : "Activo",
        origen: product.origen || "S/O",
      });
      setIsEditing(false);
      setIsDeleting(false);
      setErrorMessage(null);
      setCopied(false);
      setEtiquetaCopied(false);
      setShowQrExpanded(false);
    }
  }, [product, isOpen]);

  // QR local (sin API externa) para que aparezca al instante
  useEffect(() => {
    if (!isOpen || !product) {
      setQrDataUrl("");
      return;
    }

    // Texto legible: Google Lens / escáner muestran campos claros; la app también lo parsea.
    const payload = formatInventarioQrText(product);

    let cancelled = false;
    QRCode.toDataURL(payload, {
      width: 168,
      margin: 1,
      errorCorrectionLevel: "L",
      color: { dark: "#111827", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl("");
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, product]);

  // Manejo de ESC
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isEditing) {
          setIsEditing(false);
        } else if (isDeleting) {
          setIsDeleting(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isEditing, isDeleting, onClose]);

  if (!isOpen || !product) return null;

  const qrImageUrl = qrDataUrl;

  // Formatear fechas
  const formatDate = (isoString?: string | null) => {
    if (!isoString) return "—";
    try {
      return new Intl.DateTimeFormat("es-MX", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(isoString));
    } catch {
      return isoString;
    }
  };

  const handleCopyEtiqueta = async () => {
    const tag = String(product.etiqueta ?? "").trim();
    if (!tag) return;
    try {
      await navigator.clipboard.writeText(tag);
      setEtiquetaCopied(true);
      setTimeout(() => setEtiquetaCopied(false), 2000);
    } catch (err) {
      console.error("Error al copiar etiqueta:", err);
    }
  };

  // Copiar Ficha Técnica al portapapeles (mismo formato que el QR)
  const handleCopyFicha = async () => {
    const text = `${formatInventarioQrText(product)}\nRegistrado: ${formatDate(product.created_at)}`;

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Error al copiar ficha:", err);
    }
  };

  // Imprimir Etiqueta Física
  const handlePrintLabel = () => {
    const printWindow = window.open("", "_blank", "width=600,height=400");
    if (!printWindow) return;

    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Etiqueta - ${product.etiqueta}</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              padding: 24px;
              color: #111;
              display: flex;
              justify-content: center;
            }
            .label-card {
              border: 2px dashed #333;
              border-radius: 8px;
              padding: 18px 22px;
              width: 380px;
              display: flex;
              gap: 16px;
              align-items: center;
            }
            .label-qr img {
              width: 110px;
              height: 110px;
              display: block;
            }
            .label-info h2 {
              margin: 0 0 4px 0;
              font-size: 19px;
            }
            .label-tag {
              display: inline-block;
              background: #222;
              color: #fff;
              padding: 3px 8px;
              border-radius: 4px;
              font-size: 13px;
              font-weight: bold;
              margin-bottom: 8px;
            }
            .label-info p {
              margin: 2px 0;
              font-size: 11px;
              color: #444;
            }
            @media print {
              body { padding: 0; }
              .label-card { border: 2px solid #000; }
            }
          </style>
        </head>
        <body>
          <div class="label-card">
            <div class="label-qr">
              <img src="${qrImageUrl}" alt="QR" />
            </div>
            <div class="label-info">
              <span class="label-tag">${product.etiqueta}</span>
              <h2>${product.articulo}</h2>
              <p><strong>Marca:</strong> ${product.marca || "—"} | ${product.modelo || "—"}</p>
              <p><strong>Serie:</strong> ${product.serie || "—"}</p>
              <p><strong>Área:</strong> ${product.area || "—"}</p>
              <p><strong>Asignado:</strong> ${product.persona || "—"}</p>
            </div>
          </div>
          <script>
            window.onload = function() {
              window.print();
            };
          </script>
        </body>
      </html>
    `);
    printWindow.document.close();
  };

  // Guardar Cambios
  const handleSaveChanges = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!product.id) return;
    setErrorMessage(null);

    if (!editForm.etiqueta.trim()) {
      setErrorMessage("La etiqueta no puede estar vacía.");
      return;
    }
    if (!editForm.articulo.trim()) {
      setErrorMessage("El nombre del artículo no puede estar vacío.");
      return;
    }
    if (!editForm.area.trim()) {
      setErrorMessage("El área es obligatoria.");
      return;
    }

    setIsSaving(true);
    try {
      const res = await updateInventarioAction(product.id, editForm);
      if (!res.success || !res.data) {
        setErrorMessage(res.error || "No se pudo actualizar el artículo.");
        setIsSaving(false);
        return;
      }

      onUpdated(res.data);
      setIsEditing(false);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Error al guardar cambios.");
    } finally {
      setIsSaving(false);
    }
  };

  // Eliminar Producto
  const handleDeleteConfirm = async () => {
    if (!product.id) return;
    setIsDeleteSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await deleteInventarioAction(product.id);
      if (!res.success) {
        setErrorMessage(res.error || "No se pudo eliminar el artículo.");
        setIsDeleteSubmitting(false);
        return;
      }

      onDeleted(product.id);
      onClose();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Error al eliminar artículo.");
    } finally {
      setIsDeleteSubmitting(false);
    }
  };

  return (
    <ModalPortal>
    <div
      className="product-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="detail-modal-title"
    >
      <div className="product-modal-card detail-modal-card">
        {/* Encabezado del Detalle */}
        <header className="product-modal-header detail-header">
          <div className="detail-header-main">
            <div className="detail-header-title-row">
              <span className="detail-tag-badge">{product.etiqueta}</span>
              <h2 id="detail-modal-title">{product.articulo}</h2>
            </div>
            <div className="detail-subtitle-pills">
              <span className="detail-pill pill-area">
                <MapPin size={12} />
                <span>{product.area || "General"}</span>
              </span>
              <span className="detail-pill pill-origen">
                <span>{product.origen || "S/O"}</span>
              </span>
              {product.cantidad && product.cantidad > 1 ? (
                <span className="detail-pill pill-qty">
                  <Boxes size={12} />
                  <span>{product.cantidad} unidades</span>
                </span>
              ) : null}
            </div>
          </div>
          <div className="detail-header-aside">
            <span
              className={
                String(product.estado ?? "")
                  .trim()
                  .toLowerCase() === "inactivo"
                  ? "estado-badge is-inactivo"
                  : "estado-badge is-activo"
              }
              title="Estado del artículo"
            >
              {String(product.estado ?? "")
                .trim()
                .toLowerCase() === "inactivo"
                ? "Inactivo"
                : "Activo"}
            </span>
            <button
              type="button"
              className="product-modal-close"
              onClick={onClose}
              aria-label="Cerrar ventana"
            >
              <X size={19} />
            </button>
          </div>
        </header>

        {/* Mensaje de error si ocurre */}
        {errorMessage ? (
          <div className="modal-alert modal-alert-error" role="alert">
            <AlertTriangle size={16} />
            <span>{errorMessage}</span>
          </div>
        ) : null}

        {/* Confirmación de Eliminación */}
        {isDeleting ? (
          <div className="detail-delete-prompt">
            <div className="delete-warning-box">
              <AlertTriangle size={28} className="delete-icon" />
              <div>
                <h3>¿Confirmas que deseas eliminar este artículo?</h3>
                <p>
                  Se eliminará permanentemente de Supabase el registro{" "}
                  <strong>
                    {product.etiqueta} - {product.articulo}
                  </strong>
                  . Esta acción no se puede deshacer.
                </p>
              </div>
            </div>
            <div className="delete-actions-row">
              <button
                type="button"
                className="btn-cancel"
                onClick={() => setIsDeleting(false)}
                disabled={isDeleteSubmitting}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn-danger-confirm"
                onClick={handleDeleteConfirm}
                disabled={isDeleteSubmitting}
              >
                {isDeleteSubmitting ? (
                  <>
                    <Loader2 size={15} className="spin" />
                    <span>Eliminando de la base de datos...</span>
                  </>
                ) : (
                  <>
                    <Trash2 size={15} />
                    <span>Sí, eliminar artículo</span>
                  </>
                )}
              </button>
            </div>
          </div>
        ) : isEditing ? (
          /* MODO EDICIÓN */
          <form className="product-modal-body form-body" onSubmit={handleSaveChanges}>
            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="edit-etiqueta">
                  Etiqueta <span className="req">*</span>
                </label>
                <input
                  id="edit-etiqueta"
                  required
                  value={editForm.etiqueta}
                  onChange={(e) =>
                    setEditForm((prev) => ({ ...prev, etiqueta: e.target.value }))
                  }
                />
              </div>

              <div className="form-field">
                <label htmlFor="edit-articulo">
                  Artículo <span className="req">*</span>
                </label>
                <input
                  id="edit-articulo"
                  required
                  value={editForm.articulo}
                  onChange={(e) =>
                    setEditForm((prev) => ({ ...prev, articulo: e.target.value }))
                  }
                />
              </div>

              <div className="form-field">
                <label htmlFor="edit-marca">Marca</label>
                <input
                  id="edit-marca"
                  value={editForm.marca || ""}
                  onChange={(e) =>
                    setEditForm((prev) => ({ ...prev, marca: e.target.value }))
                  }
                />
              </div>

              <div className="form-field">
                <label htmlFor="edit-modelo">Modelo</label>
                <input
                  id="edit-modelo"
                  value={editForm.modelo || ""}
                  onChange={(e) =>
                    setEditForm((prev) => ({ ...prev, modelo: e.target.value }))
                  }
                />
              </div>

              <div className="form-field">
                <label htmlFor="edit-serie">Número de Serie</label>
                <input
                  id="edit-serie"
                  value={editForm.serie || ""}
                  onChange={(e) =>
                    setEditForm((prev) => ({ ...prev, serie: e.target.value }))
                  }
                />
              </div>

              <div className="form-field">
                <label htmlFor="edit-area">
                  Área <span className="req">*</span>
                </label>
                <input
                  id="edit-area"
                  required
                  list="edit-areas-datalist"
                  value={editForm.area}
                  onChange={(e) =>
                    setEditForm((prev) => ({ ...prev, area: e.target.value }))
                  }
                />
                <datalist id="edit-areas-datalist">
                  {existingAreas.map((area) => (
                    <option key={area} value={area} />
                  ))}
                </datalist>
              </div>

              <div className="form-field">
                <label htmlFor="edit-persona">Persona Asignada</label>
                <input
                  id="edit-persona"
                  list="edit-people-datalist"
                  placeholder="Sin asignar"
                  value={editForm.persona || ""}
                  onChange={(e) =>
                    setEditForm((prev) => ({ ...prev, persona: e.target.value }))
                  }
                />
                <datalist id="edit-people-datalist">
                  {existingPeople.map((person) => (
                    <option key={person} value={person} />
                  ))}
                </datalist>
              </div>

              <div className="form-field">
                <label htmlFor="edit-cantidad">
                  Cantidad <span className="req">*</span>
                </label>
                <input
                  id="edit-cantidad"
                  type="number"
                  min="0"
                  required
                  value={editForm.cantidad ?? 1}
                  onChange={(e) =>
                    setEditForm((prev) => ({
                      ...prev,
                      cantidad: parseInt(e.target.value, 10) || 0,
                    }))
                  }
                />
              </div>

              <div className="form-field">
                <label htmlFor="edit-origen">Origen (inventario del conteo)</label>
                <ModernOrigenSelect
                  id="edit-origen"
                  value={editForm.origen || createOrigenOption}
                  options={existingOrigens}
                  createOption={createOrigenOption}
                  onChange={(origen) => setEditForm((prev) => ({ ...prev, origen }))}
                />
              </div>

              <div className="form-field">
                <label htmlFor="edit-estado">Estado del artículo</label>
                <ModernEstadoSelect
                  id="edit-estado"
                  value={editForm.estado === "Inactivo" ? "Inactivo" : "Activo"}
                  onChange={(estado) => setEditForm((prev) => ({ ...prev, estado }))}
                />
              </div>

              <div className="form-field form-field-full">
                <label htmlFor="edit-observaciones">Observaciones</label>
                <textarea
                  id="edit-observaciones"
                  rows={2}
                  value={editForm.observaciones || ""}
                  onChange={(e) =>
                    setEditForm((prev) => ({ ...prev, observaciones: e.target.value }))
                  }
                />
              </div>
            </div>

            <div className="form-footer">
              <button
                type="button"
                className="btn-cancel"
                onClick={() => setIsEditing(false)}
                disabled={isSaving}
              >
                <RotateCcw size={14} />
                <span>Cancelar edición</span>
              </button>
              <button type="submit" className="btn-submit" disabled={isSaving}>
                {isSaving ? (
                  <>
                    <Loader2 size={15} className="spin" />
                    <span>Guardando cambios...</span>
                  </>
                ) : (
                  <>
                    <Save size={15} />
                    <span>Guardar cambios</span>
                  </>
                )}
              </button>
            </div>
          </form>
        ) : (
          /* MODO LECTURA / VISTA DETALLADA */
          <div className="product-modal-body detail-body">
            <div className="detail-layout">
              {/* Columna Izquierda: Tarjetas de Información */}
              <div className="detail-info-col">
                <div className="detail-grid">
                  {/* Marca y Modelo */}
                  <div className="detail-card">
                    <span className="detail-label">Marca y Modelo</span>
                    <strong className="detail-value">
                      {product.marca || product.modelo ? (
                        `${product.marca || ""} ${product.modelo || ""}`.trim()
                      ) : (
                        <span className="empty-text">No especificado</span>
                      )}
                    </strong>
                  </div>

                  {/* Número de Serie */}
                  <div className="detail-card">
                    <span className="detail-label">Número de Serie</span>
                    <strong className="detail-value detail-code">
                      {product.serie ? (
                        product.serie
                      ) : (
                        <span className="empty-text">Sin serie registrada</span>
                      )}
                    </strong>
                  </div>

                  {/* Área */}
                  <div className="detail-card">
                    <span className="detail-label">Área / Ubicación</span>
                    <strong className="detail-value">{product.area || "General"}</strong>
                  </div>

                  {/* Persona Asignada */}
                  <div className="detail-card">
                    <span className="detail-label">Persona Asignada</span>
                    <strong className="detail-value">
                      {product.persona ? (
                        <span className="detail-person-badge">
                          <User size={13} />
                          <span>{product.persona}</span>
                        </span>
                      ) : (
                        <span className="empty-text">Sin asignar / Disponible</span>
                      )}
                    </strong>
                  </div>

                  {/* Cantidad */}
                  <div className="detail-card">
                    <span className="detail-label">Cantidad Registrada</span>
                    <strong className="detail-value">{product.cantidad ?? 1} unidades</strong>
                  </div>

                  {/* Origen */}
                  <div className="detail-card">
                    <span className="detail-label">Origen</span>
                    <strong className="detail-value">{product.origen || "S/O"}</strong>
                  </div>

                  {/* Fechas de Sistema */}
                  <div className="detail-card detail-card-full detail-dates-card">
                    <div>
                      <span className="detail-label">Fecha de alta</span>
                      <small className="detail-small-date">
                        <Calendar size={12} /> {formatDate(product.created_at)}
                      </small>
                    </div>
                    {product.updated_at ? (
                      <div>
                        <span className="detail-label">Última actualización</span>
                        <small className="detail-small-date">
                          <Calendar size={12} /> {formatDate(product.updated_at)}
                        </small>
                      </div>
                    ) : null}
                  </div>

                  {/* Observaciones */}
                  <div className="detail-card detail-card-full">
                    <span className="detail-label">Observaciones</span>
                    <p className="detail-notes">
                      {product.observaciones ? (
                        product.observaciones
                      ) : (
                        <span className="empty-text">Sin observaciones registradas.</span>
                      )}
                    </p>
                  </div>
                </div>
              </div>

              {/* Columna Derecha: Tarjeta de Código QR y Ficha */}
              <div className="detail-qr-col">
                <div className="qr-badge-card">
                  <span className="qr-badge-title">
                    <QrCode size={15} /> Código QR de Activo
                  </span>
                  <div className="qr-img-wrapper">
                    {qrImageUrl ? (
                      <img
                        src={qrImageUrl}
                        alt={`QR ${product.etiqueta}`}
                        className="qr-img"
                        decoding="sync"
                      />
                    ) : (
                      <div className="qr-img qr-img-placeholder" aria-hidden="true" />
                    )}
                  </div>
                  <span className="qr-tag-label">{product.etiqueta}</span>
                  <p className="qr-instruction">
                    Apunta con la cámara o un escáner para consultar este artículo.
                  </p>

                  <div className="qr-action-buttons">
                    <button
                      type="button"
                      className="qr-btn"
                      onClick={handlePrintLabel}
                      disabled={!qrImageUrl}
                      title="Imprimir etiqueta adhesiva para este artículo"
                    >
                      <Printer size={14} />
                      <span>Imprimir etiqueta</span>
                    </button>
                    <button
                      type="button"
                      className="qr-btn"
                      onClick={handleCopyEtiqueta}
                      disabled={!product.etiqueta}
                      title="Copiar etiqueta al portapapeles"
                    >
                      {etiquetaCopied ? <Check size={14} /> : <Copy size={14} />}
                      <span>{etiquetaCopied ? "¡Copiada!" : "Copiar etiqueta"}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* BARRA DE ACCIONES INFERIOR */}
            <div className="detail-actions-bar">
              <div className="detail-actions-left">
                <button
                  type="button"
                  className="btn-action-tool"
                  onClick={handleCopyFicha}
                  title="Copiar todos los datos de este artículo al portapapeles"
                >
                  {copied ? <Check size={15} className="text-teal" /> : <Copy size={15} />}
                  <span>{copied ? "¡Copiado!" : "Copiar ficha"}</span>
                </button>

                <button
                  type="button"
                  className="btn-action-tool"
                  onClick={handlePrintLabel}
                  title="Imprimir etiqueta con código QR para pegar en el equipo"
                >
                  <Printer size={15} />
                  <span>Imprimir etiqueta</span>
                </button>
              </div>

              <div className="detail-actions-right">
                <button
                  type="button"
                  className="btn-action-danger"
                  onClick={() => setIsDeleting(true)}
                  title="Eliminar este artículo de la base de datos"
                >
                  <Trash2 size={15} />
                  <span>Eliminar</span>
                </button>

                <button
                  type="button"
                  className="btn-action-edit"
                  onClick={() => setIsEditing(true)}
                  title="Editar la información de este artículo"
                >
                  <Edit3 size={15} />
                  <span>Modificar artículo</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
    </ModalPortal>
  );
}
