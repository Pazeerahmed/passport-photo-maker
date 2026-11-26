'use strict';
const input = document.getElementById('photoInput');
const dropzone = document.getElementById('dropzone');
const generate = document.getElementById('generate');
const status = document.getElementById('status');
const result = document.getElementById('result');
const download = document.getElementById('download');
const placeholder = document.querySelector('.placeholder');
let photo = null;
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
    else { generate.disabled = false; status.textContent = 'Showing original upload only (not a passport result). Face detection failed; try a clear front-facing photo or reload the page.'; }
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
  if (!detectedFace) {
    status.textContent = 'Cannot crop safely without detecting a face. Upload a clear front-facing photo.';
    return;
  }
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
  body.append('face', detectedFace.join(','));
  body.append('require_face', 'true');
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
    status.textContent = 'Your photo is ready to download.';
  } catch (error) {
    if (run === detectionRun) status.textContent = error.name === 'AbortError' ? 'Processing timed out. Please retry; the server may be cold-starting.' : error.message;
  } finally {
    processing = false;
    if (run !== detectionRun && photo && detectedFace) { processPhoto(); return; }
    generate.disabled = !photo;
    generate.textContent = '↻ Regenerate Photo';
  }
}
generate.addEventListener('click', processPhoto);
