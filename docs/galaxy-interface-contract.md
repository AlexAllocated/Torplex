# Galaxy Interface Contract

Torplex's Galaxy Class theme adapts TheLCARS Classic Theme V26. It uses the source as a reproducible implementation contract rather than treating LCARS as a generic collection of rounded colored blocks.

## Sources

- [TheLCARS Classic Theme V26](https://www.thelcars.com/download.php): implementation baseline for colors, typography, frame radii, border thickness, bar sequencing, dividers, and responsive dimensions.
- [TheLCARS color guide](https://www.thelcars.com/colors.php): named Classic-era palette.
- [LCARS TNG panel archive](https://www.lcars.org.uk/lcars_TNG_panels.htm): screen-capture reconstructions used to validate the overall visual grammar.

These are independent fan references, not a published Paramount design standard. V26 is the testable implementation baseline.

## Traceability

| Torplex decision | Source rule | Adaptation |
| --- | --- | --- |
| Antonio typeface | V26 `@font-face` and `body` | The bundled Antonio WOFF2 files render the complete Galaxy interface. |
| Black content field and African-violet text | V26 `body` and `--font-color` | Operational surfaces stay black while readable text remains independent of panel colors. |
| African-violet titles and orange banner text | V26 heading and banner variables | Product identity uses orange; page and section titles use African violet. |
| Blue upper lower-left and red lower upper-left elbows | V26 `--radius-top`, `--radius-bottom`, and frame colors | Upper and lower frames are separate structures, never fused or rounded on the wrong outside corner. |
| Explicit black frame divider | V26 `#gap` and `--divider-height` | A responsive black band separates both frame halves across the rail and workspace. |
| 0.25rem panel and 0.35rem bar segmentation | V26 `--panel-border` and `--bar-border` | Adjacent structural colors never touch without the source black separator. |
| Blue, orange, violet, violet, red upper bar | V26 `--bar-1-color` through `--bar-5-color` | The header uses the source five-segment sequence and 40/4/17/fill/4 proportions. |
| Red, butterscotch, half-height red, violet, butterscotch lower bar | V26 `--bar-6-color` through `--bar-10-color` and `.bar-8` | The footer preserves the lower sequence and its intentional half-height third segment. The labeled terminal retains a minimum readable width. |
| Responsive 240/200/180/150/120/62px rail | V26 media queries | The functional rail follows source widths while preserving readable mobile controls. |
| 40/30/24px labeled data bar | V26 `.lcars-text-bar` | Telemetry labels and terminal caps remain the same height at each breakpoint. |
| Fixed-height, non-overlapping structural bars | V26 bar geometry | Labels may clip or disappear at compact widths, but their intrinsic size may never enlarge a bar or overlap an adjacent segment. |

The machine-readable values live in `src/lib/client/galaxy-visual-contract.js`; unit and browser tests protect the frame, palette, typography, adjacency, and containment rules.
