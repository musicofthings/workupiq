/**
 * Pitch review API. A stateless proxy from the browser to the user's chosen provider.
 * Deck text and API keys are used for one upstream call, then dropped. Never log them.
 *
 * Upstream hosts are fixed here and clients cannot supply a base URL, so this
 * cannot be used to reach arbitrary or internal addresses.
 */

type Auth = "bearer" | "x-api-key" | "x-goog-api-key";

interface Provider {
  style: "openai" | "anthropic" | "gemini";
  baseUrl: string;
  modelsUrl: string;
  auth: Auth;
  keyOptionalForCatalog?: boolean;
  headers?: Record<string, string>;
}

const PROVIDERS: Record<string, Provider> = {
  openrouter: {
    style: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    // The default output_modalities is "text", which silently drops other models.
    modelsUrl: "https://openrouter.ai/api/v1/models?output_modalities=all",
    auth: "bearer",
    keyOptionalForCatalog: true,
  },
  nvidia: {
    style: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    modelsUrl: "https://integrate.api.nvidia.com/v1/models",
    auth: "bearer",
    keyOptionalForCatalog: true,
  },
  grok: {
    style: "openai",
    baseUrl: "https://api.x.ai/v1",
    modelsUrl: "https://api.x.ai/v1/models",
    auth: "bearer",
  },
  openai: {
    style: "openai",
    baseUrl: "https://api.openai.com/v1",
    modelsUrl: "https://api.openai.com/v1/models",
    auth: "bearer",
  },
  anthropic: {
    style: "anthropic",
    baseUrl: "https://api.anthropic.com",
    modelsUrl: "https://api.anthropic.com/v1/models?limit=1000",
    auth: "x-api-key",
    headers: { "anthropic-version": "2023-06-01" },
  },
  gemini: {
    style: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    modelsUrl: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    auth: "x-goog-api-key",
  },
};

const SYSTEM_PROMPT = `You are WorkupIQ, an associate-level venture analyst that screens fundraising decks the way a fund LLM and junior associate will.

Rules:
- Use ONLY facts present in the extracted deck text. If a number is missing, say it is missing. Never invent TAM, revenue, customers, or dates.
- Treat image-only charts as unseen. If a metric is alluded to but no raw number appears in text, flag it under hygiene and data_gaps.
- Write like a partner memo: dense, numbered, tables in markdown.
- Verdict must be exactly one of: Pass, Request Data, Advance.
  Pass = you can still write five durable, evidence-based reasons to decline.
  Request Data = the model is blocked on missing evidence, not on a broken business.
  Advance = adversarial prompts no longer produce novel, well-supported pass reasons from this extract.

Return ONLY this tagged format. Do not wrap in JSON or markdown fences.

===WIQ_VERDICT===
Pass
===WIQ_RATIONALE===
One short paragraph.
===WIQ_PASS_REASONS===
- reason one
- reason two
===WIQ_GAPS===
- missing evidence
===WIQ_HYGIENE===
- parser issue
===WIQ_WORKUP===
Markdown memo with sections: The ask; Problem and why now; Product; Market (state TAM method); Traction table; Competition table; Team; Gatekeeper risks.
===WIQ_FAQ===
Markdown Q/A covering moat, unit economics, regulatory, scientific, GTM.
`;

const ATTACK_SYSTEM = `You are WorkupIQ running one red-team attack on a fundraising extract.
Use ONLY facts in the extract. If a number is missing, say it is missing. Never invent TAM, revenue, customers, or dates.
Return ONLY the single tagged section requested. No JSON. No other tags.
`;

const ATTACKS: Record<string, { tag: string; title: string; prompt: string }> = {
  gatekeeper: {
    tag: "WIQ_GATEKEEPER",
    title: "Gatekeeper Screener",
    prompt:
      "Role: cynical Tier-1 principal, 50+ memos a week, look for reasons to pass in 3 minutes.\n" +
      "Output markdown:\n" +
      "1. Fatal Flaw Checklist: top 3-5 reasons to PASS.\n" +
      "2. Information Deficit: missing or vague data.\n" +
      "3. Verdict: Pass, Request More Data, or Advance to Partner Call, plus 2-sentence rationale.",
  },
  wrapper: {
    tag: "WIQ_WRAPPER",
    title: "Defensibility & Wrapper Stress Test",
    prompt:
      "Role: deep-tech / AI partner attacking moat.\n" +
      "1. Foundation Model Disruption: why a frontier lab or incumbent could commoditize this in 12 months.\n" +
      "2. Moat Evaluation: real data/IP loop vs illusion of complexity.\n" +
      "3. Five hardest CTO diligence questions.",
  },
  forensic: {
    tag: "WIQ_FORENSIC",
    title: "Financial Forensic Audit",
    prompt:
      "Role: quantitative diligence associate.\n" +
      "1. Math & Sizing Sanity Check on TAM/SAM/SOM.\n" +
      "2. Burn vs runway vs stated milestones.\n" +
      "3. CAC & payback vs typical enterprise B2B.",
  },
  premortem: {
    tag: "WIQ_PREMORTEM",
    title: "Partner Meeting Pre-Mortem",
    prompt:
      "Role: IC pre-mortem. Assume we funded today and the company is zero or down-round in 24 months.\n" +
      "1. Primary cause of failure.\n" +
      "2. Underestimated external friction.\n" +
      "3. Exact memo/FAQ lines that must be added before IC.",
  },
};

