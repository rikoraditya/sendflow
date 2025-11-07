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

// 🧩 Tambahkan middleware untuk parsing body (JSON & form-urlencoded)
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// =============================
// 🗄️ PostgreSQL (Supabase) Setup
// =============================
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false },
});

// ✅ Tes koneksi DB
(async () => {
  try {
    await pool.query("SELECT 1");
    console.log("✅ Supabase Database connected successfully");

    // Pastikan tabel reply sudah ada
    await pool.query(`
      CREATE TABLE IF NOT EXISTS reply (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(20),
        message TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

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
// 📁 Setup Upload Folder
// =============================
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
const upload = multer({ dest: "uploads/" });

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
app.post("/api/upload", upload.single("file"), async (req, res) => {
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
      const rawPhone = row.phone || row.Phone || "";
      const phone = normalizePhone(rawPhone);
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
    res.json({
      success: true,
      message: `✅ ${inserted} kontak berhasil diupload & diperbarui.`,
    });
  } catch (err) {
    console.error("❌ Upload gagal:", err.message);
    res.status(500).json({ success: false, message: "Upload gagal." });
  }
});

// =============================
// 📱 Kirim Pesan Batch (20 kontak / 5 menit)
// =============================
app.post("/api/send", async (req, res) => {
  const { message_template, reminder_template } = req.body;
  try {
    const { rows: contacts } = await pool.query(
      "SELECT * FROM contacts WHERE status IN ('pending','failed')"
    );
    if (contacts.length === 0)
      return res.json({
        success: false,
        message: "Tidak ada kontak untuk dikirim.",
      });

    console.log(`🚀 Mulai kirim ${contacts.length} kontak dalam batch 20 tiap 5 menit`);

    const batches = [];
    for (let i = 0; i < contacts.length; i += 20) {
      batches.push(contacts.slice(i, i + 20));
    }

    let batchIndex = 0;
    const processBatch = async () => {
      if (batchIndex >= batches.length) {
        console.log("✅ Semua batch selesai dikirim.");
        return;
      }

      const batch = batches[batchIndex];
      console.log(`📦 Batch ${batchIndex + 1}/${batches.length}`);

      for (const c of batch) {
        const phone = normalizePhone(c.phone);
        if (!phone) continue;

        let msg = message_template.replace(/{name}/g, c.name);
        msg = msg.replace(/NIK:? ?{nik}/gi, "").replace(/{nik}/g, "");

        const form = new FormData();
        form.append("target", phone);
        form.append("message", msg);

        try {
          const resp = await axios.post("https://api.fonnte.com/send", form, {
            headers: { Authorization: process.env.FONNTE_TOKEN, ...form.getHeaders() },
          });

          if (resp.data.status) {
            await pool.query(
              `
              UPDATE contacts 
              SET status='sent', last_sent=NOW(), reminder_message=$1, reminder_count=0
              WHERE id=$2
            `,
              [reminder_template, c.id]
            );
            console.log(`✅ Terkirim ke ${c.name}`);
          } else {
            await pool.query("UPDATE contacts SET status='failed' WHERE id=$1", [c.id]);
          }
        } catch (err) {
          console.log(`⚠️ Gagal kirim ke ${c.phone}: ${err.message}`);
        }

        await new Promise((r) => setTimeout(r, 2000)); // jeda antar pesan
      }

      batchIndex++;
      if (batchIndex < batches.length) {
        console.log("⏳ Tunggu 5 menit sebelum batch berikutnya...");
        setTimeout(processBatch, 5 * 60 * 1000);
      }
    };

    processBatch();
    res.json({
      success: true,
      message: `Pengiriman dimulai — total ${contacts.length} kontak dalam ${batches.length} batch.`,
    });
  } catch (err) {
    console.error("❌ Error kirim:", err.message);
    res.status(500).json({ success: false, message: "Gagal kirim pesan." });
  }
});

// =============================
// 🔁 Reminder Otomatis (tiap jam WITA)
// =============================
cron.schedule("0 * * * *", async () => {
  try {
    console.log("⏰ Cek reminder otomatis...");
    const { rows } = await pool.query(`
      SELECT * FROM contacts
      WHERE status='sent'
      AND (last_reply IS NULL OR status!='dibalas')
      AND reminder_count < 2
      AND NOW() - last_sent >= INTERVAL '24 hours'
    `);

    for (const c of rows) {
      const phone = normalizePhone(c.phone);
      if (!phone) continue;

      const reminderMsg =
        c.reminder_message || `Halo ${c.name}, ini pengingat dari kami 🙏`;

      const form = new FormData();
      form.append("target", phone);
      form.append("message", reminderMsg);

      try {
        await axios.post("https://api.fonnte.com/send", form, {
          headers: { Authorization: process.env.FONNTE_TOKEN, ...form.getHeaders() },
        });

        await pool.query(
          `
          UPDATE contacts
          SET status='reminded',
              reminder_count = reminder_count + 1,
              last_sent=NOW()
          WHERE id=$1
        `,
          [c.id]
        );

        console.log(`🔁 Reminder ke-${c.reminder_count + 1} terkirim ke ${c.name}`);
      } catch (err) {
        console.log(`⚠️ Reminder gagal ke ${c.phone}: ${err.message}`);
      }

      await new Promise((r) => setTimeout(r, 3000));
    }
  } catch (err) {
    console.error("❌ Error CRON reminder:", err.message);
  }
});

// =============================
// 📩 Webhook Fonnte → Balasan User
// =============================
app.post("/webhook/fonnte", async (req, res) => {
  try {
    const data = req.body;
    console.log("📬 Webhook Fonnte diterima:", data);

    const { phone, message } = data;
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return res.sendStatus(400);

    // Simpan isi balasan user
    await pool.query(
      `INSERT INTO reply (phone, message, created_at)
       VALUES ($1, $2, NOW())`,
      [normalizedPhone, message]
    );

    // Update status kontak ke 'dibalas'
    await pool.query(
      `UPDATE contacts
       SET status='dibalas', last_reply=NOW()
       WHERE phone=$1`,
      [normalizedPhone]
    );

    console.log(`💬 ${normalizedPhone} membalas: "${message}"`);
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error webhook Fonnte:", err.message);
    res.sendStatus(500);
  }
});

// =============================
// 📋 API Kontak
// =============================
app.get("/api/contacts", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM contacts ORDER BY created_at DESC");
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
  console.log(`🚀 WhatsApp Auto Reminder running at http://localhost:${PORT} (WITA)`);
});
