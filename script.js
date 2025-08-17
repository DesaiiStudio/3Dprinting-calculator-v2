// script.js (ES Module) — imports three.js + STLLoader directly
import * as THREE from 'https://unpkg.com/three@0.161.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.161.0/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'https://unpkg.com/three@0.161.0/examples/jsm/loaders/STLLoader.js';

/* ========= Config (editable) ========= */
const MATERIALS = {
  "PLA":     { density_g_cm3: 1.24, cost_per_kg_thb: 450 },
  "PETG":    { density_g_cm3: 1.27, cost_per_kg_thb: 500 },
  "PETG-CF": { density_g_cm3: 1.30, cost_per_kg_thb: 750 }
};
const QUALITY_SPEED = { draft: 600, standard: 420, fine: 260 }; // mm^3/min
const SUPPORT_TIME_MULTIPLIER = { yes: 1.15, no: 1.0 };
const INFILL_TIME_MULTIPLIER = (infillPct) => 0.85 + (infillPct / 100) * 0.6;

/* ========= DOM ========= */
const $ = (id) => document.getElementById(id);
const fileInput   = $('stlFile');
const fileInfo    = $('fileInfo');
const calcBtn     = $('calcBtn');
const metricsEl   = $('metrics');
const breakdownEl = $('breakdown');
const totalEl     = $('total');
const downloadBtn = $('downloadQuote');

const materialSel = $('material');
const qualitySel  = $('quality');
const infillInp   = $('infill');
const supportsSel = $('supports');
const qtyInp      = $('qty');

const baseFeeInp   = $('baseFee');
const machHrInp    = $('machHr');
const ppFeeInp     = $('ppFee');
const minThreshInp = $('minThresh');
const marginInp    = $('margin');
const vatInp       = $('vat');

/* ========= Viewer ========= */
let renderer, scene, camera, controls, mesh;
initViewer();

function initViewer() {
  const canvas = $('viewer');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  resizeRenderer();
  window.addEventListener('resize', resizeRenderer);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1115);

  const light1 = new THREE.DirectionalLight(0xffffff, 1.0);
  light1.position.set(1, 1, 1);
  scene.add(light1);
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));

  camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / canvas.clientHeight, 0.1, 10000);
  camera.position.set(120, 120, 120);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  animate();
}
function resizeRenderer() {
  const canvas = renderer.domElement;
  const parent = canvas.parentElement || document.body;
  const w = parent.clientWidth || 600;
  const h = Math.max(320, Math.floor(w * 0.55));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

/* ========= STL load & measure ========= */
let currentMetrics = null;

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  resetOutputs();
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.stl')) {
    fileInfo.textContent = 'Please choose a .stl file.';
    return;
  }
  fileInfo.textContent = `Selected: ${file.name} (${(file.size/1024/1024).toFixed(2)} MB)`;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const loader = new STLLoader();
    const parsed = loader.parse(arrayBuffer);

    const geo = parsed.isBufferGeometry ? parsed : new THREE.BufferGeometry().fromGeometry(parsed);
    geo.computeBoundingBox();
    geo.computeVertexNormals();

    const volume_mm3 = computeVolume(geo);
    const bbox = {
      x: (geo.boundingBox.max.x - geo.boundingBox.min.x),
      y: (geo.boundingBox.max.y - geo.boundingBox.min.y),
      z: (geo.boundingBox.max.z - geo.boundingBox.min.z)
    };

    currentMetrics = { volume_mm3, bbox };
    renderMesh(geo);
    showMetrics(currentMetrics);
    calcBtn.disabled = false;
  } catch (err) {
    console.error(err);
    fileInfo.textContent = 'Could not parse STL (file invalid).';
    calcBtn.disabled = true;
  }
});

function renderMesh(geo) {
  if (mesh) scene.remove(mesh);
  const mat = new THREE.MeshStandardMaterial({ color: 0x5ad, metalness: 0.1, roughness: 0.8 });
  mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);

  const box = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  controls.target.copy(center);
  const maxDim = Math.max(size.x, size.y, size.z);
  const dist = maxDim * 2.2;
  camera.position.set(center.x + dist, center.y + dist, center.z + dist);
  camera.lookAt(center);
}