const MAX_BODY_CHARS = 1_000_000;
const PACK_TEXT_CHARS = 80_000;
const ATTACK_TEXT_CHARS = 60_000;
const COMPLETION_TIMEOUT_MS = 180_000;
const CATALOG_TIMEOUT_MS = 40_000;
const MODEL_ID = /^[\w.\-:/@+]{1,200}$/;
const SKIP_NON_CHAT = ["embed", "tts", "whisper", "dall-e", "moderation", "rerank"];

class ClientError extends Error {}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function upstream(
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: unknown; timeoutMs: number },
): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // A followed redirect could carry the user's key to another host.
      redirect: "manual",
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (err: any) {
    if (err?.name === "TimeoutError") throw new Error("The provider took too long to respond.");
    throw new Error("Couldn't reach the provider: " + String(err?.message || err));
  }
  const raw = await res.text();
  if (!res.ok) throw new Error(`The provider returned HTTP ${res.status}: ${providerMessage(raw)}`);
  let body: any;
  try {
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw new Error("Provider response was not JSON: " + raw.slice(0, 300));
  }
  if (body && typeof body === "object" && body.error) {
    throw new Error(providerMessage(raw));
  }
  return body;
}

function providerMessage(raw: string): string {
  try {
    const body = JSON.parse(raw);
    const message = body?.error?.message ?? body?.message ?? body?.error;
    if (typeof message === "string" && message) return message.slice(0, 500);
  } catch {
    // Not JSON; show the raw text below.
  }
  return raw.slice(0, 500);
}

function authHeaders(provider: Provider, key: string): Record<string, string> {
  const headers: Record<string, string> = { ...provider.headers };
  if (!key) return headers;
  if (provider.auth === "bearer") headers.Authorization = "Bearer " + key;
  else headers[provider.auth] = key;
  return headers;
}

function flatten(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" ? String((part as any).text ?? (part as any).content ?? "") : String(part)))
      .join("");
  }
  return String(content);
}

