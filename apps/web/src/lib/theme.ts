import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const KEY = 'theme';

const initial = (): Theme =>
  (localStorage.getItem(KEY) as Theme | null) ??
  (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem(KEY, theme);
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) };
}
