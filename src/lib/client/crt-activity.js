const normalizeKind = (kind) => String(kind || 'unknown').trim().toLowerCase() || 'unknown';

export function createCrtActivityRegistry(dispatch) {
  const tokens = new Map();
  let sequence = 0;

  const snapshot = () => {
    const counts = {};
    for (const kind of tokens.values()) counts[kind] = (counts[kind] || 0) + 1;
    return { counts, total: tokens.size };
  };

  const notify = () => dispatch?.(snapshot());

  return {
    begin(kind) {
      sequence += 1;
      const token = sequence;
      tokens.set(token, normalizeKind(kind));
      notify();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        tokens.delete(token);
        notify();
      };
    },
    snapshot,
    clear() {
      if (!tokens.size) return;
      tokens.clear();
      notify();
    },
  };
}

const registry = createCrtActivityRegistry((detail) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('torplex:crt-activity', { detail }));
});

export const beginCrtActivity = (kind) => registry.begin(kind);
export const getCrtActivity = () => registry.snapshot();
