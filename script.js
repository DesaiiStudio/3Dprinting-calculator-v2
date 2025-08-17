// script.js — ES Module (STL-only estimator)

// Imports via import map
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

/* ================= CONFIG ================= */
// Material pricing + densities
const MATERIALS = {
  PLA:       { rate: 2.0, baseFee: 150, density_g_cm3: 1.24 },
  PETG:      { rate: 2.4, baseFee: 160, density_g_cm3: 1.27 },
  ABS:       { rate: 3.0, baseFee: 180, density_g_cm3: 1.04 },
  'PETG-CF': { rate: 2.8, baseFee: 175, density_g_cm3: 1.30 }
};
// Estimated volumetric throughput (mm^3/min) by quality
const QUALITY_SPEED = {
  draft:    320,  // ~60 mm/s @ 0.28 layer, 0.45 line, 70% efficiency
  standard: 230,  // ~60 mm/s @ 0.20 layer, 0.45 line, 70% efficiency
  fine:     140   // ~60 mm/s @ 0.12 layer, 0.45 line, 70% efficiency
};
const INFILL_TIME_MULT = (p) => 0.85 + (p/100) * 0.60;
// Supports slow-down
const SUPPORT_MULT = (yn) => yn === 'yes' ? 1.15 : 1.00;
// Convert volume to GRAMS factor (shells≈38% + infill remainder)
const MASS_FACTOR = (p) => 0.38 + (p/100) * 0.62;  // 0%→0.38, 100%→1.00
// Pricing constants
const SMALL_FEE_THRESHOLD = 250; // THB
const SMALL_FEE_TAPER     = 400; // THB
const PRINT_RATE_PER_HOUR = 10;  // THB/hr

/* ================= DOM ================= */
const $ = (id) => document.getElementById(id);
const el = {
  file: $('stlFile'),
  fileInfo: $('fileInfo'),
  material: $('material'),
  quality: $('quality'),
  infill: $('infill'),
  supports: $('supports'),
  qty: $('qty'),
  calcBtn: $('calcBtn'),
  summary: $('summaryList'),
  grandTotal: $('grandTotal'),
  download: $('downloadQuote'),
  canvas: $('viewer')
};

/* ================= VIEWER ================= */
let renderer, scene, camera, controls, mesh;

initViewer();

function initViewer() {
  const canvas = el.canvas;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1115);

  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(1,1,1);
  scene.add(key, new THREE.AmbientLight(0xffffff, 0.45));

  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);
  camera.position.set(120,120,120);

  sizeViewer();
  window.addEventListener('resize', sizeViewer);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  animate();
}
function sizeViewer() {
  if (!renderer) return;
  const canvas = renderer.domElement;
  const w = (canvas.parentElement?.clientWidth || 900);
  const h = Math.max(320, Math.floor(w * 0.55));
  renderer.setSize(w, h, false);
  if (!camera) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
function animate() {
  requestAnimationFrame(animate);
  controls?.update();
  renderer?.render(scene, camera);
}

/* ================= STL → metrics ================= */
let model = { volume_mm3: 0, bbox: {x:0,y:0,z:0} };

el.file.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  resetOutputs();
  if (!file) return;

  if (!file.name.toLowerCase().endsWith('.stl')) {
    el.fileInfo.textContent = 'Please choose a .stl file.';
    return;
  }
  el.fileInfo.textContent = `Selected: ${file.name} (${(file.size/1024/1024).toFixed(2)} MB)`;

  try {
    const buf = await file.arrayBuffer();
    const parsed = new STLLoader().parse(buf);
    const g = parsed.isBufferGeometry ? parsed : new THREE.BufferGeometry().fromGeometry(parsed);
    g.computeBoundingBox(); g.computeVertexNormals();

    model.volume_mm3 = computeVolume(g);
    model.bbox = {
      x: g.boundingBox.max.x - g.boundingBox.min.x,
      y: g.boundingBox.max.y - g.boundingBox.min.y,
      z: g.boundingBox.max.z - g.boundingBox.min.z
    };

    renderMesh(g);
    el.calcBtn.disabled = false;
  } catch (err) {
    console.error('STL parse failed:', err);
    el.fileInfo.textContent = 'Could not parse STL (file invalid).';
    el.calcBtn.disabled = true;
  }
});

