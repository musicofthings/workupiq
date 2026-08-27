#!/usr/bin/env python3
"""Pull latest chat models from inference providers. Free models first."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "models.json"

PROVIDERS = {
    "openrouter": {
        "label": "OpenRouter",
        "base_url": "https://openrouter.ai/api/v1",
        "models_url": "https://openrouter.ai/api/v1/models",
        "auth_env": "OPENROUTER_API_KEY",
        "auth_optional": True,
    },
    "nvidia": {
        "label": "NVIDIA NIM",
        "base_url": "https://integrate.api.nvidia.com/v1",
        "models_url": "https://integrate.api.nvidia.com/v1/models",
        "auth_env": "NVIDIA_API_KEY",
        "auth_optional": True,
    },
    "grok": {
        "label": "xAI Grok",
        "base_url": "https://api.x.ai/v1",
        "models_url": "https://api.x.ai/v1/models",
        "auth_env": "XAI_API_KEY",
        "auth_optional": False,
    },
    "openai": {
        "label": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "models_url": "https://api.openai.com/v1/models",
        "auth_env": "OPENAI_API_KEY",
        "auth_optional": False,
    },
    "ollama": {
        "label": "Ollama",
        "base_url": "http://127.0.0.1:11434/v1",
        "models_url": "http://127.0.0.1:11434/v1/models",
        "auth_env": "",
        "auth_optional": True,
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
        {"id": "claude-sonnet-4-20250514", "free": False},
        {"id": "claude-3-5-haiku-latest", "free": False},
    ],
    "gemini": [
        {"id": "gemini-2.0-flash", "free": False},
        {"id": "gemini-2.5-flash", "free": False},
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


def _get_json(url: str, api_key: str | None = None, timeout: int = 25) -> dict:
    headers = {"Accept": "application/json", "User-Agent": "WorkupIQ/1.0"}
    if api_key:
        headers["Authorization"] = "Bearer " + api_key
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


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


def _normalize(provider: str, raw) -> list[dict]:
    if isinstance(raw, dict):
        rows = raw.get("data") or raw.get("models") or []
    elif isinstance(raw, list):
        rows = raw
    else:
        rows = []
    out = []
    for item in rows:
        if isinstance(item, str):
            item = {"id": item}
        mid = item.get("id") or item.get("name")
        if not mid:
            continue
        low = str(mid).lower()
        if any(skip in low for skip in ("embed", "tts", "whisper", "dall-e", "image", "video", "moderation", "rerank")):
            if provider != "openrouter":
                continue
        free = is_free(provider, item)
        out.append({
            "id": mid,
            "name": item.get("name") or mid,
            "free": free,
            "context": item.get("context_length") or item.get("context"),
        })
    out.sort(key=lambda m: (not m["free"], m["id"].lower()))
    return out


def fetch_provider(provider: str, api_key: str | None = None) -> dict:
    meta = PROVIDERS.get(provider)
    if not meta:
        models = FALLBACK.get(provider, [])
        return {"provider": provider, "source": "fallback", "models": models}

    key = api_key or (os.environ.get(meta["auth_env"]) if meta.get("auth_env") else None)
    try:
        raw = _get_json(meta["models_url"], key)
        models = _normalize(provider, raw)
        if not models:
            raise RuntimeError("empty catalog")
        return {"provider": provider, "source": "live", "models": models, "base_url": meta["base_url"]}
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
        models = FALLBACK.get(provider, [])
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
    for provider in list(PROVIDERS) + ["anthropic", "gemini", "custom"]:
        catalog[provider] = fetch_provider(provider, keys.get(provider))
    return catalog


def save_cache(catalog: dict) -> Path:
    CACHE.write_text(json.dumps(catalog, indent=2))
    return CACHE


def load_cache() -> dict:
    if CACHE.exists():
        return json.loads(CACHE.read_text())
    return {k: {"provider": k, "source": "fallback", "models": v} for k, v in FALLBACK.items()}


if __name__ == "__main__":
    catalog = fetch_all()
    path = save_cache(catalog)
    for name, block in catalog.items():
        free = sum(1 for m in block.get("models", []) if m.get("free"))
        print(f"{name:12} {block.get('source', '?'):8} models={len(block.get('models', [])):4} free={free:3} {block.get('error', '')}")
    print("wrote", path)
