# layout

View Unity areas and compose Canopy scenes on the phone, in the browser.

    runLayout            # starts it in the background and opens http://localhost:8080
    runLayout stop       # stops it;  runLayout log  follows its log

`runLayout` is a two-line launcher in `~/.local/bin` (on PATH) that runs `bash /sdcard/dev/layout/runLayout.sh "$@"`; scripts on the sdcard cannot run directly, only through `bash`. The launcher and the Termux:Widget button (`~/.shortcuts/runLayout`, same one line) live outside version control: `setup.sh` recreates both. Without them, run `bash /sdcard/dev/layout/runLayout.sh`.

While it runs, any edit to layout's files restarts the server and the page reloads itself (or, with unsaved changes, shows Reload). `node server.js` runs it once, without the watcher.

Tap ⛶ for full screen, or add the page to the home screen.

Errors fail loudly: any page error shows in red in the status line and is written to `layout.log` (`runLayout log`), next to the server's own messages.

## Two kinds of scene

- **Composed scenes** are yours: `docs/scenes/<Type> <Name>.md` (e.g. `Landmark Ring Forge.md`), one Piece line per piece. Create one with ☰ **New**; edit it here or by hand. They are what will be exported to Unity.
- **Imported areas** are read-only copies of a cube of a Unity scene: ☰ **Import area** (or `node tools/scene.js extract <Scene> <cx> <cy> <cz> <halfSize> <Name>`) writes `areas/<Scene> <Name>.json`. Regenerate them whenever Unity changes. Trees (already cut into cubic chunks, `Meshes/Grid*`) come in as one read-only piece per tree holding only its chunks whose bounds overlap the cube, at the LOD `treeLod` in `unity.json` (L0 now; a chunk without it uses the LOD it has). Chunk bounds are read from each chunk's smallest LOD and cached. A tree's leaves (one mesh for the whole tree) come too, cut to the cube; scenes save their trees with leaves switched off (turned on at run time), so a show rule in `unity.json` brings the leaves from the tree prefab and the piece says so. Cutout materials (a shader that clip()s, e.g. Canopy/LeafCut, or Standard Cutout) are drawn with alpha testing.

## unity.json

What an imported area shows is set in `unity.json`, not in code: `defaults`, plus a section per scene under `scenes` (its values replace the defaults; its show and hide lists add to them).

- `treeLod`: LOD of tree chunks (0 is full detail). `treeChunks`: path pattern of chunk meshes (`Meshes/Grid*`).
- `maxTexture`: largest texture side kept, in pixels (1024).
- `show`: rules forcing objects on even when the scene or prefab switches them off (the tree leaves: `mesh:ForestTreeLeaves*`).
- `hide`: rules removing objects.

A rule is `kind:pattern`, `*` matching anything: `prefab:Cairn` (a whole piece), `prefab:Cairn/PlaceholderObject` (an object inside it), `object:`, `mesh:`, `material:`, `folder:Prefabs/PFX`. Example: `"scenes": {"BeechScene": {"hide": ["folder:Prefabs/PFX"]}}`. An area is re-imported automatically the next time it is opened after `unity.json` changes.

Piece line: `- Piece: Name | x y z | rx ry rz | scale | extra settings`, in Unity's world coordinates and euler degrees. The name is a Unity prefab, a mesh, or a new asset from a docs Asset line (shown as a labeled box until it has a model).

## Composing

- **Add** opens a filterable list (new assets from docs, then Unity prefabs). The piece appears on the cursor a few meters ahead, sized to about a quarter of the screen.
- Drive the camera like a player with the WASD pad (W toward where the camera points, S straight back, A and D sidestep, Q down, E up), or the same keys on a keyboard. One finger looks around (carrying a piece, it orbits instead); two fingers pinch to move forward and back, and drag to pan.
- While a piece is carried it keeps its place relative to the camera, so moving carries it and orbiting turns it.
- **Snap** (toggle) rests the carried piece on whatever is below it.
- **Labels** (toggle) names every piece just above it; placeholder boxes are always named.
- The scale bar sets its size (1.0 in the middle; ×0.25 to ×4).
- **Drop** places it; **Cancel** puts it back (or discards a new one); **Delete** removes it.
- Tap a placed piece to pick it up again. **Undo** and **Redo** cover drops and deletes. ☰ **Save** writes the Piece lines (☰ shows ● while there are unsaved changes).
- ☰ **Folders** hides pieces by prefab folder (Items, Harvesters, …).

## How it gets meshes

The server resolves each piece name through its Unity prefab (nested prefabs and variants followed; Lod0 only; only meshes with an enabled renderer), fetches the `.asset` meshes it needs from the Canopy git repo (through a throwaway store, `~/.cache/layout-fetch.git`, deleted after each fetch, so Canopy's own git store stays lean; blobs Canopy already has are read from it), and converts them to OBJ in `cache/meshes/`. `node tools/guid-index.js` rebuilds `cache/guid-index.json` after the Canopy repo changes.

Materials: each renderer's first material is read from its `.mat`; its color texture, normal map, and (for Canopy/General) detail texture are stored in `cache/textures/` at most `maxTexture` px (ImageMagick; TGA, TIF and PSD become PNG, their extra channel kept as alpha). Textures changed in the Canopy working tree but not yet committed are read from there. **Textures** switches back to plain gray. Needs `pkg install imagemagick`.

An imported prefab instance that changes objects inside its prefab (a rotated arm, a moved marker, a switched-off gem holder), at any depth of nesting, carries its own parts in the area file. Ids inside nested prefabs follow Unity's rule: instance id XOR source id. Of sibling LOD meshes, the most detailed one present is shown (some prefabs hold only a Lod3). Objects that scripts show or hide at run time (e.g. a Payee's amber payment marker) appear as they are saved, unless a `unity.json` rule says otherwise.

FBX models (binary FBX) are read by `tools/fbx.js`: each mesh is scaled as Unity imports it (the .meta's Scale Factor, times the file's unit when Convert Units is on; checked against a Unity-made LOD mesh, exact to 0.1%), with its geometric offset, and its origin moved to its pivot, as Unity does on import. The mesh an object uses is found by the name Unity listed; else by an older-style id (4300000, 4300002, …: the n-th mesh in Unity's reading order, depth first; checked against every model that lists its ids); else the object's name; else the file's only (or only LOD0) mesh; else, as a guess, its largest. ASCII FBX is not read (a few store-pack models are ASCII).

Not yet: materials of a mesh's second and later submeshes. `cache/` can be deleted any time; it refills on demand (the Beech area's textures are about 32 MB capped, 155 MB at full size).
