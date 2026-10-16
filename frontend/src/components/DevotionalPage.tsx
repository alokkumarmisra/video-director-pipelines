// Devotional Studio — canonical asset library for devotional/mythological
// filmmaking (characters, locations, props, styles + reference studio,
// approval queue, version history, project usage, health).
// Mounted from App.tsx as the "Devotional" nav view (stays mounted, hidden
// when inactive — same pattern as every other top-level view).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDialog } from "./Dialog";
import { type MediaSession } from "./DevotionalMediaProgress";
import DevotionalMediaSection from "./DevotionalMediaSection";
import { IconCheck, IconDatabase, IconEye, IconFilm, IconMusic, IconRefresh, IconSparkles, IconTrash, IconUpload, IconX, Spinner } from "./Icons";
import {
  archiveDevotionalAsset, cancelDevotionalJob, createDevotionalAsset, deleteDevotionalFile,
  exportDevotional, generateDevotionalClip, generateDevotionalMedia, generateDevotionalReference, getDevotionalAsset, getDevotionalBoardLinks,
  getDevotionalHealth, getDevotionalStats, getDevotionalUsage, importDevotional,
  listDevotionalAssets, listDevotionalJobs, lockDevotionalAsset, newDevotionalVersion,
  previewDevotionalPrompt, recordDevotionalUsage, resolveDevotionalScene,
  restoreDevotionalVersion, saveDevotionalSceneLinks, seedDevotionalLibrary,
  setDevotionalStatus, updateDevotionalAsset, uploadDevotionalFile,
  type DevotionalAsset, type DevotionalDetail, type DevotionalJob, type DevotionalKind, type DevotionalStats,
} from "../devotionalApi";

type Tab = "dashboard" | "characters" | "locations" | "props" | "styles" | "studio" | "review" | "usage" | "versions" | "settings";
const TAB_KIND: Partial<Record<Tab, DevotionalKind>> = {
  characters: "character", locations: "location", props: "prop", styles: "style",
};
const KIND_LABEL: Record<DevotionalKind, string> = {
  character: "Character", location: "Location", prop: "Prop", style: "Style",
};

const statusPill = (s: string) =>
  s === "approved" ? "pill ok" : s === "review" ? "pill warn" : s === "generating" ? "pill running" : s === "archived" ? "pill" : "pill";

const fmtTime = (v: unknown) => {
  const t = v ? new Date(String(v)).getTime() : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleString() : "—";
};

const isVideoFile = (p: string) => /\.(mp4|webm|mov)$/i.test(String(p || ""));

function Empty({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="hint" style={{ padding: "28px 12px", textAlign: "center", border: "1px dashed var(--line)", borderRadius: "var(--radius-m)" }}>
      <div style={{ marginBottom: 8 }}>{text}</div>
      {action}
    </div>
  );
}

