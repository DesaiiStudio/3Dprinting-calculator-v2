// script.js — per-file settings, inline prices, auto-calc, drag&drop, thumbnails
// Viewer: light gray bg; Model color: orange; Orientation locked to x+90

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

/* ===================== ORIENTATION ===================== */
// Lock orientation to x+90
const ORIENT = 'x+90';
const ORIENTATIONS = {
  'none':  [0,0,0],
  'x+90':  [ Math.PI/2, 0, 0],
  'x-90':  [-Math.PI/2, 0, 0],
  'y+90':  [0, Math.PI/2, 0],
  'y-90':  [0,-Math.PI/2, 0],
  'z+90':  [0, 0, Math.PI/2],
  'z-90':  [0, 0,-Math.PI/2],
};
function applyOrientation(obj){
  const e = ORIENTATIONS[ORIENT] || ORIENTATIONS['none'];
  obj.rotation.set(e[0], e[1], e[2]);
}

/* ===================== CONFIG ===================== */
const MATERIALS = {
  PLA:       { rate: 2.0, baseFee: 150, density_g_cm3: 1.24 },
  PETG:      { rate: 2.4, baseFee: 160, density_g_cm3: 1.27 },
  ABS:       { rate: 3.0, baseFee: 180, density_g_cm3: 1.04 },
  'PETG-CF': { rate: 2.8, baseFee: 175, density_g_cm3: 1.30 }
};
// Speeds from your targets (line width 0.45): 150/90/60 mm/s → mm³/min
const QUALITY_SPEED = { draft: 1134, standard: 486, fine: 194 };

// Estimation knobs (grams)
const SHELL_BASE = 0.70;
const INFILL_PORTION = 1.0 - SHELL_BASE;
const CALIBRATION_MULT = 2.02;
const WASTE_GRAMS_PER_PART = 2.0;
const SUPPORT_MASS_MULT = 1.25;

// Time multipliers
const INFILL_TIME_MULT  = (p) => 0.85 + (clamp(p, 0, 100)/100) * 0.60;
const SUPPORT_TIME_MULT = (yn) => yn === 'yes' ? 1.15 : 1.00;

// Prep overhead
const PREP_TIME_PER_JOB_MIN = 6 + 14/60; // 6m14s
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
  scene.background = new THREE.Color(0xf3f4f6); // light gray

  // +10% brighter lights
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(1,1,1);
  const amb = new THREE.AmbientLight(0xffffff, 0.495);
  scene.add(key, amb);

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
function clearViewer() {
  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose?.();
    mesh.material.dispose?.();
    mesh = null;
  }
  controls?.target.set(0,0,0);
  camera?.position.set(120,120,120);
  renderer?.render(scene, camera);
}

/* ===================== STATE ===================== */
// models: { id, name, _sig, volume_mm3, bbox, qty, material, quality, infill, supports, thumbDataURL }
let models = [];
let idSeq = 1;

/* ===================== FILE INPUT (cumulative) ===================== */
el.file?.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  await addFiles(files);
  el.file.value = '';
});

