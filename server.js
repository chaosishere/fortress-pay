require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const paymentRoutes = require("./routes/payment.routes");

const app = express();

function getFrameAncestors() {
  return (process.env.B2CORE_FRAME_ANCESTORS || "'self' https://my.fortressfx.com")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .join(" ");
}

function setIframeHeaders(req, res, next) {
  res.setHeader("Content-Security-Policy", `frame-ancestors ${getFrameAncestors()}`);
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
}

function isEnvEnabled(name, fallback) {
  const value = process.env[name];

  if (typeof value === "undefined" || value === "") {
    return fallback;
  }

  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function requireDefaultPaymentPage(req, res, next) {
  if (!isEnvEnabled("DEFAULT_PAYMENT_PAGE_ENABLED", true)) {
    return res.status(404).send("Payment page disabled");
  }

  next();
}

function denyFrameHeaders(req, res, next) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  next();
}

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "1mb" }));
app.use(["/deposit.html", "/jay-deposit.html"], requireDefaultPaymentPage, setIframeHeaders);
app.use("/admin.html", denyFrameHeaders);
app.use(express.static(path.join(__dirname, "public")));

app.post("/webhook/payout", paymentRoutes);
app.use("/api", paymentRoutes);

app.get("/deposit", requireDefaultPaymentPage, (req, res) => {
  setIframeHeaders(req, res, () => {});
  res.sendFile(path.join(__dirname, "public", "deposit.html"));
});

app.get("/jay/deposit", requireDefaultPaymentPage, (req, res) => {
  setIframeHeaders(req, res, () => {});
  res.sendFile(path.join(__dirname, "public", "jay-deposit.html"));
});

app.get("/b2core/deposit", requireDefaultPaymentPage, setIframeHeaders, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "deposit.html"));
});

app.get("/b2core/jay/deposit", requireDefaultPaymentPage, setIframeHeaders, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "jay-deposit.html"));
});

app.get("/admin", (req, res) => {
  denyFrameHeaders(req, res, () => {});
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/", (req, res) => {
  res.send("Fortress Pay Gateway Running");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

server.keepAliveTimeout = Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS || 65000);
server.headersTimeout = Number(process.env.HTTP_HEADERS_TIMEOUT_MS || 66000);

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
  process.exit(1);
});
