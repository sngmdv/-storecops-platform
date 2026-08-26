"use strict";

/* Landing page interactions: use-case tabs + tiny live-ticker mock. */

(function () {
  // ── Tabs ──────────────────────────────────────────────────────────
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

  // ── Rotate the fake live-order line in the hero mock ─────────────
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

  // ── Lead capture (newsletter signup) ──────────────────────────────
  const leadForm = document.getElementById("lead-form");
  if (leadForm) {
    leadForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const emailInput = document.getElementById("lead-email");
      const msgEl = document.getElementById("lead-msg");
      const email = emailInput?.value?.trim();
      if (!email) return;
      msgEl.textContent = "Subscribing...";
      msgEl.style.color = "var(--ink-soft)";
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
})();
