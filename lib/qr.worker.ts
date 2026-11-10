/// <reference lib="webworker" />
import QRCode from "qrcode";

export type QrWorkerRequest = {
  id: number;
  text: string;
  options: {
    width: number;
    margin: number;
    errorCorrectionLevel: "L" | "M" | "Q" | "H";
    color: { dark: string; light: string };
  };
};

export type QrWorkerResponse =
  | { id: number; url: string }
  | { id: number; error: string };

self.onmessage = async (event: MessageEvent<QrWorkerRequest>) => {
  const { id, text, options } = event.data;
  try {
    const url = await QRCode.toDataURL(text, options);
    const response: QrWorkerResponse = { id, url };
    self.postMessage(response);
  } catch (error) {
    const response: QrWorkerResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

export {};
