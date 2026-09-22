import { Component, type ReactNode } from "react";

// Per-view crash containment: without this, a render throw in any one view
// (Resource / Director / Create Song / Video LipSync — all stay mounted while
// hidden) unmounts the whole Studio and the user gets a blank page with no
// explanation. The boundary shows which view crashed, the actual error, and a
// retry that remounts the view (refetching its data).
export default function ViewBoundary({ name, children }: {
  name: string;
  children: ReactNode;
}) {
  return (
    <ErrorBoundary key={name} viewName={name}>
      {children}
    </ErrorBoundary>
  );
}

type Props = { viewName: string; children: ReactNode };
type State = { error: Error | null };

class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error(`[view:${this.props.viewName}]`, error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section className="card" role="alert" aria-label={`${this.props.viewName} failed to render`}>
        <div className="card-head">
          <h2>{this.props.viewName} couldn&apos;t be shown</h2>
        </div>
        <p className="err-text">{error.message || String(error)}</p>
        <div className="dialog-actions">
          <button
            type="button"
            className="primary"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      </section>
    );
  }
}
