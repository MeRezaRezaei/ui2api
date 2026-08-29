import { RegistryStore } from "./store.js";

export function renderHubHtml(store: RegistryStore, opts: { registryUrl: string }): string {
  const pkgs = store.list();
  const rows = pkgs.length
    ? pkgs.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.latest)}</td><td>${esc(p.author)}</td><td class="badge ${p.trust}">${p.trust}</td><td><button onclick="review('${esc(p.name)}','${esc(p.latest)}')">mark reviewed</button></td></tr>`).join("")
    : `<tr><td colspan="5">no packages yet</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>UI2API Hub</title><style>body{font:14px sans-serif;margin:2rem}.badge{padding:2px 6px;border-radius:4px}.reviewed{background:#c8f7c5}.unreviewed{background:#ffe2a8}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}textarea{width:100%;height:8rem}</style></head>
<body><h1>UI2API Hub</h1>
<section><h2>Packages</h2><table><thead><tr><th>name</th><th>latest</th><th>author</th><th>trust</th><th>review</th></tr></thead><tbody>${rows}</tbody></table></section>
<section><h2>Publish (operator)</h2>
<p class="hint">Publishes via <code>PUT /api/packages</code> using the operator token.</p>
<form id="pub"><label>token <input id="tok" type="password"></label><br>
<label>manifest JSON <textarea id="manifest">{ "name":"", "version":"1.0.0", "author":"", "authorizedUse":"own authorized use", "license":"MIT", "ui2api":"0.1.0" }</textarea></label><br>
<label>module <textarea id="module">export default { name:"", setup(c){} };</textarea></label><br>
<button type="button" onclick="publish()">Publish</button></form><pre id="out"></pre></section>
<script>
async function publish(){
  const body = JSON.stringify({ manifest: JSON.parse(document.getElementById('manifest').value), module: document.getElementById('module').value });
  const r = await fetch('/api/packages',{method:'PUT',headers:{'content-type':'application/json','authorization':'Bearer '+document.getElementById('tok').value},body});
  document.getElementById('out').textContent = r.status+' '+await r.text(); location.reload();
}
async function review(name,version){
  const tok = document.getElementById('tok').value;
  const r = await fetch('/api/packages/'+name+'/'+version+'/review',{method:'POST',headers:{'authorization':'Bearer '+tok}});
  location.reload();
}
</script></body></html>`;
}
function esc(s: string){ return String(s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)); }
