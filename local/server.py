#!/usr/bin/env python3
"""WorkupIQ local server. Serves the site and proxies BYOK model calls."""

from __future__ import annotations

import json
import os
import re
import zipfile
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET

from flask import Flask, jsonify, request, send_from_directory

from models_catalog import fetch_provider, load_cache

# Serve the same static assets that Cloudflare Workers deploys from public/
ROOT = Path(__file__).resolve().parent.parent / "public"
if not ROOT.is_dir():
    # Fallback when running from an older layout
    ROOT = Path(__file__).resolve().parent
app = Flask(__name__, static_folder=str(ROOT), static_url_path="")

SYSTEM_PROMPT = """You are WorkupIQ, an associate-level venture analyst that screens fundraising decks the way a fund LLM and junior associate will.

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
"""

ATTACK_SYSTEM = """You are WorkupIQ running one red-team attack on a fundraising extract.
Use ONLY facts in the extract. If a number is missing, say it is missing. Never invent TAM, revenue, customers, or dates.
Return ONLY the single tagged section requested. No JSON. No other tags.
"""

ATTACKS = {
    "gatekeeper": {
        "tag": "WIQ_GATEKEEPER",
        "title": "Gatekeeper Screener",
        "prompt": (
            "Role: cynical Tier-1 principal, 50+ memos a week, look for reasons to pass in 3 minutes.\n"
            "Output markdown:\n"
            "1. Fatal Flaw Checklist: top 3-5 reasons to PASS.\n"
            "2. Information Deficit: missing or vague data.\n"
            "3. Verdict: Pass, Request More Data, or Advance to Partner Call, plus 2-sentence rationale."
        ),
    },
    "wrapper": {
        "tag": "WIQ_WRAPPER",
        "title": "Defensibility & Wrapper Stress Test",
        "prompt": (
            "Role: deep-tech / AI partner attacking moat.\n"
            "1. Foundation Model Disruption: why a frontier lab or incumbent could commoditize this in 12 months.\n"
            "2. Moat Evaluation: real data/IP loop vs illusion of complexity.\n"
            "3. Five hardest CTO diligence questions."
        ),
    },
    "forensic": {
        "tag": "WIQ_FORENSIC",
        "title": "Financial Forensic Audit",
        "prompt": (
            "Role: quantitative diligence associate.\n"
            "1. Math & Sizing Sanity Check on TAM/SAM/SOM.\n"
            "2. Burn vs runway vs stated milestones.\n"
            "3. CAC & payback vs typical enterprise B2B."
        ),
    },
    "premortem": {
        "tag": "WIQ_PREMORTEM",
        "title": "Partner Meeting Pre-Mortem",
        "prompt": (
            "Role: IC pre-mortem. Assume we funded today and the company is zero or down-round in 24 months.\n"
            "1. Primary cause of failure.\n"
            "2. Underestimated external friction.\n"
            "3. Exact memo/FAQ lines that must be added before IC."
        ),
    },
}


def extract_pdf(data: bytes) -> tuple[str, int]:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise RuntimeError("Install pypdf: pip install pypdf") from exc
    reader = PdfReader(BytesIO(data))
    pages = []
    for i, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        pages.append(f"\n--- Slide/page {i} ---\n{text.strip()}")
    return "\n".join(pages).strip(), len(reader.pages)


def extract_pptx(data: bytes) -> tuple[str, int]:
    slides = []
    with zipfile.ZipFile(BytesIO(data)) as zf:
        names = sorted(
            n for n in zf.namelist()
            if re.match(r"ppt/slides/slide\d+\.xml$", n)
        )
        for name in names:
            root = ET.fromstring(zf.read(name))
            texts = [t.text for t in root.iter("{http://schemas.openxmlformats.org/drawingml/2006/main}t") if t.text]
            found = re.search(r"slide(\d+)", name)
            idx = found.group(1) if found else "?"
            slides.append(f"\n--- Slide {idx} ---\n" + "\n".join(texts))
    return "\n".join(slides).strip(), len(slides)


