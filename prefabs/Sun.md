# Sun

Layout's Sun (Ken, 2026-11-01): the scene's one light, Canopy's sun, drawn by `layout/scripts/Sun.js` from the scene's `unity.json` environment (`sunDirection`, `sunColor`, `ambient`), the light Canopy's own shaders get. The cube is what you tap; where it stands doesn't matter. One sun at a time (a singleton). Without one, layout's plain lights (a sky-and-ground light and a fixed sun) light Three.js's own materials.

- Shape: box 1 1 1 color #ffd84a
- Script: scripts/Sun.js
