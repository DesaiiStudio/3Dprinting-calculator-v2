// script.js
// ==========================
// 0. CONFIG
// ==========================
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const CONFIG = {
  currency: 'THB',
  // density in g/cm³, price per kg in THB
  materials: {
    PLA:  { density: 1.24, pricePerKg: 500 },
    ABS:  { density: 1.04, pricePerKg: 550 },
    PETG: { density: 1.27, pricePerKg: 520 }
  },
  defaultMaterial: 'PLA',
  gramsPerHour: 25,          // g/h, for time estimate
  machineRatePerHour: 25,    // THB/h
  electricityRatePerHour: 5, // THB/h
  minCharge: 60,             // ✅ hard minimum
  margin: 1.25               // 25% markup
};

// ==========================
// 1. DOM CACHE
// ==========================
const DOM = {
  dropZone:       document.getElementById('dropZone'),
  fileInput:      document.getElementById('stlFile'),
  fileListWrap:   document.getElementById('fileListWrap'),
  fileListEmpty:  document.getElementById('fileListEmpty'),
  fileList:       document.getElementById('fileList'),
  summaryList:    document.getElementById('summaryList'),
  grandTotal:     document.getElementById('grandTotal'),
  downloadBtn:    document.getElementById('downloadQuote'),
  addMoreBtn:     document.getElementById('addMoreBtn'),
  fileInfo:       document.getElementById('fileInfo'),
  viewerCanvas:   document.getElementById('viewer')
};

// ==========================
// 2. STATE
// ==========================
const STATE = {
  models: [],
  three: null
};

// ==========================
// 3. INIT
// ==========================
initViewer();
initDnD();
initDownload();
renderEmptyState(true);

// ==========================
// 4. VIEWER (THREE.JS)
// ==========================
function initViewer() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf6f7f9);

  const w = DOM.viewerCanvas.clientWidth;
  const h = DOM.viewerCanvas.clientHeight;
  const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
  camera.position.set(80, 80, 80);

  const renderer = new THREE.WebGLRenderer({ canvas: DOM.viewerCanvas, antialias: true });
  renderer.setSize(w, h);

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

  STATE.three = { scene, camera, renderer, controls };
}

function showGeometry(geometry) {
  if (!STATE.three) return;
  const { scene, camera, controls } = STATE.three;

  // remove old mesh
  scene.children = scene.children.filter(obj => !obj.isMesh);

  const mat = new THREE.MeshStandardMaterial({
    color: 0x374151,
    metalness: 0.1,
    roughness: 0.7
  });
  const mesh = new THREE.Mesh(geometry, mat);
  scene.add(mesh);

  // center
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const center = new THREE.Vector3();
  box.getCenter(center);
  mesh.position.sub(center);

  // frame
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  const dist = maxDim * 1.8;

  camera.position.set(dist, dist, dist);
  camera.lookAt(0, 0, 0);

  controls.target.set(0, 0, 0);
  controls.update();
}

// ==========================
// 5. PRICING (NO LOGIC CHANGE)
// ==========================
function computeVolumeMm3(geometry) {
  // STL → mm → mm³
  const pos = geometry.attributes.position;
  let volume = 0;
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();

  for (let i = 0; i < pos.count; i += 3) {
    v1.fromBufferAttribute(pos, i);
    v2.fromBufferAttribute(pos, i + 1);
    v3.fromBufferAttribute(pos, i + 2);
    volume += v1.dot(v2.cross(v3)) / 6;
  }
  return Math.abs(volume); // mm³
}

function calcUsageFactor(infillPercent) {
  // same as your original
  const base = 0.25;
  const infillEff = 0.75;
  return base + (infillPercent / 100) * infillEff;
}

