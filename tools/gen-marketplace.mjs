import fs from "fs"
import { manifests } from "./bump.mjs"

const FIELDS = ["id", "name", "version", "description", "author", "type", "language", "lang", "icon", "website", "manifestURI"]

const list = manifests().map((f) => JSON.parse(fs.readFileSync(f, "utf8")))
const json = JSON.stringify(list, FIELDS, 2) + "\n"
if (process.argv.includes("--check")) {
    const current = fs.existsSync("marketplace.json") ? fs.readFileSync("marketplace.json", "utf8").replace(/\r\n/g, "\n") : ""
    if (current !== json) {
        console.error("marketplace.json is out of date — run: node tools/gen-marketplace.mjs")
        process.exit(1)
    }
    console.log(`marketplace.json matches ${list.length} manifests`)
} else {
    fs.writeFileSync("marketplace.json", json)
    console.log(`wrote ${list.length} entries`)
}
