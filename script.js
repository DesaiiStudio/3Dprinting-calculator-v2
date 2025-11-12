import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * CENTRAL CONFIG
 * All prices in THB
 */
const CONFIG = {
  currency: 'THB',
  // density in g/cm³, price per kg in THB
  materials: {
    PLA:  { density: 1.24, pricePerKg: 500 },
    ABS:  { density: 1.04, pricePerKg: 550 },
    PETG: { density: 1.27, pricePerKg: 520 }
  },
  defaultMaterial: 'PLA',
  gramsPerHour: 25,          // for time estimate
  machineRatePerHour: 25,    // THB/h
  electricityRatePerHour: 5, // THB/h
  minCharge: 60,             // THB
  margin: 1.25               // 25% markup
};

const dom = {
  dropZone: document.getElementById('dropZone'),
  fileInput: document.getElementById('stlFile'),
  fileListWrap: document.getElementById('fileListWrap'),
  fileListEmpty: document.getElementById('fileListEmpty'),
  fileList: document.getElementById('fileList'),
  summaryList: document.getElementById('summaryList'),
  grandTotal: document.getElementById('grandTotal'),
  downloadBtn: document.getElementById('downloadQuote'),
  addMoreBtn: document.getElementById('addMoreBtn'),
  fileInfo: document.getElementById('fileInfo'),
  viewerCanvas: document.getElementById('viewer'),
  // NEW: discount UI
  discountCode: document.getElementById('discountCode'),
  applyDiscount: document.getElementById('applyDiscount'),
  discountInfo: document.getElementById('discountInfo')
};

const state = {
  models: [],
  counter: 1,
  three: null
};

// Discount state
let discount = { code: '', rate: 0 };

// =========================
// 1. THREE.JS VIEWER SETUP
// =========================
function initViewer() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf6f7f9);

  const camera = new THREE.PerspectiveCamera(45, dom.viewerCanvas.clientWidth / dom.viewerCanvas.clientHeight, 0.1, 1000);
  camera.position.set(80, 80, 80);

  const renderer = new THREE.WebGLRenderer({ canvas: dom.viewerCanvas, antialias: true });
  renderer.setSize(dom.viewerCanvas.clientWidth, dom.viewerCanvas.clientHeight);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // light
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

  state.three = { scene, camera, renderer, controls };
}

function showGeometry(geometry) {
  if (!state.three) return;
  const { scene, camera, controls } = state.three;

  // clear old mesh
  scene.children = scene.children.filter(obj => !(obj.isMesh));

  const material = new THREE.MeshStandardMaterial({ color: 0x374151, metalness: 0.1, roughness: 0.7 });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // auto center & frame
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const center = new THREE.Vector3();
  box.getCenter(center);
  mesh.position.sub(center); // move to origin

  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);

  const fitDist = maxDim * 1.8;
  camera.position.set(fitDist, fitDist, fitDist);
  camera.lookAt(new THREE.Vector3(0, 0, 0));
  controls.target.set(0, 0, 0);
  controls.update();
}

// =========================
/* 2. STL → VOLUME → GRAMS */
// =========================

/**
 * IMPORTANT:
 * - STLLoader returns geometry in MILLIMETERS.
 * - Our volume calc returns in mm³.
 * - Density is in g/cm³.
 * - So we MUST:  cm³ = mm³ / 1000
 */
function computeVolumeMm3(geometry) {
  const pos = geometry.attributes.position;
  let volume = 0;
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const v3 = new THREE.Vector3();

  for (let i = 0; i < pos.count; i += 3) {
    v1.fromBufferAttribute(pos, i + 0);
    v2.fromBufferAttribute(pos, i + 1);
    v3.fromBufferAttribute(pos, i + 2);

    // signed volume of tetrahedron (0, v1, v2, v3)
    volume += v1.dot(v2.cross(v3)) / 6.0;
  }

  return Math.abs(volume); // mm³
}

function calcUsageFactor(infillPercent) {
  // simple model:
  // 25% base for walls/top/bottom + scaled infill
  const base = 0.25;
  const infillEff = 0.75;
  return base + (infillPercent / 100) * infillEff;
}

