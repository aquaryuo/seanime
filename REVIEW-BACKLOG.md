# Review and remediation plan — `aquaryuo/seanime`

## 1. Honest assessment

The repo is well-built for what it is: seven standalone payloads, no build step, one maintainer, a real error-reporting channel, and code that mostly degrades rather than crashes. It is also carrying a class of defect it has almost no defence against — **silent wrong answers**. Search returns the wrong season, a subtitle menu offers nine languages that all serve one file, a plugin's only feature is disabled by a single `=== true` against a Go pointer, an episode list truncates and is then cached by the host for 24 hours. None of these throw, so none of them reach the SEHERRv1 channel the operator built to see failures, and the fixture suite asserts loose title substrings that a wrong-season match satisfies. Compounding that, the delivery path is unreliable: payload commits have shipped without a manifest version bump 13 times across history, so a fix can be committed, reviewed, and never reach a single installed user. The typecheck workflow is new, is not on `main`, and does not check the thing that actually kills a payload. The individual code quality is fine; the gaps are in *verification* and *delivery*, and those are the two areas where one more hour of work buys the most.

Confidence labels below: findings marked **[unverified]** came from a completeness pass and were not put through the refutation stage — confirm the evidence before spending effort on them.

---

## 2. THE PLAN

Batches are ordered by value per unit of effort. **Batch C (delivery) gates every other batch** — a fix that does not reach users is worth nothing — so do at least `version-bump-gate` and `push-beta` before or alongside Batch A.

---

## Batch A — wrong answers in search and matching

The provider hands Seanime a confidently wrong entity. No error, no telemetry, no way for the user to tell.

### `anizone-search-parser-dead` — AniZone search matches a page shape the site no longer serves
**Sev** critical **[unverified]** · **Component** anizone · **File** extensions/anizone/provider.ts:307,313
**What** `parseCards` finds cards via `anmTitles: JSON.parse('…')` and `href="https://host/anime/<slug>"`. The live search page emits a single Alpine `items: JSON.parse('[{"slug":…,"url":"http:\\/\\/…","main_title":…,"title_list":{…}}]')` blob instead. Zero blocks parsed → `pickBest([])` → `[]`, and because `anyOk` is true the `fail()` at :38 never fires.
**Why** If it reproduces, both channels' AniZone search returns "no results" for every title with nothing in the error pane. `findEpisodes` still works, so the break is confined to search — the first thing every user hits.
**Fix** Parse the `items:` blob as the single source of truth (slug + `main_title` + `title_list`), which also deletes the byte-offset title/href pairing hack at :318-323. Separately: a 200 that is the site but yields zero *card nodes* across every query is a parser-shape failure, not "no such anime" — raise `fail("search", …)` so it lands in telemetry.
**Effort** hours · **Risk** low · **Verify first**: fetch `/anime?search=one%20piece` with the provider's headers and count matches for both regexes.

### `anizone-rank-on-card-metadata` — score on all titles and the card badges, not one display string
**Sev** high · **Component** anizone · **File** extensions/anizone/provider.ts:42-56,68-79,95-128,371-379
**What** Three findings, one root cause. (a) `parseCards` collapses a card's ~11 localized titles to one display string via `bestTitle`, so every later decision sees only that string. (b) `matchTargets` pushes `t.split(/[:,;~]/)[0]` as a *full-weight* target, so the bare parent series scores 1.0 for any "X: Subtitle" media. (c) `disambiguate` infers a candidate's year by regexing the *display* title rather than reading the card's year badge.
**Why** Verified: AniList 171627 (Chainsaw Man – The Movie: Reze Arc, MOVIE, 1 ep) resolves to the 12-episode TV series and `pickBest`'s high-confidence gate returns only that, discarding the movie. AniList 210 (Ranma ½, 1989) resolves to the 2025 remake S2. Both channels; hits most modern sequels and films.
**Fix** Keep `titles: string[]` on the internal candidate and take the max score over all of them (`bestTitle` then only picks the human-readable label). Parse the card badge — the live markup carries `<span>Movie</span> • <span>2025</span> • <span>1 Eps</span>` under a stable `wire:key="a-<sid>"` anchor — and attach `{type, year, eps}`. Exclude only when `media.format` is explicitly non-TV (upstream sets `Format: "TV"` when unknown, so never exclude on `format === "TV"`). Treat year as a soft rank (`|cardYear − mediaYear| ≤ 1` preferred), never a hard filter that can empty the set.
**Effort** hours · **Risk** low · **Note** fixing (a) alone already makes the CSM movie tie the TV entry, which drops the 0.12 gate and hands both to the host — strictly better even before the badge parse lands.

### `anikoto-season-evidence` — give the season/part decision real evidence
**Sev** high · **Component** anikoto · **File** extensions/anikoto/provider.ts:141,175-218,289-322
**What** For a media whose season marker is a word, `buildSmartSearchTitles` returns `season = -1`, so `filterBySeason`'s `if (season < 2 && part < 2) return pool` skips filtering; `dominantMatch` then declines (top 0.828 < 0.85) and the whole same-show pool is returned. The host's chooser has no distance threshold and compares against AniList synonyms, so it picks the wrong season.
**Why** Verified end to end: AniList 110277 (Final Season, 16 eps) resolves to "Attack on Titan Season 3" (22 eps). Masked today because `findEpisodes` short-circuits on the metadata backend — the moment that path is unavailable (see `anikoto-resolvedown`) the user gets Season 3's episode list. Both channels.
**Fix** Score on facts already on the card. In `parseSearchInto` also read `.ep-status.total` and the format label, and in disambiguation: exact episode-count match is a strong positive **guarded on `media.episodeCount > 0`** (upstream returns −1 for airing/unknown); a missing `.ep-status.total` means "no signal", not a mismatch (23 of 30 cards carried it on one live page); drop candidates whose card format is a different bucket. Return the single winner, never a pool.
**Effort** hours · **Risk** medium

### `anikoto-manual-mapping-loses-id` — stop smuggling the AniList id through the search-result id
**Sev** high · **Component** anikoto · **File** extensions/anikoto/provider.ts:320,360-363,833,856-858,992-995
**What** The AniList id reaches `findEpisodes` only as a `$al<id>` suffix on the result id. Upstream's manual-search path passes a zero `Media`, so `withMeta` omits the suffix and the suffix-less id is what `ManualMapping` persists. From then on `anilistId === 0` forever: no fast path, no renumbering, and `buildSubtitles` emits raw CDN track URLs.
**Why** Any user who manually maps an anikoto series permanently loses metadata enrichment and falls back to the raw-scrape path — the one with the wrong-season bug above. Both channels.
**Fix** Cache `anikoto:al:<seriesUrl> → anilistId` in `$store` whenever the automatic path knows it, and have `splitMeta` fall back to that lookup. `$store` is process-lifetime, so this converts a permanent degradation into a per-process one. The durable fix is a backend route keyed on the series slug, which lands outside this repo. **Open question**: whether the host applies `EpisodeServer.headers` to subtitle track requests — if it does, the raw URLs still work and only the metadata loss remains. Settle that before sizing the subtitle half.
**Effort** hours · **Risk** low · **Depends** none

### `anikoto-layout-change-invisible` — a markup change looks identical to "no such anime"
**Sev** medium · **Component** anikoto · **File** extensions/anikoto/provider.ts:124-141
**What** `anyOk` means only "a 200 that still looks like the site". If the card selectors stop matching, `results` is empty, the `if (anyOk)` branch runs, `rememberBase(base)` pins the now-useless mirror, and an empty array is returned with no throw and no report.
**Why** This is the failure a scraping project most needs to detect and it produces the least signal: every user, every title, at once, with an empty error pane. (Selectors are fine today — `div.item` ×40, `a.name.d-title` ×40 — so this is about the next redesign.)
**Fix** Have `parseSearchInto` return the count of card *nodes* seen, not accepted. Site page + non-empty query + zero card nodes across every query and mirror ⇒ `reportError("search", "no cards parsed — site layout may have changed")` and skip `rememberBase`. Same shape for the episode-list parse at :431.
**Effort** minutes · **Risk** low

### `anikoto-empty-pool-fallback` — the same-show gate falls back to the raw pool unbounded
**Sev** low · **Component** anikoto · **File** extensions/anikoto/provider.ts:160-177
**What** `const pool = show.length > 0 ? show : results` — if the base-title gate rejects everything, the unfiltered, noisy site results are returned.
**Why** Converts "no match" into "confidently wrong match". But the fallback also does real work: on the one live case found, it produced the *correct* parent entry ("Love Stage!!") that the gate had rejected, so returning `[]` (and a 0.5 similarity floor) would regress a working match.
**Fix** Keep the fallback, bound it: require containment (one normalized base title is a substring/prefix of the other) or a floor computed against the shorter string.
**Effort** minutes · **Risk** low

### `animelok-anilist-only-search` — manual matching is a dead end
**Sev** low · **Component** animelok · **File** extensions/animelok/provider.ts:17-19,220-227
**What** `search` needs a numeric AniList id; the fallback only accepts an anilist.co URL or a bare digit string. Manual mapping passes a zero Media and a *title*.
**Why** The error text says "anime not found, try manual matching" and manual matching cannot work. Beta only.
**Fix** When `opts.media.id` is absent **and** the query is non-empty and non-numeric, `throw this.fail("search", "animelok matches by AniList id; paste the anilist.co URL or its numeric id")`. Do not throw on an empty query — that would turn every ordinary no-match into a red error.
**Effort** minutes · **Risk** low

**Nits (Batch A):** `anikoto` `subOrDub` defaults to `"sub"` when neither badge parses — report once per search only when a whole page yields zero `.ep-status` nodes (per-card inference misfires). · `animepahe` search-result `subOrDub` asserts `"dub"` from the request, not the data — use `"both"` as anizone does. · `anizone` `if (!q || results.length >= 12) continue` should be `break` for the cap (becomes load-bearing once a budget is added). · `anizone` six dedup maps are bare `{}` so `seen["constructor"]` is pre-truthy — prefix keys.

---

## Batch B — wrong answers in playback and subtitles

### `aquaprefs-go-bool` — `useLibassRenderer === true` can never be true
**Sev** high · **Component** aquaprefs · **File** plugins/aquaprefs/plugin.ts:271-272
**What** `getCurrentPlaybackInfo()` returns a live Go struct via `vm.ToValue`; `UseLibassRenderer` is a `*bool`, so it arrives as a wrapper object. `=== true` is always false. Every track is classified `kind:"cap"` with a raw array index and routed to `setMediaCaptionTrack`, which the host discards for online streams.
**Why** This is the plugin's only feature, and it is off for everyone on the default configuration, on both channels, silently.
**Fix** `String(x) === "true"` (verified correct for true / pointer-to-false / nil). **`!!x` is wrong** — it is true for a pointer to false. Because the server defaults the pointer to true and never sets it false, once this is fixed **every** track is libass and the whole `cap` domain becomes dead — delete it rather than normalise it, which also retires `aquaprefs-caption-index` and `aquaprefs-caption-event` below.
**Effort** minutes · **Risk** low

### `anikoto-subtitle-languages-collapse` — nine language entries, one English file
**Sev** high · **Component** anikoto · **File** extensions/anikoto/provider.ts:856-864
**What** Every track is rewritten to `/s/{anilistId}/{ep}/{slot}.{ext}?src=…&t=…&ref=…`. The backend ignores `src` and returns one canonical track per (anilistId, episode). Verified on a cold episode requesting the last track first: all nine proxied URLs return byte-identical English content while the nine underlying source files differ.
**Why** Any non-English viewer picks their language, the track switches, the text does not. Both channels. It also invalidates the `minSubtitles` fixtures, which count tracks rather than verifying they differ.
**Fix** **Interim, in this repo:** emit exactly one proxied entry (the picked track) and leave the rest as raw `t.file` URLs — verified the CDN serves 200 for every track with the video's Referer, and the host applies the video source's headers to subtitle URLs through its proxy, so they will play the right language. **Do not** put a source hash in the path yet: the backend 404s any (anime, ep) key it does not hold, so that change turns every subtitle into "not available" until the backend ships the matching change. The real fix — key the store on source identity — lands in the metadata backend.
**Effort** hours · **Risk** medium · **Depends** blocks `anikoto-subtitle-path-key`

### `anikoto-subtitle-path-key` — the proxy key omits audio track and source identity
**Sev** medium · **Component** anikoto · **File** extensions/anikoto/provider.ts:828-830,853-857
**What** The path is (anilistId, episode, language-slot) where the slot's `-{idx}` disambiguator is the *position* in the collected array. Nothing about sub-vs-dub, nothing about which server produced the set.
**Why** Latent today (the backend ignores `src` anyway). Bites the moment the backend honours source identity: a path-keyed cache anywhere in the chain serves one audio track's subtitles for the other, and any track reordering shifts every slot.
**Fix** `/s/{anilistId}/{ep}/{audio}/{hash8(t.file)}.vtt` — stable, unique per file, immune to reordering; keep the human language in the `language` field. Must not ship before the backend understands the new key.
**Effort** hours · **Risk** low · **Depends** `anikoto-subtitle-languages-collapse`

