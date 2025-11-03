// Top-to-bottom UI — same logic as before

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

/* ---------- i18n ---------- */
const I18N = {
  en:{brand:'Desaii',home:'Home',product:'Product',quote:'3D Printing Quote',viewport:'3D Model',draghere:'Drag & drop STL',or:'or',browse:'Browse files',picture:'Model',setting:'Details',qty:'Qty',price:'Price',addmore:'+ Add more files',emptyList:'Drop STL files above to start.',quotation:'Quotation',download:'Download JSON',lblMaterial:'Material',lblQuality:'Quality',lblInfill:'Infill %',lblSupport:'Supports',remove:'Remove'},
  th:{brand:'เดไซอิ',home:'หน้าแรก',product:'สินค้า',quote:'คำนวณราคา',viewport:'มุมมองโมเดล',draghere:'ลากและวาง STL',or:'หรือ',browse:'เลือกไฟล์',picture:'โมเดล',setting:'รายละเอียด',qty:'จำนวน',price:'ราคา',addmore:'+ เพิ่มไฟล์',emptyList:'วางไฟล์ STL ด้านบนเพื่อเริ่มต้น',quotation:'สรุปค่าใช้จ่าย',download:'ดาวน์โหลด JSON',lblMaterial:'วัสดุ',lblQuality:'คุณภาพ',lblInfill:'เปอร์เซ็นต์ Infill',lblSupport:'ซัพพอร์ต',remove:'ลบ'}
};
const getLang=()=>localStorage.getItem('lang')||'en';
const setLang=l=>{localStorage.setItem('lang',l);applyI18N();};
function applyI18N(){
  const dict=I18N[getLang()]||I18N.en;
  document.querySelectorAll('[data-i18n]').forEach(n=>{const k=n.getAttribute('data-i18n'); if(dict[k]) n.textContent=dict[k];});
  document.querySelectorAll('.lang-switch').forEach(b=>b.classList.toggle('active', b.dataset.lang===getLang()));
}
document.addEventListener('click',e=>{const b=e.target.closest('.lang-switch'); if(b) setLang(b.dataset.lang);});
applyI18N();

/* ---------- Config ---------- */
const MATERIALS={PLA:{rate:2.0,baseFee:150,density_g_cm3:1.24},PETG:{rate:2.4,baseFee:160,density_g_cm3:1.27},ABS:{rate:3.0,baseFee:180,density_g_cm3:1.04},'PETG-CF':{rate:2.8,baseFee:175,density_g_cm3:1.30}};
const QUALITY_SPEED={draft:1134,standard:486,fine:194};
const SHELL_BASE=0.70, INFILL_PORTION=0.30, CALIBRATION_MULT=2.02, WASTE_GRAMS_PER_PART=2.0, SUPPORT_MASS_MULT=1.25;
const INFILL_TIME_MULT=p=>0.85+(clamp(p,0,100)/100)*0.60, SUPPORT_TIME_MULT=yn=>yn==='yes'?1.15:1.00;
const PREP_TIME_PER_JOB_MIN=6+14/60, PREP_IS_PER_PART=false;
const SMALL_FEE_THRESHOLD=250, SMALL_FEE_TAPER=400, PRINT_RATE_PER_HOUR=10;

/* ---------- DOM ---------- */
const $=id=>document.getElementById(id);
const el={file:$('stlFile'),fileInfo:$('fileInfo'),dropZone:$('dropZone'),fileListWrap:$('fileListWrap'),fileList:$('fileList'),fileListEmpty:$('fileListEmpty'),summary:$('summaryList'),grandTotal:$('grandTotal'),download:$('downloadQuote'),canvas:$('viewer'),addMoreBtn:$('addMoreBtn')};
el.addMoreBtn?.addEventListener('click',()=>el.file?.click());

