import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

/* ========== i18n (EN/TH) ========== */
const I18N = {
  en:{brand:'Desaii',home:'Home',product:'Product',quote:'3d printing quote',viewport:'3D Model view port',draghere:'Drag&Drop files here',or:'or',browse:'Browse Files',picture:'Picture',setting:'Setting',qty:'qty',price:'price',addmore:'+ Browse more files',emptyList:'Upload STL files to see them here',quotation:'Quotation',download:'Download quote (.json)',lblMaterial:'Material',lblQuality:'Quality',lblInfill:'Infill %',lblSupport:'Supports',remove:'Remove'},
  th:{brand:'เดไซอิ',home:'หน้าแรก',product:'สินค้า',quote:'คำนวณราคา 3D print',viewport:'มุมมองโมเดล 3D',draghere:'ลากและวางไฟล์ที่นี่',or:'หรือ',browse:'เลือกไฟล์',picture:'รูปภาพ',setting:'ตั้งค่า',qty:'จำนวน',price:'ราคา',addmore:'+ เลือกไฟล์เพิ่ม',emptyList:'อัปโหลดไฟล์ STL เพื่อแสดงรายการ',quotation:'ใบเสนอราคา',download:'ดาวน์โหลดใบเสนอราคา (.json)',lblMaterial:'วัสดุ',lblQuality:'คุณภาพ',lblInfill:'พิมพ์โปร่ง %',lblSupport:'ซัพพอร์ต',remove:'ลบ'}
};
const getLang=()=>localStorage.getItem('lang')||'en';
const setLang=l=>{localStorage.setItem('lang',l);applyI18N();};
function applyI18N(){
  const dict = I18N[getLang()]||I18N.en;
  document.documentElement.lang = getLang();
  document.querySelectorAll('[data-i18n]').forEach(n=>{
    const k=n.getAttribute('data-i18n'); if(dict[k]) n.textContent=dict[k];
  });
  document.querySelectorAll('.lang-switch').forEach(b=>b.classList.toggle('active', b.dataset.lang===getLang()));
}
document.addEventListener('click',e=>{const b=e.target.closest('.lang-switch'); if(b) setLang(b.dataset.lang);});
applyI18N();

/* ========== constants ========== */
const ORIENT=[Math.PI/2,0,0]; // x+90
const MATERIALS={PLA:{rate:2.0,baseFee:150,density_g_cm3:1.24},PETG:{rate:2.4,baseFee:160,density_g_cm3:1.27},ABS:{rate:3.0,baseFee:180,density_g_cm3:1.04},'PETG-CF':{rate:2.8,baseFee:175,density_g_cm3:1.30}};
const QUALITY_SPEED={draft:1134,standard:486,fine:194};
const SHELL_BASE=0.70, INFILL_PORTION=0.30, CALIBRATION_MULT=2.02, WASTE_GRAMS_PER_PART=2.0, SUPPORT_MASS_MULT=1.25;
const INFILL_TIME_MULT=p=>0.85+(clamp(p,0,100)/100)*0.60, SUPPORT_TIME_MULT=yn=>yn==='yes'?1.15:1.00;
const PREP_TIME_PER_JOB_MIN=6+14/60, PREP_IS_PER_PART=false;
const SMALL_FEE_THRESHOLD=250, SMALL_FEE_TAPER=400, PRINT_RATE_PER_HOUR=10;

/* ========== dom ========== */
const $=id=>document.getElementById(id);
const el={file:$('stlFile'),fileInfo:$('fileInfo'),dropZone:$('dropZone'),fileListWrap:$('fileListWrap'),fileList:$('fileList'),fileListEmpty:$('fileListEmpty'),summary:$('summaryList'),grandTotal:$('grandTotal'),download:$('downloadQuote'),canvas:$('viewer'),addMoreBtn:$('addMoreBtn')};
el.addMoreBtn?.addEventListener('click',()=>el.file?.click());

