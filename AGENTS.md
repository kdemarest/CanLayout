{#include ../vids/SharedProjects.md}

layout: a local web app (Node server + browser page) for viewing Unity areas and composing Canopy scenes on the phone. Usage and design: README.md.

Rules:
- Dependency-free Node on the server side; the page is plain browser scripts with vendored three.js (`web/three.js`, unminified r160).
- Pieces are stored in Unity's terms (left-handed position, Unity euler degrees, scale). `web/space.js` is the only place that converts to Three.js; keep it that way.
- Composed scenes live in `../docs/scenes/` and are the source of truth; imported areas (`areas/`) and `cache/` are regenerated, never edited.
- The viewer (server and page) never writes into the Canopy repo (`/sdcard/Canopy`): it reads it, and fetches blobs into `cache/`. Tools that change Canopy (`make-shapes.js`, `tree-tips.js --cap`, `leaves.js`, `dice.js`) write its working tree only behind an explicit `--write` or `--cap`, never commit, and every change they make is logged in `docs/Canopy Changes.md` (files, why, how to undo) and commented in the code where the format allows. Without the flag they only report.
- Run `jslint layout` after JS edits.
