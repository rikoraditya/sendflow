// 🕒 Set timezone ke Bali (WITA)
process.env.TZ = "Asia/Makassar";

import express from "express";
import multer from "multer";
import XLSX from "xlsx";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

import { Vonage } from "@vonage/server-sdk";
import pkg from "pg";
const { Pool } = pkg;

dotenv.config();
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// PostgreSQL Connection
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT
});

// Vonage SMS Client
const vonage = new Vonage({
  apiKey: process.env.VONAGE_API_KEY,
  apiSecret: process.env.VONAGE_API_SECRET
});

// File Upload (Excel)
const upload = multer({ dest: "uploads/" });

// Serve static UI
app.use(express.static("public"));

// Upload Excel → Simpan ke DB
app.post("/api/contacts/upload", upload.single("file"), async (req, res) => {
  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    let inserted = 0;

    for (const row of rows) {
      if (!row.phone) continue;

      await pool.query(
        "INSERT INTO contacts (name, phone, status) VALUES ($1,$2,'pending')",
        [row.name || "No Name", row.phone]
      );
      inserted++;
    }

    fs.unlinkSync(req.file.path);

    res.json({ success: true, inserted });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Upload gagal" });
  }
});

// Kirim SMS (manual)
app.post("/api/send", async (req, res) => {
  const { message } = req.body;

  if (!message) return res.status(400).json({ error: "Message kosong" });

  const { rows: contacts } = await pool.query(
    "SELECT * FROM contacts WHERE status='pending' LIMIT 20"
  );

  for (const c of contacts) {
    try {
      await vonage.sms.send({
        to: c.phone,
        from: process.env.VONAGE_FROM,
        text: message
      });

      await pool.query(
        "UPDATE contacts SET status='sent', sent_at=NOW() WHERE id=$1",
        [c.id]
      );
    } catch (err) {
      console.error(err);
      await pool.query(
        "UPDATE contacts SET status='failed' WHERE id=$1",
        [c.id]
      );
    }
  }

  res.json({ success: true, sent: contacts.length });
});

// Cron job kirim otomatis tiap 5 menit
cron.schedule("*/5 * * * *", async () => {
  console.log("CRON: Mengirim batch 20 SMS…");

  const { rows: contacts } = await pool.query(
    "SELECT * FROM contacts WHERE status='pending' LIMIT 20"
  );

  for (const c of contacts) {
    try {
      await vonage.sms.send({
        to: c.phone,
        from: process.env.VONAGE_FROM,
        text: "Reminder dari Klinik"
      });

      await pool.query(
        "UPDATE contacts SET status='sent', sent_at=NOW() WHERE id=$1",
        [c.id]
      );
    } catch (err) {
      console.error(err);
    }
  }
});

// Inbound SMS Webhook dari Vonage
app.post("/webhook/sms", async (req, res) => {
  const sig = req.headers["x-webhook-secret"];
  if (sig !== process.env.VONAGE_WEBHOOK_SECRET)
    return res.status(403).send("Invalid secret");

  const { msisdn, text } = req.body;
  console.log("INBOUND SMS:", msisdn, text);

  // Simpan ke DB
  await pool.query(
    "INSERT INTO inbound_sms (phone, message) VALUES ($1,$2)",
    [msisdn, text]
  );

  res.json({ ok: true });
});

app.listen(process.env.PORT, () =>
  console.log(`Server berjalan di port ${process.env.PORT}`)
);