/* ========== viewer ========== */
let renderer, scene, camera, controls, mesh;
(function initViewer(){
  renderer = new THREE.WebGLRenderer({canvas:el.canvas, antialias:true, preserveDrawingBuffer:true});
  scene = new THREE.Scene(); scene.background=new THREE.Color(0xf3f4f6);
  const key=new THREE.DirectionalLight(0xffffff,1.1); key.position.set(1,1,1);
  const amb=new THREE.AmbientLight(0xffffff,0.495); scene.add(key,amb);
  camera=new THREE.PerspectiveCamera(50,1,0.1,10000); camera.position.set(120,120,120);
  sizeViewer(); window.addEventListener('resize',sizeViewer);
  controls=new OrbitControls(camera, el.canvas); controls.enableDamping=true;
  (function loop(){requestAnimationFrame(loop); controls.update(); renderer.render(scene,camera);})();
})();
function sizeViewer(){const w=el.canvas.parentElement?.clientWidth||900,h=Math.max(360,Math.floor(w*.55));renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();}
function clearViewer(){if(mesh){scene.remove(mesh);mesh.geometry.dispose?.();mesh.material.dispose?.();mesh=null;}controls.target.set(0,0,0);camera.position.set(120,120,120);renderer.render(scene,camera);}
function renderMesh(geo){
  if(mesh){scene.remove(mesh);mesh.geometry.dispose();mesh.material.dispose();}
  mesh=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color:0xff7a00,metalness:.05,roughness:.85}));
  mesh.rotation.set(...ORIENT); scene.add(mesh);
  const box=new THREE.Box3().setFromObject(mesh), size=new THREE.Vector3(); box.getSize(size); const center=new THREE.Vector3(); box.getCenter(center);
  controls.target.copy(center); const dist=Math.max(size.x,size.y,size.z)*2.2+10; camera.position.set(center.x+dist,center.y+dist,center.z+dist); camera.lookAt(center);
}

/* ========== state & input ========== */
let models=[], idSeq=1;
el.file?.addEventListener('change',async e=>{const files=[...(e.target.files||[])]; if(!files.length) return; await addFiles(files); el.file.value='';});
if(el.dropZone){
  ['dragenter','dragover'].forEach(evt=>el.dropZone.addEventListener(evt,e=>{e.preventDefault(); el.dropZone.style.opacity='0.9';}));
  ['dragleave','drop'].forEach(evt=>el.dropZone.addEventListener(evt,e=>{e.preventDefault(); el.dropZone.style.opacity='1';}));
  el.dropZone.addEventListener('drop',async e=>{
    const items=e.dataTransfer?.items; let files=[];
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
      const volume_mm3=computeVolume(g);
      const thumb=await makeThumb(g);
      const m={id:idSeq++,name:f.name,_sig:`${f.name}::${f.size}`,volume_mm3,bbox:null,qty:1,material:'PLA',quality:'standard',infill:15,supports:'no',thumbDataURL:thumb};
      models.push(m); addRow(m,g); renderMesh(g); added++;
    }catch(err){console.error('STL parse failed:', f.name, err);}
  }
  if(added){ el.fileListWrap.style.display='block'; el.dropZone?.style.setProperty('display','none'); toggleEmpty(true); updateInfo(); recalc(); }
}
function toggleEmpty(has){ if(el.fileListEmpty) el.fileListEmpty.style.display = has?'none':'block'; }

