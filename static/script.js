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
