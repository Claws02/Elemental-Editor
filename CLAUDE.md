# Elemental-Editor — context for Claude

iPad scene editor for Elemental, built into one self-contained page
(`dist/elemental-editor.html`) that's published to a claude.ai page. Built
**from the game's own code** (`game/` submodule): schema, Catalog, validate,
startGame. What you place is what ships.

## Verify

```
git submodule update --init      # game/ = Elemental, pinned to a commit
npm install && npm run build     # esbuild → dist/elemental-editor.html
npm test                         # drives the built page in Chromium, framed like claude.ai, in-memory store
```

After a build, the page must be republished to its claude.ai page for the change to reach the iPad.

## Map

`editor.html` markup + build markers · `src/editor.js` app (library, bar, Save,
Scenes, Play) · `src/view.js` 3D view, cameras, gestures, turn handle, wires ·
`src/panels.js` Inspect/Logic/Story/Scene/Check · `src/doc.js` scene doc, undo,
ids/refs · `src/store.js` "Save for Claude" store · `scripts/build.js` bundler.

## Rules

- The editor never keeps its own copy of a model or rule. If it needs one, it belongs in the game.
- Game bumps: `git -C game checkout <commit>` → build → test → commit "Editor: game <commit>".
- Object type keys are stable: saved scenes reference types by key.
- "Save for Claude" → Claude pulls `scenes/<id>` from the page store into `game/scenes/<id>.json` (a game PR).
