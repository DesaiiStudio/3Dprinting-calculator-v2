// Ensure DOM loaded before attaching listeners
window.addEventListener('DOMContentLoaded', () => {

/* ========= Config (you can tweak freely) ========= */
const MATERIALS = {
  "PLA":     { density_g_cm3: 1.24, cost_per_kg_thb: 450 },
  "PETG":    { density_g_cm3: 1.27, cost_per_kg_thb: 500 },
  "PETG-CF": { density_g_cm3: 1.30, cost_per_kg_thb: 750 }
};

const QUALITY_SPEED = { draft:600, standard:420, fine:260 };
const SUPPORT_TIME_MULTIPLIER = { yes: 1.15, no: 1.0 };
const INFILL_TIME_MULTIPLIER = (infillPct) => 0.85 + (infillPct/100)*0.6;

/* ========= Elements ========= */
const fileInput = document.getElementById('stlFile');
const fileInfo  = document.getElementById('fileInfo');
const calcBtn   = document.getElementById('calcBtn');
const metricsEl = document.getElementById('metrics');
const breakdownEl = document.getElementById('breakdown');
const totalEl   = document.getElementById('total');
const downloadBtn = document.getElementById('downloadQuote');

const materialSel = document.getElementById('material');
const qualitySel  = document.getElementById('quality');
const infillInp   = document.getElementById('infill');
const supportsSel = document.getElementById('supports');
const qtyInp      = document.getElementById('qty');

const baseFeeInp   = document.getElementById('baseFee');
const machHrInp    = document.getElementById('machHr');
const ppFeeInp     = document.getElementById('ppFee');
const minThreshInp = document.getElementById('minThresh');
const marginInp    = document.getElementById('margin');
const vatInp       = document.getElementById('vat');

/* ========= Three.js viewer ========= */
let renderer, scene, camera, controls, mesh;
if (window.THREE && THREE.WebGLRenderer) {
  initViewer();
} else {
  console.warn("THREE not loaded; viewer disabled.");
}

function initViewer() {
  const canvas = document.getElementById('viewer');
  if (!canvas) return;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  resizeRenderer();
  window.addEventListener('resize', resizeRenderer);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f1115);

  const light1 = new THREE.DirectionalLight(0xffffff, 1.0);
  light1.position.set(1,1,1);
  scene.add(light1);
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));

  camera = new THREE.PerspectiveCamera(50, canvas.clientWidth / canvas.clientHeight, 0.1, 10000);
  camera.position.set(120, 120, 120);

  if (THREE.OrbitControls) {
    controls = new THREE.OrbitControls(camera, canvas);
    controls.enableDamping = true;
  }

  animate();
}
function resizeRenderer() {
  if (!renderer) return;
  const canvas = renderer.domElement;
  const parent = canvas.parentElement || document.body;
  const w = parent.clientWidth || 600;
  const h = Math.max(300, Math.floor(w * 0.55));
  renderer.setSize(w, h, false);
  if (camera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
function animate() {
  if (!renderer || !scene || !camera) return;
  requestAnimationFrame(animate);
  if (controls && controls.update) controls.update();
  renderer.render(scene, camera);
}

/* ========= STL load & measure ========= */
let currentMetrics = null;

fileInput?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  resetOutputs();
  if (!file) return;

  if (!file.name.toLowerCase().endsWith(".stl")) {
    fileInfo.textContent = "Please choose a .stl file.";
    return;
  }
  fileInfo.textContent = `Selected: ${file.name} (${(file.size/1024/1024).toFixed(2)} MB)`;

  try {
    const arrayBuffer = await file.arrayBuffer();
    if (!window.THREE || !THREE.STLLoader) throw new Error("STLLoader missing");

    const loader = new THREE.STLLoader();
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
    if (scene) renderMesh(geo);
    showMetrics(currentMetrics);
    calcBtn.disabled = false;
  } catch (err) {
    console.error(err);
    fileInfo.textContent = "Could not parse STL (libs not loaded or file invalid).";
    calcBtn.disabled = true;
  }
});

function renderMesh(geo) {
  if (mesh) scene.remove(mesh);
  const mat = new THREE.MeshStandardMaterial({ color: 0x5ad, metalness: 0.1, roughness: 0.8 });
  mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);

  const box = new THREE.Box3().setFromObject(mesh);
  const center = new THREE.Vector3();
  box.getCenter(center);
  if (controls && controls.target) controls.target.copy(center);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  const dist = maxDim * 2.2;
  if (camera) {
    camera.position.set(center.x + dist, center.y + dist, center.z + dist);
    camera.lookAt(center);
  }
}

