export const INTERFACE_THEME_STORAGE_KEY = 'torplex:interface-theme';
export const DEFAULT_INTERFACE_THEME = 'galaxy';

export const INTERFACE_THEMES = [
  {
    id: 'galaxy',
    name: 'Galaxy Class',
    civilization: 'Galaxy-class LCARS',
    code: 'GAL',
    rail: '1701',
    railCode: 'NCC\n1701-D',
    kicker: 'Library Computer Access / Retrieval System',
    cycleLabel: 'Stardate',
    cycle: '61324.7',
    footer: 'LCARS NCC-1701-D',
    footerEnd: '1701',
  },
  {
    id: 'intrepid',
    name: 'Intrepid Class',
    civilization: 'Intrepid-class LCARS',
    code: 'INT',
    rail: '74656',
    railCode: 'NCC\n74656',
    kicker: 'Intrepid-Class Integrated Data Network',
    cycleLabel: 'Stardate',
    cycle: '54973.4',
    footer: 'LCARS 74656-DELTA',
    footerEnd: '74656',
  },
];

const themesById = new Map(INTERFACE_THEMES.map((theme) => [theme.id, theme]));

export function normalizeInterfaceTheme(value) {
  if (value === 'tng') return 'galaxy';
  if (value === 'voyager') return 'intrepid';
  return themesById.has(value) ? value : DEFAULT_INTERFACE_THEME;
}

export function interfaceTheme(value) {
  return themesById.get(normalizeInterfaceTheme(value));
}

export function applyInterfaceTheme(value, { persist = true, notify = true } = {}) {
  const id = normalizeInterfaceTheme(value);
  const changed = document.documentElement.dataset.interfaceTheme !== id;
  document.documentElement.dataset.interfaceTheme = id;
  if (persist) localStorage.setItem(INTERFACE_THEME_STORAGE_KEY, id);
  if (changed && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.documentElement.classList.remove('interface-reconfiguring');
    void document.documentElement.offsetWidth;
    document.documentElement.classList.add('interface-reconfiguring');
    window.setTimeout(() => document.documentElement.classList.remove('interface-reconfiguring'), 320);
  }
  if (notify) {
    window.dispatchEvent(new CustomEvent('torplex:interface-theme', { detail: { theme: id } }));
  }
  return id;
}
