// script.js — Multi-file STL estimator with: cumulative list, remove, drag&drop, thumbnails
// Colors: light-gray viewport, orange model

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

// Estimator knobs (calibrated)
const SHELL_BASE = 0.70;
const INFILL_PORTION = 1.00 - SHELL_BASE;
const CALIBRATION_MULT = 2.02;
const WASTE_GRAMS_PER_PART = 2.0;
const SUPPORT_MASS_MULT = 1.25;

// Speeds from your targets (line width 0.45): 150/90/60 mm/s → mm³/min
const QUALITY_SPEED = { draft: 1134, standard: 486, fine: 194 };

// Time multipliers
const INFILL_TIME_MULT  = (p) => 0.85 + (clamp(p, 0, 100)/100) * 0.60;
const SUPPORT_TIME_MULT = (yn) => yn === 'yes' ? 1.15 : 1.00;

// Prep overhead
const PREP_TIME_PER_JOB_MIN = 6 + 14/60; // ≈6.2333
const PREP_IS_PER_PART = false;

// Pricing
const SMALL_FEE_THRESHOLD = 250;
const SMALL_FEE_TAPER     = 400;
const PRINT_RATE_PER_HOUR = 10;

/* ===================== DOM ===================== */
const $ = (id) => document.getElementById(id);
const el = {
  file: $('stlFile'),
  fileInfo: $('fileInfo'),
  dropZone: $('dropZone'),
  fileListWrap: $('fileListWrap'),
  fileList: $('fileList'),

  material: $('material'),
  quality: $('quality'),
  infill: $('infill'),
  supports: $('supports'),

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
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });

  scene = new THREE.Scene();
  // Light gray background
  scene.background = new THREE.Color(0xf3f4f6);

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

/* ===================== STATE ===================== */
// models[]: { id, name, volume_mm3, bbox, qty, thumbDataURL, geom? (optional) }
let models = [];
let idSeq = 1;

/* ===================== FILE INPUT (CUMULATIVE) ===================== */
el.file.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  await addFiles(files);
  // clear the input value so selecting the same files again still triggers change
  el.file.value = '';
});

/* ===================== DRAG & DROP ===================== */
const dz = el.dropZone || document.body;

['dragenter','dragover'].forEach(evt =>
  dz.addEventListener(evt, (e)=>{ e.preventDefault(); dz.style.opacity='0.85'; }, false)
);
['dragleave','drop'].forEach(evt =>
  dz.addEventListener(evt, (e)=>{ e.preventDefault(); dz.style.opacity='1'; }, false)
);

dz.addEventListener('drop', async (e) => {
  const items = e.dataTransfer?.items;
  let files = [];
  if (items && items.length) {
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
  } else {
    files = Array.from(e.dataTransfer?.files || []);
  }
  if (!files.length) return;
  await addFiles(files);
});

/* ===================== ADD FILES (accumulate, dedupe by name+size) ===================== */
async function addFiles(fileList) {
  const stls = fileList.filter(f => /\.stl$/i.test(f.name));
  if (!stls.length) return;

  el.fileInfo.textContent = `Added ${stls.length} file(s). Total: ${models.length + stls.length}`;
  for (const f of stls) {
    // dedupe by (name,size)
    if (models.some(m => m._sig === sigOf(f))) continue;

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

      // make a tiny thumbnail
      const thumbDataURL = await makeThumbnail(g);

      const model = {
        id: idSeq++,
        name: f.name,
        _sig: sigOf(f),
        volume_mm3,
        bbox,
        qty: 1,
        thumbDataURL
      };
      models.push(model);
      addFileRow(model, g);
      // show last added in viewer
      renderMesh(g);
    } catch (err) {
      console.error('STL parse failed:', f.name, err);
    }
  }

  el.fileListWrap.style.display = models.length ? 'block' : 'none';
  el.calcBtn.disabled = models.length === 0;
}

function sigOf(file){ return `${file.name}::${file.size}`; }

