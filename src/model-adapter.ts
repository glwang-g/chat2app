export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelAdapterOptions {
  url: string;
  apiKey: string;
  model: string;
  thinking?: "enabled" | "disabled";
}

export function parseSSE(text: string, onData: (event: any) => void): void {
  for (const block of text.split("\n\n")) {
    const line = block.split("\n").find((item) => item.startsWith("data:"));
    if (!line) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try { onData(JSON.parse(data)); } catch { /* 忽略不完整块 */ }
  }
}

function headers(apiKey: string): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: "Bearer " + apiKey };
}

export async function streamChat(options: ModelAdapterOptions, messages: ModelMessage[], signal: AbortSignal | undefined, onDelta: (content: string) => void): Promise<void> {
  const response = await fetch(options.url, {
    method: "POST",
    headers: headers(options.apiKey),
    body: JSON.stringify({ model: options.model, messages, stream: true, temperature: 0.7, thinking: { type: options.thinking || "disabled" } }),
    signal,
  });
  if (!response.ok) throw new Error("模型返回 " + response.status + "：" + (await response.text()).slice(0, 300));
  if (!response.body) throw new Error("模型没有返回可读流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      parseSSE(part, (event) => {
        const delta = event.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      });
    }
  }
  if (buffer.trim()) parseSSE(buffer, (event) => {
    const delta = event.choices?.[0]?.delta?.content;
    if (delta) onDelta(delta);
  });
}

export async function completeChat(options: ModelAdapterOptions, messages: ModelMessage[], signal: AbortSignal | undefined, temperature = 0.2): Promise<string> {
  const response = await fetch(options.url, {
    method: "POST",
    headers: headers(options.apiKey),
    body: JSON.stringify({ model: options.model, messages, stream: false, temperature }),
    signal,
  });
  if (!response.ok) throw new Error("模型返回 " + response.status + "：" + (await response.text()).slice(0, 300));
  const body: any = await response.json();
  return body.choices?.[0]?.message?.content || "";
}
