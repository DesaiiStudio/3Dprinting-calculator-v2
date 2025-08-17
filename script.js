// script.js — ES Module with detailed logs
// Used by quote.html via: <script type="module" src="script.js"></script>

console.log("[INIT] script.js module starting…");

// ----- Import three.js + helpers -----
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';


  window.THREE = THREE;
  window.THREE.OrbitControls = OrbitControls;
  window.THREE.STLLoader = STLLoader;

// ===== Config you can tweak =====
const MATERIALS = {
  PLA:       { density_g_cm3: 1.24, cost_per_kg_thb: 450 },
  PETG:      { density_g_cm3: 1.27, cost_per_kg_thb: 500 },
  "PETG-CF": { density_g_cm3: 1.30, cost_per_kg_thb: 750 },
};
const QUALITY_SPEED = { draft: 600, standard: 420, fine: 260 }; // mm^3/min
const SUPPORT_TIME_MULTIPLIER = { yes: 1.15, no: 1.0 };
const INFILL_TIME_MULTIPLIER = (p) => 0.85 + (clamp(p,0,100)/100)*0.6;

// ===== DOM helpers =====
const $ = (id) => document.getElementById(id);
const el = {
  file: $('stlFile'),
  fileInfo: $('fileInfo'),
  calcBtn: $('calcBtn'),
  metrics: $('metrics'),
  breakdown: $('breakdown'),
  total: $('total'),
  download: $('downloadQuote'),
  material: $('material'),
  quality: $('quality'),
  infill: $('infill'),
  supports: $('supports'),
  qty: $('qty'),
  baseFee: $('baseFee'),
  machHr: $('machHr'),
  ppFee: $('ppFee'),
  minThresh: $('minThresh'),
  margin: $('margin'),
  vat: $('vat'),
  canvas: $('viewer'),
};

Object.entries(el).forEach(([k,v]) => console.log(`[DOM] ${k}:`, !!v));

// ===== 3D Viewer =====
let renderer, scene, camera, controls, mesh;
initViewer();

function initViewer() {
  try {
    if (!el.canvas) { console.warn("[VIEWER] No canvas found"); return; }

    renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true });
    sizeViewer();
    window.addEventListener('resize', sizeViewer);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1115);

    const key = new THREE.DirectionalLight(0xffffff, 1.0); key.position.set(1,1,1);
    scene.add(key, new THREE.AmbientLight(0xffffff, 0.4));

    camera = new THREE.PerspectiveCamera(50, el.canvas.clientWidth / el.canvas.clientHeight, 0.1, 10000);
    camera.position.set(120,120,120);

    controls = new OrbitControls(camera, el.canvas);
    controls.enableDamping = true;

    console.log("[VIEWER] Initialized");
    animate();
  } catch (e) {
    console.error("[VIEWER] Init error:", e);
  }
}
function sizeViewer() {
  if (!renderer || !camera) return;
  const w = (el.canvas.parentElement?.clientWidth || 900);
  const h = Math.max(320, Math.floor(w * 0.55));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
function animate() {
  requestAnimationFrame(animate);
  controls?.update();
  renderer?.render(scene, camera);
}

// ===== STL load + measure =====
let currentMetrics = null;

el.file?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  console.log("[FILE] Selected:", file?.name, file?.size, "bytes");
  resetOutputs();
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.stl')) {
    console.warn("[FILE] Not STL");
    el.fileInfo.textContent = 'Please choose a .stl file.';
    return;
  }
  el.fileInfo.textContent = `Selected: ${file.name} (${(file.size/1024/1024).toFixed(2)} MB)`;

  try {
    const buf = await file.arrayBuffer();
    console.log("[FILE] ArrayBuffer length:", buf.byteLength);

    const loader = new STLLoader();
    console.log("[STL] Loader created:", !!loader);

    const parsed = loader.parse(buf);
    console.log("[STL] Parsed geometry type:", parsed?.type, "isBufferGeometry:", parsed?.isBufferGeometry);

    const geo = parsed.isBufferGeometry ? parsed : new THREE.BufferGeometry().fromGeometry(parsed);
    geo.computeBoundingBox(); geo.computeVertexNormals();
    console.log("[GEO] BBox:", geo.boundingBox);

    const volume_mm3 = computeVolume(geo);
    const bbox = {
      x: geo.boundingBox.max.x - geo.boundingBox.min.x,
      y: geo.boundingBox.max.y - geo.boundingBox.min.y,
      z: geo.boundingBox.max.z - geo.boundingBox.min.z,
    };
    console.log("[METRICS] volume_mm3:", volume_mm3, "bbox:", bbox);

    currentMetrics = { volume_mm3, bbox };
    renderMesh(geo);
    showMetrics(currentMetrics);

    el.calcBtn.disabled = false;
    console.log("[UI] calcBtn enabled");
  } catch (err) {
    console.error("[ERROR] STL load failed:", err);
    el.fileInfo.textContent = 'Could not parse STL (file invalid).';
    el.calcBtn.disabled = true;
  }
});

function renderMesh(geo) {
  if (!scene) return;
  if (mesh) scene.remove(mesh);
  mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x5ad, metalness: 0.1, roughness: 0.8 }));
  scene.add(mesh);

  const box = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  controls.target.copy(center);

  const dist = Math.max(size.x, size.y, size.z) * 2.2;
  camera.position.set(center.x + dist, center.y + dist, center.z + dist);
  camera.lookAt(center);
  console.log("[VIEWER] Mesh rendered. size:", size);
}