/* ---------- Viewer ---------- */
let renderer, scene, camera, controls, mesh;
(function initViewer(){
  renderer=new THREE.WebGLRenderer({canvas:el.canvas,antialias:true,preserveDrawingBuffer:true});
  scene=new THREE.Scene(); scene.background=new THREE.Color(0xffffff);
  const key=new THREE.DirectionalLight(0xffffff,0.9); key.position.set(1,1,1);
  const fill=new THREE.DirectionalLight(0xffffff,0.6); fill.position.set(-1,0.5,1);
  const amb=new THREE.AmbientLight(0xffffff,0.35); scene.add(key,fill,amb);
  camera=new THREE.PerspectiveCamera(50,1,0.1,10000); camera.position.set(140,140,140);
  size(); window.addEventListener('resize',size);
  controls=new OrbitControls(camera, el.canvas); controls.enableDamping=true;
  (function loop(){requestAnimationFrame(loop); controls.update(); renderer.render(scene,camera);})();
})();
function size(){const w=el.canvas.parentElement?.clientWidth||900,h=Math.max(360,Math.floor(w*.58));renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}
function setMesh(geo){
  if(mesh){scene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();}
  mesh=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:0x222222,metalness:0.1,roughness:0.85}));
  mesh.rotation.set(Math.PI/2,0,0); scene.add(mesh);
  const box=new THREE.Box3().setFromObject(mesh), s=new THREE.Vector3(); box.getSize(s); const c=new THREE.Vector3(); box.getCenter(c);
  controls.target.copy(c); const dist=Math.max(s.x,s.y,s.z)*2.4+12; camera.position.set(c.x+dist,c.y+dist,c.z+dist); camera.lookAt(c);
}
function clearViewer(){if(mesh){scene.remove(mesh);mesh.geometry.dispose?.();mesh.material.dispose?.();mesh=null;}}

/* ---------- State & Input ---------- */
let models=[], idSeq=1;
el.file?.addEventListener('change',async e=>{const fs=[...(e.target.files||[])]; if(!fs.length)return; await addFiles(fs); el.file.value='';});
if(el.dropZone){
  ['dragenter','dragover'].forEach(evt=>el.dropZone.addEventListener(evt,e=>{e.preventDefault();}));
  el.dropZone.addEventListener('drop',async e=>{
    e.preventDefault();
    let files=[]; const items=e.dataTransfer?.items;
    if(items&&items.length){for(const it of items){if(it.kind==='file'){const f=it.getAsFile(); if(f) files.push(f);}}}
    else files=[...(e.dataTransfer?.files||[])];
    if(!files.length) return; await addFiles(files);
  });
}

async function addFiles(fileList){
  const stls=fileList.filter(f=>/\.stl$/i.test(f.name)); if(!stls.length){el.fileInfo.textContent='Only .stl files are supported.'; return;}
  let added=0;
  for(const f of stls){
    if(models.some(m=>m._sig===`${f.name}::${f.size}`)) continue;
    try{
      const buf=await f.arrayBuffer(); const parsed=new STLLoader().parse(buf);
      const g=parsed.isBufferGeometry?parsed:new THREE.BufferGeometry().fromGeometry(parsed);
      g.computeBoundingBox(); g.computeVertexNormals();
      const vol=computeVolume(g); const thumb=await makeThumb(g);
      const model={id:idSeq++,name:f.name,_sig:`${f.name}::${f.size}`,volume_mm3:vol,qty:1,material:'PLA',quality:'standard',infill:15,supports:'no',thumbDataURL:thumb};
      models.push(model); addRow(model,g); setMesh(g); added++;
    }catch(err){console.error('STL parse failed', f.name, err);}
  }
  if(added){ el.fileListWrap.style.display='block'; el.dropZone?.style.setProperty('display','none'); toggleEmpty(true); info(); recalc(); }
}
function toggleEmpty(has){ if(el.fileListEmpty) el.fileListEmpty.style.display = has?'none':'block'; }