def _http_json(url: str, payload: dict | None, headers: dict, timeout: int = 180) -> dict:
    import urllib.error
    import urllib.request

    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="GET" if data is None else "POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw_body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(f"Provider HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Provider unreachable: {exc.reason}") from exc
    try:
        body = json.loads(raw_body) if raw_body.strip() else {}
    except json.JSONDecodeError as exc:
        raise RuntimeError("Provider HTTP body was not JSON: " + raw_body[:800]) from exc
    if isinstance(body, dict) and body.get("error"):
        raise RuntimeError(str(body["error"]))
    return body if isinstance(body, dict) else {"data": body}


def _flatten_content(content) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks = []
        for part in content:
            if isinstance(part, dict):
                chunks.append(str(part.get("text") or part.get("content") or ""))
            else:
                chunks.append(str(part))
        return "".join(chunks)
    return str(content)


def call_openai_compat(base_url: str, api_key: str, model: str, user: str) -> str:
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ],
    }
    headers = {
        "Content-Type": "application/json",
        "HTTP-Referer": "http://127.0.0.1:8080",
        "X-Title": "WorkupIQ",
    }
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    body = _http_json(url, payload, headers)
    choice = (body.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    return _flatten_content(message.get("content")) or _flatten_content(choice.get("text"))


def call_anthropic(api_key: str, model: str, user: str) -> str:
    payload = {
        "model": model,
        "max_tokens": 8000,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user}],
    }
    body = _http_json(
        "https://api.anthropic.com/v1/messages",
        payload,
        {
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
    )
    return _flatten_content(body.get("content"))


def call_gemini(api_key: str, model: str, user: str) -> str:
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        + model
        + ":generateContent?key="
        + api_key
    )
    payload = {
        "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {"temperature": 0.2},
    }
    body = _http_json(url, payload, {"Content-Type": "application/json"})
    candidates = body.get("candidates") or [{}]
    parts = ((candidates[0].get("content") or {}).get("parts")) or []
    return _flatten_content(parts)


TAGS = (
    "WIQ_VERDICT",
    "WIQ_RATIONALE",
    "WIQ_PASS_REASONS",
    "WIQ_GAPS",
    "WIQ_HYGIENE",
    "WIQ_WORKUP",
    "WIQ_FAQ",
    "WIQ_GATEKEEPER",
    "WIQ_WRAPPER",
    "WIQ_FORENSIC",
    "WIQ_PREMORTEM",
)


def _bullets(text: str) -> list[str]:
    rows = []
    for line in (text or "").splitlines():
        line = re.sub(r"^[\-\*\d\.\)\s]+", "", line).strip()
        if line:
            rows.append(line)
    return rows


def parse_tagged(raw: str) -> dict | None:
    if "WIQ_" not in raw and "===WIQ" not in raw:
        return None
    parts = {tag: "" for tag in TAGS}
    current = None
    for line in raw.splitlines():
        marker = re.match(r"^(?:#{1,3}\s+)?={2,}\s*(WIQ_[A-Z_]+)\s*={2,}\s*$", line.strip())
        if not marker:
            marker = re.match(r"^(?:#{1,3}\s+)?(WIQ_[A-Z_]+)\s*$", line.strip())
        if marker and marker.group(1) in parts:
            current = marker.group(1)
            continue
        if current:
            parts[current] += line + "\n"
    verdict = parts["WIQ_VERDICT"].strip()
    if "Request Data" in verdict:
        verdict = "Request Data"
    elif "Advance" in verdict:
        verdict = "Advance"
    elif "Pass" in verdict:
        verdict = "Pass"
    else:
        verdict = "Request Data"
    return {
        "verdict": verdict,
        "verdict_rationale": parts["WIQ_RATIONALE"].strip(),
        "pass_reasons": _bullets(parts["WIQ_PASS_REASONS"]),
        "data_gaps": _bullets(parts["WIQ_GAPS"]),
        "hygiene": _bullets(parts["WIQ_HYGIENE"]),
        "workup_markdown": parts.get("WIQ_WORKUP", "").strip(),
        "faq_markdown": parts.get("WIQ_FAQ", "").strip(),
        "attacks": {
            "gatekeeper": parts.get("WIQ_GATEKEEPER", "").strip(),
            "wrapper": parts.get("WIQ_WRAPPER", "").strip(),
            "forensic": parts.get("WIQ_FORENSIC", "").strip(),
            "premortem": parts.get("WIQ_PREMORTEM", "").strip(),
        },
    }