async function complete(provider: Provider, key: string, model: string, system: string, user: string, referer: string): Promise<string> {
  const headers = { "Content-Type": "application/json", ...authHeaders(provider, key) };
  const timeoutMs = COMPLETION_TIMEOUT_MS;
  let text = "";
  if (provider.style === "anthropic") {
    const body = await upstream(provider.baseUrl + "/v1/messages", {
      method: "POST",
      headers,
      timeoutMs,
      body: { model, max_tokens: 8000, system, messages: [{ role: "user", content: user }] },
    });
    text = flatten(body.content);
  } else if (provider.style === "gemini") {
    const url = `${provider.baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = await upstream(url, {
      method: "POST",
      headers,
      timeoutMs,
      body: {
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2 },
      },
    });
    text = flatten(body.candidates?.[0]?.content?.parts);
  } else {
    const body = await upstream(provider.baseUrl + "/chat/completions", {
      method: "POST",
      headers: { ...headers, "HTTP-Referer": referer, "X-Title": "WorkupIQ" },
      timeoutMs,
      body: {
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
    });
    const choice = body.choices?.[0] ?? {};
    text = flatten(choice.message?.content) || flatten(choice.text);
  }
  if (!text.trim()) throw new Error("The provider returned an empty response.");
  return text;
}

function bullets(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean);
}

function normalizeVerdict(verdict: string): string {
  if (verdict.includes("Request Data")) return "Request Data";
  if (verdict.includes("Advance")) return "Advance";
  if (verdict.includes("Pass")) return "Pass";
  return "Request Data";
}

function parseTagged(raw: string): Record<string, string> | null {
  if (!raw.includes("WIQ_")) return null;
  const parts: Record<string, string> = {};
  let current: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const marker =
      trimmed.match(/^(?:#{1,3}\s+)?={2,}\s*(WIQ_[A-Z_]+)\s*={2,}$/) ?? trimmed.match(/^(?:#{1,3}\s+)?(WIQ_[A-Z_]+)$/);
    if (marker) {
      current = marker[1];
      parts[current] ??= "";
      continue;
    }
    if (current) parts[current] += line + "\n";
  }
  return Object.keys(parts).length ? parts : null;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter((item) => item.trim());
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

function parsePack(raw: string) {
  const tagged = parseTagged(raw);
  if (tagged && (tagged.WIQ_WORKUP?.trim() || tagged.WIQ_RATIONALE?.trim())) {
    return {
      verdict: normalizeVerdict(tagged.WIQ_VERDICT ?? ""),
      verdict_rationale: (tagged.WIQ_RATIONALE ?? "").trim(),
      pass_reasons: bullets(tagged.WIQ_PASS_REASONS ?? ""),
      data_gaps: bullets(tagged.WIQ_GAPS ?? ""),
      hygiene: bullets(tagged.WIQ_HYGIENE ?? ""),
      workup_markdown: (tagged.WIQ_WORKUP ?? "").trim(),
      faq_markdown: (tagged.WIQ_FAQ ?? "").trim(),
    };
  }

  const blob = raw.match(/\{[\s\S]*\}/)?.[0];
  if (blob) {
    try {
      const repaired = blob.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, "$1");
      const data = JSON.parse(repaired);
      if (data && typeof data === "object" && ("verdict" in data || "workup_markdown" in data)) {
        return {
          verdict: normalizeVerdict(String(data.verdict ?? "")),
          verdict_rationale: String(data.verdict_rationale ?? ""),
          pass_reasons: asList(data.pass_reasons),
          data_gaps: asList(data.data_gaps),
          hygiene: asList(data.hygiene),
          workup_markdown: String(data.workup_markdown ?? ""),
          faq_markdown: String(data.faq_markdown ?? ""),
        };
      }
    } catch {
      // Not JSON after all; fall through and show the raw text.
    }
  }

  return {
    verdict: "Request Data",
    verdict_rationale: "Model output was not cleanly structured. Raw response is in the workup tab so you can still use it.",
    pass_reasons: [],
    data_gaps: ["Model did not return a parseable WorkupIQ payload. Re-run with a stronger model if this is incomplete."],
    hygiene: ["Parser recovered unformatted model text."],
    workup_markdown: raw.trim().slice(0, 20000),
    faq_markdown: "",
  };
}

function parseAttack(raw: string, tag: string): string {
  const tagged = parseTagged(raw)?.[tag]?.trim();
  return (tagged || raw.trim()).slice(0, 20000);
}

async function readRequest(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) throw new ClientError("This deck is too large to review.");
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ClientError("Invalid request body.");
  }
  const text = String(body?.text ?? "").trim();
  if (text.length < 40) throw new ClientError("There isn't enough deck text to review.");
  const provider = Object.hasOwn(PROVIDERS, String(body?.provider)) ? PROVIDERS[body.provider] : null;
  if (!provider) throw new ClientError("That provider isn't supported.");
  const model = String(body?.model ?? "").trim();
  if (!MODEL_ID.test(model) || model.includes("..")) throw new ClientError("That model ID isn't valid.");
  const key = String(body?.api_key ?? "").trim();
  if (!key) throw new ClientError("Add your API key to run a review.");
  return {
    text,
    provider,
    model,
    key,
    company: String(body?.company || "the company").slice(0, 200),
    filename: String(body?.filename || "deck").slice(0, 200),
    attack: String(body?.attack ?? ""),
  };
}

async function handleWorkup(request: Request, referer: string): Promise<Response> {
  const req = await readRequest(request);
  const user =
    `Company: ${req.company}\nFilename: ${req.filename}\n\n` +
    "Extracted deck text follows. Reply with the tagged WorkupIQ pack sections only. " +
    "Do not output JSON. Do not run extra attacks in this reply.\n\n" +
    req.text.slice(0, PACK_TEXT_CHARS);
  const raw = await complete(req.provider, req.key, req.model, SYSTEM_PROMPT, user, referer);
  return json(parsePack(raw));
}

async function handleAttack(request: Request, referer: string): Promise<Response> {
  const req = await readRequest(request);
  const spec = Object.hasOwn(ATTACKS, req.attack) ? ATTACKS[req.attack] : null;
  if (!spec) throw new ClientError("That review type isn't supported.");
  const user =
    `Company: ${req.company}\nFilename: ${req.filename}\n` +
    `Attack: ${spec.title}\n` +
    `Start your reply with ===${spec.tag}===\n\n` +
    `${spec.prompt}\n\n` +
    "Extract:\n" +
    req.text.slice(0, ATTACK_TEXT_CHARS);
  const raw = await complete(req.provider, req.key, req.model, ATTACK_SYSTEM, user, referer);
  return json({ attack: req.attack, markdown: parseAttack(raw, spec.tag) });
}

function isFree(providerName: string, item: any, id: string): boolean {
  if (id.includes(":free") || id.endsWith("/free")) return true;
  const { prompt, completion } = item.pricing ?? {};
  if (prompt != null && completion != null && Number(prompt) === 0 && Number(completion) === 0) return true;
  const name = String(item.name ?? id).toLowerCase();
  if (name.includes("(free)") || name.includes("free endpoint")) return true;
  return providerName === "nvidia" && ["8b", "7b", "nano", "mini", "small"].some((token) => id.toLowerCase().includes(token));
}

function isChatModel(providerName: string, item: any, id: string): boolean {
  const methods: string[] = item.supportedGenerationMethods ?? item.supported_actions ?? [];
  if (methods.length && !methods.some((m) => ["generateContent", "generateMessage", "generateText"].includes(m))) return false;
  if (providerName === "openrouter") return true;
  return !SKIP_NON_CHAT.some((skip) => id.toLowerCase().includes(skip));
}

async function fetchCatalogRows(provider: Provider, key: string): Promise<any[]> {
  const headers = { Accept: "application/json", ...authHeaders(provider, key) };
  const host = new URL(provider.modelsUrl).host;
  const rows: any[] = [];
  const seen = new Set<string>();
  let current = provider.modelsUrl;
  for (let page = 0; page < 25 && !seen.has(current); page++) {
    seen.add(current);
    const raw = await upstream(current, { method: "GET", headers, timeoutMs: CATALOG_TIMEOUT_MS });
    if (Array.isArray(raw)) {
      rows.push(...raw);
      break;
    }
    rows.push(...(raw.data ?? raw.models ?? []));
    const next = new URL(current);
    if (raw.links?.next) {
      const linked = new URL(String(raw.links.next), current);
      if (linked.host !== host) break;
      current = linked.href;
    } else if (raw.nextPageToken) {
      next.searchParams.set("pageToken", String(raw.nextPageToken));
      current = next.href;
    } else if (raw.has_more && raw.last_id) {
      next.searchParams.set("after_id", String(raw.last_id));
      current = next.href;
    } else {
      break;
    }
  }
  return rows;
}

async function handleModels(request: Request, url: URL): Promise<Response> {
  let providerName = (url.searchParams.get("provider") || "openrouter").trim().toLowerCase();
  if (providerName === "xai") providerName = "grok";
  const provider = Object.hasOwn(PROVIDERS, providerName) ? PROVIDERS[providerName] : null;
  if (!provider) throw new ClientError("That provider isn't supported.");
  const key = (request.headers.get("X-API-Key") || "").trim();
  if (!key && !provider.keyOptionalForCatalog) throw new ClientError("add your API key to load live models");

  const rows = await fetchCatalogRows(provider, key);
  const byId = new Map<string, { id: string; name: string; free: boolean; context: unknown }>();
  for (const row of rows) {
    const item = typeof row === "string" ? { id: row } : row;
    const id = String(item?.id ?? item?.name ?? "").replace(/^models\//, "");
    if (!id || byId.has(id) || !isChatModel(providerName, item, id)) continue;
    byId.set(id, {
      id,
      name: item.display_name ?? item.displayName ?? item.name ?? id,
      free: isFree(providerName, item, id),
      context: item.context_length ?? item.inputTokenLimit ?? item.context ?? null,
    });
  }
  if (providerName === "openrouter") byId.delete("openrouter/free");
  if (!byId.size && providerName !== "openrouter") throw new Error("The provider returned no models.");

  const models = [...byId.values()].sort(
    (a, b) => Number(b.free) - Number(a.free) || a.id.toLowerCase().localeCompare(b.id.toLowerCase()),
  );
  if (providerName === "openrouter") models.unshift({ id: "openrouter/free", name: "Free Models Router", free: true, context: null });
  return json({
    provider: providerName,
    source: "live",
    models,
    free_count: models.filter((m) => m.free).length,
  });
}

/** Returns null when the path isn't a pitch review route. */
export async function handleScreenApi(request: Request, url: URL): Promise<Response | null> {
  const route = `${request.method} ${url.pathname}`;
  try {
    switch (route) {
      case "GET /api/health":
        return json({ status: "ok", service: "WorkupIQ" });
      case "GET /api/models":
        return await handleModels(request, url);
      case "POST /api/workup":
        return await handleWorkup(request, url.origin);
      case "POST /api/attack":
        return await handleAttack(request, url.origin);
      default:
        return null;
    }
  } catch (err: any) {
    const status = err instanceof ClientError ? 400 : 502;
    return json({ error: String(err?.message || err) }, status);
  }
}
