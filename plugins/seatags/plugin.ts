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
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#0b0b0e;color:#e6e6ea;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px}
#app{max-width:1080px;margin:0 auto;padding:18px 18px 48px}
.head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.title{font-size:20px;font-weight:700}
.title .sub{font-size:13px;font-weight:500;color:#8b8b97;margin-left:6px}
.actions{margin-left:auto;display:flex;gap:8px;align-items:center}
#search{background:#16161c;border:1px solid #2a2a33;color:#e6e6ea;border-radius:8px;padding:8px 12px;width:280px;max-width:60vw;outline:none}
#search:focus{border-color:#5b6cff}
.btn{background:#5b6cff;border:none;color:#fff;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer}
.btn:hover{filter:brightness(1.1)}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.sortbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0 12px}
.slbl{color:#8b8b97;font-size:12px;margin-right:4px}
.pill{background:#16161c;border:1px solid #2a2a33;color:#c4c4cf;border-radius:999px;padding:5px 12px;font-size:12.5px;cursor:pointer;white-space:nowrap}
.pill:hover{border-color:#3a3a45}
.pill.on{background:#5b6cff;border-color:#5b6cff;color:#fff;font-weight:600}
.pill.k.on{background:#7a3cff;border-color:#7a3cff}
.pill.s.on{background:#2a2a33;border-color:#4a4a57;color:#fff}
.status{display:none;background:#2a1b1b;border:1px solid #5a2d2d;color:#f0b4b4;border-radius:8px;padding:8px 12px;margin-bottom:12px;font-size:13px}
.list{display:flex;flex-direction:column;gap:10px}
.card{background:#121218;border:1px solid #23232c;border-radius:12px;padding:12px 14px}
.card:hover{border-color:#33333f}
.crow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.badges{display:flex;gap:5px;flex-wrap:wrap}
.name{font-weight:650;font-size:15px;color:#f2f2f6}
.meta{color:#8b8b97;font-size:12.5px;margin-top:5px}
.desc{color:#b8b8c2;font-size:13px;margin-top:7px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.abtn{background:#1c1c24;border:1px solid #2e2e3a;color:#c4c4cf;border-radius:7px;padding:5px 10px;font-size:12px;cursor:pointer}
.abtn:hover{border-color:#5b6cff;color:#fff}
.abtn.done{border-color:#3ecf8e;color:#3ecf8e}
.badge{display:inline-block;border-radius:6px;padding:2px 7px;font-size:11px;font-weight:600;line-height:1.5}
.b-work{background:rgba(62,207,142,.15);color:#5fe0a6;border:1px solid rgba(62,207,142,.35)}
.b-broken{background:rgba(255,80,80,.15);color:#ff8585;border:1px solid rgba(255,80,80,.35)}
.b-dep{background:rgba(255,180,60,.15);color:#ffce80;border:1px solid rgba(255,180,60,.35)}
.b-untag{background:rgba(150,150,165,.12);color:#9a9aa6;border:1px solid rgba(150,150,165,.25)}
.b-official{background:rgba(91,108,255,.18);color:#aab3ff;border:1px solid rgba(91,108,255,.4)}
.b-vtok{background:rgba(62,207,142,.10);color:#5fe0a6;border:1px solid rgba(62,207,142,.25)}
.b-vtbad{background:rgba(255,80,80,.18);color:#ff8585;border:1px solid rgba(255,80,80,.45)}
.empty{color:#8b8b97;text-align:center;padding:48px 0;font-size:14px}
</style>
</head>
<body>
<div id="app">
  <div class="head">
    <div class="title">SeaTags<span class="sub" id="count"></span></div>
    <div class="actions">
      <input id="search" type="text" placeholder="Search name, author, description…" autocomplete="off">
      <button id="refresh" class="btn">Refresh</button>
    </div>
  </div>
  <div class="filters" id="tagfilters"></div>
  <div class="filters" id="kindfilters"></div>
  <div class="sortbar" id="sortbar"></div>
  <div class="status" id="status"></div>
  <div class="list" id="list"></div>
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
  var KINDLABEL = {"plugin":"Plugin","onlinestream-provider":"Streaming","manga-provider":"Manga","anime-torrent-provider":"Torrent","custom-source":"Custom"};
  var SORTS = [["name","Name"],["stars","Stars"],["flags","VirusTotal"],["type","Type"]];

  function el(id){ return document.getElementById(id); }
  function esc(s){ s = (s==null)?"":String(s); return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function low(s){ return (s==null?"":String(s)).toLowerCase(); }

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
    var m = f.match(/^(\d+)\s*\/\s*(\d+)$/);
    if(!m) return null;
    return { n: parseInt(m[1],10), d: parseInt(m[2],10) };
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

  function badge(text,cls){ return '<span class="badge '+cls+'">'+esc(text)+'</span>'; }
  function statusBadges(e){
    var s = "";
    if(e.brokenTag) s += badge("Broken","b-broken");
    if(e.deprecatedTag) s += badge("Deprecated","b-dep");
    if(e.workingTag) s += badge("Working","b-work");
    if(!e.brokenTag && !e.deprecatedTag && !e.workingTag) s += badge("Untagged","b-untag");
    if(e.official) s += badge("Official","b-official");
    return s;
  }
  function vtBadge(e){
    var v = vtNums(e);
    if(v) return badge("VT "+v.n+"/"+v.d, v.n>0?"b-vtbad":"b-vtok");
    var f = (e.flags==null)?"":String(e.flags);
    if(f && f!=="0/0") return badge(f,"b-untag");
    return "";
  }
  function card(e){
    var meta = [];
    meta.push(KINDLABEL[e.type]||e.type||"?");
    if(e.author) meta.push("by "+e.author);
    if(e.version) meta.push("v"+e.version);
    if(typeof e.stars==="number" && e.stars>0) meta.push("★ "+e.stars);
    var acts = "";
    if(e.manifestURI) acts += '<button class="abtn" data-copy="'+esc(e.manifestURI)+'">Copy install link</button>';
    if(e.permalink) acts += '<button class="abtn" data-copy="'+esc(e.permalink)+'">Copy VirusTotal</button>';
    if(e.website) acts += '<button class="abtn" data-copy="'+esc(e.website)+'">Copy website</button>';
    return '<div class="card">'+
        '<div class="crow"><div class="badges">'+statusBadges(e)+vtBadge(e)+'</div><div class="name">'+esc(e.name||e.id||"?")+'</div></div>'+
        '<div class="meta">'+esc(meta.join("   ·   "))+'</div>'+
        (e.description ? '<div class="desc">'+esc(e.description)+'</div>' : '')+
        (acts ? '<div class="acts">'+acts+'</div>' : '')+
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
      el("list").innerHTML = '<div class="empty">'+(statusMsg==="loading"?"Loading the marketplace…":(statusMsg?esc(statusMsg):"No data yet."))+'</div>';
      return;
    }
    if(f.length===0){ el("list").innerHTML = '<div class="empty">Nothing matches this filter.</div>'; return; }
    var html = "";
    for(var i=0;i<f.length;i++) html += card(f[i]);
    el("list").innerHTML = html;
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
    if(btn){ var old = btn.textContent; btn.textContent = "Copied ✓"; btn.className = btn.className+" done"; setTimeout(function(){ btn.textContent = old; btn.className = btn.className.replace(/ ?done/,""); }, 1200); }
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
            try { ctx.screen.navigateTo(webview.getScreenPath()) } catch (_e) {}
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