/* ========== row ui (redesigned) ========== */
function addRow(model, geo){
  const dict = I18N[getLang()]||I18N.en;

  const row=document.createElement('div'); row.className='file-row'; row.id=`row-${model.id}`;

  // idx
  const idx=document.createElement('div'); idx.className='idx'; idx.textContent = models.indexOf(model)+1;

  // media
  const media=document.createElement('div'); media.className='card-media';
  const img=document.createElement('img'); img.src=model.thumbDataURL; img.alt='thumb'; img.onclick=()=>renderMesh(geo);
  const meta=document.createElement('div');
  const name=document.createElement('div'); name.className='file-name'; name.title=model.name; name.textContent=model.name;
  const vol=document.createElement('div'); vol.className='file-meta'; vol.textContent=`${(model.volume_mm3/1000).toFixed(2)} cm³`;
  meta.appendChild(name); meta.appendChild(vol); media.append(img,meta);

  // settings grid
  const settings=document.createElement('div'); settings.className='settings';
  const fMat=field(dict.lblMaterial, sel(['PLA','PETG','ABS','PETG-CF'], model.material));
  const fQ=field(dict.lblQuality, sel([['draft','Draft (0.28)'],['standard','Standard (0.20)'],['fine','Fine (0.12)']], model.quality));
  const fIn=field(dict.lblInfill, num(model.infill,0,100,1));
  const fSup=field(dict.lblSupport, sel([['no','No'],['yes','Yes']], model.supports));
  settings.append(fMat.wrap,fQ.wrap,fIn.wrap,fSup.wrap);

  // qty
  const qtyCol=document.createElement('div'); qtyCol.className='qtycol field';
  const qtyLbl=document.createElement('label'); qtyLbl.textContent=dict.qty;
  const qty=num(model.qty,1,999,1); qtyCol.append(qtyLbl, qty);

  // price
  const priceCol=document.createElement('div'); priceCol.className='pricecol';
  const price=document.createElement('div'); price.className='price-chip'; price.id=`price-${model.id}`; price.textContent='—';
  priceCol.appendChild(price);

  // remove
  const rm=document.createElement('button'); rm.className='danger'; rm.textContent=dict.remove; rm.onclick=()=>{
    models=models.filter(m=>m.id!==model.id); row.remove();
    if(!models.length){el.fileListWrap.style.display='none'; toggleEmpty(false); el.download.disabled=true; el.summary.innerHTML=''; el.grandTotal.innerHTML=''; clearViewer(); updateInfo(); el.dropZone?.style.removeProperty('display');}
    else { resetIndices(); updateInfo(); recalc(); }
  };

  // events
  fMat.input.onchange=()=>{model.material=fMat.input.value; recalc();};
  fQ.input.onchange=()=>{model.quality=fQ.input.value; recalc();};
  fIn.input.oninput =()=>{model.infill=clamp(+fIn.input.value||0,0,100); fIn.input.value=String(model.infill); recalc();};
  fSup.input.onchange=()=>{model.supports=fSup.input.value; recalc();};
  qty.oninput      =()=>{model.qty=Math.max(1,parseInt(qty.value||'1',10)); qty.value=String(model.qty); recalc();};

  row.append(idx, media, settings, qtyCol, priceCol, rm);
  el.fileList.appendChild(row);
}
function resetIndices(){
  [...el.fileList.querySelectorAll('.file-row .idx')].forEach((n,i)=>n.textContent=String(i+1));
}
function field(labelText, inputEl){
  const wrap=document.createElement('div'); wrap.className='field';
  const lbl=document.createElement('label'); lbl.textContent=labelText;
  wrap.append(lbl,inputEl); return {wrap, input:inputEl};
}
function sel(values, val){
  const s=document.createElement('select');
  values.forEach(v=>{
    if(Array.isArray(v)){const [value,label]=v; const o=document.createElement('option'); o.value=value; o.textContent=label; s.appendChild(o);}
    else {const o=document.createElement('option'); o.value=v; o.textContent=v; s.appendChild(o);}
  });
  s.value=val; return s;
}
function num(v,min,max,step){const n=document.createElement('input'); n.type='number'; n.className='number'; n.min=min; n.max=max; n.step=step; n.value=String(v); return n;}

/* ========== math & thumbs ========== */
function computeVolume(geo){
  const a=geo.attributes.position.array; let v=0;
  for(let i=0;i<a.length;i+=9){
    const ax=a[i],ay=a[i+1],az=a[i+2], bx=a[i+3],by=a[i+4],bz=a[i+5], cx=a[i+6],cy=a[i+7],cz=a[i+8];
    v += (ax*by*cz + bx*cy*az + cx*ay*bz - ax*cy*bz - bx*ay*cz - cx*by*az);
  }
  return Math.abs(v)/6;
}
async function makeThumb(geo){
  const w=140,h=100; const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h;
  const r=new THREE.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true});
  const sc=new THREE.Scene(); sc.background=new THREE.Color(0xf3f4f6);
  const d=new THREE.DirectionalLight(0xffffff,1.1); d.position.set(1,1,1);
  sc.add(d,new THREE.AmbientLight(0xffffff,.495));
  const cam=new THREE.PerspectiveCamera(50,w/h,.1,1e4);
  const m=new THREE.Mesh(geo.clone(), new THREE.MeshStandardMaterial({color:0xff7a00,metalness:.05,roughness:.85}));
  m.rotation.set(...ORIENT); sc.add(m);
  const box=new THREE.Box3().setFromObject(m), size=new THREE.Vector3(); box.getSize(size); const c=new THREE.Vector3(); box.getCenter(c);
  const dist=Math.max(size.x,size.y,size.z)*2.6+10; cam.position.set(c.x+dist,c.y+dist,c.z+dist); cam.lookAt(c);
  r.setSize(w,h,false); r.render(sc,cam); const url=canvas.toDataURL('image/png'); m.geometry.dispose(); m.material.dispose(); r.dispose(); return url;
}

