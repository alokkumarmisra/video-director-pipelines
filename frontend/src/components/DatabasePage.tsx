import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listDbFiles, listDbRows, insertDbRow, updateDbRow, deleteDbRow,
  fmtDateTime,
  type DbColumnInfo, type DbFileInfo, type DbValue,
} from "../api";
import { useDialog } from "./Dialog";
import {
  IconCheck, IconDatabase, IconEdit, IconPlus,
  IconRefresh, IconSearch, IconTrash, IconX, Spinner,
} from "./Icons";

type Row = Record<string, DbValue>;

const PAGE_SIZES = [10, 25, 50, 100];
const PREVIEW_LEN = 140;
// Columns edited as multi-line text (JSON blobs / long prose).
const BIG_COLS = new Set(["config", "snapshot", "identity", "aliases", "metadata", "scenes", "description", "prompt", "continuity", "negative_prompt", "error_message"]);
const isNumeric = (t: string) => /INT|REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(String(t || "").toUpperCase());
const isBig = (c: DbColumnInfo) =>
  BIG_COLS.has(c.name) || /TEXT|CLOB/.test(String(c.type || "").toUpperCase());

const strVal = (v: DbValue): string => (v == null ? "" : String(v));

// Epoch-ms (scenarios.updated_at) renders as a real date; everything else raw.
const fmtCell = (col: string, v: DbValue): string => {
  if (v == null) return "";
  if ((col === "updated_at" || col === "updatedAt") && typeof v === "number" && v > 100000000000) {
    try { return fmtDateTime(v); } catch { return String(v); }
  }
  return String(v);
};

const keyOf = (pk: string[], row: Row): Record<string, DbValue> => {
  if (pk.length) return Object.fromEntries(pk.map((c) => [c, row[c] ?? null]));
  return { _rowid: row._rowid ?? null };
};
const keyLabel = (pk: string[], row: Row): string => {
  const k = keyOf(pk, row);
  return Object.entries(k).map(([c, v]) => `${c}=${v == null ? "NULL" : String(v).slice(0, 40)}`).join(", ");
};

