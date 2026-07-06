require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const paymentRoutes = require("./routes/payment.routes");

const app = express();

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/webhook/payout", paymentRoutes);
app.use("/api", paymentRoutes);

app.get("/deposit", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "deposit.html"));
});

app.get("/jay/deposit", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "jay-deposit.html"));
});

app.get("/admin", (req, res) => {
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
