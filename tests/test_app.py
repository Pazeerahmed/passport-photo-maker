import io
import unittest
from app import app

class WebTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
    def test_homepage(self):
        self.assertIn(b"Passport Studio", self.client.get("/").data)
    def test_health(self):
        self.assertEqual(self.client.get("/health").json, {"status": "ok"})
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