function renderMesh(geo) {
  if (mesh) scene.remove(mesh);
  mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0x5ad, metalness: 0.1, roughness: 0.85 })
  );
  scene.add(mesh);

  const box = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  controls.target.copy(center);

  const dist = Math.max(size.x, size.y, size.z) * 2.2;
  camera.position.set(center.x + dist, center.y + dist, center.z + dist);
  camera.lookAt(center);
}

// Signed volume (mm^3)
function computeVolume(geo) {
  const a = geo.attributes.position.array;
  let v = 0;
  for (let i=0;i<a.length;i+=9){
    const ax=a[i], ay=a[i+1], az=a[i+2];
    const bx=a[i+3], by=a[i+4], bz=a[i+5];
    const cx=a[i+6], cy=a[i+7], cz=a[i+8];
    v += (ax*by*cz + bx*cy*az + cx*ay*bz - ax*cy*bz - bx*ay*cz - cx*by*az);
  }
  return Math.abs(v)/6;
}

/* ================= Estimator + Pricing ================= */
el.calcBtn.addEventListener('click', () => {
  const matKey = el.material.value;
  const mat = MATERIALS[matKey];
  const quality = el.quality.value;            // draft/standard/fine
  const infill = clamp(+el.infill.value || 0, 0, 100);
  const supports = el.supports.value;          // yes/no
  const qty = Math.max(1, +el.qty.value || 1);

  // 1) grams (uses STL volume, material density and fill factor)
  const gramsPerPart = (model.volume_mm3 / 1000) * mat.density_g_cm3 * MASS_FACTOR(infill);
  const totalGrams = gramsPerPart * qty;

  // 2) time estimator
  const baseSpeed = QUALITY_SPEED[quality];                // mm^3/min
  const timeMult = INFILL_TIME_MULT(infill) * SUPPORT_MULT(supports);
  const timeMinPerPart = (model.volume_mm3 / baseSpeed) * timeMult;
  const totalMinutes = timeMinPerPart * qty;
  const totalHours = totalMinutes / 60;

  // --- Your pricing rules ---
  // Material fee
  const materialCost = totalGrams * mat.rate;
  // Printing time fee
  const printCost = totalHours * PRINT_RATE_PER_HOUR;
  // Subtotal
  const subtotal = materialCost + printCost;
  // Small order fee (dynamic)
  let smallOrderFee;
  if (subtotal <= SMALL_FEE_THRESHOLD) {
    smallOrderFee = mat.baseFee;
  } else {
    const reduction = ((subtotal - SMALL_FEE_THRESHOLD) / SMALL_FEE_TAPER) * mat.baseFee;
    smallOrderFee = Math.max(mat.baseFee - reduction, 0);
  }
  // Final (ceil)
  const finalPrice = Math.ceil(subtotal + smallOrderFee);

  // UI
  el.summary.innerHTML = `
    <li><span>Filament</span><strong>${matKey}</strong></li>
    <li><span>Total used</span><strong>${round(totalGrams,2)} g</strong></li>
    <li><span>Total time</span><strong>${Math.floor(totalHours)} h ${Math.round((totalHours%1)*60)} m</strong></li>
    <li><span>Printing fee</span><strong>${round(materialCost + printCost, 2)} THB</strong></li>
    <li><span>Small order fee</span><strong>${round(smallOrderFee, 2)} THB</strong></li>
  `;
  el.grandTotal.innerHTML = `<div class="total"><h2>Total price: ${finalPrice} THB</h2></div>`;

  // JSON download
  const payload = {
    filament: matKey, quantity: qty,
    gramsPerPart: round(gramsPerPart,2),
    totalGrams: round(totalGrams,2),
    estTime: { minutes: Math.round(totalMinutes), hours: Math.floor(totalHours), remMinutes: Math.round((totalHours%1)*60) },
    materialCost: round(materialCost,2),
    printCost: round(printCost,2),
    smallOrderFee: round(smallOrderFee,2),
    finalPrice
  };
  el.download.disabled = false;
  el.download.onclick = () => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'quote.json'; a.click();
    URL.revokeObjectURL(url);
  };
});

/* ================= helpers ================= */
function round(n,d){return Math.round(n*10**d)/10**d}
function clamp(v,min,max){return Math.max(min,Math.min(max,v))}
function resetOutputs(){
  el.summary.innerHTML = '';
  el.grandTotal.innerHTML = '';
  el.download.disabled = true;
  el.calcBtn.disabled = true;
}
