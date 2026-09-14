# AGENTS.md — operating notes for video generation + frontend

## What this is
Repo root is the folder `comfyui-video-pipelines-frontend/` (all paths below are
relative to it). Two parts:
- **CLI generation**: standalone Node scripts that drive a **remote ComfyUI** (via a
  reverse-proxy tunnel) to make videos. No local GPU. ESM (`.mjs`), Node ≥ 18, no deps.
- **`frontend/`**: a React+TS (Vite) web UI over the character-sequence pipeline, with a
  zero-dep Node backend (`frontend/server.mjs`).

## Ground rules
1. **Never edit the base workflows** (`workflows/flux-t2i.json`, `workflows/ltx2_5_i2v.json`,
   `workflows/image_to_video_wan.json`). Clone them (`structuredClone`) and mutate the
   clone via the builders in `lib/comfy.mjs` (`buildFluxGraph`, `buildLtxGraph`,
   `buildMergedGraph`, `buildWanGraph`).
2. **All generation code goes through `lib/comfy.mjs`** (`run`, `queue`, `wait`,
   `download`, `uploadToInput`, `fetchJson`). Don't re-implement HTTP/retries in scripts —
   fix the lib instead.
3. **Prompts live in `prompts/*.json`**, not in scripts. Scripts read config from the
   matching JSON. New content usually needs **no new script** — just a new prompts JSON run
   through a generic runner.
4. **Outputs go to `outputs/<project>/`**. Runners are resumable: an asset with any
   version on disk is skipped. Keep that pattern.
5. **Stitch with ffmpeg concat** (`-c copy`): clips from one ComfyUI run share
   codec/resolution/fps, so stream-copy concat is safe and lossless.
6. **Self-contained**: base workflows live in `workflows/` and are loaded from there by
   `lib/comfy.mjs` (`WORKFLOWS_DIR` overrides). Nothing else outside the repo is read at
   runtime (only remote ComfyUI via `COMFY_BASE`).

## Scripts
Generic runners (a new scenario = one new `prompts/<scenario>.json`):
- `director.mjs [scenario]` — N scenes, **merged** Flux→LTX per scene (one queue item each).
  JSON: `{ duration, scenes: [{ title, fluxPrompt, ltxPrompt }] }`
- `character_sequence.mjs [scenario]` — reference visual + N keyframe beats (same subject),
  **split** Flux→LTX. JSON: `{ duration, referencePrompt, sequence: [{ title, image, motion }] }`.
  Flags: `--stitch` (re-stitch only), `--regen ref|keyframe|clip <beat>` (regenerate one asset
  as a new version, then re-stitch).
- `character_sequence_wan.mjs [scenario]` — same shape but clips use **Wan 2.1 i2v**
  (`buildWanGraph`, video-only, no audio). Outputs to `outputs/<scenario>_wan/` so it never
  clobbers the LTX run.
- Either runner takes **`--vertical`** for the 9:16 Instagram Reel cut: every asset is
  regenerated vertical (Flux 360×640, LTX `9:16 (Portrait Widescreen)` at 0.125MP, Wan 240×416,
  prompts gain a portrait-framing suffix) into `outputs/<scenario>[_wan]_vertical/`
  (see `lib/variant.mjs` — the single source of truth for the mapping). The landscape
  cut is never touched; the frontend's Reel card (`InstagramCut`) triggers it via
  `POST /api/runs` with `{ format: "vertical" }`.
- `make_music.mjs [scenario]` — music-only: LTX **t2v** at tiny 64×64 (video throwaway),
  extracts the generated AAC to `.wav`; optionally lays it onto an existing video with the
  video's audio ducked. JSON: `{ musicPrompt, duration, fps?, size?, video?, videoVolume?, musicVolume?, out? }`.
- `movie_director.mjs [scenario]` — 20s LTX **t2v** narration at 64×64 + 5× 9:16 0.5MP
  trailer clips → final cut; `clipAudioVolume` mixes narration 100% / clip audio 20%.
