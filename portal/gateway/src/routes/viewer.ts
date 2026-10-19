import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, normalize, sep } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { type CadVersion, cadModels, cadVersions, describeInfo, formatMm, verifyViewerSignature, versionFiles } from '../cad.js'
import { escapeHtml } from '../html.js'
import { signedMediaUrl } from '../media.js'
import { type AppContext, currentSession, sendHtml } from '../web.js'

const require = createRequire(import.meta.url)
// three's exports hide package.json; its main entry lives in <root>/build/
const THREE_ROOT = dirname(dirname(require.resolve('three')))
const STATIC_ALLOWED = [join(THREE_ROOT, 'build') + sep, join(THREE_ROOT, 'examples', 'jsm') + sep]

const VIEWER_STYLE = `
:root { --bg:#f7f7f5; --panel:#fff; --text:#1d1d1b; --muted:#6b6b66; --line:#e4e4df; --accent:#0f766e; }
@media (prefers-color-scheme: dark) { :root { --bg:#1b1b19; --panel:#252523; --text:#ececea; --muted:#a3a39d; --line:#3a3a37; --accent:#2dd4bf; } }
* { box-sizing:border-box; }
html, body { margin:0; height:100%; background:var(--bg); color:var(--text); font:15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
#app { display:flex; flex-direction:column; height:100%; }
header { display:flex; gap:12px; align-items:center; flex-wrap:wrap; padding:10px 14px; background:var(--panel); border-bottom:1px solid var(--line); }
header h1 { font-size:1.05rem; margin:0; flex:1 1 auto; }
select, button, a.btn { font:inherit; padding:7px 11px; border-radius:8px; border:1px solid var(--line); background:var(--panel); color:var(--text); text-decoration:none; cursor:pointer; }
button.on { border-color:var(--accent); color:var(--accent); font-weight:600; }
#stage { position:relative; flex:1 1 auto; min-height:300px; }
#stage canvas { display:block; width:100%; height:100%; touch-action:none; }
#info { position:absolute; left:12px; top:12px; background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:.85rem; white-space:pre-line; max-width:min(360px, calc(100% - 24px)); }
#tools { display:flex; gap:8px; flex-wrap:wrap; padding:10px 14px; background:var(--panel); border-top:1px solid var(--line); align-items:center; }
#tools label { display:flex; gap:6px; align-items:center; }
#loading { position:absolute; inset:0; display:grid; place-items:center; color:var(--muted); }
`

function viewerScript(glbUrl: string, sizeMm: [number, number, number], minMm: [number, number, number]): string {
  return `
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

const stage = document.getElementById('stage');
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;
stage.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(dark ? 0x1b1b19 : 0xf7f7f5);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8); sun.position.set(1, -1.5, 2); scene.add(sun);

// CAD is Z-up in millimetres
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const size = new THREE.Vector3(${sizeMm.join(',')});
const min = new THREE.Vector3(${minMm.join(',')});
const centre = min.clone().addScaledVector(size, 0.5);
const radius = Math.max(size.length() / 2, 1);

// Millimetre grid on the build plate (z = model bottom), 10 mm cells
const gridSize = Math.ceil(Math.max(size.x, size.y) * 1.6 / 10) * 10 || 50;
const grid = new THREE.GridHelper(gridSize, gridSize / 10, dark ? 0x55554f : 0xbdbdb6, dark ? 0x3a3a37 : 0xe0e0da);
grid.rotation.x = Math.PI / 2; grid.position.set(centre.x, centre.y, min.z); scene.add(grid);

const material = new THREE.MeshStandardMaterial({ color: 0x2a78d6, metalness: 0.1, roughness: 0.55, side: THREE.DoubleSide });
const clip = new THREE.Plane(new THREE.Vector3(0, 0, -1), min.z + size.z);
let mesh;
new GLTFLoader().load(${JSON.stringify(glbUrl)}, (gltf) => {
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    // STL-derived meshes carry no normals: smooth curved faces, keep edges sharper than 30° crisp
    o.geometry = toCreasedNormals(o.geometry, Math.PI / 6);
    o.material = material;
    mesh = o;
  });
  // trimesh keeps the CAD coordinates (Z-up, mm); the camera is Z-up as well
  scene.add(gltf.scene);
  const box = new THREE.Box3Helper(new THREE.Box3(min, min.clone().add(size)), dark ? 0x8a8a83 : 0x9a9a93);
  scene.add(box);
  document.getElementById('loading').remove();
  view('iso');
  document.body.dataset.ready = 'true';
}, undefined, (err) => { document.getElementById('loading').textContent = 'Modell konnte nicht geladen werden.'; console.error(err); });

function view(name) {
  const d = radius * 2.6;
  const dirs = { iso: [1, -1.2, 0.9], front: [0, -1, 0], top: [0, -0.0001, 1], right: [1, 0, 0] };
  const v = new THREE.Vector3(...dirs[name]).normalize().multiplyScalar(d);
  camera.position.copy(centre).add(v);
  controls.target.copy(centre);
  camera.near = d / 1000; camera.far = d * 20; camera.updateProjectionMatrix();
  controls.update();
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
}
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => view(b.dataset.view)));
document.getElementById('wire').addEventListener('change', (e) => { material.wireframe = e.target.checked; });
const cut = document.getElementById('cut');
cut.addEventListener('input', () => {
  const t = Number(cut.value) / 100;
  material.clippingPlanes = t >= 1 ? [] : [clip];
  clip.constant = min.z + size.z * t;
  document.getElementById('cut-value').textContent = t >= 1 ? 'aus' : (size.z * t).toFixed(1).replace('.', ',') + ' mm';
});

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage); resize();
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
document.getElementById('fullscreen').addEventListener('click', () => document.documentElement.requestFullscreen?.());
`
}

