import express, { type Express } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const uploadsDir = path.resolve(__dirname, "../uploads");
process.env.UPLOADS_DIR = uploadsDir;
app.use("/api/uploads", express.static(uploadsDir, { maxAge: "1d" }));

app.use("/api", router);

export default app;
