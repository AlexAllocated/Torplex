import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_INTERFACE_THEME,
  INTERFACE_THEMES,
  interfaceTheme,
  normalizeInterfaceTheme,
} from '../src/lib/client/interface-themes.js';
import { GALAXY_VISUAL_CONTRACT } from '../src/lib/client/galaxy-visual-contract.js';
import { INTREPID_VISUAL_CONTRACT } from '../src/lib/client/intrepid-visual-contract.js';

const css = await Bun.file(new URL('../src/routes/dashboard.css', import.meta.url)).text();
const dashboard = await Bun.file(new URL('../src/lib/client/dashboard.js', import.meta.url)).text();
const audio = await Bun.file(new URL('../src/lib/client/lcars-audio.js', import.meta.url)).text();
const layout = await Bun.file(new URL('../src/routes/+layout.svelte', import.meta.url)).text();

function block(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`));
  expect(match, `missing CSS block for ${selector}`).not.toBeNull();
  return match?.[1] || '';
}

function token(source: string, name: string) {
  const match = source.match(new RegExp(`--${name}:\\s*([^;]+);`));
  expect(match, `missing --${name}`).not.toBeNull();
  return match?.[1].trim();
}

describe('Starfleet interface registry', () => {
  test('exposes exactly the Galaxy and Intrepid class systems', () => {
    expect(DEFAULT_INTERFACE_THEME).toBe('galaxy');
    expect(INTERFACE_THEMES.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'galaxy', name: 'Galaxy Class' },
      { id: 'intrepid', name: 'Intrepid Class' },
    ]);
  });

  test('migrates legacy class names and rejects speculative systems', () => {
    expect(normalizeInterfaceTheme('tng')).toBe('galaxy');
    expect(normalizeInterfaceTheme('voyager')).toBe('intrepid');
    expect(normalizeInterfaceTheme('cardassian')).toBe('galaxy');
    expect(normalizeInterfaceTheme('borg')).toBe('galaxy');
  });

  test('publishes class-correct labels and vessel identifiers', () => {
    expect(interfaceTheme('galaxy')).toMatchObject({
      code: 'GAL',
      rail: '1701',
      railCode: 'NCC\n1701-D',
      kicker: 'Library Computer Access / Retrieval System',
      footerEnd: '1701',
    });
    expect(interfaceTheme('intrepid')).toMatchObject({
      code: 'INT',
      rail: '74656',
      railCode: 'NCC\n74656',
      kicker: 'Intrepid-Class Integrated Data Network',
      footerEnd: '74656',
    });
  });
});

describe('Starfleet visual specification tokens', () => {
  const root = block(':root');
  const galaxy = block('html[data-interface-theme="galaxy"]');
  const intrepid = block('html[data-interface-theme="intrepid"]');

  test('locks the Galaxy-era classic LCARS palette', () => {
    expect(token(root, 'violet')).toBe(GALAXY_VISUAL_CONTRACT.palette.bluey);
    expect(token(root, 'lilac')).toBe(GALAXY_VISUAL_CONTRACT.palette.africanViolet);
    expect(token(root, 'mauve')).toBe(GALAXY_VISUAL_CONTRACT.palette.trueMauve);
    expect(token(root, 'salmon')).toBe(GALAXY_VISUAL_CONTRACT.palette.almondCreme);
    expect(token(root, 'barley')).toBe(GALAXY_VISUAL_CONTRACT.palette.barley);
    expect(token(root, 'orange')).toBe(GALAXY_VISUAL_CONTRACT.palette.orange);
    expect(token(root, 'red')).toBe(GALAXY_VISUAL_CONTRACT.palette.red);
  });

  test('locks the Intrepid-era Voyager LCARS palette', () => {
    for (const [name, value] of Object.entries(INTREPID_VISUAL_CONTRACT.palette)) {
      const cssName = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      const sourceName = cssName === 'salmon' ? 'voyager-salmon' : cssName;
      expect(token(intrepid, sourceName)).toBe(value);
    }
    expect(token(intrepid, 'text')).toBe('var(--sky)');
    expect(INTREPID_VISUAL_CONTRACT.palette.sky).toBe('#70b5ff');
  });

  test('locks the Classic V26 frame, typography, and segmented bar grammar', async () => {
    expect(token(galaxy, 'rail')).toBe('15rem');
    expect(token(galaxy, 'galaxy-panel-border')).toBe('.25rem');
    expect(token(galaxy, 'galaxy-bar-border')).toBe('.35rem');
    expect(token(galaxy, 'galaxy-bar-height')).toBe('1.75rem');
    expect(token(galaxy, 'galaxy-divider-height')).toBe('.5rem');
    expect(token(galaxy, 'galaxy-outer-radius')).toBe('10rem');
    expect(token(galaxy, 'galaxy-content-radius')).toBe('3.75rem');
    expect(css).toContain('border-radius: 0 0 0 var(--galaxy-outer-radius)');
    expect(block('html[data-interface-theme="galaxy"] .lcars-nav a:first-child')).toContain(
      'border-radius: var(--galaxy-outer-radius) 0 0 0',
    );
    expect(block('html[data-interface-theme="galaxy"] .lcars-header-stripe')).toContain(
      'grid-template-columns: 40% 4% 17% minmax(0, 1fr) 4%',
    );
    expect(GALAXY_VISUAL_CONTRACT.typography.family).toContain('Antonio');
    expect(await Bun.file(new URL('../static/fonts/lcars/Antonio-Regular.woff2', import.meta.url)).exists()).toBe(true);
    expect(await Bun.file(new URL('../static/fonts/lcars/Antonio-Bold.woff2', import.meta.url)).exists()).toBe(true);
  });

  test('locks the Voyager V26 frame, typography, and segmented bar grammar', () => {
    expect(token(intrepid, 'rail')).toBe('15rem');
    expect(token(intrepid, 'intrepid-panel-border')).toBe('.325rem');
    expect(token(intrepid, 'intrepid-bar-height')).toBe('1.75rem');
    expect(token(intrepid, 'intrepid-divider-height')).toBe('.75rem');
    expect(token(intrepid, 'intrepid-outer-radius')).toBe('6.25rem');
    expect(token(intrepid, 'intrepid-content-radius')).toBe('2.75rem');
    expect(css).toContain('border-radius: 0 0 0 var(--intrepid-outer-radius)');
    expect(block('html[data-interface-theme="intrepid"] .lcars-nav a:first-child')).toContain(
      'border-radius: var(--intrepid-outer-radius) 0 0 0',
    );
    expect(block('html[data-interface-theme="intrepid"] .lcars-section-heading > .section-index')).toContain(
      'border-radius: var(--intrepid-content-radius) 0 0 0',
    );
    expect(block('html[data-interface-theme="intrepid"] .lcars-header-stripe')).toContain(
      'grid-template-columns: clamp(.65rem, 14%, 5rem) 20% 5% minmax(0, 1fr)',
    );
    expect(css).toContain('font-family: "Antonio", "Arial Narrow", "Avenir Next Condensed", sans-serif');
  });

  test('renders explicit synchronized frame dividers and both source bar terminals', () => {
    expect(layout).toContain('class="lcars-frame-divider"');
    expect(layout).toContain('class="lcars-workspace-divider"');
    expect(layout).toContain('class="stripe-terminal"');
    expect(block('.lcars-frame-divider,\n.lcars-workspace-divider')).toContain(
      'height: var(--frame-divider-height, .35rem)',
    );
  });

  test('keeps a written source trail for every era-specific decision', async () => {
    const galaxyContract = await Bun.file(new URL('../docs/galaxy-interface-contract.md', import.meta.url)).text();
    const intrepidContract = await Bun.file(new URL('../docs/intrepid-interface-contract.md', import.meta.url)).text();
    expect(galaxyContract).toContain('TheLCARS Classic Theme V26');
    expect(galaxyContract).toContain('https://www.lcars.org.uk/lcars_TNG_panels.htm');
    expect(galaxyContract).toContain('Explicit black frame divider');
    expect(intrepidContract).toContain('TheLCARS Voyager Theme V26');
    expect(intrepidContract).toContain('https://www.lcars.org.uk/lcars_Voyager_panels.htm');
    expect(intrepidContract).toContain('no top-left cap is used');
    expect(GALAXY_VISUAL_CONTRACT.provenance.implementationUrl).toBe('https://www.thelcars.com/download.php');
    expect(INTREPID_VISUAL_CONTRACT.provenance.implementationUrl).toBe('https://www.thelcars.com/download.php');
  });
});

describe('Starfleet tactical and audio semantics', () => {
  test('renders the Pi as completed green and the complete VPN system as clear red', () => {
    expect(dashboard).toContain('const nodeColor = currentCompletedStateRgb()');
    expect(dashboard).toContain('const tunnelRgb = currentDangerStateRgb()');
    expect(dashboard).toContain('swarmMap.relay.label, tunnelRgb, true');
    expect(dashboard).toContain("label: 'VPN TUNNEL'");
  });

  test('invalidates every map layer when the interface class changes', () => {
    expect(dashboard).toContain("window.addEventListener('torplex:interface-theme', onInterfaceTheme)");
    expect(dashboard).toContain("phosphorCache = { theme: '', rgb: defaultPhosphorRgb }");
    expect(dashboard).toContain('scheduleMapRaster()');
    expect(dashboard).toContain('scheduleMapStatic()');
  });

  test('uses separate canonical bridge beds and input banks', async () => {
    expect(audio).toContain("ambient: '/audio/lcars/bridge-ambient.mp3'");
    expect(audio).toContain("ambient: '/audio/lcars/intrepid-bridge.mp3'");
    expect(audio).toContain("'/audio/lcars/intrepid-key.mp3'");
    for (const asset of ['bridge-ambient.mp3', 'intrepid-bridge.mp3', 'intrepid-key.mp3']) {
      const file = Bun.file(new URL(`../static/audio/lcars/${asset}`, import.meta.url));
      expect(await file.exists()).toBe(true);
      expect(file.size).toBeGreaterThan(1_000);
    }
  });
});
