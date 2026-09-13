Some utilities that *might** help me; I don't know about whoever reads this, though.

> A file describing the repo has to be the most useless part of the space since its' birth, Idk why am I bothering writing this.

Since you're here anyway: these are [Seanime](https://seanime.rahim.app) extensions and plugins. Add one of these as a marketplace URL in Seanime's settings.

| channel | URL | who it's for |
| --- | --- | --- |
| stable | `https://raw.githubusercontent.com/aquaryuo/seanime/main/marketplace.json` | anyone |
| beta | `https://raw.githubusercontent.com/aquaryuo/seanime/beta/marketplace.json` | people who don't mind things breaking |

The beta list is a superset — it carries the stable entries too, so you only ever need one URL.

| payload | kind | channels | what it is |
| --- | --- | --- | --- |
| `anikoto` | onlinestream provider | stable + beta | anikototv.to |
| `anizone` | onlinestream provider | stable + beta | anizone.to |
| `animelok` | onlinestream provider | beta only | animelok.live |
| `animepahe` | onlinestream provider | beta only | animepahe; needs the solver below |
| `aquatils` | plugin | stable + beta | downloads and supervises a Cloudflare solver, and surfaces errors other extensions report |
| `aquaprefs` | plugin | stable + beta | remembers player options |
| `seatags` | plugin | stable + beta | tags marketplace cards and adds filters |

One thing worth knowing before you install `aquatils`: in its default mode it downloads a solver binary from GitHub into its own cache directory and runs it, and it asks for shell execution and broad network access to do that. The archive is checked against the digest published with the release — but if no digest is published, or no hash tool is available on the machine, that check is skipped and the install continues. Its own [README](plugins/aquatils/README.md) explains the rest, including the Remote mode that downloads and runs nothing.
