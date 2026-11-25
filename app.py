import io
import os
import tempfile
from functools import lru_cache
from flask import Flask, jsonify, render_template, request, send_file
from PIL import Image, ImageOps, ImageEnhance, ImageFilter, ImageChops, UnidentifiedImageError

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 12 * 1024 * 1024
SIZES = {"35x45": (35, 45), "2x2": (50.8, 50.8), "25x35": (25, 35)}
COLORS = {"blue": "#1689df", "white": "#ffffff"}
Image.MAX_IMAGE_PIXELS = 25_000_000
# Vercel functions have a read-only project filesystem. Models must live in /tmp.
if os.environ.get("VERCEL"):
    os.environ.setdefault("U2NET_HOME", os.path.join(tempfile.gettempdir(), ".u2net"))

@lru_cache(maxsize=1)
def background_session():
    from rembg import new_session
    return new_session("u2netp")

def adjustment(value, name, minimum, maximum):
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Invalid {name} setting.") from exc
    if not minimum <= number <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}.")
    return number

def soften_skin(image, strength):
    """Conservative skin-tone smoothing in the upper portrait; no face-shape changes."""
    if not strength:
        return image
    image = image.convert("RGBA")
    rgb = image.convert("RGB")
    # Work at a bounded resolution to keep serverless memory usage predictable.
    ycbcr = rgb.convert("YCbCr")
    pixels = ycbcr.load()
    width, height = image.size
    mask = Image.new("L", image.size, 0)
    mask_pixels = mask.load()
    # Limit to the upper portrait and plausible skin chroma; preserve eyes and sharp edges.
    for y in range(int(height * 0.68)):
        for x in range(width):
            _y, cb, cr = pixels[x, y]
            if 75 <= cb <= 135 and 130 <= cr <= 180 and _y > 45:
                mask_pixels[x, y] = 255
    mask = mask.filter(ImageFilter.GaussianBlur(radius=max(1, width // 180)))
    softened = rgb.filter(ImageFilter.GaussianBlur(radius=max(0.5, width / 350)))
    # Strongest slider value remains moderate to avoid an artificial appearance.
    mask = mask.point(lambda p: round(p * (strength / 100) * 0.65))
    blended = Image.composite(softened, rgb, mask).convert("RGBA")
    blended.putalpha(image.getchannel("A"))
    return blended

def crop_head_and_chest(cutout, dimensions):
    """Frame head, shoulders and upper chest, even in seated/full-body images.

    Estimate head width from the *top* of the foreground silhouette instead
    of the widest point of the body. This is not facial landmark detection.
    """
    subject = cutout.convert("RGBA")
    width, height = subject.size
    # Analyze a small mask to avoid expensive full-resolution pixel loops.
    scale = min(1.0, 320 / max(width, height))
    mask = subject.getchannel("A").resize(
        (max(1, round(width * scale)), max(1, round(height * scale))),
        Image.Resampling.NEAREST,
    ).point(lambda value: 255 if value >= 110 else 0)
    bounds = mask.getbbox()
    if bounds is None:
        return ImageOps.fit(subject, dimensions, method=Image.Resampling.LANCZOS)

    left, top, right, bottom = bounds
    mask_width, mask_height = mask.size
    subject_height = max(1, bottom - top)
    # The head usually occupies the first 12-25% of a visible person.
    # Scan several rows and take the median to ignore hair tips/noise.
    widths = []
    centers = []
    for fraction in (0.10, 0.14, 0.18, 0.22, 0.26):
        y = min(mask_height - 1, top + round(subject_height * fraction))
        row = mask.crop((0, y, mask_width, y + 1)).getbbox()
        if row:
            widths.append(row[2] - row[0])
            centers.append((row[0] + row[2]) / 2)
    if widths:
        sorted_widths = sorted(widths)
        head_width = sorted_widths[len(sorted_widths) // 2]
        center_x = sorted(centers)[len(centers) // 2]
    else:
        head_width = max(1, (right - left) * 0.4)
        center_x = (left + right) / 2

    # Roughly 2.8 head-widths across gives room for both shoulders.
    # Cap zoom-out to prevent legs or furniture entering the frame.
    crop_width = max(head_width * 2.8, mask_width * 0.16)
    crop_width = min(crop_width, mask_width * 0.88)
    crop_height = crop_width * dimensions[1] / dimensions[0]
    crop_top = top - crop_height * 0.09
    crop_left = center_x - crop_width / 2
    factor_x = width / mask_width
    factor_y = height / mask_height
    framed = subject.crop((
        round(crop_left * factor_x),
        round(crop_top * factor_y),
        round((crop_left + crop_width) * factor_x),
        round((crop_top + crop_height) * factor_y),
    ))
    return framed.resize(dimensions, Image.Resampling.LANCZOS)

def crop_around_face(image, dimensions, face, zoom, shift_x, shift_y):
    width, height = image.size
    x, y, w, h = face
    if not (0 <= x <= 1 and 0 <= y <= 1 and 0 < w <= 1 and 0 < h <= 1
            and x + w <= 1.01 and y + h <= 1.01):
        raise ValueError("Invalid face coordinates.")
    crop_height = h * height / 0.37 * 100 / zoom
    crop_width = crop_height * dimensions[0] / dimensions[1]
    center_x = (x + w / 2) * width
    center_y = (y + h / 2) * height
    left = center_x - crop_width / 2 + crop_width * shift_x / 100
    top = center_y - crop_height * 0.36 + crop_height * shift_y / 100
    framed = image.convert("RGBA").crop((round(left), round(top),
                                        round(left + crop_width), round(top + crop_height)))
    return framed.resize(dimensions, Image.Resampling.LANCZOS)

def make_photo(data, background, size_key, smooth=0, brightness=0, face=None, zoom=100, shift_x=0, shift_y=0, auto_enhance=False):
    if background not in COLORS or size_key not in SIZES:
        raise ValueError("Choose a valid background color and photo size.")
    try:
        source = Image.open(io.BytesIO(data))
        source.verify()
        source = Image.open(io.BytesIO(data))
        source = ImageOps.exif_transpose(source)
        source.load()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ValueError("Upload a valid JPG, PNG, or WEBP photo.") from exc
    if source.width * source.height > 25_000_000:
        raise ValueError("Please upload an image under 25 megapixels.")
    smooth = adjustment(smooth, "Face smoothing", 0, 100)
    brightness = adjustment(brightness, "Brightness", -50, 50)
    from rembg import remove
    cutout = remove(source.convert("RGBA"), session=background_session())
    if not isinstance(cutout, Image.Image):
        cutout = Image.open(io.BytesIO(cutout)).convert("RGBA")
    width_mm, height_mm = SIZES[size_key]
    dimensions = (round(width_mm / 25.4 * 300), round(height_mm / 25.4 * 300))
    fitted = (crop_around_face(cutout, dimensions, face, zoom, shift_x, shift_y)
              if face is not None else crop_head_and_chest(cutout, dimensions))
    if auto_enhance:
        from PIL import ImageStat
        rgb = fitted.convert("RGB")
        luminance = ImageStat.Stat(rgb.convert("L")).mean[0]
        if luminance < 105:
            rgb = ImageEnhance.Brightness(rgb).enhance(min(1.20, 115 / max(1, luminance)))
        elif luminance > 205:
            rgb = ImageEnhance.Brightness(rgb).enhance(max(0.90, 195 / luminance))
        rgb = ImageEnhance.Contrast(rgb).enhance(1.035)
        alpha = fitted.getchannel("A")
        fitted = rgb.convert("RGBA")
        fitted.putalpha(alpha)
        smooth = max(smooth, 12)
    fitted = soften_skin(fitted, smooth)
    if brightness:
        soften_skin_alpha = fitted.getchannel("A")
        adjusted_rgb = ImageEnhance.Brightness(fitted.convert("RGB")).enhance(1 + brightness / 100)
        fitted = adjusted_rgb.convert("RGBA")
        fitted.putalpha(soften_skin_alpha)
    backdrop = Image.new("RGBA", dimensions, COLORS[background])
    backdrop.alpha_composite(fitted)
    output = io.BytesIO()
    backdrop.convert("RGB").save(output, format="JPEG", quality=94, dpi=(300, 300), optimize=True)
    output.seek(0)
    return output

@app.get("/")
def index():
    return render_template("index.html")

@app.get("/health")
def health():
    return jsonify(status="ok")

@app.post("/api/process")
def process():
    uploaded = request.files.get("photo")
    if not uploaded or not uploaded.filename:
        return jsonify(error="Please upload a photo first."), 400
    background = request.form.get("background", "blue")
    size = request.form.get("size", "35x45")
    smooth = request.form.get("smooth", "0")
    brightness = request.form.get("brightness", "0")
    if background not in COLORS or size not in SIZES:
        return jsonify(error="Invalid background or photo size."), 400
    data = uploaded.read(12 * 1024 * 1024 + 1)
    if len(data) > 12 * 1024 * 1024:
        return jsonify(error="File exceeds the 12 MB limit."), 413
    try:
        zoom = adjustment(request.form.get("zoom", "100"), "Zoom", 70, 200)
        shift_x = adjustment(request.form.get("shift_x", "0"), "Horizontal position", -40, 40)
        shift_y = adjustment(request.form.get("shift_y", "0"), "Vertical position", -40, 40)
        face_text = request.form.get("face", "")
        face = None
        if face_text:
            parts = face_text.split(",")
            if len(parts) != 4:
                raise ValueError("Invalid face coordinates.")
            face = tuple(float(value) for value in parts)
            if not all(__import__("math").isfinite(value) for value in face):
                raise ValueError("Invalid face coordinates.")
        photo = make_photo(data, background, size, smooth, brightness, face, zoom, shift_x, shift_y, request.form.get('auto_enhance') == 'true')
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    except Exception as exc:
        app.logger.exception("Photo processing failed: %s", type(exc).__name__)
        return jsonify(error="AI background removal failed on the server. Check Vercel Runtime Logs for the detailed error."), 500
    return send_file(photo, mimetype="image/jpeg", download_name=f"passport-{background}-{size}.jpg")

@app.errorhandler(413)
def too_large(_error):
    return jsonify(error="File exceeds the 12 MB limit."), 413

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")))