/* ===== Drag & Drop ===== */
if (el.dropZone) {
  ['dragenter','dragover'].forEach(evt =>
    el.dropZone.addEventListener(evt, (e)=>{ e.preventDefault(); el.dropZone.style.opacity='0.85'; })
  );
  ['dragleave','drop'].forEach(evt =>
    el.dropZone.addEventListener(evt, (e)=>{ e.preventDefault(); el.dropZone.style.opacity='1'; })
  );
  el.dropZone.addEventListener('drop', async (e) => {
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
}

/* ===================== ADD FILES ===================== */
async function addFiles(fileList) {
  const stls = fileList.filter(f => /\.stl$/i.test(f.name));
  if (!stls.length) {
    el.fileInfo.textContent = 'Only .stl files are supported.';
    return;
  }
  let added = 0;

  for (const f of stls) {
    if (models.some(m => m._sig === sigOf(f))) continue; // dedupe name+size

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

      const thumbDataURL = await makeThumbnail(g); // uses clone inside

      const model = {
        id: idSeq++,
        name: f.name,
        _sig: sigOf(f),
        volume_mm3,
        bbox,
        qty: 1,
        material: 'PLA',
        quality: 'standard',
        infill: 15,
        supports: 'no',
        thumbDataURL
      };
      models.push(model);

      addFileRow(model, g);
      renderMesh(g);
      added++;
    } catch (err) {
      console.error('STL parse failed:', f.name, err);
    }
  }

  if (added) {
    el.fileListWrap.style.display = 'block';
    updateInfo();
    recalc();
  }
}
function sigOf(file){ return `${file.name}::${file.size}`; }

/* ===================== ROW RENDER ===================== */
function addFileRow(model, geometryForPreview) {
  const row = document.createElement('div');
  row.className = 'file-row';
  row.id = `row-${model.id}`;

  // 1) thumbnail
  const thumb = document.createElement('img');
  thumb.src = model.thumbDataURL;
  thumb.alt = 'thumb';
  Object.assign(thumb.style, {
    width: '56px', height: '56px', objectFit: 'cover',
    borderRadius: '8px', border: '1px solid #e5e7eb', background: '#f3f4f6', cursor: 'pointer'
  });
  thumb.onclick = () => renderMesh(geometryForPreview);

  // 2) model title + volume
  const nameWrap = document.createElement('div');
  const nameBtn = document.createElement('button');
  nameBtn.textContent = model.name;
  Object.assign(nameBtn.style, { textAlign:'left', background:'transparent', border:'none', cursor:'pointer', fontWeight:'600' });
  nameBtn.title = 'Click to preview';
  nameBtn.onclick = () => renderMesh(geometryForPreview);
  const vol = document.createElement('div');
  vol.className = 'mini';
  vol.textContent = `${(model.volume_mm3/1000).toFixed(2)} cm³`;
  nameWrap.appendChild(nameBtn);
  nameWrap.appendChild(vol);

  // 3) settings (material, quality, infill, supports)
  const settings = document.createElement('div');
  settings.style.display = 'grid';
  settings.style.gridTemplateColumns = '1fr 1fr 0.8fr 0.8fr';
  settings.style.gap = '8px';

  const matSel = document.createElement('select');
  ['PLA','PETG','ABS','PETG-CF'].forEach(v=>{
    const o = document.createElement('option'); o.value=v; o.textContent=v; matSel.appendChild(o);
  });
  matSel.value = model.material;

  const qualSel = document.createElement('select');
  [['draft','Draft (0.28)'],['standard','Standard (0.20)'],['fine','Fine (0.12)']]
    .forEach(([v,l])=>{ const o=document.createElement('option'); o.value=v; o.textContent=l; qualSel.appendChild(o); });
  qualSel.value = model.quality;

  const infillIn = document.createElement('input');
  infillIn.type='number'; infillIn.min='0'; infillIn.max='100'; infillIn.step='1';
  infillIn.value = String(model.infill); infillIn.className = 'number short';

  const supSel = document.createElement('select');
  [['no','No'],['yes','Yes']].forEach(([v,l])=>{ const o=document.createElement('option'); o.value=v; o.textContent=l; supSel.appendChild(o); });
  supSel.value = model.supports;

  // attach change listeners → update model + recalc
  matSel.onchange   = () => { model.material = matSel.value; recalc(); };
  qualSel.onchange  = () => { model.quality  = qualSel.value; recalc(); };
  infillIn.oninput  = () => { model.infill   = clamp(+infillIn.value||0,0,100); infillIn.value = String(model.infill); recalc(); };
  supSel.onchange   = () => { model.supports = supSel.value; recalc(); };

  settings.appendChild(matSel);
  settings.appendChild(qualSel);
  settings.appendChild(infillIn);
  settings.appendChild(supSel);

  // 4) qty
  const qtyWrap = document.createElement('div');
  const qty = document.createElement('input');
  qty.type='number'; qty.min='1'; qty.step='1'; qty.value=String(model.qty);
  qty.className='number short';
  qty.oninput = ()=>{ model.qty = Math.max(1, parseInt(qty.value||'1',10)); qty.value = String(model.qty); recalc(); };
  qtyWrap.appendChild(qty);

  // 5) price cell (auto-filled)
  const priceCell = document.createElement('div');
  priceCell.className = 'price-chip';
  priceCell.id = `price-${model.id}`;
  priceCell.textContent = '—';

  // 6) remove
  const rmv = document.createElement('button');
  rmv.textContent = 'Remove';
  Object.assign(rmv.style, { border:'1px solid #ef4444', background:'#fff', color:'#ef4444', padding:'6px 10px', borderRadius:'8px', cursor:'pointer' });
  rmv.onclick = () => {
    models = models.filter(m => m.id !== model.id);
    row.remove();
    if (!models.length) {
      el.fileListWrap.style.display = 'none';
      el.download.disabled = true;
      el.summary.innerHTML = '';
      el.grandTotal.innerHTML = '';
      clearViewer();
      updateInfo(); // "No models selected."
    } else {
      updateInfo();
      recalc();
    }
  };

  row.appendChild(thumb);
  row.appendChild(nameWrap);
  row.appendChild(settings);
  row.appendChild(qtyWrap);
  row.appendChild(priceCell);
  row.appendChild(rmv);
  el.fileList.appendChild(row);
}

/* ===================== RENDER MESH (applyOrientation) ===================== */
function renderMesh(geo) {
  if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
  mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0xff7a00, metalness: 0.05, roughness: 0.85 }) // orange
  );
  applyOrientation(mesh); // <- rotate according to ORIENT
  scene.add(mesh);

  const box = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  controls.target.copy(center);

  const dist = Math.max(size.x, size.y, size.z) * 2.2 + 10;
  camera.position.set(center.x + dist, center.y + dist, center.z + dist);
  camera.lookAt(center);
}