### `anikoto-episode-servers-list` — the advertised server list is wrong and costs 3× the work
**Sev** medium · **Component** anikoto · **File** extensions/anikoto/provider.ts:95-100,498-501
**What** `episodeServers: ["Auto", "VidPlay-1", "HD-1"]`. Across 10 titles × 2 episodes the site only ever exposed two names, and "VidPlay-1" was never one of them. Upstream calls `FindEpisodeServer` **once per advertised name**, discarding each error, so every episode load runs the chain three times (three fresh Provider instances) and writes a guaranteed-false error line into the operator's own channel. `KNOWN_SERVERS`' sub/dub ordering branch is dead for the same reason, and the two real servers resolve to the identical master playlist.
**Why** 3× the requests to a rate-limited site per episode load, plus a recurring false error, plus the user's messages from this path never reaching the player anyway (the host discards per-server errors). All merged from three separate findings — same two lines.
**Fix** `episodeServers: ["Auto"]`, and collapse `KNOWN_SERVERS` to `["HD-1", "Vidstream-2"]` with no branch (keep the allow-list; a deny-list would let an unknown slow server extend the hang). Route real reasons through SEHERRv1, which is the only channel that survives the host's error handling. Add a fixture assertion that advertised names are a subset of what `collectServers` finds.
**Effort** minutes · **Risk** low

### `anizone-dub-selects-nothing` — "Dub" passes a gate and then plays Japanese
**Sev** medium · **Component** anizone · **File** extensions/anizone/provider.ts:237-249,506-520
**What** For `audio === "dub"` the provider only checks the master playlist *mentions* an English rendition, then returns the identical master URL. The master marks Japanese `DEFAULT=YES`.
**Why** The user picks Dub and gets Japanese with no indication anything failed — worse than "no dub available", because it looks like it worked. `supportsDub: true` sets the expectation.
**Fix** A provider cannot override an HLS DEFAULT flag. **The two obvious labels do not work**: `VideoSource.label` is only forwarded when there is more than one source (anizone returns one), and folding it into `quality` can get the source filtered out entirely by the host's default-quality filter. Workable options: emit a second `videoSource` with the same URL and a distinct label purely to flip the host's multi-source path, or leave the stream alone and document that Dub here means "an English track exists, switch it in the player". The durable fix is upstream: an `EpisodeServer`-declared preferred audio language applied at `MANIFEST_PARSED` / passed as `--alang`.
**Effort** hours · **Risk** low

### `anikoto-meta-remap-numbering` — decide the site's numbering once, by set overlap
**Sev** medium · **Component** anikoto · **File** extensions/anikoto/provider.ts:449-479
**What** `perPart = episodes.length < maxTarget` guesses whether the page is a part page from a length comparison; when false the per-key lookup prefers `m.ep` and silently falls back to `m.abs`. `map[k]` is dereferenced without a null check at :455 and :463, and a JSON `null` there throws into the bare catch at :479.
**Why** Misfires on a part page with continuous numbering (site 13..24, keys 1..12): every lookup misses, the remap is discarded by the coverage guard, and the user gets episodes 13..24 for a media the player thinks has 1..12 — nothing plays. Reasoned failure mode; no live series found in this state.
**Fix** Before the loop, build the site-number set and the `m.ep` / `m.abs` sets, and pick whichever has the larger intersection (ties to `ep`). Apply that one choice to every key — removes `perPart` and the per-key cascade. Guard `map[k]`, and `reportError` when the remap is discarded.
**Effort** hours · **Risk** medium

### `anikoto-subtitle-episode-number` — the proxy episode number is assumed, not asserted
**Sev** low · **Component** anikoto · **File** extensions/anikoto/provider.ts:493,828-829
**What** `ctx.episode = episode.number` becomes the `{ep}` path segment, but that is only an AniList episode number if the `/meta` remap actually fired (it is gated twice).
**Why** A wildly wrong number 404s harmlessly; an **off-by-one silently serves a neighbouring episode's subtitles**, which is the bad case — confidently out of sync with no signal.
**Fix** Carry a flag through the id when `findEpisodes` did not remap, and fall back to raw `t.file` subtitle URLs in that case. Note a path-key change alone does *not* fix this while the backend indexes by (anilistId, episode).
**Effort** hours · **Risk** medium · **Depends** `anikoto-meta-remap-numbering`

### `animelok-subtitle-default-and-dedup` — English detection cannot fire for label-only tracks
**Sev** medium · **Component** animelok · **File** extensions/animelok/provider.ts:85-106
**What** `lang = (t.lang || t.label || "en").toLowerCase().split("-")[0]` yields `"english"` for a label-only track, but the default-picker compares `lang === "en"`. Separately `if (seen[lang]) continue` dedupes on that key. The two are **mutually exclusive**, not cumulative: with `lang:"en"` the default works and the dedup collapses variants; with labels only, the keys differ so the dedup mostly does not bite but `englishIdx` never fires. There is no content scoring at all (anikoto and anizone both carry a four-function ladder).
**Why** Playback starts on an arbitrary language, or a forced/signs track becomes the only English entry and the default. Beta only.
**Fix** Copy anizone's `fallbackCode` / `isNonDialogue` / `isMachine` / `isAltDialogue` / `trackScore` verbatim, match on the normalised code, and dedupe on **URL**, not language.
**Effort** hours · **Risk** low

### `anikoto-fallbackcode-defaults-english` — unknown language is not English
**Sev** low · **Component** anikoto · **File** extensions/anikoto/provider.ts:945-977,899-902
**What** `fallbackCode` ends in `return "en"`, so any English-named language absent from the 30-entry map ("Filipino", "Hebrew", "Danish", "Norwegian", "Hungarian", "Finnish") resolves to English and gets `trackScore`'s base 6 instead of 2. Only reachable when the language endpoint is unreachable (it is not negatively cached, so it self-heals).
**Fix** Return `""` and treat unknown as unknown — `isEnglish` becomes false, the slot falls back to `"und"`, `langName("")` yields the raw label. Adding more prefixes is a bonus; not defaulting to English is the point.
**Effort** minutes · **Risk** low

### `extof-dead-extension` — the proxy only serves `.vtt`
**Sev** low · **Component** anikoto · **File** extensions/anikoto/provider.ts:796-801,857
**What** `extOf` interpolates `"ass"`/`"srt"` into the proxy path. `.ass` returns a hard 502; `.srt` returns 200 with a WebVTT body under a SubRip content type, which the player will fail to parse.
**Why** Latent (every observed track is `.vtt`), but a dead track still counts toward `vs.subtitles.length > 0`, so Auto stops on a server whose subtitles do not load.
**Fix** Delete `extOf`, hard-code `.vtt`. The proxy is a normaliser; echoing the upstream container into the path is a category error.
**Effort** minutes · **Risk** low

### `aquaprefs-caption-event-dead` — `video-media-caption-track` is never emitted
**Sev** low · **Component** aquaprefs · **File** plugins/aquaprefs/plugin.ts:473-478
**What** The event is declared in the vendored d.ts but the host's videocore→player translation switch has no case for it, so it never becomes a player event. `curTrack.cap` stays at −999 forever.
**Why** One blind `setMediaCaptionTrack` per load. `sendGetMediaCaptionTrack()` is **not** an alternative — it and its five siblings are empty stubs upstream.
**Fix** Delete the listener with the `cap` domain (see `aquaprefs-go-bool`). File the upstream d.ts/adapter gap.
**Effort** minutes · **Risk** low · **Depends** `aquaprefs-go-bool`

### `aquaprefs-caption-index` — caption tracks indexed by raw array position
**Sev** nit · **Component** aquaprefs · **File** plugins/aquaprefs/plugin.ts:272
Latent mismatch (host indexes captions by position within the *non-libass* subset). Unreachable because no track the plugin can see is ever non-libass. Deleted along with the `cap` domain.

### `aquaprefs-vs-native-preference` — the plugin overwrites Seanime's own per-media preference
**Sev** medium · **Component** aquaprefs · **File** plugins/aquaprefs/plugin.ts:227-232,244-248,329-350,464-466
**What** Seanime already stores a per-media onlinestream subtitle preference and applies it. aquaprefs arms on `video-loaded` and enforces one global record over the same player for up to 8 s / 8 retries.
**Why** Native behaviour is per-series; the plugin converts it to global, so the user's per-series choice appears forgotten and the plugin is what forgot it. The two systems also write different records from the same click.
**Fix** Skip enforcement entirely when `pinfo().onlinestreamParams` is present — the host does this better per-media — and let aquaprefs own local/MKV playback where nothing else remembers anything. That removes code. Then fix the manifest wording (see `aquaprefs-scope`).
**Effort** hours · **Risk** medium

### `aquaprefs-track-match-key` — no stable key to match a subtitle track on
**Sev** medium **[unverified]** · **Component** cross · **File** plugins/aquaprefs/plugin.ts:289-303; anikoto:862; anizone:453-461,476; animelok:98
**What** `VideoSubtitle` exposes only `language`, and the three providers fill it three different ways (raw site label / `"English - Group"` / `t.label || t.lang`). aquaprefs' label-key and language-key fallbacks are therefore the same string for an online stream.
**Why** The remembered preference silently fails to apply whenever the label text differs by one character between episodes — a different release group, a `[CC]` suffix, or switching provider for the same show.
**Fix** Make `VideoSubtitle.id` a contract: `"<iso639-1>-<idx>"` in every provider (they already compute the code), and have aquaprefs match on the leading ISO code with the label only as a tiebreaker.
**Effort** hours · **Risk** medium

**Nits (Batch B):** anikoto `language` carries raw site artifacts ("English (- (Crunchyroll))") — three `.replace()` calls; it is also written into the track's `language` attribute, so saved preferences are keyed on a scraped string. · anikoto's dub-vs-sub guard fails open on an unrecognised embed URL; add the symmetric sub check, but do **not** report on empty — hardsub candidates legitimately yield empty and would spam telemetry. · anikoto's `hs:` server-label parser is unreachable; drop it and keep hardsub as an Auto-only last resort. · Auto probes playability, the manual path does not; running `isPlayable(resolved, false)` on both makes the picker's entries mean the same thing and lets the duplicated clearance decoration at :541-542 go. · animepahe returns `server: "animepahe"`, a name it never advertised — echo `"Auto"` like its siblings.

---

## Batch C — delivery: making a fix reach the user

Do `version-bump-gate` and `push-beta` **first**. Everything else in this document is theoretical until they are done.

### `push-beta` — local `beta` is 4 commits ahead of origin
**Sev** critical **[unverified]** · **Component** delivery
**What** `git rev-list --left-right --count origin/beta...beta` → `0 4`. The unpushed commits add the typecheck workflow and `.gitignore`, the state-dir fix, download verification plus the host-mode fix and poll singleflight, and the incremental log parse. Six of seven live payloads are byte-identical to the worktree; `aquatils/plugin.ts` differs by ~292 lines. The live manifest already advertises the same version string the local tree carries.
**Why** Users are running the older aquatils payload, and after a push they will keep running it until the version changes. `.github/` and `.gitignore` do not exist on origin at all — which is the actual reason the gate has never gated anything.
**Fix** Push, and bump the aquatils version in the same commit.
**Effort** minutes · **Risk** low

