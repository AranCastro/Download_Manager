import { api } from './api.js';

// Accent hues, one step per mode. Each passes the chart validator's
// lightness, chroma and 3:1 surface-contrast checks for its mode
// (light surface #ffffff, dark surface #1b1e24).
export const ACCENTS = {
  blue: { label: 'Blue', light: '#2563eb', dark: '#5b8cf5' },
  violet: { label: 'Violet', light: '#7c3aed', dark: '#9b7bf0' },
  teal: { label: 'Teal', light: '#008a7e', dark: '#16a092' },
  green: { label: 'Green', light: '#15803d', dark: '#2aa95c' },
  orange: { label: 'Orange', light: '#c2410c', dark: '#d9722d' },
  rose: { label: 'Rose', light: '#e11d48', dark: '#e3566f' },
};

const media = window.matchMedia('(prefers-color-scheme: dark)');

export function isDarkTheme(theme) {
  return theme === 'dark' || (theme !== 'light' && media.matches);
}

// Applies theme, accent and density to the document, and tells the main
// process which colours to use for the native window buttons.
export function applyAppearance(settings) {
  const root = document.documentElement;
  const dark = isDarkTheme(settings.theme);
  const accent = ACCENTS[settings.accent] || ACCENTS.blue;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.density = settings.density || 'comfortable';
  root.style.setProperty('--accent', dark ? accent.dark : accent.light);
  const styles = getComputedStyle(root);
  api.setTitleBar?.({
    color: styles.getPropertyValue('--chrome').trim(),
    symbolColor: styles.getPropertyValue('--text').trim(),
  });
}

export function onSystemThemeChange(callback) {
  media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
}
