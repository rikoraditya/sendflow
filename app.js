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
import FormData from "form-data";
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
app.post("/upload", upload.single("file"), async (req, res) => {
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

    res.json({ success: true, total: totalInsert, data: json });
  } catch (err) {
    res.json({ success: false, message: "Gagal upload", error: err.toString() });
  }
});

// =============================
// 💬 Kirim SMS via Zuwinda
// =============================
async function sendSMS(to, message) {
  try {
    const response = await axios.post(
      process.env.SMS_API_URL,
      {
        api_key: process.env.SMS_API_KEY,
        sender_id: process.env.SMS_SENDER_ID,
        to,
        message,
      }
    );
    return response.data;
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

// =============================
// 🚀 Kirim pesan batch (20 kontak per 5 menit)
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
      await sendSMS(c.phone, req.body.message_template);

      await pool.query(
        "UPDATE contacts SET status='sent', sent_at=NOW() WHERE id=$1",
        [c.id]
      );
    }

    res.json({
      success: true,
      sent: contacts.length,
    });
  } catch (err) {
    res.json({ success: false, error: err.toString() });
  }
});

// =============================
// 🕒 Cron job setiap 5 menit
// =============================
cron.schedule("*/5 * * * *", async () => {
  console.log("⏳ Cron: cek kontak pending...");

  const { rows } = await pool.query(
    "SELECT * FROM contacts WHERE status='pending' ORDER BY created_at ASC LIMIT 20"
  );

  for (let c of rows) {
    await sendSMS(c.phone, "Reminder otomatis dari sistem");
    await pool.query(
      "UPDATE contacts SET status='sent', sent_at=NOW() WHERE id=$1",
      [c.id]
    );
  }
});

// =============================
// 🚀 Start Server
// =============================
app.listen(process.env.PORT, () => {
  console.log(`Server berjalan pada port ${process.env.PORT}`);
});
