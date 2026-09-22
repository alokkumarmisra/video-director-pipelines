import { useCallback, useEffect, useRef, useState } from "react";
import { deleteSong, estimateSongLength, getProjectSong, getScenario, listRuns, listSongs, saveScenario, slugFolder, startRun, tailRun } from "../api";
import { useDialog } from "./Dialog";
import type { SongInfo } from "../types";
import { AUDIO_MODELS, SONG_PRESETS, VOCAL_OPTIONS, applyVocalToTags, audioModelById, buildPresetTags, estimateSongDurationLocal, isAudioModelId, isVocalId, songPresetById } from "../songPresets";
import type { AudioModelId, VocalId } from "../songPresets";
import { recordSongPaceDuration } from "./GenerationProgressBar";
import { IconPanel, Spinner } from "./Icons";
import Collapse from "./Collapse";

const LANGUAGES = ["en", "hi", "sa", "ur", "bn", "pa", "ta", "te", "unknown"];
// NOTE: time signature, seed and steps are auto-fit per song mode (all modes
// are 4/4, seed is fixed for reproducible takes, steps are tuned for the
// turbo model) — intentionally NOT user inputs.

// Create Song — lyrics-to-song workspace (selected audio model on ComfyUI:
// ACE-Step 1.5 XL Turbo or MiniMax Music 3; narration presets speak via Edge-TTS).
// Saving here stores the project with projects.project_type = 'AUDIO'
// (normal Project creation saves 'VIDEO'); the audio block on the scenario
// config is what scripts/generate_song.mjs renders into versioned mp3s.
// Stays mounted while hidden so in-flight work survives view switches
// (same pattern as ResourcePage / DirectorPage).
export default function CreateSongPage({ onOpenProject, focusProject, onProjectsChanged }: {
  onOpenProject?: (name: string) => void;
  // Opening an AUDIO project from anywhere (Home card, Projects panel,
  // "Open project" button) lands here with its name — the full saved form
  // + songs load immediately. Nonce re-fires for repeat selections.
  focusProject?: { name: string; nonce: number } | null;
  onProjectsChanged?: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // Song mode: one dropdown drives all generation values internally
  // (tags/bpm/key/language/steps/cfg/temperature). The user only picks the
  // mode + writes lyrics; duration auto-follows the lyrics length.
  const [presetId, setPresetId] = useState(SONG_PRESETS[0].id);
  const [vocal, setVocal] = useState<VocalId>(SONG_PRESETS[0].defaultVocal);
  // Audio model for sung takes (ACE-Step 1.5 XL Turbo | MiniMax Music 3).
  // Narration presets ignore it (Edge-TTS voices, never a music model).
  const [songModel, setSongModel] = useState<AudioModelId>("ace-step");
  const [tags, setTags] = useState(() => buildPresetTags(SONG_PRESETS[0], SONG_PRESETS[0].defaultVocal));
  const [lyrics, setLyrics] = useState("");
  const [duration, setDuration] = useState(120);
  const [autoDuration, setAutoDuration] = useState(true);
  const [estimating, setEstimating] = useState(false);
  const [estimateNote, setEstimateNote] = useState<string | null>(null);
  const [bpm, setBpm] = useState(SONG_PRESETS[0].bpm);
  const [language, setLanguage] = useState(SONG_PRESETS[0].language);
  const [keyscale, setKeyscale] = useState(SONG_PRESETS[0].keyscale);
  const [timesignature, setTimesignature] = useState(SONG_PRESETS[0].timesignature);
  const [seed, setSeed] = useState(0);
  const [steps, setSteps] = useState(SONG_PRESETS[0].steps);
  // Advanced ACE-Step sampling values — set internally per preset, saved with
  // the project, not hand-edited (kept in state so a preset switch restores them).
  const [cfgScale, setCfgScale] = useState(SONG_PRESETS[0].cfgScale);
  const [temperature, setTemperature] = useState(SONG_PRESETS[0].temperature);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [songs, setSongs] = useState<SongInfo[]>([]);
  const [songsLoading, setSongsLoading] = useState(false);
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  const dialog = useDialog();
  // Latest saved take from project_songs.file_path (shown under the header).
  const [songFile, setSongFile] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runLog, setRunLog] = useState("");
  const tailClose = useRef<(() => void) | null>(null);
  const songLogRef = useRef<HTMLPreElement>(null);
  // Hide/show toggles for the two cards (same persisted icon pattern as the
  // other cards). Collapsing only hides the body JSX; form state is kept.
  const [formCollapsed, setFormCollapsed] = useState(() => localStorage.getItem("ss-sec-song") === "closed");
  const toggleFormCollapsed = () =>
    setFormCollapsed((c) => {
      localStorage.setItem("ss-sec-song", c ? "open" : "closed");
      return !c;
    });
  const [songsCollapsed, setSongsCollapsed] = useState(() => localStorage.getItem("ss-sec-songs") === "closed");
  const toggleSongsCollapsed = () =>
    setSongsCollapsed((c) => {
      localStorage.setItem("ss-sec-songs", c ? "open" : "closed");
      return !c;
    });

  const stopTail = () => {
    tailClose.current?.();
    tailClose.current = null;
  };
  useEffect(() => stopTail, []);
  // Keep the latest log line visible: pin the rendering log to the bottom on
  // every chunk (same pattern as RunPanel).
  useEffect(() => {
    songLogRef.current?.scrollTo(0, songLogRef.current.scrollHeight);
  }, [runLog]);

  const refreshSongs = useCallback(async (project: string) => {
    if (!project.trim()) {
      setSongs([]);
      return;
    }
    setSongsLoading(true);
    try {
      const r = await listSongs(project.trim());
      setSongs(r.songs);
    } catch {
      // Project not saved yet (or DB down) — no songs to show.
      setSongs([]);
    } finally {
      setSongsLoading(false);
    }
  }, []);

  // Typing a project name auto-refreshes its song list so the
  // Generated Songs section follows the form without needing Refresh.
  // Skipped while a take is rendering (completion refreshes anyway).
  const nameTrimmed = name.trim();
  useEffect(() => {
    if (!nameTrimmed || runId != null) return;
    const t = window.setTimeout(() => {
      refreshSongs(nameTrimmed).catch(() => {});
    }, 600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nameTrimmed, runId]);
  // Reattach to a song run started before this page loaded (refresh, another
  // tab) so progress + Stop keep working.
  useEffect(() => {
    const n = name.trim();
    if (!n || runId) return;
    listRuns()
      .then((rs) => {
        const active = [...rs].reverse().find((r) => r.status === "running" && r.scenario === n && r.mode === "song");
        if (active) attachTail(active.id, n, active.startedAt ?? Date.now());
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  const attachTail = (id: string, project: string, startedAt: number) => {
    stopTail();
    setRunId(id);
    setRunLog("");
    tailClose.current = tailRun(
      id,
      (line) => setRunLog((prev) => (prev + line).slice(-12000)),
      (status) => {
        // A finished take seeds the song pace so the NEXT run's menu
        // countdown (Time Remaining) ticks from the first second. Failures
        // and cancels record nothing — they are not pace samples.
        if (status === "done") recordSongPaceDuration(Date.now() - startedAt);
        setRunId(null);
        stopTail();
        refreshSongs(project).catch(() => {});
        onProjectsChanged?.();
      },
    );
  };

  // Delete one generated take: confirm first, then remove the mp3 from
  // disk + repoint project_songs.file_path in the DB (server-side).
  const handleDeleteSong = async (file: string) => {
    const project = name.trim();
    if (!project || deletingFile) return;
    const ok = await dialog.confirm(
      `Delete "${file}" permanently? This removes the audio file and its database record. This cannot be undone.`,
      { title: `Delete ${file}?`, tone: "error", okText: "Delete", cancelText: "Keep" },
    );
    if (!ok) return;
    setDeletingFile(file);
    setError(null);
    try {
      await deleteSong(project, file);
      setSongs((prev) => prev.filter((s) => s.file !== file));
      onProjectsChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed.");
    } finally {
      setDeletingFile(null);
    }
  };

  // Switching the mode stamps the whole tuned value set (style tags with the
  // mode's default voice, bpm, key, language, time-sig/seed/steps + sampling).
  // Lyrics + project name are kept.
  const applyPreset = (id: string) => {
    const p = songPresetById(id);
    setPresetId(p.id);
    setVocal(p.defaultVocal);
    setTags(buildPresetTags(p, p.defaultVocal));
    setBpm(p.bpm);
    setLanguage(p.language);
    setKeyscale(p.keyscale);
    setTimesignature(p.timesignature);
    setSteps(p.steps);
    setCfgScale(p.cfgScale);
    setTemperature(p.temperature);
    setEstimateNote(null);
    if (autoDuration && lyrics.trim()) {
      setDuration(estimateSongDurationLocal(lyrics, p.id));
    }
  };

  // Switching the voice swaps only the singer/narrator instruction inside the
  // style tags (old voice phrase stripped first) — hand-edits to the style
  // portion are preserved. Song modes sing, narration modes narrate.
  const applyVocal = (v: VocalId) => {
    setVocal(v);
    setTags((prev) => applyVocalToTags(prev, presetId, v));
  };

  // Switching the audio model stamps that model's tuned sampling defaults
  // (MiniMax needs ~30 steps + 1.7 cfg; ACE-Step uses the preset's own
  // steps/cfg). Lyrics + project name are kept.
  const applySongModel = (m: AudioModelId) => {
    setSongModel(m);
    if (m === "minimax") {
      setSteps(30);
      setCfgScale(1.7);
    } else {
      setSteps(songPresetById(presetId).steps);
      setCfgScale(songPresetById(presetId).cfgScale);
    }
  };

  // Auto length: lyrics edits re-estimate locally (debounced below).
  useEffect(() => {
    if (!autoDuration || runId != null) return;
    if (!lyrics.trim()) return;
    const t = window.setTimeout(() => {
      setDuration(estimateSongDurationLocal(lyrics, presetId));
    }, 700);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lyrics, presetId, autoDuration]);

  // AI length: the local LLM reads the lyrics + mode and returns the exact
  // singable seconds (falls back to the local heuristic when the LLM is down).
  const handleAiEstimate = async () => {
    if (!lyrics.trim() || estimating) return;
    setEstimating(true);
    setEstimateNote(null);
    setError(null);
    try {
      const r = await estimateSongLength(lyrics, presetId, language);
      setDuration(r.duration);
      if (Number.isFinite(Number(r.bpm))) setBpm(Math.min(300, Math.max(10, Math.round(Number(r.bpm)))));
      if (typeof r.keyscale === "string" && r.keyscale.trim()) setKeyscale(r.keyscale.trim().slice(0, 24));
      setEstimateNote(
        r.source === "llm"
          ? `AI set ${r.duration}s${r.reasoning ? ` — ${r.reasoning}` : ""}`
          : `LLM offline — heuristic set ${r.duration}s`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI estimate failed.");
    } finally {
      setEstimating(false);
    }
  };

  const audioBlock = () => ({
    ...(tags.trim() ? { tags: tags.trim() } : { tags: "" }),
    lyrics: lyrics.trim(),
    duration: Math.min(1000, Math.max(1, Number(duration) || 120)),
    bpm: Math.min(300, Math.max(10, Number(bpm) || 95)),
    language,
    keyscale: keyscale.trim() || "E minor",
    timesignature,
    seed: Math.max(0, Number(seed) || 0),
    steps: Math.min(100, Math.max(1, Number(steps) || 8)),
    cfgScale,
    temperature,
    topP: 0.9,
    topK: 0,
    minP: 0,
    // Which mode + voice tuned these values (server + runner need no branch —
    // the values above are already mode-tuned; these are for UI restore).
    songPreset: presetId,
    songVocal: vocal,
    // Audio model rendering sung takes ("ace-step" | "minimax"); the runner
    // normalizes anything else to ace-step. Narration presets ignore it.
    songModel,
  });

  const save = async (): Promise<string> => {
    const n = name.trim();
    if (!n) throw new Error("Song project name is required.");
    if (!lyrics.trim()) throw new Error("Lyrics are required — write or paste the song text first.");
    await saveScenario(n, {
      ...(description.trim() ? { description: description.trim() } : {}),
      referencePrompt: "",
      duration: Math.min(1000, Math.max(1, Number(duration) || 120)),
      sequence: [],
      // Audio project (projects.project_type) — never VIDEO from this tab.
      project_type: "AUDIO",
      // Immutable storage folder hint (server is authoritative).
      folder_name: slugFolder(n),
      audio: audioBlock(),
    });
    setSaved(n);
    onProjectsChanged?.();
    return n;
  };

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const n = await save();
      await refreshSongs(n);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  const handleGenerate = async () => {
    if (runId) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const n = await save();
      const d = await startRun(n, { mode: "song", songModel });
      if (d.error) throw new Error(d.error);
      if (!d.id) throw new Error("server did not start a run");
      attachTail(d.id, n, Date.now());
      onProjectsChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generate failed.");
    } finally {
      setBusy(false);
    }
  };

  const applySongForm = (s: {
    description?: string | null; tags?: string | null; lyrics?: string | null;
    duration?: number | null; bpm?: number | null; language?: string | null;
    keyscale?: string | null; timesignature?: string | null;
    seed?: number | null; steps?: number | null;
    cfgScale?: number | null; temperature?: number | null;
    songPreset?: string | null; songVocal?: string | null;
    songModel?: string | null;
  } | null, fallbackDesc = "") => {
    if (s) {
      if (typeof s.description === "string") setDescription(s.description);
      if (typeof s.songPreset === "string" && SONG_PRESETS.some((p) => p.id === s.songPreset)) {
        setPresetId(s.songPreset);
      }
      if (isVocalId(s.songVocal)) {
        setVocal(s.songVocal);
      } else if (typeof s.songPreset === "string") {
        setVocal(songPresetById(s.songPreset).defaultVocal);
      }
      // Old rows predate the column (null) = ace-step, the original engine.
      setSongModel(isAudioModelId(s.songModel) ? s.songModel : "ace-step");
      if (typeof s.tags === "string") setTags(s.tags);
      if (typeof s.lyrics === "string") setLyrics(s.lyrics);
      if (Number.isFinite(Number(s.duration))) {
        setDuration(Number(s.duration));
        setAutoDuration(false);
      }
      if (Number.isFinite(Number(s.bpm))) setBpm(Number(s.bpm));
      if (typeof s.language === "string") setLanguage(s.language);
      if (typeof s.keyscale === "string") setKeyscale(s.keyscale);
      if (typeof s.timesignature === "string") setTimesignature(s.timesignature);
      if (Number.isFinite(Number(s.seed))) setSeed(Number(s.seed));
      if (Number.isFinite(Number(s.steps))) setSteps(Number(s.steps));
      if (Number.isFinite(Number(s.cfgScale))) setCfgScale(Number(s.cfgScale));
      if (Number.isFinite(Number(s.temperature))) setTemperature(Number(s.temperature));
    } else {
      setDescription(fallbackDesc);
    }
  };

  // Load a saved song project into the whole form (Create Song fields +
  // Generated Songs list). Reads the project_songs row first; falls back to
  // the scenario config audio block when the DB is down.
  const loadProject = async (n: string) => {
    const t = n.trim();
    if (!t) {
      setError("Enter a project name to load.");
      return;
    }
    setLoading(true);
    setError(null);
    setSongFile(null);
    try {
      let filled = false;
      try {
        const r = await getProjectSong(t);
        if (r.song) {
          applySongForm(r.song);
          // Stored take pointer (project_songs.file_path) — file name for
          // display, full URL already covered by the Generated Songs list.
          setSongFile(r.song.file ?? (r.song.file_path ? r.song.file_path.split("/").pop() ?? null : null));
          filled = true;
        }
      } catch {
        // DB/table unavailable — fall through to the scenario config.
      }
      if (!filled) {
        const r = await getScenario(t);
        const c = r.config;
        setDescription(typeof c.description === "string" ? c.description : "");
        const a = c.audio && typeof c.audio === "object" ? c.audio : null;
        if (a) {
          if (typeof a.songPreset === "string" && SONG_PRESETS.some((p) => p.id === a.songPreset)) {
            setPresetId(a.songPreset);
          }
          if (isVocalId(a.songVocal)) {
            setVocal(a.songVocal);
          } else if (typeof a.songPreset === "string") {
            setVocal(songPresetById(a.songPreset).defaultVocal);
          }
          setSongModel(isAudioModelId(a.songModel) ? a.songModel : "ace-step");
          setTags(typeof a.tags === "string" ? a.tags : "");
          setLyrics(typeof a.lyrics === "string" ? a.lyrics : "");
          if (Number.isFinite(Number(a.duration))) {
            setDuration(Number(a.duration));
            setAutoDuration(false);
          }
          if (Number.isFinite(Number(a.bpm))) setBpm(Number(a.bpm));
          if (typeof a.language === "string") setLanguage(a.language);
          if (typeof a.keyscale === "string") setKeyscale(a.keyscale);
          if (typeof a.timesignature === "string") setTimesignature(a.timesignature);
          if (Number.isFinite(Number(a.seed))) setSeed(Number(a.seed));
          if (Number.isFinite(Number(a.steps))) setSteps(Number(a.steps));
          if (Number.isFinite(Number(a.cfgScale))) setCfgScale(Number(a.cfgScale));
          if (Number.isFinite(Number(a.temperature))) setTemperature(Number(a.temperature));
        }
      }
      setSaved(t);
      await refreshSongs(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleLoad = async () => {
    await loadProject(name);
  };

  // External open (Home card / Projects panel / Open-project button for an
  // AUDIO project): select it and load its saved form + songs at once, so
  // clicking the project always shows its data.
  useEffect(() => {
    if (!focusProject || !focusProject.name.trim()) return;
    setName(focusProject.name.trim());
    void loadProject(focusProject.name.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusProject]);

  const generating = runId != null;
  const fmtBytes = (b: number) =>
    b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

  return (
    <div className="song-page">
      <section className={`card song-form-card${formCollapsed ? " collapsed" : ""}`} aria-label="Create Song">
        <div className="card-head">
          <h2>Create Song</h2>
          {saved && <span className="pill ok">AUDIO · {saved}</span>}
          {songFile && <span className="muted" title={`Saved take: ${songFile}`}>♪ {songFile}</span>}
          <span className="spacer" />
          <button
            className="icon-btn"
            onClick={toggleFormCollapsed}
            title={formCollapsed ? "Show create song" : "Hide create song"}
            aria-label={formCollapsed ? "Show create song" : "Hide create song"}
            aria-expanded={!formCollapsed}
          >
            <IconPanel size={15} />
          </button>
        </div>
        <Collapse open={!formCollapsed}>
        <p className="card-desc">
          Write lyrics, pick the style and render a full song with the selected audio model.
          Saved in the projects table as <b>AUDIO</b>.
        </p>
        <div className="dialog-actions song-actions song-actions-top">
          <button type="button" className="ghost" onClick={handleSave} disabled={busy || generating || !name.trim()}>
            {busy && !generating && <Spinner size={13} />}
            Save Audio
          </button>
          <button type="button" className="primary" onClick={handleGenerate} disabled={busy || generating || !name.trim() || !lyrics.trim()}>
            {generating && <Spinner size={13} />}
            {generating ? "Generating…" : "Generate Song"}
          </button>
        </div>
        <div className="song-grid">
          <label htmlFor="song-name">Project Name *</label>
          <div className="song-name-row">
            <input
              id="song-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My new song"
              disabled={busy || generating}
              maxLength={60}
            />
            <button type="button" className="ghost" onClick={handleLoad} disabled={loading || busy || generating || !name.trim()}>
              {loading ? "Loading…" : "Load"}
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <div>
              <label htmlFor="song-preset">Song Mode *</label>
              <select
                id="song-preset"
                value={presetId}
                onChange={(e) => applyPreset(e.target.value)}
                disabled={busy || generating}
                style={{ width: "100%", marginTop: 4 }}
              >
                {SONG_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="song-vocal">Vocal *</label>
              <select
                id="song-vocal"
                value={vocal}
                onChange={(e) => isVocalId(e.target.value) && applyVocal(e.target.value)}
                disabled={busy || generating}
                style={{ width: "100%", marginTop: 4 }}
              >
                {VOCAL_OPTIONS.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="song-model">Audio Model *</label>
              <select
                id="song-model"
                value={songModel}
                onChange={(e) => isAudioModelId(e.target.value) && applySongModel(e.target.value)}
                disabled={busy || generating || songPresetById(presetId).narration}
                title={songPresetById(presetId).narration
                  ? "Narration presets speak via Edge-TTS voices — no music model is used"
                  : "Which AI music model renders the sung take"}
                style={{ width: "100%", marginTop: 4 }}
              >
                {AUDIO_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="muted" style={{ margin: "0" }}>
            {songPresetById(presetId).hint}{" "}
            {songPresetById(presetId).narration
              ? "The AI narrates in the selected voice."
              : "The AI sings in the selected voice."}
          </p>
          <p className="muted" style={{ margin: "0" }}>
            {songPresetById(presetId).narration
              ? "Narration uses Edge-TTS voices, so the audio model above does not apply."
              : audioModelById(songModel).hint}
          </p>
          <label htmlFor="song-desc">Description</label>
          <input
            id="song-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What is this song about?"
            disabled={busy || generating}
            maxLength={240}
          />
          <label htmlFor="song-tags">Style / Tags <span className="muted">(auto from mode — editable)</span></label>
          <textarea
            id="song-tags"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="e.g. filmi piano, soft strings, slow emotional chorus, high tenor"
            disabled={busy || generating}
            rows={2}
          />
          <label htmlFor="song-lyrics">Lyrics *</label>
          <textarea
            id="song-lyrics"
            value={lyrics}
            onChange={(e) => setLyrics(e.target.value)}
            placeholder="मुखड़ा…&#10;&#10;नन्हे कदम, नन्ही-सी हँसी…"
            disabled={busy || generating}
            rows={12}
            className="song-lyrics"
          />
          <div className="song-params">
            <div>
              <label htmlFor="song-duration">Duration (s)</label>
              <input
                id="song-duration"
                type="number"
                min={1}
                max={1000}
                value={duration}
                onChange={(e) => { setDuration(Number(e.target.value)); setAutoDuration(false); }}
                disabled={busy || generating || autoDuration}
                title={autoDuration ? "Auto length follows the lyrics — uncheck Auto to edit" : undefined}
              />
              <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4, fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={autoDuration}
                  onChange={(e) => {
                    setAutoDuration(e.target.checked);
                    if (e.target.checked && lyrics.trim()) {
                      setDuration(estimateSongDurationLocal(lyrics, presetId));
                    }
                  }}
                  disabled={busy || generating}
                />
                Auto length
              </label>
              <button
                type="button"
                className="ghost"
                onClick={handleAiEstimate}
                disabled={busy || generating || estimating || !lyrics.trim()}
                title="Ask the local LLM to read the lyrics and set the exact singable length"
                style={{ marginTop: 4 }}
              >
                {estimating ? "Analyzing…" : "✨ AI length"}
              </button>
              {estimateNote && <p className="muted" style={{ margin: "4px 0 0" }}>{estimateNote}</p>}
            </div>
            <div>
              <label htmlFor="song-bpm">BPM</label>
              <input
                id="song-bpm"
                type="number"
                min={10}
                max={300}
                value={bpm}
                onChange={(e) => setBpm(Number(e.target.value))}
                disabled={busy || generating}
              />
            </div>
            <div>
              <label htmlFor="song-lang">Language</label>
              <select id="song-lang" value={language} onChange={(e) => setLanguage(e.target.value)} disabled={busy || generating}>
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="song-key">Key / Scale</label>
              <input
                id="song-key"
                value={keyscale}
                onChange={(e) => setKeyscale(e.target.value)}
                placeholder="E minor"
                disabled={busy || generating}
                maxLength={24}
              />
            </div>
            {/* Time Sig / Seed / Steps are auto-fit per song mode (4/4, fixed
                seed, mode-tuned steps) — no user input needed. */}
          </div>
        </div>
        {error && (
          <p className="err-text" role="alert">
            {error}
          </p>
        )}
        {saved && !error && (
          <p role="status" style={{ color: "var(--ok)" }}>
            Saved "{saved}" as AUDIO.
            {onOpenProject && (
              <>
                {" "}
                <button type="button" className="ghost" onClick={() => onOpenProject(saved)} disabled={busy}>
                  Open project
                </button>
              </>
            )}
          </p>
        )}
        {generating && (
          <div className="song-run" role="status" aria-label="Song generation progress">
            <p className="muted">Rendering with {songPresetById(presetId).narration ? "Edge-TTS" : audioModelById(songModel).name} — this takes a few minutes…</p>
            {runLog && <pre ref={songLogRef} className="run-log">{runLog}</pre>}
          </div>
        )}
        </Collapse>
      </section>

      <section className={`card song-list-card${songsCollapsed ? " collapsed" : ""}`} aria-label="Generated Songs">
        <div className="card-head">
          <h2>Generated Songs</h2>
          <span className="spacer" />
          <button
            type="button"
            className="ghost"
            onClick={() => refreshSongs(name)}
            disabled={songsLoading || !name.trim()}
            title="Reload the song list"
          >
            {songsLoading ? "Loading…" : "Refresh"}
          </button>
          <button
            className="icon-btn"
            onClick={toggleSongsCollapsed}
            title={songsCollapsed ? "Show generated songs" : "Hide generated songs"}
            aria-label={songsCollapsed ? "Show generated songs" : "Hide generated songs"}
            aria-expanded={!songsCollapsed}
          >
            <IconPanel size={15} />
          </button>
        </div>
        <Collapse open={!songsCollapsed}>
        {error && (
          <p className="err-text" role="alert">
            {error}
          </p>
        )}
        {!name.trim() ? (
          <p className="muted">Enter a project name above to see its songs.</p>
        ) : songsLoading && songs.length === 0 ? (
          <p className="muted"><Spinner size={13} /> Loading songs…</p>
        ) : songs.length === 0 ? (
          <p className="muted">No songs yet — press Generate Song to render the first take.</p>
        ) : (
          <ol className="song-list">
            {songs.map((s) => (
              <li key={s.file} className="song-item">
                <div className="song-item-head">
                  <span className="pill">v{s.version}</span>
                  <span className="song-file" title={s.file}>{s.file}</span>
                  <span className="muted">{fmtBytes(s.bytes)}</span>
                  <span className="spacer" />
                  <a className="ghost" href={s.url} download={s.file} title={`Download ${s.file}`}>
                    Download
                  </a>
                  <button
                    type="button"
                    className="ghost danger"
                    onClick={() => handleDeleteSong(s.file)}
                    disabled={deletingFile === s.file || generating}
                    title={`Delete ${s.file}`}
                  >
                    {deletingFile === s.file ? "Deleting…" : "Delete"}
                  </button>
                </div>
                <audio controls preload="none" src={s.url} className="song-player" />
              </li>
            ))}
          </ol>
        )}
        </Collapse>
      </section>
    </div>
  );
}
