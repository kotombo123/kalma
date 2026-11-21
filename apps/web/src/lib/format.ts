import i18n from './i18n.ts';

/** Locale for dates and numbers, following the UI language (24-hour clock in both). */
export const uiLocale = () => (i18n.language === 'pl' ? 'pl-PL' : 'en-GB');
const timeFmt = () => new Intl.DateTimeFormat(uiLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dayFmt = () => new Intl.DateTimeFormat(uiLocale(), { day: 'numeric', month: 'short' });

/** "03:17:25" today, "23 paź 11:14" otherwise. */
export function when(iso: string) {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? timeFmt().format(d)
    : `${dayFmt().format(d)} ${timeFmt().format(d).slice(0, 5)}`;
}

export const plural = (n: number, one: string, few: string, many: string) => {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n === 1) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
};
