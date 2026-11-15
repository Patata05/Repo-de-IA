/** Cliente para prosa dinámica (PydanticAI en Backend-ia). */

export type ComposeChatReplyInput = {
  userText: string;
  kind?: string;
  facts?: Record<string, unknown>;
  threadHint?: string;
  fallback: string;
  /** Memoria PydanticAI (messages_json) por chat. */
  sessionId?: string | null;
};

export type ComposeChatReplyResult = {
  reply: string;
  followUps: string[];
  engine: "pydantic-ai" | "fallback";
};

export async function composeChatReply(
  input: ComposeChatReplyInput,
): Promise<ComposeChatReplyResult> {
  const fallback = String(input.fallback || "").trim();
  try {
    const response = await fetch("/api/chat/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_text: input.userText,
        kind: input.kind || "general",
        facts: input.facts || {},
        thread_hint: input.threadHint || "",
        session_id: input.sessionId || undefined,
        fallback,
      }),
      cache: "no-store",
    });
    const data = (await response.json()) as {
      ok?: boolean;
      reply?: string | null;
      follow_ups?: string[];
      engine?: string;
    };
    const reply = String(data.reply || "").trim();
    if (reply) {
      return {
        reply,
        followUps: Array.isArray(data.follow_ups)
          ? data.follow_ups.map((u) => String(u).trim()).filter(Boolean).slice(0, 3)
          : [],
        engine: data.ok ? "pydantic-ai" : "fallback",
      };
    }
  } catch {
    /* backend caído → plantilla local */
  }
  return { reply: fallback, followUps: [], engine: "fallback" };
}