function computeVolume(bufferGeo) {
  const pos = bufferGeo.attributes.position.array;
  let vol = 0.0;
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i], ay = pos[i+1], az = pos[i+2];
    const bx = pos[i+3], by = pos[i+4], bz = pos[i+5];
    const cx = pos[i+6], cy = pos[i+7], cz = pos[i+8];
    vol += (ax*by*cz + bx*cy*az + cx*ay*bz - ax*cy*bz - bx*ay*cz - cx*by*az);
  }
  return Math.abs(vol) / 6.0;
}

function calculatePrice(metrics) {
  const mat = MATERIALS[materialSel.value];
  const qualityKey = qualitySel.value;
  const infillPct = clamp(Number(infillInp.value), 0, 100);
  const supports = supportsSel.value;
  const qty = Math.max(1, Number(qtyInp.value));

  const baseFee = Number(baseFeeInp.value);
  const machine_hr_thb = Number(machHrInp.value);
  const pp_fee = Number(ppFeeInp.value);
  const min_order = Number(minThreshInp.value);
  const margin_pct = Number(marginInp.value);
  const vat_pct = Number(vatInp.value);

  const mass_g = (metrics.volume_mm3 / 1000) * mat.density_g_cm3;
  const material_cost = (mass_g / 1000) * mat.cost_per_kg_thb;

  const base_speed = QUALITY_SPEED[qualityKey];
  const time_mult = SUPPORT_TIME_MULTIPLIER[supports] * INFILL_TIME_MULTIPLIER(infillPct);
  const est_time_min = (metrics.volume_mm3 / base_speed) * time_mult;

  const machine_cost = (est_time_min / 60) * machine_hr_thb;
  const ops_fee = pp_fee;

  let subtotal = baseFee + material_cost + machine_cost + ops_fee;
  if (subtotal < min_order) subtotal = min_order;

  const with_margin = subtotal * (1 + margin_pct/100);
  const with_vat = with_margin * (1 + vat_pct/100);

  const per_part_total = with_vat;
  const grand_total = per_part_total * qty;

  return {
    inputs: { material: materialSel.value, quality: qualityKey, infill_pct: infillPct, supports },
    metrics: { volume_mm3: round(metrics.volume_mm3, 0), bbox_mm: metrics.bbox, mass_g: round(mass_g, 2), est_time_min: round(est_time_min, 1) },
    costs: { base_fee: round(baseFee, 2), material_cost: round(material_cost, 2), machine_cost: round(machine_cost, 2), post_process_fee: round(ops_fee, 2), subtotal_after_min_threshold: round(subtotal, 2) },
    totals: { per_part_total: round(per_part_total, 2), grand_total: round(grand_total, 2), quantity: qty }
  };
}

function showMetrics(m) {
  metricsEl.innerHTML = `<p><strong>Volume:</strong> ${round(m.volume_mm3/1000,2)} cm³</p><p><strong>Bounding box (mm):</strong> ${round(m.bbox.x,2)} × ${round(m.bbox.y,2)} × ${round(m.bbox.z,2)}</p>`;
}
function showBreakdown(bd) {
  breakdownEl.innerHTML = `<h4>Inputs</h4><pre>${JSON.stringify(bd.inputs, null, 2)}</pre><h4>Metrics</h4><pre>${JSON.stringify(bd.metrics, null, 2)}</pre><h4>Costs</h4><pre>${JSON.stringify(bd.costs, null, 2)}</pre>`;
  totalEl.innerHTML = `<h3>Total: ${bd.totals.grand_total.toFixed(2)} THB</h3>`;
}

calcBtn?.addEventListener('click', () => {
  if (!currentMetrics) return;
  const bd = calculatePrice(currentMetrics);
  showBreakdown(bd);
  downloadBtn.disabled = false;
  downloadBtn.onclick = () => {
    const blob = new Blob([JSON.stringify(bd, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'quote.json';
    a.click();
    URL.revokeObjectURL(url);
  };
});

function round(num, dec) { return Math.round(num * Math.pow(10, dec)) / Math.pow(10, dec); }
function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }
function resetOutputs() { metricsEl.innerHTML = ""; breakdownEl.innerHTML = ""; totalEl.innerHTML = ""; calcBtn.disabled = true; downloadBtn.disabled = true; }

}); // DOMContentLoaded