/* ========== pricing ========== */
function estimate(m){
  const mat=MATERIALS[m.material];
  const grams_solid=(m.volume_mm3/1000)*mat.density_g_cm3;
  const fillFactor=SHELL_BASE+INFILL_PORTION*(m.infill/100);
  const supportMass=m.supports==='yes'?SUPPORT_MASS_MULT:1.0;
  const gramsPerPart=grams_solid*fillFactor*supportMass*CALIBRATION_MULT + WASTE_GRAMS_PER_PART;
  const gramsTotal=gramsPerPart*m.qty;

  const baseSpeed=QUALITY_SPEED[m.quality];
  const timeMult=INFILL_TIME_MULT(m.infill)*SUPPORT_TIME_MULT(m.supports);
  const timeMinPerPart=(m.volume_mm3/baseSpeed)*timeMult;
  const minutesTotal=timeMinPerPart*m.qty;

  const materialCost=gramsTotal*mat.rate;
  const printCost=(minutesTotal/60)*PRINT_RATE_PER_HOUR;
  return {gramsTotal, minutesTotal, sub: materialCost+printCost, matBaseFee: mat.baseFee};
}

function recalc(){
  if(!models.length){ el.summary.innerHTML=''; el.grandTotal.innerHTML=''; el.download.disabled=true; updateInfo(); clearViewer(); return; }
  let grams=0, minutes=0, sub=0, maxBase=0;
  for(const m of models){
    const e=estimate(m); grams+=e.gramsTotal; minutes+=e.minutesTotal; sub+=e.sub; maxBase=Math.max(maxBase,e.matBaseFee);
    const cell=document.getElementById(`price-${m.id}`); if(cell) cell.textContent=String(Math.ceil(e.sub));
  }
  const parts=models.reduce((s,m)=>s+m.qty,0);
  minutes += PREP_TIME_PER_JOB_MIN * (PREP_IS_PER_PART ? parts : 1);
  const hours=minutes/60;

  let smallFee;
  if(sub<=SMALL_FEE_THRESHOLD) smallFee=maxBase;
  else {
    const reduction=((sub-SMALL_FEE_THRESHOLD)/SMALL_FEE_TAPER)*maxBase;
    smallFee=Math.max(maxBase-reduction,0);
  }
  const total=Math.ceil(sub+smallFee);

  el.summary.innerHTML=`
    <li><span>Models</span><strong>${models.length} file(s), ${parts} part(s)</strong></li>
    <li><span>Total used</span><strong>${round(grams,2)} g</strong></li>
    <li><span>Total time</span><strong>${Math.floor(hours)} h ${Math.round((hours%1)*60)} m</strong></li>
    <li><span>Printing fee</span><strong>${round(sub,2)} THB</strong></li>
    <li><span>Small order fee (max)</span><strong>${round(smallFee,2)} THB</strong></li>`;
  el.grandTotal.innerHTML=`<div class="total"><h2>Total price: ${total} THB</h2></div>`;
  el.download.disabled=false;

  el.download.onclick=()=>{
    const payload={ items:models.map(m=>({file:m.name,qty:m.qty,material:m.material,quality:m.quality,infill:m.infill,supports:m.supports})),
      totals:{files:models.length,parts,grams:round(grams,2),minutes:Math.round(minutes)},
      costs:{subtotal:round(sub,2),smallOrderFee:round(smallFee,2),finalPrice:total} };
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='quote.json'; a.click(); URL.revokeObjectURL(url);
  };

  updateInfo(); applyI18N();
}

/* ========== helpers ========== */
function updateInfo(){ el.fileInfo.textContent = models.length ? `Total models: ${models.length}` : ''; }
function round(n,d){ return Math.round(n*10**d)/10**d; }
function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
