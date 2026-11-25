import io
import unittest
from app import app, adjustment, soften_skin, crop_head_and_chest, crop_around_face
from PIL import Image

class WebTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
    def test_homepage(self):
        self.assertIn(b"Passport Studio", self.client.get("/").data)
    def test_health(self):
        self.assertEqual(self.client.get("/health").json, {"status": "ok"})
    def test_adjustment_validation(self):
        self.assertEqual(adjustment("25", "Brightness", -50, 50), 25)
        with self.assertRaises(ValueError):
            adjustment("200", "Brightness", -50, 50)

    def test_zero_smoothing_preserves_pixels(self):
        original = Image.new("RGBA", (20, 20), (210, 150, 120, 255))
        self.assertEqual(soften_skin(original, 0).tobytes(), original.tobytes())

    def test_auto_crop_output_dimensions(self):
        image = Image.new("RGBA", (300, 600), (0, 0, 0, 0))
        for y in range(50, 560):
            for x in range(90, 210):
                image.putpixel((x, y), (180, 130, 100, 255))
        cropped = crop_head_and_chest(image, (413, 531))
        self.assertEqual(cropped.size, (413, 531))
        self.assertEqual(cropped.mode, "RGBA")

    def test_full_body_crop_excludes_legs(self):
        from PIL import ImageDraw
        image = Image.new("RGBA", (300, 700), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        draw.ellipse((125, 40, 175, 120), fill=(200, 150, 120, 255))
        draw.rectangle((75, 120, 225, 350), fill=(240, 240, 240, 255))
        draw.rectangle((55, 350, 245, 680), fill=(255, 0, 0, 255))
        cropped = crop_head_and_chest(image, (413, 531))
        self.assertEqual(cropped.size, (413, 531))
        self.assertFalse(any(r > 230 and g < 30 and b < 30 and a > 100
                             for r, g, b, a in cropped.getdata()))

    def test_empty_foreground_fallback(self):
        image = Image.new("RGBA", (100, 200), (0, 0, 0, 0))
        self.assertEqual(crop_head_and_chest(image, (200, 260)).size, (200, 260))

    def test_face_crop_and_zoom(self):
        image = Image.new("RGBA", (600, 900), (120, 80, 60, 255))
        face = (0.4, 0.15, 0.2, 0.15)
        a = crop_around_face(image, (413, 531), face, 100, 0, 0)
        b = crop_around_face(image, (413, 531), face, 150, 0, 0)
        self.assertEqual(a.size, (413, 531))
        self.assertEqual(b.size, (413, 531))
        with self.assertRaises(ValueError):
            crop_around_face(image, (413, 531), (2, 0, 0.2, 0.2), 100, 0, 0)

    def test_missing_upload(self):
        self.assertEqual(self.client.post("/api/process").status_code, 400)
    def test_invalid_background(self):
        response = self.client.post("/api/process", data={"photo": (io.BytesIO(b"x"), "photo.jpg"), "background": "green"})
        self.assertEqual(response.status_code, 400)
    def test_bad_image(self):
        response = self.client.post("/api/process", data={"photo": (io.BytesIO(b"x"), "photo.jpg")})
        self.assertEqual(response.status_code, 400)

if __name__ == "__main__":
    unittest.main()
