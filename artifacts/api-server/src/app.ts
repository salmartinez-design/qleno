import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";

// Works in both ESM (tsx dev) and CJS (esbuild prod bundle).
// In CJS, __dirname is a global string; typeof check avoids ReferenceError in ESM.
// In ESM, __dirname is not defined so we derive it from import.meta.url.
// eslint-disable-next-line no-undef
const __appDir: string =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const uploadsDir = path.resolve(__appDir, "../uploads");
process.env.UPLOADS_DIR = uploadsDir;
app.use("/api/uploads", express.static(uploadsDir, { maxAge: "1d" }));

const pdfsDir = path.resolve(__appDir, "../pdfs");
process.env.PDFS_DIR = pdfsDir;
app.use("/api/pdfs", express.static(pdfsDir, { maxAge: "1h" }));

app.use("/api", router);

export default app;