### `version-bump-gate` — payload changes ship to nobody without a manifest bump
**Sev** high · **Component** delivery · **File** plugins/*/manifest.json:4
**What** Upstream's update check is a plain string inequality on `manifest.version`; the payload is cached on disk at install time. 13 commits across history changed a payload without touching its sibling manifest. Because `payloadURI` tracks the branch tip, any *later* bump delivers all accumulated changes — so the permanent harm is not the stranded commits but that **version is not a code identity**: two users both reporting "0.10.5" can be running three different payloads and no bug report is interpretable.
**Fix** A pre-push hook (not pre-commit — intermediate commits legitimately share one bump): fail when `git diff --name-only @{u}..` contains `<dir>/{provider,plugin}.ts` without `<dir>/manifest.json`. If you put it in CI instead, `actions/checkout` defaults to depth 1, so it needs `fetch-depth: 0`, and `github.event.before` is empty on the `pull_request` trigger.
**Effort** minutes · **Risk** low

### `main-has-no-gate` — the stable channel ships with no typecheck and no `.gitignore`
**Sev** medium · **Component** delivery · **File** .github/workflows/typecheck.yml:5-8
**What** The workflow lists `[main, beta]` but Actions only runs workflows present on the branch being pushed, and `main` has no `.github/` and no `.gitignore`.
**Why** Payloads originate on beta where the gate runs, so residual risk is a typo during the per-string promotion rewrite — which is exactly the edit tsc mostly cannot check. The missing `.gitignore` on main is the sharper half: agent state and scratch files are unignored there.
**Fix** `git checkout beta -- .github .gitignore` on main, once; add both to the promotion file list so they cannot lag again.
**Effort** minutes · **Risk** low

### `tsconfig-and-goja-gate` — the only automated gate does not model the runtime
**Sev** medium · **Component** all · **File** */tsconfig.json:3-4
**What** All seven use `target: ES2018, lib: ES2018`. Merged from five findings, with corrections: **`target` is irrelevant** — the host transforms every payload with esbuild at ES2018 before goja sees it, so lowering `target` only produces false errors on syntax esbuild downlevels. `lib` is the real knob, and at ES2018 it already rejects `flat`, `replaceAll`, `matchAll`, `.at()`. Lowering `lib` to ES2015/ES2016 buys exactly three more: named capture groups, `Object.entries/values/fromEntries`, `padStart/padEnd`. Nothing target-gates `?.`, `??` or lookbehind.
**Fix** Two steps. (1) Narrow `lib` (expect the occasional false positive on a builtin goja does have — `// @ts-ignore` it, don't revert). (2) Add the gate that actually matches production: run `esbuild --loader=ts --target=es2018` over every payload and fail on error — that is byte-for-byte the host's transform, so anything it rejects is guaranteed to brick the extension. Add a warn-only grep for `?.` / `??` / lookbehind on top. This is strictly cheaper than the "goja smoke harness" proposed elsewhere and catches the same class. Also enable `noUnusedLocals` (finds 6 dead symbols today); leave `noUnusedParameters` **off** — the three hits are interface-mandated signatures. Set `skipLibCheck: false` while you are there; the vendored types already pass with it off.
**Effort** minutes · **Risk** low

### `channel-constant` — promotion is 20+ hand edits with silent-failure cliffs
**Sev** medium · **Component** all · **File** plugins/aquatils/plugin.ts:125,587,603,606,974-1180,1335-1336,1397-1433,1523,1544,1550,1570,1718; manifest.json:27-28
**What** aquatils alone has 23 literal `beta` occurrences across the ext id, the icon URL, two DOM selectors, eleven cache path joins, four user-facing strings, two process-matching patterns, and the manifest path grants. aquaprefs has 4, seatags 1, providers 1 each.
**Why** Two are destructive if missed. The solver reap has a port-based fallback that would still free the port, but the Chromium reaper does **not** — a stale pattern there leaks a headless browser after every stop, on Linux and Windows.
**Fix** `const CH = "-beta"` / `AQ_SUFFIX` / `AQ_BRANCH` inside `$ui.register` (module scope is invisible to UI callbacks), and derive the id, icon URL, both selectors, the cache dir and both reap patterns. Note the cache dir name is also pinned in `manifest.json`'s read/write paths, so it changes in two files or not at all. **Cheap check that works today**: `grep -c 'quatils-beta'` (drop the leading `a`) returns 22 and *does* match the bracketed shell patterns, which `grep aquatils-beta` misses — use the shorter pattern in the promotion sweep, and consider that sufficient rather than doing the full refactor.
**Effort** hours · **Risk** low

### `seatags-dom-namespace` — beta and stable seatags collide in the DOM
**Sev** medium **[unverified]** · **Component** seatags · **File** plugins/seatags/plugin.ts:302-303,335,345,391,552,609,618,637-641
**What** The two channels are byte-identical except `EXT_ID`, but every DOM marker is channel-free (`data-seatags`, `data-seatags-tb`, `data-seatags-style`, `.seatags-block`). Both are listed in the same marketplace.json.
**Why** Whichever boots first tags every card, suppressing the other's observers; each instance's reset removes the *other's* live `[data-seatags-style]` element while that instance's variable still points at the detached node, so `ensureFilterStyle` early-returns and both filters silently stop working for the session.
**Fix** `const NS = EXT_ID` and build every attribute, class and selector from it.
**Effort** minutes · **Risk** low

### `userconfig-placeholders` — `{{placeholders}}` survive into the running payload
**Sev** high **[unverified]** · **Component** all providers · **File** extensions/*/provider.ts:4-7
**What** Upstream's `loadUserConfig` returns early — leaving the payload untouched — when a saved config's version differs from the manifest's, and then loads the extension anyway. Only animepahe guards for the residue, and only for one field.
**Why** anikoto has already been at userConfig v1, v3 and v2, so anyone who saved during the v3 window is mismatched until they re-open settings. anizone/animelok then fetch `{{baseUrl}}/anime?search=…` and report "site unreachable" — the message that sends the user to check the site rather than their config. anikoto degrades quietly: `("{{useCustomSolver}}").toLowerCase() === "on"` is false, so a user who enabled the solver silently gets it off and is told to enable it.
**Fix** Stop using string substitution. `$getUserPreference(key)` is bound by the host, declared in every vendored d.ts, and used by nothing: `private baseUrl = $getUserPreference("baseUrl") || "https://anizone.to"`. Eight lines across four providers. This also kills the payload-injection class below and makes the config testable (see `config-untested`).
**Effort** minutes · **Risk** low · **Depends** enables `userconfig-injection`, `config-untested`

### `userconfig-injection` — config values are spliced into a JS string literal
**Sev** medium · **Component** anizone, animelok · **File** extensions/{anizone,animelok}/manifest.json:19-22
**What** Upstream substitutes with `strings.ReplaceAll` into the middle of a double-quoted literal, no escaping. A value containing `"` either bricks the extension with an opaque parse error or injects statements.
**Why** Robustness, not a serious threat model — the actor is the user typing into their own settings box for code they already chose to execute. But a stray quote bricks the extension with nothing pointing at the settings field.
**Fix** Subsumed entirely by `userconfig-placeholders`. If that is not done, make both `baseUrl` fields `select` (as anikoto and animepahe already are); note the splice surface only shrinks from 4 to 2, since solver fields stay free text.
**Effort** minutes · **Risk** low · **Depends** `userconfig-placeholders`

### `manifest-marketplace-generated` — 120 hand-copied fields with no check
**Sev** low · **Component** delivery · **File** marketplace.json
**What** Each of 12 entries restates 10 fields that already live in a manifest. Merged with four related findings: the animelok entry advertises a two-hop-dead domain (`.online` → `.net` → `.live`); no entry carries `version`, so no card shows one; `aq-seatags-beta` sits after the stable block so the beta group is not contiguous; `main/marketplace.json` is a strict subset of beta's and Seanime stores only one marketplace URL.
**Why** Cosmetic today (`website` is not rendered by the card), but it is a drift generator and the next field to drift may be one the card *does* show.
**Fix** Generate `marketplace.json` from the seven manifests with a ~15-line node script and have the gate fail if the committed file differs. That makes `version` free and correct by construction, fixes ordering, and removes the hand-maintained copy. Do **not** add a hand-copied `version` field without that check — a missing badge beats a lying one.
**Effort** minutes · **Risk** low

### `payload-sha-pin` — manifest and payload are two independently cached objects
**Sev** low · **Component** delivery · **File** */manifest.json:5,13
**What** Both URIs point at a mutable branch ref, both served with `max-age=300`, measured with 42 s of age skew from different edge nodes on a single back-to-back pair.
**Why** Bump the version and change the payload in one commit; a user updating inside the window can get the new manifest and the old payload. The versions now match, so it never re-fetches — permanently pinned to old code labelled as fixed. Small per user, but it does not self-heal.
**Fix** Point `payloadURI` at a commit SHA (immutable, long cache lifetime, one-line rollback); leave `manifestURI` on the branch for discovery. It does **not** replace `version-bump-gate` — changing the SHA without bumping still ships to nobody. Only worth it once the generator script exists to fill the SHA.
**Effort** hours · **Risk** low · **Depends** `manifest-marketplace-generated`

### `scratch-files-untracked` — three unignored working files in a public repo root
**Sev** medium · **Component** repo · **File** .gitignore
**What** `REVIEW-BACKLOG.md` (605 KB of internal findings that name mechanisms), `hls.ts` (upstream GPL frontend source in an MIT repo), `RENAMED.md` (stale: describes a `services/` layout and an `extensions.json` on main, neither of which exists, and documents a token procedure).
**Why** One `git add -A` publishes all three. `RENAMED.md` is also the file a future agent will read as ground truth and act on — that is the more likely harm.
**Fix** Move working notes out of the tree entirely (an ignored file is still one `git add -f` away); delete `hls.ts`; delete or rewrite `RENAMED.md` first. Promote whatever rule you add to `main`, which has no `.gitignore`.
**Effort** minutes · **Risk** low

### `semver-constraint` — no manifest declares a minimum Seanime version
**Sev** low · **Component** all
Upstream refuses to load an extension whose `semverConstraint` fails, with a clear reason. Three providers use `$scannerUtils` (documented as v3.5.1) and aquaprefs needs `ctx.videoCore`. Add `">=3.5.1"` to the three; **do not guess** for aquatils/aquaprefs, where no release documents the binding. Two caveats: enforcement is all-or-nothing (too high invalidates the extension outright), and it is skipped entirely on prerelease hosts — i.e. it does nothing for beta testers.
**Effort** minutes · **Risk** low

**Nits (Batch C):** CI pins `typescript@6` while the documented local compiler path does not exist on this machine — pin an exact version in a root `package.json` and call `./node_modules/.bin/tsc`, not `npx`. · A `solver-release` workflow is registered on GitHub with no file in any ref (almost certainly a history-rewrite artefact) — delete the stale registration. · Beta and main are promoted the same day for four of seven units, so the channel currently buys no soak time on the branch that has no gate.

---

## Batch D — aquatils: what it does to the user's machine

### `solver-port-kill-ownership` — the plugin kills whatever holds the port
**Sev** high · **Component** aquatils · **File** plugins/aquatils/plugin.ts:1495-1512,1481,828-836
**What** After a correctly channel-scoped `pkill`, `reapOrphanSolvers` unconditionally kills the port holder (`fuser -k <port>/tcp`, `lsof … | xargs kill -9`) with no ownership check. On Windows it is `taskkill /F /T /IM solver.exe`, which matches **any** process of that name on the machine. It runs on every start, on every remove, and on a 15 s repeat while the user has manually stopped. Both channels default to the same port.
**Why** The README advertises interoperating with a compatible endpoint on that port, so a user already running one is an explicitly supported audience — and this SIGKILLs it, repeatedly. Cross-channel, both plugins installed (the normal beta-tester setup) is the same collision; on a box where Seanime runs as root, `fuser -k` reaches any user's process.
**Fix** Do **not** simply delete the port-kill — it exists for bind-race recovery. Resolve the listener PID as today, then require `readlink /proc/$PID/exe` (or `ps -o args=`) to contain the channel's own cache dir before killing; otherwise surface "port busy — pick another port". On Windows use the PowerShell CommandLine filter `reapOurChrome` already demonstrates. Separately, derive the default port from the channel (beta 8192) so the two channels and any third-party endpoint never contend. Also: `reapOrphanSolvers` still derives `localHost` from the raw stored host, which the recent host-mode fix did not update — a user who left Remote mode with a remote address stored gets no port cleanup at all.
**Effort** hours · **Risk** low · **Depends** `channel-constant` (for the port derivation)

### `solver-identity-probe` — the probe cannot tell our solver from any compatible one
**Sev** medium · **Component** aquatils · **File** plugins/aquatils/plugin.ts:792
**What** `const ours = !!data && (data.version !== undefined || Array.isArray(data.sessions))` — a stock compatible service answers that shape. The comment directly above states the correct intent; the predicate does not implement it.
**Why** The user's own solver never starts (autostart checks `!== "up"`), the badge is green, and every path needing the browser stage fails silently because the other service has no `capability` command.
**Fix** In non-remote mode require a marker only our solver returns — the `capability` command already exists — before `setStatus("up")`. Keep the loose check for Remote mode, which is the documented interop feature.
**Effort** hours · **Risk** low · **Depends** enables `animepahe-proxy-identity`

### `animepahe-proxy-identity` — a compatible-but-different solver silently kills playback
**Sev** high **[unverified]** · **Component** animepahe · **File** extensions/animepahe/provider.ts:169,436-453,505-510
**What** `useProxy` is true whenever `sessions.list` returns 2xx. It then **replaces** every m3u8 URL with `<solverBase>/m3u8?u=…&r=…`, an endpoint only our solver implements. The version string is parsed at :445 and never used for the decision.
**Why** aquatils' README explicitly recommends pointing Remote mode at a third-party compatible endpoint. Following that instruction makes every animepahe source a URL that endpoint 404s — and because the rewrite replaces rather than augments, the working direct URL is discarded and the failure happens in the host's HLS fetch *after* `findEpisodeServer` returned success, so nothing reaches the error pane either.
**Fix** Two independent halves. (a) Push **both** URLs — proxied first, direct second with a distinct `quality` label — so a 404 degrades instead of killing playback. (b) Gate `useProxy` on an unambiguous identity marker (see `solver-identity-probe`); until the server side ships one, gate on `/m3u8` answering a HEAD once per session, cached alongside the existing ping.
**Effort** hours · **Risk** low

### `consent-bypass` — the download consent gate is satisfied without consent
**Sev** medium · **Component** aquatils · **File** plugins/aquatils/plugin.ts:520,1045-1051,1664
**What** The gate is `!fsConsent.get() && !priorInstall()`, and `priorInstall()` reads a flag that `setStatus("up")` sets — which runs in Remote mode and for any listener passing the weak probe above.
**Why** A user who only ever used Remote mode (or merely had a compatible service on the port when the plugin first polled) has the flag set without seeing the box. Switching to Bundled later downloads and executes an 8 MB binary with no prompt. "Remove downloaded solver" never clears the flag either, so the gate never returns. (The archive *is* checksum-verified now, so this is an unconsented install of a verified binary.)
**Fix** Call `markInstalled()` only from the successful-install branch. Optionally store `fs.consentedVersion = SOLVER_VERSION` so a major solver change re-asks once.
**Effort** minutes · **Risk** low · **Depends** `solver-identity-probe`

### `apt-install-unattended` — 35 system packages installed as root with no prompt
**Sev** medium · **Component** aquatils · **File** plugins/aquatils/plugin.ts:353,361-386,396-420
**What** When a downloaded browser exists and packages are missing, the plugin probes for root/passwordless sudo and runs `apt-get update && apt-get install -y <35 packages>` system-wide. The only notice is a toast fired at the same moment. It installs the **entire** dependency set, not the missing subset it detected and displayed.
**Why** The consent the user gave covers downloading a binary into the cache. Mutating the host's package database — including `apt-get update`, which takes the dpkg lock — is a categorically larger action taken with no confirmation. Fires once per plugin load, not per poll.
**Fix** Delete the automatic branch and always call `promptDeps()` — the tray already renders the package list, the exact command, an install button and a copy button, and it persists (a toast does not). Install only the packages actually detected as missing.
**Effort** minutes · **Risk** low

### `permissions-hash-stability` — editing the permissions block takes the plugin offline
**Sev** high **[unverified]** · **Component** aquatils · **File** plugins/aquatils/manifest.json:16-29
**What** Seanime hashes scopes, read/write paths, and the free-text *description* of each command scope, and refuses to load when the grant hash differs. Editing any of them revokes the grant. `reasoning` is the only free-text field excluded.
**Why** aquatils' paths have already been rewritten twice post-release, and each push silently disabled the plugin for every installed user until they re-granted — solver stops, tray disappears, error pane goes dark, and the only signal is an entry in the invalid-extensions list. Nothing in the repo records this cost.
**Fix** Write two rules into `plugins/aquatils/README.md`: never touch scopes/paths/commandScopes/allowedDomains except in a deliberate permissions release (put prose churn in `reasoning`); when you must, bump the version in the same commit and say "you will be asked to re-grant". Bundle any path cleanup with the next real permissions change.
**Effort** minutes · **Risk** low

### `readpaths-asymmetry` — fix the read/write mismatch instead of dropping `$CACHE`
**Sev** low · **Component** aquatils · **File** plugins/aquatils/manifest.json:27-28
**What** `writePaths` grants both the bare directory and the subtree; `readPaths` grants `$CACHE` and only the subtree. **Two reviewers disagreed here and one was wrong**: the bare `$CACHE` read entry is redundant under the host's own path matcher (the `/**` pattern already covers the parent directory entry), *and* the plugin does call `$os.readDir(aquatilsDir())` in two places, both wrapped in silent catches.
**Fix** Mirror writePaths exactly: `["$CACHE/aquatils-beta", "$CACHE/aquatils-beta/**"]`. That drops the whole-cache read grant from the permission prompt and keeps both `readDir` calls working. Route the two `readDir` catches through `setNote`/`aqReport` so a future permission mistake is visible rather than expressed as "pruning quietly stopped". Ship it bundled with the next permission-visible change (see `permissions-hash-stability`) — the re-prompt is itself a moment a user can decline. Also correct the aquatils README, which currently describes a narrower grant than the manifest asks for.
**Effort** minutes · **Risk** low · **Depends** `permissions-hash-stability`

### `checksum-skipped-on-spaces` — the new verification never runs for many Windows users
**Sev** medium · **Component** aquatils · **File** plugins/aquatils/plugin.ts:1636-1650,1669-1672,1839-1855
**What** `sha256OfFile` builds `cmd /c certutil -hashfile <winCmdArg(path)> SHA256`, and `winCmdArg` returns a path containing a space **unquoted**. certutil gets two arguments and fails; the failure is swallowed and treated as "no hash tool available", so the install proceeds and the log claims a benign cause.
**Why** The cache path is under the user profile, so `C:\Users\John Smith\…` is ordinary. Those users get the pre-fix behaviour while the log and the commit say the digest is checked. A silently downgraded security control is worse than none.
**Fix** Invoke argv-style — `$os.cmd("certutil", "-hashfile", path, "SHA256")` — and skip the shell entirely. Distinguish "no digest published" from "we had a digest and could not compute one", and surface the unverified case in `fsNote`/the tray rather than only in the log. Note verification is advisory in general: pinning the expected digests in the plugin source next to `SOLVER_VERSION` would stop the digest and the binary sharing a fetch path.
**Effort** minutes · **Risk** low

### `orphan-browser-processes` — SIGKILL orphans the browser tree
**Sev** medium · **Component** aquatils · **File** plugins/aquatils/plugin.ts:1470-1478,1528-1534
**What** `binaryStop` only hard-kills, so the solver never tears down its children. The compensating reaper matches the *downloaded* browser's binary path only — not a system browser found by `findSystemChrome`, and not the virtual display.
**Why** The common desktop case is reaped. The exposure is the system-browser path (ARM Linux, or browser-fetch disabled) plus the display server, leaked on every stop/restart/settings-toggle.
**Fix** Widen the fallback reaper to match the profile-dir marker (`-f 'user-data-dir=.*aquatils-beta'`), which covers a system browser too. Do **not** pkill the display server by name — that needs a marker the solver emits, which lands in the solver repo along with graceful-shutdown handling.
**Effort** hours · **Risk** medium

### `chromium-delete-before-download` — the update deletes the working copy first
**Sev** low · **Component** aquatils · **File** plugins/aquatils/plugin.ts:1163-1170
`downloadChromium` starts with `removeAll(dir)` then begins an 80-150 MB download; any failure leaves no browser and clears the version. Auto-update fires this unattended. Recovery is automatic (the next start re-downloads), so the cost is a wasted re-download plus a window with no browser stage. **Fix**: download and unzip into `chromium.new`, validate, swap. Skip the versioned-dirs-with-rollback variant.
**Effort** hours · **Risk** low

### `chromium-download-not-cancellable` — Stop does not stop it
**Sev** medium · **Component** aquatils · **File** plugins/aquatils/plugin.ts:1163-1200,1465-1471
The chromium download's id is a local, never assigned to the field `binaryStop` cancels; the transfer continues, unzips, writes state and fires `setErr`/`tray.update` after the user pressed Stop — and `updateChromium`'s apply path then calls `fsStart()`, restarting after an explicit stop. **Fix**: reuse the single `fsDownloadId` for both downloads (they are never concurrent) and capture `const gen = fsBinaryGen` at the top so the completion branch bails.
**Effort** minutes · **Risk** low

### `animelok-untrusted-headers-and-url` — scraped JSON dictates the host's request headers
**Sev** medium **[unverified]** · **Component** animelok · **File** extensions/animelok/provider.ts:73-83,159-161
**What** `streamHeaders` copies **every** string-valued key of the remote `headers` object into `EpisodeServer.headers`, which the host applies to the video and every subtitle request — no key allowlist. `sources[0].url` becomes `VideoSource.url` with no scheme check, while `buildSubs` in the same file validates its inputs at :91.
**Why** The provider lets a scraped third party choose what headers the user's Seanime sends and what URL the player loads. Beta only.
**Fix** Allowlist `Referer`/`Origin`/`User-Agent`; gate `v.url` on `/^https?:\/\//i` inside `getVibe` before it is cached. Put both checks where the JSON is parsed, not at the consumers.
**Effort** minutes · **Risk** low

### `m3u8-host-validation` — the scraped playlist URL is handed to a local open proxy
**Sev** low · **Component** animepahe · **File** extensions/animepahe/provider.ts:288-292,505-510
`proxyM3u8` percent-encodes but does not validate `u`, which is whatever was scraped from a third party's packed JavaScript. The local endpoint has no allowlist. It is *not* the last line of defence (the direct branch feeds the same URL to the host's proxy, and no sibling provider validates either), but the check is four lines. **Fix**: in `matchM3u8`, require `https:` and reject IP literals / `localhost` / `.local` — applying it there covers both branches. A request allowlist on the solver lands outside this repo.
**Effort** minutes · **Risk** low

