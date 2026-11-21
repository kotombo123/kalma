import {
  cloneElement,
  isValidElement,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { Severity } from '../lib/types.ts';

type Variant = 'primary' | 'quiet' | 'ink';

const variants: Record<Variant, string> = {
  primary: 'bg-ink text-sheet hover:bg-ink/90',
  quiet: 'text-ink hover:bg-rule/40',
  ink: 'border border-rule bg-sheet text-ink hover:border-ink-soft',
};

export function Button({
  variant = 'ink',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`inline-flex h-8 items-center gap-1.5 rounded-control px-3 text-sm font-semibold transition-colors disabled:opacity-50 ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

/**
 * Label + control + hint. The label points at the control by id (a wrapping <label> would put a
 * <select>'s option texts into its accessible name), and the hint is linked with aria-describedby.
 */
export function Field({ label, children, hint }: { label: string; children: ReactElement; hint?: string }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const control = isValidElement<{ id?: string; 'aria-describedby'?: string }>(children)
    ? cloneElement(children, { id, ...(hint && { 'aria-describedby': hintId }) })
    : children;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-semibold">
        {label}
      </label>
      {control}
      {hint && (
        <span id={hintId} className="mt-1 block text-xs text-ink-soft">
          {hint}
        </span>
      )}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className="h-9 w-full rounded-control border border-rule bg-sheet px-3 text-ink placeholder:text-ink-soft focus:border-ink-soft"
      {...props}
    />
  );
}

export const sevVar = (s: Severity) => `var(--${s})`;

/**
 * "Więcej opcji": settings with a sensible default stay folded away (implementation_plan.md §4a).
 * The button says how many are inside and how many differ from the default, so nothing hides silently.
 */
export function MoreOptions({
  count,
  changed = 0,
  label,
  children,
  defaultOpen = false,
}: {
  count?: number;
  changed?: number;
  label?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation();
  const text = label ?? t('ui.moreOptions');
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const meta = [
    count ? String(count) : '',
    changed ? t(changed === 1 ? 'ui.changedOne' : 'ui.changedMany', { count: changed }) : '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-control px-1 py-0.5 text-sm text-ink-soft hover:text-ink"
      >
        <span aria-hidden className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>
          ›
        </span>
        {open ? t('ui.hide', { label: text.toLowerCase() }) : text}
        {meta && <span className={changed ? 'font-semibold text-ink' : ''}>({meta})</span>}
      </button>
      {open && (
        <div id={id} className="mt-2 border-l-2 border-rule pl-4">
          {children}
        </div>
      )}
    </div>
  );
}

/** Shown when someone opens a screen their role does not use (the API would refuse the writes anyway). */
export function NoAccess({ what }: { what: string }) {
  const { t } = useTranslation();
  return (
    <div className="max-w-[72ch] px-6 py-5">
      <h1 className="text-2xl font-bold">{what}</h1>
      <p className="mt-2 text-ink-soft">{t('ui.noAccess')}</p>
    </div>
  );
}
