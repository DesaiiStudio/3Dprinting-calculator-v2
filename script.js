/* ========= Config (you can tweak freely) ========= */
const MATERIALS = {
  "PLA":     { density_g_cm3: 1.24, cost_per_kg_thb: 450, color_options: ["Black","White"] },
  "PETG":    { density_g_cm3: 1.27, cost_per_kg_thb: 500, color_options: ["Black","White","Clear"] },
  "PETG-CF": { density_g_cm3: 1.30, cost_per_kg_thb: 750, color_options: ["Black"] }
};

// Quality affects print speed (mm^3/min) – rough but practical starter values.
const QUALITY_SPEED = {
  "draft":    600,   // fastest
  "standard": 420,
  "fine":     260    // slowest
};

// Support & infill multipliers (simple starters)
const SUPPORT_TIME_MULTIPLIER = { yes: 1.15, no: 1.0 };
const INFILL_TIME_MULTIPLIER = (infillPct) => 0.85 + (infillPct/100)*0.6; // 0%→0.85x, 100%→1.45x

/* ========= Elements ========= */
const fileInput = document.getElementById('stlFile');
const fileInfo  = document.getElementById('fileInfo');
const calcBtn   = document.getElementById('calcBtn');
const metricsEl = document.getElementById('metrics');
const breakdownEl = document.getElementById('breakdown');
const totalEl   = document.getElementById('total');
const downloadBtn = document.getElementById('downloadQuote');

/* Settings inputs */
const materialSel = document.getElementById('material');
const qualitySel  = document.getElementById('quality');
const infillInp   = document.getElementById('infill');
const supportsSel = document.getElementById('supports');
const qtyInp      = document.getElementById('qty');

/* Advanced inputs */
const baseFeeInp   = document.getElementById('baseFee');
const machHrInp    = document.getElementById('machHr');
const ppFeeInp     = document.getElementById('ppFee');
const minThreshInp = document.getElementById('minThresh');
const marginInp    = document.getElementById('margin');
const vatInp       = document.getElementById('vat');

/* ========= Three.js viewer ========= */
let renderer, scene, camera, controls, mesh;
initViewer();

function initViewer() {
  const canvas = document.getElementById('viewer');
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

  controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true;

  animate();
}
function resizeRenderer() {
  const canvas = renderer.domElement;
  const parent = canvas.parentElement;
  const w = parent.clientWidth;
  const h = Math.max(300, Math.floor(w * 0.55));
  renderer.setSize(w, h, false);
  if (camera) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
function animate() {
  requestAnimationFrame(animate);
  controls && controls.update();
  renderer.render(scene, camera);
}

/* ========= STL load & measure ========= */
let currentMetrics = null; // { volume_mm3, bbox: {x,y,z}, triangles }

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  resetOutputs();
  if (!file) return;

  if (!file.name.toLowerCase().endsWith(".stl")) {
    fileInfo.textContent = "Please choose a .stl file.";
    return;
  }
  fileInfo.textContent = `Selected: ${file.name} (${(file.size/1024/1024).toFixed(2)} MB)`;

  const arrayBuffer = await file.arrayBuffer();
  const loader = new THREE.STLLoader();
  let geometry;
  try {
    geometry = loader.parse(arrayBuffer);
  } catch (err) {
    fileInfo.textContent = "Could not parse STL. Is the file valid?";
    return;
  }

  // Normalize to BufferGeometry
  const geo = geometry.isBufferGeometry ? geometry : new THREE.BufferGeometry().fromGeometry(geometry);
  geo.computeBoundingBox();
  geo.computeVertexNormals();

  // Compute metrics
  const volume_mm3 = computeVolume(geo); // signed volume (expects mm units)
  const bbox = {
    x: (geo.boundingBox.max.x - geo.boundingBox.min.x),
    y: (geo.boundingBox.max.y - geo.boundingBox.min.y),
    z: (geo.boundingBox.max.z - geo.boundingBox.min.z)
  };

  currentMetrics = { volume_mm3, bbox };
  renderMesh(geo);
  showMetrics(currentMetrics);
  calcBtn.disabled = false;
});

function renderMesh(geo) {
  if (mesh) scene.remove(mesh);
  const mat = new THREE.MeshStandardMaterial({ color: 0x5ad, metalness: 0.1, roughness: 0.8 });
  mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);

  // Frame the object
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

/* Signed volume of a closed mesh using triangles */
function computeVolume(bufferGeo) {
  const pos = bufferGeo.attributes.position.array;
  let vol = 0.0;
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i],   ay = pos[i+1], az = pos[i+2];
    const bx = pos[i+3], by = pos[i+4], bz = pos[i+5];
    const cx = pos[i+6], cy = pos[i+7], cz = pos[i+8];
    // Scalar triple product: (a x b) · c  / 6
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

  // Advanced vars
  const baseFee = Number(baseFeeInp.value);
  const machine_hr_thb = Number(machHrInp.value);
  const pp_fee = Number(ppFeeInp.value);
  const min_order = Number(minThreshInp.value);
  const margin_pct = Number(marginInp.value);
  const vat_pct = Number(vatInp.value);

  // Mass (g) from volume (mm^3): 1 cm^3 = 1000 mm^3
  const mass_g = (metrics.volume_mm3 / 1000) * mat.density_g_cm3;
  const material_cost = (mass_g / 1000) * mat.cost_per_kg_thb;

  // Estimate print time (min)
  const base_speed = QUALITY_SPEED[qualityKey];          // mm^3/min
  const time_mult = SUPPORT_TIME_MULTIPLIER[supports] * INFILL_TIME_MULTIPLIER(infillPct);
  const est_time_min = (metrics.volume_mm3 / base_speed) * time_mult;

  // Machine + ops
  const machine_cost = (est_time_min / 60) * machine_hr_thb;
  const ops_fee = pp_fee;

  let subtotal = baseFee + material_cost + machine_cost + ops_fee;
  if (subtotal < min_order) subtotal = min_order;

  const with_margin = subtotal * (1 + margin_pct/100);
  const with_vat = with_margin * (1 + vat_pct/100);

  const per_part_total = with_vat;
  const grand_total = per_part_total * qty;

  const breakdown = {
    inputs: {
      material: materialSel.value,
      density_g_cm3: mat.density_g_cm3,
      cost_per_kg_thb: mat.cost_per_kg_thb,
      quality: qualityKey,
      infill_pct: infillPct,
      supports
    },
    metrics: {
      volume_mm3: round(metrics.volume_mm3, 0),
      bbox_mm: {
        x: round(metrics.bbox.x, 2),
        y: round(metrics.bbox.y, 2),
        z: round(metrics.bbox.z, 2)
      },
      mass_g: round(mass_g, 2),
      est_time_min: round(est_time_min, 1)
    },
    costs: {
      base_fee: round(baseFee, 2),
      material_cost: round(material_cost, 2),
      machine_cost: round(machine_cost, 2),
      post_process_fee: round(ops_fee, 2),
      subtotal_after_min_threshold: round(subtotal,