/* ===================== FILE LIST ROW (thumb + name + qty + remove) ===================== */
function addFileRow(model, geometryForPreview) {
  const row = document.createElement('div');
  row.style.display = 'grid';
  row.style.gridTemplateColumns = '60px 1fr 110px 120px';
  row.style.gap = '10px';
  row.style.alignItems = 'center';
  row.style.borderBottom = '1px dashed #e5e7eb';
  row.style.padding = '6px 0';
  row.id = `row-${model.id}`;

  // thumbnail
  const thumb = document.createElement('img');
  thumb.src = model.thumbDataURL;
  thumb.alt = 'thumb';
  thumb.style.width = '56px';
  thumb.style.height = '56px';
  thumb.style.objectFit = 'cover';
  thumb.style.borderRadius = '8px';
  thumb.style.border = '1px solid #e5e7eb';
  thumb.style.background = '#f3f4f6';
  thumb.onclick = () => renderMesh(geometryForPreview);

  // name + vol
  const nameWrap = document.createElement('div');
  const nameBtn = document.createElement('button');
  nameBtn.textContent = model.name;
  nameBtn.style.textAlign = 'left';
  nameBtn.style.background = 'transparent';
  nameBtn.style.border = 'none';
  nameBtn.style.cursor = 'pointer';
  nameBtn.style.fontWeight = '600';
  nameBtn.title = 'Click to preview this model';
  nameBtn.onclick = () => renderMesh(geometryForPreview);

  const vol = document.createElement('div');
  vol.textContent = `${(model.volume_mm3/1000).toFixed(2)} cm³`;
  vol.style.color = '#6b7280';
  vol.style.fontSize = '12px';
  nameWrap.appendChild(nameBtn);
  nameWrap.appendChild(vol);

  // qty
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

  // remove
  const rmv = document.createElement('button');
  rmv.textContent = 'Remove';
  rmv.style.border = '1px solid #ef4444';
  rmv.style.background = '#fff';
  rmv.style.color = '#ef4444';
  rmv.style.padding = '6px 10px';
  rmv.style.borderRadius = '8px';
  rmv.style.cursor = 'pointer';
  rmv.onclick = () => {
    models = models.filter(m => m.id !== model.id);
    row.remove();
    el.calcBtn.disabled = models.length === 0;
    if (!models.length) {
      el.fileListWrap.style.display = 'none';
      el.summary.innerHTML = '';
      el.grandTotal.innerHTML = '';
    }
  };

  row.appendChild(thumb);
  row.appendChild(nameWrap);
  row.appendChild(qtyWrap);
  row.appendChild(rmv);
  el.fileList.appendChild(row);
}

/* ===================== RENDER MESH (orange) ===================== */
function renderMesh(geo) {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
  mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0xff7a00, metalness: 0.05, roughness: 0.85 })
  );
  scene.add(mesh);

  const box = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  controls.target.copy(center);

  const dist = Math.max(size.x, size.y, size.z) * 2.2 + 10;
  camera.position.set(center.x + dist, center.y + dist, center.z + dist);
  camera.lookAt(center);
}

/* ===================== THUMBNAIL MAKER ===================== */
async function makeThumbnail(geo) {
  const w = 140, h = 100;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  const scn = new THREE.Scene();
  scn.background = new THREE.Color(0xf3f4f6); // match viewer bg

  const light1 = new THREE.DirectionalLight(0xffffff, 1.0); light1.position.set(1,1,1);
  const amb = new THREE.AmbientLight(0xffffff, 0.45);
  scn.add(light1, amb);

  const cam = new THREE.PerspectiveCamera(50, w/h, 0.1, 10000);

  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xff7a00, metalness: 0.05, roughness: 0.85 }));
  scn.add(m);

  const box = new THREE.Box3().setFromObject(m);
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);

  const dist = Math.max(size.x, size.y, size.z) * 2.6 + 10;
  cam.position.set(center.x + dist, center.y + dist, center.z + dist);
  cam.lookAt(center);

  r.setSize(w, h, false);
  r.render(scn, cam);

  const url = canvas.toDataURL('image/png');
  r.dispose();
  m.geometry.dispose();
  m.material.dispose();
  return url;
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

  let totalGrams = 0;
  let totalMinutes = 0;
  const items = [];

  for (const m of models) {
    // grams
    const grams_solid = (m.volume_mm3 / 1000) * mat.density_g_cm3;
    const fillFactor  = SHELL_BASE + INFILL_PORTION * (infill/100);
    const supportMass = (supports === 'yes') ? SUPPORT_MASS_MULT : 1.0;
    const gramsPerPart = grams_solid * fillFactor * supportMass * CALIBRATION_MULT + WASTE_GRAMS_PER_PART;
    const gramsThis = gramsPerPart * m.qty;

    // time
    const baseSpeed = QUALITY_SPEED[quality];
    const timeMult  = INFILL_TIME_MULT(infill) * SUPPORT_TIME_MULT(supports);
    const timeMinPerPart = (m.volume_mm3 / baseSpeed) * timeMult;
    const minutesThis = timeMinPerPart * m.qty;

    totalGrams += gramsThis;
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

  // UI
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
