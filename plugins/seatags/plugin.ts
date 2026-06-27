function init() {
    $ui.register((ctx) => {
        const SRC = "https://raw.githubusercontent.com/Bas1874/Seanime-Marketplace/main/Marketplace/Main.json"
        const ICON = "https://raw.githubusercontent.com/aquaryuo/seanime/beta/plugins/seatags/icon.png"
        const CACHE_KEY = "seatags:cache"
        const CACHE_TTL = 3600000

        type Entry = {
            id?: string
            name?: string
            author?: string
            version?: string
            description?: string
            type?: string
            language?: string
            lang?: string
            icon?: string
            manifestURI?: string
            payloadURI?: string
            website?: string
            permalink?: string
            flags?: string
            stars?: number
            official?: boolean
            workingTag?: boolean
            brokenTag?: boolean
            deprecatedTag?: boolean
        }

        function now(): number {
            try { return Date.now() } catch (_e) { return 0 }
        }
        function sget<T>(k: string, d: T): T {
            try { const v = $storage.get<T>(k); return v === undefined || v === null ? d : v } catch (_e) { return d }
        }

        const boot = sget<{ at: number; data: Entry[] }>(CACHE_KEY, { at: 0, data: [] })
        const entriesState = ctx.state<Entry[]>(boot.data && boot.data.length > 0 ? boot.data : [])
        const statusState = ctx.state<string>("")
        let lastAt = boot.at || 0

        let inflight = false
        async function load(force: boolean): Promise<void> {
            if (inflight) return
            if (!force && entriesState.get().length > 0 && now() - lastAt < CACHE_TTL) return
            inflight = true
            statusState.set("loading")
            try { tray.update() } catch (_e) {}
            let msg = ""
            try {
                const res = await fetch(SRC, { timeout: 15 })
                if (!res.ok) {
                    msg = "fetch failed (HTTP " + res.status + ")"
                } else {
                    const data = res.json<any>()
                    if (!Array.isArray(data)) {
                        msg = "unexpected marketplace format"
                    } else {
                        entriesState.set(data as Entry[])
                        lastAt = now()
                        try { $storage.set(CACHE_KEY, { at: lastAt, data: data }) } catch (_e) {}
                    }
                }
            } catch (_e) {
                msg = "could not reach the marketplace"
            }
            inflight = false
            statusState.set(msg)
            try { tray.update() } catch (_e) {}
        }

        const SIDEBAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.5V11a2 2 0 0 0 .59 1.42l8 8a2 2 0 0 0 2.83 0l5.5-5.5a2 2 0 0 0 0-2.83l-8-8A2 2 0 0 0 10.5 3H5a2 2 0 0 0-2 2Z"/><circle cx="7.6" cy="7.6" r="1.1" fill="currentColor"/></svg>`

        const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{
  --background:#070707;
  --paper:#0b0b0b;
  --gray-900:#101010;
  --gray-950:#0b0b0b;
  --gray-800:#1c1c1c;
  --gray-700:#363636;
  --gray-600:#484848;
  --gray-500:#5a5a5a;
  --gray-400:#8f8f8f;
  --gray-300:#cacaca;
  --gray-200:#d1d1d1;
  --foreground:#d1d1d1;
  --border:rgba(255,255,255,0.1);
  --card-border:rgba(255,255,255,0.05);
  --muted:rgba(255,255,255,0.4);
  --muted-highlight:rgba(255,255,255,0.6);
  --subtle:rgba(255,255,255,0.06);
  --subtle-highlight:rgba(255,255,255,0.08);
  --ring:#d4d0ff;
  --radius:0.5rem;
  --brand:#c7c2ff;
  --brand-500:#6152df;
  --brand-50-10:rgba(242,240,255,0.10);
  --brand-50-20:rgba(242,240,255,0.20);
  --green:#68b695;
  --green-500:#258c60;
  --red:#fca5a5;
  --red-500:#ef4444;
  --orange:#fdba74;
  --orange-500:#f97316;
  --blue:#93c5fd;
  --blue-500:#3b82f6;
  --indigo-300:#a5b4fc;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif,"Apple Color Emoji","Segoe UI Emoji";
}

*{box-sizing:border-box}
html,body{
  margin:0;padding:0;
  background:var(--background);
  color:var(--foreground);
  font-family:var(--sans);
  font-size:14px;
  line-height:1.5;
  -webkit-font-smoothing:antialiased;
}

/* ===== Page chrome (header / filters / sort) ===== */
#app{max-width:1200px;margin:0 auto;padding:20px 20px 56px}
.head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.title{font-size:1.375rem;font-weight:700;letter-spacing:-0.01em;color:var(--foreground)}
.title .sub{font-size:0.8125rem;font-weight:500;color:var(--muted);margin-left:8px}
.actions{margin-left:auto;display:flex;gap:8px;align-items:center}
#search{background:var(--gray-900);border:1px solid var(--border);color:var(--foreground);border-radius:0.5rem;padding:0.5rem 0.75rem;width:300px;max-width:60vw;outline:none;font-family:var(--sans);font-size:0.875rem}
#search::placeholder{color:var(--muted)}
#search:focus{border-color:var(--ring)}
.topbtn{height:2rem;padding-inline:0.875rem;border-radius:0.5rem;border:1px solid transparent;background:rgba(225,225,225,0.10);color:var(--gray-300);font-weight:600;font-size:0.875rem;cursor:pointer;font-family:var(--sans);transition:background 120ms}
.topbtn:hover{background:rgba(225,225,225,0.18)}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.sortbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0 18px}
.slbl{color:var(--muted);font-size:0.75rem;margin-right:4px}
.pill{height:1.875rem;padding-inline:0.75rem;border-radius:0.5rem;border:1px solid var(--border);background:var(--gray-900);color:var(--gray-300);font-size:0.8125rem;font-weight:500;cursor:pointer;white-space:nowrap;font-family:var(--sans);transition:border-color 120ms,background 120ms,color 120ms}
.pill:hover{border-color:rgba(255,255,255,0.25)}
.pill.on{background:var(--brand-50-10);border-color:transparent;color:var(--brand);font-weight:600}
.status{display:none;background:rgba(254,242,242,0.06);border:1px solid rgba(239,68,68,0.30);color:var(--red);border-radius:0.5rem;padding:0.5rem 0.75rem;margin-bottom:12px;font-size:0.8125rem}

/* ===== Responsive card grid ===== */
.sea-grid{display:grid;grid-template-columns:repeat(1,minmax(0,1fr));gap:1rem}
@media (min-width:1024px){.sea-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (min-width:1536px){.sea-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
.sea-empty{grid-column:1 / -1;background:var(--paper);border:1px solid var(--border);border-radius:0.75rem;padding:2rem;text-align:center;color:var(--muted)}

/* ===== Card root ===== */
.ext-card{position:relative;overflow:hidden;background:var(--gray-900);border:1px solid var(--card-border);border-radius:0.75rem;padding:0.75rem;transition:border-color 150ms ease-in;display:flex;flex-direction:column}
.ext-card:hover{border-color:rgba(255,255,255,0.12)}
.ext-card.is-update{border-color:var(--green)}
.ext-card.is-broken{border-color:var(--orange)}
.ext-card.is-deprecated{opacity:0.85}
.ext-card-decor{position:absolute;z-index:0;right:0;top:0;height:100%;width:100%;max-width:150px;pointer-events:none;background:linear-gradient(to left,var(--gray-950),rgba(11,11,11,0))}
.ext-actions{position:absolute;top:0.75rem;right:0.75rem;z-index:2;display:flex;flex-direction:row;gap:0.25rem;flex-wrap:wrap;justify-content:flex-end}
.ext-content{position:relative;z-index:1;display:flex;flex-direction:column;gap:0.75rem;flex:1}
.ext-header{display:flex;gap:0.75rem;padding-right:4rem}
.ext-icon{position:relative;flex:none;width:3rem;height:3rem;border-radius:0.375rem;overflow:hidden;background:var(--gray-900)}
.ext-icon img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;z-index:1}
.ext-icon-fallback{position:absolute;inset:0;z-index:0;display:flex;align-items:center;justify-content:center;background:var(--gray-950);color:var(--foreground);font-size:1.5rem;font-weight:700;text-transform:uppercase}
.ext-text{min-width:0;flex:1}
.ext-name{margin:0;font-weight:600;font-size:1rem;color:var(--foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ext-meta{margin:0.125rem 0 0;font-size:0.75rem;line-height:1rem;letter-spacing:0.025em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ext-meta .type{opacity:0.7}
.ext-meta .id{opacity:0.3}
.ext-desc{margin:0;font-size:0.875rem;line-height:1.25rem;color:var(--muted);cursor:default;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ext-badges{display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;margin-top:auto;padding-top:0.25rem}

/* ===== Badge primitive ===== */
.badge{display:inline-flex;flex:none;width:fit-content;justify-content:center;align-items:center;gap:0.5rem;overflow:hidden;white-space:nowrap;height:1.5rem;padding-inline:0.5rem;font-size:0.75rem;line-height:1rem;font-weight:600;letter-spacing:0.025em;border-radius:0.375rem;border:1px solid transparent}
.badge.link{cursor:pointer}
.badge.link:hover{filter:brightness(1.15)}
.badge-unstyled{color:var(--gray-300);border:1px solid var(--border)}
.badge-blue{color:var(--blue);background:rgba(239,246,255,0.10);border:1px solid transparent}
.badge-success{color:var(--green);background:rgba(230,247,234,0.10);border:1px solid rgba(37,140,96,0.40)}
.badge-warning{color:var(--orange);background:rgba(255,247,237,0.10);border:1px solid rgba(249,115,22,0.40)}
.badge-alert{color:var(--red);background:rgba(254,242,242,0.10);border:1px solid rgba(239,68,68,0.40)}
.badge-gray{color:var(--gray-300);background:rgba(225,225,225,0.10);border:1px solid rgba(90,90,90,0.40)}
.badge-muted{color:var(--muted);background:transparent;border:1px solid transparent;padding-inline:0}
.badge-official{color:var(--brand);background:var(--brand-50-10);border:1px solid rgba(199,194,255,0.30)}
.badge-vt-ok{color:var(--green);background:rgba(230,247,234,0.10);border:1px solid rgba(37,140,96,0.30)}
.badge-vt-bad{color:var(--red);background:rgba(254,242,242,0.10);border:1px solid rgba(239,68,68,0.45)}
.badge-stars{color:var(--gray-300);background:transparent;border:1px solid transparent;padding-inline:0;gap:0.2rem}

/* ===== Button primitive ===== */
.btn{display:inline-flex;align-items:center;justify-content:center;text-align:center;white-space:nowrap;gap:0.375rem;height:2rem;padding-inline:0.75rem;font-size:0.875rem;line-height:1.25rem;font-weight:600;border-radius:0.5rem;border:1px solid transparent;cursor:pointer;transition:all 150ms ease-in;font-family:var(--sans)}
.btn:focus-visible{outline:none;box-shadow:0 0 0 1px var(--background),0 0 0 3px var(--ring)}
.btn:disabled{opacity:0.5;pointer-events:none}
.btn.icon{width:2rem;padding-inline:0}
.btn.icon svg{width:1.05rem;height:1.05rem}
.btn-primary-subtle{color:var(--brand);background:var(--brand-50-10);border:1px solid transparent}
.btn-primary-subtle:hover{background:var(--brand-50-20)}
.btn-gray-subtle{color:var(--gray-300);background:rgba(225,225,225,0.10);border:1px solid transparent}
.btn-gray-subtle:hover{background:rgba(225,225,225,0.20)}
.btn-success-subtle{color:var(--green);background:rgba(230,247,234,0.10);border:1px solid transparent}
.btn .ic{display:inline-flex;align-self:center;flex-shrink:0;line-height:0}
.btn svg{width:1em;height:1em}
</style>
</head>
<body>
<div id="app">
  <div class="head">
    <div class="title">SeaTags<span class="sub" id="count"></span></div>
    <div class="actions">
      <input id="search" type="text" placeholder="Search name, author, description…" autocomplete="off">
      <button id="refresh" class="topbtn">Refresh</button>
    </div>
  </div>
  <div class="filters" id="tagfilters"></div>
  <div class="filters" id="kindfilters"></div>
  <div class="sortbar" id="sortbar"></div>
  <div class="status" id="status"></div>
  <div class="sea-grid" id="list"></div>
</div>
<script>
(function(){
  var entries = [];
  var statusMsg = "";
  var q = "";
  var tag = "all";
  var kind = "all";
  var sortKey = "name";
  var sortDir = 1;

  var TAGS = [["all","All"],["working","Working"],["broken","Broken"],["deprecated","Deprecated"],["untagged","Untagged"]];
  var KINDS = [["all","All"],["plugin","Plugins"],["onlinestream-provider","Streaming"],["manga-provider","Manga"],["anime-torrent-provider","Torrent"],["custom-source","Custom"]];
  var KINDLABEL = {"plugin":"Plugin","onlinestream-provider":"Online Streaming","manga-provider":"Manga","anime-torrent-provider":"Anime Torrent","custom-source":"Custom Source"};
  var SORTS = [["name","Name"],["stars","Stars"],["flags","VirusTotal"],["type","Type"]];

  var DL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  var CK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  function el(id){ return document.getElementById(id); }
  function esc(s){ s = (s==null)?"":String(s); return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function low(s){ return (s==null?"":String(s)).toLowerCase(); }
  function cap(s){ s=(s==null)?"":String(s); return s ? (s.charAt(0).toUpperCase()+s.slice(1)) : ""; }

  function hasTag(e,t){
    if(t==="all") return true;
    if(t==="working") return !!e.workingTag;
    if(t==="broken") return !!e.brokenTag;
    if(t==="deprecated") return !!e.deprecatedTag;
    if(t==="untagged") return !e.workingTag && !e.brokenTag && !e.deprecatedTag;
    return true;
  }
  function vtNums(e){
    var f = (e.flags==null)?"":String(e.flags);
    var parts = f.split("/");
    if(parts.length!==2) return null;
    var n = parseInt(parts[0],10), d = parseInt(parts[1],10);
    if(isNaN(n) || isNaN(d)) return null;
    return { n: n, d: d };
  }
  function matchKind(e,k){ return k==="all" || (e.type||"")===k; }
  function matchSearch(e){
    if(!q) return true;
    var hay = low(e.name)+" "+low(e.author)+" "+low(e.description)+" "+low(e.id);
    return hay.indexOf(q) >= 0;
  }
  function filtered(){
    var out = [];
    for(var i=0;i<entries.length;i++){
      var e = entries[i];
      if(hasTag(e,tag) && matchKind(e,kind) && matchSearch(e)) out.push(e);
    }
    out.sort(function(a,b){
      var r = 0;
      if(sortKey==="name") r = low(a.name).localeCompare(low(b.name));
      else if(sortKey==="type") r = low(a.type).localeCompare(low(b.type));
      else if(sortKey==="stars") r = (a.stars||0)-(b.stars||0);
      else if(sortKey==="flags"){ var an=vtNums(a), bn=vtNums(b); var av=an?an.n:-1, bv=bn?bn.n:-1; r = av-bv; }
      if(r===0) r = low(a.name).localeCompare(low(b.name));
      return r*sortDir;
    });
    return out;
  }
  function tagCount(t){
    var n = 0;
    for(var i=0;i<entries.length;i++){ var e=entries[i]; if(matchKind(e,kind) && hasTag(e,t)) n++; }
    return n;
  }

  function statusBadges(e){
    var s = "";
    if(e.brokenTag) s += '<span class="badge badge-alert">Broken</span>';
    if(e.deprecatedTag) s += '<span class="badge badge-warning">Deprecated</span>';
    if(e.workingTag) s += '<span class="badge badge-success">Working</span>';
    if(!e.brokenTag && !e.deprecatedTag && !e.workingTag) s += '<span class="badge badge-gray">Untagged</span>';
    return s;
  }
  function vtBadge(e){
    var v = vtNums(e), cls, txt;
    if(v){ cls = v.n>0 ? "badge-vt-bad" : "badge-vt-ok"; txt = "VT "+v.n+"/"+v.d; }
    else { var f = (e.flags==null)?"":String(e.flags); if(!f || f==="0/0") return ""; cls = "badge-gray"; txt = f; }
    if(e.permalink) return '<span class="badge '+cls+' link" data-copy="'+esc(e.permalink)+'" title="Copy VirusTotal link">'+esc(txt)+'</span>';
    return '<span class="badge '+cls+'">'+esc(txt)+'</span>';
  }
  function officialBadge(e){ return e.official ? '<span class="badge badge-official">Official</span>' : ""; }
  function langBadge(e){
    var lang = (e.lang==null)?"":String(e.lang);
    if(lang && lang.toLowerCase()!=="multi") return '<span class="badge badge-blue">'+esc(lang.toUpperCase())+'</span>';
    return "";
  }
  function starsBadge(e){
    if(typeof e.stars==="number" && e.stars>0) return '<span class="badge badge-stars">&#9733; '+e.stars+'</span>';
    return "";
  }
  function actionButtons(e){
    if(e.manifestURI) return '<button type="button" class="btn icon btn-primary-subtle" title="Copy install link" data-copy="'+esc(e.manifestURI)+'"><span class="ic">'+DL_SVG+'</span></button>';
    return "";
  }
  function card(e){
    var nm = e.name || e.id || "?";
    var initial = esc(String(nm).charAt(0).toUpperCase() || "?");
    var typeLabel = KINDLABEL[e.type] || e.type || "";
    var stateCls = e.brokenTag ? "is-broken" : (e.deprecatedTag ? "is-deprecated" : "");
    var iconImg = e.icon ? ('<img src="'+esc(e.icon)+'" alt="" crossorigin="anonymous" referrerpolicy="no-referrer">') : "";
    var typeSpan = typeLabel ? ('<span class="type">'+esc(typeLabel)+' - </span>') : "";
    var desc = e.description ? ('<p class="ext-desc" title="'+esc(e.description)+'">'+esc(e.description)+'</p>') : "";
    var badges = statusBadges(e) + vtBadge(e) + officialBadge(e) +
      (e.version ? '<span class="badge badge-gray">'+esc(e.version)+'</span>' : '') +
      (e.author ? '<span class="badge badge-unstyled">'+esc(e.author)+'</span>' : '') +
      langBadge(e) +
      (e.language ? '<span class="badge badge-muted">'+esc(cap(e.language))+'</span>' : '') +
      starsBadge(e);
    return '<div class="ext-card '+stateCls+'">'+
        '<div class="ext-card-decor"></div>'+
        '<div class="ext-actions">'+actionButtons(e)+'</div>'+
        '<div class="ext-content">'+
          '<div class="ext-header">'+
            '<div class="ext-icon"><div class="ext-icon-fallback">'+initial+'</div>'+iconImg+'</div>'+
            '<div class="ext-text"><p class="ext-name">'+esc(nm)+'</p><p class="ext-meta">'+typeSpan+'<span class="id">'+esc(e.id||"")+'</span></p></div>'+
          '</div>'+
          desc+
          '<div class="ext-badges">'+badges+'</div>'+
        '</div>'+
      '</div>';
  }

  function renderFilters(){
    var th = "";
    for(var i=0;i<TAGS.length;i++){ var t=TAGS[i][0]; th += '<button class="pill'+(tag===t?' on':'')+'" data-tag="'+t+'">'+esc(TAGS[i][1])+' '+tagCount(t)+'</button>'; }
    el("tagfilters").innerHTML = th;
    var kh = "";
    for(var j=0;j<KINDS.length;j++){ var k=KINDS[j][0]; kh += '<button class="pill k'+(kind===k?' on':'')+'" data-kind="'+k+'">'+esc(KINDS[j][1])+'</button>'; }
    el("kindfilters").innerHTML = kh;
    var sh = '<span class="slbl">Sort</span>';
    for(var s=0;s<SORTS.length;s++){ var sk=SORTS[s][0]; var arrow = (sortKey===sk)?(sortDir>0?" ▲":" ▼"):""; sh += '<button class="pill s'+(sortKey===sk?' on':'')+'" data-sort="'+sk+'">'+esc(SORTS[s][1])+arrow+'</button>'; }
    el("sortbar").innerHTML = sh;
  }
  function renderList(){
    var f = filtered();
    el("count").textContent = entries.length ? ("  ·  "+f.length+" of "+entries.length) : "";
    if(entries.length===0){
      el("list").innerHTML = '<div class="sea-empty">'+(statusMsg==="loading"?"Loading the marketplace…":(statusMsg?esc(statusMsg):"No data yet."))+'</div>';
      return;
    }
    if(f.length===0){ el("list").innerHTML = '<div class="sea-empty">Nothing matches this filter.</div>'; return; }
    var html = "";
    for(var i=0;i<f.length;i++) html += card(f[i]);
    el("list").innerHTML = html;
    var imgs = el("list").getElementsByTagName("img");
    for(var j=0;j<imgs.length;j++){ imgs[j].addEventListener("error", function(){ this.style.display="none"; }); }
  }
  function renderStatus(){
    var node = el("status");
    if(entries.length>0 && statusMsg && statusMsg!=="loading"){ node.style.display="block"; node.textContent = statusMsg; }
    else if(entries.length>0 && statusMsg==="loading"){ node.style.display="block"; node.textContent = "Refreshing…"; }
    else { node.style.display="none"; node.textContent=""; }
  }
  function render(){ renderFilters(); renderList(); renderStatus(); }

  document.addEventListener("click", function(ev){
    var t = ev.target;
    while(t && t!==document.body){
      if(t.getAttribute){
        var dt = t.getAttribute("data-tag"); if(dt!=null){ tag=dt; render(); return; }
        var dk = t.getAttribute("data-kind"); if(dk!=null){ kind=dk; render(); return; }
        var dsr = t.getAttribute("data-sort"); if(dsr!=null){ if(sortKey===dsr) sortDir=-sortDir; else { sortKey=dsr; sortDir=1; } render(); return; }
        var dc = t.getAttribute("data-copy"); if(dc!=null){ sendCopy(dc,t); return; }
        if(t.id==="refresh"){ doRefresh(); return; }
      }
      t = t.parentNode;
    }
  });
  el("search").addEventListener("input", function(ev){ q = low(ev.target.value); renderList(); });

  function sendCopy(url, btn){
    if(window.webview && window.webview.send) window.webview.send("copy", { url: url });
    if(!btn) return;
    if(btn.getAttribute("data-copied")) return;
    var oldHtml = btn.innerHTML, oldCls = btn.className;
    btn.setAttribute("data-copied","1");
    if(btn.tagName==="BUTTON"){
      btn.innerHTML = '<span class="ic">'+CK_SVG+'</span>';
      btn.className = oldCls.replace("btn-primary-subtle","btn-success-subtle").replace("btn-gray-subtle","btn-success-subtle");
    } else {
      btn.textContent = "Copied";
    }
    setTimeout(function(){ btn.innerHTML = oldHtml; btn.className = oldCls; btn.removeAttribute("data-copied"); }, 1200);
  }
  function doRefresh(){
    statusMsg = "loading"; renderStatus();
    if(window.webview && window.webview.send) window.webview.send("refresh", {});
  }

  function onEntries(arr){ entries = (arr && typeof arr.length==="number") ? arr : []; render(); }
  function onStatus(s){ statusMsg = s || ""; render(); }

  var tries = 0;
  function boot(){
    if(window.webview && window.webview.on && window.webview.send){
      window.webview.on("entries", onEntries);
      window.webview.on("status", onStatus);
      window.webview.send("ready", {});
      render();
    } else if(tries++ < 100){ setTimeout(boot, 50); }
  }
  render();
  boot();
})();
</script>
</body>
</html>`

        const webview = ctx.newWebview({
            slot: "screen",
            fullWidth: true,
            autoHeight: true,
            sidebar: { label: "SeaTags", icon: SIDEBAR_SVG },
        })
        webview.setContent(() => PAGE)
        webview.channel.sync("entries", entriesState)
        webview.channel.sync("status", statusState)
        webview.channel.on("ready", () => {
            try { webview.channel.send("entries", entriesState.get()) } catch (_e) {}
            try { webview.channel.send("status", statusState.get()) } catch (_e) {}
            void load(false)
        })
        webview.channel.on("refresh", () => { void load(true) })
        webview.channel.on("copy", (p: any) => {
            const url = p && p.url ? String(p.url) : ""
            if (!url) return
            try { ctx.dom.clipboard.write(url) } catch (_e) {}
            try { ctx.toast.success("Copied to clipboard") } catch (_e) {}
        })

        const tray = ctx.newTray({ iconUrl: ICON, withContent: true, width: "300px" })
        ctx.registerEventHandler("st-refresh", () => { void load(true) })
        ctx.registerEventHandler("st-open", () => {
            try { ctx.screen.navigateTo(webview.getScreenPath().replace(/-screen$/, "")) } catch (_e) {}
        })
        tray.render(() => {
            const es = entriesState.get()
            const items: any[] = []
            items.push(tray.flex({
                items: [
                    tray.text("SeaTags", { style: { fontWeight: "600", fontSize: "15px", color: "rgba(255,255,255,0.95)" } }),
                    tray.button({ label: statusState.get() === "loading" ? "Loading…" : "Refresh", onClick: "st-refresh", intent: "gray-subtle", size: "xs", style: { marginLeft: "auto" } }),
                ],
                gap: 2,
                style: { alignItems: "center" },
            }))
            if (es.length === 0) {
                items.push(tray.text(statusState.get() === "loading" ? "Loading the marketplace…" : (statusState.get() || "Open the page to load the tag list."), { style: { color: "rgba(255,255,255,0.6)", fontSize: "12px" } }))
            } else {
                let w = 0, b = 0, d = 0
                for (let i = 0; i < es.length; i++) { if (es[i].workingTag) w++; if (es[i].brokenTag) b++; if (es[i].deprecatedTag) d++ }
                items.push(tray.flex({
                    items: [
                        tray.badge({ text: "✓ " + w, intent: "success", size: "sm" }),
                        tray.badge({ text: "✗ " + b, intent: "alert", size: "sm" }),
                        tray.badge({ text: "⚠ " + d, intent: "warning", size: "sm" }),
                        tray.badge({ text: es.length + " total", intent: "gray", size: "sm" }),
                    ],
                    gap: 2,
                    style: { flexWrap: "wrap" },
                }))
            }
            items.push(tray.button({ label: "Open SeaTags ↗", onClick: "st-open", intent: "primary", size: "sm", style: { marginTop: "4px" } }))
            return tray.stack({ items: items, gap: 3 })
        })
        tray.onOpen(() => { void load(false) })

        ctx.setTimeout(() => { void load(false) }, 0)
    })
}
