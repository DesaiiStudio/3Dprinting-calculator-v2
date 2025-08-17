// script.js — ES Module with your pricing rules

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

/* ====== MATERIALS & RATES ====== */
const MATERIALS = {
  PLA:       { rate: 2.0, baseFee: 150, density_g_cm3: 1.24 },
  PETG:      { rate: 2.4, baseFee: 160, density_g_cm3: 1.27 },
  ABS:       { rate: 3.0, baseFee: 180, density_g_cm3: 1.04 },
  'PETG-CF': { rate: 2.8, baseFee: 175, density_g_cm3: 1.30 }
};
const SMALL_FEE_THRESHOLD = 250;
const SMALL_FEE_TAPER     = 400;
const PRINT_RATE_PER_HOUR = 10;

/* ====== DOM ====== */
const $ = (id) => document.getElementById(id);
const el = {
  file: $('stlFile'),
  fileInfo: $('fileInfo'),
  material: $('material'),
  hours: $('hours'),
  minutes: $('minutes'),
  qty: $('qty'),
  calcBtn: $('calcBtn'),
  summary: $('summaryList'),
  grandTotal: $('grandTotal'),
  download: $('downloadQuote'),
  canvas: $('viewer')
};

/* ====== Viewer ====== */
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

  // create the camera BEFORE first size call
  camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);
  camera.position.set(120,120,120);

  // now safe to size renderer + update camera
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
  if (!camera) return;                 // guard against early calls
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
function animate() {
  requestAnimationFrame(animate);
  controls?.update();
  renderer?.render(scene, camera);
}

/* ====== STL metrics ====== */
let model = { volume_mm3: 0, grams: 0, bbox: {x:0,y:0,z:0} };

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

// signed volume (mm^3)
function computeVolume(geo) {
  const a = geo.attributes.position.array;
  let v = 0;
  for (let i = 0; i < a.length; i += 9) {
    const ax=a[i], ay=a[i+1], az=a[i+2];
    const bx=a[i+3], by=a[i+4], bz=a[i+5];
    const cx=a[i+6], cy=a[i+7], cz=a[i+8];
    v += (ax*by*cz + bx*cy*az + cx*ay*bz - ax*cy*bz - bx*ay*cz - cx*by*az);
  }
  return Math.abs(v) / 6;
}

/* ====== Pricing (your spec) ====== */
el.calcBtn.addEventListener('click', () => {
  const filament = el.material.value;
  const qty = Math.max(1, Number(el.qty.value || 1));
  const hrs = Math.max(0, Number(el.hours.value || 0));
  const mins = Math.min(59, Math.max(0, Number(el.minutes.value || 0)));

  const mat = MATERIALS[filament];

  const gramsPerPart = (model.volume_mm3 / 1000) * mat.density_g_cm3;
  const totalGrams = gramsPerPart * qty;

  const totalMinutes = qty * (hrs * 60 + mins);
  const totalHours = totalMinutes / 60;

  const materialCost = totalGrams * mat.rate;
  const printCost = totalHours * PRINT_RATE_PER_HOUR;
  const subtotal = materialCost + printCost;

  let smallOrderFee;
  if (subtotal <= SMALL_FEE_THRESHOLD) {
    smallOrderFee = mat.baseFee;
  } else {
    const reduction = ((subtotal - SMALL_FEE_THRESHOLD) / SMALL_FEE_TAPER) * mat.baseFee;
    smallOrderFee = Math.max(mat.baseFee - reduction, 0);
  }

  const finalPrice = Math.ceil(subtotal + smallOrderFee);

  el.summary.innerHTML = `
    <li><span>Filament</span><strong>${filament}</strong></li>
    <li><span>Total used</span><strong>${round(totalGrams,2)} g</strong></li>
    <li><span>Total time</span><strong>${Math.floor(totalHours)} h ${Math.round((totalHours%1)*60)} m</strong></li>
    <li><span>Printing fee</span><strong>${round(materialCost + printCost, 2)} THB</strong></li>
    <li><span>Small order fee</span><strong>${round(smallOrderFee, 2)} THB</strong></li>
  `;
  el.grandTotal.innerHTML = `<div class="total"><h2>Total price: ${finalPrice} THB</h2></div>`;

  const payload = {
    filament, quantity: qty,
    gramsPerPart: round(gramsPerPart,2),
    totalGrams: round(totalGrams,2),
    time: { hours: Math.floor(totalHours), minutes: Math.round((totalHours%1)*60) },
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

/* ====== helpers ====== */
function round(n,d){return Math.round(n*10**d)/10**d}
function resetOutputs(){
  el.summary.innerHTML = '';
  el.grandTotal.innerHTML = '';
  el.download.disabled = true;
  el.calcBtn.disabled = true;
}
