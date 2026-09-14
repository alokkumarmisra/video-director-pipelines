import { useEffect, useRef, useState } from "react";
import { craftVideoMeta } from "../api";
import type { Scenario } from "../types";
import { IconCheck, IconClipboard, IconPanel, IconRefresh, IconSparkles, Spinner } from "./Icons";

interface Props {
  /** Base scenario name ("" when nothing selected). */
  name: string;
  /** Saved (or draft) scenario config — the LLM drafts copy from this. */
  config: Scenario | null;
}

async function copyText(t: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    // Clipboard API unavailable (permissions / non-secure context) —
    // fall back to the legacy execCommand path.
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// Publishing copy for the finished video: an LLM-drafted Title, Description
// and hashtags from the scenario JSON (description / character / beats).
// Stateless server-side — the result is cached per project in localStorage
// and stays editable so it can be tweaked before copying to YouTube / Reels.
export default function VideoMetaPanel({ name, config }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("ss-sec-meta") === "closed");
  const copyTimer = useRef<number | null>(null);
  const toggleCollapsed = () =>
    setCollapsed((c) => {
      localStorage.setItem("ss-sec-meta", c ? "open" : "closed");
      return !c;
    });

  // Per-project cache: switching projects restores that project's copy (or
  // a blank slate when nothing was generated yet). Never auto-generates —
  // the LLM call is always an explicit click.
  useEffect(() => {
    if (!name) {
      setTitle("");
      setDescription("");
      setHashtags([]);
      setError("");
      return;
    }
    try {
      const raw = localStorage.getItem(`ss-video-meta:${name}`);
      if (raw) {
        const c = JSON.parse(raw);
        setTitle(typeof c.title === "string" ? c.title : "");
        setDescription(typeof c.description === "string" ? c.description : "");
        setHashtags(Array.isArray(c.hashtags) ? c.hashtags.filter((t: unknown) => typeof t === "string") : []);
        setError("");
        return;
      }
    } catch { /* corrupt cache — start blank */ }
    setTitle("");
    setDescription("");
    setHashtags([]);
    setError("");
  }, [name]);
  useEffect(() => {
    if (!name) return;
    if (!title && !description && !hashtags.length) return;
    try {
      localStorage.setItem(`ss-video-meta:${name}`, JSON.stringify({ title, description, hashtags }));
    } catch { /* storage full / unavailable — the panel still works in-memory */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, title, description, hashtags]);
  useEffect(() => () => {
    if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
  }, []);

  if (!name) return null;

  const hasSequence = !!config && Array.isArray(config.sequence) && config.sequence.length > 0;
  const hasMeta = !!(title || description || hashtags.length);
  const tagLine = hashtags.map((t) => `#${t}`).join(", ");

  const generate = async () => {
    if (!config || busy) return;
    setBusy(true);
    setError("");
    setSeconds(0);
    const t0 = Date.now();
    const tick = window.setInterval(() => setSeconds((Date.now() - t0) / 1000), 500);
    try {
      const meta = await craftVideoMeta(config);
      setTitle(meta.title || "");
      setDescription(meta.description || "");
      setHashtags(Array.isArray(meta.hashtags) ? meta.hashtags : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      window.clearInterval(tick);
      setBusy(false);
    }
  };

  const copy = async (id: string, text: string) => {
    if (!text) return;
    if (!(await copyText(text))) {
      setError("Copy failed — select the text and copy it manually.");
      return;
    }
    setCopied(id);
    if (copyTimer.current != null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1500);
  };

  const copyBtn = (id: string, text: string, label: string) => (
    <button
      className="meta-copy"
      onClick={() => void copy(id, text)}
      disabled={!text}
      title={label}
      aria-label={label}
    >
      {copied === id ? <IconCheck size={13} /> : <IconClipboard size={13} />}
      {copied === id ? "Copied" : "Copy"}
    </button>
  );

  return (
    <section className={`card meta-card${collapsed ? " collapsed" : ""}`} aria-label={`Video info for ${name}`}>
      <div className="card-head">
        <h2>
          <span className="head-icon hi-output"><IconClipboard size={15} /></span>
          Video Info · Title &amp; Tags
        </h2>
        {busy && (
          <span className="pill running">
            <Spinner size={11} />
            {Math.round(seconds)}s
          </span>
        )}
        <span className="platform-title" title="Publishing target">[YOUTUBE-INSTAGRAM]</span>
        <span className="spacer" />
        <button
          className="icon-btn"
          onClick={toggleCollapsed}
          title={collapsed ? "Show video info" : "Hide video info"}
          aria-label={collapsed ? "Show video info" : "Hide video info"}
          aria-expanded={!collapsed}
        >
          <IconPanel size={15} />
        </button>
      </div>

      {!collapsed && (
        <>
          <p className="card-desc">
            Publishing copy for <b>{name}</b> — drafted by the local LLM from this project's story and visuals.
          </p>
          {!hasMeta && !busy && (
            <div className="empty" style={{ padding: "20px 12px" }}>
              <span className="empty-title">No copy yet</span>
              <span className="empty-sub">Generate a title, description and hashtags for this video.</span>
            </div>
          )}
          {(hasMeta || busy) && (
            <>
              <label htmlFor="meta-title">Title</label>
              <div className="meta-field">
                <input
                  id="meta-title"
                  value={title}
                  placeholder="Video title…"
                  maxLength={140}
                  disabled={busy}
                  onChange={(e) => setTitle(e.target.value)}
                />
                {copyBtn("title", title, "Copy title")}
              </div>
              <label htmlFor="meta-desc">Description</label>
              <div className="meta-field">
                <textarea
                  id="meta-desc"
                  rows={4}
                  value={description}
                  placeholder="Video description…"
                  disabled={busy}
                  onChange={(e) => setDescription(e.target.value)}
                />
                {copyBtn("description", description, "Copy description")}
              </div>
              <label id="meta-tags-label">Hashtags</label>
              {hashtags.length > 0 ? (
                <>
                  <div className="meta-tags" role="group" aria-labelledby="meta-tags-label">
                    {hashtags.map((t) => (
                      <button
                        key={t}
                        className="vchip"
                        onClick={() => void copy(`tag:${t}`, `#${t}`)}
                        title={`Copy #${t}`}
                      >
                        {copied === `tag:${t}` ? <IconCheck size={11} /> : null}#{t}
                      </button>
                    ))}
                  </div>
                  <div className="row" style={{ marginTop: 8, justifyContent: "flex-end" }}>
                    {copyBtn("tags", tagLine, "Copy all hashtags")}
                  </div>
                </>
              ) : (
                <p className="hint" style={{ marginTop: 0 }}>No hashtags yet — generate them below.</p>
              )}
            </>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="primary"
              onClick={() => void generate()}
              disabled={busy || !hasSequence}
              title={
                !hasSequence
                  ? "Add at least one scene first — the copy is drafted from the project's beats"
                  : hasMeta
                    ? "Draft fresh copy — replaces the title, description and hashtags above"
                    : "Draft title, description and hashtags for this video"
              }
            >
              {busy ? <Spinner size={13} /> : hasMeta ? <IconRefresh size={13} /> : <IconSparkles size={13} />}
              {busy ? "Drafting…" : hasMeta ? "Regenerate" : "Generate title & tags"}
            </button>
            {hasMeta && (
              <button
                className="meta-copy"
                onClick={() => void copy("all", `${title}\n\n${description}\n\n${tagLine}`.trim())}
                disabled={busy || (!title && !description)}
                title="Copy title + description + hashtags as one block"
              >
                {copied === "all" ? <IconCheck size={13} /> : <IconClipboard size={13} />}
                {copied === "all" ? "Copied" : "Copy all"}
              </button>
            )}
          </div>
          {error && <p className="hint err-text">{error}</p>}
          <p className="hint">
            Edits are kept per project in this browser. Regenerate drafts fresh copy from the current scenes.
          </p>
        </>
      )}
    </section>
  );
}
