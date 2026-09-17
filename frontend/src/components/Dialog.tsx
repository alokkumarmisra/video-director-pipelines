import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { IconAlert, IconCheck, IconSparkles, IconTrash, IconX } from "./Icons";

export type DialogTone = "info" | "success" | "warning" | "error";

export interface AlertOptions {
  title?: string;
  tone?: DialogTone;
  okText?: string;
}

export interface ConfirmOptions {
  title?: string;
  tone?: DialogTone;
  okText?: string;
  cancelText?: string;
  /** Danger styling on the confirm button (implied by tone "error"). */
  danger?: boolean;
}

interface DialogItem {
  id: number;
  kind: "alert" | "confirm";
  title: string;
  message: string;
  tone: DialogTone;
  okText: string;
  cancelText: string;
  danger: boolean;
  resolve: (v: boolean) => void;
}

export interface DialogApi {
  /** Beautiful replacement for window.alert — resolves when dismissed. */
  alert(message: string, opts?: AlertOptions): Promise<void>;
  /** Beautiful replacement for window.confirm — resolves true on confirm. */
  confirm(message: string, opts?: ConfirmOptions): Promise<boolean>;
}

const DialogCtx = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const api = useContext(DialogCtx);
  if (!api) throw new Error("useDialog must be used inside <DialogProvider>");
  return api;
}

let nextId = 1;

const DEFAULT_TITLES: Record<DialogTone, string> = {
  info: "Notice",
  success: "Done",
  warning: "Please confirm",
  error: "Something went wrong",
};

function ToneIcon({ tone, danger }: { tone: DialogTone; danger: boolean }) {
  const size = 20;
  if (tone === "success") return <IconCheck size={size} />;
  if (tone === "warning") return <IconAlert size={size} />;
  if (tone === "error") return danger ? <IconTrash size={size} /> : <IconX size={size} />;
  return <IconSparkles size={size} />;
}

// Global alert/confirm dialogs. Mount <DialogProvider> once near the app
// root; any card calls dialog.alert()/dialog.confirm() instead of the native
// window.alert()/window.confirm(). Requests queue — one dialog at a time —
// and resolve as promises, so callers stay linear async code.
export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<DialogItem[]>([]);
  const okRef = useRef<HTMLButtonElement>(null);

  const alert = useCallback((message: string, opts?: AlertOptions): Promise<void> => {
    const tone = opts?.tone ?? "info";
    return new Promise<void>((resolve) => {
      const item: DialogItem = {
        id: nextId++,
        kind: "alert",
        title: opts?.title ?? DEFAULT_TITLES[tone],
        message,
        tone,
        okText: opts?.okText ?? "OK",
        cancelText: "",
        danger: false,
        resolve: () => resolve(),
      };
      setQueue((q) => [...q, item]);
    });
  }, []);

  const confirm = useCallback((message: string, opts?: ConfirmOptions): Promise<boolean> => {
    const tone = opts?.tone ?? "warning";
    return new Promise<boolean>((resolve) => {
      const item: DialogItem = {
        id: nextId++,
        kind: "confirm",
        title: opts?.title ?? DEFAULT_TITLES[tone],
        message,
        tone,
        okText: opts?.okText ?? "Confirm",
        cancelText: opts?.cancelText ?? "Cancel",
        danger: opts?.danger ?? tone === "error",
        resolve,
      };
      setQueue((q) => [...q, item]);
    });
  }, []);

  const current = queue[0] ?? null;

  const settle = useCallback((result: boolean) => {
    if (!current) return;
    current.resolve(result);
    setQueue((q) => q.filter((d) => d.id !== current.id));
  }, [current]);

  // Esc dismisses (cancel for confirms), Enter activates the primary button.
  // The dialog carries no text inputs, so global Enter is safe.
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); settle(false); }
      else if (e.key === "Enter") { e.preventDefault(); settle(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, settle]);

  // Focus the primary action on open; lock background scroll while open.
  useEffect(() => {
    if (!current) return;
    okRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [current]);

  return (
    <DialogCtx.Provider value={{ alert, confirm }}>
      {children}
      {current && (
        <div
          className="dlg-overlay"
          role="alertdialog"
          aria-modal="true"
          aria-label={current.title}
          onClick={() => settle(current.kind === "alert")}
        >
          <div className="dlg-box" data-tone={current.tone} onClick={(e) => e.stopPropagation()}>
            <div className="dlg-icon" data-tone={current.tone} aria-hidden="true">
              <ToneIcon tone={current.tone} danger={current.danger} />
            </div>
            <h3 className="dlg-title">{current.title}</h3>
            <p className="dlg-message">{current.message}</p>
            <div className="dlg-actions">
              {current.kind === "confirm" && (
                <button className="ghost" onClick={() => settle(false)}>
                  {current.cancelText}
                </button>
              )}
              <button
                ref={okRef}
                className={current.danger ? "danger" : "primary"}
                onClick={() => settle(true)}
              >
                {current.okText}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogCtx.Provider>
  );
}
