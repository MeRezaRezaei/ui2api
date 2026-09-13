import { test } from "node:test";
import assertStrict from "node:assert/strict";
import { createServer } from "node:http";
import { createContext } from "../src/plugin/context.js";
import type { EngineName } from "../src/plugin/context.js";

// End-to-end proof of the JS-level primitives that make up the map's key section:
//   paste  -> inject text into the site's input via keyboard/paste events
//   press  -> Enter fires the SITE's own keydown handler (its "send")
//   capture-> the site streams an answer into the page (event bus); we read the
//            chunks off it, exactly like an AI-call answer
//   status -> situation status of the page
// The control site is served inline so the loop is deterministic and hermetic.

const CONTROL_HTML = `<!doctype html><html><body>
<textarea id="in"></textarea><div id="events"></div><div id="out"></div>
<script>
const input=document.getElementById("in"), out=document.getElementById("out"), events=document.getElementById("events");
input.addEventListener("paste",(e)=>{events.textContent+="PASTE:"+(e.clipboardData?e.clipboardData.getData("text"):"")+"\\n";});
input.addEventListener("input",(e)=>{events.textContent+="INPUT\\n";});
function stream(promiseText){
  const words=[...promiseText.split(" "),"done"];
  let i=0; const t=setInterval(()=>{
    if(i<words.length){out.textContent+=(out.textContent?" ":"")+words[i];i++;}
    else clearInterval(t);
  },60);
}
input.addEventListener("keydown",(e)=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();stream(input.value);}});
</script></body></html>`;

function startControl(): Promise<{ url: string; close(): void }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(CONTROL_HTML);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

test("js-level primitives stream the site's answer end to end (native engine)", async () => {
  const site = await startControl();
  try {
    const died = /Target page, context or browser has been closed|Execution context was destroyed/i;
    // Fresh context per attempt: sandboxed chromium sometimes dies mid-run and
    // a dead page must never be reused. Each attempt is the real full loop.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ctx: any = createContext({ dataDir: "/tmp/ui2api-e2e" }, { baseUrl: site.url, dataDir: "/tmp/ui2api-e2e" });
      try {
        await ctx.dom.paste("#in", "hello from the map");
        await ctx.dom.press("#in", ["Enter"]);
        const cap = await ctx.dom.capture("#out", 1200);
        const status = await ctx.dom.status("#out");

        assertStrict.ok((cap as any).text.includes("hello from the map"), "answer echoes the prompt");
        assertStrict.ok((cap as any).text.endsWith("done"), "answer streamed to completion");
        assertStrict.ok((cap as any).chunkCount >= 3, `stream observed as chunks, got ${(cap as any).chunkCount}`);
        assertStrict.equal((status as any).url, site.url);
        assertStrict.equal((status as any).readyState, "complete");
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (died.test(msg) && attempt < 3) continue;
        throw err;
      }
    }
  } finally {
    site.close();
  }
});

test("paste delivers the text and fires the site's paste+input handlers", async () => {
  const site = await startControl();
  try {
    const ctx: any = createContext({ dataDir: "/tmp/ui2api-e2e" }, { baseUrl: site.url, dataDir: "/tmp/ui2api-e2e" }) as any;
    await ctx.dom.paste("#in", "pastetext");
    await ctx.dom.waitFor("#events", 1000);
    const events = (await ctx.dom.extract("text #events")) as string;
    assertStrict.ok(events.includes("PASTE:pastetext"), "site received the paste event with the text");
    assertStrict.ok(events.includes("INPUT"), "site received the input event (keyboard insert)");
  } finally {
    site.close();
  }
});