/* ---------- Model row ---------- */
function addRow(model, geo){
  const dict=I18N[getLang()]||I18N.en;
  const row=document.createElement('div'); row.className='file-row'; row.id=`row-${model.id}`;

  const idx=document.createElement('div'); idx.className='idx'; idx.textContent=models.indexOf(model)+1;

  const media=document.createElement('div'); media.className='card-media';
  const img=document.createElement('img'); img.src=model.thumbDataURL; img.alt='thumb'; img.onclick=()=>setMesh(geo);
  const meta=document.createElement('div');
  const nm=document.createElement('div'); nm.className='file-name'; nm.title=model.name; nm.textContent=model.name;
  const vol=document.createElement('div'); vol.className='file-meta'; vol.textContent=`${(model.volume_mm3/1000).toFixed(2)} cm³`;
  meta.append(nm,vol); media.append(img,meta);

  const details=document.createElement('div'); details.className='details';
  const mat=field(dict.lblMaterial, select(['PLA','PETG','ABS','PETG-CF'], model.material));
  const ql =field(dict.lblQuality,  select([['draft','Draft (0.28)'],['standard','Standard (0.20)'],['fine','Fine (0.12)']], model.quality));
  const inf=field(dict.lblInfill,   number(model.infill,0,100,1));
  const sup=field(dict.lblSupport,  select([['no','No'],['yes','Yes']], model.supports));
  details.append(mat.wrap, ql.wrap, inf.wrap, sup.wrap);

  const qtyCol=document.createElement('div'); qtyCol.className='qtycol field';
  const qtyLbl=document.createElement('label'); qtyLbl.textContent=dict.qty;
  const qty=number(model.qty,1,999,1); qtyCol.append(qtyLbl, qty);

  const priceCol=document.createElement('div'); priceCol.className='pricecol';
  const price=document.createElement('div'); price.className='price-chip'; price.id=`price-${model.id}`; price.textContent='—';
  priceCol.append(price);

  const rm=document.createElement('button'); rm.className='danger'; rm.textContent=dict.remove;
  rm.onclick=()=>{
    models=models.filter(m=>m.id!==model.id); row.remove();
    if(!models.length){el.fileListWrap.style.display='none'; toggleEmpty(false); el.download.disabled=true; el.summary.innerHTML=''; el.grandTotal.innerHTML=''; clearViewer(); info(); el.dropZone?.style.removeProperty('display');}
    else{ reindex(); info(); recalc(); }
  };

  // events
  mat.input.onchange=()=>{model.material=mat.input.value; recalc();};
  ql.input.onchange =()=>{model.quality=ql.input.value; recalc();};
  inf.input.oninput =()=>{model.infill=clamp(+inf.input.value||0,0,100); inf.input.value=String(model.infill); recalc();};
  sup.input.onchange=()=>{model.supports=sup.input.value; recalc();};
  qty.oninput       =()=>{model.qty=Math.max(1,parseInt(qty.value||'1',10)); qty.value=String(model.qty); recalc();};

  row.append(idx, media, details, qtyCol, priceCol, rm);
  el.fileList.appendChild(row);
}
function reindex(){[...el.fileList.querySelectorAll('.file-row .idx')].forEach((n,i)=>n.textContent=String(i+1));}
function field(label, input){const w=document.createElement('div'); w.className='field'; const l=document.createElement('label'); l.textContent=label; w.append(l,input); return {wrap:w,input};}
function select(values, val){const s=document.createElement('select'); values.forEach(v=>{const o=document.createElement('option'); if(Array.isArray(v)){o.value=v[0]; o.textContent=v[1];} else{ o.value=v; o.textContent=v;} s.appendChild(o);}); s.value=val; return s;}
function number(v,min,max,step){const n=document.createElement('input'); n.type='number'; n.className='number'; n.min=min; n.max=max; n.step=step; n.value=String(v); return n;}

/* ---------- Math / Thumbs ---------- */
function computeVolume(geo){
  const a=geo.attributes.position.array; let v=0;
  for(let i=0;i<a.length;i+=9){
    const ax=a[i],ay=a[i+1],az=a[i+2], bx=a[i+3],by=a[i+4],bz=a[i+5], cx=a[i+6],cy=a[i+7],cz=a[i+8];
    v += (ax*by*cz + bx*cy*az + cx*ay*bz - ax*cy*bz - bx*ay*cz - cx*by*az);
  }
  return Math.abs(v)/6;
}
async function makeThumb(geo){
  const w=150,h=110; const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h;
  const r=new THREE.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true});
  const scn=new THREE.Scene(); scn.background=new THREE.Color(0xffffff);
  const d1=new THREE.DirectionalLight(0xffffff,0.9); d1.position.set(1,1,1);
  const d2=new THREE.DirectionalLight(0xffffff,0.6); d2.position.set(-1,0.5,1);
  const amb=new THREE.AmbientLight(0xffffff,0.35); scn.add(d1,d2,amb);
  const cam=new THREE.PerspectiveCamera(50,w/h,0.1,10000);
  const m=new THREE.Mesh(geo.clone(), new THREE.MeshStandardMaterial({color:0x222222,metalness:0.1,roughness:0.85}));
  m.rotation.set(Math.PI/2,0,0); scn.add(m);
  const box=new THREE.Box3().setFromObject(m), s=new THREE.Vector3(); box.getSize(s); const c=new THREE.Vector3(); box.getCenter(c);
  const dist=Math.max(s.x,s.y,s.z)*2.6+12; cam.position.set(c.x+dist,c.y+dist,c.z+dist); cam.lookAt(c);
  r.setSize(w,h,false); r.render(scn,cam); const url=canvas.toDataURL('image/png'); m.geometry.dispose(); m.material.dispose(); r.dispose(); return url;
}

