import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.TOPAZ_API_KEY;

app.use(express.json({ limit: "2mb" }));

// Shared-password protection for personal deployments.
const APP_PASSWORD = process.env.APP_PASSWORD;
app.use((req, res, next) => {
  if (!APP_PASSWORD) {
    if (process.env.NODE_ENV === "production") {
      return res.status(503).send("Setup incomplete: set APP_PASSWORD in hosting secrets.");
    }
    return next();
  }
  const [scheme, encoded] = (req.headers.authorization || "").split(" ");
  if (scheme === "Basic" && encoded) {
    let decoded = "";
    try { decoded = Buffer.from(encoded, "base64").toString("utf8"); } catch {}
    const colon = decoded.indexOf(":");
    if (colon >= 0 && decoded.slice(colon + 1) === APP_PASSWORD) return next();
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Quality Enhancer Studio", charset="UTF-8"');
  return res.status(401).send("Enter your personal site password.");
});

app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/png", "image/webp", "image/tiff",
      "video/mp4", "video/quicktime", "video/webm", "video/x-matroska"
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Unsupported file type. Try JPG, PNG, WEBP, TIFF, MP4, MOV, WEBM or MKV."));
  }
});

const TOPAZ_IMAGE = "https://api.topazlabs.com/image/v1";
const TOPAZ_VIDEO = "https://api.topazlabs.com/video";

function requireKey(_req, res, next) {
  if (!API_KEY || API_KEY === "put_your_topaz_api_key_here") {
    return res.status(503).json({
      error: "Topaz API key is not configured. Add TOPAZ_API_KEY to your server .env file and restart the server."
    });
  }
  next();
}