// Signed volume from triangles (expects mm units)
function computeVolume(bufferGeo) {
  const pos = bufferGeo.attributes.position.array;
  let vol = 0.0;
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i],     ay = pos[i+1], az = pos[i+2];
    const bx = pos[i+3],   by = pos[i+4], bz = pos[i+5];
    const cx = pos[i+6],   cy = pos[i+7], cz = pos[i+8];
    vol += (ax*by*cz + bx*cy*az + cx*ay*bz - ax*cy*bz - bx*ay*cz - cx*by*az);
  }
  return Math.abs(vol) / 6.0; // mm^3
}

/* ========= Pricing ========= */
function calculatePrice(metrics) {
  const mat = MATERIALS[materialSel.value];
  const qualityKey = qualitySel.value;
  const infillPct = clamp(Number(infillInp.value), 0, 100);
  const supports = supportsSel.value;
  const qty = Math.max(1, Number(qtyInp.value));

  const baseFee    = Number(baseFeeInp.value);
  const machine_hr = Number(machHrInp.value);
  const pp_fee     = Number(ppFeeInp.value);
  const min_order  = Number(minThreshInp.value);
  const margin_pct = Number(marginInp.value);
  const vat_pct    = Number(vatInp.value);

  const mass_g = (metrics.volume_mm3 / 1000) * mat.density_g_cm3;
  const material_cost = (mass_g / 1000) * mat.cost_per_kg_thb;

  const base_speed = QUALITY_SPEED[qualityKey];
  const time_mult  = SUPPORT_TIME_MULTIPLIER[supports] * INFILL_TIME_MULTIPLIER(infillPct);
  const est_time_min = (metrics.volume_mm3 / base_speed) * time_mult;

  const machine_cost = (est_time_min / 60) * machine_hr;
  const ops_fee = pp_fee;

  let subtotal = baseFee + material_cost + machine_cost + ops_fee;
  if (subtotal < min_order) subtotal = min_order;

  const with_margin = subtotal * (1 + margin_pct / 100);
  const with_vat    = with_margin * (1 + vat_pct / 100);

  const per_part_total = with_vat;
  const grand_total = per_part_total * qty;

  return {
    inputs: { material: materialSel.value, quality: qualityKey, infill_pct: infillPct, supports },
    metrics: {
      volume_mm3: round(metrics.volume_mm3, 0),
      bbox_mm: { x: round(metrics.bbox.x,2), y: round(metrics.bbox.y,2), z: round(metrics.bbox.z,2) },
      mass_g: round(mass_g, 2),
      est_time_min: round(est_time_min, 1)
    },
    costs: {
      base_fee: round(baseFee, 2),
      material_cost: round(material_cost, 2),
      machine_cost: round(machine_cost, 2),
      post_process_fee: round(ops_fee, 2),
      subtotal_after_min_threshold: round(subtotal, 2),
      margin_pct: round(margin_pct, 2),
      vat_pct: round(vat_pct, 2)
    },
    totals: { per_part_total: round(per_part_total, 2), grand_total: round(grand_total, 2), quantity: qty }
  };
}

/* ========= UI ========= */
function showMetrics(m) {
  metricsEl.innerHTML = `
    <p><strong>Volume:</strong> ${round(m.volume_mm3/1000, 2)} cm³</p>
    <p><strong>Bounding box (mm):</strong> ${round(m.bbox.x,2)} × ${round(m.bbox.y,2)} × ${round(m.bbox.z,2)}</p>
  `;
}
function showBreakdown(bd) {
  breakdownEl.innerHTML = `
    <h4>Inputs</h4><pre>${JSON.stringify(bd.inputs, null, 2)}</pre>
    <h4>Metrics</h4><pre>${JSON.stringify(bd.metrics, null, 2)}</pre>
    <h4>Costs</h4><pre>${JSON.stringify(bd.costs, null, 2)}</pre>
  `;
  totalEl.innerHTML = `<h3>Total: ${bd.totals.grand_total.toFixed(2)} THB</h3>`;
}

calcBtn.addEventListener('click', () => {
  if (!currentMetrics) return;
  const bd = calculatePrice(currentMetrics);
  showBreakdown(bd);
  downloadBtn.disabled = false;
  downloadBtn.onclick = () => {
    const blob = new Blob([JSON.stringify(bd, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'quote.json';
    a.click();
    URL.revokeObjectURL(url);
  };
});

/* ========= Helpers ========= */
function round(num, dec) { return Math.round(num * 10**dec) / 10**dec; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function resetOutputs() {
  metricsEl.innerHTML = '';
  breakdownEl.innerHTML = '';
  totalEl.innerHTML = '';
  calcBtn.disabled = true;
  downloadBtn.disabled = true;
}
