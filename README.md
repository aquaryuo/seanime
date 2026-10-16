Some utilities that *might** help me; I don't know about whoever reads this, though.

> A file describing the repo has to be the most useless part of the space since its' birth, Idk why am I bothering writing this.

Since you're here anyway: these are the released [Seanime](https://seanime.rahim.app) extensions. Unreleased ones are on the `gate` branch, retired ones on `archive`. Add this as a marketplace URL in Seanime's settings:

`https://raw.githubusercontent.com/aquaryuo/seanime/main/marketplace.json`

| payload | kind | what it is |
| --- | --- | --- |
| `anikoto` | onlinestream provider | anikototv.to |
| `anizone` | onlinestream provider | anizone.to |
| `kickassanime` | onlinestream provider | kaa.lt |
| `mkissa` | onlinestream provider | mkissa.to; episode links stop behind a captcha after a few lookups from one IP, which `extensions/mkissa/captcha-relay.mjs` lets you clear from a browser tab |