- `man_eras.mjs` — 5-era character film.

Single-shot test tools: `run_flux_ltx_test.mjs` (one merged shot; ad-hoc via
`FLUX_PROMPT`/`LTX_PROMPT` env) and `run_flux_wan_test.mjs` (`prompts/wan_i2v.json`;
`--image <file>` skips Flux).

## Character-sequence implementation (important)
`character_sequence.mjs` and `character_sequence_wan.mjs` are **thin wrappers** — the shared
pipeline lives in `lib/sequence.mjs` (`runSequence`/`stitchSequence`); they differ only in the
clip builder and `videoNode` ("75" LTX / "56" Wan). `lib/sequence_state.mjs` handles
**versioned assets**: regenerating writes a new `_vN` file (never overwrites); the "main"
version per asset is recorded in `outputs/<scenario>/state.json` and is what gets stitched /
used as the keyframe a clip is generated from. Default main = latest version.

## frontend/ (web UI)
Serve the built UI + API: `npm install && npm run build` then `npm run serve`
(http://localhost:8790). Dev with hot reload: `npm run serve` + `npm run dev` (vite :5173,
proxies `/api` + `/outputs` to :8790). `build` = `tsc && vite build`.

Gotchas:
- **Scenarios live in Postgres** (`scenarios` table, canonical for the UI) by default —
  SQLite (`data/scenarios.sqlite`) is only used when `USE_SQLITE=true` is set in root
  `.env` (then SQLite is canonical and Postgres only mirrors saves). **Every
  save also writes `prompts/<name>.json`** so the CLI runners keep working (in either
  mode). Editing the JSON directly won't update the UI list — prefer the UI Save route.
- Auth is session-cookie based. Defaults `LOGIN_USER`/`LOGIN_PASS` = `admin`/`admin` from
  env — change these for anything non-local (server.mjs already forces login for `/api/*`
  and `/outputs/*`).
- `server.mjs` spawns the sequence scripts via `startRun()`; **only one run at a time** (the
  ComfyUI queue is serial) — new runs are rejected while one is `running`.
- Runs stream script logs via SSE and parse `[asset] {...}` lines into live asset events —
  keep emitting `[asset]` JSON from any script you want surfaced in the UI.
- **Postgres catalog**: every finished generation is indexed in the `video_generator`
  DB (`assets` table; binaries stay in `outputs/`). `server.mjs` upserts on each
  `[asset]` event, reconciles the run dir on exit, backfills on boot, and serves the
  gallery file list from `assets` (disk fallback when PG is down). Scenario saves are
  versioned in `scenario_versions` (every PUT = new version, never overwrite;
  `GET /api/scenario/:name/versions[/:v]`); editor has no autosave — explicit Save only.
  Needs the `pg` npm dep + `PG_HOST`/`PG_PORT`/`PG_DATABASE`/`PG_USER`/`PG_PASSWORD`
  from root `.env` (see `.env.example`). `GET /api/db` reports catalog health/counts.
- "Craft" / "extend beat" features call a local llama-server at `LLM_BASE`
  (`/v1/chat/completions`, `chat_template_kwargs: {enable_thinking:false}`) to author
  scenario JSON.

## Configuration
- `COMFY_BASE` (required) and `LLM_BASE` come from root `.env` via the tiny built-in loader
  in `lib/comfy.mjs` / `server.mjs`. **Never hardcode the ComfyUI URL in code or docs.**
  `.env.example` is the template. Real env vars always override `.env`.

## ComfyUI API facts (verified)
- Endpoints: `POST /prompt`, `GET /history/{id}`, `GET /view?...`,
  `POST /upload/image` (multipart: `image` + `overwrite`), `GET /object_info/{Node}`,
  `GET /system_stats`, `GET /queue`.
- **The reverse-proxy tunnel intermittently returns HTML error pages (404/502) instead of
  JSON.** All HTTP in `lib/comfy.mjs` retries on non-JSON content-type. Keep that.
