(function () {
  const $ = (id) => document.getElementById(id);
  const providerEl = $("provider");
  const modelEl = $("model");
  const modelSelect = $("modelSelect");
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
  const modelStatus = $("modelStatus");
  const keyHint = $("keyHint");
  const refreshBtn = $("refreshModels");
  const modelFilter = $("modelFilter");

  const PRESETS = {
    openrouter: { model: "openrouter/free", hint: "Full OpenRouter catalog, free variants first. Type in Filter catalog to search. openrouter/free routes across the free pool." },
    nvidia: { model: "meta/llama-3.1-8b-instruct", hint: "NVIDIA NIM key from build.nvidia.com. Trial / smaller models are sorted first." },
    grok: { model: "grok-4.6", hint: "xAI key from console.x.ai. Grok models are paid." },
    openai: { model: "gpt-4o-mini", hint: "Your OpenAI key is sent with each request and isn’t stored by WorkupIQ." },
    anthropic: { model: "claude-sonnet-4-5", hint: "Paste your Anthropic key, then Refresh models for the live Claude catalog." },
    gemini: { model: "gemini-2.5-flash", hint: "Google AI Studio key. Refresh models lists every generateContent model on that key." },
  };

  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem("workupiq.settings") || "{}") || {};
  } catch {
    saved = {};
  }
  if (PRESETS[saved.provider]) {
    providerEl.value = saved.provider;
    if (saved.model) modelEl.value = saved.model;
  }
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
    loadModels();
  });
  modelSelect.addEventListener("change", () => {
    modelEl.value = modelSelect.value;
    persist();
  });
  [providerEl, modelEl, apiKeyEl, companyEl].forEach((el) => {
    el.addEventListener("change", persist);
    el.addEventListener("input", persist);
  });
  refreshBtn.addEventListener("click", () => loadModels());
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

  loadModels();

  function applyPreset(overwrite) {
    const preset = PRESETS[providerEl.value];
    if (!preset) return;
    if (overwrite || !modelEl.value) modelEl.value = preset.model;
    keyHint.textContent = preset.hint;
    persist();
  }

  function persist() {
    localStorage.setItem("workupiq.settings", JSON.stringify({
      provider: providerEl.value,
      model: modelEl.value,
      apiKey: apiKeyEl.value,
      company: companyEl.value,
    }));
  }

  async function readJson(res) {
    try {
      return await res.json();
    } catch {
      throw new Error("Unexpected response from the server (HTTP " + res.status + "). Please try again.");
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

  async function loadModels() {
    modelStatus.textContent = "Loading catalog…";
    modelSelect.innerHTML = "";
    const provider = providerEl.value;
    try {
      const headers = {};
      if (apiKeyEl.value) headers["X-API-Key"] = apiKeyEl.value;
      const params = new URLSearchParams({ provider });
      const res = await fetch("/api/models?" + params.toString(), { headers });
      const data = await readJson(res);
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
      const reason = String(err.message || err);
      try {
        const snap = await snapshotCatalog(provider);
        catalogModels = snap.models;
        catalogMeta = { source: "snapshot", free_count: snap.free_count };
        renderModelSelect(modelEl.value);
        modelStatus.textContent += " · live catalog unavailable (" + reason + ")";
        persist();
      } catch {
        catalogModels = [];
        catalogMeta = { source: "fallback", free_count: 0 };
        const preset = PRESETS[provider] || {};
        modelSelect.appendChild(optionFor({ id: modelEl.value || preset.model || "custom", free: provider === "openrouter" }));
        modelStatus.textContent = "Catalog fallback: " + reason;
      }
    }
  }

  async function extractPdf(file) {
    const root = "/vendor/pdfjs-6.5.438/";
    const pdfjs = await import(root + "pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = root + "pdf.worker.min.mjs";
    const task = pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      cMapUrl: root + "cmaps/",
      cMapPacked: true,
      isEvalSupported: false,
    });
    try {
      const pdf = await task.promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        pages.push(content.items.map((item) => (item.str || "") + (item.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+\n/g, "\n").trim());
        page.cleanup();
      }
      return { parts: pages, label: "Slide/page" };
    } catch (err) {
      if (err && err.name === "PasswordException") {
        throw new Error("This PDF is password-protected. Remove the password and try again.");
      }
      throw err;
    } finally {
      await task.destroy();
    }
  }

  async function extractPptx(file) {
    const zip = await JSZip.loadAsync(file);
    const names = Object.keys(zip.files)
      .map((name) => ({ name, match: name.match(/^ppt\/slides\/slide(\d+)\.xml$/) }))
      .filter((entry) => entry.match)
      .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
    const slides = [];
    for (const { name } of names) {
      const doc = new DOMParser().parseFromString(await zip.file(name).async("string"), "application/xml");
      const runs = doc.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "t");
      slides.push(Array.from(runs).map((run) => run.textContent).filter(Boolean).join("\n"));
    }
    return { parts: slides, label: "Slide" };
  }

  async function handleFile(file) {
    filename = file.name;
    fileEl.value = "";
    runBtn.disabled = true;
    if (runRedBtn) runRedBtn.disabled = true;
    pack = null;
    extracted = "";
    resultEl.textContent = "";
    fileStatus.textContent = "Reading " + file.name + "…";
    try {
      const name = file.name.toLowerCase();
      let result;
      if (name.endsWith(".pdf")) result = await extractPdf(file);
      else if (name.endsWith(".pptx")) result = await extractPptx(file);
      else throw new Error("Please choose a PDF or PPTX file.");
      if (!result.parts.some((part) => part.trim())) {
        throw new Error("We couldn’t find selectable text in " + file.name + ". It may be an image-only deck. Export it with live text and try again.");
      }
      extracted = result.parts.map((part, i) => "--- " + result.label + " " + (i + 1) + " ---\n" + part).join("\n\n");
      fileStatus.textContent = file.name + " · " + extracted.length.toLocaleString() + " characters · " + result.parts.length + " parts";
      const tooShort = extracted.length < 40;
      runBtn.disabled = tooShort;
      if (runRedBtn) runRedBtn.disabled = tooShort;
      resultEl.textContent = extracted.slice(0, 4000);
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
    if (!apiKeyEl.value.trim()) {
      resultEl.textContent = "Add your API key to run a review.";
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
    const steps = 1 + attacks.length;
    const progress = (step, label) => {
      resultEl.textContent = "Step " + step + " of " + steps + ": " + label + " on " + model + "…";
    };
    const common = {
      text: extracted.slice(0, 80000),
      filename,
      company: companyEl.value,
      provider: providerEl.value,
      model,
      api_key: apiKeyEl.value,
    };
    const post = async (path, body) => {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "The review failed. Please try again.");
      return data;
    };
    try {
      progress(1, "drafting documents");
      const data = await post("/api/workup", common);
      data.attacks = {};
      data.attacks_requested = attacks;
      for (let i = 0; i < attacks.length; i++) {
        progress(i + 2, attacks[i] + " review");
        try {
          data.attacks[attacks[i]] = (await post("/api/attack", { ...common, attack: attacks[i] })).markdown;
        } catch (err) {
          data.attacks[attacks[i]] = "This review failed: " + String(err.message || err);
        }
      }
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
