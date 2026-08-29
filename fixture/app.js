// A small, deterministic SPA that exposes a real JS API (window.App) and makes
// network calls. UI2API analyzes this to prove the full pipeline end-to-end.
window.App = {
  async sendPrompt(prompt, model) {
    const reply = `Echo[${model}]: ${prompt}`;
    const el = document.getElementById("reply");
    if (el) el.innerText = reply;
    try {
      await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, model }),
      });
    } catch (e) {
      /* test server may not implement this; ignore */
    }
    return reply;
  },
  listModels() {
    return ["default", "pro", "ultra"];
  },
  clearChat() {
    const el = document.getElementById("reply");
    if (el) el.innerText = "";
    return "cleared";
  },
};

// DOM-driven actions (no window.<root> required) so the analyzer can discover
// actions by interacting with the page, not just by reading window.App.
document.getElementById("searchBtn")?.addEventListener("click", async () => {
  try {
    await fetch("/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "test query" }),
    });
  } catch (e) {}
});

document.getElementById("qform")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = new FormData(e.target).get("q") || "";
  const el = document.getElementById("reply");
  if (el) el.innerText = "Queried: " + q;
  try {
    await fetch("/api/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q }),
    });
  } catch (e) {}
});
