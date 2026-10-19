"""Runs inside the CAD sandbox: executes /code/model.py and exports the resulting shape.

Writes to /mnt/data: model.stl, model.glb, preview.png, info.json and, if requested,
model.step and model.3mf. Units are millimetres.
"""

from __future__ import annotations

import json
import math
import runpy
import sys
import traceback
from pathlib import Path

OUT = Path("/mnt/data")
FORMATS = set(json.loads(Path("/code/formats.json").read_text()))


def find_shape(namespace: dict):
    from build123d import BuildPart, Compound, Part, Shape, Solid

    candidate = namespace.get("result", namespace.get("part"))
    if candidate is None:
        # Otherwise the last Part/Solid/BuildPart defined at top level
        for value in reversed(list(namespace.values())):
            if isinstance(value, (Part, Solid, Compound, BuildPart)):
                candidate = value
                break
    if isinstance(candidate, BuildPart):
        candidate = candidate.part
    if not isinstance(candidate, Shape):
        raise ValueError("Kein 3D-Körper gefunden: weise das Ergebnis der Variablen `result` zu.")
    if candidate.volume <= 0:
        raise ValueError("Das Ergebnis hat kein Volumen (nur Flächen/Kanten?).")
    return candidate


def render_preview(mesh, path: Path) -> None:
    import matplotlib.pyplot as plt
    import numpy as np
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    triangles = mesh.vertices[mesh.faces]
    normals = mesh.face_normals
    light = np.array([0.4, -0.6, 0.7])
    light /= np.linalg.norm(light)
    shade = 0.35 + 0.65 * np.clip(normals @ light, 0, 1)
    base = np.array([0.16, 0.47, 0.84])
    colors = np.clip(shade[:, None] * base + (1 - shade[:, None]) * 0.08, 0, 1)

    lo, hi = mesh.bounds
    centre = (lo + hi) / 2
    # Tight framing: matplotlib's 3D axes add their own margin around the limits
    span = float((hi - lo).max()) * 0.36 or 1.0
    views = [("Iso", 25, -60), ("Vorne", 0, -90), ("Oben", 90, -90), ("Rechts", 0, 0)]
    fig = plt.figure(figsize=(8, 8), dpi=125)
    for index, (title, elev, azim) in enumerate(views, start=1):
        ax = fig.add_subplot(2, 2, index, projection="3d")
        ax.add_collection3d(Poly3DCollection(triangles, facecolors=colors, edgecolors="none", linewidths=0))
        for setter, c in zip((ax.set_xlim, ax.set_ylim, ax.set_zlim), centre):
            setter(c - span, c + span)
        ax.set_box_aspect((1, 1, 1))
        ax.view_init(elev=elev, azim=azim)
        ax.set_axis_off()
        ax.set_title(title, fontsize=11)
    fig.subplots_adjust(left=0, right=1, bottom=0, top=0.96, wspace=0, hspace=0.06)
    fig.savefig(path, facecolor="white")
    plt.close(fig)


def main() -> int:
    try:
        namespace = runpy.run_path("/code/model.py", run_name="__main__")
        shape = find_shape(namespace)
    except Exception:
        # Only the user's part of the traceback is useful to the model
        lines = traceback.format_exc().splitlines()
        print("\n".join(lines[-12:]), file=sys.stderr)
        return 1

    import trimesh
    from build123d import Mesher, export_step, export_stl

    export_stl(shape, str(OUT / "model.stl"), tolerance=0.01, angular_tolerance=0.1)
    if "step" in FORMATS:
        export_step(shape, str(OUT / "model.step"))
    if "3mf" in FORMATS:
        mesher = Mesher()
        mesher.add_shape(shape, linear_deflection=0.01, angular_deflection=0.1)
        mesher.write(str(OUT / "model.3mf"))

    mesh = trimesh.load_mesh(OUT / "model.stl")
    mesh.export(OUT / "model.glb")
    render_preview(mesh, OUT / "preview.png")

    box = shape.bounding_box()
    info = {
        "size_mm": [round(box.size.X, 3), round(box.size.Y, 3), round(box.size.Z, 3)],
        "min_mm": [round(box.min.X, 3), round(box.min.Y, 3), round(box.min.Z, 3)],
        "volume_mm3": round(shape.volume, 3),
        "area_mm2": round(shape.area, 3),
        "watertight": bool(mesh.is_watertight),
        "triangles": int(len(mesh.faces)),
        "solids": len(shape.solids()),
    }
    if not all(math.isfinite(v) for v in info["size_mm"]):
        print("Ungültige Geometrie (unendliche Maße).", file=sys.stderr)
        return 1
    (OUT / "info.json").write_text(json.dumps(info))
    return 0


if __name__ == "__main__":
    sys.exit(main())
