'use strict';
const input = document.getElementById('photoInput');
const dropzone = document.getElementById('dropzone');
const generate = document.getElementById('generate');
const status = document.getElementById('status');
const result = document.getElementById('result');
const download = document.getElementById('download');
const placeholder = document.querySelector('.placeholder');
let photo = null;
let manualCropApplied = false;
let objectUrl = null;
let detectedFace = null;
let detectionRun = 0;
let processing = false;
let editVersion = 0;
const withTimeout = (promise, ms, message) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
const formalSuit = document.getElementById('formalSuit');
formalSuit.addEventListener('change', () => {
  disableDownload();
  if (photo) status.textContent = 'Clothing option changed. Click Regenerate Photo.';
});
async function addSuitTemplate(blob) {
  if (!formalSuit.checked) return blob;
  const source = await createImageBitmap(blob);
  const overlay = new Image();
  overlay.src = '/static/formal-suit.svg';
  try {
    await overlay.decode();
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0);
    // Start below the face; simple illustrative clothing overlay only.
    const start = Math.round(canvas.height * 0.68);
    ctx.drawImage(overlay, 0, start, canvas.width, canvas.height - start);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.94));
  } finally { source.close(); }
}
const cropInputs = ['zoom', 'shiftX', 'shiftY'].map(id => document.getElementById(id));
function updateCrop() {
  ['zoomValue', 'shiftXValue', 'shiftYValue'].forEach((id, i) => {
    document.getElementById(id).textContent = cropInputs[i].value + (i === 0 ? '%' : '');
  });
  disableDownload();
  if (photo) status.textContent = 'Crop changed. Generate again to apply.';
}
cropInputs.forEach(slider => slider.addEventListener('input', updateCrop));
document.getElementById('resetCrop').addEventListener('click', () => {
  cropInputs.forEach((slider, i) => { slider.value = i === 0 ? '100' : '0'; });
  updateCrop();
});
async function detectFace(file, run) {
  const message = document.getElementById('faceStatus');
  message.textContent = 'Detecting face on your device…';
  let bitmap;
  try {
    bitmap = await withTimeout(createImageBitmap(file, {imageOrientation:'from-image'}), 8000, 'Could not open image');
    let box = null;
    if ('FaceDetector' in window) {
      try {
        const faces = await new FaceDetector({fastMode:true, maxDetectedFaces:1}).detect(bitmap);
        if (faces.length) box = faces[0].boundingBox;
      } catch (_) { /* Try the free MediaPipe detector instead. */ }
    }
    if (!box) {
      // CDNs are sometimes blocked by networks or browser extensions.
      // Try multiple independent ESM providers instead of failing immediately.
      let visionModule;
      const moduleUrls = [
        'https://esm.sh/@mediapipe/tasks-vision@0.10.22',
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/+esm'
      ];
      for (const url of moduleUrls) {
        try {
          visionModule = await withTimeout(import(/* webpackIgnore: true */ url), 10000, 'Face detector download timed out');
          if (visionModule.FaceDetector && visionModule.FilesetResolver) break;
        } catch (error) { console.warn('Face detector provider unavailable:', url, error); }
      }
      if (!visionModule?.FaceDetector || !visionModule?.FilesetResolver) {
        throw new Error('Face detector download blocked. Try another network or disable content-blocking extensions');
      }
      const {FaceDetector: MPFaceDetector, FilesetResolver} = visionModule;
      let vision;
      for (const wasmBase of [
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm',
        'https://unpkg.com/@mediapipe/tasks-vision@0.10.22/wasm'
      ]) {
        try {
          vision = await withTimeout(FilesetResolver.forVisionTasks(wasmBase), 10000, 'WASM loading timed out');
          break;
        } catch (error) { console.warn('WASM provider unavailable:', wasmBase, error); }
      }
      if (!vision) throw new Error('Face detector runtime could not load');
      const detector = await withTimeout(MPFaceDetector.createFromOptions(vision, {
        baseOptions: {modelAssetPath:'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'},
        runningMode:'IMAGE'
      }), 18000, 'Face model loading timed out');
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const detections = detector.detect(canvas).detections;
        if (detections.length) {
          const b = detections.sort((a,b) => b.boundingBox.width * b.boundingBox.height - a.boundingBox.width * a.boundingBox.height)[0].boundingBox;
          box = {x:b.originX / scale, y:b.originY / scale, width:b.width / scale, height:b.height / scale};
        }
      } finally { detector.close(); }
    }
    if (run !== detectionRun) return;
    if (box) {
      const x = Math.max(0, box.x), y = Math.max(0, box.y);
      const w = Math.max(0, Math.min(box.width, bitmap.width - x));
      const h = Math.max(0, Math.min(box.height, bitmap.height - y));
      if (w < bitmap.width * 0.025 || h < bitmap.height * 0.025) throw new Error('Face detection too small');
      detectedFace = [x / bitmap.width, y / bitmap.height, w / bitmap.width, h / bitmap.height];
      message.textContent = '✓ Face detected — automatic passport crop ready.';
    } else {
      message.textContent = 'No face found. Upload a clearer front-facing portrait. No incorrect full-body result will be generated.';
    }
  } catch (error) {
    if (run === detectionRun) message.textContent = 'Face detection could not load: ' + error.message + '. Try again or use another photo.';
    console.warn('Face detection:', error);
  } finally {
    if (bitmap) bitmap.close();
  }
}

