// script.js
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* =========================================================
 * 1. GLOBAL CONFIGURATION
 * ======================================================= */
const CONFIG = Object.freeze({
  currency: 'THB',
  materials: {
    PLA:  { density: 1.24, pricePerKg: 500 },
    ABS:  { density: 1.04, pricePerKg: 550 },
    PETG: { density: 1.27, pricePerKg: 520 }
  },
  defaultMaterial: 'PLA',
  gramsPerHour: 25,          // printing speed
  machineRatePerHour: 25,    // THB/h
  electricityRatePerHour: 5, // THB/h
  minCharge: 60,             // minimum per line
  margin: 1.25               // 25% markup
});

/* =========================================================
 * 2. DOM REFERENCES
 * ======================================================= */
const dom = {
  dropZone:      document.getElementById('dropZone'),
  fileInput:     document.getElementById('stlFile'),
  fileListWrap:  document.getElementById('fileListWrap'),
  fileListEmpty: document.getElementById('fileListEmpty'),
  fileList:      document.getElementById('fileList'),
  summaryList:   document.getElementById('summaryList'),
  grandTotal:    document.getElementById('grandTotal'),
  downloadBtn:   document.getElementById('downloadQuote'),
  addMoreBtn:    document.getElementById('addMoreBtn'),
  fileInfo:      document.getElementById('fileInfo'),
  viewerCanvas:  document.getElementById('viewer')
};

/* =========================================================
 * 3. APP STATE
 * ======================================================= */
const state = {
  models: [],           // [{ id, name, volumeMm3, volumeCm3, printWeightG, material, infill, layerHeight, qty, unitPrice, lineTotal }]
  three: null,          // { scene, camera, renderer, controls, activeMesh }
  loader: null          // STLLoader (reused)
};

/* =========================================================
 * 4. VIEWER SETUP
 * ======================================================= */
function initViewer() {
  if (!dom.viewerCanvas) return;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf6f7f9);

  const aspect = dom.viewerCanvas.clientWidth / dom.viewerCanvas.clientHeight;
  const camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
  camera.position.set(80, 80, 80);

  const renderer = new THREE.WebGLRenderer({
    canvas: dom.viewerCanvas,
    antialias: true
  });
  renderer.setSize(dom.viewerCanvas.clientWidth, dom.viewerCanvas.clientHeight);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  hemi.position.set(0, 200, 0);
  scene.add(hemi);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
  dirLight.position.set(80, 80, 80);
  scene.add(dirLight);

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  state.three = { scene, camera, renderer, controls, activeMesh: null };
}

function showGeometry(geometry) {
  if (!state.three) return;

  const { scene, camera, controls } = state.three;

  // remove old mesh only (don't wipe lights)
  if (state.three.activeMesh) {
    scene.remove(state.three.activeMesh);
    state.three.activeMesh.geometry.dispose();
    state.three.activeMesh.material.dispose();
    state.three.activeMesh = null;
  }

  const material = new THREE.MeshStandardMaterial({
    color: 0x374151,
    metalness: 0.1,
    roughness: 0.7
  });

  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  state.three.activeMesh = mesh;

  // center + frame
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const center = new THREE.Vector3();
  box.getCenter(center);
  mesh.position.sub(center);

  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  const fitDist = maxDim * 1.8;

  camera.position.set(fitDist, fitDist, fitDist);
  camera.lookAt(new THREE.Vector3(0, 0, 0));
  controls.target.set(0, 0, 0);
  controls.update();
}

/* =========================================================
 * 5. PRICING / GEOMETRY HELPERS
 * ======================================================= */
/**
 * STL is in millimeters.
 * We compute volume in mm³, then convert → cm³.
 */
function computeVolumeMm3(geometry) {
  const pos = geometry.attributes.position;
  let volume = 0;

  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();

  for (let i = 0; i < pos.count; i += 3) {
    v1.fromBufferAttribute(pos, i);
    v2.fromBufferAttribute(pos, i + 1);
    v3.fromBufferAttribute(pos, i + 2);

    // signed volume of tetra (0, v1, v2, v3)
    volume += v1.dot(v2.cross(v3)) / 6.0;
  }

  return Math.abs(volume); // mm³
}

function calcUsageFactor(infillPercent) {
  // 25% always used for shell/walls + infill portion
  const base = 0.25;
  const infillEff = 0.75;
  return base + (infillPercent / 100) * infillEff;
}

