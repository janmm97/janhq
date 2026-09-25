"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { elapsed, type Tone } from "@/lib/client/format";
import { STATE_TEXT, type Station } from "@/lib/client/stations";

export function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(" ");
}

// A state's square (dense rows) and mark (prints): outline, dash and fill carry the state, so it reads
// without colour; only "you" (the safelight) and "fog" (failure) have any.
const SQUARE: Record<Tone, string> = {
  you: "border-safe bg-safe",
  run: "border-paper",
  plan: "border-silver",
  line: "border-dashed border-silver",
  fixed: "border-fixed bg-fixed",
  unfixed: "border-dashed border-paper",
  fog: "border-fog bg-fog",
  pulled: "border-rim-strong",
  preview: "border-silver-hi",
};
const MARK: Record<Tone, string> = {
  you: "border-safe bg-safe text-on-safe",
  run: "border-paper text-paper",
  plan: "border-silver text-silver-hi",
  line: "border-dashed border-silver text-silver-hi",
  fixed: "border-fixed bg-fixed text-ground",
  unfixed: "border-dashed border-paper text-paper",
  fog: "border-fog text-fog line-through decoration-1",
  pulled: "border-rim-strong text-silver",
  preview:
    "border-silver-hi text-paper bg-[linear-gradient(90deg,var(--color-strip-1)_0_20%,var(--color-strip-2)_20%_40%,var(--color-strip-3)_40%_60%,var(--color-strip-4)_60%_80%,var(--color-strip-5)_80%_100%)] bg-[length:100%_2px] bg-bottom bg-no-repeat",
};
const STATUS_TEXT_CLASS: Record<Tone, string> = {
  you: "text-safe",
  fog: "text-fog",
  run: "text-paper",
  unfixed: "text-paper",
  fixed: "text-silver-hi",
  plan: "text-silver-hi",
  line: "text-silver-hi",
  pulled: "text-silver",
  preview: "text-paper",
};

export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cx("inline-block size-[7px] shrink-0 rounded-[1px] border", SQUARE[tone], className)} />;
}

/** A state as a square plus HQ's word for it, for dense rows. Status is never colour alone. */
export function Status({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2 whitespace-nowrap text-[12.5px]", STATUS_TEXT_CLASS[tone], className)}>
      <StatusDot tone={tone} />
      {children}
    </span>
  );
}

/** A state as a mark on a print (spec 1.5): HQ's word, in the state's shape. */
export function Mark({ tone, children, className, title }: { tone: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-[3px] border px-2 text-[11px] font-bold uppercase leading-none tracking-[0.12em]", MARK[tone], className)}>
      {children}
    </span>
  );
}

/** A neutral label (workspace, platform). One and Studio are told apart by name, never by colour. */
export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("inline-flex items-center rounded-[3px] border border-rim-strong px-1.5 py-px text-[12px] text-silver-hi", className)}>{children}</span>;
}