const smoothSlider = document.getElementById('smooth');
const brightnessSlider = document.getElementById('brightness');
function updateAdjustments() {
  document.getElementById('smoothValue').textContent = smoothSlider.value + '%';
  document.getElementById('brightnessValue').textContent = (Number(brightnessSlider.value) > 0 ? '+' : '') + brightnessSlider.value + '%';
  disableDownload();
  if (photo) status.textContent = 'Adjustments changed. Generate again to update your photo.';
}
[smoothSlider, brightnessSlider].forEach(slider => slider.addEventListener('input', updateAdjustments));
document.getElementById('resetAdjustments').addEventListener('click', () => {
  smoothSlider.value = 0;
  brightnessSlider.value = 0;
  updateAdjustments();
});

function disableDownload() {
  editVersion++;
  download.classList.add('disabled');
  download.setAttribute('aria-disabled', 'true');
  download.removeAttribute('href');
}
async function setFile(file) {
  if (!file) return;
  if (!['image/jpeg','image/png','image/webp'].includes(file.type)) {
    status.textContent = 'Please use a JPG, PNG or WEBP photo.'; return;
  }
  if (file.size > 12 * 1024 * 1024) {
    status.textContent = 'The maximum file size is 12 MB.'; return;
  }
  photo = file;
  manualCropApplied = false;
  document.getElementById('openCrop').disabled = false;
  document.getElementById('cropEditor').hidden = true;
  document.getElementById('cropNotice').textContent = '';
  detectedFace = null;
  const run = ++detectionRun;
  generate.disabled = true;
  status.textContent = 'AI is detecting your face and preparing your photo automatically…';
  dropzone.querySelector('strong').textContent = file.name;
  dropzone.querySelector('small').textContent = (file.size / 1024 / 1024).toFixed(2) + ' MB · Click to replace';
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  result.src = objectUrl; result.hidden = false; placeholder.hidden = true;
  result.alt = 'Original uploaded photo — processing not complete';
  disableDownload();
  await detectFace(file, run);
  if (run === detectionRun) {
    if (detectedFace) await processPhoto();
    else {
      document.getElementById('faceStatus').textContent = '⚠ Face detector unavailable. Using an approximate automatic head-and-shoulders crop instead; check positioning before official use.';
      await processPhoto();
    }
  }
}
input.addEventListener('change', () => setFile(input.files[0]));
['dragenter','dragover'].forEach(type => dropzone.addEventListener(type, event => {
  event.preventDefault(); dropzone.classList.add('dragging');
}));
['dragleave','drop'].forEach(type => dropzone.addEventListener(type, event => {
  event.preventDefault(); dropzone.classList.remove('dragging');
}));
dropzone.addEventListener('drop', event => setFile(event.dataTransfer.files[0]));
document.querySelectorAll('input[name="background"]').forEach(radio => radio.addEventListener('change', () => {
  document.querySelectorAll('.option').forEach(option => option.classList.toggle('selected', option.dataset.bg === radio.value));
  document.getElementById('colorName').textContent = radio.value === 'blue' ? 'Blue' : 'White';
  disableDownload();
  if (photo) status.textContent = 'Background changed. Generate again to update your photo.';
}));
document.getElementById('size').addEventListener('change', () => {
  disableDownload();
  if (photo) status.textContent = 'Size changed. Generate again to update your photo.';
});
async function processPhoto() {
  if (!photo || processing) return;
  processing = true;
  const run = detectionRun;
  const version = editVersion;
  const body = new FormData();
  body.append('photo', photo);
  body.append('background', document.querySelector('input[name="background"]:checked').value);
  body.append('size', document.getElementById('size').value);
  body.append('smooth', smoothSlider.value);
  body.append('brightness', brightnessSlider.value);
  body.append('auto_enhance', 'true');
  if (manualCropApplied) {
    body.append('manual_crop', 'true');
    body.append('require_face', 'false');
  } else if (detectedFace) {
    body.append('face', detectedFace.join(','));
    body.append('require_face', 'true');
  } else {
    body.append('require_face', 'false');
  }
  body.append('zoom', cropInputs[0].value);
  body.append('shift_x', cropInputs[1].value);
  body.append('shift_y', cropInputs[2].value);
  generate.disabled = true;
  generate.textContent = 'Processing your photo…';
  status.textContent = 'Removing the background. First-time processing may take longer.';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    let response;
    try { response = await fetch('/api/process', {method:'POST', body, signal: controller.signal}); }
    finally { clearTimeout(timeout); }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Unable to process this photo.');
    }
    const blob = await addSuitTemplate(await response.blob());
    if (run !== detectionRun || version !== editVersion) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    result.src = objectUrl; result.hidden = false; placeholder.hidden = true;
    download.href = objectUrl;
    download.download = 'passport-' + body.get('background') + '-' + body.get('size') + '.jpg';
    download.classList.remove('disabled');
    download.setAttribute('aria-disabled', 'false');
    status.textContent = manualCropApplied ? 'Your manually cropped photo is ready. Check official passport positioning requirements.' : detectedFace ? 'Your photo is ready to download.' : 'Approximate crop ready. Face detector was unavailable; inspect the head and shoulders carefully before downloading.';
  } catch (error) {
    if (run === detectionRun) status.textContent = error.name === 'AbortError' ? 'Processing timed out. Please retry; the server may be cold-starting.' : error.message;
  } finally {
    processing = false;
    if (run !== detectionRun && photo) { processPhoto(); return; }
    generate.disabled = !photo;
    generate.textContent = '↻ Regenerate Photo';
  }
}
generate.addEventListener('click', processPhoto);


