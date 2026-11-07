import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";

import { HELP_TEXTS } from "../lib/help-texts";

/**
 * §4.5 标题旁 ⓘ 气泡（arch/12 v1.9）：口径/规则说明统一入口。
 * 点击开、Esc/外点关；文案取自 lib/help-texts.ts 注册表（一处维护）。
 */
export function HelpIcon({ pageKey }: { pageKey: string }) {
  const help = HELP_TEXTS[pageKey];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  if (!help) return null;

  return (
    <span className="help-icon-wrap" ref={ref}>
      <button
        type="button"
        className="help-icon"
        aria-label={`说明：${help.title}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Info size={14} />
      </button>
      {open ? (
        <span className="help-bubble" role="note">
          <strong>{help.title}</strong>
          <p>{help.body}</p>
        </span>
      ) : null}
    </span>
  );
}