**Nits (Batch D):** `winCmdArg`'s branch is inverted — the space-plus-metacharacter case is the failing one, not the safe one; launching the exe directly (adding it to `commandScopes`) beats keeping a second parser in the loop. · The named solver session is a documented cross-component contract, not a leak; the only in-repo actionable is that anikoto sends no session and uses a different max-timeout than animepahe — reconcile the two numbers. · The `.5` in `timeout: 900.5` is unexplained, not proven load-bearing — hoist it to `DL_TIMEOUT_SEC`. · Every settings toggle restarts the solver, dropping in-flight clearance state; mark the setting dirty and reuse the existing "Restart to apply" chip. · Selecting DNS "Custom" restarts immediately with the feature *off*, then again on Save — guard the first restart when the URL is still empty.

---

## Batch E — failures that never surface

### `fail-contract-wrapper` — network errors escape the `fail()` convention
**Sev** medium · **Component** anikoto, anizone · **File** anikoto:81,84,390,556; anizone:189,228
**What** `fail()` returns a string precisely so the rejection marshals readably, but four `await fetch(…)` calls sit outside any try/catch. A transport failure escapes as a raw Go error. **Correction to an earlier claim**: this is *not* the empty `promise rejected: map[]` — the host wraps fetch errors so the message survives. What is actually lost is the SEHERRv1 record, the mirror invalidation, and any control over the text (which includes the full request URL).
**Fix** One private entry point per provider and no bare `fetch` in the class: `private async req(scope, url, opts)` that catches, reports through `fail()`, invalidates the base, and runs the challenge check. That also fixes `anikoto-ajax-unguarded` (the `/ajax/episode/list` call, the only network call in `findEpisodes` with no try, no challenge check and no `invalidateBase`) and `anikoto-serverlist-bare-fetch` in one edit.
**Effort** hours · **Risk** low

### `seherr-non-ascii` — five of the most diagnostic error messages may never be ingested
**Sev** high **[unverified]** · **Component** all providers · **File** anikoto:146,379,1009-1013; animepahe:426,428,432
**What** The channel has two emitters. The plugin-side one runs messages through `aqText()` (rewrites em/en dashes and ellipses, collapses newlines). The provider-side `reportError` — copy-pasted into all four providers — emits `String(message)` raw. Five provider strings contain a literal em dash, and aquatils' own README states the constraint: keep `msg` plain ASCII because the log anonymiser mangles non-ASCII JSON. `sehParse` drops an unparseable line in a bare catch.
**Why** The affected messages are exactly the ones the pane exists for — challenge detected on all mirrors, solver not reachable, solver reachable but could not clear. A blocked user sees an empty pane. Both channels.
**Fix** Move the three-line normalisation into `reportError` so the constraint is enforced by construction rather than remembered across 34 string literals. That also fixes the newline hazard (`sehParse` is line-based). Make `sehParse` tolerant as a second layer: on parse failure retry once with `\"` unescaped, then fall back to three regex extractions.
**Effort** minutes · **Risk** low

### `seherr-source-label` — every plugin-side error is stamped `scope: "solver"`
**Sev** medium · **Component** aquatils · **File** plugins/aquatils/plugin.ts:485,116-122,640-643
**What** `setErr` is the only caller of `aqReport` and hard-codes the scope. So download failures, extraction failures, launch exceptions and release-feed errors all publish as `[aq-aquatils-beta · solver]`, while errors from the solver *process* never enter the channel at all.
**Why** The pane cannot answer the first triage question — plugin, solver binary, or site — and the label actively asserts a component that was not involved.
**Fix** `scope` is free text and already rendered: give `setErr` an optional scope defaulting to `"plugin"` and pass `"solver"` only at the two exit-classification sites that genuinely quote solver output. Two edits, no payload-shape change across seven files. Note the scope string is part of `errorGroups`' key, so persisted entries show as two groups once.
**Effort** minutes · **Risk** low

### `fail-vs-report` — recovered failures poison the error pane
**Sev** medium · **Component** anikoto · **File** extensions/anikoto/provider.ts:508-524,583-586,1015-1018
**What** `fail()` reports at throw time; the Auto loop recovers at catch time. So a user whose episode played fine on the second candidate still gets "could not resolve the player URL" and "dub source resolved to the subbed track" listed as errors.
**Why** Trains the user to ignore the pane and permanently inflates the tray badge for a healthy install. With notifications on, each fresh distinct label also raises a toast and a desktop notification.
**Fix** Two functions: `msg(scope, m)` for speculative throws a caller may absorb, and `fail(scope, m)` reserved for the terminal exits of the three public methods. Then have the Auto loop keep `lastReason` and fold the per-candidate reasons into the single terminal message — one report, more information, and it stops telling the user to enable the solver when the real cause was something else.
**Effort** hours · **Risk** low

