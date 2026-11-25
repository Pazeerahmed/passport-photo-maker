import io
import unittest
from app import app, adjustment, soften_skin
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
