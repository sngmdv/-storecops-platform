"use strict";

/* ─────────────────────────────────────────────────────────────────
   Storecops landing — Enterprise interactions
   Scroll reveal, dark mode, tabs, counters, command palette.
   ───────────────────────────────────────────────────────────────── */

(function () {
  /* ── Dark Mode ── */
  const savedTheme = localStorage.getItem("storecops-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  if (savedTheme === "dark" || (!savedTheme && prefersDark)) {
    document.documentElement.classList.add("dark");
  }
  document.querySelectorAll(".theme-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.documentElement.classList.toggle("dark");
      localStorage.setItem(
        "storecops-theme",
        document.documentElement.classList.contains("dark") ? "dark" : "light"
      );
    });
  });

  /* ── Scroll Reveal (IntersectionObserver) ── */
  const revealElements = document.querySelectorAll(".reveal, .stagger");
  if (revealElements.length && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -40px 0px" }
    );
    revealElements.forEach((el) => observer.observe(el));
  } else {
    document.querySelectorAll(".reveal, .stagger").forEach((el) => el.classList.add("visible"));
  }

  /* ── Number Counter Animation ── */
  const counters = document.querySelectorAll(".counter[data-target]");
  if (counters.length && "IntersectionObserver" in window) {
    const counterObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            animateCounter(entry.target);
            counterObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.5 }
    );
    counters.forEach((el) => counterObserver.observe(el));
  }

  function animateCounter(el) {
    const target = parseInt(el.dataset.target, 10);
    const prefix = el.dataset.prefix || "";
    const suffix = el.dataset.suffix || "";
    const duration = 1200;
    const start = performance.now();
    function update(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = prefix + Math.round(target * eased).toLocaleString() + suffix;
      if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
  }

  /* ── Use-case Tabs ── */
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      const panel = document.getElementById("panel-" + tab.dataset.tab);
      if (panel) panel.classList.add("active");
    });
  });

  /* ── Live ticker in hero mock ── */
  const liveCard = document.querySelector(".mock-card.live");
  if (liveCard) {
    const buyers = [
      "LIVE — Priya just bought Smart Ring · $199",
      "LIVE — Rahul just bought 2× Phone Case · $48",
      "LIVE — Sara just bought Earbuds + Cable · $101",
      "LIVE — Vikram just bought 2× Power Bank · $90",
      "LIVE — Anita just bought Smart Watch · $149",
    ];
    let i = 0;
    setInterval(() => {
      i = (i + 1) % buyers.length;
      const dot = liveCard.querySelector(".live-dot");
      liveCard.textContent = buyers[i];
      liveCard.prepend(dot);
    }, 3200);
  }

  /* ── Lead capture (newsletter) ── */
  const leadForm = document.getElementById("lead-form");
  if (leadForm) {
    leadForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const emailInput = document.getElementById("lead-email");
      const msgEl = document.getElementById("lead-msg");
      const email = emailInput?.value?.trim();
      if (!email) return;
      msgEl.textContent = "Subscribing...";
      msgEl.style.color = "var(--text-dim)";
      try {
        const res = await fetch("/api/v1/leads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, source: "landing_newsletter" }),
        });
        const data = await res.json();
        if (res.ok) {
          msgEl.textContent = data.created ? "Subscribed! Check your inbox." : "Already subscribed — welcome back!";
          msgEl.style.color = "var(--green)";
          emailInput.value = "";
        } else {
          throw new Error(data.error || "Failed to subscribe");
        }
      } catch (err) {
        msgEl.textContent = err.message;
        msgEl.style.color = "var(--red)";
      }
    });
  }

  /* ── Pricing Toggle (Monthly / Annual) ── */
  const pricingToggle = document.querySelector(".toggle-track");
  if (pricingToggle) {
    const monthlyLabel = document.querySelector(".pricing-toggle .monthly");
    const annualLabel = document.querySelector(".pricing-toggle .annual");
    const prices = document.querySelectorAll(".plan .price");
    const monthlyPrices = ["$0", "$49", "$149"];
    const annualPrices = ["$0", "$39", "$119"];
    let isAnnual = false;

    pricingToggle.addEventListener("click", () => {
      isAnnual = !isAnnual;
      pricingToggle.classList.toggle("active", isAnnual);
      monthlyLabel?.classList.toggle("active", !isAnnual);
      annualLabel?.classList.toggle("active", isAnnual);
      const selected = isAnnual ? annualPrices : monthlyPrices;
      prices.forEach((p, i) => {
        if (selected[i]) {
          const span = p.querySelector("span");
          p.childNodes[0].textContent = selected[i];
          if (span) p.appendChild(span);
        }
      });
    });
  }
})();