### `error-group-key` — numeric variance defeats grouping and blows the 30-group cap
**Sev** medium · **Component** aquatils · **File** plugins/aquatils/plugin.ts:2213,2223
**What** Groups key on the exact message, and provider messages interpolate status codes and episode numbers. Twelve failed episodes become twelve groups, not one `×12`; at 30 groups, rarer errors are silently dropped off the end and out of the badge.
**Fix** Key on `e.msg.replace(/\d+/g, "#")` while displaying the newest raw message — one line, no emitter coordination. State the trade in the code review: it collapses 404 and 503 into one row, which is acceptable only because the raw message is still shown. Add a dim `+N more error kinds` row so truncation is never silent.
**Effort** minutes · **Risk** low

### `exit-cause-from-stale-log` — crash classification reads the previous session's log
**Sev** medium · **Component** aquatils · **File** plugins/aquatils/plugin.ts:1384-1385,2664-2667
**What** `bindRace` and `execBlocked` are regex-tested against the 12,000-char rolling buffer, which spans every previous run *and* is pre-seeded from the on-disk log at plugin load.
**Why** One historical bind message poisons every later diagnosis: a genuinely different crash (missing library, wrong arch, permission denied) is reported as a port race, the real text is never shown, and pointless retries fire. A stale antivirus match is worse — it disables auto-restart and tells the user to add a security exclusion.
**Fix** Accumulate a per-spawn `runOut` in the already generation-guarded stdout callback and classify against that; keep the rolling buffer purely for display. Apply to the start-timeout path too.
**Effort** minutes · **Risk** low

### `log-priming-not-normalised` — half the log pane is coloured by a keyword guesser
**Sev** medium · **Component** aquatils · **File** plugins/aquatils/plugin.ts:2661-2668,2397
**What** Live lines go through `aqNormalize`; the boot priming assigns the raw file tail straight into the buffers. Those lines fail the canonical line regex and fall through to keyword guessing, so an INFO line containing "failed" is painted as an error and a DIAG line is painted as info.
**Why** After every restart the top of the pane is mis-levelled, and it is the pane the operator reads from a user's screenshot.
**Fix** Split the primed history, run each line through `aqNormalize(l, "solver")`, drop empties, rejoin — apply to both buffers (normalise first, then filter). Do **not** delete the keyword fallback: truncated first lines still need it. While there, cut buffers on a line boundary (`cutAt`) — three uncoordinated caps (12000 stored / 10000 primed / 6000 displayed) each leave an orphaned partial first line.
**Effort** minutes · **Risk** low

### `poll-health-invisible` — a wrong Seanime URL fails silently forever
**Sev** low · **Component** aquatils · **File** plugins/aquatils/plugin.ts:702-727,1892-1900,2288-2291
`sehPoll` surfaces only 401/403; everything else returns from a bare catch. Save validates the scheme and reports unconditional success, and the empty state reads "No extension errors reported" whether the channel is healthy or dead. **Fix**: track `sehOkAt`/`sehFailStreak`, make Save await the probe and toast the real outcome, and give the empty state two forms. While editing Save, also reset `sehSeenChars` — the new incremental cursor is not cleared when the URL changes, so pointing at a different Seanime with a longer log skips its head.
**Effort** minutes · **Risk** low

### `seatags-error-codes` — users are shown internal tokens as error messages
**Sev** low · **Component** seatags · **File** plugins/seatags/plugin.ts:185-190
Thirteen bare identifiers (`"fetch"`, `"shape"`, `"attr"`, …) are forwarded into the error pane as `[aq-seatags-beta · decorate] fetch`. **Fix**: keep the code as the dedup key, pass a sentence as the message. Delete the write-only `dErr` field.
**Effort** minutes · **Risk** low

**Nits (Batch E):** `/meta` enrichment swallows everything into `} catch (e) {}` with an unused binding — `catch (_e) { this.reportError("episodes", …) }`, same on the discarded-remap branch. · `ensureServeToken` duplicates the cache read its caller just did and degrades silently; the token is inert today, so either stop minting it (and drop the round-trip) or add the report. · anikoto backs the solver off only on 5xx; a 4xx (wrong path, wrong version, something else on the port) is retried on every playable check forever — `if (!res.ok)` records the cooldown. · aquatils' `setKind`/clipboard blocks swallow the action the user asked for; log the failure and move the success toast inside the try. · The tray copy toasts assert more than the plugin can know (`clipboard.write` is fire-and-forget) — one shared `copy(text, what)` helper with honest wording replaces six duplicated blocks. · `sehMaxT` is a persisted wall-clock high-water mark; add `if (sehMaxT > Date.now()) sehMaxT = 0` at load for RTC-less boxes. · A `t = 0` error never expires and dedupes forever — default a missing timestamp to now in `sehParse`.

---

## Batch F — truncated and stale episode lists

### `host-cache-24h` — a shipped mapping fix cannot reach an affected user for a day
**Sev** high **[unverified]** · **Component** cross · **File** upstream cache, consumed by all providers
**What** The host persists the provider's episode list on disk for 24 h keyed on (mediaId, provider, dubbed), and the UI's refresh button does **not** bypass that bucket — it only bypasses the 15-minute per-episode server cache. The providers' own 15-minute `$store` TTLs are invisible on this path.
**Why** Commits that correct episode mapping cannot take effect for an already-affected user for 24 h; restarting does not help (it is on disk) and refresh does not help. The user updates, sees the same wrong numbering, and concludes the fix does not work. It also amplifies every truncation below into a day-long one.
**Fix** aquatils already knows the app base URL and already polls it — add a "Clear onlinestream cache" tray action that calls the host's file-cache delete endpoint with the onlinestream bucket prefix. That makes every future provider fix deliverable in one click. Second, stop treating the providers' own episode-list caches as if they bound staleness.
**Effort** hours · **Risk** low

### `animepahe-truncated-list` — a page failure silently produces a short episode list
**Sev** high · **Component** animepahe · **File** extensions/animepahe/provider.ts:115-122,152
**What** The paging loop swallows every per-page failure with `catch (_e) { pageFail = true }` and keeps going; the only consequence is that the (already returned) result is not cached locally. `lastPage` also comes straight from the remote JSON with no upper bound.
**Why** Reproduced on the first attempt: One Piece returned **46 episodes instead of 1173**, then 1173 on the retry. Because `sort=episode_asc`, the episodes that vanish are the newest ones the user wants — and the host then freezes that list for 24 h.
**Fix** The envelope carries `total`; parse it. Collect failed pages, retry them once serially, then `if (collected.length < total) throw this.fail("episodes", "episode list incomplete (got N of M) — retry")`. Clamp `lastPage` and `break` on the first failure. **Do not** add parallel page fetches — firing concurrent requests at a guarded origin invites the exact challenge this provider fights.
**Effort** hours · **Risk** low · **Depends** `host-cache-24h` (for the recovery story)

### `anizone-truncated-list` — the same class, plus the partial result is cached
**Sev** high · **Component** anizone · **File** extensions/anizone/provider.ts:195-216
**What** The paging loop breaks on any throw or non-ok, then unconditionally writes whatever it has to `$store`.
**Why** One transient failure on page 7 of 33 leaves ~250 of 1173 episodes. **The obvious fix is wrong**: "return what you have but don't persist it" does nothing, because the host caches the returned list for 24 h regardless.
**Fix** Make an incomplete walk a *failure*: track `complete` and `throw this.fail("episodes", …)` when the walk aborted, so the host caches nothing and the user gets a retryable error. Per-page caching in `$store` is a fine optimisation but is not the fix.
**Effort** minutes · **Risk** low

### `animelok-probe-boundary` — a server error defines the end of the series
**Sev** high · **Component** animelok · **File** extensions/animelok/provider.ts:154,177-184,196-218
**What** Merged from two findings. `noSources()` returns true for any 500 whose body matches a pattern that the site's *generic* failure body also matches, so the "this episode does not exist" status is raised for every backend failure site-wide. `probeEpisodeCount` then treats it as the series boundary in both the doubling loop and the bisect.
**Why** Verified: a mid-probe outage produced exactly 128 episodes (the doubling step) for a series with 1173; a full outage produced `[]`. Truncation looks like the site genuinely only has 128 episodes. Beta only, and unguarded (the sibling truncation fixture exists for anikoto only).
**Fix** Immediate: only a genuine not-found may set the boundary; on an ambiguous failure abandon the probe and `throw this.fail("episodes", …)` — never return a partial count from an error path. Structural: `/api/flix/{anilistId}/{ep}` is a clean cheap oracle (HTTP 200 with a populated server array = exists, 200 with an empty array = absent, non-200 = error) that also carries the per-server audio type, so it answers the audio dimension too and lets `availability()` stop calling the resolver entirely. **Note**: an absent episode returns 200, so the caller must inspect the array, not the status.
**Effort** hours · **Risk** low · **Depends** enables `animelok-availability-latency`

### `animelok-outage-reads-as-not-found` — a site outage is reported as "anime not found"
**Sev** medium · **Component** animelok · **File** extensions/animelok/provider.ts:20-21,108-137
**What** `availability()` collapses every non-ok status into `exists: false` and `search()` returns `[]` with no `reportError`. Separately the positive availability cache lives 15 min while the source cache lives 5, so search can answer from a stale positive after everything else went red.
**Why** Users are told to "try manual matching" for a title the provider knows perfectly well, during an outage manual matching cannot fix — and neither `search` nor `findEpisodes` ever calls `reportError`, so the plugin whose job is surfacing extension failures sees nothing.
**Fix** The three-way shape is half-built already (`definitelyAbsent` gets the long TTL, ambiguous gets 45 s). Stop mapping the ambiguous branch onto `exists: false` — let it throw with a real reason. Make the availability TTL ≤ the source TTL.
**Effort** hours · **Risk** low

### `anizone-pagination-budget` — 59 sequential requests with no wall-clock ceiling
**Sev** medium · **Component** anizone · **File** extensions/anizone/provider.ts:189-208
Every fetch passes a `timeout` the host ignores, so each request can take the 35 s default and `findEpisodes` can issue up to 59 of them. **Fix**: `const deadline = this.now() + 45000` before the loop, checked each iteration (`this.now()` already wraps `Date.now`). Also derive the page cap from the paginator — the series page emits the last page number, so `Math.max` over those gives an exact bound instead of a blind 60 and removes a wasted probe page.
**Effort** minutes · **Risk** low

**Nits (Batch F):** anizone's `hasEnglishAudio` writes a fetch failure into the same 5-minute cache as a genuine negative — never let a catch block feed a cache write (the same rule fixes `anizone-truncated-list`). · animelok's probe caches on one of five exit paths; move `writeCache` to a single exit, and cache the incomplete case only once it carries a `{count, complete}` shape (caching a truncated count today would make the truncation sticky). · animelok's `availability` probes sub and dub sequentially — `Promise.all` (both are needed; `subOrDub` requires them), and the oracle above collapses them to one request. · Seed the probe's lower bound from `media.episodeCount` when it is > 0.

---

## Batch G — waste

### `seh-poll-cadence` — the whole Seanime log is fetched every 6 seconds forever
**Sev** medium · **Component** aquatils · **File** plugins/aquatils/plugin.ts:702-728,2672
**What** The incremental *parse* has already been fixed. What remains: the request is unconditional at 6 s for the life of the plugin, and the endpoint is not a tail endpoint — it flushes, sleeps 100 ms, reads the entire log file, anonymises it and JSON-encodes it. The logs on this machine are 55-61 MB.
**Fix** `trayVisible` and the open/close hooks already exist — consult them: 6 s while the panel is open, 60-120 s otherwise. Keep a slow background tick (the badge is visible while closed). A `since=`/`tail=` parameter is the real fix and lands upstream. **Settle first**: curl the endpoint with Seanime up and compare Content-Length to the file size.
**Effort** minutes · **Risk** low

### `tray-render-burst` — the tray tree is rebuilt at 4 Hz while nobody is looking
**Sev** low · **Component** aquatils · **File** plugins/aquatils/plugin.ts:1362,2603-2643
The 5 s baseline render is already gated by `trayPoke()`. Residual: the solver-output path still calls `tray.update()` directly at up to 4 Hz during startup — the busiest period — rebuilding ~100 components including 80 log lines and broadcasting them to a client whose popover is unmounted. **Fix**: route that one call through `trayPoke()` and drop the live cadence to 1 s. Separately memoise the badge (`number + "|" + intent`), which is visible while closed. Do **not** sweep all ~40 call sites; the rest are user-initiated.
**Effort** minutes · **Risk** low

### `tray-visible-multi-client` — one server-side flag, per-client open/close events
**Sev** medium **[unverified]** · **Component** aquatils · **File** plugins/aquatils/plugin.ts:155,871-877,2828-2829
Upstream emits tray open/close from **every** connected client, ungated. So tab A opens the tray, tab B opens and closes its own, and tab A's still-open panel stops updating — status, note, download progress and the test result freeze until A closes and reopens. **Fix**: count instead of latch (`trayOpenCount`, floor at 0), and have the periodic refresh force a real update every Nth tick so a missed close event degrades to a slow tray rather than a dead one. The code comment already states that preference; the code does not implement it.
**Effort** minutes · **Risk** low · **Depends** `seh-poll-cadence` (same hooks)