def _repair_json(blob: str) -> str:
    blob = blob.replace("\u201c", '"').replace("\u201d", '"').replace("\u2018", "'").replace("\u2019", "'")
    blob = re.sub(r",\s*([}\]])", r"\1", blob)
    return blob


def parse_model_json(raw: str) -> dict:
    tagged = parse_tagged(raw)
    if tagged and (tagged.get("workup_markdown") or tagged.get("verdict_rationale")):
        return tagged

    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?", "", text).strip()
        text = re.sub(r"```$", "", text).strip()
    match = re.search(r"\{.*\}", text, re.S)
    if match:
        blob = _repair_json(match.group(0))
        try:
            data = json.loads(blob)
            if isinstance(data, dict) and ("verdict" in data or "workup_markdown" in data):
                return data
        except json.JSONDecodeError:
            pass

    return {
        "verdict": "Request Data",
        "verdict_rationale": "Model output was not cleanly structured. Raw response is in the workup tab so you can still use it.",
        "pass_reasons": [],
        "data_gaps": ["Model did not return a parseable WorkupIQ payload. Re-run with a stronger model if this is incomplete."],
        "hygiene": ["Parser recovered unformatted model text."],
        "workup_markdown": raw.strip()[:20000],
        "faq_markdown": "",
        "attacks": {},
    }


@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "service": "WorkupIQ", "workup_parser": "tagged-v2"})


@app.get("/api/models")
def models():
    provider = (request.args.get("provider") or "openrouter").strip().lower()
    if provider == "xai":
        provider = "grok"
    live = request.args.get("live", "1") != "0"
    api_key = (
        request.headers.get("X-API-Key")
        or request.args.get("key")
        or ""
    )
    base_url = (request.args.get("base_url") or "").strip() or None
    if live:
        block = fetch_provider(provider, api_key or None, base_url)
    else:
        cache = load_cache()
        block = cache.get(provider) or fetch_provider(provider, api_key or None, base_url)
    models = block.get("models") or []
    # Always pin known free routers first.
    pinned = [m for m in models if m.get("id") in {"openrouter/free"}]
    rest = [m for m in models if m.get("id") not in {"openrouter/free"}]
    rest.sort(key=lambda m: (not m.get("free"), str(m.get("id", "")).lower()))
    block = dict(block)
    block["models"] = pinned + rest
    block["free_count"] = sum(1 for m in block["models"] if m.get("free"))
    return jsonify(block)