function calculatePricing({ volumeMm3, materialKey, infillPercent }) {
  const material = CONFIG.materials[materialKey] || CONFIG.materials[CONFIG.defaultMaterial];
  const density = material.density; // g/cm³

  const volumeCm3 = volumeMm3 / 1000;             // mm³ → cm³
  const rawWeightG = volumeCm3 * density;         // solid
  const usageFactor = calcUsageFactor(infillPercent);
  const printWeightG = rawWeightG * usageFactor;  // actual printed weight

  const printTimeHr = printWeightG / CONFIG.gramsPerHour;
  const materialCost = (printWeightG / 1000) * material.pricePerKg;
  const machineCost  = printTimeHr * CONFIG.machineRatePerHour;
  const elecCost     = printTimeHr * CONFIG.electricityRatePerHour;

  let subtotal = materialCost + machineCost + elecCost;
  subtotal *= CONFIG.margin;

  const unitPrice = Math.max(CONFIG.minCharge, subtotal);

  return {
    volumeCm3,
    rawWeightG,
    printWeightG,
    materialCost,
    machineCost,
    elecCost,
    unitPrice,
    printTimeHr
  };
}

/* =========================================================
 * 6. DOM HELPERS
 * ======================================================= */
function formatPrice(num) {
  return `${num.toFixed(0)} ${CONFIG.currency}`;
}

function renderEmptyState(show) {
  dom.fileListEmpty.style.display = show ? 'block' : 'none';
  dom.fileListWrap.style.display  = show ? 'none' : 'block';
}

function buildMaterialOptions(current) {
  return Object.keys(CONFIG.materials)
    .map(k => `<option value="${k}" ${k === current ? 'selected' : ''}>${k}</option>`)
    .join('');
}

function createModelRow(model) {
  const row = document.createElement('div');
  row.className = 'q-list-row';
  row.dataset.id = model.id;

  row.innerHTML = `
    <div>${model.index}</div>
    <div>
      <div class="q-file-name">${model.name}</div>
      <div class="q-file-meta">${model.volumeCm3.toFixed(2)} cm³ • ${model.printWeightG.toFixed(1)} g</div>
    </div>
    <div class="q-file-details">
      <label>Mat
        <select class="js-mat">
          ${buildMaterialOptions(model.material)}
        </select>
      </label>
      <label>Infill
        <input type="number" class="js-infill" min="0" max="100" step="5" value="${model.infill}">
      </label>
      <label>Layer
        <input type="number" class="js-layer" min="0.08" max="0.4" step="0.02" value="${model.layerHeight}">
      </label>
    </div>
    <div>
      <input type="number" class="js-qty" min="1" value="${model.qty}" style="width:60px;">
    </div>
    <div class="q-price-cell">
      <span class="js-price">${formatPrice(model.lineTotal)}</span>
    </div>
    <div>
      <button class="q-btn q-btn--ghost js-remove" aria-label="Remove model">×</button>
    </div>
  `;

  // hook events
  row.querySelector('.js-mat').addEventListener('change', () => updateModelFromRow(model.id, row));
  row.querySelector('.js-infill').addEventListener('input', () => updateModelFromRow(model.id, row));
  row.querySelector('.js-qty').addEventListener('input', () => updateModelFromRow(model.id, row));
  row.querySelector('.js-remove').addEventListener('click', () => removeModel(model.id));

  return row;
}

/* =========================================================
 * 7. MODEL MUTATIONS
 * ======================================================= */
function addModelFromGeometry({ fileName, geometry, baseInfill = 20 }) {
  const volumeMm3 = computeVolumeMm3(geometry);
  const pricing = calculatePricing({
    volumeMm3,
    materialKey: CONFIG.defaultMaterial,
    infillPercent: baseInfill
  });

  const model = {
    id: crypto.randomUUID ? crypto.randomUUID() : `m-${Date.now()}-${Math.random()}`,
    index: state.models.length + 1,
    name: fileName,
    volumeMm3,
    volumeCm3: pricing.volumeCm3,
    printWeightG: pricing.printWeightG,
    material: CONFIG.defaultMaterial,
    infill: baseInfill,
    layerHeight: 0.2,
    qty: 1,
    unitPrice: pricing.unitPrice,
    lineTotal: pricing.unitPrice
  };

  state.models.push(model);

  // UI
  const row = createModelRow(model);
  dom.fileList.appendChild(row);
  renderEmptyState(false);
  renderSummary();

  // viewer
  showGeometry(geometry);

  // info text
  dom.fileInfo.textContent = `Loaded ${fileName} • ${model.volumeCm3.toFixed(2)} cm³ • ${model.printWeightG.toFixed(1)} g`;
}

