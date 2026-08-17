# Intrepid Interface Contract

Torplex's Intrepid Class theme is an adaptation of Voyager-era LCARS, not a freehand recolor. Every structural choice below is tied to either TheLCARS Voyager Theme V26 or a screen-capture reconstruction.

## Sources

- [TheLCARS Voyager Theme V26](https://www.thelcars.com/download.php): implementation baseline for exact colors, typography, frame radii, border thickness, bars, and responsive dimensions.
- [TheLCARS color guide](https://www.thelcars.com/colors.php): named Voyager palette.
- [LCARS Voyager panel archive](https://www.lcars.org.uk/lcars_Voyager_panels.htm): panel reconstructions based primarily on episode screen captures.

These are independent fan references, not a published Paramount design standard. V26 is used as the reproducible implementation contract; the screen archive is used to reject structures that do not appear in Voyager displays.

## Traceability

| Torplex decision | Source rule | Adaptation |
| --- | --- | --- |
| Antonio typeface | V26 `@font-face` and `body` | Bundled WOFF2 files are used for all Intrepid UI text. |
| Black content field and sky-blue body text | V26 `body`, `--font-color: var(--sky)` | Torplex panels remain predominantly black instead of dark-blue cards. |
| Silver structural frame | V26 `--left-frame-top-color`, `--left-frame-color`, and both corner colors | Sidebar fill, elbows, primary bars, and lower frame use silver. |
| Command-gold titles | V26 `--banner-color` and `--h1-color` through `--h4-color` | Product title, section headings, and primary labels use command gold. |
| Upper lower-left and lower upper-left elbows | V26 `--radius-top: 0 0 0 100px` and `--radius-bottom: 100px 0 0 0` | The shell is split at the same elbow seam; no top-left cap is used. |
| Explicit black frame divider | V26 `.divider` and `--divider-height` | A 0.75rem, 0.5rem, or 0.345rem band separates the upper and lower frames at the matching responsive breakpoint. |
| Inner 44px corners | V26 `--radius-content-top` and `--radius-content-bottom` | The upper cutout rounds its bottom-left corner; the lower cutout rounds its top-left corner. |
| 0.325rem black segmentation | V26 `--panel-border` and `--bar-border` | Rail panels and horizontal bars are separated by exact black gutters. |
| Silver, gold, blue, silver bar sequence | V26 `--bar-1-color` through `--bar-4-color` | Header telemetry rail uses the same sequence and 14/20/5/fill proportions. |
| Silver, pumpkin, blue, silver lower bar | V26 `--bar-6-color` through `--bar-9-color` | The footer follows the source lower sequence; its vessel terminal is a labeled silver extension. |
| Dense data cascade | V26 `.data-cascade-button-group` and Voyager panel captures | A compact, non-interactive readout occupies unused header space. |
| Flat segmented rail controls | V26 `.panel-3` through `.panel-7` | Navigation is integrated into the lower frame. The non-canonical detached four-button group is not copied. |
| Responsive 240/200/180/150/120/62px rail | V26 media queries | Torplex follows the source breakpoints while preserving mobile controls. |
| Green completion and Pi; red alert and VPN | Torplex operational semantics | These state colors intentionally override decorative palette assignments. |
| Fixed-height, non-overlapping structural bars | V26 bar geometry | Labels may clip or disappear at compact widths, but their intrinsic size may never enlarge a bar or overlap an adjacent segment. |

The machine-readable values live in `src/lib/client/intrepid-visual-contract.js`; contract and browser tests protect them from accidental drift.
