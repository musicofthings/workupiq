(function () {
  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  const menuBtn = document.getElementById("menuBtn");
  const mobileNav = document.getElementById("mobileNav");
  if (menuBtn && mobileNav) {
    menuBtn.addEventListener("click", () => {
      const open = mobileNav.classList.toggle("is-open");
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    mobileNav.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        mobileNav.classList.remove("is-open");
        menuBtn.setAttribute("aria-expanded", "false");
      });
    });
  }

  const form = document.getElementById("accessForm");
  const status = document.getElementById("formStatus");
  if (!form || !status) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const data = new FormData(form);
    const email = String(data.get("email") || "").trim();
    const company = String(data.get("company") || "").trim();
    const round = String(data.get("round") || "").trim();
    const note = String(data.get("note") || "").trim();
    const gotcha = String(data.get("_gotcha") || "").trim();

    if (!email || !company || !round) {
      status.className = "form-status err";
      status.textContent = "Email, company, and round are required.";
      return;
    }

    // Honeypot filled → pretend success, do nothing
    if (gotcha) {
      status.className = "form-status ok";
      status.textContent = "Request received. We’ll reply from hello@workupiq.com.";
      form.reset();
      return;
    }

    status.className = "form-status";
    status.textContent = "Sending…";

    const payload = { email, company, round, note };

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });

      let body = {};
      try {
        body = await res.json();
      } catch {
        /* ignore parse errors */
      }

      if (!res.ok) {
        throw new Error(body.error || "Request failed");
      }

      status.className = "form-status ok";
      status.textContent = "Request received. We’ll reply from hello@workupiq.com.";
      form.reset();
    } catch (err) {
      status.className = "form-status err";
      status.textContent =
        "Something went wrong. Please try again or write hello@workupiq.com.";
      console.error(err);
    }
  });
})();