### `tray-dom-observers` — two app-wide DOM observers registered forever
**Sev** medium · **Component** aquatils · **File** plugins/aquatils/plugin.ts:601-624
Both `ctx.dom.observe` calls discard their stop handles, and the host re-runs a full `document.querySelectorAll` per observer on every mutation batch — one of the two selectors is a descendant + substring-attribute match with no index fast path. The targets only exist while the popover is open. **Fix**: the cheap 90% is to narrow the substring selector; the full fix registers in `onOpen` and stops in `onClose`, at the cost of a frame or two of unstyled panel on each open.
**Effort** minutes · **Risk** low

### `anikoto-double-search` — the host runs the whole search twice per episode-list load
**Sev** low · **Component** anikoto · **File** extensions/anikoto/provider.ts:107-136,251
Upstream calls `Search()` twice (romaji, then english) and `searchQueries` builds the same query set both times, so it is 6 `/filter` requests per cache miss instead of 3. **Fix**: cache the outcome in `$store` for ~60 s — but key on the query, not `media.id`, because manual search passes no Media and every such call would collide on id 0. Keep the cached value small ($store clones through JSON on every read). Also drop the pretence that `searchBudget` bounds wall clock; since no request can be cut short, it can only mean "don't start more work".
**Effort** hours · **Risk** low

### `anikoto-mirror-ordering` — mirror memory is defeated by always probing the configured mirror first
**Sev** low · **Component** anikoto · **File** extensions/anikoto/provider.ts:24-49
`candidateBases()` puts the configured base first and does not validate the cached one; `currentBase()` does the opposite and does validate. A hard-down configured mirror costs one ~35 s stall per search call (the query loop breaks on transport error), roughly 70 s across the host's two calls. **Fix**: one ordered list, `currentBase() = candidateBases()[0]`, same validation in both. Skip the per-mirror failure timestamps unless outages recur.
**Effort** minutes · **Risk** low

### `anikoto-server-budget-unconditional` — the budget refuses to fire when it matters
**Sev** low · **Component** anikoto · **File** extensions/anikoto/provider.ts:14,509,72-85
`if (this.outOfTime() && (playableNoSubs || firstResolved)) break` — the deadline is ignored in exactly the case where giving up matters. Since per-request timeouts are inert, this is the only time control the provider has. **Fix**: `if (this.outOfTime()) break` before each candidate, plus make `fetchRetry` deadline-aware (skip the second attempt when out of time) so transient-error recovery is kept. Realistic bad case is minutes, not the 19 minutes a strict worst case implies.
**Effort** minutes · **Risk** low

### `inert-timeout-literals` — 26 `timeout:` values that do nothing
**Sev** low · **Component** all providers
The host reads the option with a type assertion goja can never satisfy, so every request uses the 35 s default. The plugin already documents this; the providers do not. **Fix**: delete the literals or carry the same one-line note, so nobody tunes a number with no effect. Note a float does **not** work either — it fails the same assertion. Add `redirect?: "follow" | "manual" | "error"` to the extension `FetchOptions` (the host supports it, the plugin copy declares it, the extension copy does not), and record that there is no cancellation primitive in the extension VM.
**Effort** minutes · **Risk** low

### `store-eviction` — expired entries are never removed
**Sev** low · **Component** all providers · **File** anikoto:1064-1075; animepahe:183-188; anizone:589-600
`$store` is a plain in-process map with no cap; `readCache` treats a stale entry as a miss and leaves it. Keys include full HTML documents (a server-list document per episode, a play page per episode) under ~250-char base64 ids. Growth is per-session, not disk. **Fix**: `$store.remove(key)` on a stale read — but note `remove` is **not declared in the vendored d.ts** (the host binds it), so this is two edits: declare it, then call it. The one attacker-influenced key (`anikoto:lang:{label}`) is the case for `setIfLessThanLimit`, which is already declared — but check its semantics: it refuses new inserts at the cap rather than evicting, so it turns caching off rather than recycling, and it counts the *whole* store.
**Effort** minutes · **Risk** low

### `icons-oversized` — 4.2 MB of 1024×1024 PNGs rendered into a 48 px box
**Sev** low · **Component** repo
Six of seven icons are 543 KB-1.04 MB; anikoto's is 49 KB at 256×256 and looks identical. The marketplace pulls the whole set on a cold cache, and beta and main reference byte-identical blobs at different URLs so nothing is shared. **Fix**: re-export at 256×256 through `oxipng`/`pngquant` in one commit; URLs unchanged, no code edit. Pointing both channels at one URL only works for the five units that exist on main.
**Effort** minutes · **Risk** low

**Nits (Batch G):** each anikoto search page is `LoadDoc`-parsed twice (once for the site-page check, once to parse) on a ~115 KB body — pass the parsed doc down; leave the lowercase pass alone. · `readCache` deserialises the whole payload just to test the timestamp; split `key` and `key + ":at"` so a miss is free. · The author-filter input is bound to both `input` and `keyup` with no debounce, two bridge round-trips per keystroke — remove `keyup` (test the input-only path first; the duplicate may exist for a reason) and debounce via the cancel handle `ctx.setTimeout` returns. · seatags re-arms both observers on every navigation anywhere in the app — gate on the pathname it is handed. · seatags caches the whole 262 KB upstream array including a dozen unused fields and reads it back with the cloning getter; project to the ten fields used (45 KB) and use `getUnsafe`, which also makes change-detection immune to the `updatedAt` churn that currently forces a full re-decoration on every upstream commit. · animepahe caches the whole play-page HTML rather than the parsed sources (fold into `animepahe-playpage-predicate`). · animepahe re-harvests credentials after the final retry and discards the local result. · `$storage.set` is a full read-modify-write of the plugin's entire blob; aquatils' settings toggle does 18 of them — write one nested object. · aquaprefs persists its whole log array on every log line. · aquatils' solver log is unbounded within a version — stat and rotate at load, keeping the tail.

---

## Batch H — seatags, config, docs, UX

### `seatags-version-overwrite` — the installed version badge is replaced with a third party's
**Sev** high **[unverified]** · **Component** seatags · **File** plugins/seatags/plugin.ts:240-252,263-286,613-619
**What** The card observer matches the Installed page as well as the Marketplace page. `rebuildBadges` hides the native badge row and injects chips built from the **remote** community list — including `info.version`.
**Why** On the Installed page the version chip is the one piece of state that must be accurate, and it is the one seatags overwrites with data from a repository nobody here controls. A user on an old build sees the list's newer number, concludes they are current, and never updates — the exact situation manifest version bumps exist to prevent. It inverts on staleness too.
**Fix** Never render remote data that describes the user's local install (version, author, lang). Merged with `seatags-hidden-badges` below: **do not hide the native row at all** — append the tag chips into it. That deletes the whole `blockHtml` reconstruction, fixes both findings, and stops beta cards (which have no remote entry) rendering differently from stable ones for no reason.
**Effort** hours · **Risk** low

### `seatags-hidden-badges` — hiding the native row loses Built-in / Disabled / update
**Sev** high · **Component** seatags · **File** plugins/seatags/plugin.ts:280-285
The upstream row also carries a "Built-in" badge, a "Disabled" badge, a clickable `1.2.3 → 1.2.4` badge that opens the code-diff modal, and on marketplace cards an "Update available" badge. None is reproduced. Updating an extension is exactly what users are on that page for. Same fix as above.
**Effort** hours · **Risk** low

### `seatags-author-filter-hides-everything` — one character in the author box empties the grid
**Sev** high · **Component** seatags · **File** plugins/seatags/plugin.ts:352-361,613-615,300-303
**What** The *status* rule is gated on loaded data; the *author* rule is not. When the tag list has not loaded, the cards observer never arms, so no card has the author attribute, and the emitted `:not([data-seatags-author*="x"])` rule matches every card. Even with data loaded, any extension absent from the remote list has an empty author and is hidden.
**Why** Offline or behind a proxy, typing one character makes the whole grid vanish with no message; clearing the box is the only recovery and is not discoverable. Verified: six of seven of the author's own beta ids are absent from the remote list, so searching the author's own name hides all of them.
**Fix** Gate the author rule like the status rule, and surface the unloaded state (`ctx.toast.warning` exists and is unused). Structurally: read the author off the card's own DOM — the badge is right there — and use the remote entry only as a fallback. That makes author search work for every installed extension and fixes `seatags-beta-invisible` at the root.
**Effort** hours · **Risk** low

### `seatags-installed-id-fallback` — installed cards match by non-unique name
**Sev** medium · **Component** seatags · **File** plugins/seatags/plugin.ts:253-260,164-177
**What** `extractId` grabs the first `opacity-30` element's text — the extension id on a marketplace card, but the **description** on an installed card, which never renders the id. The description is rejected by the whitespace guard and everything falls through to a last-write-wins name lookup. The remote list has six duplicated names.
**Why** Verified: an installed MangaFire is labelled **Broken** and attributed to the wrong author because a different entry won the name key; the author's own AniZone is attributed to someone else in one direction and vice versa. A plugin whose only job is reporting status shows the wrong verdict.
**Fix** While building the maps, count names and delete any key occurring more than once, so ambiguity yields "Untagged" rather than a false verdict — three lines. Better: match on (name, author) read from the card, which is unique in the live data.
**Effort** hours · **Risk** low

### `seatags-load-never-retried` — one transient failure disables the plugin for the session
**Sev** medium · **Component** seatags · **File** plugins/seatags/plugin.ts:642-682
`load(false)` is called from one place; `onNavigate` re-arms observers but never retries the fetch; the failure path leaves no user-visible signal and `force` is dead. A user who has loaded once still has the `$storage` cache, so the fully-inert session needs a first run plus a failed fetch. **Fix**: make `onNavigate` call `load(false)` — the TTL check makes it free — plus a bounded backoff retry and one once-per-session warning toast on final failure. Distinguish a JSON parse failure from a transport failure (`res.json()` throws inside the same try).
**Effort** hours · **Risk** low

### `seatags-reset-loses-controls` — a reset leaves the DOM marker behind
**Sev** medium · **Component** seatags · **File** plugins/seatags/plugin.ts:623-649,543-555
`resetForReady()` clears the id→generation map but leaves `data-seatags-tb` on the search input, whose observer selector excludes marked elements. Every control callback then fails its liveness check, so the status dropdown and the author box go permanently inert while still looking clickable. The main-tab-ready event has no fire-once guard, so this triggers on tab switches. Recovery is navigating away and back — real, but undiscoverable. **Fix**: mirror the existing fire-and-forget `[data-seatags-style]` cleanup with `ctx.dom.query("[data-seatags-tb]") → removeAttribute`. **Do not** adopt the "store element handles and remove them" variant — the code comment at :624-628 explains why (a client reload recycles element ids, so removing through a stale handle can delete real UI).
**Effort** hours · **Risk** medium

### `seatags-row-never-restored` — a card that stops matching loses all its badges
**Sev** low · **Component** seatags · **File** plugins/seatags/plugin.ts:325-336,289-308
`refreshDecorated` removes the injected blocks but never un-hides the native rows, and `rebuildBadges` only runs when a match exists. If an entry is renamed or removed upstream, the card is left blank. Subsumed entirely by the "append, don't hide" fix.
**Effort** minutes · **Risk** low · **Depends** `seatags-version-overwrite`

### `seatags-beta-invisible` — seatags cannot tag any beta extension
**Sev** medium **[unverified]** · **Component** seatags
The remote list has 244 entries including five of the author's stable ids and one beta id, but not the other six beta ids. seatags-beta is installed *by beta users*, whose cards it cannot resolve — so "Working" hides them and typing the author's name hides them. **Fix**: (a) merge this repo's own `marketplace.json` as a second source (already an allowed domain, already published on both branches); (b) read author and version off the card, which fixes this and `seatags-author-filter-hides-everything` together.
**Effort** hours · **Risk** low

### `seatags-status-dropdown-a11y` — the status filter is keyboard- and screen-reader-inoperable
**Sev** low · **Component** seatags · **File** plugins/seatags/plugin.ts:431-529
Built from bare `<div>`s reusing the host's Select classes: no tabindex, no roles, no aria state, no key handling, no focus management; the author input has no label. The native Select beside it is fully accessible, so this is a visible regression on that toolbar rather than a pre-existing gap. **Fix**: use a real `<select>` with a `change` listener. It inherits the toolbar styling the author input already uses, and it deletes ~90 lines (`buildStatusDropdown`, the menu open/close/toggle/check machinery, the hover style, the body-click listener — which also retires that leak). Cost is losing the pixel-match with the host's Select, which appears to be why the div version exists.
**Effort** hours · **Risk** low

