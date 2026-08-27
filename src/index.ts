/**
 * WorkupIQ Worker
 * - Serves static assets (landing + app shell)
 * - Handles POST /api/contact → email via Cloudflare Email Routing
 *
 * Screen logic stays 100% local. Keys and decks never reach this Worker.
 */

import { EmailMessage } from "cloudflare:email";

export interface Env {
  ASSETS: Fetcher;
  SEB: {
    send(message: EmailMessage): Promise<void>;
  };
}

interface ContactPayload {
  email?: string;
  company?: string;
  round?: string;
  note?: string;
  _gotcha?: string;
}

function corsHeaders(origin?: string | null): HeadersInit {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data: unknown, status = 200, origin?: string | null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

/** Minimal RFC 5322 plain-text message (no external deps). */
function buildRawMime(opts: {
  from: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
}): string {
  const encodedSubject = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(opts.subject)))}?=`;
  // Simple folding-safe headers + body
  return [
    `From: ${opts.fromName} <${opts.from}>`,
    `To: ${opts.to}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    opts.text,
  ].join("\r\n");
}

async function handleContact(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, origin);
  }

  let data: ContactPayload;

  try {
    const contentType = request.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
      data = (await request.json()) as ContactPayload;
    } else {
      const form = await request.formData();
      data = {
        email: String(form.get("email") || ""),
        company: String(form.get("company") || ""),
        round: String(form.get("round") || ""),
        note: String(form.get("note") || ""),
        _gotcha: String(form.get("_gotcha") || ""),
      };
    }
  } catch {
    return json({ error: "Invalid request body" }, 400, origin);
  }

  // Honeypot
  if (data._gotcha && String(data._gotcha).trim() !== "") {
    return json({ ok: true }, 200, origin);
  }

  const email = String(data.email || "").trim();
  const company = String(data.company || "").trim();
  const round = String(data.round || "").trim();
  const note = String(data.note || "").trim();

  if (!email || !company || !round) {
    return json({ error: "Email, company, and round are required." }, 400, origin);
  }

  if (!isValidEmail(email)) {
    return json({ error: "Please provide a valid work email." }, 400, origin);
  }

  if (company.length > 200 || round.length > 80 || note.length > 2000) {
    return json({ error: "One or more fields are too long." }, 400, origin);
  }

  const subject = `WorkupIQ Screen request — ${company}`;
  const text = [
    `Email:   ${email}`,
    `Company: ${company}`,
    `Round:   ${round}`,
    ``,
    `First attack surface:`,
    note || "(none)",
    ``,
    `---`,
    `Submitted from workupiq.com contact form`,
    `Time: ${new Date().toISOString()}`,
  ].join("\n");

  // --- Email addresses (must match Email Routing setup) ---
  // fromAddr  = a Custom address you created on workupiq.com (e.g. forms@ or noreply@)
  // toAddr    = the EXACT verified Destination address shown in
  //             Cloudflare Dashboard → Email → Email Routing → Destination addresses
  //             (usually your personal inbox — NOT hello@workupiq.com)
  const fromAddr = "forms@workupiq.com";
  const toAddr   = "shibi.kannan@gmail.com";

  try {
    const raw = buildRawMime({
      from: fromAddr,
      fromName: "WorkupIQ Form",
      to: toAddr,
      subject,
      text,
    });

    const message = new EmailMessage(fromAddr, toAddr, raw);
    await env.SEB.send(message);

    return json({ ok: true }, 200, origin);
  } catch (err: any) {
    // Log the real error so it appears in wrangler tail / Workers logs
    console.error("Email send failed:", err?.message || err, err);
    return json(
      {
        error: "Failed to send. Please write hello@workupiq.com directly.",
        detail: String(err?.message || err),
      },
      500,
      origin
    );
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/contact") {
      return handleContact(request, env);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
