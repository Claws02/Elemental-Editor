# Elemental-Editor

The scene editor for [Elemental](https://github.com/Claws02/Elemental): build towns, courtyards, puzzles and story scenes on an iPad, play them on the spot, and hand them to the game.

**Open the editor:** its claude.ai page (a private link; ask Claude for it). It's one self-contained page, built for iPad and usable in any browser.

## What it edits

Everything in a scene file (the game's `docs/SCENES.md`):

- **Layout.** Every object the game has: ruins, rocks, trees, braziers and basins, crates and barrels, barricades, gates, pressure plates, trigger zones, characters, the player start, ground patches, and the **building kit**: walls (stone, half-timbered or plaster, with doors, windows or arches), floors, roofs, stairs, fences, posts, and ready-made buildings (cottage, town house, smithy, watchtower, shed) that you can **break apart** into their pieces.
- **Properties.** Size, height, style, variant, whether it starts hidden, what a plate's chain runs to, a character's name and look.
- **Puzzle logic** (Logic). Wires: *when these signals hold* (a plate is weighted, a barricade is broken, the player entered a zone), *make these objects act* (raise, open, close, reveal).
- **Story** (Story). The speaker, the opening view, saved flags; steps with lines, an objective, a marker, what to watch for while waiting, and endings that decide what happens next; reactions (Cael answering fire, a stone too heavy); the end card.
- **Scene settings** (Scene). Name, file name, ground, the light it opens in (day, dusk, night, ember, sea, peaks, glare), how far you see, which powers the player has, the testing reset.
- **Land** (Land). Make a scene land (60, 120 or 240 m), then shape it with one finger: Raise, Lower, Smooth, Flatten (to where you first touched), Paint (twelve surfaces), with size and strength; each stroke is one undo. Things stand on the land and follow it; water keeps its own level.
- **Several at once.** *Select several* in the bar: tap to add or take out, drag on nothing to draw a box; drag one to move them all; turn, raise, duplicate or delete them together.
- **Patrol routes.** A character set to patrol shows its route as gold points in the view: drag them, or add, edit and remove them in Inspect.
- **Check.** The game's own scene checks, live, with a tap to jump to the problem.

## Using it

| | |
|---|---|
| **Add** | Tap a card in the library. It lands in the middle of the view, selected. |
| **Move** | Drag it with one finger. **Snap** keeps it on half metres and 15° turns. |
| **Turn** | Drag the gold handle. It marks the front. |
| **Height** | Inspect → Height (an upper floor sits at 3). |
| **Look around** | **Plan** is straight down; **3D** orbits. Drag empty ground, pinch to zoom, two fingers pan. |
| **Pick** | Wherever a field names another object, **Pick** takes your next tap in the view. |
| **Play** | Puts you in the scene with the elements live: the real game, running in the page. **Stop** comes back. |
| **Save for Claude** | Stores the scene with a note, and keeps it as a version. Then ask Claude to pull the scene. |
| **Scenes** | Open the game's scenes, your saved ones, or start new; versions; copy or paste scene JSON; help. |

Undo and redo are there, and your work is kept on the device as you go. At a desk: ⌘/Ctrl-Z, D duplicate, R turn, Delete, arrows nudge (⇧ for a metre), F frame.

## How the pieces fit

```
game/  (Elemental, a git submodule pinned to a commit)
  src/scene/schema.js    what a scene may contain ─┐
  src/scene/Catalog.js   every type's model ───────┼──► the editor draws and checks with these
  src/scene/validate.js  the scene checks ─────────┘
  src/Game.js            startGame() ─────────────────► Play
  scenes/*.json          the game's scenes ───────────► open them in the editor

editor ──Save for Claude──► the page's store ──Claude pulls──► game/scenes/<id>.json ──► ?scene=<id>
```

The editor never has its own copy of a model or a rule: it is built from the game's code, so what you place is what ships and what Check accepts is what the game loads.

## Working on the editor

```bash
git clone --recurse-submodules https://github.com/Claws02/Elemental-Editor
npm install
npm run build          # → dist/elemental-editor.html (republish it to the editor's page)
npm test               # the built page end to end: add, drag, turn, inspector, undo, rename,
                       # wires, story, break apart, Play and Stop, save, scenes, reload, phone width
```

| File | What it is |
|---|---|
| `editor.html` | The page: markup and styles, with markers the build fills |
| `src/editor.js` | The app: library, bar, panels, Save, Scenes, Play |
| `src/view.js` | The 3D view: the game's models, plan and orbit cameras, touch gestures, the turn handle, wires drawn as dashes |
| `src/panels.js` | Inspect, Logic, Story, Scene and Check |
| `src/doc.js` | The scene being edited: undo, selection, ids and references, the device copy |
| `src/store.js` | Save for Claude: `scenes/<id>` and its versions in the page's database |
| `scripts/build.js` | Bundles it all with the game's code (esbuild) into one page |
| `test/editor.test.js` | Drives the built page in Chromium, framed the way claude.ai frames it, against an in-memory store |

## Keeping in step with the game

When the game gets new object types, models or scenes:

```bash
git -C game fetch origin claude/elemental-game-design-os46tu && git -C game checkout <commit>
npm run build && npm test
git commit -am "Editor: game <commit>"
```

Then republish `dist/elemental-editor.html` to the editor's page. Saved scenes and versions stay in the page's store. Keep object type names stable in the game: saved scenes name types by key.

## Not in this version

- The region scenes are made by scripts in the game (`scripts/scenes/`); edit one here and tell Claude, who keeps the script or retires it for that region.
- Water is placed as sheets at a level: shaping a riverbed doesn't move the river.
- Buildings don't break: walls and roofs are solid, not destructible.