- `SaveVideo` emits its file under `outputs[node].images` (not `.videos`).
- `LoadImage` can only read ComfyUI's **input** folder → external images must go through
  `uploadToInput()` first.
- History: `entry.outputs[nodeId]`, `entry.status.messages` has `["execution_error", ...]`
  on failure. `run()` throws with them.

## Workflow node map (the ones that matter)
`ltx2_5_i2v.json`:
- `395` LoadImage (first frame, input-folder filename)
- `398:376` prompt; `403` ResolutionSelector; `398:362`/`398:361` duration(s)/fps (frames=duration×fps+1)
- `398:363` "Switch to Text to Video?" (false=i2v; `buildLtxGraph({t2v:true})` sets true —
  used by movie_director/make_music to generate narration/music audio)
- `398:372`/`398:360` PrimitiveInt width/height — `buildLtxGraph({size:[w,h]})` sets these to
  literals, bypassing ResolutionSelector (lets us go below its 0.1MP floor, e.g. 64×64 runs)
- `398:383` "Enable Prompt Enhance" (leave false — gemma e2b not needed)
- `75` SaveVideo (final mp4). Latent gen runs at **half** resolution then 2× `LTXVLatentUpsampler`.
- **LTX-2.5 generates audio (AAC) alongside video — expected, not a bug.**

`flux-t2i.json`: `75:74` prompt, `75:68`/`75:69` w/h, `75:62` steps (default 4 in builder, base ships 20), `75:73` seed,
`75:65` VAEDecode (IMAGE — the bridge point), `9` SaveImage. Merged bridge:
`398:351`.inputs.input = `["75:65", 0]`; delete nodes `395` and `9`.
Keyframe ref anchor (`buildFluxImg2ImgGraph`): LoadImage (`ref:load`, uploaded main
ref version) → ImageScale (`ref:scale`, bilinear to target w/h, center crop) →
VAEEncode (`ref:vaeenc`, same `75:72` VAE); `75:64` latent_image rewired from
`75:66` (deleted) to `ref:vaeenc`. Falls back to pure t2i when no ref exists yet.

`image_to_video_wan.json` (Wan 2.1 i2v): `52` LoadImage; `6`/`7` positive/negative CLIPTextEncode;
`50` WanImageToVideo (w/h min 16 step 16; `length`=frames, **4n+1**, step 4 — 33≈2s at fixed
16fps of `55` CreateVideo); `3` KSampler (8 steps, cfg 1, uni_pc/simple — AccVid LoRA);
`56` SaveVideo. **Wan is video-only (no generated audio).**

## Models on the remote box (RTX 3080 Ti, 12GB)
- UNets: `flux-2-klein-9b-fp8`, `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot`,
  `wan2.1-i2v-14b-480p-Q4_K_M.gguf` (+ `Wan21_AccVid_I2V_480P_14B_lora_rank32` LoRA)
- CLIPs: `qwen_3_8b_fp4mixed` (flux), `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot` (ltx),
  `umt5_xxl_fp8_e4m3fn_scaled` (wan), `clip_vision_h`
- VAEs: `flux2-vae`, `ltx-2.5-video-vae-bf16`, `ltx-2.5-audio-vae-bf16`, `wan_2.1_vae`
- Upscaler: `ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0`

## Performance
- Back-to-back runs are much faster (models stay in VRAM): ~30s vs ~120s for i2v.
- Flux decode of one frame is <1s — don't try to "optimize it away"; the VAEs are
  incompatible between Flux and LTX, pixels are the only bridge.
- Keep `megapixels` at 0.5 for 16:9 (960×512) unless quality demands otherwise.

## Debugging
- `curl $COMFY_BASE/system_stats` — is the box alive? `curl $COMFY_BASE/queue` — stuck?
  `curl $COMFY_BASE/object_info/{Node}` — node schema.
- Execution errors land in `entry.status.messages` — `run()` throws with them.