// Manual crop: drag inside the box to reposition, drag the bottom-right corner to resize.
const cropCanvas = document.getElementById('cropCanvas');
const cropCtx = cropCanvas.getContext('2d');
const cropEditor = document.getElementById('cropEditor');
let cropBitmap = null, cropBox = null, cropDrag = null;
function cropAspect() {
  const sizes = {'35x45':35/45, '2x2':1, '25x35':25/35};
  return sizes[document.getElementById('size').value] || 35/45;
}
function renderCrop() {
  if (!cropBitmap || !cropBox) return;
  const {width:w,height:h} = cropCanvas;
  cropCtx.clearRect(0,0,w,h);
  cropCtx.drawImage(cropBitmap,0,0,w,h);
  cropCtx.fillStyle='rgba(8,20,39,.55)';
  cropCtx.fillRect(0,0,w,cropBox.y);
  cropCtx.fillRect(0,cropBox.y,cropBox.x,cropBox.h);
  cropCtx.fillRect(cropBox.x+cropBox.w,cropBox.y,w-cropBox.x-cropBox.w,cropBox.h);
  cropCtx.fillRect(0,cropBox.y+cropBox.h,w,h-cropBox.y-cropBox.h);
  cropCtx.strokeStyle='#fff';cropCtx.lineWidth=2;cropCtx.strokeRect(cropBox.x,cropBox.y,cropBox.w,cropBox.h);
  cropCtx.strokeStyle='#267cf6';cropCtx.lineWidth=4;
  cropCtx.beginPath();cropCtx.moveTo(cropBox.x+cropBox.w-18,cropBox.y+cropBox.h);cropCtx.lineTo(cropBox.x+cropBox.w,cropBox.y+cropBox.h);cropCtx.lineTo(cropBox.x+cropBox.w,cropBox.y+cropBox.h-18);cropCtx.stroke();
}
document.getElementById('openCrop').addEventListener('click', async () => {
  if (!photo) return;
  cropEditor.hidden=false;
  document.getElementById('cropNotice').textContent='Drag the selection or resize using the blue bottom-right corner.';
  try {
    if (cropBitmap) cropBitmap.close();
    cropBitmap = await createImageBitmap(photo);
    const scale = Math.min(1, 900/Math.max(cropBitmap.width,cropBitmap.height));
    cropCanvas.width=Math.round(cropBitmap.width*scale);
    cropCanvas.height=Math.round(cropBitmap.height*scale);
    const ratio=cropAspect();
    const h=Math.min(cropCanvas.height*.8,cropCanvas.width*.8/ratio);
    const w=h*ratio;
    cropBox={x:(cropCanvas.width-w)/2,y:(cropCanvas.height-h)/2,w,h};
    renderCrop();
  } catch(e) {document.getElementById('cropNotice').textContent='Unable to open this photo for cropping.';}
});
function cropPointer(e) {
  const r=cropCanvas.getBoundingClientRect();
  return {x:(e.clientX-r.left)*cropCanvas.width/r.width,y:(e.clientY-r.top)*cropCanvas.height/r.height};
}
cropCanvas.addEventListener('pointerdown',e=>{
  if(!cropBox)return;
  const p=cropPointer(e), b=cropBox;
  const handle=Math.hypot(p.x-(b.x+b.w),p.y-(b.y+b.h))<32;
  if(!handle && !(p.x>=b.x&&p.x<=b.x+b.w&&p.y>=b.y&&p.y<=b.y+b.h))return;
  cropDrag={p,b:{...b},mode:handle?'resize':'move'};
  cropCanvas.setPointerCapture(e.pointerId);
});
cropCanvas.addEventListener('pointermove',e=>{
  if(!cropDrag)return;
  const p=cropPointer(e),dx=p.x-cropDrag.p.x,dy=p.y-cropDrag.p.y,b=cropDrag.b;
  if(cropDrag.mode==='move') {
    cropBox.x=Math.max(0,Math.min(cropCanvas.width-b.w,b.x+dx));
    cropBox.y=Math.max(0,Math.min(cropCanvas.height-b.h,b.y+dy));
  } else {
    const ratio=cropAspect();
    const maxW=Math.min(cropCanvas.width-b.x,(cropCanvas.height-b.y)*ratio);
    const newW=Math.max(Math.min(60,maxW),Math.min(maxW,Math.max(b.w+dx,(b.h+dy)*ratio)));
    cropBox.w=newW;cropBox.h=newW/ratio;
  }
  renderCrop();
});
['pointerup','pointercancel'].forEach(t=>cropCanvas.addEventListener(t,()=>cropDrag=null));
document.getElementById('cancelCrop').addEventListener('click',()=>{cropEditor.hidden=true;});
document.getElementById('applyCrop').addEventListener('click',async()=>{
  if(!cropBitmap||!cropBox)return;
  const scaleX=cropBitmap.width/cropCanvas.width,scaleY=cropBitmap.height/cropCanvas.height;
  const out=document.createElement('canvas');
  out.width=Math.max(1,Math.round(cropBox.w*scaleX));
  out.height=Math.max(1,Math.round(cropBox.h*scaleY));
  out.getContext('2d').drawImage(cropBitmap,cropBox.x*scaleX,cropBox.y*scaleY,cropBox.w*scaleX,cropBox.h*scaleY,0,0,out.width,out.height);
  const blob=await new Promise(resolve=>out.toBlob(resolve,'image/jpeg',.94));
  if(!blob)return;
  // This crop is already positioned by the user: do not run face detection again.
  detectionRun++;
  manualCropApplied=true;
  detectedFace=null;
  photo=new File([blob],'manual-crop.jpg',{type:'image/jpeg'});
  if(objectUrl)URL.revokeObjectURL(objectUrl);
  objectUrl=URL.createObjectURL(blob);
  result.src=objectUrl;result.alt='Manually cropped original — processing not complete';
  result.hidden=false;placeholder.hidden=true;
  disableDownload();
  cropEditor.hidden=true;
  document.getElementById('faceStatus').textContent='✓ Manual crop selected — AI face detection not required.';
  document.getElementById('cropNotice').textContent='Crop applied. Generating your photo with background removal…';
  generate.disabled=false;
  await processPhoto();
});