function updateModelFromRow(id, row) {
  const model = state.models.find(m => m.id === id);
  if (!model) return;

  const mat   = row.querySelector('.js-mat').value;
  const infill = clamp(Number(row.querySelector('.js-infill').value) || 0, 0, 100);
  const qty    = Math.max(1, Number(row.querySelector('.js-qty').value) || 1);

  const pricing = calculatePricing({
    volumeMm3: model.volumeMm3,
    materialKey: mat,
    infillPercent: infill
  });

  model.material     = mat;
  model.infill       = infill;
  model.qty          = qty;
  model.volumeCm3    = pricing.volumeCm3;
  model.printWeightG = pricing.printWeightG;
  model.unitPrice    = pricing.unitPrice;
  model.lineTotal    = pricing.unitPrice * qty;

  // reflect to DOM
  row.querySelector('.q-file-meta').textContent =
    `${model.volumeCm3.toFixed(2)} cm³ • ${model.printWeightG.toFixed(1)} g`;
  row.querySelector('.js-price').textContent = formatPrice(model.lineTotal);

  renderSummary();
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

function removeModel(id) {
  state.models = state.models.filter(m => m.id !== id);

  const row = dom.fileList.querySelector(`.q-list-row[data-id="${id}"]`);
  if (row) row.remove();

  // reindex visible rows
  state.models.forEach((m, i) => {
    m.index = i + 1;
    const cell = dom.fileList.querySelector(`.q-list-row[data-id="${m.id}"] > div:first-child`);
    if (cell) cell.textContent = m.index;
  });

  renderSummary();
  if (state.models.length === 0) renderEmptyState(true);
}

/* =========================================================
 * 8. SUMMARY
 * ======================================================= */
function renderSummary() {
  dom.summaryList.innerHTML = '';

  let total = 0;
  for (const m of state.models) {
    total += m.lineTotal;
    const li = document.createElement('li');
    li.className = 'q-summary-item';
    li.textContent = `${m.qty}× ${m.name} — ${formatPrice(m.lineTotal)}`;
    dom.summaryList.appendChild(li);
  }

  dom.grandTotal.textContent = state.models.length
    ? `Total: ${formatPrice(total)}`
    : 'No items';

  dom.downloadBtn.disabled = state.models.length === 0;
}

/* =========================================================
 * 9. FILE HANDLING
 * ======================================================= */
function handleFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;

  if (!state.loader) {
    state.loader = new STLLoader();
  }

  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const geometry = state.loader.parse(e.target.result);
        geometry.computeVertexNormals();
        addModelFromGeometry({ fileName: file.name, geometry });
      } catch (err) {
        console.error('Failed to load STL:', err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

function setupDnD() {
  if (!dom.dropZone) return;

  dom.dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dom.dropZone.classList.add('is-dragover');
  });

  dom.dropZone.addEventListener('dragleave', () => {
    dom.dropZone.classList.remove('is-dragover');
  });

  dom.dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dom.dropZone.classList.remove('is-dragover');
    const files = e.dataTransfer.files;
    if (files && files.length) {
      handleFiles(files);
    }
  });

  dom.fileInput.addEventListener('change', e => {
    if (e.target.files && e.target.files.length) {
      handleFiles(e.target.files);
    }
  });

  if (dom.addMoreBtn) {
    dom.addMoreBtn.addEventListener('click', () => dom.fileInput.click());
  }
}

/* =========================================================
 * 10. DOWNLOAD
 * ======================================================= */
function setupDownload() {
  if (!dom.downloadBtn) return;

  dom.downloadBtn.addEventListener('click', () => {
    const payload = {
      date: new Date().toISOString().slice(0, 10),
      currency: CONFIG.currency,
      items: state.models.map(m => ({
        name: m.name,
        volume_mm3: m.volumeMm3,
        volume_cm3: m.volumeCm3,
        weight_g: m.printWeightG,
        material: m.material,
        infill: m.infill,
        qty: m.qty,
        unit_price: m.unitPrice,
        line_total: m.lineTotal
      })),
      subtotal: state.models.reduce((s, m) => s + m.lineTotal, 0)
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `quote-${payload.date}.json`;
    a.click();

    URL.revokeObjectURL(url);
  });
}

/* =========================================================
 * 11. INIT
 * ======================================================= */
function init() {
  initViewer();
  setupDnD();
  setupDownload();
  renderEmptyState(true);
}

init();
