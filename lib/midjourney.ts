import { Midjourney } from "midjourney";

const ServerId = process.env.MIDJOURNEY_SERVER_ID;
const ChannelId = process.env.MIDJOURNEY_CHANNEL_ID;
const SalaiToken = process.env.MIDJOURNEY_SALAI_TOKEN;

let midjourneyClient: Midjourney | null = null;

export function getMidjourneyClient(): Midjourney {
  if (!ServerId || !ChannelId || !SalaiToken) {
    throw new Error(
      "Faltan variables de entorno para Midjourney (MIDJOURNEY_SERVER_ID, MIDJOURNEY_CHANNEL_ID, MIDJOURNEY_SALAI_TOKEN) en .env.local."
    );
  }

  if (!midjourneyClient) {
    midjourneyClient = new Midjourney({
      ServerId,
      ChannelId,
      SalaiToken,
      Debug: process.env.NODE_ENV === "development",
      Ws: true,
    });
  }

  return midjourneyClient;
}

export async function generateMidjourneyImage(prompt: string) {
  const client = getMidjourneyClient();
  await client.init();
  const msg = await client.Imagine(prompt);
  return msg;
}