export function registerViewerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, db } = ctx
  const base = config.basePath

  // three.js modules for the viewer, served from the gateway itself (no external CDN)
  app.get<{ Params: { '*': string } }>(`${base}/static/three/*`, async (req, reply) => {
    const file = normalize(join(THREE_ROOT, req.params['*']))
    if (!file.endsWith('.js') || !STATIC_ALLOWED.some((dir) => file.startsWith(dir))) return reply.code(404).send('not found')
    try {
      const data = await readFile(file)
      return reply.header('content-type', 'text/javascript; charset=utf-8').header('cache-control', 'public, max-age=604800, immutable').send(data)
    } catch {
      return reply.code(404).send('not found')
    }
  })

  app.get<{ Params: { id: string }; Querystring: { v?: string; exp?: string; sig?: string } }>(`${base}/view/:id`, async (req, reply) => {
    const model = await cadModels(db).findOne({ _id: req.params.id })
    if (!model) return reply.code(404).send('Modell nicht gefunden.')
    const signed = verifyViewerSignature(config, model._id, req.query.exp ?? '', req.query.sig ?? '')
    const session = signed ? null : await currentSession(ctx, req)
    if (!signed && session?.user._id !== model.userId) return reply.code(403).send('Link ungültig oder abgelaufen.')

    const versions = await cadVersions(db).find({ modelId: model._id }).sort({ version: -1 }).toArray()
    const wanted = Number(req.query.v) || model.latestVersion
    const version: CadVersion | undefined = versions.find((v) => v.version === wanted) ?? versions[0]
    if (!version) return reply.code(404).send('Keine Version gespeichert.')
    const files = await versionFiles(db, version)
    if (!files.glb) return reply.code(404).send('Modelldateien abgelaufen.')

    const query = (v: number) => `?v=${v}&exp=${encodeURIComponent(req.query.exp ?? '')}&sig=${encodeURIComponent(req.query.sig ?? '')}`
    const downloads = (
      [
        ['STL', files.stl],
        ['3MF', files.threemf],
        ['STEP', files.step],
      ] as const
    )
      .filter(([, f]) => f)
      .map(([label, f]) => `<a class="btn" href="${escapeHtml(signedMediaUrl(config, f!, 30))}" download>${label}</a>`)
      .join('')
    const [x, y, z] = version.info.size_mm
    const importMap = JSON.stringify({
      imports: { three: `${base}/static/three/build/three.module.js`, 'three/addons/': `${base}/static/three/examples/jsm/` },
    })

    return sendHtml(
      reply,
      `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(model.name)} v${version.version} · 3D-Ansicht</title>
<link rel="icon" href="data:,">
<style>${VIEWER_STYLE}</style>
<script type="importmap">${importMap}</script>
</head><body>
<div id="app">
  <header>
    <h1>${escapeHtml(model.name)} <span style="color:var(--muted);font-weight:400">· ${formatMm(x)} × ${formatMm(y)} × ${formatMm(z)} mm</span></h1>
    <select id="version" aria-label="Version" onchange="location.search=this.value">
      ${versions.map((v) => `<option value="${escapeHtml(query(v.version))}" ${v.version === version.version ? 'selected' : ''}>Version ${v.version}</option>`).join('')}
    </select>
    ${downloads}
  </header>
  <div id="stage"><div id="info">${escapeHtml(describeInfo(version.info))}</div><div id="loading">Lade 3D-Modell …</div></div>
  <div id="tools">
    <button data-view="iso">Iso</button><button data-view="front">Vorne</button><button data-view="top">Oben</button><button data-view="right">Rechts</button>
    <label><input type="checkbox" id="wire"> Drahtgitter</label>
    <label>Schnitt <input type="range" id="cut" min="1" max="100" value="100"> <span id="cut-value">aus</span></label>
    <button id="fullscreen">Vollbild</button>
  </div>
</div>
<script type="module">${viewerScript(signedMediaUrl(config, files.glb, 30), version.info.size_mm, version.info.min_mm)}</script>
</body></html>`,
    )
  })
}
