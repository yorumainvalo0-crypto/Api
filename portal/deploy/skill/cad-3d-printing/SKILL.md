---
name: cad-3d-printing
description: Design precise technical parts for 3D printing or CAD (brackets, holders, enclosures, adapters, spacers) with the cad_erstellen tool. Use whenever the user wants a 3D model, an STL/STEP/3MF file or a printable part.
---

# Technical parts for 3D printing (build123d)

Build parts with the **`cad_erstellen`** tool (portal MCP server). It runs Python with
[build123d](https://build123d.readthedocs.io) and returns a preview, dimensions, a 3D viewer link
and STL/3MF/STEP downloads. Units are **millimetres**. Never write STL by hand.

## Workflow

1. Clarify missing key dimensions briefly (or state sensible assumptions).
2. Write parametric code: all dimensions as named variables at the top, then the geometry.
3. Assign the finished solid to `result`. Call `cad_erstellen` with a short German `name`.
4. Check the returned dimensions against the request. If "Wasserdicht" is "NEIN" or the
   size is wrong, fix the code and call again with the **same name** (creates a new version).
5. Give the user the viewer link and the downloads exactly as returned.

## build123d patterns

```python
from build123d import *

width, depth, height = 60, 40, 4      # mm
hole_d = 4.5                           # M4 clearance

with BuildPart() as part:
    Box(width, depth, height)
    fillet(part.edges().filter_by(Axis.Z), radius=3)          # rounded vertical edges
    with Locations((-20, 0, 0), (20, 0, 0)):
        Hole(radius=hole_d / 2)                                 # through hole
    with BuildSketch(part.faces().sort_by(Axis.Z)[-1]):         # sketch on top face
        Rectangle(20, 10)
    extrude(amount=10)                                          # boss
result = part.part
```

- Profiles: `with BuildSketch(Plane.XZ): ...` then `extrude(amount=w/2, both=True)`; revolve with `revolve()`.
- Subtract with `mode=Mode.SUBTRACT`; counterbores `CounterBoreHole`, countersinks `CounterSinkHole`.
- Shells/enclosures: `offset(amount=-wall, openings=part.faces().sort_by(Axis.Z)[-1])`.
- Chamfers: `chamfer(edges, length=0.8)` – also helps the first layer.
- Text/emboss: `with BuildSketch(face): Text("ABC", font_size=6)` then `extrude(amount=0.6)`.

## FDM printing rules (typical 0.4 mm nozzle)

- Walls ≥ 1.2 mm (better 2 mm for load); floors/roofs ≥ 0.8 mm.
- Clearance for parts that must fit: +0.2 mm per side (holes: +0.3–0.4 mm on the diameter).
  Screw clearance: M3 → 3.4 mm, M4 → 4.5 mm, M5 → 5.5 mm. Heat-set inserts M3 → 4.2 mm hole.
- Overhangs ≤ 45° without support; bridges ≤ 20 mm; prefer chamfers over fillets on the bottom.
- Orient so the largest flat face is on the bed (Z = 0 at the bottom of `result`).
- Mention the print orientation and whether support is needed.