/* ===================== THUMBNAIL (clone + applyOrientation) ===================== */
async function makeThumbnail(geo) {
  const w = 140, h = 100;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  const scn = new THREE.Scene();
  scn.background = new THREE.Color(0xf3f4f6);

  const light1 = new THREE.DirectionalLight(0xffffff, 1.1); light1.position.set(1,1,1);
  const amb = new THREE.AmbientLight(0xffffff, 0.495);
  scn.add(light1, amb);

  const cam = new THREE.PerspectiveCamera(50, w/h, 0.1, 10000);

  const geoClone = geo.clone();
  const m = new THREE.Mesh(geoClone, new THREE.MeshStandardMaterial({ color: 0xff7a00, metalness: 0.05, roughness: 0.85 }));
  applyOrientation(m); // match viewport orientation
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
  m.geometry.dispose(); m.material.dispose(); r.dispose();
  return url;
}

/* ===================== CORE MATH ===================== */
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

function estimateForModel(m) {
  const mat = MATERIALS[m.material];

  // grams
  const grams_solid = (m.volume_mm3 / 1000) * mat.density_g_cm3;
  const fillFactor  = SHELL_BASE + INFILL_PORTION * (m.infill/100);
  const supportMass = (m.supports === 'yes') ? SUPPORT_MASS_MULT : 1.0;
  const gramsPerPart = grams_solid * fillFactor * supportMass * CALIBRATION_MULT + WASTE_GRAMS_PER_PART;
  const gramsTotal   = gramsPerPart * m.qty;

  // time
  const baseSpeed = QUALITY_SPEED[m.quality];
  const timeMult  = INFILL_TIME_MULT(m.infill) * SUPPORT_TIME_MULT(m.supports);
  const timeMinPerPart = (m.volume_mm3 / baseSpeed) * timeMult;
  const minutesTotal   = timeMinPerPart * m.qty;

  // costs (without small-order fee)
  const materialCost = gramsTotal * mat.rate;
  const printHours   = minutesTotal / 60;
  const printCost    = printHours * PRINT_RATE_PER_HOUR;

  return {
    gramsPerPart, gramsTotal,
    minutesTotal,
    materialCost, printCost,
    sub: materialCost + printCost,
    matBaseFee: mat.baseFee
  };
}

