import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;

export const openai = apiKey
  ? new OpenAI({
      apiKey,
    })
  : null;

export interface DalleGenerateOptions {
  prompt: string;
  model?: "dall-e-3" | "dall-e-2";
  size?: "1024x1024" | "1792x1024" | "1024x1792" | "512x512" | "256x256";
  quality?: "standard" | "hd";
}

export async function generateDalleImage({
  prompt,
  model = "dall-e-3",
  size = "1024x1024",
  quality = "standard",
}: DalleGenerateOptions) {
  if (!openai) {
    throw new Error(
      "OPENAI_API_KEY no está configurada en las variables de entorno (.env.local)."
    );
  }

  const response = await openai.images.generate({
    model,
    prompt,
    n: 1,
    size,
    quality,
  });

  return {
    url: response.data?.[0]?.url ?? null,
    revisedPrompt: response.data?.[0]?.revised_prompt ?? null,
  };
}