// Database explorer: every SQLite table (scenarios + devotional stores) with
// search / sort / pagination and full row CRUD (add / edit / delete).
export default function DatabasePage() {
  const dialog = useDialog();
  const [files, setFiles] = useState<DbFileInfo[]>([]);
  const [store, setStore] = useState("");
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState("");
  const [dbKey, setDbKey] = useState("scenarios");
  const [table, setTable] = useState("");
  const [cols, setCols] = useState<DbColumnInfo[]>([]);
  const [pk, setPk] = useState<string[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState("");
  const [dir, setDir] = useState<"ASC" | "DESC">("DESC");
  const [limit, setLimit] = useState(25);
  const [page, setPage] = useState(0);
  // Expanded cells (full text) keyed by `${rowIdx}:${col}`.
  const [openCells, setOpenCells] = useState<Set<string>>(new Set());
  // Row modal: null = closed, otherwise { mode, row? }.
  const [modal, setModal] = useState<{ mode: "add" | "edit"; row?: Row } | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [nulls, setNulls] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const refreshFiles = useCallback(async () => {
    const d = await listDbFiles();
    setFiles(d.files);
    setStore(d.store);
    return d.files;
  }, []);

  // First load: overview, then the first table of the first file.
  useEffect(() => {
    let stop = false;
    (async () => {
      setBooting(true);
      setBootError("");
      try {
        const fs = await refreshFiles();
        if (stop) return;
        const first = fs.find((f) => f.key === "scenarios") ?? fs[0];
        if (first) {
          setDbKey(first.key);
          setTable(first.tables[0]?.name ?? "");
        }
      } catch (e) {
        if (!stop) setBootError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!stop) setBooting(false);
      }
    })();
    return () => { stop = true; };
  }, [refreshFiles]);

  // Debounce the search box (300ms) so every keystroke is not a query.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadRows = useCallback(async () => {
    if (!table) {
      setRows([]);
      setCols([]);
      setPk([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const d = await listDbRows(dbKey, table, {
        search: debounced || undefined,
        sort: sort || undefined,
        dir,
        limit,
        offset: page * limit,
      });
      setCols(d.columns);
      setPk(d.pk);
      setRows(d.rows);
      setTotal(d.total);
      setOpenCells(new Set());
      // Clamp the page when a delete shrinks the table under us.
      const maxPage = Math.max(0, Math.ceil(d.total / limit) - 1);
      if (page > maxPage) setPage(maxPage);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [dbKey, table, debounced, sort, dir, limit, page]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  const switchTable = (db: string, t: string) => {
    setDbKey(db);
    setTable(t);
    setSearch("");
    setDebounced("");
    setSort("");
    setDir("DESC");
    setPage(0);
  };

  const totalRows = useMemo(
    () => files.reduce((n, f) => n + f.tables.reduce((m, t) => m + t.rows, 0), 0),
    [files],
  );
  const totalTables = useMemo(
    () => files.reduce((n, f) => n + f.tables.length, 0),
    [files],
  );
  const activeFile = files.find((f) => f.key === dbKey) ?? null;
  const pages = Math.max(1, Math.ceil(total / limit));

  const openAdd = () => {
    const f: Record<string, string> = {};
    const n = new Set<string>();
    for (const c of cols) {
      if (c.name === "_rowid") continue;
      if (c.name === "id" && /INT/.test(String(c.type || "").toUpperCase())) continue; // autoincrement
      f[c.name] = c.default != null ? String(c.default).replace(/^'(.*)'$/, "$1") : "";
      if (c.default == null && !c.notnull) n.add(c.name);
    }
    setForm(f);
    setNulls(n);
    setFormError("");
    setModal({ mode: "add" });
  };

  const openEdit = (row: Row) => {
    const f: Record<string, string> = {};
    const n = new Set<string>();
    for (const c of cols) {
      if (c.name === "_rowid") continue;
      const v = row[c.name];
      if (v == null) {
        f[c.name] = "";
        n.add(c.name);
      } else {
        f[c.name] = strVal(v);
      }
    }
    setForm(f);
    setNulls(n);
    setFormError("");
    setModal({ mode: "edit", row });
  };

  const buildValues = (): Record<string, DbValue> | null => {
    const values: Record<string, DbValue> = {};
    for (const c of cols) {
      if (c.name === "_rowid") continue;
      if (modal?.mode === "edit" && pk.includes(c.name)) continue; // PKs are read-only on edit
      if (modal?.mode === "add" && c.name === "id" && /INT/.test(String(c.type || "").toUpperCase()) && !strVal(form[c.name]).trim()) continue;
      if (nulls.has(c.name)) {
        values[c.name] = null;
        continue;
      }
      const raw = (form[c.name] ?? "").trim();
      if (raw === "" && !c.notnull) {
        values[c.name] = null;
        continue;
      }
      values[c.name] = isNumeric(c.type) && raw !== "" ? Number(raw) : raw;
      if (isNumeric(c.type) && raw !== "" && !Number.isFinite(values[c.name] as number)) {
        setFormError(`"${c.name}" must be a number.`);
        return null;
      }
      if (c.notnull && c.default == null && raw === "") {
        setFormError(`"${c.name}" is required.`);
        return null;
      }
    }
    return values;
  };

  const saveModal = async () => {
    if (!modal || saving) return;
    setFormError("");
    const values = buildValues();
    if (!values) return;
    setSaving(true);
    try {
      if (modal.mode === "add") {
        await insertDbRow(dbKey, table, values);
      } else if (modal.row) {
        await updateDbRow(dbKey, table, keyOf(pk, modal.row), values);
      }
      setModal(null);
      await refreshFiles().catch(() => {});
      await loadRows();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const askDelete = async (row: Row) => {
    const label = keyLabel(pk, row);
    const ok = await dialog.confirm(
      `Delete this row from "${table}"?\n\n${label}\n\nThis cannot be undone.`,
      { title: `Delete row`, tone: "error", okText: "Delete", danger: true },
    );
    if (!ok) return;
    const k = keyLabel(pk, row);
    setBusyKey(k);
    try {
      await deleteDbRow(dbKey, table, keyOf(pk, row));
      await refreshFiles().catch(() => {});
      await loadRows();
    } catch (e) {
      await dialog.alert(e instanceof Error ? e.message : String(e), { title: "Delete failed", tone: "error" });
    } finally {
      setBusyKey(null);
    }
  };

  const refreshAll = async () => {
    try { await refreshFiles(); } catch { /* rows error below covers it */ }
    await loadRows();
  };

  if (booting) {
    return (
      <div className="db-page">
        <div className="db-loading"><Spinner size={20} /><span>Loading databases…</span></div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="db-page">
        <div className="db-hero">
          <div className="db-hero-icon"><IconDatabase size={26} /></div>
          <div>
            <h2>Database</h2>
            <p>SQLite tables with full row CRUD.</p>
          </div>
        </div>
        <div className="db-error">{bootError} <button className="btn sm" onClick={() => window.location.reload()}>Retry</button></div>
      </div>
    );
  }

  return (
    <div className="db-page">
      {/* Beautiful header: identity + live stats + refresh */}
      <header className="db-hero">
        <div className="db-hero-icon" aria-hidden="true"><IconDatabase size={26} /></div>
        <div className="db-hero-text">
          <h2>Database</h2>
          <p>
            {store === "sqlite" ? "SQLite is the active store" : `Active store: ${store || "—"}`} · every table below is editable
          </p>
        </div>
        <div className="db-hero-stats">
          <div className="db-stat"><strong>{files.length}</strong><span>Files</span></div>
          <div className="db-stat"><strong>{totalTables}</strong><span>Tables</span></div>
          <div className="db-stat"><strong>{totalRows.toLocaleString()}</strong><span>Rows</span></div>
        </div>
        <button className="btn sm db-refresh" onClick={refreshAll} title="Reload schemas + rows">
          <IconRefresh size={14} /> Refresh
        </button>
      </header>

      {/* File tabs */}
      <div className="db-files" role="tablist" aria-label="Database files">
        {files.map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={dbKey === f.key}
            className={`db-file${dbKey === f.key ? " on" : ""}`}
            onClick={() => {
              const first = f.tables[0]?.name ?? "";
              if (first) switchTable(f.key, first);
              else setDbKey(f.key);
            }}
            title={f.file}
          >
            <IconDatabase size={14} />
            <span className="db-file-name">{f.file}</span>
            <span className="db-file-count">{f.tables.reduce((n, t) => n + t.rows, 0).toLocaleString()} rows</span>
          </button>
        ))}
        {files.length === 0 && <p className="muted">No database files found.</p>}
      </div>

      {/* Table chips */}
      {activeFile && (
        <div className="db-tables" role="tablist" aria-label="Tables">
          {activeFile.tables.map((t) => (
            <button
              key={t.name}
              role="tab"
              aria-selected={table === t.name}
              className={`db-chip${table === t.name ? " on" : ""}`}
              onClick={() => switchTable(dbKey, t.name)}
              title={`${t.rows} rows`}
            >
              {t.name}
              <span className="db-chip-n">{t.rows.toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}

      {table ? (
        <>
          {/* Toolbar: search / sort / paging size / add */}
          <div className="db-toolbar">
            <label className="db-search">
              <IconSearch size={14} aria-hidden="true" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search ${table}…`}
                aria-label={`Search ${table}`}
              />
              {search && (
                <button className="icon-btn" onClick={() => setSearch("")} title="Clear search" aria-label="Clear search">
                  <IconX size={13} />
                </button>
              )}
            </label>
            <label className="db-sort">
              <span className="muted">Sort</span>
              <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(0); }} aria-label="Sort column">
                <option value="">Newest first</option>
                {cols.filter((c) => c.name !== "_rowid").map((c) => (
                  <option key={c.name} value={c.name}>{c.name}{c.pk ? "  ★" : ""}</option>
                ))}
              </select>
              <button
                className="btn sm"
                onClick={() => { setDir((d) => (d === "DESC" ? "ASC" : "DESC")); setPage(0); }}
                title={dir === "DESC" ? "Descending — click for ascending" : "Ascending — click for descending"}
              >
                {dir === "DESC" ? "↓" : "↑"}
              </button>
            </label>
            <label className="db-sort">
              <span className="muted">Rows</span>
              <select value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(0); }} aria-label="Rows per page">
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <span className="spacer" />
            <button className="btn primary sm" onClick={openAdd}>
              <IconPlus size={14} /> Add row
            </button>
          </div>

          {error && <div className="db-error">{error}</div>}

          {/* Data grid */}
          <div className="db-grid-wrap">
            <table className="db-grid">
              <thead>
                <tr>
                  {cols.filter((c) => c.name !== "_rowid").map((c) => (
                    <th key={c.name} title={`${c.name} - ${c.type || "?"}${c.pk ? " - PRIMARY KEY" : ""}${c.notnull ? " - NOT NULL" : ""}${c.default != null ? ` - default ${c.default}` : ""}`}>
                      <span className="db-th">
                        {c.pk && <span className="db-pk" title="Primary key">★</span>}
                        {c.name}
                        <span className="db-type">{(c.type || "").toLowerCase()}</span>
                      </span>
                    </th>
                  ))}
                  <th className="db-actions-th">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={cols.length + 1} className="db-state"><Spinner size={16} /> Loading rows…</td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={cols.length + 1} className="db-state muted">
                    {debounced ? `No rows match "${debounced}".` : "No rows yet — click “Add row”."}
                  </td></tr>
                ) : rows.map((row, i) => {
                  const k = keyLabel(pk, row);
                  return (
                    <tr key={`${page}-${i}-${k}`}>
                      {cols.filter((c) => c.name !== "_rowid").map((c) => {
                        const v = row[c.name];
                        const cellId = `${i}:${c.name}`;
                        const open = openCells.has(cellId);
                        const text = fmtCell(c.name, v);
                        const long = text.length > PREVIEW_LEN;
                        return (
                          <td key={c.name} className={v == null ? "is-null" : undefined}>
                            {v == null ? (
                              <span className="db-null">NULL</span>
                            ) : (
                              <button
                                type="button"
                                className={`db-cell${open ? " open" : ""}`}
                                onClick={() => setOpenCells((s) => {
                                  const next = new Set(s);
                                  if (next.has(cellId)) next.delete(cellId);
                                  else next.add(cellId);
                                  return next;
                                })}
                                title={long ? (open ? "Click to collapse" : `${text.length} chars — click to expand`) : text}
                              >
                                {open ? text : long ? `${text.slice(0, PREVIEW_LEN)}…` : text}
                              </button>
                            )}
                          </td>
                        );
                      })}
                      <td className="db-actions">
                        <button className="icon-btn" onClick={() => openEdit(row)} title={`Edit row (${k})`} aria-label={`Edit row ${k}`}>
                          <IconEdit size={14} />
                        </button>
                        <button
                          className="icon-btn danger"
                          onClick={() => askDelete(row)}
                          disabled={busyKey === k}
                          title={`Delete row (${k})`}
                          aria-label={`Delete row ${k}`}
                        >
                          {busyKey === k ? <Spinner size={14} /> : <IconTrash size={14} />}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="db-pager">
            <span className="muted">
              {total === 0 ? "0 rows" : `${page * limit + 1}–${Math.min(total, (page + 1) * limit)} of ${total.toLocaleString()} rows`}
              {debounced && <> matching “{debounced}”</>}
            </span>
            <span className="spacer" />
            <button className="btn sm" disabled={page <= 0} onClick={() => setPage(0)} title="First page">«</button>
            <button className="btn sm" disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>‹ Prev</button>
            <span className="db-page-n">Page {page + 1} / {pages}</span>
            <button className="btn sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next ›</button>
            <button className="btn sm" disabled={page + 1 >= pages} onClick={() => setPage(pages - 1)} title="Last page">»</button>
          </div>
        </>
      ) : (
        <p className="muted">Select a table above.</p>
      )}

      {/* Add / Edit modal */}
      {modal && (
        <div className="db-modal-overlay">
          <div className="db-modal" role="dialog" aria-modal="true" aria-label={modal.mode === "add" ? `Add row to ${table}` : `Edit row in ${table}`} onClick={(e) => e.stopPropagation()}>
            <div className="db-modal-head">
              <h3>{modal.mode === "add" ? `Add row → ${table}` : `Edit row → ${table}`}</h3>
              <button className="icon-btn" onClick={() => setModal(null)} disabled={saving} aria-label="Close">
                <IconX size={15} />
              </button>
            </div>
            {modal.mode === "edit" && modal.row && (
              <p className="db-modal-key muted">{keyLabel(pk, modal.row)}</p>
            )}
            <div className="db-form">
              {cols.filter((c) => c.name !== "_rowid").map((c) => {
                const locked = modal.mode === "edit" && pk.includes(c.name);
                const isNull = nulls.has(c.name);
                const big = isBig(c);
                return (
                  <label key={c.name} className={`db-field${big ? " wide" : ""}`}>
                    <span className="db-field-head">
                      <span className="db-field-name">
                        {c.pk && <span className="db-pk" title="Primary key">★</span>}
                        {c.name}
                        <span className="db-type">{(c.type || "").toLowerCase()}{c.notnull ? " · required" : ""}</span>
                      </span>
                      {!locked && !c.notnull && (
                        <span className="db-null-check">
                          <input
                            type="checkbox"
                            checked={isNull}
                            onChange={(e) => setNulls((s) => {
                              const next = new Set(s);
                              if (e.target.checked) next.add(c.name);
                              else next.delete(c.name);
                              return next;
                            })}
                          /> NULL
                        </span>
                      )}
                    </span>
                    {big ? (
                      <textarea
                        rows={Math.min(10, Math.max(3, Math.ceil(strVal(form[c.name]).length / 90)))}
                        value={isNull ? "" : (form[c.name] ?? "")}
                        disabled={locked || isNull || saving}
                        onChange={(e) => setForm((f) => ({ ...f, [c.name]: e.target.value }))}
                        placeholder={c.default != null ? `Default: ${c.default}` : locked ? "" : "—"}
                        spellCheck={false}
                      />
                    ) : (
                      <input
                        type={isNumeric(c.type) ? "number" : "text"}
                        value={isNull ? "" : (form[c.name] ?? "")}
                        disabled={locked || isNull || saving}
                        onChange={(e) => setForm((f) => ({ ...f, [c.name]: e.target.value }))}
                        placeholder={c.default != null ? `Default: ${c.default}` : locked ? "" : "—"}
                        spellCheck={false}
                      />
                    )}
                  </label>
                );
              })}
            </div>
            {formError && <div className="db-error">{formError}</div>}
            <div className="db-modal-actions">
              <button className="btn sm" onClick={() => setModal(null)} disabled={saving}>Cancel</button>
              <button className="btn primary sm" onClick={saveModal} disabled={saving}>
                {saving ? <Spinner size={14} /> : <IconCheck size={14} />}
                {modal.mode === "add" ? "Insert row" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
