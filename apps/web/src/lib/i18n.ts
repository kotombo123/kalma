import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en.ts';
import pl from '../locales/pl.ts';

const LANG_KEY = 'kalma_lang';

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    pl: { translation: pl },
  },
  lng: localStorage.getItem(LANG_KEY) ?? 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function toggleLang() {
  const next = i18n.language === 'en' ? 'pl' : 'en';
  void i18n.changeLanguage(next);
  localStorage.setItem(LANG_KEY, next);
}

export default i18n;