@app.post("/api/extract")
def extract():
    uploaded = request.files.get("file")
    if not uploaded or not uploaded.filename:
        return jsonify({"error": "No file"}), 400
    data = uploaded.read()
    name = uploaded.filename.lower()
    try:
        if name.endswith(".pdf"):
            text, pages = extract_pdf(data)
        elif name.endswith(".pptx"):
            text, pages = extract_pptx(data)
        else:
            return jsonify({"error": "Use PDF or PPTX"}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
    if not text:
        return jsonify({"error": "No selectable text. Likely a flattened / image-only deck."}), 422
    return jsonify({"text": text, "pages": pages, "filename": uploaded.filename})


@app.post("/api/workup")
def workup():
    body = request.get_json(force=True, silent=True) or {}
    text = (body.get("text") or "").strip()
    if len(text) < 40:
        return jsonify({"error": "Extract is too short"}), 400
    provider = body.get("provider") or "openai"
    model = body.get("model") or "gpt-4o-mini"
    api_key = body.get("api_key") or ""
    base_url = body.get("base_url") or "https://api.openai.com/v1"
    company = body.get("company") or "the company"
    filename = body.get("filename") or "deck"
    selected = body.get("attacks") or []
    if isinstance(selected, str):
        selected = [selected]
    selected = [str(item).strip().lower() for item in selected if str(item).strip().lower() in ATTACKS]

    def complete(system: str, user: str) -> str:
        old = SYSTEM_PROMPT
        try:
            # Rebind module prompt for this call only.
            globals()["SYSTEM_PROMPT"] = system
            if provider == "anthropic":
                return call_anthropic(api_key, model, user)
            if provider == "gemini":
                return call_gemini(api_key, model, user)
            return call_openai_compat(base_url, api_key, model, user)
        finally:
            globals()["SYSTEM_PROMPT"] = old

    pack_user = (
        f"Company: {company}\nFilename: {filename}\n\n"
        "Extracted deck text follows. Reply with the tagged WorkupIQ pack sections only. "
        "Do not output JSON. Do not run extra attacks in this reply.\n\n"
        + text[:80000]
    )
    try:
        raw = complete(SYSTEM_PROMPT, pack_user)
        if not raw or not str(raw).strip():
            raise RuntimeError("Provider returned an empty completion.")
        result = parse_model_json(str(raw))
        attacks_out = result.get("attacks") if isinstance(result.get("attacks"), dict) else {}
        for key in selected:
            spec = ATTACKS[key]
            attack_user = (
                f"Company: {company}\nFilename: {filename}\n"
                f"Attack: {spec['title']}\n"
                f"Start your reply with ==={spec['tag']}===\n\n"
                f"{spec['prompt']}\n\n"
                "Extract:\n"
                + text[:60000]
            )
            try:
                attack_raw = complete(ATTACK_SYSTEM, attack_user) or ""
            except Exception as attack_exc:
                attacks_out[key] = f"Attack failed: {attack_exc}"
                continue
            parsed = parse_tagged(attack_raw) or {}
            chunk = ""
            if isinstance(parsed.get("attacks"), dict):
                chunk = parsed["attacks"].get(key) or ""
            if not chunk:
                tag_match = re.search(
                    r"={2,}\s*" + re.escape(spec["tag"]) + r"\s*={2,}(.*)$",
                    attack_raw,
                    re.S | re.I,
                )
                chunk = tag_match.group(1).strip() if tag_match else attack_raw.strip()
            attacks_out[key] = chunk[:20000]
        result["attacks"] = attacks_out
    except Exception as exc:
        result = {
            "verdict": "Request Data",
            "verdict_rationale": "Provider or parser error. Raw detail is below.",
            "pass_reasons": [],
            "data_gaps": [str(exc)],
            "hygiene": ["Workup returned a recovered payload instead of a 502."],
            "workup_markdown": str(exc),
            "faq_markdown": "",
            "attacks": {},
        }
    if not isinstance(result, dict):
        result = {"verdict": "Request Data", "workup_markdown": str(result)}
    verdict = str(result.get("verdict") or "Request Data")
    if "Request Data" in verdict:
        verdict = "Request Data"
    elif "Advance" in verdict:
        verdict = "Advance"
    elif "Pass" in verdict:
        verdict = "Pass"
    else:
        verdict = "Request Data"

    def as_list(value):
        if isinstance(value, list):
            return [str(item) for item in value if str(item).strip()]
        if isinstance(value, str) and value.strip():
            return [value.strip()]
        return []

    raw_attacks = result.get("attacks") if isinstance(result.get("attacks"), dict) else {}
    clean = {
        "verdict": verdict,
        "verdict_rationale": str(result.get("verdict_rationale") or ""),
        "pass_reasons": as_list(result.get("pass_reasons")),
        "data_gaps": as_list(result.get("data_gaps")),
        "hygiene": as_list(result.get("hygiene")),
        "workup_markdown": str(result.get("workup_markdown") or ""),
        "faq_markdown": str(result.get("faq_markdown") or ""),
        "attacks": {
            "gatekeeper": str(raw_attacks.get("gatekeeper") or result.get("gatekeeper") or ""),
            "wrapper": str(raw_attacks.get("wrapper") or result.get("wrapper") or ""),
            "forensic": str(raw_attacks.get("forensic") or result.get("forensic") or ""),
            "premortem": str(raw_attacks.get("premortem") or result.get("premortem") or ""),
        },
        "attacks_requested": selected,
    }
    return jsonify(clean)


@app.get("/")
def home():
    return send_from_directory(ROOT, "index.html")


@app.get("/<path:path>")
def static_file(path):
    return send_from_directory(ROOT, path)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    print(f"WorkupIQ → http://127.0.0.1:{port}/app.html")
    app.run(host="127.0.0.1", port=port, debug=False)