// Signed volume (mm^3) from triangles
function computeVolume(geo) {
  const a = geo.attributes.position.array;
  let v = 0;
  for (let i=0; i<a.length; i+=9) {
    const ax=a[i], ay=a[i+1], az=a[i+2];
    const bx=a[i+3], by=a[i+4], bz=a[i+5];
    const cx=a[i+6], cy=a[i+7], cz=a[i+8];
    v += (ax*by*cz + bx*cy*az + cx*ay*bz - ax*cy*bz - bx*ay*cz - cx*by*az);
  }
  return Math.abs(v) / 6;
}

// ===== Pricing =====
function calculatePrice(m) {
  const mat = MATERIALS[el.material.value];
  const q = el.quality.value;
  const infill = clamp(Number(el.infill.value), 0, 100);
  const supports = el.supports.value;
  const qty = Math.max(1, Number(el.qty.value));

  const baseFee = Number(el.baseFee.value);
  const machineHr = Number(el.machHr.value);
  const ppFee = Number(el.ppFee.value);
  const minOrder = Number(el.minThresh.value);
  const marginPct = Number(el.margin.value);
  const vatPct = Number(el.vat.value);

  const mass_g = (m.volume_mm3 / 1000) * mat.density_g_cm3;
  const material_cost = (mass_g / 1000) * mat.cost_per_kg_thb;

  const base_speed = QUALITY_SPEED[q];
  const time_mult = SUPPORT_TIME_MULTIPLIER[supports] * INFILL_TIME_MULTIPLIER(infill);
  const est_time_min = (m.volume_mm3 / base_speed) * time_mult;

  const machine_cost = (est_time_min / 60) * machineHr;
  const ops_fee = ppFee;

  let subtotal = baseFee + material_cost + machine_cost + ops_fee;
  if (subtotal < minOrder) subtotal = minOrder;

  const with_margin = subtotal * (1 + marginPct/100);
  const with_vat = with_margin * (1 + vatPct/100);

  const per_part_total = with_vat;
  const grand_total = per_part_total * qty;

  const out = {
    inputs: { material: el.material.value, quality: q, infill_pct: infill, supports },
    metrics: {
      volume_mm3: round(m.volume_mm3, 0),
      bbox_mm: { x: round(m.bbox.x,2), y: round(m.bbox.y,2), z: round(m.bbox.z,2) },
      mass_g: round(mass_g, 2),
      est_time_min: round(est_time_min, 1)
    },
    costs: {
      base_fee: round(baseFee, 2),
      material_cost: round(material_cost, 2),
      machine_cost: round(machine_cost, 2),
      post_process_fee: round(ops_fee, 2),
      subtotal_after_min_threshold: round(subtotal, 2),
      margin_pct: round(marginPct, 2),
      vat_pct: round(vatPct, 2)
    },
    totals: { per_part_total: round(per_part_total, 2), grand_total: round(grand_total, 2), quantity: qty }
  };

  console.log("[PRICE] breakdown:", out);
  return out;
}

// ===== UI =====
function showMetrics(m) {
  el.metrics.innerHTML = `
    <p><strong>Volume:</strong> ${round(m.volume_mm3/1000,2)} cm³</p>
    <p><strong>Bounding box (mm):</strong> ${round(m.bbox.x,2)} × ${round(m.bbox.y,2)} × ${round(m.bbox.z,2)}</p>
  `;
}

function showBreakdown(bd) {
  el.breakdown.innerHTML = `
    <h4>Inputs</h4><pre>${JSON.stringify(bd.inputs, null, 2)}</pre>
    <h4>Metrics</h4><pre>${JSON.stringify(bd.metrics, null, 2)}</pre>
    <h4>Costs</h4><pre>${JSON.stringify(bd.costs, null, 2)}</pre>`;
  el.total.innerHTML = `<h3>Total: ${bd.totals.grand_total.toFixed(2)} THB</h3>`;
}

el.calcBtn?.addEventListener('click', () => {
  if (!currentMetrics) { console.warn("[UI] No metrics yet"); return; }
  const bd = calculatePrice(currentMetrics);
  showBreakdown(bd);
  el.download.disabled = false;
  el.download.onclick = () => {
    const blob = new Blob([JSON.stringify(bd, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'quote.json'; a.click();
    URL.revokeObjectURL(url);
  };
  console.log("[UI] Price calculated & download enabled");
});

// ===== Utils =====
function round(n,d){return Math.round(n*10**d)/10**d}
function clamp(v,min,max){return Math.max(min,Math.min(max,v))}
function resetOutputs(){
  el.metrics.innerHTML=''; el.breakdown.innerHTML=''; el.total.innerHTML='';
  el.calcBtn.disabled = true; el.download.disabled = true;
  console.log("[UI] Outputs reset; calcBtn disabled");
}

// Global error hook (helps catch silent errors)
window.addEventListener('error', (e) => console.log("[GLOBAL ERROR]", e.message));
window.addEventListener('unhandledrejection', (e) => console.log("[PROMISE REJECTION]", e.reason));
console.log("[READY] script.js loaded.");
