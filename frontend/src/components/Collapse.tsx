import type { ReactNode } from "react";

// Smooth hide/show wrapper for every collapsible section app-wide.
// Content stays mounted and animates height (grid-rows) + fade, so
// toggling a section never flicks the layout. When closed the wrapper
// is visibility-hidden, dropping it from the tab order and AT tree.
export default function Collapse({ open, children, className }: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`collapse${open ? "" : " closed"}${className ? ` ${className}` : ""}`}>
      <div className="collapse-inner">{children}</div>
    </div>
  );
}
