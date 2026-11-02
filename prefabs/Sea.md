# Sea

Layout's Sea (Ken, 2026-10-29): Canopy's own `Sea.prefab`, drawn and run as in the game: its C# scripts with stand-ins in `layout/scripts/` (Sea, Abyss, WaterScroller) put it at the world's origin, at its altitude, keep its water under the camera and drift the ripples. The cube is what you tap; where it stands doesn't move the sea. One sea at a time (Sea.cs's stand-in is a singleton).

- Shape: box 1 1 1 color #2f6f8f
- Shape: use Sea.prefab
