// script.js — ES Module (multi-file STL estimator + your pricing rules)

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

/* ===================== CONFIG ===================== */
// Material pricing + densities
const MATERIALS = {
  PLA:       { rate: 2.0, baseFee: 150, density_g_cm3: 1.24 },
  PETG:      { rate: 2.4, baseFee: 160, density_g_cm3: 1.27 },
  ABS:       { rate: 3.0, baseFee: 180, density_g_cm3: 1.04 },
  'PETG-CF': { rate: 2.8, baseFee: 175, density_g_cm3: 1.30 }
};

// Estimator knobs (tune to your printer)
const SHELL_BASE = 0.70;                 // mass share at 0% infill (walls/top/bottom)
const INFILL_PORTION = 1.00 - SHELL_BASE;
const CALIBRATION_MULT = 2.02;           // from your samples
const WASTE_GRAMS_PER_PART = 2.0;        // purge/brim/etc per part
const SUPPORT_MASS_MULT = 1.25;          // extra grams when supports=yes

// Convert your speeds to volumetric flow (mm³/min) using lw=0.45mm
// Draft 150 mm/s @ 0.28 → 1134 mm³/min
// Standard 90 mm/s @ 0.20 → 486 mm³/min
// Fine 60 mm/s @ 0.12 → 194 mm³/min
const QUALITY_SPEED = { draft: 1134, standard: 486, fine: 194 };

// Time multipliers
const INFILL_TIME_MULT  = (p) => 0.85 + (clamp(p, 0, 100)/100) * 0.60;  // 0%→0.85, 100%→1.45
const SUPPORT_TIME_MULT = (yn) => yn === 'yes' ? 1.15 : 1.00;

// Prep overhead
const PREP_TIME_PER_JOB_MIN = 6 + 14/60; // 6m14s ≈ 6.2333
const PREP_IS_PER_PART = false;          // set true if each file (or copy) is its own job

// Pricing constants
const SMALL_FEE_THRESHOLD = 250; // THB
const SMALL_FEE_TAPER     = 400; // THB
const PRINT_RATE_PER_HOUR = 10;  // THB/hr

/* ===================== DOM ===================== */
const $ = (id) => document.getElementById(id);
const el = {
  file: $('stlFile'),
  fileInfo: $('fileInfo'),
  fileListWrap: $('fileListWrap'),
  fileList: $('fileList'),

  material: $('material'),
  quality: $('quality'),
  infill: $('infill'),
  supports: $('supports'),

  // (global qty removed; quantities are per-file now)
  calcBtn: $('calcBtn'),
  summary: $('summaryList'),
  grandTotal: $('grandTotal'),
  download: $('downloadQuote'),
  canvas: $('viewer')
};

/* ===================== VIEWER ===================== */
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

/* ===================== MODELS STATE ===================== */
// models[] holds: { id, name, volume_mm3, bbox, qty }
let models = [];
let idSeq = 1;

/* ===================== FILE HANDLING (MULTI) ===================== */
el.file.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  resetOutputs();
  el.fileList.innerHTML = '';
  models = [];

  if (!files.length) {
    el.fileInfo.textContent = 'No files selected.';
    el.fileListWrap.style.display = 'none';
    el.calcBtn.disabled = true;
    return;
  }
  el.fileInfo.textContent = `${files.length} file(s) selected. Units assumed mm.`;

  // Parse sequentially to keep UI snappy
  for (const f of files) {
    if (!f.name.toLowerCase().endsWith('.stl')) continue;

    try {
      const buf = await f.arrayBuffer();
      const parsed = new STLLoader().parse(buf);
      const g = parsed.isBufferGeometry ? parsed : new THREE.BufferGeometry().fromGeometry(parsed);
      g.computeBoundingBox(); g.computeVertexNormals();

      const volume_mm3 = computeVolume(g);
      const bbox = {
        x: g.boundingBox.max.x - g.boundingBox.min.x,
        y: g.boundingBox.max.y - g.boundingBox.min.y,
        z: g.boundingBox.max.z - g.boundingBox.min.z
      };

      const model = { id: idSeq++, name: f.name, volume_mm3, bbox, qty: 1 };
      models.push(model);

      // add row to list; clicking name previews it
      addFileRow(model, g);

      // show first mesh (or keep last – your choice)
      renderMesh(g);
    } catch (err) {
      console.error('STL parse failed:', f.name, err);
    }
  }

  el.fileListWrap.style.display = models.length ? 'block' : 'none';
  el.calcBtn.disabled = models.length === 0;
});

function addFileRow(model, geometryForPreview) {
  const row = document.createElement('div');
  row.style.display = 'grid';
  row.style.gridTemplateColumns = '1fr 110px 140px';
  row.style.gap = '10px';
  row.style.alignItems = 'center';
  row.style.borderBottom = '1px dashed #e5e7eb';
  row.style.padding = '6px 0';

  // name (click to preview)
  const name = document.createElement('button');
  name.textContent = model.name;
  name.style.textAlign = 'left';
  name.style.background = 'transparent';
  name.style.border = 'none';
  name.style.cursor = 'pointer';
  name.title = 'Click to preview this model';
  name.onclick = () => renderMesh(geometryForPreview);

  // volume info (cm³)
  const vol = document.createElement('div');
  vol.textContent = `${(model.volume_mm3/1000).toFixed(2)} cm³`;

  // qty input
  const qtyWrap = document.createElement('div');
  const qtyLabel = document.createElement('label');
  qtyLabel.textContent = 'Qty ';
  const qty = document.createElement('input');
  qty.type = 'number';
  qty.min = '1';
  qty.step = '1';
  qty.value = String(model.qty);
  qty.style.width = '80px';
  qty.oninput = () => {
    const v = Math.max(1, parseInt(qty.value || '1', 10));
    qty.value = String(v);
    model.qty = v;
  };
  qtyLabel.appendChild(qty);
  qtyWrap.appendChild(qtyLabel);

  row.appendChild(name);
  row.appendChild(vol);
  row.appendChild(qtyWrap);
  el.fileList.appendChild(row);
}

