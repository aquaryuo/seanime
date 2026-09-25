import fs from "fs"
import { execFileSync } from "child_process"

const FIELDS = ["id", "name", "version", "description", "author", "type", "language", "lang", "icon", "website", "manifestURI"]
const ROOTS = ["extensions", "plugins"]

function entryFrom(manifest) {
    const out = {}
    for (const f of FIELDS) if (manifest[f] !== undefined) out[f] = manifest[f]
    return out
}

function stagedOrHead(p) {
    try {
        return execFileSync("git", ["show", `:${p}`], { encoding: "utf8" })
    } catch {
        return fs.readFileSync(p, "utf8")
    }
}

function localManifests() {
    const out = []
    for (const root of ROOTS) {
        if (!fs.existsSync(root)) continue
        for (const name of fs.readdirSync(root).sort()) {
            const p = `${root}/${name}/manifest.json`
            if (!fs.existsSync(p)) continue
            try {
                out.push(JSON.parse(stagedOrHead(p)))
            } catch {}
        }
    }
    return out
}

const entries = localManifests().map(entryFrom).filter((e) => e.id)

const json = JSON.stringify(entries, null, 2) + "\n"
if (process.argv.includes("--check")) {
    const current = fs.existsSync("marketplace.json") ? fs.readFileSync("marketplace.json", "utf8") : ""
    if (current !== json) {
        console.error("marketplace.json is out of date — run: node tools/gen-marketplace.mjs")
        process.exit(1)
    }
    console.log(`marketplace.json matches ${entries.length} manifests`)
} else {
    fs.writeFileSync("marketplace.json", json)
    console.log(`wrote ${entries.length} entries`)
}
