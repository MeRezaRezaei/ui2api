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
