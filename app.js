// =============================
// 🕒 Timezone
// =============================
process.env.TZ = "Asia/Makassar";

// =============================
// 📦 Import Library
// =============================
import express from "express";
import multer from "multer";
import XLSX from "xlsx";
import axios from "axios";
import cron from "node-cron";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();
const { Pool } = pkg;

// =============================
// 🗄️ PostgreSQL Connection
// =============================
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false },
});

// =============================
// 🚀 Express App
// =============================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============================
// 📁 Upload Config
// =============================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 5 * 1024 * 1024 },
});

// =============================
// 📥 Upload Excel & Simpan kontak
// =============================
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.json({ success: false, message: "File tidak ditemukan" });
    }

    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet);

    let totalInsert = 0;

    for (let row of json) {
      if (!row.phone) continue;

      await pool.query(
        "INSERT INTO contacts (nik, name, phone, status) VALUES ($1,$2,$3,'pending')",
        [row.nik || "", row.name || "", row.phone]
      );
      totalInsert++;
    }

    fs.unlinkSync(req.file.path);

    res.json({ success: true, message: "Upload berhasil", total: totalInsert });
  } catch (err) {
    res.json({
      success: false,
      message: "Gagal upload",
      error: err.toString(),
    });
  }
});

// =============================
// 💬 Twilio SMS Gateway
// =============================
import twilio from "twilio";

const client = new twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendSMS(to, message) {
  try {
    const res = await client.messages.create({
      body: message,
      from: process.env.TWILIO_NUMBER,
      to: to.startsWith("+") ? to : "+62" + to.replace(/^0/, "")
    });

    return { success: true, sid: res.sid };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// =============================
// 🚀 Kirim batch
// =============================
app.post("/api/send", async (req, res) => {
  try {
    const { rows: contacts } = await pool.query(
      "SELECT * FROM contacts WHERE status='pending' ORDER BY created_at ASC LIMIT 20"
    );

    if (contacts.length === 0) {
      return res.json({ success: false, message: "Tidak ada kontak pending" });
    }

    for (let c of contacts) {
      const msg = req.body.message_template
        .replace("{name}", c.name)
        .replace("{phone}", c.phone);

      await sendSMS(c.phone, msg);

      await pool.query(
        "UPDATE contacts SET status='sent', last_sent=NOW() WHERE id=$1",
        [c.id]
      );
    }

    res.json({
      success: true,
      message: `Berhasil mengirim ${contacts.length} SMS`,
    });
  } catch (err) {
    res.json({ success: false, error: err.toString() });
  }
});

// =============================
// 📥 Webhook menerima SMS balasan
// =============================
app.post("/api/sms/webhook", async (req, res) => {
  try {
    const from = req.body.From;
    const message = req.body.Body;

    await pool.query(
      "UPDATE contacts SET last_reply_message=$1, last_reply_at=NOW() WHERE phone LIKE $2",
      [message, "%" + from.slice(-10)]
    );

    res.send("<Response></Response>");
  } catch (err) {
    res.status(500).send("Error");
  }
});

// =============================
// 🚀 Start Server
// =============================
app.listen(process.env.PORT, () => {
  console.log("Server berjalan di port " + process.env.PORT);
});
