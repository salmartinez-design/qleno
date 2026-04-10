import { Router, type Request, type Response } from "express";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage.js";
import { requireAuth } from "../lib/auth.js";

const router = Router();
const storage = new ObjectStorageService();

router.post("/request-url", requireAuth, async (req: Request, res: Response) => {
  const { name, size, contentType } = req.body;
  if (!name || !contentType) {
    res.status(400).json({ error: "name and contentType are required" });
    return;
  }
  try {
    const uploadURL = await storage.getObjectEntityUploadURL();
    const objectPath = storage.normalizeObjectEntityPath(uploadURL);
    res.json({ uploadURL, objectPath });
  } catch (err) {
    console.error("POST /photos/request-url:", err);
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

router.get("/objects/*path", requireAuth, async (req: Request, res: Response) => {
  const raw = req.params.path;
  const rawPath = "/objects/" + (Array.isArray(raw) ? raw.join("/") : raw);
  try {
    const file = await storage.getObjectEntityFile(rawPath);
    const response = await storage.downloadObject(file);
    const headers = Object.fromEntries(response.headers.entries());
    res.set(headers);
    res.status(response.status);
    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    console.error("GET /photos/objects/*:", err);
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