function calculatePricing({ volumeMm3, materialKey, infillPercent }) {
  const mat = CONFIG.materials[materialKey] || CONFIG.materials[CONFIG.defaultMaterial];
  const density = mat.density; // g/cm³

  const volumeCm3 = volumeMm3 / 1000;         // 🔐 convert mm³ → cm³
  const rawWeightG = volumeCm3 * density;     // fully solid
  const usageFactor = calcUsageFactor(infillPercent);
  const printWeightG = rawWeightG * usageFactor;

  // material cost
  const materialCost = (printWeightG / 1000) * mat.pricePerKg;

  // time & machine
  const printTimeHr = printWeightG / CONFIG.gramsPerHour;
  const machineCost = printTimeHr * CONFIG.machineRatePerHour;
  const elecCost = printTimeHr * CONFIG.electricityRatePerHour;

  let subtotal = materialCost + machineCost + elecCost;
  subtotal = subtotal * CONFIG.margin;

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

// =========================
// 3. DOM HELPERS
// =========================
function renderEmptyState(showEmpty) {
  dom.fileListEmpty.style.display = showEmpty ? 'block' : 'none';
  dom.fileListWrap.style.display = showEmpty ? 'none' : 'block';
}

function createModelRow(model) {
  const row = document.createElement('div');
  row.className = 'q-list-row';
  row.dataset.id = model.id;

  // material options
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
  const selMat = row.querySelector('.js-mat');
  const inpInfill = row.querySelector('.js-infill');
  const inpQty = row.querySelector('.js-qty');
  const btnRemove = row.querySelector('.js-remove');

  selMat.addEventListener('change', () => updateModelFromRow(model.id, row));
  inpInfill.addEventListener('input', () => updateModelFromRow(model.id, row));
  inpQty.addEventListener('input', () => updateModelFromRow(model.id, row));
  btnRemove.addEventListener('click', () => removeModel(model.id));

  return row;
}

function formatPrice(num) {
  return `${num.toFixed(0)} ${CONFIG.currency}`;
}

function updateModelFromRow(id, row) {
  const model = state.models.find(m => m.id === id);
  if (!model) return;

  const mat = row.querySelector('.js-mat').value;
  const infill = Number(row.querySelector('.js-infill').value) || 0;
  const qty = Math.max(1, Number(row.querySelector('.js-qty').value) || 1);

  const pricing = calculatePricing({
    volumeMm3: model.volumeMm3,
    materialKey: mat,
    infillPercent: infill
  });

  model.material = mat;
  model.infill = infill;
  model.qty = qty;
  model.volumeCm3 = pricing.volumeCm3;
  model.printWeightG = pricing.printWeightG;
  model.unitPrice = pricing.unitPrice;
  model.lineTotal = pricing.unitPrice * qty;

  row.querySelector('.q-file-meta').textContent =
    `${model.volumeCm3.toFixed(2)} cm³ • ${model.printWeightG.toFixed(1)} g`;
  row.querySelector('.js-price').textContent = formatPrice(model.lineTotal);

  renderSummary();
}

function removeModel(id) {
  state.models = state.models.filter(m => m.id !== id);
  const row = dom.fileList.querySelector(`.q-list-row[data-id="${id}"]`);
  if (row) row.remove();
  // reindex
  state.models.forEach((m, i) => {
    m.index = i + 1;
    const rowEl = dom.fileList.querySelector(`.q-list-row[data-id="${m.id}"] > div:first-child`);
    if (rowEl) rowEl.textContent = m.index;
  });
  renderSummary();
  if (state.models.length === 0) renderEmptyState(true);
}

// NEW: recompute totals with discount
function renderSummary() {
  dom.summaryList.innerHTML = '';
  let total = 0;
  state.models.forEach(m => {
    total += m.lineTotal;
    const li = document.createElement('li');
    li.className = 'q-summary-item';
    li.textContent = `${m.qty}× ${m.name} — ${formatPrice(m.lineTotal)}`;
    dom.summaryList.appendChild(li);
  });

  if (state.models.length === 0) {
    dom.grandTotal.textContent = 'No items';
    dom.downloadBtn.disabled = true;
    dom.discountInfo.textContent = '';
    return;
  }

  let finalTotal = total;
  dom.discountInfo.textContent = '';

  if (discount.rate > 0) {
    const discountAmt = total * discount.rate;
    finalTotal = total - discountAmt;
    dom.discountInfo.textContent =
      `Total before discount: ${formatPrice(total)} • Discount (${Math.round(discount.rate*100)}%): −${formatPrice(discountAmt)}`;
  }

  dom.grandTotal.textContent = `Total: ${formatPrice(finalTotal)}`;
  dom.downloadBtn.disabled = false;
}

// =========================
// 4. FILE HANDLING
// =========================
function handleFiles(fileList) {
  const loader = new STLLoader();
  Array.from(fileList).forEach(file => {
    const reader = new FileReader();
    reader.onload = e => {
      const arrayBuffer = e.target.result;
      const geometry = loader.parse(arrayBuffer);
      geometry.computeVertexNormals();

      const volumeMm3 = computeVolumeMm3(geometry);

      const pricing = calculatePricing({
        volumeMm3,
        materialKey: CONFIG.defaultMaterial,
        infillPercent: 20
      });

      const model = {
        id: crypto.randomUUID ? crypto.randomUUID() : `m-${Date.now()}-${Math.random()}`,
        index: state.models.length + 1,
        name: file.name,
        volumeMm3,
        volumeCm3: pricing.volumeCm3,
        printWeightG: pricing.printWeightG,
        material: CONFIG.defaultMaterial,
        infill: 20,
        layerHeight: 0.2,
        qty: 1,
        unitPrice: pricing.unitPrice,
        lineTotal: pricing.unitPrice * 1
      };

      state.models.push(model);
      const row = createModelRow(model);
      dom.fileList.appendChild(row);
      renderEmptyState(false);
      renderSummary();
      showGeometry(geometry);

      dom.fileInfo.textContent = `Loaded ${file.name} • ${model.volumeCm3.toFixed(2)} cm³ • ${model.printWeightG.toFixed(1)} g`;
    };
    reader.readAsArrayBuffer(file);
  });
}

function setupDnD() {
  dom.dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dom.dropZone.classList.add('is-dragover');
  });
  dom.dropZone.addEventListener('dragleave', e => {
    dom.dropZone.classList.remove('is-dragover');
  });
  dom.dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dom.dropZone.classList.remove('is-dragover');
    if (e.dataTransfer.files.length) {
      handleFiles(e.dataTransfer.files);
    }
  });
  dom.fileInput.addEventListener('change', e => {
    if (e.target.files.length) handleFiles(e.target.files);
  });
  dom.addMoreBtn?.addEventListener('click', () => dom.fileInput.click());
}

