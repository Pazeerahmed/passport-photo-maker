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

def make_photo(data, background, size_key, smooth=0, brightness=0):
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
    fitted = ImageOps.fit(cutout.convert("RGBA"), dimensions, method=Image.Resampling.LANCZOS, centering=(0.5, 0.32))
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
        photo = make_photo(data, background, size, smooth, brightness)
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
