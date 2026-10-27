(function () {
  const $ = (id) => document.getElementById(id);
  const providerEl = $("provider");
  const modelEl = $("model");
  const modelSelect = $("modelSelect");
  const baseUrlEl = $("baseUrl");
  const apiKeyEl = $("apiKey");
  const companyEl = $("company");
  const drop = $("drop");
  const fileEl = $("file");
  const fileStatus = $("fileStatus");
  const runBtn = $("runBtn");
  const runRedBtn = $("runRedBtn");
  const masterBox = $("atk-master");
  const downloadBtn = $("downloadBtn");
  const resultEl = $("result");
  const serverStatus = $("serverStatus");
  const modelStatus = $("modelStatus");
  const keyHint = $("keyHint");
  const refreshBtn = $("refreshModels");
  const modelFilter = $("modelFilter");

  const PRESETS = {
    openrouter: { model: "openrouter/free", baseUrl: "https://openrouter.ai/api/v1", hint: "Full OpenRouter catalog, free variants first. Type in Filter catalog to search. openrouter/free routes across the free pool." },
    nvidia: { model: "meta/llama-3.1-8b-instruct", baseUrl: "https://integrate.api.nvidia.com/v1", hint: "NVIDIA NIM key from build.nvidia.com. Trial / smaller models are sorted first." },
    grok: { model: "grok-4.6", baseUrl: "https://api.x.ai/v1", hint: "xAI key from console.x.ai. Grok models are paid." },
    openai: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1", hint: "Key goes to api.openai.com via the local proxy only." },
    anthropic: { model: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com", hint: "Paste your Anthropic key, then Refresh models for the live Claude catalog." },
    gemini: { model: "gemini-2.5-flash", baseUrl: "https://generativelanguage.googleapis.com", hint: "Google AI Studio key. Refresh models lists every generateContent model on that key." },
    ollama: { model: "llama3.1", baseUrl: "http://127.0.0.1:11434/v1", hint: "No key. Requires Ollama running locally." },
    custom: { model: "local-model", baseUrl: "http://127.0.0.1:1234/v1", hint: "Any OpenAI-compatible server on this machine." },
  };

  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem("workupiq.settings") || "{}") || {};
  } catch {
    saved = {};
  }
  if (saved.provider && providerEl) providerEl.value = saved.provider;
  if (saved.model && modelEl) modelEl.value = saved.model;
  if (saved.baseUrl && baseUrlEl) baseUrlEl.value = saved.baseUrl;
  if (saved.apiKey && apiKeyEl) apiKeyEl.value = saved.apiKey;
  if (saved.company && companyEl) companyEl.value = saved.company;
  applyPreset(false);

  let extracted = "";
  let filename = "";
  let pack = null;
  let activeTab = "verdict";
  let catalogModels = [];
  let catalogMeta = { source: "", free_count: 0 };

  providerEl.addEventListener("change", () => {
    applyPreset(true);
    if (modelFilter) modelFilter.value = "";
    loadModels(true);
  });
  modelSelect.addEventListener("change", () => {
    modelEl.value = modelSelect.value;
    persist();
  });
  [providerEl, modelEl, baseUrlEl, apiKeyEl, companyEl].forEach((el) => {
    el.addEventListener("change", persist);
    el.addEventListener("input", persist);
  });
  refreshBtn.addEventListener("click", () => loadModels(true));
  if (modelFilter) {
    modelFilter.addEventListener("input", () => renderModelSelect(modelEl.value));
  }

  drop.addEventListener("click", () => fileEl.click());
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileEl.addEventListener("change", () => {
    if (fileEl.files[0]) handleFile(fileEl.files[0]);
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      activeTab = tab.dataset.tab;
      renderTab();
    });
  });

  runBtn.addEventListener("click", () => runScreen({ redTeam: false }));
  if (runRedBtn) runRedBtn.addEventListener("click", () => runScreen({ redTeam: true }));
  downloadBtn.addEventListener("click", downloadPack);
  if (masterBox) {
    masterBox.addEventListener("change", () => {
      document.querySelectorAll(".atk").forEach((box) => {
        box.checked = masterBox.checked;
      });
    });
  }
  document.querySelectorAll(".atk").forEach((box) => {
    box.addEventListener("change", () => {
      if (!masterBox) return;
      masterBox.checked = Array.from(document.querySelectorAll(".atk")).some((el) => el.checked);
    });
  });

  pingServer().then(() => loadModels(true));

  function applyPreset(overwrite) {
    const preset = PRESETS[providerEl.value];
    if (!preset) return;
    if (overwrite || !modelEl.value) modelEl.value = preset.model;
    if (overwrite || !baseUrlEl.value) baseUrlEl.value = preset.baseUrl;
    keyHint.textContent = preset.hint;
    persist();
  }

  function persist() {
    localStorage.setItem("workupiq.settings", JSON.stringify({
      provider: providerEl.value,
      model: modelEl.value,
      baseUrl: baseUrlEl.value,
      apiKey: apiKeyEl.value,
      company: companyEl.value,
    }));
  }

  async function pingServer() {
    try {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error("down");
      const data = await res.json();
      serverStatus.textContent = "Local server · " + data.status + (data.workup_parser ? " · " + data.workup_parser : "");
      return true;
    } catch {
      serverStatus.textContent = "The local server isn’t connected. In the project’s local folder, run python3 server.py, then open its localhost address.";
      return false;
    }
  }

  function optionFor(model) {
    const opt = document.createElement("option");
    opt.value = model.id;
    const label = model.name && model.name !== model.id ? model.name + " (" + model.id + ")" : model.id;
    opt.textContent = (model.free ? "Free · " : "") + label;
    return opt;
  }

  function filteredCatalog() {
    const q = (modelFilter && modelFilter.value || "").trim().toLowerCase();
    if (!q) return catalogModels;
    return catalogModels.filter((m) => {
      const hay = ((m.id || "") + " " + (m.name || "")).toLowerCase();
      return hay.includes(q);
    });
  }

  function renderModelSelect(wanted) {
    modelSelect.innerHTML = "";
    const models = filteredCatalog();
    const free = models.filter((m) => m.free);
    const paid = models.filter((m) => !m.free);
    if (free.length) {
      const group = document.createElement("optgroup");
      group.label = "Free / $0";
      free.forEach((m) => group.appendChild(optionFor(m)));
      modelSelect.appendChild(group);
    }
    if (paid.length) {
      const group = document.createElement("optgroup");
      group.label = "Paid";
      paid.forEach((m) => group.appendChild(optionFor(m)));
      modelSelect.appendChild(group);
    }
    if (!models.length) {
      modelSelect.appendChild(optionFor({ id: wanted || modelEl.value || "custom", free: false }));
    }
    const ids = models.map((m) => m.id);
    if (wanted && ids.includes(wanted)) modelSelect.value = wanted;
    else if (models[0]) {
      modelSelect.value = models[0].id;
      if (!wanted) modelEl.value = models[0].id;
    }
    const shown = models.length;
    const total = catalogModels.length;
    const freeCount = catalogMeta.free_count || catalogModels.filter((m) => m.free).length;
    const source = catalogMeta.source || "unknown";
    modelStatus.textContent = (shown === total ? shown : shown + " / " + total) + " models · " + freeCount + " free · source " + source;
  }

  async function snapshotCatalog(provider) {
    const res = await fetch("models.json", { cache: "no-store" });
    if (!res.ok) throw new Error("no snapshot");
    const catalog = await res.json();
    const block = catalog[provider] || {};
    return {
      models: block.models || [],
      source: "snapshot",
      free_count: (block.models || []).filter((m) => m.free).length,
    };
  }

  async function loadModels(live) {
    modelStatus.textContent = "Loading catalog…";
    modelSelect.innerHTML = "";
    const provider = providerEl.value;
    try {
      const headers = {};
      if (apiKeyEl.value) headers["X-API-Key"] = apiKeyEl.value;
      const params = new URLSearchParams({
        provider: provider,
        live: live ? "1" : "0",
      });
      if (baseUrlEl.value) params.set("base_url", baseUrlEl.value);
      const res = await fetch("/api/models?" + params.toString(), { headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "catalog failed");
      catalogModels = data.models || [];
      catalogMeta = { source: data.source || "unknown", free_count: data.free_count || 0 };
      if (data.error) catalogMeta.source += " (" + data.error + ")";
      const wanted = modelEl.value;
      const ids = catalogModels.map((m) => m.id);
      if (wanted && !ids.includes(wanted) && catalogModels[0]) {
        modelEl.value = catalogModels[0].id;
      }
      renderModelSelect(modelEl.value);
      persist();
    } catch (err) {
      try {
        const snap = await snapshotCatalog(provider);
        catalogModels = snap.models;
        catalogMeta = { source: "snapshot", free_count: snap.free_count };
        renderModelSelect(modelEl.value);
        modelStatus.textContent += " · live catalog unavailable (" + (err.message || err) + ")";
        persist();
      } catch {
        catalogModels = [];
        catalogMeta = { source: "fallback", free_count: 0 };
        const preset = PRESETS[provider] || {};
        modelSelect.appendChild(optionFor({ id: modelEl.value || preset.model || "custom", free: provider === "openrouter" }));
        modelStatus.textContent = "Catalog fallback: " + (err.message || err);
      }
    }
  }

  async function handleFile(file) {
    filename = file.name;
    fileStatus.textContent = "Extracting " + file.name + "…";
    runBtn.disabled = true;
    pack = null;
    const body = new FormData();
    body.append("file", file);
    try {
      const res = await fetch("/api/extract", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Extract failed");
      extracted = data.text || "";
      fileStatus.textContent = file.name + " · " + extracted.length.toLocaleString() + " characters · " + (data.pages || "?") + " parts";
      const ready = extracted.length < 40;
      runBtn.disabled = ready;
      if (runRedBtn) runRedBtn.disabled = ready;
      resultEl.textContent = extracted.slice(0, 4000) || "(empty extract)";
      activeTab = "extract";
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "extract"));
    } catch (err) {
      fileStatus.textContent = String(err.message || err);
      extracted = "";
    }
  }

  function selectedAttacks() {
    return ["gatekeeper", "wrapper", "forensic", "premortem"].filter((id) => {
      const box = document.getElementById("atk-" + id);
      return box && box.checked;
    });
  }

  async function runScreen(opts) {
    if (!extracted) return;
    const model = modelEl.value || modelSelect.value;
    if (providerEl.value !== "ollama" && !apiKeyEl.value.trim()) {
      resultEl.textContent = "Add an API key, or switch provider to Ollama.";
      return;
    }
    const redTeam = !opts || opts.redTeam !== false;
    runBtn.disabled = true;
    if (runRedBtn) runRedBtn.disabled = true;
    let attacks = redTeam ? selectedAttacks() : [];
    if (redTeam && attacks.length === 0) {
      const gate = document.getElementById("atk-gatekeeper");
      if (gate) gate.checked = true;
      if (masterBox) masterBox.checked = true;
      attacks = ["gatekeeper"];
    }
    resultEl.textContent = redTeam
      ? "Running pack + " + attacks.join(", ") + " on " + model + "…"
      : "Running pack only on " + model + "…";
    try {
      const res = await fetch("/api/workup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: extracted,
          filename,
          company: companyEl.value,
          provider: providerEl.value,
          model,
          base_url: baseUrlEl.value,
          api_key: apiKeyEl.value,
          attacks,
        }),
      });
      let data = {};
      try {
        data = await res.json();
      } catch {
        throw new Error("Server returned a non-JSON body (HTTP " + res.status + "). Restart python3 server.py.");
      }
      if (!res.ok) throw new Error(data.error || "Workup failed");
      pack = data;
      downloadBtn.disabled = false;
      activeTab = "verdict";
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "verdict"));
      renderTab();
    } catch (err) {
      resultEl.textContent = String(err.message || err);
    } finally {
      runBtn.disabled = extracted.length < 40;
      if (runRedBtn) runRedBtn.disabled = extracted.length < 40;
    }
  }

  function renderTab() {
    if (!pack) {
      if (activeTab === "extract") resultEl.textContent = extracted || "No extract.";
      return;
    }
    if (activeTab === "verdict") {
      const reasons = (pack.pass_reasons || []).map((r, i) => (i + 1) + ". " + r).join("\n");
      const gaps = (pack.data_gaps || []).map((r) => "• " + r).join("\n");
      resultEl.textContent = [
        "WIQ Verdict: " + (pack.verdict || "—"),
        "",
        pack.verdict_rationale || "",
        "",
        "Reasons a junior associate could still pass:",
        reasons || "None that survive the extract.",
        "",
        "Request Data / missing evidence:",
        gaps || "None listed.",
      ].join("\n");
    } else if (activeTab === "workup") {
      resultEl.textContent = pack.workup_markdown || "";
    } else if (activeTab === "faq") {
      resultEl.textContent = pack.faq_markdown || "We couldn’t find enough information in the deck text to draft the FAQ.\n\nDownload templates/WorkupIQ_RedTeam_FAQ_Template.md from the home page, fill Q1–Q8, export as selectable-text PDF, attach it with the deck, and re-run the Screen.";
    } else if (["gatekeeper", "wrapper", "forensic", "premortem"].includes(activeTab)) {
      const text = (pack.attacks && pack.attacks[activeTab]) || "";
      const requested = pack.attacks_requested || [];
      if (text) resultEl.textContent = text;
      else if (requested.length && !requested.includes(activeTab)) {
        resultEl.textContent = "This review wasn’t selected. Choose  " + activeTab + "  above and click Review my pitch.";
      } else {
        resultEl.textContent = "The model didn’t return this section. Keep this option selected and try Review my pitch again.";
      }
    } else if (activeTab === "hygiene") {
      resultEl.textContent = (pack.hygiene || []).map((h) => "• " + h).join("\n") || "No readability issues were flagged in this review.";
    } else {
      resultEl.textContent = extracted;
    }
  }

  function downloadPack() {
    if (!pack) return;
    const name = (companyEl.value || "Company").replace(/\s+/g, "_");
    const md = [
      "# " + name + " — WorkupIQ Pack",
      "",
      "## WIQ Verdict: " + (pack.verdict || ""),
      "",
      pack.verdict_rationale || "",
      "",
      "## Workup",
      "",
      pack.workup_markdown || "",
      "",
      "## Red-team FAQ",
      "",
      pack.faq_markdown || "",
      "",
      "## Hygiene",
      "",
      (pack.hygiene || []).map((h) => "- " + h).join("\n"),
      "",
      "## Gatekeeper",
      "",
      (pack.attacks && pack.attacks.gatekeeper) || "",
      "",
      "## Wrapper stress test",
      "",
      (pack.attacks && pack.attacks.wrapper) || "",
      "",
      "## Financial forensic",
      "",
      (pack.attacks && pack.attacks.forensic) || "",
      "",
      "## Pre-mortem",
      "",
      (pack.attacks && pack.attacks.premortem) || "",
    ].join("\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name + "_WorkupIQ_Pack.md";
    a.click();
    URL.revokeObjectURL(a.href);
  }
})();
