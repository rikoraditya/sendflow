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
// 📁 Upload Excel → Simpan ke DB
// =============================
const upload = multer({ dest: "uploads/" });

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
// 🛡️ SAFE MODE — Pengiriman Sangat Aman
// Batch 5 kontak • Delay 7 detik • Batch delay 12 menit • Retry otomatis
// =============================
app.post("/api/send", async (req, res) => {
  const { message_template, reminder_template } = req.body;

  try {
    const { rows: contacts } = await pool.query(
      "SELECT * FROM contacts WHERE status IN ('pending','failed') ORDER BY created_at ASC"
    );

    if (contacts.length === 0)
      return res.json({ success: false, message: "Tidak ada kontak untuk dikirim." });

    console.log(`🛡️ SAFE MODE aktif — ${contacts.length} kontak akan dikirim aman & bertahap.`);

    // 🔹 Batch hanya 5 kontak
    const batches = [];
    for (let i = 0; i < contacts.length; i += 5) {
      batches.push(contacts.slice(i, i + 5));
    }

    let batchIndex = 0;
    let totalFailed = 0;

    // 🔁 Fungsi retry (maks 3x)
    async function sendWithRetry(phone, msg, retries = 3) {
      let form = new FormData();
      form.append("target", phone);
      form.append("message", msg);

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const resp = await axios.post("https://api.fonnte.com/send", form, {
            headers: { Authorization: process.env.FONNTE_TOKEN, ...form.getHeaders() },
          });

          if (resp.data.status) return { success: true };
        } catch (e) {
          console.log(`⚠️ Retry ${attempt}/${retries} gagal untuk ${phone}`);
        }

        await new Promise((r) => setTimeout(r, 5000)); // jeda 5 detik antar retry
      }

      return { success: false };
    }

    // 🚀 Mulai proses
    const processBatch = async () => {
      if (batchIndex >= batches.length) {
        console.log("🎉 Semua batch selesai.");
        return;
      }

      const batch = batches[batchIndex];
      console.log(`📦 SAFE BATCH ${batchIndex + 1}/${batches.length}`);

      let failedInBatch = 0;

      for (const c of batch) {
        const phone = normalizePhone(c.phone);
        if (!phone) continue;

        const msg = message_template.replace(/{name}/g, c.name);

        // 🔁 Kirim dengan retry
        const result = await sendWithRetry(phone, msg);

        if (result.success) {
          await pool.query(
            `UPDATE contacts SET status='sent', last_sent=NOW(), reminder_message=$1 WHERE id=$2`,
            [reminder_template, c.id]
          );
          console.log(`✅ Terkirim ke ${c.name}`);
        } else {
          failedInBatch++;
          totalFailed++;
          await pool.query("UPDATE contacts SET status='failed' WHERE id=$1", [c.id]);
          console.log(`❌ Gagal kirim ke ${c.name} (${phone})`);
        }

        // ⏱️ Aman: jeda 7 detik antar orang
        await new Promise((r) => setTimeout(r, 7000));
      }

      // 🛑 AUTO-PAUSE bila 3 orang gagal dalam batch
      if (failedInBatch >= 3) {
        console.log("🛑 Pengiriman dihentikan — terlalu banyak gagal di 1 batch (≥ 3).");
        return;
      }

      // 🛑 AUTO-PAUSE bila gagal total lebih dari 10%
      if (totalFailed / contacts.length > 0.1) {
        console.log("🛑 Pengiriman dihentikan — lebih dari 10% kontak gagal. Lindungi nomor WA.");
        return;
      }

      batchIndex++;

      if (batchIndex < batches.length) {
        console.log("⏳ SAFE MODE delay 12 menit sebelum batch berikutnya...");
        setTimeout(processBatch, 12 * 60 * 1000);
      }
    };

    processBatch();

    res.json({
      success: true,
      message: `SAFE MODE aktif — pengiriman dimulai. Total ${contacts.length} kontak dalam ${batches.length} batch.`,
    });
  } catch (err) {
    console.error("❌ Error SAFE MODE:", err.message);
    res.status(500).json({ success: false, message: "Gagal memulai SAFE MODE." });
  }
});

// =============================
// 🔁 Reminder Otomatis Tiap Jam (24 jam setelah pesan dikirim)
// =============================
cron.schedule("0 * * * *", async () => {
  try {
    console.log("⏰ Cek reminder otomatis...");
    const { rows } = await pool.query(`
      SELECT * FROM contacts
      WHERE status='sent'
      AND (last_reply IS NULL OR status!='replied')
      AND reminder_count < 2
      AND NOW() - last_sent >= INTERVAL '24 hours'
    `);

    for (const c of rows) {
      const phone = normalizePhone(c.phone);
      if (!phone) continue;

      const reminderMsg = c.reminder_message || `Halo ${c.name}, ini pengingat dari kami 🙏`;

      const form = new FormData();
      form.append("target", phone);
      form.append("message", reminderMsg);

      try {
        await axios.post("https://api.fonnte.com/send", form, {
          headers: { Authorization: process.env.FONNTE_TOKEN, ...form.getHeaders() },
        });

        await pool.query(
          `UPDATE contacts SET status='reminded', reminder_count = reminder_count + 1, last_sent=NOW() WHERE id=$1`,
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
// 📩 Webhook Fonnte → Balasan Pasien
// =============================
app.post("/webhook/fonnte", async (req, res) => {
  try {
    const data = req.body;
    const phone = data.phone || data.sender;
    const message = data.message || "";

    fs.appendFileSync(
      path.join(__dirname, "webhook.log"),
      `[${new Date().toLocaleString("id-ID", { timeZone: "Asia/Makassar" })}] ${JSON.stringify(
        data,
        null,
        2
      )}\n\n`
    );

    if (!phone || !message) return res.sendStatus(200);

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return res.status(400).send("Nomor tidak valid");

    const { rows } = await pool.query(
      "SELECT id FROM contacts WHERE phone=$1 LIMIT 1",
      [normalizedPhone]
    );
    if (rows.length === 0) return res.sendStatus(200);

    const contactId = rows[0].id;

    await pool.query("DELETE FROM reply WHERE contact_id=$1", [contactId]);
    await pool.query(
      `INSERT INTO reply (contact_id, phone, message, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [contactId, normalizedPhone, message]
    );

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