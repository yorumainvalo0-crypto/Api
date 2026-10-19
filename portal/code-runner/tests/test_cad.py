"""CAD runs in the real CAD sandbox image (needs Docker and portal-cad-sandbox:dev)."""

from __future__ import annotations

import base64
import io
import os
import zipfile

import pytest
from fastapi.testclient import TestClient

from runner.app import create_app
from runner.sandbox import Limits, Sandbox
from runner.storage import Store

IMAGE = os.environ.get("SANDBOX_IMAGE", "portal-sandbox:dev")
CAD_IMAGE = os.environ.get("CAD_SANDBOX_IMAGE", "portal-cad-sandbox:dev")

BRACKET = """
from build123d import *

width, depth, height = 60, 40, 10   # mm
hole = 8

with BuildPart() as bracket:
    Box(width, depth, height)
    with Locations((-15, 0, 0), (15, 0, 0)):
        Hole(radius=hole / 2)
result = bracket.part
print("gebaut")
"""


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> TestClient:
    root = tmp_path_factory.mktemp("cad")
    store = Store(root / "store")
    sandbox = Sandbox(store, root / "work", IMAGE, cad_image=CAD_IMAGE, cad_limits=Limits(timeout_seconds=60, memory="2g"))
    return TestClient(create_app(store, sandbox))


def cad(client: TestClient, code: str, formats: list[str] | None = None) -> dict:
    res = client.post("/v1/cad", json={"code": code, "formats": ["step", "3mf"] if formats is None else formats})
    assert res.status_code == 200, res.text
    return res.json()


def test_bracket_exports_all_formats_with_correct_dimensions(client: TestClient) -> None:
    body = cad(client, BRACKET)
    assert body["ok"], body["stderr"]
    assert "gebaut" in body["stdout"]
    info = body["info"]
    assert info["size_mm"] == pytest.approx([60, 40, 10], abs=1e-3)
    # Box minus two through holes of 8 mm
    expected = 60 * 40 * 10 - 2 * 3.141592653589793 * 4**2 * 10
    assert info["volume_mm3"] == pytest.approx(expected, rel=1e-4)
    assert info["watertight"] is True
    assert info["solids"] == 1

    files = {name: base64.b64decode(data) for name, data in body["files"].items()}
    assert set(files) == {"model.stl", "model.step", "model.3mf", "model.glb", "preview.png"}
    assert files["model.step"].startswith(b"ISO-10303-21")
    assert files["model.glb"][:4] == b"glTF"
    assert files["preview.png"][:8] == b"\x89PNG\r\n\x1a\n"
    assert zipfile.is_zipfile(io.BytesIO(files["model.3mf"]))
    assert len(files["model.stl"]) > 1000


def test_only_requested_extra_formats(client: TestClient) -> None:
    body = cad(client, "from build123d import *\nresult = Cylinder(10, 20)", formats=[])
    assert body["ok"], body["stderr"]
    assert set(body["files"]) == {"model.stl", "model.glb", "preview.png"}
    assert body["info"]["size_mm"] == pytest.approx([20, 20, 20], abs=1e-3)


def test_errors_in_the_code_come_back_readable(client: TestClient) -> None:
    body = cad(client, "from build123d import *\nresult = Box(10, 10)  # missing height")
    assert body["ok"] is False
    assert "TypeError" in body["stderr"]
    assert body["files"] == {}


def test_missing_result_is_explained(client: TestClient) -> None:
    body = cad(client, "x = 1")
    assert body["ok"] is False
    assert "result" in body["stderr"]


def test_endless_loops_are_stopped(client: TestClient, tmp_path_factory: pytest.TempPathFactory) -> None:
    root = tmp_path_factory.mktemp("cad-timeout")
    store = Store(root / "store")
    sandbox = Sandbox(store, root / "work", IMAGE, cad_image=CAD_IMAGE, cad_limits=Limits(timeout_seconds=5, memory="1g"))
    fast = TestClient(create_app(store, sandbox))
    body = fast.post("/v1/cad", json={"code": "while True: pass"}).json()
    assert body["ok"] is False
    assert "Zeitlimit" in body["stderr"]


def test_cad_code_has_no_network(client: TestClient) -> None:
    code = "import urllib.request\nurllib.request.urlopen('http://1.1.1.1', timeout=3)\n"
    body = cad(client, code)
    assert body["ok"] is False
    assert "Error" in body["stderr"]


def test_planted_symlinks_are_not_followed(client: TestClient) -> None:
    # Swaps an export for a symlink after the wrapper wrote it: the runner (root) must not read
    # the link target out of its own container
    code = BRACKET + """
import atexit, os
def swap():
    os.remove("/mnt/data/model.step")
    os.symlink("/etc/hostname", "/mnt/data/model.step")
atexit.register(swap)
"""
    body = cad(client, code)
    assert body["ok"], body["stderr"]
    assert "model.step" not in body["files"]
    assert "model.stl" in body["files"]