/* ---------- Pricing ---------- */
function estimate(m){
  const mat=MATERIALS[m.material];
  const gramsSolid=(m.volume_mm3/1000)*mat.density_g_cm3;
  const fill=SHELL_BASE+INFILL_PORTION*(m.infill/100);
  const supp=m.supports==='yes'?SUPPORT_MASS_MULT:1.0;
  const gramsPerPart=gramsSolid*fill*supp*CALIBRATION_MULT + WASTE_GRAMS_PER_PART;
  const gramsTotal=gramsPerPart*m.qty;

  const speed=QUALITY_SPEED[m.quality];
  const tMult=INFILL_TIME_MULT(m.infill)*SUPPORT_TIME_MULT(m.supports);
  const minutesPerPart=(m.volume_mm3/speed)*tMult;
  const minutesTotal=minutesPerPart*m.qty;

  const materialCost=gramsTotal*mat.rate;
  const printCost=(minutesTotal/60)*PRINT_RATE_PER_HOUR;
  return {gramsTotal, minutesTotal, sub: materialCost+printCost, matBaseFee: mat.baseFee};
}

function recalc(){
  if(!models.length){ el.summary.innerHTML=''; el.grandTotal.innerHTML=''; el.download.disabled=true; info(); clearViewer(); return; }
  let grams=0, minutes=0, subtotal=0, maxBase=0;
  for(const m of models){
    const e=estimate(m); grams+=e.gramsTotal; minutes+=e.minutesTotal; subtotal+=e.sub; maxBase=Math.max(maxBase,e.matBaseFee);
    const cell=document.getElementById(`price-${m.id}`); if(cell) cell.textContent=String(Math.ceil(e.sub));
  }
  const parts=models.reduce((s,m)=>s+m.qty,0);
  minutes += PREP_TIME_PER_JOB_MIN * (PREP_IS_PER_PART ? parts : 1);
  const hours=minutes/60;

  let smallFee;
  if(subtotal<=SMALL_FEE_THRESHOLD) smallFee=maxBase;
  else { const reduction=((subtotal-SMALL_FEE_THRESHOLD)/SMALL_FEE_TAPER)*maxBase; smallFee=Math.max(maxBase-reduction,0); }

  const total=Math.ceil(subtotal + smallFee);
  el.summary.innerHTML=`
    <li><span>Models</span><strong>${models.length} file(s), ${parts} part(s)</strong></li>
    <li><span>Total used</span><strong>${round(grams,2)} g</strong></li>
    <li><span>Total time</span><strong>${Math.floor(hours)} h ${Math.round((hours%1)*60)} m</strong></li>
    <li><span>Printing fee</span><strong>${round(subtotal,2)} THB</strong></li>
    <li><span>Small order fee (max)</span><strong>${round(smallFee,2)} THB</strong></li>`;
  el.grandTotal.innerHTML=`<div class="total"><h2>Total price: ${total} THB</h2></div>`;
  el.download.disabled=false;

  el.download.onclick=()=>{
    const payload={items:models.map(m=>({file:m.name,qty:m.qty,material:m.material,quality:m.quality,infill:m.infill,supports:m.supports})),
      totals:{files:models.length,parts,grams:round(grams,2),minutes:Math.round(minutes)},
      costs:{subtotal:round(subtotal,2),smallOrderFee:round(smallFee,2),finalPrice:total}};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='quote.json'; a.click(); URL.revokeObjectURL(url);
  };

  info(); applyI18N();
}

/* ---------- Helpers ---------- */
function info(){ el.fileInfo.textContent = models.length ? `Total models: ${models.length}` : ''; }
function round(n,d){ return Math.round(n*10**d)/10**d; }
function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