### `anikoto-metadata-disclosure` — the metadata host is contacted with the AniList id on every load
**Sev** medium · **Component** anikoto · **File** extensions/anikoto/provider.ts:18,330,435; manifest.json:8,17-57
Every title a user opens is reported to a single external host, before anything else, **regardless of the subtitles setting** — a user who reads the config screen would reasonably assume Disabled stops it. Neither the manifest nor the marketplace description mentions a third-party host. This is the author's own service, so the issue is disclosure and control, not intent. **Fix**: one `select` field ("Enhanced episode data & subtitle proxy", default on) that short-circuits both calls, plus a sentence in the description. **Caveat**: this endpoint is the primary episode-list source, so switching it off drops the user onto the scraping path — fix `anikoto-season-evidence` first or the opt-out is a footgun. Label it for what it does, not as a privacy switch.
**Effort** minutes · **Risk** low · **Depends** `anikoto-season-evidence`

### `animepahe-diag-in-user-error` — raw page and solver bodies in the thrown message
**Sev** medium · **Component** animepahe · **File** extensions/animepahe/provider.ts:591-635,461
`parseDiag` assembles the request URL, the resolved base, status, redirect chain, cookie counts, the matched challenge token, and 160 characters each of the raw site body and the solver body — and that string is both thrown to the player and written to the log via `reportError`. Interstitials routinely embed a request id and sometimes the client's own address. It is also computed on the **happy path**: `snapResp` runs `res.text()`, a whole-body whitespace collapse and a whole-body lowercase on every response for diagnostics only read on failure. **Fix**: throw a short actionable sentence; send the detail to the log only (or behind the existing verbose toggle); compute the snippet lazily. Skip a redaction regex over a 160-char snippet — once it is log-only, the operator is the only reader.
**Effort** hours · **Risk** low

### `diagnostics-unscrubbed` — the blob users are told to paste bypasses the scrubber
**Sev** medium · **Component** aquatils · **File** plugins/aquatils/plugin.ts:562-579,237-246
The log tail is scrubbed at capture; `endpoint=`, `lastError=` and `note=` are not, and those carry OS error text including absolute cache paths containing the username. **Fix**: `return scrubLog(out.join("\n"))` — one line, structural, covers every future field. Emit `mode=` and `port=` separately first, because the URL rule would otherwise destroy the one useful support detail in `endpoint=`. Note the same raw strings also reach the log via `aqReport`, so this closes one of three exits.
**Effort** minutes · **Risk** low

### `log-scrub-boundary` — soften the URL rule rather than moving the boundary
**Sev** low · **Component** aquatils · **File** plugins/aquatils/plugin.ts:450,237-246
One reviewer proposed scrubbing at the copy boundary instead of at capture so the operator sees real URLs on screen. **Rejected in that form**: capture-time scrubbing is fail-closed and covers the most common report medium — a screenshot of the pane — which no exit-point redaction can reach. **Take the good half**: keep scheme+host and redact only path/query, which recovers "which mirror" with a one-regex change. The raw text is not lost either way; the solver writes it unredacted to its own log file.
**Effort** minutes · **Risk** low

### `diagnostics-incomplete` — the blob omits the settings that change behaviour
**Sev** low · **Component** aquatils · **File** plugins/aquatils/plugin.ts:563-578
No plugin version, no engine/DNS/verbose/pacing/launch-mode state, no hard-challenge capability, no error list. The tray exposes ~10 toggles that materially change how the solver runs. **Fix**: add `PLUGIN_VERSION` next to `SOLVER_VERSION` (highest value single item — two users on the same manifest version can be running different bytes), a line listing only non-default toggles, the capability flag, and the top ~10 error groups.
**Effort** minutes · **Risk** low

### `error-pane-timestamps` — the Errors pane never shows when anything happened
**Sev** medium · **Component** aquatils · **File** plugins/aquatils/plugin.ts:640-643,2205-2248
`t` is carried, sorted on, and TTL-filtered at 6 h, but never rendered. With a 6 h window the top entry can be six hours old and looks identical to one from five seconds ago, and `×12` over six hours means something completely different from `×12` in a minute. **Fix**: `aqStamp(e.t)` already produces the format the log pane uses — prefix it, and for a group show the newest time plus the span.
**Effort** minutes · **Risk** low

### `copy-all-mismatch` — "Copy all" pastes something other than what is shown
**Sev** nit · **Component** aquatils · **File** plugins/aquatils/plugin.ts:1882-1890
The pane renders deduped, TTL-filtered, capped, newest-first groups; Copy all dumps up to 100 raw entries in ingest order including duplicates and entries the UI decided were too old. **Fix**: copy `errorGroups()` (call it directly — `sehGroups` is stale if the Errors view was never opened).
**Effort** minutes · **Risk** low

### `readme-empty` — the README tells a prospective user nothing
**Sev** low · **Component** repo · **File** README.md
Three lines, two of them asides about the pointlessness of READMEs. No marketplace URL, no channel explanation, no list of payloads, and no statement that one plugin downloads and runs a binary with shell execution and broad network access. That plugin's own README documents it well and nothing links to it. **Fix**: twenty lines, tone unchanged — the URL(s) and who each is for, a table of the seven payloads, one accurate sentence on the solver download and its verification (say plainly that verification is skipped when no digest or no hash tool is available), and a link. Add `readme` to the aquatils manifest pointing at the **rendered** blob URL, not the raw one, and use the unused `notes` field for the one-line dependency statements the providers need.
**Effort** minutes · **Risk** low

### `aquaprefs-scope` — the description promises per-series memory that does not exist
**Sev** low · **Component** aquaprefs · **File** plugins/aquaprefs/plugin.ts:244-261; manifest.json:8
`writeKey()` returns a constant; `readCascade()` is not a cascade; `indexAdd`/`IDX_KEY` are write-only; `curMediaId`/`curEpisode` feed one log line. The manifest says "Remembers your player and series options". **Fix**: pick one. Global is defensible — then delete the index, inline the constant, and reword the description (three places: two manifests, two marketplace entries). Purge the orphaned `pref:m:`/`pref:e:` keys from earlier releases behind one boolean flag; a schema version integer is only worth it if a second change is expected.
**Effort** minutes · **Risk** low · **Depends** `aquaprefs-vs-native-preference`

### `server-arg-contract` — three behaviours for one host input
**Sev** medium · **Component** all providers
anikoto advertises three names and throws on an unrecognised one; anizone and animelok echo whatever arrives; animepahe ignores the argument and returns an unadvertised name. **Fix**: one rule — a provider returns only a name it advertised, and falls back to `"Auto"` for anything else, never throws and never echoes. One line per provider. anikoto's genuine "this server has no link for this episode" case is a different message and stays.
**Effort** minutes · **Risk** low · **Depends** `anikoto-episode-servers-list`

### `animepahe-playpage-predicate` — the page validator accepts the wrong page
**Sev** medium · **Component** animepahe · **File** extensions/animepahe/provider.ts:182-195
`looksLikePlayPage` accepts any body containing a lazy-image attribute, which the *series* page (served with 200 for an unknown episode session) is full of. The wrong page is accepted on the first attempt with no retry or escalation, cached for five minutes, and then parsed to zero sources — so the next five minutes of retries fail instantly without touching the network, and the user cannot distinguish it from "no sources exist". **Fix**: delete the predicate and make the parse itself the validity check — pass `(b) => this.parsePlaySources(b, audio).length > 0` as the validator and cache the parsed `PlaySource[]` instead of 30-50 KB of HTML. That is the cheapest fix in the whole document and subsumes the play-page cache nit.
**Effort** minutes · **Risk** low

### `animepahe-season-filter` — season filtering is not confined to the matched series
**Sev** medium · **Component** animepahe · **File** extensions/animepahe/provider.ts:71-96
`filterBySeason` keeps every result whose ordinal equals the target with no same-show check, and `ordinalOf` collapses season and part into one number. Because `searchQueries` deliberately widens the pool, an unrelated widened hit with a matching ordinal becomes the *only* thing returned. anikoto was fixed for exactly this. **Fix**: port anikoto's shape (narrow to same-show first, then season and part as independent predicates). **Do not** reach for a shared module across two independently-fetched payloads — copy the ~20 lines. Cross-show contamination is inferred, not observed; one search where the right series has no ordinal-bearing entry would settle it.
**Effort** hours · **Risk** medium

### `animepahe-error-protocol` — control flow branches on English substrings
**Sev** low · **Component** animepahe · **File** extensions/animepahe/provider.ts:43-49
`search` decides whether to break its query loop by matching six needles against message text written elsewhere in the file — and one of them (`"blocked"`) already matches nothing. Rewording a sentence silently removes the loop break, costing up to six full solver round trips. **Fix**: a private `lastFailKind` set inside `fail()` (safe: a new Provider per call). Clear `lastResp` at the top of each iteration too.
**Effort** minutes · **Risk** low

### `animepahe-mirror-select-inert` — a three-way mirror control that cannot change anything
**Sev** low · **Component** animepahe · **File** manifest.json:20-27, provider.ts:350-366
All three options are the same origin (two redirect to the third), and `preferredBase` puts the rewritten list ahead of the user's choice anyway. **Fix**: relabel honestly and drop the two redundant probes from `resolveBase` (each costs a round trip on every 6 h cache miss). Do not collapse to a one-option select. The same shape applies to `animelok`'s `normBase()`, which rewrites away from three legacy domains on every URL construction — that rewrite is a deliberate migration aid for users stranded by two earlier moves, so keep a one-time legacy remap if you convert the field to a select, and hoist it out of the hot path either way. Record it as a settled choice; the next reviewer will read it as dead code.
**Effort** minutes · **Risk** low

