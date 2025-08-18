// script.js — per-file settings, inline prices, auto-calc, drag&drop, thumbnails
// Viewer: light gray bg; Model color: orange; Orientation locked to x+90

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

/* ===================== ORIENTATION ===================== */
// Lock orientation to x+90
let ORIENT = 'x+90';
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

// ... rest of the code remains unchanged ...
