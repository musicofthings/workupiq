#!/usr/bin/env python3
"""Refresh models.json from OpenRouter, NVIDIA, xAI, OpenAI, Ollama."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from models_catalog import fetch_all, save_cache

if __name__ == "__main__":
    catalog = fetch_all()
    path = save_cache(catalog)
    for name, block in catalog.items():
        free = sum(1 for m in block.get("models", []) if m.get("free"))
        err = block.get("error") or ""
        print(f"{name:12} {block.get('source', '?'):8} n={len(block.get('models', [])):4} free={free:3} {err}")
    print("wrote", path)
