"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import jsQR from "jsqr";
import {
  Camera,
  CheckCircle2,
  FilePenLine,
  Image as ImageIcon,
  Loader2,
  Plus,
  QrCode,
  RefreshCw,
  Sparkles,
  Upload,
  VideoOff,
  X,
  AlertCircle,
  ArrowLeft,
} from "lucide-react";
import type { InventarioRow, NewInventarioItem } from "@/lib/supabase";
import { addInventarioAction } from "@/app/actions";

interface AddProductModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (item: InventarioRow) => void;
  existingAreas: string[];
  existingPeople: string[];
}

type StepMode = "choose" | "qr" | "form";

const ORIGEN_OPTIONS = ["Compra", "Donación", "Préstamo", "Traslado", "Otro"] as const;

export default function AddProductModal({
  isOpen,
  onClose,
  onCreated,
  existingAreas,
  existingPeople,
}: AddProductModalProps) {
  const [mode, setMode] = useState<StepMode>("choose");
  const [fromQR, setFromQR] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

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
    origen: "Compra",
  });

  // QR Scanner State
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const scanLoopRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [qrDecodedRaw, setQrDecodedRaw] = useState<string | null>(null);

  // Reiniciar estado al abrir/cerrar
  useEffect(() => {
    if (isOpen) {
      setMode("choose");
      setFromQR(false);
      setErrorMessage(null);
      setSuccessMessage(null);
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
        origen: "Compra",
      });
    } else {
      stopCamera();
    }
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

  // Parsear datos obtenidos del QR
  const parseQRContent = (rawText: string) => {
    const trimmed = rawText.trim();
    let parsed: Partial<NewInventarioItem> = {};

    // 1. Intentar parsear como JSON
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const json = JSON.parse(trimmed);
        parsed = {
          etiqueta: json.etiqueta || json.tag || json.label || json.code || json.id || "",
          articulo: json.articulo || json.name || json.item || json.producto || "",
          marca: json.marca || json.brand || "",
          modelo: json.modelo || json.model || "",
          serie: json.serie || json.serial || json.sn || "",
          area: json.area || json.departamento || json.ubicacion || "",
          persona: json.persona || json.asignado || json.user || json.owner || "",
          cantidad:
            typeof json.cantidad === "number"
              ? json.cantidad
              : typeof json.qty === "number"
              ? json.qty
              : 1,
          origen: ORIGEN_OPTIONS.includes(json.origen) ? json.origen : "Compra",
          observaciones: json.observaciones || json.notes || json.desc || "",
        };
      } catch {
        // No era JSON válido, continuar
      }
    }

    // 2. Si no fue JSON, intentar buscar pares clave: valor
    if (!parsed.etiqueta && !parsed.articulo) {
      const lines = trimmed.split(/\r?\n/);
      const dict: Record<string, string> = {};

      for (const line of lines) {
        const separatorIdx = line.indexOf(":");
        if (separatorIdx !== -1) {
          const key = line.slice(0, separatorIdx).trim().toLowerCase();
          const val = line.slice(separatorIdx + 1).trim();
          dict[key] = val;
        }
      }

      if (Object.keys(dict).length > 0) {
        parsed = {
          etiqueta: dict["etiqueta"] || dict["tag"] || dict["codigo"] || dict["id"] || "",
          articulo: dict["articulo"] || dict["producto"] || dict["nombre"] || dict["item"] || "",
          marca: dict["marca"] || dict["brand"] || "",
          modelo: dict["modelo"] || dict["model"] || "",
          serie: dict["serie"] || dict["serial"] || dict["sn"] || "",
          area: dict["area"] || dict["departamento"] || "",
          persona: dict["persona"] || dict["asignado"] || "",
          cantidad: dict["cantidad"] ? parseInt(dict["cantidad"], 10) || 1 : 1,
          origen: ORIGEN_OPTIONS.find((o) => o.toLowerCase() === dict["origen"]?.toLowerCase()) || "Compra",
          observaciones: dict["observaciones"] || dict["notas"] || "",
        };
      }
    }

    // 3. Fallback: usar el texto como etiqueta si es corto, o en observaciones si es largo
    if (!parsed.etiqueta && !parsed.articulo) {
      if (trimmed.length <= 50) {
        parsed.etiqueta = trimmed;
      } else {
        parsed.observaciones = `QR: ${trimmed}`;
      }
    }

    setFormData((prev) => ({
      ...prev,
      ...parsed,
      cantidad: parsed.cantidad !== undefined ? parsed.cantidad : prev.cantidad || 1,
      origen: parsed.origen || prev.origen || "Compra",
    }));

    setQrDecodedRaw(rawText);
    setFromQR(true);
    stopCamera();
    setMode("form");
  };

  // Iniciar cámara y escaneo continuo
  const startCamera = useCallback(async (facing: "environment" | "user" = facingMode) => {
    stopCamera();
    setCameraError(null);

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraError("Tu navegador no soporta el acceso a la cámara o requiere HTTPS.");
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute("playsinline", "true");
        await videoRef.current.play();
        setCameraActive(true);

        // Bucle de lectura de frames
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
              return; // Detener bucle
            }
          }
          scanLoopRef.current = requestAnimationFrame(scan);
        };

        scanLoopRef.current = requestAnimationFrame(scan);
      }
    } catch (err: unknown) {
      console.error("Error al acceder a la cámara:", err);
      const message =
        err instanceof Error && err.name === "NotAllowedError"
          ? "Permiso denegado para usar la cámara. Permite el acceso o sube una imagen del QR."
          : "No se pudo iniciar la cámara. Intenta subir una foto o ingresa manualmente.";
      setCameraError(message);
      setCameraActive(false);
    }
  }, [facingMode, stopCamera]);

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
    setFormData((prev) => ({ ...prev, etiqueta: `${prefix}${randomNum}` }));
  };

  // Envío del formulario
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!formData.etiqueta.trim()) {
      setErrorMessage("Por favor ingresa una etiqueta única para el producto.");
      return;
    }
    if (!formData.articulo.trim()) {
      setErrorMessage("Por favor ingresa el nombre o descripción del artículo.");
      return;
    }
    if (!formData.area.trim()) {
      setErrorMessage("Por favor indica el área a la que pertenece el producto.");
      return;
    }

    setIsSubmitting(true);

    try {
      const result = await addInventarioAction(formData);

      if (!result.success || !result.data) {
        setErrorMessage(result.error || "Ocurrió un error al registrar en Supabase.");
        setIsSubmitting(false);
        return;
      }

      setSuccessMessage("¡Producto registrado con éxito en la base de datos!");
      onCreated(result.data);

      setTimeout(() => {
        onClose();
      }, 1100);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error al conectar con la base de datos.";
      setErrorMessage(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return (
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
                  ? "Registrar nuevo producto"
                  : mode === "qr"
                  ? "Escanear código QR"
                  : fromQR
                  ? "Revisar datos del producto"
                  : "Registro manual de producto"}
              </h2>
              <p>
                {mode === "choose"
                  ? "Selecciona el método de registro para añadir a la base de datos"
                  : mode === "qr"
                  ? "Apunta con la cámara al QR o sube una imagen con el código"
                  : fromQR
                  ? "Verifica y edita la información leída antes de guardar en Supabase"
                  : "Completa los campos para dar de alta el artículo en Supabase"}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="product-modal-close"
            onClick={onClose}
            aria-label="Cerrar modal"
          >
            <X size={19} />
          </button>
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
                  Lee automáticamente la información del producto usando la cámara de tu dispositivo o
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
            <div className="qr-scanner-container">
              {/* Contenedor de Video */}
              <div className="qr-viewport">
                <video ref={videoRef} className="qr-video" muted />
                <canvas ref={canvasRef} style={{ display: "none" }} />

                {cameraActive ? (
                  <div className="qr-overlay-reticle">
                    <div className="qr-scan-laser" />
                    <div className="qr-corner top-left" />
                    <div className="qr-corner top-right" />
                    <div className="qr-corner bottom-left" />
                    <div className="qr-corner bottom-right" />
                  </div>
                ) : (
                  <div className="qr-placeholder">
                    {cameraError ? (
                      <div className="qr-camera-prompt">
                        <VideoOff size={40} />
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
                        <Loader2 size={36} className="spin" />
                        <p>Iniciando cámara...</p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Barra de herramientas del escáner */}
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
                      className="qr-tool-btn"
                      onClick={() => startCamera()}
                    >
                      <Camera size={16} />
                      <span>Activar cámara</span>
                    </button>
                  )}

                  {/* Subir archivo de imagen */}
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
                  Coloca el código QR dentro del recuadro o carga un archivo con la imagen del código.
                </p>
              </div>

              {/* Fallback de entrada directa de texto/JSON del QR */}
              <details className="qr-manual-fallback">
                <summary>¿Tienes el código copiado o en texto?</summary>
                <div className="qr-manual-input-box">
                  <textarea
                    rows={2}
                    placeholder='Pega aquí el contenido del QR (ej. JSON: {"etiqueta": "E-10", "articulo": "Mouse"})'
                    onChange={(e) => {
                      if (e.target.value.trim()) {
                        parseQRContent(e.target.value);
                      }
                    }}
                  />
                </div>
              </details>
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
                  <p>Verifica y modifica cualquier campo necesario antes de registrar en Supabase.</p>
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
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, etiqueta: e.target.value }))
                  }
                />
              </div>

              {/* Artículo */}
              <div className="form-field">
                <label htmlFor="field-articulo">
                  Artículo / Producto <span className="req">*</span>
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

              {/* Origen */}
              <div className="form-field">
                <label htmlFor="field-origen">Origen</label>
                <select
                  id="field-origen"
                  value={formData.origen || "Compra"}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, origen: e.target.value }))
                  }
                >
                  {ORIGEN_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
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
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 size={16} className="spin" />
                    <span>Guardando en Supabase...</span>
                  </>
                ) : (
                  <>
                    <Plus size={16} strokeWidth={2.4} />
                    <span>Registrar en Base de Datos</span>
                  </>
                )}
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}