export default function DevotionalPage() {
  const dialog = useDialog();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [stats, setStats] = useState<DevotionalStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);
  // One-click media sessions (library Generate / detail Still+clip): live
  // here at the page root so progress survives tab switches — the cards and
  // the detail dialog render inline loading bars with % instead of a
  // fire-and-forget "track it in Reference Studio" alert.
  const [mediaSessions, setMediaSessions] = useState<MediaSession[]>([]);
  const queueMediaSession = useCallback((assetId: string, assetName: string, jobIds: string[], kinds?: ("reference" | "video")[]) => {
    if (!jobIds.length) return;
    setMediaSessions((s) => [
      ...s.filter((x) => x.assetId !== assetId),
      { assetId, assetName, jobIds, kinds, startedAt: Date.now() },
    ]);
  }, []);
  const dropMediaSession = useCallback((assetId: string) => {
    setMediaSessions((s) => s.filter((x) => x.assetId !== assetId));
  }, []);
  const mediaDone = useCallback((assetId: string) => {
    refresh();
    setMediaSessions((s) => s.filter((x) => x.assetId !== assetId));
  }, [refresh]);
  // Bulk-regen selection (Keyframes → clips pattern): checked asset ids,
  // shared by the library cards and the detail dialog section checkbox.
  const [checkedAssets, setCheckedAssets] = useState<string[]>([]);
  const toggleCheckedAsset = useCallback((assetId: string) => {
    setCheckedAssets((s) => (s.includes(assetId) ? s.filter((x) => x !== assetId) : [...s, assetId]));
  }, []);
  const clearCheckedAssets = useCallback(() => setCheckedAssets([]), []);

  useEffect(() => {
    let dead = false;
    getDevotionalStats()
      .then((s) => { if (!dead) { setStats(s); setStatsErr(null); } })
      .catch((e) => { if (!dead) setStatsErr(e instanceof Error ? e.message : String(e)); });
    return () => { dead = true; };
  }, [refreshTick, tab]);

  const tabs: { id: Tab; label: string }[] = [
    { id: "dashboard", label: "Dashboard" },
    { id: "characters", label: "Characters" },
    { id: "locations", label: "Locations" },
    { id: "props", label: "Props" },
    { id: "styles", label: "Styles & Presets" },
    { id: "studio", label: "Reference Studio" },
    { id: "review", label: "Review" },
    { id: "usage", label: "Projects & Usage" },
    { id: "versions", label: "Versions" },
    { id: "settings", label: "Settings & Health" },
  ];

  return (
    <section className="card" aria-label="Devotional Studio">
      <div className="card-head">
        <h2><span className="head-icon hi-ref"><IconSparkles size={15} /></span>Devotional Studio</h2>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={refresh} title="Reload devotional data"><IconRefresh size={13} /> Refresh</button>
      </div>
      <div className="row" role="tablist" aria-label="Devotional sections" style={{ gap: 6, flexWrap: "wrap" }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`btn sm${tab === t.id ? " primary" : " ghost"}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === "review" && stats && stats.drafts > 0 && (
              <span className="pill warn" style={{ marginLeft: 6 }}>{stats.drafts}</span>
            )}
          </button>
        ))}
      </div>
      {statsErr && <p className="hint" style={{ color: "var(--err)" }}>Library unavailable: {statsErr} — is the backend running?</p>}
      <div style={{ marginTop: 12 }}>
        {tab === "dashboard" && <Dashboard stats={stats} onSeed={refresh} onGo={setTab} />}
        {(tab === "characters" || tab === "locations" || tab === "props" || tab === "styles") && (
          <LibraryTab
            key={tab} kind={TAB_KIND[tab]!} onChanged={refresh}
            sessions={mediaSessions} onMediaQueued={queueMediaSession}
            onMediaDone={mediaDone} onMediaDismiss={dropMediaSession}
            checkedAssets={checkedAssets} onToggleCheck={toggleCheckedAsset}
            onClearChecks={clearCheckedAssets}
          />
        )}
        {tab === "studio" && <StudioTab onChanged={refresh} />}
        {tab === "review" && <ReviewTab onChanged={refresh} />}
        {tab === "usage" && <UsageTab />}
        {tab === "versions" && <VersionsTab />}
        {tab === "settings" && <SettingsTab onChanged={refresh} />}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- dashboard
function Dashboard({ stats, onSeed, onGo }: { stats: DevotionalStats | null; onSeed: () => void; onGo: (t: Tab) => void }) {
  const dialog = useDialog();
  const [seeding, setSeeding] = useState(false);
  const seed = async () => {
    if (!await dialog.confirm("Seed the starter library (suggested deities, places, props, styles)? Existing entries are never overwritten.", { title: "Seed library" })) return;
    setSeeding(true);
    try {
      const r = await seedDevotionalLibrary();
      await dialog.alert(`Seeded ${r.created.length} entries${r.skipped.length ? `, skipped ${r.skipped.length} existing` : ""}.`, { title: "Library seeded", tone: "success" });
      onSeed();
    } catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Seed failed", tone: "error" }); }
    finally { setSeeding(false); }
  };
  const cards = stats ? [
    { label: "Characters", n: stats.counts.character, go: "characters" as Tab },
    { label: "Locations", n: stats.counts.location, go: "locations" as Tab },
    { label: "Props", n: stats.counts.prop, go: "props" as Tab },
    { label: "Styles", n: stats.counts.style, go: "styles" as Tab },
    { label: "Approved", n: stats.approved, go: "review" as Tab },
    { label: "Awaiting review", n: stats.drafts, go: "review" as Tab },
    { label: "Failed / pending jobs", n: stats.failedJobs, go: "studio" as Tab },
    { label: "Projects using assets", n: stats.projectsUsing, go: "usage" as Tab },
  ] : [];
  return (
    <div>
      {!stats ? (
        <Empty text="Loading library statistics…" />
      ) : (stats.counts.character + stats.counts.location + stats.counts.prop + stats.counts.style) === 0 ? (
        <Empty
          text="The devotional library is empty. Seed the starter collection (Krishna, Rama, Vrindavan, flute, …) or create your first entry."
          action={<span style={{ display: "inline-flex", gap: 8 }}>
            <button className="primary" onClick={seed} disabled={seeding}>{seeding ? <Spinner size={13} /> : <IconSparkles size={13} />} Seed starter library</button>
            <button className="ghost" onClick={() => onGo("characters")}>Create a character</button>
          </span>}
        />
      ) : (
        <>
          <div className="grid grid-3" style={{ marginBottom: 12 }}>
            {cards.map((c) => (
              <button key={c.label} className="card" style={{ textAlign: "left", cursor: "pointer" }} onClick={() => onGo(c.go)} title={`Open ${c.label}`}>
                <div className="muted" style={{ fontSize: 12 }}>{c.label}</div>
                <div style={{ fontSize: 26, fontWeight: 700 }}>{c.n}</div>
              </button>
            ))}
          </div>
          <div className="row" style={{ marginBottom: 12 }}>
            <button className="btn sm" onClick={() => onGo("characters")}><IconDatabase size={13} /> New character</button>
            <button className="btn sm" onClick={() => onGo("locations")}><IconDatabase size={13} /> New location</button>
            <button className="btn sm" onClick={() => onGo("props")}><IconDatabase size={13} /> New prop</button>
            <button className="btn sm" onClick={() => onGo("styles")}><IconDatabase size={13} /> New style</button>
          </div>
          <h3 style={{ margin: "8px 0" }}>Recently updated</h3>
          {stats.recent.length === 0 ? <p className="hint">Nothing yet.</p> : (
            <div className="grid">
              {stats.recent.map((a) => (
                <div key={a.id} className="card" style={{ padding: 10 }}>
                  <div style={{ fontWeight: 600 }}>{a.name} <span className="muted">· {a.id}</span></div>
                  <div className="row" style={{ gap: 6, marginTop: 4 }}>
                    <span className="pill">{KIND_LABEL[a.kind as DevotionalKind] ?? a.kind}</span>
                    <span className={statusPill(a.status)}>{a.status}</span>
                    <span className="muted">v{a.version} · {fmtTime(a.updated_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- library tab
function LibraryTab({ kind, onChanged, sessions, onMediaQueued, onMediaDone, onMediaDismiss, checkedAssets, onToggleCheck, onClearChecks }: {
  kind: DevotionalKind; onChanged: () => void;
  sessions: MediaSession[];
  onMediaQueued: (assetId: string, assetName: string, jobIds: string[], kinds?: ("reference" | "video")[]) => void;
  onMediaDone: (assetId: string) => void;
  onMediaDismiss: (assetId: string) => void;
  checkedAssets: string[];
  onToggleCheck: (assetId: string) => void;
  onClearChecks: () => void;
}) {
  const dialog = useDialog();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("updated");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; pageSize: number; assets: DevotionalAsset[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  // `${assetId}:${what}` queue POST in flight (both | image | video).
  const [queueing, setQueueing] = useState<string | null>(null);
  const [bulkKind, setBulkKind] = useState<"clip" | "image" | "both">("clip");
  const [bulkBusy, setBulkBusy] = useState(false);
  const deb = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (p = page) => {
    setLoading(true);
    try {
      const d = await listDevotionalAssets({ kind, search: search.trim() || undefined, status: status || undefined, category: category.trim() || undefined, sort, page: p, pageSize: 24 });
      setData(d);
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [kind, search, status, category, sort, page]);

  useEffect(() => {
    if (deb.current) clearTimeout(deb.current);
    deb.current = setTimeout(() => { setPage(1); load(1); }, search ? 350 : 0);
    return () => { if (deb.current) clearTimeout(deb.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, search, status, category, sort]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  // One-click still + showcase clip from any library card. No success popup —
  // the card itself renders inline loading bars with % (tracked by job id)
  // until the media lands; only failures pop an alert.
  const generateMedia = async (a: DevotionalAsset) => {
    setQueueing(`${a.id}:both`);
    try {
      const r = await generateDevotionalMedia(a.id, {});
      onMediaQueued(a.id, a.name, r.jobs, r.image === "reused" ? ["video"] : ["reference", "video"]);
    } catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Queue failed", tone: "error" }); }
    finally { setQueueing(null); }
  };

  // Per-kind regen buttons in the Image & video section (new versions —
  // old files are kept, like the Keyframes → clips regen).
  const regenImage = async (a: DevotionalAsset, fileKind: string) => {
    setQueueing(`${a.id}:image`);
    try {
      const r = await generateDevotionalReference(a.id, { fileKind });
      onMediaQueued(a.id, a.name, [r.job], ["reference"]);
    } catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Queue failed", tone: "error" }); }
    finally { setQueueing(null); }
  };
  const regenVideo = async (a: DevotionalAsset) => {
    setQueueing(`${a.id}:video`);
    try {
      const r = await generateDevotionalClip(a.id, {});
      onMediaQueued(a.id, a.name, r.jobs, ["video"]);
    } catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Queue failed", tone: "error" }); }
    finally { setQueueing(null); }
  };

  // Bulk regenerate checked assets (Keyframes → clips pattern): one queued
  // job set per asset — the pump runs them serially, each card tracks its
  // own progress. Clip regens need an existing still, so imageless assets
  // are skipped with a count (their stills come from Images/Both instead).
  const bulkRegen = async () => {
    const list = (data?.assets ?? []).filter((a) => checkedAssets.includes(a.id));
    if (list.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    let queued = 0;
    let skipped = 0;
    const errors: string[] = [];
    try {
      for (const a of list) {
        if (sessions.some((s) => s.assetId === a.id)) { skipped++; continue; }
        const needsClip = bulkKind === "clip" || bulkKind === "both";
        if (needsClip && !a.preview_image) { skipped++; continue; }
        try {
          if (bulkKind === "image") {
            const r = await generateDevotionalReference(a.id, {});
            onMediaQueued(a.id, a.name, [r.job], ["reference"]);
          } else if (bulkKind === "clip") {
            const r = await generateDevotionalClip(a.id, {});
            onMediaQueued(a.id, a.name, r.jobs, ["video"]);
          } else {
            const r = await generateDevotionalMedia(a.id, {});
            onMediaQueued(a.id, a.name, r.jobs, r.image === "reused" ? ["video"] : ["reference", "video"]);
          }
          queued++;
        } catch (e) { errors.push(`${a.name}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    } finally {
      setBulkBusy(false);
      onClearChecks();
    }
    if (errors.length || skipped) {
      await dialog.alert(
        [...errors, skipped ? `${skipped} skipped (already generating or no still yet for clips)` : ""].filter(Boolean).join("\n"),
        { title: `Regenerated ${queued} of ${list.length}`, tone: errors.length ? "error" : "info" });
    }
  };

  // A tracked session finished: refresh the list (previews appear) + drop it.
  const handleDone = useCallback((assetId: string) => {
    load();
    onMediaDone(assetId);
  }, [load, onMediaDone]);

  return (
    <div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <input
          aria-label={`Search ${kind}s`}
          placeholder={`Search ${kind}s by name, id, alias…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: "1 1 220px" }}
        />
        <select aria-label="Status filter" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {["draft", "generating", "review", "approved", "archived"].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input aria-label="Category filter" placeholder="Category" value={category} onChange={(e) => setCategory(e.target.value)} style={{ width: 130 }} />
        <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="updated">Recently updated</option>
          <option value="name">Name A–Z</option>
          <option value="created">Recently created</option>
        </select>
        {(data?.assets.length ?? 0) > 0 && (
          <span className="beats-bulk" role="group" aria-label="Bulk regenerate checked assets">
            <button
              type="button"
              className="ghost beats-bulk-all"
              onClick={() => { for (const a of data?.assets ?? []) if (!checkedAssets.includes(a.id)) onToggleCheck(a.id); }}
              disabled={bulkBusy || (data?.assets ?? []).every((a) => checkedAssets.includes(a.id))}
              title="Check every asset below"
            >
              All
            </button>
            <button
              type="button"
              className="ghost beats-bulk-all"
              onClick={onClearChecks}
              disabled={bulkBusy || checkedAssets.length === 0}
              title="Uncheck every asset"
            >
              None
            </button>
            <select
              className="beats-bulk-kind"
              value={bulkKind}
              onChange={(e) => setBulkKind(e.target.value as "clip" | "image" | "both")}
              disabled={bulkBusy}
              title="What Regenerate rebuilds for each checked asset"
              aria-label="Bulk regenerate kind"
            >
              <option value="clip">Videos</option>
              <option value="image">Images</option>
              <option value="both">Both</option>
            </select>
            <button
              type="button"
              className="primary beats-bulk-go"
              onClick={() => void bulkRegen()}
              disabled={bulkBusy || checkedAssets.length === 0}
              title={checkedAssets.length === 0
                ? "Check one or more assets below first"
                : `Regenerate ${bulkKind === "both" ? "images + videos" : bulkKind === "image" ? "images only" : "videos only"} for ${checkedAssets.length} asset${checkedAssets.length === 1 ? "" : "s"} — queued one by one, old versions kept`}
            >
              <IconRefresh size={12} />
              {bulkBusy ? "Queueing…" : `Regenerate${checkedAssets.length > 0 ? ` (${checkedAssets.length})` : ""}`}
            </button>
          </span>
        )}
        <span className="spacer" />
        <button className="primary sm" onClick={() => setShowCreate(true)}>+ New {KIND_LABEL[kind].toLowerCase()}</button>
      </div>
      {err && <p className="hint" style={{ color: "var(--err)" }}>{err} <button className="btn sm ghost" onClick={() => load()}>Retry</button></p>}
      {loading && !data ? <p className="hint"><Spinner size={13} /> Loading…</p>
        : data && data.assets.length === 0 ? (
          <Empty text={`No ${kind}s yet. Create the first canonical ${kind} — it stays editable until you approve it.`} action={<button className="primary sm" onClick={() => setShowCreate(true)}>+ New {KIND_LABEL[kind].toLowerCase()}</button>} />
        ) : (
          <>
            <div className="grid">
              {(data?.assets ?? []).map((a) => (
                <AssetCard key={a.id} asset={a} onOpen={() => setSelected(a.id)}
                  onGenerate={() => void generateMedia(a)}
                  queueing={queueing}
                  onRegenImage={(fileKind) => void regenImage(a, fileKind)}
                  onRegenVideo={() => void regenVideo(a)}
                  session={sessions.find((s) => s.assetId === a.id) ?? null}
                  onDone={() => handleDone(a.id)} onDismiss={() => onMediaDismiss(a.id)}
                  checked={checkedAssets.includes(a.id)} onToggleCheck={() => onToggleCheck(a.id)} />
              ))}
            </div>
            {data && pages > 1 && (
              <div className="row" style={{ marginTop: 10, alignItems: "center" }}>
                <button className="btn sm ghost" disabled={page <= 1} onClick={() => { setPage(page - 1); load(page - 1); }}>← Prev</button>
                <span className="muted">Page {page} of {pages} · {data.total} total</span>
                <button className="btn sm ghost" disabled={page >= pages} onClick={() => { setPage(page + 1); load(page + 1); }}>Next →</button>
              </div>
            )}
            {data && (
              <GeneratedGallery kind={kind} assets={data.assets} onOpen={(id) => setSelected(id)} />
            )}
          </>
        )}
      {showCreate && (
        <AssetForm
          kind={kind}
          onClose={() => setShowCreate(false)}
          onSaved={(id) => { setShowCreate(false); onChanged(); load(); setSelected(id); }}
        />
      )}
      {selected && (
        <AssetDetail
          id={selected}
          onClose={() => { setSelected(null); onChanged(); load(); }}
          session={sessions.find((s) => s.assetId === selected) ?? null}
          onMediaQueued={onMediaQueued}
          onMediaDone={handleDone}
          onMediaDismiss={onMediaDismiss}
          checked={checkedAssets.includes(selected)}
          onToggleCheck={onToggleCheck}
        />
      )}
    </div>
  );
}

function AssetCard({ asset, onOpen, onGenerate, queueing, onRegenImage, onRegenVideo, session, onDone, onDismiss, checked, onToggleCheck }: {
  asset: DevotionalAsset; onOpen: () => void; onGenerate: () => void;
  queueing: string | null;
  onRegenImage: (fileKind: string) => void; onRegenVideo: () => void;
  session: MediaSession | null; onDone: () => void; onDismiss: () => void;
  checked: boolean; onToggleCheck: () => void;
}) {
  const generating = queueing === `${asset.id}:both` || !!session;
  const files = [
    ...(asset.image_versions ?? []).map((v) => ({ id: v.id, url: v.url, file_kind: v.file_kind })),
    ...(asset.video_versions ?? []).map((v) => ({ id: v.id, url: v.url, file_kind: v.file_kind })),
  ];
  return (
    <div className="card" style={{ textAlign: "left", padding: 10 }}>
      <div
        role="button" tabIndex={0} onClick={onOpen} title={`Open ${asset.name}`}
        style={{ cursor: "pointer" }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      >
        <div style={{ fontWeight: 600, marginTop: 8 }}>{asset.name}</div>
        <div className="muted" style={{ fontSize: 11 }}>{asset.id}{asset.parent_id ? ` · variant of ${asset.parent_id}` : ""}</div>
        {asset.description && <div className="hint" style={{ margin: "4px 0", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{asset.description}</div>}
      </div>
      <div style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
        <DevotionalMediaSection
          files={files}
          checked={checked}
          onToggleCheck={onToggleCheck}
          checkTitle={`Select ${asset.name} for bulk Regenerate`}
          session={session}
          onDone={onDone}
          onDismiss={onDismiss}
          onRegenImage={onRegenImage}
          onRegenVideo={onRegenVideo}
          regenBusy={queueing != null && queueing.startsWith(`${asset.id}:`) || !!session}
        />
      </div>
      <div className="row" style={{ gap: 6, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="pill">{asset.category || KIND_LABEL[asset.kind]}</span>
        <span className={statusPill(asset.status)}>{asset.status}{asset.locked ? " · locked" : ""}</span>
        <span className="muted">v{asset.version} · {fmtTime(asset.updated_at)}</span>
        <span className="spacer" />
        <button
          className="btn sm" disabled={generating}
          onClick={(e) => { e.stopPropagation(); onGenerate(); }}
          title="Generate a reference still + a short showcase clip (tracked inline with live progress)"
        >
          {generating ? <Spinner size={12} /> : <IconSparkles size={12} />} Generate
        </button>
      </div>
    </div>
  );
}

// Generated stills + showcase clips for the current tab, rendered below the
// library cards (e.g. Lord Rama / Lord Krishna under Characters). Driven by
// the same list response — no extra fetches.
function GeneratedGallery({ kind, assets, onOpen }: {
  kind: DevotionalKind; assets: DevotionalAsset[]; onOpen: (id: string) => void;
}) {
  const withMedia = (assets ?? []).filter((a) => a.preview_image || a.preview_video);
  return (
    <div style={{ marginTop: 18 }}>
      <h3 style={{ margin: "8px 0" }}>
        Generated images &amp; videos — {KIND_LABEL[kind]}s
        <span className="muted" style={{ fontWeight: 400 }}> · {withMedia.length} with media</span>
      </h3>
      {withMedia.length === 0 ? (
        <p className="hint" style={{ border: "1px dashed var(--line)", borderRadius: "var(--radius-m)", padding: "14px 12px", textAlign: "center" }}>
          No generated media for these {kind}s yet — press <b>Generate</b> on any card above (the still + showcase clip render with live progress right on the card).
        </p>
      ) : (
        <div className="grid">
          {withMedia.map((a) => (
            <div key={`media-${a.id}`} className="card" style={{ padding: 8, textAlign: "left" }}>
              <div
                role="button" tabIndex={0}
                onClick={() => onOpen(a.id)}
                title={`Open ${a.name}`}
                style={{ cursor: "pointer" }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(a.id); } }}
              >
                <div style={{ fontWeight: 600 }}>{a.name} <span className="muted" style={{ fontWeight: 400 }}>· {a.id}</span></div>
              </div>
              {a.preview_image ? (
                <a href={a.preview_image} target="_blank" rel="noreferrer" title={`Open ${a.name} still full size`} onClick={(e) => e.stopPropagation()}>
                  <img
                    src={a.preview_image}
                    alt={`${a.name} generated still`}
                    loading="lazy"
                    style={{ width: "100%", borderRadius: 6, display: "block", marginTop: 6, aspectRatio: "1 / 1", objectFit: "cover", background: "var(--bg2)" }}
                  />
                </a>
              ) : (
                <div className="hint" style={{ marginTop: 6 }}>Still pending…</div>
              )}
              {a.preview_video ? (
                <video
                  src={a.preview_video}
                  controls
                  preload="metadata"
                  title={`${a.name} showcase clip`}
                  style={{ width: "100%", borderRadius: 6, display: "block", marginTop: 6, background: "#000", maxHeight: 240 }}
                />
              ) : (
                <div className="hint" style={{ marginTop: 6 }}>Clip pending…</div>
              )}
              <div className="row" style={{ gap: 6, marginTop: 6, alignItems: "center" }}>
                <span className={statusPill(a.status)}>{a.status}</span>
                <span className="muted">v{a.version}</span>
                <span className="spacer" />
                <button className="btn sm ghost" onClick={() => onOpen(a.id)}>Open</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- create/edit form
function AssetForm({ kind, initial, parentId, onClose, onSaved }: {
  kind: DevotionalKind; initial?: DevotionalAsset | null; parentId?: string | null;
  onClose: () => void; onSaved: (id: string) => void;
}) {
  const dialog = useDialog();
  const [name, setName] = useState(initial?.name ?? "");
  const [aliases, setAliases] = useState((initial?.aliases ?? []).join(", "));
  const [category, setCategory] = useState(initial?.category ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [identity, setIdentity] = useState(() => JSON.stringify(initial?.identity ?? {}, null, 2));
  const [negative, setNegative] = useState(initial?.negative_prompt ?? "");
  const [promptText, setPromptText] = useState(initial?.prompt ?? "");
  const [continuity, setContinuity] = useState(initial?.continuity ?? "");
  const [parent, setParent] = useState(initial?.parent_id ?? parentId ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    let identityObj: Record<string, unknown> = {};
    try { identityObj = identity.trim() ? JSON.parse(identity) : {}; }
    catch { await dialog.alert("Identity must be valid JSON (an object of canonical traits).", { title: "Invalid identity", tone: "error" }); return; }
    if (typeof identityObj !== "object" || Array.isArray(identityObj)) {
      await dialog.alert("Identity must be a JSON object.", { title: "Invalid identity", tone: "error" }); return;
    }
    if (!name.trim()) { await dialog.alert("Name is required.", { title: "Missing name", tone: "warning" }); return; }
    setSaving(true);
    try {
      const body = {
        kind, name: name.trim(),
        aliases: aliases.split(",").map((s) => s.trim()).filter(Boolean),
        category: category.trim(), description: description.trim(),
        prompt: promptText.trim(),
        identity: identityObj, negative_prompt: negative.trim(), continuity: continuity.trim(),
        ...(parent.trim() ? { parent_id: parent.trim().toUpperCase() } : {}),
      };
      const saved = initial
        ? await updateDevotionalAsset(initial.id, { ...body, ...(initial.status === "approved" && initial.locked ? { unlock: true } : {}) })
        : await createDevotionalAsset(body);
      onSaved(saved.id);
    } catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Save failed", tone: "error" }); }
    finally { setSaving(false); }
  };

  return (
    <div className="dlg-overlay" role="dialog" aria-modal="true" aria-label={initial ? "Edit asset" : "New asset"}>
      <div className="dlg-box" style={{ width: "min(640px, 100%)", textAlign: "left", maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <h3 className="dlg-title" style={{ textAlign: "center" }}>
          {initial ? `Edit ${initial.id}` : `New ${KIND_LABEL[kind].toLowerCase()}${parent ? ` (variant of ${parent})` : ""}`}
        </h3>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></label>
        <div className="grid" style={{ marginTop: 8 }}>
          <label>Aliases (comma separated)<input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="Kanha, Murli Manohar" /></label>
          <label>Category<input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Deity / City / Weapon / 3D" /></label>
        </div>
        <label style={{ marginTop: 8 }}>Description — canonical identity in words<textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} /></label>
        <label style={{ marginTop: 8 }}>Identity traits (JSON — complexion, costume, architecture, materials…)<textarea rows={5} value={identity} onChange={(e) => setIdentity(e.target.value)} spellCheck={false} style={{ fontFamily: "var(--mono)" }} /></label>
        <label style={{ marginTop: 8 }}>Generation prompt (blank = auto from description + traits — every still + clip renders from this)<textarea rows={3} value={promptText} onChange={(e) => setPromptText(e.target.value)} maxLength={2000} placeholder="Portrait of … (leave blank for auto)" /></label>
        <div className="grid" style={{ marginTop: 8 }}>
          <label>Negative prompt<input value={negative} onChange={(e) => setNegative(e.target.value)} /></label>
          <label>Continuity rules<input value={continuity} onChange={(e) => setContinuity(e.target.value)} placeholder="Same crown in every scene" /></label>
        </div>
        {!initial && kind !== "style" && (
          <label style={{ marginTop: 8 }}>Parent ID (variant / sub-location — optional)<input value={parent} onChange={(e) => setParent(e.target.value)} placeholder="CHAR_KRISHNA_01" /></label>
        )}
        {initial?.locked && <p className="hint">This identity is approved and locked — saving creates an editable revision (explicit unlock).</p>}
        <div className="dlg-actions">
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save} disabled={saving}>{saving ? <Spinner size={13} /> : <IconCheck size={13} />} Save</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- asset detail
function AssetDetail({ id, onClose, session, onMediaQueued, onMediaDone, onMediaDismiss, checked, onToggleCheck }: {
  id: string; onClose: () => void;
  session: MediaSession | null;
  onMediaQueued: (assetId: string, assetName: string, jobIds: string[], kinds?: ("reference" | "video")[]) => void;
  onMediaDone: (assetId: string) => void;
  onMediaDismiss: (assetId: string) => void;
  checked: boolean;
  onToggleCheck: (assetId: string) => void;
}) {
  const dialog = useDialog();
  const [detail, setDetail] = useState<DevotionalDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [variantFor, setVariantFor] = useState<string | null>(null);
  const [genPrompt, setGenPrompt] = useState("");
  const [genKind, setGenKind] = useState("master");
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try { setDetail(await getDevotionalAsset(id)); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
      if (okMsg) await dialog.alert(okMsg, { title: "Done", tone: "success" });
    } catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Action failed", tone: "error" }); }
    finally { setBusy(false); }
  };

  const approve = () => act(() => setDevotionalStatus(id, "approved"), "Approved and identity-locked. The Director must use this canonical version.");
  const reject = async () => {
    if (!await dialog.confirm("Send this asset back to draft for rework?", { title: "Reject reference" })) return;
    await act(() => setDevotionalStatus(id, "draft"));
  };
  const archive = async () => {
    if (!await dialog.confirm("Archive this asset? It stays in history and can be restored.", { title: "Archive asset" })) return;
    await act(() => archiveDevotionalAsset(id));
  };
  const hardDelete = async () => {
    if (!await dialog.confirm("Permanently delete this asset and its files? Only possible when nothing references it.", { title: "Delete forever", tone: "error", danger: true })) return;
    await act(async () => { await archiveDevotionalAsset(id, true); onClose(); });
  };
  const newVersion = async () => {
    const note = prompt("Version note (optional):", "") ?? "";
    await act(() => newDevotionalVersion(id, note));
  };
  const upload = async (f: File) => {
    const buf = await f.arrayBuffer();
    if (buf.byteLength > 25 * 1024 * 1024) { await dialog.alert("Image over 25MB.", { title: "Too large", tone: "warning" }); return; }
    // Chunked base64 to avoid stack blowups on large files.
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    await act(() => uploadDevotionalFile(id, `data:${f.type || "image/png"};base64,${btoa(bin)}`, genKind), "Reference uploaded.");
  };
  // Still / Still+clip queueing: no success popup — the inline progress
  // block below tracks the jobs with live bars + % until media lands.
  const queueGen = async (fn: () => Promise<{ jobs: string[]; kinds?: ("reference" | "video")[] }>, fallbackKinds: ("reference" | "video")[]) => {
    setBusy(true);
    try {
      const r = await fn();
      await load();
      onMediaQueued(id, detail?.name ?? id, r.jobs, r.kinds ?? fallbackKinds);
    } catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Queue failed", tone: "error" }); }
    finally { setBusy(false); }
  };
  const generate = () => queueGen(async () => {
    const r = await generateDevotionalReference(id, { prompt: genPrompt.trim() || undefined, fileKind: genKind });
    return { jobs: [r.job] };
  }, ["reference"]);
  const generateMedia = () => queueGen(async () => {
    const r = await generateDevotionalMedia(id, { prompt: genPrompt.trim() || undefined, fileKind: genKind });
    return { jobs: r.jobs, kinds: (r.image === "reused" ? ["video"] : ["reference", "video"]) as ("reference" | "video")[] };
  }, ["reference", "video"]);
  // Per-kind regen buttons in the Image & video section (new versions —
  // old files are kept). Image regen reuses the latest still's kind.
  const regenImage = (fileKind: string) => queueGen(async () => {
    const r = await generateDevotionalReference(id, { prompt: genPrompt.trim() || undefined, fileKind });
    return { jobs: [r.job] };
  }, ["reference"]);
  const regenVideo = () => queueGen(async () => {
    const r = await generateDevotionalClip(id, { prompt: genPrompt.trim() || undefined });
    return r;
  }, ["video"]);
  // Saved-prompt editor: Save keeps it for all future stills + clips;
  // Save & Regenerate additionally renders a NEW still (new version, never
  // overwritten) and then a clip from that still — both tracked inline.
  // The still is queued first and the pump runs jobs FIFO, so the clip
  // always animates the fresh still.
  const savePrompt = async (regen: boolean) => {
    const p = promptText.trim().slice(0, 2000);
    setBusy(true);
    try {
      await updateDevotionalAsset(id, {
        prompt: p,
        ...(detail && detail.status === "approved" && detail.locked ? { unlock: true } : {}),
      });
      await load();
      if (regen) {
        const fk = [...(detail?.files ?? [])].reverse().find((f) => !isVideoFile(f.file_path))?.file_kind || "master";
        const r1 = await generateDevotionalReference(id, { fileKind: fk });
        const r2 = await generateDevotionalClip(id, {});
        onMediaQueued(id, detail?.name ?? id, [r1.job, ...r2.jobs], ["reference", "video"]);
      }
      setPromptOpen(false);
    } catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Save failed", tone: "error" }); }
    finally { setBusy(false); }
  };
  const handleDone = useCallback(() => {
    load();
    onMediaDone(id);
  }, [load, onMediaDone, id]);
  const genBusy = busy || !!session;

  return (
    <div className="dlg-overlay" role="dialog" aria-modal="true" aria-label="Asset detail">
      <div className="dlg-box" style={{ width: "min(760px, 100%)", textAlign: "left", maxHeight: "92vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        {!detail && !err && <p className="hint"><Spinner size={13} /> Loading…</p>}
        {err && <p className="hint" style={{ color: "var(--err)" }}>{err}</p>}
        {detail && (
          <>
            <h3 className="dlg-title" style={{ textAlign: "center" }}>{detail.name}</h3>
            <div className="row" style={{ gap: 6, justifyContent: "center", flexWrap: "wrap" }}>
              <span className="pill">{KIND_LABEL[detail.kind]}</span>
              <span className={statusPill(detail.status)}>{detail.status}</span>
              <span className="pill">v{detail.version}</span>
              {detail.locked && <span className="pill warn">locked</span>}
              <span className="muted">{detail.id}</span>
            </div>
            {detail.description && <p style={{ margin: "10px 0" }}>{detail.description}</p>}
            {detail.missing.length > 0 && (
              <p className="hint" style={{ color: "var(--warn)" }}>Missing files: {detail.missing.join(", ")} — re-upload or regenerate them.</p>
            )}
            <DevotionalMediaSection
              files={(detail.files ?? []).filter((f) => f.exists).map((f) => ({ id: f.id, url: f.url, file_kind: f.file_kind }))}
              checked={checked}
              onToggleCheck={() => onToggleCheck(id)}
              checkTitle={`Select ${detail.name} for bulk Regenerate`}
              session={session}
              onDone={handleDone}
              onDismiss={() => onMediaDismiss(id)}
              onRegenImage={regenImage}
              onRegenVideo={regenVideo}
              regenBusy={genBusy}
            />
            <div className="card" style={{ padding: 8, marginTop: 8 }}>
              <div className="row" style={{ gap: 6, alignItems: "center" }}>
                <b style={{ fontSize: 12 }}>Generation prompt</b>
                <span className="spacer" />
                <button
                  className="btn sm ghost"
                  onClick={() => { setPromptText(detail.prompt || ""); setPromptOpen(true); }}
                  disabled={busy}
                  title="Edit the saved prompt this asset's stills + clips render from"
                >
                  Edit Prompt
                </button>
              </div>
              {detail.prompt ? (
                <p className="hint" style={{ whiteSpace: "pre-wrap", margin: "6px 0 0" }}>{detail.prompt}</p>
              ) : (
                <p className="hint" style={{ margin: "6px 0 0" }}>Auto — built from the canonical description + identity traits.</p>
              )}
            </div>
            <div className="grid" style={{ marginTop: 8 }}>
              <div>
                <h4>Reference files ({detail.files.length})</h4>
                {detail.files.length === 0 ? <p className="hint">No references yet — upload or generate one below.</p> : (
                  <div className="grid">
                    {detail.files.map((f) => (
                      <div key={f.id} className="card" style={{ padding: 6 }}>
                        {f.exists ? (
                          isVideoFile(f.file_path) ? (
                            <video src={f.url} controls preload="metadata" style={{ width: "100%", borderRadius: 6, display: "block" }} title={`${detail.name} showcase clip`} />
                          ) : (
                            <a href={f.url} target="_blank" rel="noreferrer" title="Open full size">
                              <img src={f.url} alt={`${detail.name} ${f.file_kind}`} style={{ width: "100%", borderRadius: 6, display: "block" }} loading="lazy" />
                            </a>
                          )
                        ) : <span className="pill err">missing file</span>}
                        <div className="row" style={{ gap: 6, marginTop: 4, alignItems: "center" }}>
                          <span className="pill">{f.file_kind} · {f.source}</span>
                          <span className="spacer" />
                          <button className="btn sm ghost" title="Delete file" onClick={() => act(() => deleteDevotionalFile(f.id))} disabled={busy}><IconTrash size={12} /></button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                  <select aria-label="Reference kind" value={genKind} onChange={(e) => setGenKind(e.target.value)}>
                    {["master", "face", "fullbody", "three-quarter", "side", "back", "expression", "pose", "costume", "detail", "wide", "medium", "angle", "lighting", "front"].map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                  <button className="btn sm" onClick={() => fileInput.current?.click()} disabled={busy} title="Import an existing image"><IconUpload size={13} /> Upload</button>
                  <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
                </div>
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <input aria-label="Generation prompt" placeholder="One-off prompt override (blank = saved prompt, else auto)" value={genPrompt} onChange={(e) => setGenPrompt(e.target.value)} style={{ flex: 1 }} />
                  <button className="btn sm" onClick={generate} disabled={genBusy} title="Generate via ComfyUI Flux (tracked inline with live progress)"><IconSparkles size={13} /> Generate</button>
                  <button className="btn sm" onClick={generateMedia} disabled={genBusy} title="Generate a still (if missing) + a short LTX showcase clip (tracked inline with live progress)"><IconFilm size={13} /> Still + clip</button>
                </div>
              </div>
              <div>
                <h4>Lifecycle</h4>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <button className="btn sm" onClick={() => setEditing(true)} disabled={busy}>Edit</button>
                  {detail.status !== "approved" && <button className="btn sm primary" onClick={approve} disabled={busy || detail.files.length === 0} title={detail.files.length === 0 ? "Add a reference file first" : "Approve and lock this identity"}><IconCheck size={13} /> Approve</button>}
                  {detail.status === "review" && <button className="btn sm ghost" onClick={reject} disabled={busy}>Reject</button>}
                  <button className="btn sm ghost" onClick={() => act(() => lockDevotionalAsset(id, !detail.locked))} disabled={busy}>{detail.locked ? "Unlock" : "Lock"}</button>
                  <button className="btn sm ghost" onClick={newVersion} disabled={busy} title="Snapshot and open a new version">New version</button>
                  {detail.status !== "archived" ? <button className="btn sm ghost" onClick={archive} disabled={busy}>Archive</button>
                    : <button className="btn sm ghost" onClick={() => act(() => setDevotionalStatus(id, "draft"))} disabled={busy}>Restore</button>}
                  <button className="btn sm ghost" onClick={hardDelete} disabled={busy} title="Permanent delete (only when unreferenced)"><IconTrash size={13} /></button>
                </div>
                {(detail.kind === "character" || detail.kind === "location") && (
                  <div style={{ marginTop: 8 }}>
                    <button className="btn sm ghost" onClick={() => setVariantFor(detail.id)} title={detail.kind === "character" ? "New age/costume variant under this identity" : "New sub-location inside this environment"}>
                      + New {detail.kind === "character" ? "variant" : "sub-location"}
                    </button>
                    {detail.children.length > 0 && (
                      <ul className="hint" style={{ marginTop: 6 }}>
                        {detail.children.map((c) => <li key={c.id}>{c.name} · {c.id} · {c.status}</li>)}
                      </ul>
                    )}
                  </div>
                )}
                <h4 style={{ marginTop: 12 }}>Versions ({detail.versions.length})</h4>
                <ul className="hint">
                  {detail.versions.map((v) => (
                    <li key={v.version}>v{v.version} · {fmtTime(v.created_at)}{v.note ? ` — ${v.note}` : ""}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="dlg-actions">
              <button className="ghost" onClick={onClose}>Close</button>
            </div>
          </>
        )}
        {editing && detail && (
          <AssetForm kind={detail.kind} initial={detail} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void load(); }} />
        )}
        {variantFor && detail && (
          <AssetForm kind={detail.kind} parentId={variantFor} onClose={() => setVariantFor(null)} onSaved={() => { setVariantFor(null); void load(); }} />
        )}
        {promptOpen && detail && (
          <div className="dlg-overlay" role="dialog" aria-modal="true" aria-label="Edit generation prompt">
            <div className="dlg-box" style={{ width: "min(560px, 100%)", textAlign: "left", maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
              <h3 className="dlg-title" style={{ textAlign: "center" }}>Edit Prompt — {detail.name}</h3>
              <p className="hint">Saved on the asset — every future still + clip renders from it. Blank restores auto mode (canonical description + identity traits).</p>
              <textarea
                rows={6}
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                maxLength={2000}
                placeholder="Portrait of … (blank = auto)"
                style={{ width: "100%", boxSizing: "border-box" }}
                aria-label="Generation prompt"
              />
              {detail.locked && detail.status === "approved" && (
                <p className="hint">Approved + locked — saving creates an editable revision (explicit unlock), like any canonical edit.</p>
              )}
              <div className="dlg-actions">
                <button className="ghost" onClick={() => setPromptOpen(false)}>Cancel</button>
                <button className="btn sm" onClick={() => void savePrompt(false)} disabled={busy} title="Save the prompt for future generations">Save</button>
                <button
                  className="primary sm"
                  onClick={() => void savePrompt(true)}
                  disabled={genBusy}
                  title="Save the prompt, then render a NEW still + showcase clip from it (old versions kept, tracked inline)"
                >
                  {genBusy ? <Spinner size={12} /> : <IconFilm size={12} />} Save & Regenerate
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- reference studio
function StudioTab({ onChanged }: { onChanged: () => void }) {
  const dialog = useDialog();
  const [jobs, setJobs] = useState<DevotionalJob[]>([]);
  const [filter, setFilter] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [comfyUp, setComfyUp] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      const [j, h] = await Promise.all([listDevotionalJobs(filter || undefined), getDevotionalHealth()]);
      setJobs(j);
      setComfyUp(h.comfy.up);
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [filter]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div>
      <p className="hint">
        Reference generation runs through the existing ComfyUI Flux workflow as a background job (serial with main runs — never blocking the UI).
        {comfyUp === false && <> <b style={{ color: "var(--err)" }}>ComfyUI is unreachable</b> — jobs will fail; manual upload keeps working.</>}
      </p>
      {err && <p className="hint" style={{ color: "var(--err)" }}>{err} <button className="btn sm ghost" onClick={() => void load()}>Retry</button></p>}
      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <select aria-label="Job status filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All jobs</option>
          <option value="PENDING">Pending</option>
          <option value="PROCESSING">Processing</option>
          <option value="COMPLETED">Completed</option>
          <option value="FAILED">Failed</option>
        </select>
        <span className="muted">{jobs.length} jobs</span>
      </div>
      {jobs.length === 0 ? <Empty text="No generation jobs yet. Open an asset and press Generate, or upload references manually." />
        : jobs.map((j) => (
          <div key={j.id} className="card" style={{ padding: 10, marginBottom: 8 }}>
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <span className={j.status === "COMPLETED" ? "pill ok" : j.status === "FAILED" ? "pill err" : "pill running"}>{j.status}</span>
              <span className="pill">{j.kind === "video" ? "clip" : "still"}</span>
              <b>{j.asset_id}</b>
              <span className="muted">{j.id} · {fmtTime(j.created_at)}</span>
              <span className="spacer" />
              {(j.status === "PENDING" || j.status === "PROCESSING") && (
                <button className="btn sm ghost" onClick={async () => { await cancelDevotionalJob(j.id); onChanged(); void load(); }}><IconX size={12} /> Cancel</button>
              )}
              {j.status === "FAILED" && (
                <button className="btn sm ghost" onClick={async () => {
                  try {
                    await generateDevotionalReference(j.asset_id, { prompt: j.prompt || undefined });
                    onChanged(); void load();
                  } catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Retry failed", tone: "error" }); }
                }}><IconRefresh size={12} /> Retry</button>
              )}
            </div>
            {j.prompt && <div className="hint" style={{ marginTop: 4 }}>{j.prompt.slice(0, 220)}</div>}
            {j.error_message && <div className="hint" style={{ color: "var(--err)", marginTop: 4 }}>{j.error_message}</div>}
          </div>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------- review queue
function ReviewTab({ onChanged }: { onChanged: () => void }) {
  const dialog = useDialog();
  const [assets, setAssets] = useState<DevotionalAsset[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const kinds: DevotionalKind[] = ["character", "location", "prop", "style"];
      const lists = await Promise.all(kinds.map((kind) => listDevotionalAssets({ kind, status: "review", pageSize: 100 })));
      setAssets(lists.flatMap((l) => l.assets));
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const decide = async (a: DevotionalAsset, approveOk: boolean) => {
    if (approveOk) {
      const d = await getDevotionalAsset(a.id).catch(() => null);
      if (d && d.files.length === 0) {
        await dialog.alert("Approval needs at least one reference file — generate or upload one first.", { title: "Cannot approve", tone: "warning" });
        return;
      }
    } else if (!await dialog.confirm(`Send ${a.name} back to draft?`, { title: "Reject" })) return;
    setBusy(a.id);
    try {
      await setDevotionalStatus(a.id, approveOk ? "approved" : "draft");
      onChanged(); await load();
    } catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Failed", tone: "error" }); }
    finally { setBusy(null); }
  };

  return (
    <div>
      <p className="hint">Approval queue: every asset in <b>review</b>. Approving locks the canonical identity — the Director must use that exact version.</p>
      {err && <p className="hint" style={{ color: "var(--err)" }}>{err} <button className="btn sm ghost" onClick={() => void load()}>Retry</button></p>}
      {assets.length === 0 ? <Empty text="Nothing awaiting review. Assets move here after their first reference is generated or uploaded." />
        : assets.map((a) => (
          <div key={a.id} className="card" style={{ padding: 10, marginBottom: 8 }}>
            <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span className="pill">{KIND_LABEL[a.kind]}</span>
              <b>{a.name}</b><span className="muted">{a.id} · v{a.version}</span>
              <span className="spacer" />
              <button className="btn sm primary" disabled={busy === a.id} onClick={() => void decide(a, true)}><IconCheck size={13} /> Approve</button>
              <button className="btn sm ghost" disabled={busy === a.id} onClick={() => void decide(a, false)}>Reject</button>
            </div>
            {a.description && <div className="hint" style={{ marginTop: 4 }}>{a.description.slice(0, 240)}</div>}
          </div>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------- projects & usage
function UsageTab() {
  const dialog = useDialog();
  const [assetId, setAssetId] = useState("");
  const [usage, setUsage] = useState<{ asset_id: string; scenes: { board_id: string; scene_number: number; asset_version: number; role: string }[]; projects: { name: string; asset_version: number; scenes: number[] }[] } | null>(null);
  const [boardId, setBoardId] = useState("");
  const [links, setLinks] = useState<{ board_id: string; scene_number: number; asset_id: string; asset_version: number; role: string }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const lookup = async () => {
    if (!assetId.trim()) return;
    try {
      setUsage(await getDevotionalUsage(assetId.trim().toUpperCase()));
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const lookupBoard = async () => {
    if (!boardId.trim()) return;
    try {
      setLinks(await getDevotionalBoardLinks(boardId.trim()));
      setErr(null);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div>
      {err && <p className="hint" style={{ color: "var(--err)" }}>{err}</p>}
      <h3>Where is an asset used?</h3>
      <div className="row" style={{ gap: 8 }}>
        <input aria-label="Asset id" placeholder="CHAR_KRISHNA_01" value={assetId} onChange={(e) => setAssetId(e.target.value)} style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => void lookup()}><IconEye size={13} /> Lookup</button>
      </div>
      {usage && (
        <div className="card" style={{ padding: 10, marginTop: 8 }}>
          <b>{usage.asset_id}</b>
          <h4>Director scenes ({usage.scenes.length})</h4>
          {usage.scenes.length === 0 ? <p className="hint">No linked scenes — an asset update affects nothing yet.</p> : (
            <ul className="hint">
              {usage.scenes.map((s, i) => <li key={i}>Board {s.board_id} · scene {s.scene_number} · {s.role} @ v{s.asset_version}</li>)}
            </ul>
          )}
          <h4>Projects ({usage.projects.length})</h4>
          {usage.projects.length === 0 ? <p className="hint">No recorded project usage.</p> : (
            <ul className="hint">
              {usage.projects.map((p) => <li key={p.name}>{p.name} @ v{p.asset_version}{p.scenes.length ? ` · scenes ${p.scenes.join(", ")}` : ""}</li>)}
            </ul>
          )}
        </div>
      )}
      <h3 style={{ marginTop: 16 }}>Scene links for a Director board</h3>
      <div className="row" style={{ gap: 8 }}>
        <input aria-label="Board id" placeholder="board id" value={boardId} onChange={(e) => setBoardId(e.target.value)} style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => void lookupBoard()}><IconEye size={13} /> Lookup</button>
      </div>
      {links && (
        <div className="card" style={{ padding: 10, marginTop: 8 }}>
          {links.length === 0 ? <p className="hint">No devotional links recorded for this board.</p> : (
            <ul className="hint">
              {links.map((l, i) => <li key={i}>Scene {l.scene_number} · {l.role} {l.asset_id} @ v{l.asset_version}</li>)}
            </ul>
          )}
        </div>
      )}
      <RecordUsageForm onDone={() => dialog.alert("Usage recorded.", { title: "Done", tone: "success" })} />
    </div>
  );
}

function RecordUsageForm({ onDone }: { onDone: () => void }) {
  const dialog = useDialog();
  const [project, setProject] = useState("");
  const [assets, setAssets] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const list = assets.split(",").map((s) => s.trim()).filter(Boolean).map((asset_id) => ({ asset_id }));
    if (!project.trim() || list.length === 0) {
      await dialog.alert("Project name and at least one asset id are required.", { title: "Missing input", tone: "warning" });
      return;
    }
    setSaving(true);
    try {
      const r = await recordDevotionalUsage(project.trim(), list);
      await dialog.alert(`Recorded ${r.saved} asset link(s) on ${project.trim()}.`, { title: "Done", tone: "success" });
      onDone();
    } catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Failed", tone: "error" }); }
    finally { setSaving(false); }
  };
  return (
    <div className="card" style={{ padding: 10, marginTop: 16 }}>
      <h4>Record project usage</h4>
      <p className="hint">Link approved asset versions to a project (used by the dashboard + change-impact lookup).</p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input aria-label="Project name" placeholder="Project name" value={project} onChange={(e) => setProject(e.target.value)} />
        <input aria-label="Asset ids" placeholder="CHAR_KRISHNA_01, LOC_VRINDAVAN_01" value={assets} onChange={(e) => setAssets(e.target.value)} style={{ flex: 1 }} />
        <button className="btn sm primary" onClick={() => void save()} disabled={saving}>{saving ? <Spinner size={12} /> : "Record"}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- versions
function VersionsTab() {
  const dialog = useDialog();
  const [assetId, setAssetId] = useState("");
  const [detail, setDetail] = useState<DevotionalDetail | null>(null);
  const [compareA, setCompareA] = useState<number | null>(null);
  const [compareB, setCompareB] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<Record<number, Record<string, unknown>>>({});

  const load = async () => {
    if (!assetId.trim()) return;
    try {
      const d = await getDevotionalAsset(assetId.trim().toUpperCase());
      setDetail(d);
      setErr(null);
      const vers: { version: number; snapshot: Record<string, unknown> }[] =
        await (await fetch(`/api/devotional/assets/${encodeURIComponent(d.id)}/versions`)).json().then((r) => {
          if (Array.isArray(r)) return r;
          throw new Error("version load failed");
        });
      const map: Record<number, Record<string, unknown>> = {};
      for (const v of vers) map[v.version] = (v.snapshot ?? {}) as Record<string, unknown>;
      setSnapshots(map);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const diff = useMemo(() => {
    if (compareA == null || compareB == null) return null;
    const a = snapshots[compareA] ?? {}, b = snapshots[compareB] ?? {};
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys
      .filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
      .map((k) => ({ key: k, a: a[k], b: b[k] }));
  }, [compareA, compareB, snapshots]);

  return (
    <div>
      <p className="hint">Durable, auditable version history. Restoring snapshots the current state first — scene links keep the versions they recorded.</p>
      {err && <p className="hint" style={{ color: "var(--err)" }}>{err}</p>}
      <div className="row" style={{ gap: 8 }}>
        <input aria-label="Asset id" placeholder="CHAR_KRISHNA_01" value={assetId} onChange={(e) => setAssetId(e.target.value)} style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => void load()}>Load history</button>
      </div>
      {detail && (
        <div className="card" style={{ padding: 10, marginTop: 8 }}>
          <b>{detail.name}</b> <span className="muted">{detail.id} · current v{detail.version}</span>
          {detail.versions.length === 0 ? <p className="hint">No snapshots yet.</p> : (
            <>
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <select aria-label="Compare from" value={compareA ?? ""} onChange={(e) => setCompareA(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">Compare from…</option>
                  {detail.versions.map((v) => <option key={v.version} value={v.version}>v{v.version}</option>)}
                </select>
                <select aria-label="Compare to" value={compareB ?? ""} onChange={(e) => setCompareB(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">…to</option>
                  {detail.versions.map((v) => <option key={v.version} value={v.version}>v{v.version}</option>)}
                </select>
                <span className="spacer" />
                {detail.versions.map((v) => (
                  <button key={v.version} className="btn sm ghost" title={`Restore v${v.version}`} onClick={async () => {
                    if (!await dialog.confirm(`Restore ${detail.id} to v${v.version}? Current state is snapshotted first.`, { title: "Restore version" })) return;
                    try {
                      await restoreDevotionalVersion(detail.id, v.version);
                      await dialog.alert(`Restored to v${v.version} (as a new review version).`, { title: "Done", tone: "success" });
                      void load();
                    } catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Restore failed", tone: "error" }); }
                  }}>Restore v{v.version}</button>
                ))}
              </div>
              {diff && (
                <div style={{ marginTop: 8 }}>
                  <h4>Changed fields ({diff.length})</h4>
                  {diff.length === 0 ? <p className="hint">Identical snapshots.</p> : diff.map((d) => (
                    <div key={d.key} className="card" style={{ padding: 8, marginBottom: 6 }}>
                      <b>{d.key}</b>
                      <div className="grid">
                        <pre className="hint" style={{ whiteSpace: "pre-wrap" }}>v{compareA}: {JSON.stringify(d.a, null, 2)?.slice(0, 800)}</pre>
                        <pre className="hint" style={{ whiteSpace: "pre-wrap" }}>v{compareB}: {JSON.stringify(d.b, null, 2)?.slice(0, 800)}</pre>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- settings & health
function SettingsTab({ onChanged }: { onChanged: () => void }) {
  const dialog = useDialog();
  const [health, setHealth] = useState<{ db: { up: boolean }; comfy: { up: boolean; error: string | null }; storage: { up: boolean; root: string; error?: string } } | null>(null);

  const load = useCallback(async () => {
    try { setHealth(await getDevotionalHealth()); }
    catch { setHealth(null); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const doExport = async () => {
    try {
      const data = await exportDevotional();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `devotional-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Export failed", tone: "error" }); }
  };
  const doImport = async (f: File, overwrite: boolean) => {
    try {
      const data = JSON.parse(await f.text());
      const assets = Array.isArray(data?.assets) ? data.assets : Array.isArray(data) ? data : null;
      if (!assets) throw new Error("file must be { assets: [...] } (see Export)");
      const r = await importDevotional(assets, overwrite);
      await dialog.alert(`Imported: ${r.created.length} created, ${r.updated.length} updated, ${r.skipped.length} skipped.`, { title: "Import done", tone: "success" });
      onChanged();
    } catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Import failed", tone: "error" }); }
  };

  return (
    <div>
      <h3>Integration health</h3>
      {!health ? <p className="hint"><Spinner size={13} /> Checking…</p> : (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <span className={health.db.up ? "pill ok" : "pill err"}>Database {health.db.up ? "up" : "down"}</span>
          <span className={health.comfy.up ? "pill ok" : "pill err"} title={health.comfy.error || ""}>ComfyUI {health.comfy.up ? "up" : "down"}</span>
          <span className={health.storage.up ? "pill ok" : "pill err"} title={health.storage.error || health.storage.root}>Storage {health.storage.up ? "writable" : "FAILED"}</span>
          <span className="muted">{health.storage.root}</span>
          <span className="spacer" />
          <button className="btn sm ghost" onClick={() => void load()}><IconRefresh size={12} /> Recheck</button>
        </div>
      )}
      {!health?.comfy.up && (
        <p className="hint">Reference generation needs ComfyUI (Flux workflow <code>TextToImage/flux-t2i.json</code> on the box behind <code>COMFY_BASE</code>). Until then every library workflow except Generate works — upload references manually.</p>
      )}
      <h3 style={{ marginTop: 16 }}>Backup & restore</h3>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className="btn sm" onClick={() => void doExport()}><IconDatabase size={13} /> Export metadata (JSON)</button>
        <label className="btn sm ghost" style={{ cursor: "pointer" }}>Import metadata
          <input type="file" accept="application/json" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void doImport(f, false); }} />
        </label>
        <label className="btn sm ghost" style={{ cursor: "pointer" }} title="Overwrite existing ids on conflict">Import with overwrite
          <input type="file" accept="application/json" style={{ display: "none" }} onChange={async (e) => {
            const f = e.target.files?.[0]; e.target.value = "";
            if (f && await dialog.confirm("Overwrite existing asset ids from this file?", { title: "Overwrite import", tone: "warning" })) void doImport(f, true);
          }} />
        </label>
      </div>
      <p className="hint">Export covers metadata, versions, files and scene links (binaries stay under the storage root — back that folder up with the project outputs). Import never overwrites without the explicit overwrite action.</p>
      <h3 style={{ marginTop: 16 }}>Director integration</h3>
      <DirectorProbe />
    </div>
  );
}

