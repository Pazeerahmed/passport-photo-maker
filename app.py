import io
import os
from flask import Flask, jsonify, render_template, request, send_file
from PIL import Image, ImageOps, UnidentifiedImageError

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 12 * 1024 * 1024
SIZES = {"35x45": (35, 45), "2x2": (50.8, 50.8), "25x35": (25, 35)}
COLORS = {"blue": "#1689df", "white": "#ffffff"}
Image.MAX_IMAGE_PIXELS = 25_000_000

def make_photo(data, background, size_key):
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
    from rembg import remove
    cutout = remove(source.convert("RGBA"))
    if not isinstance(cutout, Image.Image):
        cutout = Image.open(io.BytesIO(cutout)).convert("RGBA")
    width_mm, height_mm = SIZES[size_key]
    dimensions = (round(width_mm / 25.4 * 300), round(height_mm / 25.4 * 300))
    fitted = ImageOps.fit(cutout.convert("RGBA"), dimensions, method=Image.Resampling.LANCZOS, centering=(0.5, 0.32))
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
    if background not in COLORS or size not in SIZES:
        return jsonify(error="Invalid background or photo size."), 400
    data = uploaded.read(12 * 1024 * 1024 + 1)
    if len(data) > 12 * 1024 * 1024:
        return jsonify(error="File exceeds the 12 MB limit."), 413
    try:
        photo = make_photo(data, background, size)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    except Exception:
        app.logger.exception("Photo processing failed")
        return jsonify(error="Could not process this photo. Please try again."), 500
    return send_file(photo, mimetype="image/jpeg", download_name=f"passport-{background}-{size}.jpg")

@app.errorhandler(413)
def too_large(_error):
    return jsonify(error="File exceeds the 12 MB limit."), 413

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")))