function calculatePricing({ volumeMm3, materialKey, infillPercent }) {
  const mat = CONFIG.materials[materialKey] || CONFIG.materials[CONFIG.defaultMaterial];

  // 1) mm³ → cm³
  const volumeCm3 = volumeMm3 / 1000;
  // 2) solid grams
  const rawWeightG = volumeCm3 * mat.density;
  // 3) apply walls + infill factor
  const usageFactor = calcUsageFactor(infillPercent);
  const printWeightG = rawWeightG * usageFactor;

  // material
  const materialCost = (printWeightG / 1000) * mat.pricePerKg;

  // time-based
  const printTimeHr = printWeightG / CONFIG.gramsPerHour;
  const machineCost = printTimeHr * CONFIG.machineRatePerHour;
  const elecCost = printTimeHr * CONFIG.electricityRatePerHour;

  // subtotal + margin (NO CHANGE)
  let subtotal = materialCost + machineCost + elecCost;
  subtotal = subtotal * CONFIG.margin;

  // HARD MINIMUM (this is the small-fee behavior you currently have)
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

// ==========================
// 6. UI HELPERS
// ==========================
function renderEmptyState(show) {
  DOM.fileListEmpty.style.display = show ? 'block' : 'none';
  DOM.fileListWrap.style.display = show ? 'none' : 'block';
}

function formatPrice(num) {
  return `${num.toFixed(0)} ${CONFIG.currency}`;
}

function renderSummary() {
  DOM.summaryList.innerHTML = '';
  let total = 0;

  STATE.models.forEach(m => {
    total += m.lineTotal;
    const li = document.createElement('li');
    li.className = 'q-summary-item';
    li.textContent = `${m.qty}× ${m.name} — ${formatPrice(m.lineTotal)}`;
    DOM.summaryList.appendChild(li);
  });

  DOM.grandTotal.textContent = STATE.models.length
    ? `Total: ${formatPrice(total)}`
    : 'No items';

  DOM.downloadBtn.disabled = STATE.models.length === 0;
}

function createModelRow(model) {
  const row = document.createElement('div');
  row.className = 'q-list-row';
  row.dataset.id = model.id;

  const materialOptions = Object.keys(CONFIG.materials)
    .map(k => `<option value="${k}" ${k === model.material ? 'selected' : ''}>${k}</option>`)
    .join('');

  row.innerHTML = `
    <div>${model.index}</div>
    <div>
      <div class="q-file-name">${model.name}</div>
      <div class="q-file-meta">${model.volumeCm3.toFixed(2)} cm³ • ${model.printWeightG.toFixed(1)} g</div>
    </div>
    <div class="q-file-details">
      <label>Mat
        <select class="js-mat">${materialOptions}</select>
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
      <button class="q-btn q-btn--ghost js-remove">×</button>
    </div>
  `;

  // events
  row.querySelector('.js-mat').addEventListener('change', () => updateModelFromRow(model.id, row));
  row.querySelector('.js-infill').addEventListener('input', () => updateModelFromRow(model.id, row));
  row.querySelector('.js-qty').addEventListener('input', () => updateModelFromRow(model.id, row));
  row.querySelector('.js-remove').addEventListener('click', () => removeModel(model.id));

  return row;
}

function updateModelFromRow(id, row) {
  const model = STATE.models.find(m => m.id === id);
  if (!model) return;

  const mat = row.querySelector('.js-mat').value;
  const infill = Number(row.querySelector('.js-infill').value) || 0;
  const qty = Math.max(1, Number(row.querySelector('.js-qty').value) || 1);

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

  row.querySelector('.q-file-meta').textContent =
    `${model.volumeCm3.toFixed(2)} cm³ • ${model.printWeightG.toFixed(1)} g`;
  row.querySelector('.js-price').textContent = formatPrice(model.lineTotal);

  renderSummary();
}

function removeModel(id) {
  STATE.models = STATE.models.filter(m => m.id !== id);
  const row = DOM.fileList.querySelector(`.q-list-row[data-id="${id}"]`);
  if (row) row.remove();

  // reindex
  STATE.models.forEach((m, i) => {
    m.index = i + 1;
    const cell = DOM.fileList.querySelector(`.q-list-row[data-id="${m.id}"] > div:first-child`);
    if (cell) cell.textContent = m.index;
  });

  renderSummary();
  if (STATE.models.length === 0) renderEmptyState(true);
}

// ==========================
// 7. FILE HANDLING
// ==========================
function handleFiles(fileList) {
  const loader = new STLLoader();

  Array.from(fileList).forEach(file => {
    const reader = new FileReader();
    reader.onload = e => {
      const geometry = loader.parse(e.target.result);
      geometry.computeVertexNormals();

      const volumeMm3 = computeVolumeMm3(geometry);
      const pricing = calculatePricing({
        volumeMm3,
        materialKey: CONFIG.defaultMaterial,
        infillPercent: 20
      });

      const model = {
        id: crypto.randomUUID ? crypto.randomUUID() : `m-${Date.now()}-${Math.random()}`,
        index: STATE.models.length + 1,
        name: file.name,
        volumeMm3,
        volumeCm3: pricing.volumeCm3,
        printWeightG: pricing.printWeightG,
        material: CONFIG.defaultMaterial,
        infill: 20,
        layerHeight: 0.2,
        qty: 1,
        unitPrice: pricing.unitPrice,
        lineTotal: pricing.unitPrice
      };

      STATE.models.push(model);
      DOM.fileList.appendChild(createModelRow(model));
      renderEmptyState(false);
      renderSummary();
      showGeometry(geometry);

      DOM.fileInfo.textContent =
        `Loaded ${file.name} • ${model.volumeCm3.toFixed(2)} cm³ • ${model.printWeightG.toFixed(1)} g`;
    };
    reader.readAsArrayBuffer(file);
  });
}

function initDnD() {
  // drop
  DOM.dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    DOM.dropZone.classList.add('is-dragover');
  });
  DOM.dropZone.addEventListener('dragleave', () => {
    DOM.dropZone.classList.remove('is-dragover');
  });
  DOM.dropZone.addEventListener('drop', e => {
    e.preventDefault();
    DOM.dropZone.classList.remove('is-dragover');
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  // input
  DOM.fileInput.addEventListener('change', e => {
    if (e.target.files.length) handleFiles(e.target.files);
  });

  // add more
  DOM.addMoreBtn.addEventListener('click', () => DOM.fileInput.click());
}

// ==========================
// 8. DOWNLOAD
// ==========================
function initDownload() {
  DOM.downloadBtn.addEventListener('click', () => {
    const payload = {
      date: new Date().toISOString().slice(0, 10),
      currency: CONFIG.currency,
      items: STATE.models.map(m => ({
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
      subtotal: STATE.models.reduce((sum, m) => sum + m.lineTotal, 0)
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
