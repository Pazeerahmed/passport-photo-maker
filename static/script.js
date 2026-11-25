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
    bitmap = await createImageBitmap(file, {imageOrientation:'from-image'});
    let box = null;
    if ('FaceDetector' in window) {
      try {
        const faces = await new FaceDetector({fastMode:true, maxDetectedFaces:1}).detect(bitmap);
        if (faces.length) box = faces[0].boundingBox;
      } catch (_) { /* Try the free MediaPipe detector instead. */ }
    }
    if (!box) {
      const {FaceDetector: MPFaceDetector, FilesetResolver} = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/+esm');
      const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm');
      const detector = await MPFaceDetector.createFromOptions(vision, {
        baseOptions: {modelAssetPath:'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'},
        runningMode:'IMAGE'
      });
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
      detectedFace = [box.x / bitmap.width, box.y / bitmap.height, box.width / bitmap.width, box.height / bitmap.height]
        .map(v => Math.max(0, Math.min(1, v)));
      message.textContent = '✓ Face detected! Adjust zoom and position, then generate.';
    } else {
      message.textContent = 'No face found. Use a clear front-facing portrait; automatic outline crop will be used.';
    }
  } catch (error) {
    if (run === detectionRun) message.textContent = 'Face detection unavailable. Check internet access; outline crop remains available.';
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
  download.classList.add('disabled');
  download.setAttribute('aria-disabled', 'true');
  download.removeAttribute('href');
}
function setFile(file) {
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
  detectFace(file, run);
  generate.disabled = false;
  status.textContent = 'Ready: ' + file.name;
  dropzone.querySelector('strong').textContent = file.name;
  dropzone.querySelector('small').textContent = (file.size / 1024 / 1024).toFixed(2) + ' MB · Click to replace';
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  result.src = objectUrl; result.hidden = false; placeholder.hidden = true;
  disableDownload();
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
generate.addEventListener('click', async () => {
  if (!photo) return;
  const body = new FormData();
  body.append('photo', photo);
  body.append('background', document.querySelector('input[name="background"]:checked').value);
  body.append('size', document.getElementById('size').value);
  body.append('smooth', smoothSlider.value);
  body.append('brightness', brightnessSlider.value);
  if (detectedFace) body.append('face', detectedFace.join(','));
  body.append('zoom', cropInputs[0].value);
  body.append('shift_x', cropInputs[1].value);
  body.append('shift_y', cropInputs[2].value);
  generate.disabled = true;
  generate.textContent = 'Processing your photo…';
  status.textContent = 'Removing the background. First-time processing may take longer.';
  try {
    const response = await fetch('/api/process', {method:'POST', body});
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Unable to process this photo.');
    }
    const blob = await response.blob();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    result.src = objectUrl; result.hidden = false; placeholder.hidden = true;
    download.href = objectUrl;
    download.download = 'passport-' + body.get('background') + '-' + body.get('size') + '.jpg';
    download.classList.remove('disabled');
    download.setAttribute('aria-disabled', 'false');
    status.textContent = 'Your photo is ready to download.';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    generate.disabled = false;
    generate.textContent = '✦ Remove Background & Create Photo';
  }
});
