"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import jsQR from "jsqr";
import {
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardPaste,
  FilePenLine,
  FileSpreadsheet,
  Image as ImageIcon,
  Loader2,
  Plus,
  QrCode,
  RefreshCw,
  ScanLine,
  Sparkles,
  Upload,
  VideoOff,
  X,
  AlertCircle,
  ArrowLeft,
} from "lucide-react";
import type { InventarioRow, NewInventarioItem } from "@/lib/supabase";
import { addInventarioAction, addInventarioBulkAction } from "@/app/actions";
import ModalPortal from "@/components/modal-portal";
import { parseInventarioImportFile } from "@/lib/import-inventario-file";
import { parseInventarioQrText } from "@/lib/inventario-qr";
import {
  existsInOrigen,
  findByEtiquetaCascade,
  latestInventarioName,
  listExistingOrigens,
  nextInventarioName,
  ORIGEN_SIN_ORIGEN,
  rowToFormFields,
} from "@/lib/inventario-origen";

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
          {options.map((option) => {
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
                {selected === createOption ? <Check size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

interface AddProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (item: InventarioRow | InventarioRow[]) => void;
  existingAreas: string[];
  existingPeople: string[];
  items: InventarioRow[];
}

type StepMode = "choose" | "qr" | "form";

export default function AddProductModal({
  isOpen,
  onClose,
  onCreated,
  existingAreas,
  existingPeople,
  items,
}: AddProductModalProps) {
  const existingOrigens = useMemo(() => listExistingOrigens(items), [items]);
  const createOrigenOption = useMemo(
    () => nextInventarioName(existingOrigens),
    [existingOrigens],
  );
  const defaultOrigen = useMemo(
    () => latestInventarioName(existingOrigens),
    [existingOrigens],
  );

  const [mode, setMode] = useState<StepMode>("choose");
  const [fromQR, setFromQR] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [cascadeHint, setCascadeHint] = useState<string | null>(null);
  const [fuenteOrigen, setFuenteOrigen] = useState<string | null>(null);
  const [destinoInventario, setDestinoInventario] = useState(ORIGEN_SIN_ORIGEN);
  const [bloqueadoDuplicado, setBloqueadoDuplicado] = useState(false);

  // Form State
  const [formData, setFormData] = useState<NewInventarioItem>({
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
    origen: ORIGEN_SIN_ORIGEN,
  });

  // QR Scanner State
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const scanLoopRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const saveLockRef = useRef(false);
  const [qrDecodedRaw, setQrDecodedRaw] = useState<string | null>(null);

  const applyCascadeFromEtiqueta = useCallback(
    (etiqueta: string, destino: string) => {
      // Tras guardar ok, items/revalidate pueden llegar antes de cerrar el modal:
      // no volver a marcar duplicado en rojo.
      if (saveLockRef.current) return null;

      const dest = destino.trim();
      const tag = etiqueta.trim();
      if (!tag) {
        setFuenteOrigen(null);
        setCascadeHint(null);
        setBloqueadoDuplicado(false);
        return null;
      }

      // Rojo solo si YA está en el inventario destino elegido
      const duplicate = existsInOrigen(items, tag, dest);
      if (duplicate) {
        setFuenteOrigen(dest);
        setBloqueadoDuplicado(true);
        setCascadeHint(
          `La etiqueta ya existe en ${dest}. Debe ser completamente nueva en ese inventario.`,
        );
        return { blocked: true as const, fields: rowToFormFields(duplicate) };
      }

      const hit = findByEtiquetaCascade(items, tag, dest);
      if (!hit || hit.inDestino) {
        setFuenteOrigen(null);
        setCascadeHint(null);
        setBloqueadoDuplicado(false);
        return null;
      }

      // Azul: tomado de un inventario anterior → se puede guardar en el destino
      setFuenteOrigen(hit.foundIn);
      setBloqueadoDuplicado(false);
      setCascadeHint(
        `Datos tomados de ${hit.foundIn} (versión más reciente). Se colocarán en ${dest}.`,
      );
      return { blocked: false as const, fields: rowToFormFields(hit.row) };
    },
    [items],
  );

  // Mantener aviso azul/rojo sincronizado al cambiar destino o etiqueta
  useEffect(() => {
    if (!isOpen || mode !== "form") return;
    // Tras guardar, items se actualiza y la etiqueta ya existe en destino:
    // no revalidar o el hint azul pasa a rojo un instante antes de cerrar.
    if (successMessage || isSubmitting) return;
    const tag = formData.etiqueta?.trim();
    if (!tag) return;
    applyCascadeFromEtiqueta(tag, destinoInventario || defaultOrigen);
  }, [
    isOpen,
    mode,
    formData.etiqueta,
    destinoInventario,
    defaultOrigen,
    items,
    applyCascadeFromEtiqueta,
    successMessage,
    isSubmitting,
  ]);

  // Reiniciar estado solo al abrir (no al cambiar defaultOrigen mid-save)
  useEffect(() => {
    if (!isOpen) {
      stopCamera();
      return;
    }
    saveLockRef.current = false;
    setMode("choose");
    setFromQR(false);
    setErrorMessage(null);
    setSuccessMessage(null);
    setCascadeHint(null);
    setFuenteOrigen(null);
    setBloqueadoDuplicado(false);
    setDestinoInventario(defaultOrigen);
    setQrDecodedRaw(null);
    setFormData({
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
      origen: defaultOrigen,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo al abrir
  }, [isOpen]);

  // Manejo de ESC para cerrar
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Detener la cámara
  const stopCamera = useCallback(() => {
    if (scanLoopRef.current) {
      cancelAnimationFrame(scanLoopRef.current);
      scanLoopRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
  }, []);

  // Parsear datos obtenidos del QR (texto legible o JSON legacy)
  const parseQRContent = (rawText: string) => {
    const parsed = parseInventarioQrText(rawText);
    const etiqueta = String(parsed.etiqueta || "").trim();
    const destino = destinoInventario || defaultOrigen;
    const cascade = etiqueta ? applyCascadeFromEtiqueta(etiqueta, destino) : null;

    setFormData((prev) => {
      const fromHistory = cascade?.fields ?? null;
      return {
        ...prev,
        ...(fromHistory || {}),
        ...Object.fromEntries(
          Object.entries(parsed).filter(([, v]) => v !== undefined && v !== "" && v !== null),
        ),
        cantidad:
          parsed.cantidad !== undefined && parsed.cantidad !== null
            ? parsed.cantidad
            : fromHistory?.cantidad ?? prev.cantidad ?? 1,
        origen: String(parsed.origen || "").trim() || destino,
        etiqueta: etiqueta || prev.etiqueta,
        estado: String(parsed.estado || prev.estado || "Activo"),
      };
    });

    if (!etiqueta) {
      setCascadeHint(null);
      setFuenteOrigen(null);
      setBloqueadoDuplicado(false);
    }

    setQrDecodedRaw(rawText);
    setFromQR(true);
    stopCamera();
    setMode("form");
  };

  const beginQrScanLoop = useCallback(() => {
    const scan = () => {
      if (!videoRef.current || !canvasRef.current) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      if (video.readyState === video.HAVE_ENOUGH_DATA && ctx) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: "dontInvert",
        });

        if (code && code.data) {
          parseQRContent(code.data);
          return;
        }
      }
      scanLoopRef.current = requestAnimationFrame(scan);
    };

    scanLoopRef.current = requestAnimationFrame(scan);
  }, []);

  // Iniciar cámara y escaneo continuo
  const startCamera = useCallback(async (facing: "environment" | "user" = facingMode) => {
    stopCamera();
    setCameraError(null);

    try {
      const host = typeof window !== "undefined" ? window.location.hostname : "";
      const insecureLan =
        typeof window !== "undefined" &&
        !window.isSecureContext &&
        host !== "localhost" &&
        host !== "127.0.0.1";

      if (insecureLan || !navigator.mediaDevices?.getUserMedia) {
        setCameraError(
          "La cámara en el celular necesita HTTPS. Opción fácil: en la PC corre npm run dev y en otra terminal npm run dev:phone; abre en el cel la URL https://…trycloudflare.com. Mientras, usa Subir imagen.",
        );
        return;
      }

      const tryConstraints: MediaStreamConstraints[] = [
        { video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } } },
        { video: { facingMode: facing } },
        { video: true },
      ];

      let stream: MediaStream | null = null;
      let lastError: unknown = null;
      for (const constraints of tryConstraints) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          break;
        } catch (err) {
          lastError = err;
        }
      }

      if (!stream) {
        throw lastError instanceof Error
          ? lastError
          : new Error("No se pudo acceder a la cámara.");
      }

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute("playsinline", "true");
        videoRef.current.muted = true;
        await videoRef.current.play();
        setCameraActive(true);
        beginQrScanLoop();
      }
    } catch (err: unknown) {
      console.error("Error al acceder a la cámara:", err);
      const name = err instanceof Error ? err.name : "";
      const message =
        name === "NotAllowedError"
          ? "Permiso denegado para usar la cámara. Permite el acceso o sube una imagen del QR."
          : name === "NotFoundError"
            ? "No se encontró cámara en este dispositivo. Usa Subir imagen o registro manual."
            : "No se pudo iniciar la cámara. Intenta subir una foto o ingresa manualmente.";
      setCameraError(message);
      setCameraActive(false);
    }
  }, [facingMode, stopCamera, beginQrScanLoop]);

  // Cambiar entre cámara frontal y trasera
  const toggleFacingMode = () => {
    const next = facingMode === "environment" ? "user" : "environment";
    setFacingMode(next);
    startCamera(next);
  };

  // Procesar archivo de imagen con QR
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setCameraError(null);
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: "dontInvert",
        });

        if (code && code.data) {
          parseQRContent(code.data);
        } else {
          setCameraError("No se detectó ningún código QR en la imagen proporcionada. Intenta con otra imagen más nítida.");
        }
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  // Generar etiqueta sugerida aleatoria si el usuario no tiene una
  const generateSuggestedTag = () => {
    const prefix = "OF-";
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    setCascadeHint(null);
    setFuenteOrigen(null);
    setBloqueadoDuplicado(false);
    setFormData((prev) => ({ ...prev, etiqueta: `${prefix}${randomNum}` }));
  };

  const handleEtiquetaLookup = (etiqueta: string) => {
    const destino = destinoInventario || defaultOrigen;
    const cascade = applyCascadeFromEtiqueta(etiqueta, destino);
    if (!cascade) {
      setFormData((prev) => ({
        ...prev,
        etiqueta: etiqueta.trim() || prev.etiqueta,
        origen: destino,
      }));
      return;
    }
    // Aunque esté bloqueado por duplicado, mostrar los datos de la etiqueta
    setFormData((prev) => ({
      ...prev,
      ...cascade.fields,
      etiqueta: etiqueta.trim() || prev.etiqueta,
      origen: destino,
    }));
  };

  const handleDestinoChange = (destino: string) => {
    setDestinoInventario(destino);
    const cascade = applyCascadeFromEtiqueta(formData.etiqueta || "", destino);
    if (!cascade) {
      setFormData((prev) => ({ ...prev, origen: destino }));
      return;
    }
    setFormData((prev) => ({
      ...prev,
      ...cascade.fields,
      etiqueta: prev.etiqueta,
      origen: destino,
    }));
  };

  // Envío del formulario
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!formData.etiqueta.trim()) {
      setErrorMessage("Por favor ingresa una etiqueta para el artículo.");
      return;
    }

    const destino = destinoInventario || defaultOrigen;
    if (existsInOrigen(items, formData.etiqueta, destino)) {
      setBloqueadoDuplicado(true);
      setErrorMessage(
        `La etiqueta "${formData.etiqueta.trim()}" ya está en ${destino}. Debe ser completamente nueva en ese inventario.`,
      );
      return;
    }
    if (!formData.articulo.trim()) {
      setErrorMessage("Por favor ingresa el nombre o descripción del artículo.");
      return;
    }
    if (!formData.area.trim()) {
      setErrorMessage("Por favor indica el área a la que pertenece el artículo.");
      return;
    }

    setIsSubmitting(true);

    try {
      const result = await addInventarioAction({
        ...formData,
        origen: destino,
      });

      if (!result.success || !result.data) {
        setErrorMessage(result.error || "No se pudo guardar el artículo. Inténtalo de nuevo.");
        setIsSubmitting(false);
        return;
      }

      saveLockRef.current = true;
      setCascadeHint(null);
      setBloqueadoDuplicado(false);
      setFuenteOrigen(null);
      setErrorMessage(null);
      setSuccessMessage("¡Artículo guardado correctamente!");
      const created = result.data;
      setIsSubmitting(false);

      setTimeout(() => {
        onCreated(created);
        onClose();
      }, 1100);
      return;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error al guardar. Inténtalo de nuevo.";
      setErrorMessage(msg);
      setIsSubmitting(false);
    }
  };

  const handleCsvImport = async (file: File | null) => {
    if (!file || isImporting) return;
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsImporting(true);

    try {
      const origen = destinoInventario || defaultOrigen;
      const parsed = await parseInventarioImportFile(file, origen);
      if (!parsed.items.length) {
        setErrorMessage(
          "No se encontraron filas válidas para importar. Verifica Etiqueta y Articulo."
        );
        setIsImporting(false);
        return;
      }

      const result = await addInventarioBulkAction(parsed.items);
      if (!result.success || !result.data?.length) {
        setErrorMessage(result.error || "No se pudo importar el archivo.");
        setIsImporting(false);
        return;
      }

      const ok = result.data.length;
      const notes: string[] = [];
      if (parsed.skipped > 0) notes.push(`${parsed.skipped} vacías`);
      if (parsed.skippedDupEtiqueta > 0) {
        notes.push(`${parsed.skippedDupEtiqueta} etiqueta dup. en el mismo origen`);
      }
      const skippedNote = notes.length ? ` (omitidas: ${notes.join(", ")})` : "";
      setSuccessMessage(`Se importaron ${ok} artículo${ok === 1 ? "" : "s"}${skippedNote}.`);
      onCreated(result.data);
      setIsImporting(false);
      setTimeout(() => onClose(), 1400);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : "No se pudo leer el archivo.";
      const lower = raw.toLowerCase();
      const msg =
        lower.includes("fetch failed") || lower.includes("network")
          ? "No se pudo conectar a Supabase al importar el archivo. Revisa internet, que el proyecto no esté pausado, y Frontend-ia/.env.local (URL + anon key). Reinicia npm run dev e inténtalo de nuevo."
          : raw;
      setErrorMessage(msg);
      setIsImporting(false);
    } finally {
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  };

  if (!isOpen) return null;

  return (
    <ModalPortal>
    <div className="product-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="product-modal-card">
        {/* Encabezado del Modal */}
        <header className="product-modal-header">
          <div className="product-modal-title-group">
            {mode !== "choose" ? (
              <button
                type="button"
                className="product-modal-back"
                onClick={() => {
                  stopCamera();
                  setErrorMessage(null);
                  setMode(mode === "form" && fromQR ? "qr" : "choose");
                }}
                aria-label="Volver atrás"
              >
                <ArrowLeft size={18} />
              </button>
            ) : null}
            <div>
              <h2 id="modal-title">
                {mode === "choose"
                  ? "Registrar nuevo artículo"
                  : mode === "qr"
                  ? "Escanear código QR"
                  : fromQR
                  ? "Revisar datos del artículo"
                  : "Registro manual de artículo"}
              </h2>
              <p>
                {mode === "choose"
                  ? "Elige cómo quieres registrar el artículo"
                  : mode === "qr"
                  ? "Apunta con la cámara al QR o sube una imagen con el código"
                  : fromQR
                  ? "Verifica y edita la información antes de guardar"
                  : "Completa los campos para dar de alta el artículo"}
              </p>
            </div>
          </div>
          <div className="product-modal-header-actions">
            {mode === "choose" ? (
              <>
                <input
                  ref={csvInputRef}
                  type="file"
                  accept=".csv,.txt,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  hidden
                  onChange={(e) => handleCsvImport(e.target.files?.[0] ?? null)}
                />
                <button
                  type="button"
                  className="product-modal-import"
                  onClick={() => csvInputRef.current?.click()}
                  disabled={isImporting}
                  title="Importar CSV o Excel"
                  aria-label="Importar CSV o Excel"
                >
                  {isImporting ? (
                    <Loader2 size={16} className="spin" />
                  ) : (
                    <FileSpreadsheet size={16} />
                  )}
                  <span>{isImporting ? "Importando…" : "CSV / Excel"}</span>
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="product-modal-close"
              onClick={onClose}
              aria-label="Cerrar modal"
            >
              <X size={19} />
            </button>
          </div>
        </header>

        {/* Notificaciones de éxito o error */}
        {errorMessage ? (
          <div className="modal-alert modal-alert-error" role="alert">
            <AlertCircle size={17} />
            <span>{errorMessage}</span>
          </div>
        ) : null}

        {successMessage ? (
          <div className="modal-alert modal-alert-success" role="alert">
            <CheckCircle2 size={17} />
            <span>{successMessage}</span>
          </div>
        ) : null}

        {/* CONTENIDO SEGÚN MODO */}

        {/* 1. SELECCIÓN DE MÉTODO */}
        {mode === "choose" ? (
          <div className="product-modal-body">
            <div className="choose-options-grid">
              {/* Opción 1: Escanear QR */}
              <button
                type="button"
                className="choose-card choose-card-qr"
                onClick={() => {
                  setMode("qr");
                  setFromQR(true);
                  startCamera();
                }}
              >
                <div className="choose-card-badge">Automático</div>
                <div className="choose-card-icon">
                  <QrCode size={36} strokeWidth={1.8} />
                </div>
                <h3>Escanear código QR</h3>
                <p>
                  Lee automáticamente la información del artículo usando la cámara de tu dispositivo o
                  subiendo una foto. Luego podrás revisarla y editarla.
                </p>
                <span className="choose-card-action">
                  <span>Abrir escáner</span>
                  <span className="arrow-pill">→</span>
                </span>
              </button>

              {/* Opción 2: Registro Manual */}
              <button
                type="button"
                className="choose-card choose-card-manual"
                onClick={() => {
                  setMode("form");
                  setFromQR(false);
                }}
              >
                <div className="choose-card-badge">Paso a paso</div>
                <div className="choose-card-icon">
                  <FilePenLine size={36} strokeWidth={1.8} />
                </div>
                <h3>Registro manual</h3>
                <p>
                  Captura punto por punto todos los datos del artículo (etiqueta, marca, serie, área,
                  responsable, cantidad y observaciones).
                </p>
                <span className="choose-card-action">
                  <span>Llenar formulario</span>
                  <span className="arrow-pill">→</span>
                </span>
              </button>
            </div>
          </div>
        ) : null}

        {/* 2. ESCÁNER DE CÓDIGO QR */}
        {mode === "qr" ? (
          <div className="product-modal-body">
            <div className="qr-scanner-container qr-scanner-modern">
              <div className="qr-viewport">
                <video ref={videoRef} className="qr-video" muted playsInline />
                <canvas ref={canvasRef} style={{ display: "none" }} />

                {cameraActive ? (
                  <>
                    <div className="qr-status-pill">
                      <ScanLine size={14} />
                      <span>Buscando código…</span>
                    </div>
                    <div className="qr-overlay-reticle">
                      <div className="qr-scan-laser" />
                      <div className="qr-corner top-left" />
                      <div className="qr-corner top-right" />
                      <div className="qr-corner bottom-left" />
                      <div className="qr-corner bottom-right" />
                    </div>
                  </>
                ) : (
                  <div className="qr-placeholder">
                    {cameraError ? (
                      <div className="qr-camera-prompt">
                        <span className="qr-prompt-icon is-warn">
                          <VideoOff size={28} />
                        </span>
                        <p>{cameraError}</p>
                        <button
                          type="button"
                          className="btn-retry-cam"
                          onClick={() => startCamera()}
                        >
                          <RefreshCw size={15} />
                          <span>Reintentar cámara</span>
                        </button>
                      </div>
                    ) : (
                      <div className="qr-camera-prompt">
                        <span className="qr-prompt-icon">
                          <Loader2 size={28} className="spin" />
                        </span>
                        <p>Preparando cámara…</p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="qr-controls">
                <div className="qr-controls-group">
                  {cameraActive ? (
                    <button
                      type="button"
                      className="qr-tool-btn"
                      onClick={toggleFacingMode}
                      title="Cambiar entre cámara frontal o trasera"
                    >
                      <RefreshCw size={16} />
                      <span>Cambiar cámara</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="qr-tool-btn is-primary"
                      onClick={() => startCamera()}
                    >
                      <Camera size={16} />
                      <span>Activar cámara</span>
                    </button>
                  )}

                  <label className="qr-tool-btn file-upload-label" title="Subir foto con código QR">
                    <Upload size={16} />
                    <span>Subir imagen</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleFileUpload}
                      style={{ display: "none" }}
                    />
                  </label>
                </div>
                <p className="qr-help-hint">
                  Centra el código en el recuadro o sube una foto clara.
                </p>
              </div>

              <div className="qr-paste-card">
                <div className="qr-paste-head">
                  <span className="qr-paste-icon" aria-hidden="true">
                    <ClipboardPaste size={16} />
                  </span>
                  <div>
                    <strong>Pegar código</strong>
                    <p>Pega el texto del QR (Google Lens / escáner) o solo la etiqueta</p>
                  </div>
                </div>
                <div className="qr-paste-row">
                  <textarea
                    className="qr-paste-input"
                    rows={3}
                    placeholder={"INVENTARIO\nEtiqueta: PC-001\nArtículo: Laptop\n…"}
                    aria-label="Pegar código o texto del QR"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        const value = (e.target as HTMLTextAreaElement).value.trim();
                        if (value) parseQRContent(value);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="qr-paste-btn"
                    onClick={async () => {
                      try {
                        const text = await navigator.clipboard.readText();
                        if (text.trim()) parseQRContent(text);
                      } catch {
                        setCameraError(
                          "No se pudo leer el portapapeles. Pega el código en el campo y pulsa Continuar.",
                        );
                      }
                    }}
                  >
                    Pegar
                  </button>
                  <button
                    type="button"
                    className="qr-paste-btn is-solid"
                    onClick={(e) => {
                      const input = (e.currentTarget.parentElement?.querySelector(
                        ".qr-paste-input",
                      ) as HTMLTextAreaElement | null);
                      const value = input?.value.trim() ?? "";
                      if (value) parseQRContent(value);
                    }}
                  >
                    Continuar
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {/* 3. FORMULARIO DE DATOS (Manual o Post-QR para verificar y modificar) */}
        {mode === "form" ? (
          <form className="product-modal-body form-body" onSubmit={handleSubmit}>
            {fromQR ? (
              <div className="qr-success-banner">
                <CheckCircle2 size={18} />
                <div>
                  <strong>Información detectada desde el código QR</strong>
                  <p>Verifica y modifica cualquier campo necesario antes de guardar.</p>
                </div>
              </div>
            ) : null}

            <div className="form-grid">
              {/* Etiqueta */}
              <div className="form-field">
                <div className="field-label-row">
                  <label htmlFor="field-etiqueta">
                    Etiqueta / Código <span className="req">*</span>
                  </label>
                  <button
                    type="button"
                    className="tag-generator-btn"
                    onClick={generateSuggestedTag}
                    title="Generar código sugerido"
                  >
                    <Sparkles size={13} />
                    <span>Sugerir código</span>
                  </button>
                </div>
                <input
                  id="field-etiqueta"
                  required
                  placeholder="Ej. ACT-0421, LAP-2026"
                  value={formData.etiqueta}
                  onChange={(e) => {
                    setCascadeHint(null);
                    setFormData((prev) => ({ ...prev, etiqueta: e.target.value }));
                  }}
                  onBlur={(e) => handleEtiquetaLookup(e.target.value)}
                />
              </div>

              {/* Artículo */}
              <div className="form-field">
                <label htmlFor="field-articulo">
                  Artículo <span className="req">*</span>
                </label>
                <input
                  id="field-articulo"
                  required
                  placeholder="Ej. Laptop ThinkPad T14, Monitor Dell 27"
                  value={formData.articulo}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, articulo: e.target.value }))
                  }
                />
              </div>

              {/* Marca */}
              <div className="form-field">
                <label htmlFor="field-marca">Marca</label>
                <input
                  id="field-marca"
                  placeholder="Ej. Lenovo, Apple, Dell, Herman Miller"
                  value={formData.marca || ""}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, marca: e.target.value }))
                  }
                />
              </div>

              {/* Modelo */}
              <div className="form-field">
                <label htmlFor="field-modelo">Modelo</label>
                <input
                  id="field-modelo"
                  placeholder="Ej. Gen 2, Inspiron 15, Aeron"
                  value={formData.modelo || ""}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, modelo: e.target.value }))
                  }
                />
              </div>

              {/* Serie */}
              <div className="form-field">
                <label htmlFor="field-serie">Número de Serie</label>
                <input
                  id="field-serie"
                  placeholder="Ej. PF2X98ZA, SN-981240"
                  value={formData.serie || ""}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, serie: e.target.value }))
                  }
                />
              </div>

              {/* Área */}
              <div className="form-field">
                <label htmlFor="field-area">
                  Área / Ubicación <span className="req">*</span>
                </label>
                <input
                  id="field-area"
                  required
                  list="areas-datalist"
                  placeholder="Ej. Sistemas, Administración, Diseño"
                  value={formData.area}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, area: e.target.value }))
                  }
                />
                <datalist id="areas-datalist">
                  {existingAreas.map((area) => (
                    <option key={area} value={area} />
                  ))}
                </datalist>
              </div>

              {/* Persona asignada */}
              <div className="form-field">
                <label htmlFor="field-persona">Persona asignada</label>
                <input
                  id="field-persona"
                  list="people-datalist"
                  placeholder="Ej. Carlos Mendoza, Ana López (o dejar vacío)"
                  value={formData.persona || ""}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, persona: e.target.value }))
                  }
                />
                <datalist id="people-datalist">
                  {existingPeople.map((person) => (
                    <option key={person} value={person} />
                  ))}
                </datalist>
              </div>

              {/* Cantidad */}
              <div className="form-field">
                <label htmlFor="field-cantidad">
                  Cantidad <span className="req">*</span>
                </label>
                <input
                  id="field-cantidad"
                  type="number"
                  min="0"
                  required
                  value={formData.cantidad ?? 1}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      cantidad: parseInt(e.target.value, 10) || 0,
                    }))
                  }
                />
              </div>

              {/* Origen automático + inventario destino editable */}
              <div className="form-field form-field-full origen-destino-row">
                <div className="form-field">
                  <label htmlFor="field-origen">Origen (de dónde se tomó)</label>
                  <div
                    id="field-origen"
                    className={
                      fuenteOrigen
                        ? "origen-readonly has-source"
                        : "origen-readonly is-new"
                    }
                    aria-live="polite"
                  >
                    <span>{fuenteOrigen || "Registro nuevo"}</span>
                  </div>
                </div>
                <div className="form-field">
                  <label htmlFor="field-destino">Inventario destino</label>
                  <ModernOrigenSelect
                    id="field-destino"
                    value={destinoInventario || defaultOrigen}
                    options={existingOrigens}
                    createOption={createOrigenOption}
                    onChange={handleDestinoChange}
                  />
                </div>
              </div>

              {cascadeHint && !successMessage ? (
                <div className="form-field form-field-full">
                  <p
                    className={
                      bloqueadoDuplicado ? "cascade-hint is-blocked" : "cascade-hint"
                    }
                    role="status"
                  >
                    {cascadeHint}
                  </p>
                </div>
              ) : null}

              <div className="form-field">
                <label htmlFor="field-estado">Estado del artículo</label>
                <ModernEstadoSelect
                  id="field-estado"
                  value={formData.estado === "Inactivo" ? "Inactivo" : "Activo"}
                  onChange={(estado) =>
                    setFormData((prev) => ({ ...prev, estado }))
                  }
                />
              </div>

              {/* Observaciones (ocupa 2 columnas) */}
              <div className="form-field form-field-full">
                <label htmlFor="field-observaciones">Observaciones adicionales</label>
                <textarea
                  id="field-observaciones"
                  rows={2}
                  placeholder="Condiciones del equipo, cargador incluido, garantía, etc."
                  value={formData.observaciones || ""}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, observaciones: e.target.value }))
                  }
                />
              </div>
            </div>

            {/* Footer con acciones */}
            <div className="form-footer">
              <button
                type="button"
                className="btn-cancel"
                onClick={onClose}
                disabled={isSubmitting}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="btn-submit"
                disabled={isSubmitting || bloqueadoDuplicado}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 size={16} className="spin" />
                    <span>Guardando...</span>
                  </>
                ) : (
                  <>
                    <Plus size={16} strokeWidth={2.4} />
                    <span>Guardar artículo</span>
                  </>
                )}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
    </ModalPortal>
  );
}