// Smallest useful Director bridge in the UI: resolve scene ids + preview the
// assembled prompt, then optionally pin the link to a board scene.
function DirectorProbe() {
  const dialog = useDialog();
  const [chars, setChars] = useState("");
  const [loc, setLoc] = useState("");
  const [props, setProps] = useState("");
  const [style, setStyle] = useState("");
  const [action, setAction] = useState("");
  const [result, setResult] = useState<{ positive: string; negative: string } | null>(null);
  const [missing, setMissing] = useState<{ role: string; id: string }[]>([]);
  const [boardId, setBoardId] = useState("");
  const [sceneNo, setSceneNo] = useState("1");

  const scene = () => ({
    devotional_characters: chars.split(",").map((s) => s.trim()).filter(Boolean),
    devotional_location: loc.trim() || undefined,
    devotional_props: props.split(",").map((s) => s.trim()).filter(Boolean),
    devotional_style: style.trim() || undefined,
    action: action.trim(),
  });
  const check = async () => {
    try {
      const [r, p] = await Promise.all([resolveDevotionalScene(scene()), previewDevotionalPrompt(scene())]);
      setMissing(r.missing);
      setResult({ positive: p.positive, negative: p.negative });
      if (r.missing.length) {
        await dialog.alert(`Unresolved (not approved or unknown): ${r.missing.map((m) => `${m.role} ${m.id}`).join(", ")}. Pick approved ids instead — nothing was substituted.`, { title: "Review needed", tone: "warning" });
      }
    } catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Resolve failed", tone: "error" }); }
  };
  const pin = async () => {
    const links = [
      ...scene().devotional_characters.map((asset_id) => ({ asset_id, role: "character" })),
      ...(loc.trim() ? [{ asset_id: loc.trim(), role: "location" }] : []),
      ...scene().devotional_props.map((asset_id) => ({ asset_id, role: "prop" })),
      ...(style.trim() ? [{ asset_id: style.trim(), role: "style" }] : []),
    ];
    if (!boardId.trim() || links.length === 0) {
      await dialog.alert("Board id and at least one asset id are required.", { title: "Missing input", tone: "warning" });
      return;
    }
    try {
      const r = await saveDevotionalSceneLinks(boardId.trim(), Number(sceneNo) || 1, links);
      await dialog.alert(`Pinned ${r.saved.length} asset version(s) to board ${boardId.trim()} scene ${sceneNo}. Regenerating the scene keeps these assignments.`, { title: "Done", tone: "success" });
    } catch (e) { await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Pin failed", tone: "error" }); }
  };

  return (
    <div className="card" style={{ padding: 10 }}>
      <p className="hint">Resolve approved asset IDs for a scene, preview the assembled prompt (identity vs action stay separate), and pin the versions to a Director board scene.</p>
      <div className="grid">
        <label>Character IDs (comma separated)<input value={chars} onChange={(e) => setChars(e.target.value)} placeholder="CHAR_KRISHNA_01" /></label>
        <label>Location ID<input value={loc} onChange={(e) => setLoc(e.target.value)} placeholder="LOC_VRINDAVAN_01" /></label>
        <label>Prop IDs (comma separated)<input value={props} onChange={(e) => setProps(e.target.value)} placeholder="PROP_FLUTE_01" /></label>
        <label>Style ID<input value={style} onChange={(e) => setStyle(e.target.value)} placeholder="STYLE_CINEMATIC_3D_01" /></label>
      </div>
      <label style={{ marginTop: 8 }}>Scene action (never edits the canonical identity)<input value={action} onChange={(e) => setAction(e.target.value)} placeholder="sitting under a tree, playing the flute" /></label>
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button className="btn sm" onClick={() => void check()}><IconFilm size={13} /> Resolve + preview</button>
        <input aria-label="Board id" placeholder="board id" value={boardId} onChange={(e) => setBoardId(e.target.value)} style={{ width: 160 }} />
        <input aria-label="Scene number" placeholder="scene #" value={sceneNo} onChange={(e) => setSceneNo(e.target.value)} style={{ width: 90 }} />
        <button className="btn sm ghost" onClick={() => void pin()}>Pin to scene</button>
      </div>
      {missing.length > 0 && <p className="hint" style={{ color: "var(--warn)" }}>Missing/unapproved: {missing.map((m) => `${m.role} ${m.id}`).join(", ")}</p>}
      {result && (
        <div className="grid" style={{ marginTop: 8 }}>
          <pre className="hint" style={{ whiteSpace: "pre-wrap" }}>{result.positive || "(empty — select approved assets)"}</pre>
          <pre className="hint" style={{ whiteSpace: "pre-wrap" }}>negative: {result.negative || "—"}</pre>
        </div>
      )}
      <p className="hint" style={{ marginTop: 8 }}><IconMusic size={12} /> Video continuity: approved stills double as image-to-video start frames — pass the reference URL plus the scene motion to the existing clip pipeline.</p>
    </div>
  );
}
