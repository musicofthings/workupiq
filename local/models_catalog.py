#!/usr/bin/env python3
"""Pull latest chat models from inference providers. Free models first."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "models.json"
PUBLIC_CACHE = ROOT.parent / "public" / "models.json"

PROVIDERS = {
    "openrouter": {
        "label": "OpenRouter",
        "base_url": "https://openrouter.ai/api/v1",
        # Default output_modalities is "text" and silently drops image/audio/etc.
        "models_url": "https://openrouter.ai/api/v1/models?output_modalities=all",
        "auth_env": "OPENROUTER_API_KEY",
        "auth_optional": True,
        "auth": "bearer",
    },
    "nvidia": {
        "label": "NVIDIA NIM",
        "base_url": "https://integrate.api.nvidia.com/v1",
        "models_url": "https://integrate.api.nvidia.com/v1/models",
        "auth_env": "NVIDIA_API_KEY",
        "auth_optional": True,
        "auth": "bearer",
    },
    "grok": {
        "label": "xAI Grok",
        "base_url": "https://api.x.ai/v1",
        "models_url": "https://api.x.ai/v1/models",
        "auth_env": "XAI_API_KEY",
        "auth_optional": False,
        "auth": "bearer",
    },
    "openai": {
        "label": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "models_url": "https://api.openai.com/v1/models",
        "auth_env": "OPENAI_API_KEY",
        "auth_optional": False,
        "auth": "bearer",
    },
    "ollama": {
        "label": "Ollama",
        "base_url": "http://127.0.0.1:11434/v1",
        "models_url": "http://127.0.0.1:11434/v1/models",
        "auth_env": "",
        "auth_optional": True,
        "auth": "bearer",
    },
    "anthropic": {
        "label": "Anthropic",
        "base_url": "https://api.anthropic.com",
        "models_url": "https://api.anthropic.com/v1/models?limit=1000",
        "auth_env": "ANTHROPIC_API_KEY",
        "auth_optional": False,
        "auth": "x-api-key",
        "extra_headers": {"anthropic-version": "2023-06-01"},
    },
    "gemini": {
        "label": "Google Gemini",
        "base_url": "https://generativelanguage.googleapis.com",
        "models_url": "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
        "auth_env": "GEMINI_API_KEY",
        "auth_optional": False,
        "auth": "query",
        "auth_env_alts": ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    },
}

FALLBACK = {
    "openrouter": [
        {"id": "openrouter/free", "free": True, "name": "Free Models Router"},
        {"id": "meta-llama/llama-3.3-70b-instruct:free", "free": True},
        {"id": "qwen/qwen3-coder:free", "free": True},
        {"id": "openai/gpt-oss-120b:free", "free": True},
        {"id": "google/gemma-4-31b-it:free", "free": True},
        {"id": "nvidia/nemotron-3-nano-30b-a3b:free", "free": True},
    ],
    "nvidia": [
        {"id": "meta/llama-3.1-8b-instruct", "free": True, "name": "Llama 3.1 8B (NIM trial)"},
        {"id": "nvidia/nemotron-3-nano-30b-a3b", "free": True},
        {"id": "nvidia/llama-3.3-nemotron-super-49b-v1.5", "free": True},
        {"id": "mistralai/mistral-7b-instruct-v0.3", "free": True},
    ],
    "grok": [
        {"id": "grok-4.6", "free": False},
        {"id": "grok-4.5", "free": False},
        {"id": "grok-3-mini", "free": False},
        {"id": "grok-2-1212", "free": False},
    ],
    "openai": [
        {"id": "gpt-4o-mini", "free": False},
        {"id": "gpt-4o", "free": False},
        {"id": "o4-mini", "free": False},
    ],
    "anthropic": [
        {"id": "claude-sonnet-4-5", "free": False},
        {"id": "claude-opus-4-1", "free": False},
        {"id": "claude-sonnet-4-20250514", "free": False},
        {"id": "claude-3-5-haiku-latest", "free": False},
    ],
    "gemini": [
        {"id": "gemini-2.5-flash", "free": False},
        {"id": "gemini-2.5-pro", "free": False},
        {"id": "gemini-2.0-flash", "free": False},
        {"id": "gemini-2.5-flash-lite", "free": False},
    ],
    "ollama": [
        {"id": "llama3.1", "free": True},
        {"id": "mistral", "free": True},
        {"id": "qwen2.5", "free": True},
    ],
    "custom": [
        {"id": "local-model", "free": True},
    ],
}

SKIP_NON_CHAT = ("embed", "tts", "whisper", "dall-e", "moderation", "rerank")


def _api_key_for(meta: dict, api_key: str | None) -> str | None:
    if api_key:
        return api_key
    envs = [meta.get("auth_env") or ""] + list(meta.get("auth_env_alts") or [])
    for name in envs:
        if name and os.environ.get(name):
            return os.environ.get(name)
    return None


def _with_query(url: str, updates: dict[str, str]) -> str:
    parsed = urllib.parse.urlsplit(url)
    query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
    query.update(updates)
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(query), parsed.fragment)
    )


def _get_json(
    url: str,
    api_key: str | None = None,
    timeout: int = 40,
    extra_headers: dict | None = None,
    auth: str = "bearer",
) -> dict:
    headers = {"Accept": "application/json", "User-Agent": "WorkupIQ/1.0"}
    if extra_headers:
        headers.update(extra_headers)
    if api_key and auth == "bearer":
        headers["Authorization"] = "Bearer " + api_key
    elif api_key and auth == "x-api-key":
        headers["x-api-key"] = api_key
    elif api_key and auth == "query":
        url = _with_query(url, {"key": api_key})
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _absolute_next(current: str, nxt: str) -> str:
    if nxt.startswith("http://") or nxt.startswith("https://"):
        return nxt
    return urllib.parse.urljoin(current, nxt)


def _get_paginated(
    url: str,
    api_key: str | None = None,
    extra_headers: dict | None = None,
    auth: str = "bearer",
) -> dict:
    collected: list = []
    current = url
    seen: set[str] = set()
    raw: dict | list = {}
    for _ in range(25):
        if current in seen:
            break
        seen.add(current)
        raw = _get_json(current, api_key, extra_headers=extra_headers, auth=auth)
        if isinstance(raw, list):
            collected.extend(raw)
            break
        if not isinstance(raw, dict):
            break
        collected.extend(raw.get("data") or raw.get("models") or [])
        links = raw.get("links") or {}
        nxt = links.get("next") if isinstance(links, dict) else None
        token = raw.get("nextPageToken")
        if nxt:
            current = _absolute_next(current, str(nxt))
            continue
        if token:
            current = _with_query(url, {"pageToken": str(token)})
            continue
        if raw.get("has_more") and raw.get("last_id"):
            current = _with_query(url, {"after_id": str(raw["last_id"]), "limit": "1000"})
            continue
        break
    return {"data": collected, "source_meta": raw if isinstance(raw, dict) else {}}


def _price_zero(value) -> bool:
    if value is None:
        return False
    try:
        return float(value) == 0.0
    except (TypeError, ValueError):
        return str(value).strip() in {"0", "0.0", "0.00"}


def is_free(provider: str, item: dict) -> bool:
    mid = str(item.get("id") or "")
    if mid.endswith(":free") or ":free" in mid or mid.endswith("/free"):
        return True
    pricing = item.get("pricing") or {}
    if isinstance(pricing, dict) and (
        _price_zero(pricing.get("prompt")) and _price_zero(pricing.get("completion"))
    ):
        return True
    name = (item.get("name") or item.get("id") or "").lower()
    if "(free)" in name or "free endpoint" in name:
        return True
    if provider in {"ollama"}:
        return True
    if provider == "nvidia" and any(
        token in mid.lower() for token in ("8b", "7b", "nano", "mini", "small")
    ):
        return True
    return False


def _model_id(item: dict) -> str:
    mid = item.get("id") or item.get("name") or ""
    mid = str(mid)
    if mid.startswith("models/"):
        mid = mid[7:]
    return mid


def _is_chat_model(provider: str, item: dict, mid: str) -> bool:
    methods = item.get("supportedGenerationMethods") or item.get("supported_actions") or []
    if methods:
        allowed = {"generateContent", "generateMessage", "generateText"}
        if not any(method in allowed for method in methods):
            return False
    if provider == "openrouter":
        return True
    low = mid.lower()
    return not any(skip in low for skip in SKIP_NON_CHAT)


def _normalize(provider: str, raw) -> list[dict]:
    if isinstance(raw, dict):
        rows = raw.get("data") or raw.get("models") or []
    elif isinstance(raw, list):
        rows = raw
    else:
        rows = []
    out = []
    seen: set[str] = set()
    for item in rows:
        if isinstance(item, str):
            item = {"id": item}
        mid = _model_id(item)
        if not mid or mid in seen:
            continue
        if not _is_chat_model(provider, item, mid):
            continue
        seen.add(mid)
        free = is_free(provider, item)
        out.append({
            "id": mid,
            "name": item.get("display_name") or item.get("displayName") or item.get("name") or mid,
            "free": free,
            "context": item.get("context_length") or item.get("inputTokenLimit") or item.get("context"),
        })
    out.sort(key=lambda m: (not m["free"], m["id"].lower()))
    return out


def _pin_openrouter(provider: str, models: list[dict]) -> list[dict]:
    if provider != "openrouter":
        return models
    router = {"id": "openrouter/free", "free": True, "name": "Free Models Router"}
    rest = [m for m in models if m.get("id") != "openrouter/free"]
    return [router] + rest


def _merged_fallback(provider: str) -> list[dict]:
    canned = FALLBACK.get(provider, [])
    cached = []
    try:
        cached = (load_cache().get(provider) or {}).get("models") or []
    except Exception:
        cached = []
    by_id: dict[str, dict] = {}
    # Canned ids first so a stale snapshot cannot shrink the list; cached
    # rows then fill in live names / extra models.
    for item in canned + cached:
        mid = item.get("id")
        if not mid:
            continue
        if mid not in by_id:
            by_id[mid] = item
        else:
            by_id[mid] = {**by_id[mid], **item}
    return list(by_id.values()) or canned


def fetch_provider(provider: str, api_key: str | None = None, base_url: str | None = None) -> dict:
    meta = dict(PROVIDERS.get(provider) or {})
    if provider == "custom" or (not meta and base_url):
        target = (base_url or "http://127.0.0.1:1234/v1").rstrip("/") + "/models"
        try:
            raw = _get_paginated(target, api_key, auth="bearer")
            models = _normalize("custom", raw)
            if not models:
                raise RuntimeError("empty catalog")
            return {
                "provider": provider,
                "source": "live",
                "models": models,
                "base_url": (base_url or "http://127.0.0.1:1234/v1"),
            }
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
            models = _merged_fallback(provider)
            return {
                "provider": provider,
                "source": "fallback",
                "error": str(exc),
                "models": models,
                "base_url": base_url or "http://127.0.0.1:1234/v1",
            }

    if not meta:
        models = FALLBACK.get(provider, [])
        return {"provider": provider, "source": "fallback", "models": models}

    key = _api_key_for(meta, api_key)
    url = meta["models_url"]
    if provider == "ollama" and base_url:
        url = base_url.rstrip("/") + "/models"
    try:
        raw = _get_paginated(
            url,
            key,
            extra_headers=meta.get("extra_headers"),
            auth=meta.get("auth") or "bearer",
        )
        models = _pin_openrouter(provider, _normalize(provider, raw))
        if not models:
            raise RuntimeError("empty catalog")
        return {
            "provider": provider,
            "source": "live",
            "models": models,
            "base_url": meta["base_url"],
        }
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
        models = _pin_openrouter(provider, _merged_fallback(provider))
        return {
            "provider": provider,
            "source": "fallback",
            "error": str(exc),
            "models": models,
            "base_url": meta["base_url"],
        }


def fetch_all(keys: dict | None = None) -> dict:
    keys = keys or {}
    catalog = {}
    for provider in list(PROVIDERS) + ["custom"]:
        catalog[provider] = fetch_provider(provider, keys.get(provider))
    return catalog


def save_cache(catalog: dict) -> Path:
    payload = json.dumps(catalog, indent=2)
    CACHE.write_text(payload)
    if PUBLIC_CACHE.parent.is_dir():
        PUBLIC_CACHE.write_text(payload)
    return CACHE


def load_cache() -> dict:
    for path in (CACHE, PUBLIC_CACHE):
        if path.exists():
            try:
                return json.loads(path.read_text())
            except json.JSONDecodeError:
                continue
    return {k: {"provider": k, "source": "fallback", "models": v} for k, v in FALLBACK.items()}


if __name__ == "__main__":
    catalog = fetch_all()
    path = save_cache(catalog)
    for name, block in catalog.items():
        free = sum(1 for m in block.get("models", []) if m.get("free"))
        print(f"{name:12} {block.get('source', '?'):8} models={len(block.get('models', [])):4} free={free:3} {block.get('error', '')}")
    print("wrote", path)
