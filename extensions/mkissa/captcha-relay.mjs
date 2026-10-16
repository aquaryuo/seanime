// Captcha relay for the MKissa extension. Run `node captcha-relay.mjs [port]` on the machine Seanime runs on,
// keep http://127.0.0.1:8192/ open in a normal browser there (same public IP), and put that address in the extension settings.
// The page embeds mkissa's own captcha page; each solved check is handed to the extension once, within the token's lifetime.
import http from "http"

const port = Number(process.argv[2]) || 8192
const ttl = 270000
let held = null
let renew = false

const page = `<!doctype html><meta charset="utf-8"><title>MKissa captcha relay</title>
<body style="font:14px system-ui;margin:2em"><p id="s">Waiting for the check.</p>
<iframe id="f" src="https://api.mkissa.net/captcha/turnstile" style="width:340px;height:160px;border:0"></iframe>
<script>
addEventListener("message", (e) => {
  if (e.origin !== "https://api.mkissa.net" || !e.data || e.data.type !== "sitea-captcha-ready") return
  fetch("/token", { method: "POST", body: JSON.stringify({ token: e.data.token, provider: e.data.provider }) })
  s.textContent = "Check passed " + new Date().toLocaleTimeString() + ", ready for MKissa."
})
setInterval(async () => {
  if (!(await (await fetch("/state")).json()).renew) return
  f.src = f.src
  s.textContent = "MKissa asked for a check: complete it if one shows."
}, 3000)
</script>`

http.createServer((req, res) => {
  const json = (code, v) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(v))
  const fresh = held && Date.now() - held.at < ttl
  if (req.method === "GET" && req.url === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page)
  if (req.method === "GET" && req.url === "/state") {
    json(200, { renew })
    renew = false
    return
  }
  if (req.method === "POST" && req.url === "/token") {
    let body = ""
    req.on("data", (c) => (body += c)).on("end", () => {
      try {
        const j = JSON.parse(body)
        if (typeof j.token === "string" && j.token) held = { token: j.token, provider: j.provider || "turnstile", at: Date.now() }
      } catch {}
      json(200, {})
    })
    return
  }
  if (req.method === "GET" && req.url === "/token") {
    renew = true
    if (!fresh) return json(404, { error: `no solved check - open http://127.0.0.1:${port}/ and complete it` })
    const { token, provider } = held
    held = null
    return json(200, { token, provider })
  }
  json(404, {})
}).listen(port, "127.0.0.1", () => console.log(`captcha relay: open http://127.0.0.1:${port}/ in a browser and keep it open`))