async function topazFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "X-API-Key": API_KEY,
      "Accept": "application/json",
      ...(options.headers || {})
    }
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw }; }
  if (!response.ok) {
    const message = data?.message || data?.error || data?.detail || `Topaz API returned HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return data;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, configured: Boolean(API_KEY && API_KEY !== "put_your_topaz_api_key_here") });
});

app.post("/api/enhance/image", requireKey, upload.single("media"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Choose an image first." });
    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "This endpoint is for images. Use the Video tab for video files." });
    }

    const form = new FormData();
    const model = String(req.body.model || "Standard V2");
    const outputFormat = String(req.body.output_format || "jpeg");
    form.append("model", model);
    form.append("output_format", outputFormat);
    form.append("image", new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || "upload.jpg");

    // Only send known, optional numeric controls when the user has provided a value.
    for (const field of ["output_width", "output_height", "sharpen", "denoise", "fix_compression"]) {
      const value = req.body[field];
      if (value !== undefined && value !== "") form.append(field, String(value));
    }
    if (req.body.face_enhancement === "true") {
      form.append("face_enhancement", "true");
      form.append("face_enhancement_strength", String(req.body.face_enhancement_strength || "0.5"));
      form.append("face_enhancement_creativity", String(req.body.face_enhancement_creativity || "0.2"));
    }
    if (req.body.subject_detection) form.append("subject_detection", String(req.body.subject_detection));

    const created = await topazFetch(`${TOPAZ_IMAGE}/enhance/async`, {
      method: "POST",
      body: form
    });
    const processId = created.process_id;
    if (!processId) throw new Error("Topaz did not return a process_id.");

    // Poll the official async image API. The browser sees progress, not the API key.
    const started = Date.now();
    let status = "Queued";
    while (Date.now() - started < 15 * 60 * 1000) {
      await sleep(2000);
      const statusData = await topazFetch(`${TOPAZ_IMAGE}/status/${encodeURIComponent(processId)}`);
      status = statusData.status || "Processing";
      if (status === "Failed" || status === "Cancelled") {
        throw new Error(`Topaz processing ended with status: ${status}`);
      }
      if (status === "Completed") break;
    }
    if (status !== "Completed") throw new Error("Enhancement is taking too long. Try again or check your Topaz API dashboard.");

    const downloadData = await topazFetch(`${TOPAZ_IMAGE}/download/${encodeURIComponent(processId)}`);
    if (!downloadData.url) throw new Error("Topaz finished but did not return a download URL.");

    const outputResponse = await fetch(downloadData.url);
    if (!outputResponse.ok) throw new Error("Could not download the enhanced result from Topaz.");
    const resultBuffer = Buffer.from(await outputResponse.arrayBuffer());
    const mime = outputResponse.headers.get("content-type") || (outputFormat === "png" ? "image/png" : outputFormat === "webp" ? "image/webp" : "image/jpeg");
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="enhanced.${outputFormat === "jpg" ? "jpg" : outputFormat}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(resultBuffer);
  } catch (error) {
    console.error("Image enhancement error:", error.message);
    res.status(error.status && error.status < 500 ? error.status : 502).json({ error: error.message || "Image enhancement failed." });
  }
});

// Video jobs use Topaz's create -> accept -> signed upload -> complete-upload -> status workflow.
// The source metadata is read in the browser; the file is streamed to Topaz's signed URL.
app.post("/api/enhance/video", requireKey, upload.single("media"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Choose a video first." });
    if (!req.file.mimetype.startsWith("video/")) return res.status(400).json({ error: "Choose a video file." });

    const width = Number(req.body.width);
    const height = Number(req.body.height);
    const duration = Number(req.body.duration);
    const frameRate = Number(req.body.frameRate || 30);
    const frameCount = Number(req.body.frameCount || Math.max(1, Math.round(duration * frameRate)));
    const container = String(req.body.container || "mp4").toLowerCase();
    const model = String(req.body.videoModel || "prob-4");

    if (!(width > 0 && height > 0 && duration > 0 && frameRate > 0)) {
      return res.status(400).json({ error: "Could not read video metadata. Try an MP4 or MOV file." });
    }

    const createBody = {
      source: {
        resolution: { width, height },
        container,
        size: req.file.size,
        duration,
        frameRate,
        frameCount
      },
      output: {
        resolution: { width: Math.min(width * 2, 3840), height: Math.min(height * 2, 2160) },
        audioCodec: "AAC",
        audioTransfer: "Copy",
        frameRate,
        dynamicCompressionLevel: "High",
        container: "mp4"
      },
      filters: [{ model }]
    };

    const created = await topazFetch(`${TOPAZ_VIDEO}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBody)
    });
    const requestId = created.requestId || created.request_id;
    if (!requestId) throw new Error("Topaz did not return a video request ID.");

    const accepted = await topazFetch(`${TOPAZ_VIDEO}/${encodeURIComponent(requestId)}/accept`, {
      method: "PATCH"
    });
    const urls = accepted.urls || accepted.uploadUrls || accepted.upload_urls;
    if (!Array.isArray(urls) || !urls.length) {
      throw new Error("Topaz did not return upload URLs. Check the current Video API schema for this account.");
    }

    // The API may return multiple presigned URLs. Split the buffer evenly and retain each ETag.
    const uploadResults = [];
    for (let i = 0; i < urls.length; i++) {
      const start = Math.floor(req.file.buffer.length * i / urls.length);
      const end = Math.floor(req.file.buffer.length * (i + 1) / urls.length);
      const part = req.file.buffer.subarray(start, end);
      const put = await fetch(urls[i], {
        method: "PUT",
        headers: { "Content-Type": req.file.mimetype },
        body: part
      });
      if (!put.ok) throw new Error(`Video upload part ${i + 1} failed (HTTP ${put.status}).`);
      const etag = put.headers.get("etag");
      if (!etag) throw new Error("Upload succeeded but no ETag was returned for a video part.");
      uploadResults.push({ partNum: i + 1, eTag: etag.replaceAll('"', "") });
    }

    await topazFetch(`${TOPAZ_VIDEO}/${encodeURIComponent(requestId)}/complete-upload`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadResults })
    });

    // Keep the request open while checking status; for production hosting, move this to a background job.
    const started = Date.now();
    let state = "Queued";
    let statusData = {};
    while (Date.now() - started < 60 * 60 * 1000) {
      await sleep(5000);
      statusData = await topazFetch(`${TOPAZ_VIDEO}/${encodeURIComponent(requestId)}/status`);
      state = statusData.status || statusData.state || "Processing";
      if (["Completed", "complete", "completed", "Succeeded", "succeeded"].includes(state)) break;
      if (["Failed", "failed", "Cancelled", "cancelled"].includes(state)) {
        throw new Error(`Topaz video processing ended with status: ${state}`);
      }
    }
    const resultUrl = statusData.downloadUrl || statusData.download_url || statusData.url || statusData.output?.url;
    if (!resultUrl) {
      throw new Error(`Video job ${requestId} was submitted, but no finished download URL was returned yet. Check the Topaz API dashboard.`);
    }

    const result = await fetch(resultUrl);
    if (!result.ok) throw new Error("Could not download the enhanced video.");
    res.setHeader("Content-Type", result.headers.get("content-type") || "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="enhanced-video.mp4"');
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    console.error("Video enhancement error:", error.message);
    res.status(error.status && error.status < 500 ? error.status : 502).json({ error: error.message || "Video enhancement failed." });
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "File is too large for this starter server. Maximum upload size is 100 MB." });
  }
  res.status(400).json({ error: err.message || "Request failed." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Quality Enhancer Studio running at http://localhost:${PORT}`);
  console.log(`Topaz API key configured: ${Boolean(API_KEY && API_KEY !== "put_your_topaz_api_key_here")}`);
});