/** One surface on a hairline rim. Surfaces never nest: put rows, not panels, inside a panel. */
export function Panel({ title, description, actions, children, className, bodyClassName, id }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; id?: string }) {
  return (
    <section id={id} aria-labelledby={title && id ? `${id}-title` : undefined} className={cx("rounded-[6px] border border-rim bg-room shadow-[0_16px_30px_-22px_rgba(0,0,0,0.95)]", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-rim px-4 py-3">
          <div className="min-w-0">
            {title && (
              <h2 id={id ? `${id}-title` : undefined} className="truncate text-[11px] font-bold uppercase tracking-[0.16em] text-silver-hi">
                {title}
              </h2>
            )}
            {description && <p className="mt-1 text-[12px] text-silver">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

/** A section's heading on the page ground: a tracked label over a hairline, no box. */
export function SectionHead({ title, action, id }: { title: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-rim pb-2.5">
      <h2 id={id} className="truncate text-[11px] font-bold uppercase tracking-[0.16em] text-silver-hi">
        {title}
      </h2>
      {action}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
const BUTTON_BASE = "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[4px] border font-semibold uppercase tracking-[0.08em] transition-colors duration-200 ease-out-expo";
const BUTTON_SIZE = { sm: "h-8 px-3 text-[12px]", md: "h-10 px-4 text-[12px]" };
const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "border-safe bg-safe text-on-safe hover:border-safe-lit hover:bg-safe-lit",
  secondary: "border-rim-strong bg-transparent text-silver-hi hover:border-silver hover:text-paper",
  ghost: "border-transparent bg-transparent text-silver hover:bg-tray hover:text-paper",
  danger: "border-fog/60 bg-transparent text-fog hover:bg-fog/10",
};

export function Button({
  children,
  onClick,
  variant = "secondary",
  size = "md",
  disabled,
  type = "button",
  className,
  title,
  ...rest
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
  title?: string;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  "aria-pressed"?: boolean;
  "aria-haspopup"?: "listbox" | "menu" | "dialog" | boolean;
  "aria-controls"?: string;
  "data-testid"?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      {...rest}
      className={cx(BUTTON_BASE, "disabled:cursor-not-allowed disabled:border-rim disabled:bg-transparent disabled:text-gray", BUTTON_SIZE[size], BUTTON_VARIANT[variant], className)}
    >
      {children}
    </button>
  );
}

/** A link that looks like a button: for actions that open a page (Open, Answer, New agent). */
export function ButtonLink({ href, children, variant = "secondary", size = "sm", className, title, ...rest }: { href: string; children: ReactNode; variant?: ButtonVariant; size?: "sm" | "md"; className?: string; title?: string; "aria-label"?: string; "data-testid"?: string }) {
  return (
    <Link href={href} title={title} {...rest} className={cx(BUTTON_BASE, BUTTON_SIZE[size], BUTTON_VARIANT[variant], className)}>
      {children}
    </Link>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label, size = "sm" }: { tabs: Array<{ value: T; label: string }>; value: T; onChange: (v: T) => void; label: string; size?: "sm" | "md" }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-[4px] border border-rim bg-ground p-0.5">
      {tabs.map((t, i) => (
        <button
          key={t.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          type="button"
          aria-selected={value === t.value}
          tabIndex={value === t.value ? 0 : -1}
          onClick={() => onChange(t.value)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            e.preventDefault();
            const n = (i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
            onChange(tabs[n].value);
            refs.current[n]?.focus();
          }}
          className={cx(
            "rounded-[3px] font-medium transition-colors duration-200 ease-out-expo",
            size === "sm" ? "px-2.5 py-1 text-[12.5px]" : "px-3 py-1.5 text-[13px]",
            value === t.value ? "bg-tray text-paper shadow-[inset_0_0_0_1px_var(--color-rim-strong)]" : "text-silver hover:text-paper",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export interface MenuOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

/** Accessible single-select dropdown: arrow keys move, Enter selects, Escape closes. */
export function Menu<T extends string>({
  value,
  options,
  onChange,
  label,
  renderButton,
  align = "left",
  placement = "bottom",
  testId,
}: {
  value: T;
  options: Array<MenuOption<T>>;
  onChange: (v: T) => void;
  label: string;
  renderButton?: (current: MenuOption<T> | undefined) => ReactNode;
  align?: "left" | "right";
  placement?: "top" | "bottom";
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const onDoc = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    requestAnimationFrame(() => list.current?.focus());
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, options, value]);

  const choose = (i: number) => {
    onChange(options[i].value);
    setOpen(false);
    btn.current?.focus();
  };

  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={`${label}: ${current?.label ?? ""}`}
        data-testid={testId}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-rim-strong bg-transparent px-2.5 text-[12.5px] text-silver-hi transition-colors duration-200 ease-out-expo hover:border-silver hover:text-paper"
      >
        {renderButton ? renderButton(current) : current?.label}
        <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" className="opacity-80">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <ul
          ref={list}
          id={`${id}-list`}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${id}-opt-${active}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
              btn.current?.focus();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => (a + 1) % options.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a - 1 + options.length) % options.length);
            } else if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              choose(active);
            } else if (e.key === "Tab") {
              setOpen(false);
            }
          }}
          className={cx(
            "absolute z-50 min-w-[220px] rounded-[6px] border border-rim-strong bg-room p-1 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.85)] outline-none",
            align === "right" ? "right-0" : "left-0",
            placement === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
          )}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={o.value === value}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(i);
              }}
              className={cx("flex cursor-pointer items-start gap-2 rounded-[4px] px-2.5 py-2", i === active ? "bg-tray" : "")}
            >
              <span className={cx("mt-1.5 size-1.5 shrink-0 rounded-[1px]", o.value === value ? "bg-paper" : "bg-transparent")} />
              <span className="min-w-0">
                <span className="block text-[13px] text-paper">{o.label}</span>
                {o.description && <span className="block text-[12px] leading-snug text-silver">{o.description}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Focus-trapped modal. Escape closes; focus returns to the opener. */
export function Modal({ open, onClose, title, children, footer, wide = false, testId }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const el = ref.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []);
    (focusables()[0] ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-testid={testId} className={cx("w-full rounded-[8px] border border-rim-strong bg-room shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)] outline-none", wide ? "max-w-3xl" : "max-w-lg")}>
        <header className="flex items-center justify-between border-b border-rim px-5 py-3.5">
          <h2 id={titleId} className="text-[14px] font-bold text-paper">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-[4px] p-1 text-silver hover:bg-tray hover:text-paper">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-rim px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** A line of numbers, replacing stat tiles and ring gauges: "34 tasks · 19 verified · …". */
export function Readout({ items, className }: { items: Array<{ value: ReactNode; label: string }>; className?: string }) {
  return (
    <p className={cx("text-[12.5px] text-silver", className)} data-testid="readout">
      {items.map((it, i) => (
        <span key={`${i}-${it.label}`}>
          {i > 0 && <span aria-hidden> · </span>}
          <b className="font-bold text-paper">{it.value}</b> {it.label}
        </span>
      ))}
    </p>
  );
}

export type CircleTone = "fixed" | "fog" | "paper" | "silver" | "silver-hi";
const CIRCLE_STROKE: Record<CircleTone, string> = {
  fixed: "var(--color-fixed)",
  fog: "var(--color-fog)",
  paper: "var(--color-paper)",
  silver: "var(--color-silver)",
  "silver-hi": "var(--color-silver-hi)",
};
// An 88px box with the 4px stroke inside it: the ring's inner edge leaves an 80px well for the centre.
const CIRCLE_R = 42;
const CIRCLE_C = 2 * Math.PI * CIRCLE_R;

// The Dashboard's top-band circle, which the operator asked for on 2026-09-24. It is the only ring in
// HQ; everywhere else numbers stay a readout line. The arc is the share value/of, from 12 o'clock
// clockwise on a hairline track; there is no arc when there is nothing to show.
export function CircleStat({ label, value, of, tone, centre, caption }: { label: string; value: number; of: number | null; tone: CircleTone; centre?: ReactNode; caption?: string }) {
  const captionId = useId();
  const share = of ? Math.min(1, Math.max(0, value / of)) : 0;
  const shown = centre ?? value;
  const spoken = typeof shown === "string" || typeof shown === "number" ? String(shown) : String(value);
  // A long centre (a sub-cent cost such as $0.0034) steps down so it stays inside the ring.
  const long = spoken.length > 5;
  return (
    <figure
      data-testid="circle"
      aria-label={`${label}: ${centre !== undefined || of === null ? spoken : `${value} of ${of}`}`}
      aria-describedby={caption ? captionId : undefined}
      className="flex min-w-0 flex-col items-center text-center"
    >
      <div className="relative size-[88px] shrink-0">
        <svg aria-hidden width="88" height="88" viewBox="0 0 88 88" className="block">
          <circle cx="44" cy="44" r={CIRCLE_R} fill="none" stroke="var(--color-rim)" strokeWidth="4" />
          {share > 0 && <circle cx="44" cy="44" r={CIRCLE_R} fill="none" stroke={CIRCLE_STROKE[tone]} strokeWidth="4" strokeLinecap="butt" strokeDasharray={`${share * CIRCLE_C} ${CIRCLE_C}`} transform="rotate(-90 44 44)" />}
        </svg>
        <span className={cx("tabular absolute inset-0 flex items-center justify-center whitespace-nowrap font-extralight leading-none text-paper", long ? "text-[16px]" : "text-[22px]")}>{shown}</span>
      </div>
      <figcaption className="mt-3 min-w-0 max-w-full">
        <span className="block text-[11px] font-bold uppercase leading-[1.3] tracking-[0.16em] text-silver-hi">{label}</span>
        {caption && (
          <span id={captionId} className="mt-1 block text-[12px] leading-[1.5] text-silver">
            {caption}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

/** A running task's elapsed time, as a darkroom timer reads it. */
export function Timer({ since, limitLabel, size = "md" }: { since: string; limitLabel?: string; size?: "sm" | "md" }) {
  const now = useNow(1000);
  return (
    <div className="shrink-0 text-right">
      <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-silver">Elapsed</div>
      <div className={cx("font-extralight leading-none tracking-[-0.02em] text-paper", size === "md" ? "mt-1 text-[38px]" : "mt-0.5 text-[20px]")} data-testid="timer">
        {elapsed(since, now)}
      </div>
      {limitLabel && <div className="mt-1 text-[12px] text-silver">limit {limitLabel}</div>}
    </div>
  );
}

// The test strip: a stepped band from fibre white to dense black, one band per station. A station
// that has not taken its tone yet (current, waiting, failed, stopped) is drawn on the tray with an
// inset outline instead, so "reached and done" always reads differently from "here right now".
const STRIP_TONE = ["bg-strip-1 text-ground", "bg-strip-2 text-ground", "bg-strip-3 text-ground", "bg-strip-4 text-paper", "bg-strip-5 text-silver", "bg-strip-6 text-silver"];
const STATE_BAND: Partial<Record<Station["state"], string>> = {
  current: "bg-tray text-paper shadow-[inset_0_0_0_2px_var(--color-paper)]",
  waiting: "bg-tray text-paper shadow-[inset_0_0_0_2px_var(--color-safe)]",
  failed: "bg-tray text-fog shadow-[inset_0_0_0_2px_var(--color-fog)]",
  stopped: "bg-tray text-silver-hi shadow-[inset_0_0_0_2px_var(--color-rim-strong)]",
  todo: "bg-transparent text-silver outline-1 outline-dashed -outline-offset-1 outline-rim-strong",
  skipped: "bg-transparent text-silver outline-1 outline-dashed -outline-offset-1 outline-rim-strong",
};

// Six across once the strip's own box has room for every label (about 420px); below that it folds to
// three by two, and a two-word label wraps rather than truncating, so every station stays readable.
export function TestStrip({ stations, compact = false, className }: { stations: Station[]; compact?: boolean; className?: string }) {
  return (
    <div className={cx("@container", className)}>
      <ol aria-label="Stations" data-testid="test-strip" className="grid grid-cols-3 overflow-hidden rounded-[3px] border border-rim-strong @md:grid-cols-6">
        {stations.map((s, i) => (
          <li
            key={s.key}
            data-state={s.state}
            aria-current={s.state === "current" || s.state === "waiting" ? "step" : undefined}
            title={`${s.label} · ${s.under} · ${STATE_TEXT[s.state]}`}
            className={cx("flex min-w-0 flex-col justify-between gap-1 px-2", compact ? "py-1.5" : "py-2.5", s.state === "done" ? STRIP_TONE[i] : STATE_BAND[s.state])}
          >
            <span className="text-[11px] font-extrabold uppercase leading-tight tracking-[0.08em]">{s.label}</span>
            <span className="sr-only">: {STATE_TEXT[s.state]}</span>
            {!compact && <span className="truncate text-[12px]">{s.state === "done" || s.state === "todo" || s.state === "current" ? s.under : STATE_TEXT[s.state]}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function EmptyState({ title, body, action, compact = false }: { title: string; body?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx("flex flex-col items-start gap-1.5 rounded-[6px] border border-dashed border-rim-strong", compact ? "px-3 py-3" : "px-4 py-6")}>
      <p className="text-[13.5px] font-semibold text-paper">{title}</p>
      {body && <div className="max-w-[64ch] text-[12.5px] text-silver">{body}</div>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  );
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(i);
  }, [intervalMs]);
  return now;
}

export function ErrorNote({ error }: { error: Error | null | undefined }) {
  if (!error) return null;
  const code = (error as { code?: string }).code;
  return (
    <div role="alert" className="rounded-[4px] border border-fog/60 px-3 py-2 text-[12.5px] text-fog">
      {code ? <span className="font-bold">{code}</span> : null} {error.message}
    </div>
  );
}

export function useOutsideClose(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const handler = useCallback(
    (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    },
    [onClose],
  );
  useEffect(() => {
    if (!open) return;
    document.addEventListener("mousedown", handler);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, handler, onClose]);
  return ref;
}