/* ===================== RENDER MESH ===================== */
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

/* ===================== VOLUME ===================== */
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

/* ===================== CALCULATE (BATCH) ===================== */
el.calcBtn.addEventListener('click', () => {
  if (!models.length) return;

  const matKey   = el.material.value;
  const mat      = MATERIALS[matKey];
  const quality  = el.quality.value;
  const infill   = clamp(+el.infill.value || 0, 0, 100);
  const supports = el.supports.value;

  // totals
  let totalGrams = 0;
  let totalMinutes = 0;

  // per-file breakdown (for JSON)
  const items = [];

  // per-file compute using same settings for batch
  for (const m of models) {
    const grams_solid = (m.volume_mm3 / 1000) * mat.density_g_cm3;         // g for solid
    const fillFactor  = SHELL_BASE + INFILL_PORTION * (infill/100);         // shells + infill
    const supportMass = (supports === 'yes') ? SUPPORT_MASS_MULT : 1.0;

    const gramsPerPart = grams_solid * fillFactor * supportMass * CALIBRATION_MULT + WASTE_GRAMS_PER_PART;
    const gramsThis    = gramsPerPart * m.qty;

    const baseSpeed = QUALITY_SPEED[quality];                                // mm³/min
    const timeMult  = INFILL_TIME_MULT(infill) * SUPPORT_TIME_MULT(supports);
    const timeMinPerPart = (m.volume_mm3 / baseSpeed) * timeMult;
    const minutesThis    = timeMinPerPart * m.qty;

    totalGrams   += gramsThis;
    totalMinutes += minutesThis;

    items.push({
      file: m.name,
      qty: m.qty,
      volume_mm3: Math.round(m.volume_mm3),
      grams_per_part: round(gramsPerPart,2),
      grams_total: round(gramsThis,2),
      minutes_total: Math.round(minutesThis)
    });
  }

  // add prep overhead (per job or per part)
  const totalParts = models.reduce((s,m)=>s+m.qty,0);
  totalMinutes += PREP_TIME_PER_JOB_MIN * (PREP_IS_PER_PART ? totalParts : 1);

  const totalHours = totalMinutes / 60;

  // pricing
  const materialCost = totalGrams * mat.rate;
  const printCost    = totalHours * PRINT_RATE_PER_HOUR;
  const subtotal     = materialCost + printCost;

  let smallOrderFee;
  if (subtotal <= SMALL_FEE_THRESHOLD) {
    smallOrderFee = mat.baseFee;
  } else {
    const reduction = ((subtotal - SMALL_FEE_THRESHOLD) / SMALL_FEE_TAPER) * mat.baseFee;
    smallOrderFee = Math.max(mat.baseFee - reduction, 0);
  }

  const finalPrice = Math.ceil(subtotal + smallOrderFee);

  // UI summary (keep concise)
  el.summary.innerHTML = `
    <li><span>Models</span><strong>${models.length} file(s), ${totalParts} part(s)</strong></li>
    <li><span>Filament</span><strong>${matKey}</strong></li>
    <li><span>Total used</span><strong>${round(totalGrams,2)} g</strong></li>
    <li><span>Total time</span><strong>${Math.floor(totalHours)} h ${Math.round((totalHours%1)*60)} m</strong></li>
    <li><span>Printing fee</span><strong>${round(materialCost + printCost, 2)} THB</strong></li>
    <li><span>Small order fee</span><strong>${round(smallOrderFee, 2)} THB</strong></li>
  `;
  el.grandTotal.innerHTML = `<div class="total"><h2>Total price: ${finalPrice} THB</h2></div>`;

  // JSON download
  const payload = {
    material: matKey,
    quality, infill, supports,
    totals: {
      files: models.length,
      parts: totalParts,
      grams: round(totalGrams,2),
      minutes: Math.round(totalMinutes),
      hours: Math.floor(totalHours),
      remMinutes: Math.round((totalHours%1)*60)
    },
    costs: {
      materialCost: round(materialCost,2),
      printCost: round(printCost,2),
      smallOrderFee: round(smallOrderFee,2),
      finalPrice
    },
    prep: {
      minutes: PREP_TIME_PER_JOB_MIN,
      mode: PREP_IS_PER_PART ? 'per-part' : 'per-job'
    },
    items
  };
  el.download.disabled = false;
  el.download.onclick = () => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'quote.json'; a.click();
    URL.revokeObjectURL(url);
  };
});

/* ===================== HELPERS ===================== */
function round(n,d){return Math.round(n*10**d)/10**d}
function clamp(v,min,max){return Math.max(min,Math.min(max,v))}
function resetOutputs(){
  el.summary.innerHTML = '';
  el.grandTotal.innerHTML = '';
  el.download.disabled = true;
  el.calcBtn.disabled = true;
  el.fileList.innerHTML = '';
  el.fileListWrap.style.display = 'none';
}
