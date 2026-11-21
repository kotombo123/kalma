import {
  NORMALIZED,
  OP_LABEL,
  childrenOf,
  isGroup,
  type Condition,
  type Leaf,
  type Op,
} from '../lib/rules.ts';
import { useTranslation } from 'react-i18next';
import { Button } from './ui.tsx';
import { fieldLabel } from '../lib/labels.ts';

const OPS = Object.keys(OP_LABEL) as Op[];
/** Everyday comparisons; pattern/regex ones stay available once a condition already uses them. */
const BASIC_OPS: Op[] = ['eq', 'neq', 'gt', 'lt', 'in', 'contains', 'exists'];

function parseValue(op: Op, text: string): unknown {
  if (op === 'in' || op === 'nin')
    return text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  if (['gt', 'gte', 'lt', 'lte'].includes(op) && text.trim() !== '' && !Number.isNaN(Number(text)))
    return Number(text);
  return text;
}
const valueText = (v: unknown) => (Array.isArray(v) ? v.join(', ') : v === undefined ? '' : String(v));

function LeafRow({
  leaf,
  fieldsId,
  disabled,
  onChange,
  onRemove,
  path,
}: {
  leaf: Leaf;
  fieldsId: string;
  disabled: boolean;
  onChange: (l: Leaf) => void;
  onRemove: () => void;
  path: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 py-1">
      <label className="sr-only" htmlFor={`${path}-f`}>
        {t('condition.field')}
      </label>
      <input
        id={`${path}-f`}
        list={fieldsId}
        value={leaf.field}
        disabled={disabled}
        onChange={(e) => onChange({ ...leaf, field: e.target.value })}
        placeholder={t('condition.fieldPlaceholder')}
        title={leaf.field || undefined}
        className="h-8 w-56 rounded-control border border-rule bg-sheet px-2 text-sm"
      />
      {leaf.field && fieldLabel(leaf.field) !== leaf.field && (
        <span className="text-sm font-semibold" aria-hidden>
          {fieldLabel(leaf.field)}
        </span>
      )}
      <label className="sr-only" htmlFor={`${path}-o`}>
        {t('condition.op')}
      </label>
      <select
        id={`${path}-o`}
        value={leaf.op}
        disabled={disabled}
        onChange={(e) => {
          const op = e.target.value as Op;
          onChange({
            ...leaf,
            op,
            value: op === 'exists' ? undefined : parseValue(op, valueText(leaf.value)),
          });
        }}
        className="h-8 rounded-control border border-rule bg-sheet px-2 text-sm"
      >
        {OPS.filter((o) => BASIC_OPS.includes(o) || o === leaf.op).map((o) => (
          <option key={o} value={o}>
            {OP_LABEL[o]}
          </option>
        ))}
      </select>
      {leaf.op !== 'exists' && (
        <>
          <label className="sr-only" htmlFor={`${path}-v`}>
            {t('condition.value')}
          </label>
          <input
            id={`${path}-v`}
            value={valueText(leaf.value)}
            disabled={disabled}
            onChange={(e) => onChange({ ...leaf, value: parseValue(leaf.op, e.target.value) })}
            placeholder={leaf.op === 'in' || leaf.op === 'nin' ? 'a, b, c' : t('condition.valuePlaceholder')}
            className="h-8 w-56 rounded-control border border-rule bg-sheet px-2 text-sm"
          />
        </>
      )}
      {!disabled && (
        <Button type="button" variant="quiet" onClick={onRemove} aria-label={t('condition.removeAria')}>
          {t('condition.remove')}
        </Button>
      )}
    </div>
  );
}

/** AND / OR groups of field conditions — the same tree the API stores. */
export function ConditionEditor({
  value,
  onChange,
  fields,
  disabled = false,
  path = 'c',
  onRemove,
}: {
  value: Condition;
  onChange: (c: Condition) => void;
  fields: string[];
  disabled?: boolean;
  path?: string;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const fieldsId = 'rule-fields';
  if (!isGroup(value)) {
    return (
      <p className="text-sm text-ink-soft">
        {t('condition.notEditable')}
      </p>
    );
  }
  const items = childrenOf(value);
  const mode: 'all' | 'any' = 'all' in value ? 'all' : 'any';
  const set = (next: Condition[], m = mode) => onChange(m === 'all' ? { all: next } : { any: next });
  const replace = (i: number, c: Condition) => set(items.map((x, j) => (j === i ? c : x)));
  const remove = (i: number) => set(items.filter((_, j) => j !== i));

  return (
    <div className={`rounded-control border-l-2 pl-3 ${path === 'c' ? 'border-margin' : 'border-rule'}`}>
      {path === 'c' && (
        <datalist id={fieldsId}>
          {Object.keys(NORMALIZED).map((f) => (
            <option key={f} value={f}>
              {NORMALIZED[f]}
            </option>
          ))}
          {fields.map((f) => (
            <option key={f} value={f}>
              {fieldLabel(f)}
            </option>
          ))}
        </datalist>
      )}
      <div className="flex items-center gap-2 text-sm">
        <span>{path === 'c' ? t('condition.whenAll') : t('condition.orWhen')}</span>
        <select
          aria-label={t('condition.combineAria')}
          value={mode}
          disabled={disabled}
          onChange={(e) => set(items, e.target.value as 'all' | 'any')}
          className="h-8 rounded-control border border-rule bg-sheet px-2 font-semibold"
        >
          <option value="all">{t('condition.all')}</option>
          <option value="any">{t('condition.any')}</option>
        </select>
        {t('condition.are') && <span>{t('condition.are')}</span>}
        {onRemove && !disabled && (
          <Button type="button" variant="quiet" onClick={onRemove}>
            {t('condition.removeGroup')}
          </Button>
        )}
      </div>
      {items.map((c, i) =>
        isGroup(c) ? (
          <div key={i} className="my-1">
            <ConditionEditor
              value={c}
              onChange={(n) => replace(i, n)}
              fields={fields}
              disabled={disabled}
              path={`${path}-${i}`}
              onRemove={() => remove(i)}
            />
          </div>
        ) : 'not' in c ? (
          <p key={i} className="py-1 text-sm text-ink-soft">
            {t('condition.notOnlyText')}
          </p>
        ) : (
          <LeafRow
            key={i}
            leaf={c}
            path={`${path}-${i}`}
            fieldsId={fieldsId}
            disabled={disabled}
            onChange={(l) => replace(i, l)}
            onRemove={() => remove(i)}
          />
        ),
      )}
      {!disabled && (
        <div className="flex gap-2 py-1">
          <Button
            type="button"
            variant="quiet"
            onClick={() => set([...items, { field: '', op: 'eq', value: '' }])}
          >
            {t('condition.addCondition')}
          </Button>
          {path === 'c' && (
            <Button
              type="button"
              variant="quiet"
              className="text-ink-soft"
              onClick={() => set([...items, { any: [{ field: '', op: 'eq', value: '' }] }])}
            >
              {t('condition.addOrGroup')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
