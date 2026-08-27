# WorkupIQ

Local-first landing page + Screen app. BYOK. Decks and keys never go to workupiq.com.

## Architecture

| Surface | Where it runs | Notes |
|---------|---------------|-------|
| Marketing site + form | Cloudflare Workers (static assets + `/api/contact`) | Public |
| Screen app UI (`app.html`) | Same Worker (static) | Public shell only |
| PDF/PPTX extract + LLM calls | **Local** Flask server | Keys & decks stay on your machine |

## Run the Screen app locally (required for upload + workup)

Do **not** use `python3 -m http.server`. That server cannot extract files or call models.

```bash
cd local
python3 -m pip install -r requirements.txt
python3 server.py
```

If 8080 is busy:

```bash
PORT=8090 python3 server.py
```

Open http://127.0.0.1:8080/app.html

1. Choose provider (OpenAI, Anthropic, Gemini, Ollama, LM Studio, …).
2. Paste the key. It is saved in `localStorage` only.
3. Drop a PDF or PPTX.
4. Run Screen. Download the markdown pack.

Ollama: start `ollama serve`, pull a model, set provider to Ollama. No key.

## What v1 does

- Extracts selectable text from PDF (`pypdf`) and PPTX (slide XML).
- Sends extract + WorkupIQ system prompt to **your** model.
- Returns WIQ Verdict (Pass / Request Data / Advance), workup memo, red-team FAQ, hygiene flags.
- Does **not** OCR chart images. Hygiene will flag flattened charts.

## Cloudflare Workers deploy

Public site is a single Worker that serves static assets and handles the contact form.

### Prerequisites

1. Domain `workupiq.com` on Cloudflare.
2. Email Routing enabled.
3. At least one verified destination address.
4. Custom address `hello@workupiq.com` routing to that destination (recommended).
5. Optional but recommended: create `forms@workupiq.com` as a custom address (used as the From header in form emails).

### One-time setup

```bash
npm install
npx wrangler login
```

Edit `wrangler.toml` if your destination address is different from `hello@workupiq.com`.

### Deploy

```bash
npm run deploy
# or
npx wrangler deploy
```

Then attach the custom domain in the Cloudflare dashboard (Workers → workupiq → Settings → Domains & Routes).

### Local Worker development

```bash
npm run dev
```

### Contact form

- Browser POSTs JSON to `/api/contact`.
- Worker validates fields, applies honeypot, builds a plain-text email, and sends it via the Email Routing `send_email` binding.
- No mail-client popup. Success or error is shown in-page.

### Important boundary

Static files and the contact endpoint deploy. The local Flask routes (`/api/extract`, `/api/workup`, `/api/models`, …) are **never** exposed on Cloudflare. Keep Screen local for BYOK and privacy.

## Project layout

```
workupiq/
├── public/               # Deployed static assets
│   ├── index.html
│   ├── app.html
│   ├── app.js            # Form → /api/contact
│   ├── screen.js
│   ├── styles.css
│   ├── templates/
│   └── _headers
├── src/
│   └── index.ts          # Worker: static + /api/contact
├── local/                # Not deployed – local Screen server
│   ├── server.py
│   ├── models_catalog.py
│   └── requirements.txt
├── wrangler.toml
├── package.json
└── README.md
```
