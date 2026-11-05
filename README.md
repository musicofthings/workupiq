# WorkupIQ

Landing page and pitch review app, hosted on Cloudflare Workers. Bring your own model key.

## Architecture

| Surface | Where it runs | Notes |
|---------|---------------|-------|
| Marketing site + contact form | Worker (static assets + `/api/contact`) | Public |
| Reading PDF/PPTX | The visitor's browser (PDF.js, JSZip in `public/vendor/`) | The file is never uploaded |
| Model calls | Worker (`/api/models`, `/api/workup`, `/api/attack`) | Stateless proxy, see below |

### What reaches the Worker

Deck **text** and the visitor's **API key** pass through the Worker on each review so it can call the provider. They are not stored or logged. The key is saved only in the visitor's browser. Do not add logging of request bodies or auth headers in `src/screen.ts`.

Provider hosts are fixed in `src/screen.ts`, and clients cannot supply a base URL, so the Worker can't be used to reach arbitrary addresses. That is also why local providers such as Ollama aren't offered.

## Using the app

1. Open https://workupiq.com/app
2. Choose a provider (OpenRouter, NVIDIA NIM, xAI, OpenAI, Anthropic, Gemini).
3. Paste your key.
4. Drop a PDF or PPTX.
5. Run the review. Download the markdown pack.

## What v1 does

- Extracts selectable text from PDF and PPTX in the browser.
- Sends extract + WorkupIQ system prompt to **your** model.
- Returns WIQ Verdict (Pass / Request Data / Advance), workup memo, red-team FAQ, hygiene flags.
- Does **not** OCR chart images. Hygiene will flag flattened charts.

## Cloudflare Workers deploy

The site is a single Worker. **Pushing to `main` deploys it** through Cloudflare Workers Builds.

When you change `public/screen.js`, also bump `screen.js?v=` in `public/app.html`, because browsers cache the script.

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

### Local Worker development

```bash
npx wrangler dev --compatibility-date 2026-05-03
```

The date override is only needed while the installed Wrangler's runtime is older than the date in `wrangler.toml`.

Allowed cross-origin callers come from `ALLOWED_ORIGINS` in `wrangler.toml` (see `.env.example`). Same-origin requests are always allowed.

### Contact form

- Browser POSTs JSON to `/api/contact`.
- Worker validates fields, applies honeypot, builds a plain-text email, and sends it via the Email Routing `send_email` binding.
- No mail-client popup. Success or error is shown in-page.

## Project layout

```
workupiq/
├── public/               # Deployed static assets
│   ├── index.html
│   ├── app.html
│   ├── app.js            # Form → /api/contact
│   ├── screen.js         # Pitch review UI, reads decks in the browser
│   ├── vendor/           # PDF.js and JSZip, served from this site
│   ├── styles.css
│   ├── templates/
│   └── _headers
├── src/
│   ├── index.ts          # Worker entry, origin checks, /api/contact
│   └── screen.ts         # Provider proxy: /api/models, /api/workup, /api/attack
├── local/                # Old Flask server, no longer used by the app
├── wrangler.toml
├── package.json
└── README.md
```