**Nits (Batch H):** anizone's card href regex hard-codes a lowercase port-less origin — anchor on the id, or better on the stable `wire:key` attribute, which also removes an O(blocks × hrefs) scan. · anizone's `tagAttr` tries quoted patterns across the whole tag before the unquoted one, so a quoted attribute containing a `src=` substring wins; the site's escaping makes it inert, but one attribute tokenizer replaces `tagAttr`, the boolean-`default` heuristic, the trailing-slash bug and the entity-decode asymmetry at once. · anizone's no-`<track>` fallback drops `.vtt` while the primary path accepts it — build both regexes from one string. · `decodeEntities` handles five named entities; one generic numeric rule covers the rest. · anizone's `collectEps` builds a RegExp from an unvalidated id (unreachable through the UI; one-line guard anyway). · anizone `buildSubs` has two dead parameters and a dead `ext` field, and needs no `async`; dropping `$al` from ids is a *separate* change that breaks existing manual mappings. · anizone's `langName` lacks ~14 codes the site actually serves. · `unpack`'s alphabet diverges from the reference above radix 62 (unreachable); bound the symbol lookup with `idx < count` — that part is worth two characters. · aquatils' "quarantined" state is a Windows concept applied on every OS, producing a nonsense security message on Linux and no unattended recovery — gate on the platform. · Repeated no-output starts re-download the binary every time (the counter is only reset on success) — reset after the wipe and cap the cycle at one. · Antivirus toasts name `aquatils` while beta uses `aquatils-beta` — interpolate the directory instead. · Five camelCase properties in `styleEls` are silent no-ops; delete them, and do **not** switch to `cssText` (it would clobber the host's own inline positioning). · The tray panel's fixed geometry is hard-coded for the wide layout — gate the override on `ctx.dom.viewport.getSize()` width ≥ 1024 and keep the layout-agnostic max-height observer unconditional. · "Remove Chromium" leaves the fetch-browser setting on, so the next start silently re-downloads ~80 MB, and that toggle has no permanent home in the UI — clear it on removal and move it into the settings rows. · Untrusted extension-supplied error text flows into toasts and OS notifications with a spoofable source label — clamp to ~300 chars, run through `aqText`, restrict ext/scope to a safe charset at the parse boundary. · `esc()` in seatags omits `'` while the same file builds single-quoted attributes — not exploitable today, one `.replace` closes it. · The per-error copy buttons index a list the 6 s poll can reorder — look the group up by its stable key. · `sehIngest` never refreshes the badge (it happens to be right only because an unrelated poller runs). · `isPollingLine` and `filterLog` are the same state machine written twice, and the live copy's shared flag can leak a line on interleaved streams — one `filterLines(lines)` used by both. · The solver connectivity test drives the user's browser against an unrelated third-party demo domain with no disclosure and no fallback if that domain changes — test against a site the solver is actually used for. · `sehNotifiedAt` is keyed on full message text, so it both grows unbounded and fails open for the providers whose messages vary — key on `ext|scope`, and use `hasOwnProperty` rather than `|| 0` on a bare object. · animepahe's id third field means "count" in one method and "number" in another — rename the parameters; do **not** change the wire format, which would break persisted mappings. · animepahe's `getText` discards the exception, so the elaborate diagnostic is blank in the one case it would help. · anikoto's `epNodes.each` fallback number uses the unfiltered index — use a separate emitted counter. · anikoto's mirror list is duplicated between provider and manifest; accept it and edit both together, but note the trailing `throw lastErr` in `fetchRetry` **cannot** simply be deleted (strict mode requires a terminal throw) — dropping only the unused variable is the honest minimum. · Six unused locals across seatags and aquaprefs, plus ~105 lines of dead log-normalisation copied into two plugins that never call it. · Providers should declare `implements AnimeProvider` — free, erased at emit, catches signature drift against the hand-vendored d.ts. · anikoto sends unguarded-destination requests (loopback solver, first-party metadata host) without the flag animepahe sets on the identical endpoint.

---

## Batch I — verification gaps

### `fixtures-assert-substrings` — the regression net cannot see the wrong-entity class
**Sev** medium · **Component** all · **Note** the fixture file lives in `seanime-private` — **the actionable ask on this repo is promotion discipline**, not a code change here.
Search expectations are title regexes like `attack on titan|shingeki`, which every season, part, OVA and movie of a franchise satisfies — which is precisely why the wrong-season match went unnoticed, and why the CSM fixture is green while the movie/TV bug ships (it also pins `providerId`, skipping search entirely). animelok and animepahe have search-only fixtures and never invoke `findEpisodes` at all, so the truncation class is unguarded for both. **What to assert instead**: the resolved slug with its random suffix stripped, or the resulting episode count — the property you actually care about. Add cases for a worded-season title, a manual-mapping-shaped id with no `$al`, and a split-cour first/last episode number. Add `episodes.min` and a server stage for animelok and animepahe.
**Effort** hours · **Risk** low

### `no-hermetic-tests` — every test needs a live site and a running Seanime
**Sev** low · **Component** all
Roughly a third of provider logic is pure and deterministic and has none. The two behavioural drifts found in this review (the challenge-token lists and the language maps disagreeing between providers) are single-input pure-function facts a ten-line node script would have pinned. **Fix**: one dependency-free `tools/pure.test.mjs` that evals each provider class in a `vm` with stubs that throw, and asserts the pure helpers — runs offline in under a second alongside tsc. **Do not** commit a Go harness: there is no Go toolchain on this machine, so it could never run. Add saved raw HTML/JSON fixtures only for a parser that has actually broken once — they go stale silently and start asserting a layout the site no longer serves. Keep the live fixtures as a manual smoke suite; do not try to CI them.
**Effort** hours · **Risk** low

### `config-untested` — every test runs the default configuration
**Sev** medium · **Component** all
The harness substitutes manifest defaults, so no test has ever run a non-default mirror, subtitles disabled, the solver enabled, or the unsubstituted-placeholder state. Those branches are where the failures cluster. **Fix**: `userconfig-placeholders` removes the substitution entirely, at which point the payload runs identically under the playground and under Seanime and config becomes an input you can vary.
**Effort** hours · **Risk** low · **Depends** `userconfig-placeholders`

### `install-path-never-exercised` — the download-to-launch path has no way to be run
**Sev** low · **Component** aquatils · **File** plugins/aquatils/plugin.ts:1626-1795
~170 lines of branching ending in "execute a native binary", reachable only by actually downloading a release. The newly added checksum branch has never executed anywhere, and a mistake in it fails closed on every install. **Fix**: a hidden Advanced "Re-download solver" button that forces the full path — exercises download → verify → extract → launch in a minute per OS. The extract-pure-functions variant is weaker here; the risky parts are exactly the host calls a node harness cannot reproduce.
**Effort** hours · **Risk** low

---

## 3. Structural changes

Six changes that would each retire a whole class rather than one instance.

**1. Read config through `$getUserPreference`, not `{{placeholder}}` substitution.**
Eight lines across four providers. Removes: the residue bug when a saved userConfig version mismatches (which is *silent* and *permanent* per user), the entire payload-injection surface for the two free-text fields, and the reason config is untestable. It is the highest ratio of class-killed to lines-changed in the document.

**2. One `req()`/`getJson()` per provider; no bare `fetch` in the class.**
Every call site currently wants the same five things — retry, ok check, challenge detection, mirror invalidation, `fail()` with a report — and each site implements a different subset. Four separate findings (raw throws, the unguarded ajax call, the bare server-list fetch, the missing challenge check on the playback path) collapse into one function. It is also the natural home for the request/time budget, which today is scattered and inert.

**3. Rank on the structured facts the card already carries.**
Both providers lose the same argument the same way: they try to win on string similarity against titles the site chose for display, and the disambiguating evidence — episode count, format, year, and the card's *other* titles — is discarded at parse time. Carrying `{titles[], type, year, eps}` through to the ranker fixes the AniZone movie/TV collision, the AniZone year inference, and the anikoto worded-season case with one shape change, and it degrades gracefully when a signal is missing (guard on `episodeCount > 0`, treat a missing badge as no signal, never exclude on `format === "TV"`).

**4. One channel constant, and generate `marketplace.json`.**
Promotion is currently 20+ hand edits per unit with two silent-failure cliffs (a stale process-match pattern leaks a browser after every stop; a stale DOM selector loses styling with no error). Deriving everything from `const CH` inside `$ui.register`, and generating the marketplace file from the seven manifests, reduces the promotion surface to one line per payload plus a generated file — and makes the `grep -c 'quatils-beta'` check meaningful. Note the cheap 90% today is just using that shorter grep pattern.

**5. A pre-push hook, not CI.**
Four gates belong in one hook the operator installs once: the typecheck loop, the version-bump check (payload staged without its manifest), the esbuild-at-ES2018 transform that byte-for-byte matches what the host does, and a warn-only grep for the syntax no compiler setting catches. CI is a useful second opinion but it runs *after* the payload is already live at the CDN, so it can alert but never block. Keep the hook small enough that it is never bypassed — in particular, do not add a comment-style check to it.

**6. Decide the two convention questions and write them down.**
The zero-comment rule has been applied in both directions (a commit stripped ~100 lines of rationale, the current tree has added ~138 back), so the next cleanup pass will destroy load-bearing explanations again. The honest resolution — given that the plugin README already describes the same mechanisms — is *"rationale comments are fine; keep mechanism names out of both payload and README"*, which is a smaller change than the alternative. Likewise for `isDefault`: it is **authoritative** end to end (the frontend checks it first and falls back to index 0), so both the flag and the ordering are deliberate — record that before someone removes the "redundant" one. Both belong in whatever durable notes file the repo keeps, not in a commit message.

---

## 4. Considered and dismissed

- **Subtitle proxy as an SSRF vector** — the backend ignores the source parameter entirely, so the provider cannot make it fetch anything. Becomes live again only if the backend starts honouring it, at which point a host allowlist must land server-side *first*.
- **anizone cache keys omit the configured domain** — refuted; the domain is not a cache dimension there.
- **Route animepahe's search throws through `fail()`** — the no-report behaviour is deliberate and the cause was already reported upstream of the throw; routing it would double-report.
- **"The repo has no `.gitignore`"** — false since the recent commit; only the three untracked scratch files remain (kept as `scratch-files-untracked`).
- **Add checksum verification before executing the solver** — already implemented; only the silent-skip paths survive (kept as `checksum-skipped-on-spaces`).
- **`p.status !== "done"` may never match a Go-typed field** — the host field is a plain Go string; the download path works.
- **"Binary mode ignores the Host field"** — fixed; only the reaper's stale host derivation survives (folded into `solver-port-kill-ownership`).
- **Notification storm on a repeating error** — fixed by the cooldown; only the unbounded key map survives (listed as a nit).
- **Poll the log incrementally** — implemented; only the cadence survives (kept as `seh-poll-cadence`).
- **Fall back to the on-disk log in `buildDiagnostics`** — the buffers are primed from disk at load, so the fallback is dead; the surviving sub-point is that the exported tail honours a *display* toggle, which is a one-word fix.
- **Cap the notification fan-out** — largely fixed; the residual (no absolute cap on distinct labels in one tick) is not worth acting on unless observed.
- **Strip seatags' comments to match the convention** — actively works against keeping rationale next to code; see structural change 6.
- **`promise rejected: map[]` from unguarded fetches** — the host wraps fetch errors so the message survives; only `throw new Error(...)` produces the empty map. The real losses are telemetry and mirror invalidation.
- **Drop the bare `$CACHE` read grant** — would break two `readDir` calls silently; mirror `writePaths` instead.
- **`return scrubLog(...)` on the whole SEHERR message** — would erase the mirror URL from every legitimate provider error, which is often the most useful field.
- **Move log scrubbing to the copy boundary** — fail-open, and cannot cover a screenshot; take only the softened URL rule.
- **Lower tsconfig `target`** — irrelevant; the host transforms at ES2018 before goja sees anything. Only `lib` matters.
- **A committed Go smoke harness** — no Go toolchain exists on this machine, so it could never be run.
- **Return `[]` when anikoto's same-show gate empties** — would regress a working match observed live.
- **A src-hash path segment for subtitles, now** — the backend 404s unknown keys; it must ship server-side first.
- **`VideoSource.label` to advertise an alternate audio track** — the host drops it when there is only one source.
- **`sendGetMediaCaptionTrack()` to confirm caption state** — it and five siblings are empty stubs upstream.
- **A `v: 2` field on the SEHERRv1 payload** — a 7-file × 2-channel edit for a rendering concern the free-text `scope` field already covers.
- **Bounded-concurrency page fetching for animepahe** — invites the challenge the provider already fights; retry-once-then-fail is sufficient.
- **A discriminator in animelok's id encoding** — breaks every persisted mapping; rename the parameters instead.
- **`$shared.define`/`$shared.use` to deduplicate provider helpers** — cross-payload scope and load order are unverified and there is no build step; copy the lines and diff them by hand.

---

## 5. Not covered by this review

- **`seanime-private` was deliberately out of scope** — the solver service and the extension-helper were used only as instruments and were never audited. Several fixes here depend on changes landing there (subtitle keying by source identity, a solver identity marker, a graceful-shutdown signal, an episode-existence oracle contract, fixture assertions) and are labelled as such.
- **Two findings marked `[unverified]`** came from a completeness pass with no refutation stage: `anizone-search-parser-dead`, `push-beta`, `userconfig-placeholders`, `permissions-hash-stability`, `animepahe-proxy-identity`, `seatags-version-overwrite`, `seatags-dom-namespace`, `seatags-beta-invisible`, `animelok-untrusted-headers-and-url`, `aquaprefs-track-match-key`, `tray-visible-multi-client`. Each carries its own settling test. `anizone-search-parser-dead` is the one to check first — if it reproduces, most of the AniZone ranking work is unreachable and its priority changes.
- **The tree moved during the review.** The aquatils findings were anchored to a revision three commits behind HEAD; line numbers there are shifted by roughly +100 and the file grew from 2687 to 2851 lines. About 164 lines of new code (checksum verification, the host-mode gate, poll singleflight, the incremental log parse, the tray-visibility gate) received **no review coverage at all** apart from the two defects filed against it here. Re-run that lens against HEAD before acting on line numbers.
- **No Windows or macOS was available.** The `winCmdArg` quoting analysis, the `taskkill` blast radius and the certutil failure are derived from documented shell behaviour, not executed.
- **No Go toolchain, and no upstream Go source on disk for parts of the review.** Several upstream claims (the event-translation switch, the permission hash, the file-cache TTL, the tray event emission) are read from source citations or a compiled binary rather than run.
- **Seanime and the solver were not running for parts of the review**, so some end-to-end paths (the playground's error-channel behaviour, the log endpoint's response size, the aquaprefs listener-duplication question) are reasoned rather than observed.
- **Not reviewed at all**: the actual anti-bot posture and whether the current approaches still work; icon artwork; the marketplace UI beyond what seatags touches; anything about Nakama, sync, or non-onlinestream Seanime features.
- **No performance measurement under load.** All timing figures are single samples on one machine with a healthy network; the worst-case arithmetic in several findings is arithmetic, not measurement, and is flagged where it matters.

---

## Spot-checks against HEAD (5c385fd)

The four highest-stakes unverified entries were re-checked by hand after the review finished, because the tree moved underneath it.

| Entry | Outcome |
|---|---|
| tsconfig `target`/`lib` = ES2018 in all 7 projects | **Confirmed.** Every one of the seven reads `target=ES2018 lib=['ES2018']`. The only static gate this repo has is calibrated to a runtime it does not run on, so `Object.entries`, `padStart`, `Array.flat` and friends typecheck clean and then throw in goja. |
| Manifest version not bumped with the payload | **Confirmed, and worse than filed.** `plugins/aquatils/manifest.json` is `0.10.5`, last touched by `50a91b2`. Two commits have changed `plugin.ts` since — `c9d0fa2` and `5c385fd`. `5c385fd` *is* the download-verification fix, so the fix that retired this review's original critical is itself undelivered to users. |
| `useLibassRenderer === true` can never be true | **Unresolved — do not act on it yet.** The claim needs the Go declaration to be `*bool`; only the Seanime binary is on disk and its type metadata does not yield pointer-ness. Two data points, neither decisive: the `d.ts` declares the field optional (`useLibassRenderer?: boolean`), and Seanime's own bundled frontend tests it for truthiness (`t.useLibassRenderer && …`) rather than identity. A parallel review refuted a structurally identical claim about a different field, so treat this as open until someone reads the upstream Go source. |
| Release checksum not verified before execution | **Refuted — already fixed.** `5c385fd` added it; `plugin.ts:1868` discards the archive on mismatch. Listed under *Considered and dismissed*. |
