# puml-layout

Make diagrams you don't own look right, without touching them. The source
(`diagram.puml`) stays exactly as its author wrote it; everything you change
lives in a sidecar, `diagram.layout.json`, keyed by the element ids in the
source. When the author edits the source, your positions survive and new
elements are placed next to what they connect to.

Status: PlantUML use case diagrams. Mermaid is next; the parsers feed one
format-neutral model (`src/model/types.ts`), so a new input is a new parser.

## Use

    pnpm install
    pnpm dev                     # editor on http://localhost:5199
    PUML_ROOT=~/diagrams pnpm dev  # edit diagrams in another folder
    pnpm render fixtures/food-delivery.puml -o out/food-delivery.svg
    pnpm render fixtures/food-delivery.puml --theme modern --fit 16:9   # FIT_DEBUG=1 prints every candidate's score

Editor: drag elements (they become pinned), drag a box title to move the
box with its contents, pull a line to bend it, double-click a bend to remove
it, drag labels. Shift-click or shift-drag to multi-select; Alt disables
alignment snapping. Auto layout re-lays out everything that isn't pinned.
The editor reloads live when the .puml or the layout changes on disk.

Toolbar extras:
- **Theme**: `classic` (PlantUML look), `modern` (indigo), `midnight`
  (dark), `blueprint` (navy, mono type), `editorial` (warm paper, serif),
  `mono` (print), `mint`. All but classic share one structure: one accent
  colour, hairlines, pill use cases, avatar actors, caps titles. Stored in
  layout.json, so `pnpm render` produces the same picture.
- **Size**: text, icons and shapes from 75% to 300%, or "Largest that fits":
  the biggest size at which nothing collides and the router keeps its line
  corridors (positions are centres and stay put).
- **Text − / +** and **Icons − / +**: 10% steps on top of Size; click the
  percentage to reset to 100%. Stored as `view.text` / `view.icons`.
- **Source** (S): read-only panel with the .puml (highlighted, line numbers)
  and the live layout.json. Selecting an element highlights the line that
  declares it; clicking a line selects what it declares.
- **Frame** + **Fit to frame**: pick an aspect ratio (16:9, 4:3, 1:1, A4,
  this window) and the diagram is re-arranged to fill it. The search tries
  16 layouts (layered in both directions × 4 spacings × element sizes
  160% and 260%, in parallel Web Workers), scores them by how large the text ends up in the frame minus
  line length and crossings, routes the best three for real, stretches the
  winner into the frame, then grows text into any room left. Line corridors
  are fixed pixels, so laying out at larger sizes is what makes text big
  relative to the frame. Coordinates land on a 4px grid. ~1 s; undoable.
  (`src/layout/blocks.ts`, a per-container block layout with ports, lost on
  this fixture and is not in the search; kept for layout templates.)
  Export SVG uses the frame as the canvas.
- **Grid**: dotted canvas or plain white.

## layout.json

    {
      "version": 1,
      "view": { "theme": "modern", "frame": [16, 9], "scale": 2.6 },
      "nodes": {
        "Admin": { "x": 600, "y": 451, "pinned": true },
        "UC_Login": { "x": 2470, "y": 1012 }
      },
      "edges": {
        "UC_Pay-->PSP": { "via": [[2223, 395]], "label": [0, -8] }
      }
    }

- Node keys are PlantUML aliases (`usecase "Log In" as UC_Login`), or the
  name when there's no alias. Positions are centres.
- Edge keys are `from<arrow>to` with the arrow normalised (`-->`, `..>`,
  `--|>`, `..`); repeated edges get `#2`, `#3`.
- `via` are checkpoints the orthogonal route must pass through; `label` is an
  offset from the label's automatic position.
- Entries for ids that vanish from the source are kept, so a rename can be
  undone without losing the position.

## How

- Parse: `src/model/parse.ts` (actors, use cases, nested containers, notes,
  relations; unsupported lines become warnings, never errors).
- Layout: ELK layered for the first layout and for unpinned nodes
  (`src/layout/auto.ts`); new nodes go next to their neighbours.
- Lines: libavoid (Adaptagrams) orthogonal routing with nudging, compiled to
  WASM, re-run on every pointer move (~8 ms for the fixture).
- Text is measured with a fixed Helvetica width table so the CLI and the
  browser agree on sizes.

## Speed

Measured in Chrome on the fixture (36 elements, 45 lines), `node scripts/perf.mjs`:

| | per pointer move |
|---|---|
| routing while dragging (only lines touching what moves) | ~2 ms |
| React commit (unchanged elements are memoized) | ~4 ms |
| full re-route + nudging on release | ~17 ms |

Fit to frame: ~0.6 s, 16 ELK layouts in a pool of Web Workers
(`node scripts/fit-timing.mjs`). Drawing is not the bottleneck at this
size, which is why rendering stays SVG (crisp text, real DOM hit-testing,
1:1 SVG export) rather than WebGL.

## Test

    pnpm test        # parser, layout merge, routing (no lines through elements, < 50 ms), fit, themes
    pnpm typecheck
    node scripts/smoke.mjs out/editor.png   # with pnpm dev running: drag, bend, undo, theme, fit, in headless Chrome
    scripts/png.sh out/x.svg out/x.png 1800 # rasterise an SVG to look at it
