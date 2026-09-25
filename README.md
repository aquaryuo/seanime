Some utilities that *might** help me; I don't know about whoever reads this, though.

> A file describing the repo has to be the most useless part of the space since its' birth, Idk why am I bothering writing this.

Since you're here anyway: these are [Seanime](https://seanime.rahim.app) extensions and plugins. Add this as a marketplace URL in Seanime's settings:

`https://raw.githubusercontent.com/aquaryuo/seanime/main/marketplace.json`

`animepahe` needs the `aquatils` solver plugin running to load anything at all.

| payload | kind | what it is |
| --- | --- | --- |
| `anikoto` | onlinestream provider | anikototv.to |
| `anizone` | onlinestream provider | anizone.to |
| `animelok` | onlinestream provider | animelok.live |
| `animepahe` | onlinestream provider | animepahe; cannot load anything without the solver below |
| `aquatils` | plugin | downloads and supervises a Cloudflare solver, and surfaces errors other extensions report |
| `seatags` | plugin | tags marketplace cards and adds filters |

One thing worth knowing before you install `aquatils`: in its default mode it downloads a solver binary from GitHub into its own cache directory and runs it, and it asks for shell execution and broad network access to do that. Before anything runs, the archive is checked against the SHA-256 digest published with the same release; if that digest can't be fetched or the hash can't be computed, the download is discarded instead of run. The Chromium it downloads for the hardest challenges (on by default on Linux and macOS) comes from Google's Chrome for Testing bucket, which publishes no digest, so that download is checked only by HTTPS and its exact URL. Its own [README](plugins/aquatils/README.md) explains the rest, including the Remote mode that downloads and runs nothing.
