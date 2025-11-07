// 🕒 Set timezone ke Bali (WITA)
process.env.TZ = "Asia/Makassar";

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
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// =============================
// 🗄️ PostgreSQL (Supabase)
// =============================
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  try {
    await pool.query("SELECT 1");
    console.log("✅ Supabase Database connected");
    console.log(
      "🕓 Server timezone:",
      new Date().toLocaleString("id-ID", { timeZone: "Asia/Makassar" })
    );
  } catch (err) {
    console.error("❌ Database connection failed:", err.message);
    process.exit(1);
  }
})();

// =============================
// ☎️ Normalisasi Nomor HP
// =============================
function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/\D/g, "");
  if (p.startsWith("0")) p = "62" + p.slice(1);
  else if (!p.startsWith("62")) p = "62" + p;
  return p.length < 10 ? null : p;
}

// =============================
// 📤 Upload Excel → Simpan ke DB
// =============================
import upload from "multer";
const uploader = upload({ dest: "uploads/" });

app.post("/api/upload", uploader.single("file"), async (req, res) => {
  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = XLSX.utils.sheet_to_json(
      workbook.Sheets[workbook.SheetNames[0]],
      { defval: "" }
    );
    let inserted = 0;

    for (const row of sheet) {
      const nik = String(row.nik || row.NIK || "").trim();
      const name = String(row.name || row.Name || "").trim();
      const phone = normalizePhone(row.phone || row.Phone || "");
      if (!nik || !name || !phone) continue;

      await pool.query(
        `
        INSERT INTO contacts (nik, name, phone, status, reminder_count, created_at)
        VALUES ($1, $2, $3, 'pending', 0, NOW())
        ON CONFLICT (nik) DO UPDATE 
        SET name = EXCLUDED.name,
            phone = EXCLUDED.phone,
            status = 'pending',
            reminder_count = 0,
            last_sent = NULL,
            last_reply = NULL
      `,
        [nik, name, phone]
      );
      inserted++;
    }

    fs.unlinkSync(req.file.path);
    res.json({ success: true, message: `✅ ${inserted} kontak berhasil diupload.` });
  } catch (err) {
    console.error("❌ Upload gagal:", err.message);
    res.status(500).json({ success: false, message: "Upload gagal." });
  }
});

// =============================
// 📩 Webhook Fonnte → Balasan Pasien
// =============================
app.post("/webhook/fonnte", async (req, res) => {
  try {
    const data = req.body;
    const phone = data.phone || data.sender;
    const message = data.message || "";

    // Log ke file agar bisa dilihat di Railway (untuk debugging)
    fs.appendFileSync(
      path.join(__dirname, "webhook.log"),
      `[${new Date().toLocaleString("id-ID", { timeZone: "Asia/Makassar" })}] ${JSON.stringify(
        data
      )}\n`
    );

    // Jika bukan pesan masuk (status update)
    if (!phone || !message) {
      console.log("ℹ️ Webhook status update diterima, bukan pesan pasien.");
      return res.sendStatus(200);
    }

    console.log("📬 Webhook Fonnte diterima:", data);

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return res.status(400).send("Nomor tidak valid");

    const { rows } = await pool.query(
      "SELECT id FROM contacts WHERE phone=$1 LIMIT 1",
      [normalizedPhone]
    );
    if (rows.length === 0) {
      console.log("⚠️ Nomor tidak terdaftar:", normalizedPhone);
      return res.sendStatus(200);
    }

    const contactId = rows[0].id;

    // 🔹 Hapus balasan lama agar 1 row per contact
    await pool.query("DELETE FROM reply WHERE contact_id=$1", [contactId]);

    // 🔹 Simpan balasan baru
    await pool.query(
      `INSERT INTO reply (contact_id, phone, message, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [contactId, normalizedPhone, message]
    );

    // 🔹 Update status di contacts
    await pool.query(
      `UPDATE contacts SET status='replied', last_reply=NOW() WHERE id=$1`,
      [contactId]
    );

    console.log(`💬 Balasan masuk dari ${normalizedPhone}: "${message}"`);
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error webhook:", err.message);
    res.status(500).send("Internal Server Error");
  }
});

// =============================
// 📋 API Kontak (termasuk balasan terakhir)
// =============================
app.get("/api/contacts", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*,
             (
               SELECT r.message 
               FROM reply r 
               WHERE r.contact_id = c.id 
               ORDER BY r.created_at DESC 
               LIMIT 1
             ) AS last_reply_message
      FROM contacts c
      ORDER BY c.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("❌ Error ambil kontak:", err.message);
    res.status(500).json({ success: false, message: "Gagal ambil data kontak." });
  }
});

// =============================
// 🌐 Halaman Utama
// =============================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// =============================
// 🚀 Jalankan Server
// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT} (WITA)`);
});
