"use client";

import QRCode from "qrcode";
import {
  formatInventarioQrText,
  INVENTARIO_QR_RENDER,
} from "@/lib/inventario-qr";
import type { InventarioRow, NewInventarioItem } from "@/lib/supabase";
import type { QrWorkerRequest, QrWorkerResponse } from "@/lib/qr.worker";

const cache = new Map<string, string>();
const MAX_CACHE = 96;
const pending = new Map<string, Promise<string>>();

let worker: Worker | null = null;
let workerBroken = false;
let nextJobId = 1;
const workerWaiters = new Map<
  number,
  { resolve: (url: string) => void; reject: (err: Error) => void }
>();

function getWorker(): Worker | null {
  if (workerBroken || typeof window === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./qr.worker.ts", import.meta.url));
    worker.onmessage = (event: MessageEvent<QrWorkerResponse>) => {
      const data = event.data;
      const waiter = workerWaiters.get(data.id);
      if (!waiter) return;
      workerWaiters.delete(data.id);
      if ("error" in data && data.error) {
        waiter.reject(new Error(data.error));
      } else if ("url" in data) {
        waiter.resolve(data.url);
      } else {
        waiter.reject(new Error("Respuesta QR inválida"));
      }
    };
    worker.onerror = () => {
      workerBroken = true;
      worker?.terminate();
      worker = null;
      for (const [, waiter] of workerWaiters) {
        waiter.reject(new Error("QR worker falló"));
      }
      workerWaiters.clear();
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

function cacheSet(key: string, url: string) {
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest != null) cache.delete(oldest);
  }
  cache.set(key, url);
}

async function encodeOnWorker(text: string): Promise<string> {
  const w = getWorker();
  if (!w) throw new Error("no-worker");
  const id = nextJobId++;
  const options: QrWorkerRequest["options"] = {
    width: INVENTARIO_QR_RENDER.width,
    margin: INVENTARIO_QR_RENDER.margin,
    errorCorrectionLevel: INVENTARIO_QR_RENDER.errorCorrectionLevel,
    color: { dark: "#111827", light: "#ffffff" },
  };
  return new Promise<string>((resolve, reject) => {
    workerWaiters.set(id, { resolve, reject });
    const payload: QrWorkerRequest = { id, text, options };
    w.postMessage(payload);
  });
}

async function encodeOnMain(text: string): Promise<string> {
  // Fallback: ceder un frame para no congelar el primer paint del modal
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
  return QRCode.toDataURL(text, {
    ...INVENTARIO_QR_RENDER,
    color: { dark: "#111827", light: "#ffffff" },
  });
}

/** Ficha completa en el QR, con worker + caché (no congela la UI). */
export async function encodeProductQrDataUrl(
  product: Partial<InventarioRow | NewInventarioItem>,
): Promise<string> {
  const text = formatInventarioQrText(product);
  if (!text) return "";

  const hit = cache.get(text);
  if (hit) return hit;

  const existing = pending.get(text);
  if (existing) return existing;

  const job = (async () => {
    try {
      let url = "";
      try {
        url = await encodeOnWorker(text);
      } catch {
        url = await encodeOnMain(text);
      }
      if (url) cacheSet(text, url);
      return url;
    } finally {
      pending.delete(text);
    }
  })();

  pending.set(text, job);
  return job;
}