// =========================
// 5. DISCOUNT
// =========================
function applyDiscount() {
  const code = (dom.discountCode?.value || '').trim().toLowerCase();
  if (code === 'desaiiadmin15'.toLowerCase()) {
    discount = { code: 'DesaiiAdmin15', rate: 0.15 };
    // show a small confirmation inline; the detailed math appears in discountInfo
    if (dom.discountInfo) dom.discountInfo.textContent = '✅ Discount applied: 15% off';
  } else if (code.length === 0) {
    discount = { code: '', rate: 0 };
    if (dom.discountInfo) dom.discountInfo.textContent = '';
  } else {
    discount = { code: '', rate: 0 };
    if (dom.discountInfo) dom.discountInfo.textContent = '❌ Invalid code';
  }
  renderSummary();
}

// =========================
/* 6. DOWNLOAD JSON */
// =========================
function setupDownload() {
  dom.downloadBtn.addEventListener('click', () => {
    const subtotal = state.models.reduce((s, m) => s + m.lineTotal, 0);
    const total_after_discount = subtotal * (1 - discount.rate);

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
      subtotal,
      discount_code: discount.code || null,
      discount_rate: discount.rate,
      total_after_discount
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

// =========================
// INIT
// =========================
initViewer();
setupDnD();
setupDownload();
renderEmptyState(true);

// hook discount button
dom.applyDiscount?.addEventListener('click', applyDiscount);