/* ===================== RECALC (auto) ===================== */
function recalc() {
  if (!models.length) {
    el.summary.innerHTML = '';
    el.grandTotal.innerHTML = '';
    el.download.disabled = true;
    updateInfo();
    clearViewer();
    return;
  }

  let grandGrams = 0;
  let grandMinutes = 0;
  let grandSubtotal = 0;
  let maxBaseFee = 0;
  const items = [];

  for (const m of models) {
    const est = estimateForModel(m);
    grandGrams   += est.gramsTotal;
    grandMinutes += est.minutesTotal;
    grandSubtotal += est.sub;
    maxBaseFee = Math.max(maxBaseFee, est.matBaseFee);

    const rowPrice = Math.ceil(est.sub); // per-item price (no small fee)
    const priceCell = document.getElementById(`price-${m.id}`);
    if (priceCell) priceCell.textContent = String(rowPrice);

    items.push({
      file: m.name,
      qty: m.qty,
      material: m.material,
      quality: m.quality,
      infill: m.infill,
      supports: m.supports,
      grams_total: round(est.gramsTotal,2),
      minutes_total: Math.round(est.minutesTotal),
      sub_total_thb: round(est.sub,2)
    });
  }

  // add prep time (once per job or per part)
  const totalParts = models.reduce((s,m)=>s+m.qty,0);
  grandMinutes += PREP_TIME_PER_JOB_MIN * (PREP_IS_PER_PART ? totalParts : 1);

  const grandHours = grandMinutes / 60;

  // apply small-order fee using HIGHEST baseFee among used materials
  const subtotal = grandSubtotal;
  let smallOrderFee;
  if (subtotal <= SMALL_FEE_THRESHOLD) {
    smallOrderFee = maxBaseFee;
  } else {
    const reduction = ((subtotal - SMALL_FEE_THRESHOLD) / SMALL_FEE_TAPER) * maxBaseFee;
    smallOrderFee = Math.max(maxBaseFee - reduction, 0);
  }

  const finalPrice = Math.ceil(subtotal + smallOrderFee);

  // UI summary
  el.summary.innerHTML = `
    <li><span>Models</span><strong>${models.length} file(s), ${totalParts} part(s)</strong></li>
    <li><span>Total used</span><strong>${round(grandGrams,2)} g</strong></li>
    <li><span>Total time</span><strong>${Math.floor(grandHours)} h ${Math.round((grandHours%1)*60)} m</strong></li>
    <li><span>Printing fee</span><strong>${round(subtotal, 2)} THB</strong></li>
    <li><span>Small order fee (max)</span><strong>${round(smallOrderFee, 2)} THB</strong></li>
  `;
  el.grandTotal.innerHTML = `<div class="total"><h2>Total price: ${finalPrice} THB</h2></div>`;
  el.download.disabled = false;

  el.download.onclick = () => {
    const payload = {
      totals: {
        files: models.length,
        parts: totalParts,
        grams: round(grandGrams,2),
        minutes: Math.round(grandMinutes),
        hours: Math.floor(grandHours),
        remMinutes: Math.round((grandHours%1)*60)
      },
      costs: {
        subtotal: round(subtotal,2),
        smallOrderFee: round(smallOrderFee,2),
        finalPrice
      },
      rule_smallFee_base: 'highest baseFee among selected filaments',
      items
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'quote.json'; a.click();
    URL.revokeObjectURL(url);
  };

  updateInfo();
}

/* ===================== HELPERS ===================== */
function updateInfo() {
  el.fileInfo.textContent = models.length ? `Total models: ${models.length}` : 'No models selected.';
}
function round(n,d){return Math.round(n*10**d)/10**d}
function clamp(v,min,max){return Math.max(min,Math.min(max,v))}


// after your element lookups:
const emptyMsg = document.getElementById('fileListEmpty');

// helper to toggle right-side placeholder
function toggleEmpty(hasFiles){
  if (emptyMsg) emptyMsg.style.display = hasFiles ? 'none' : 'block';
}

// when you finish adding files (inside addFiles):
if (added) {
  el.fileListWrap.style.display = 'block';
  document.getElementById('dropZone')?.style.setProperty('display','none'); // hide dropzone once used
  toggleEmpty(true);
  updateInfo();
  recalc();
}

// when removing the last file:
if (!models.length) {
  el.fileListWrap.style.display = 'none';
  toggleEmpty(false);
  // (optional) show dropzone again:
  document.getElementById('dropZone')?.style.removeProperty('display');
  // ...your existing reset code...
}

