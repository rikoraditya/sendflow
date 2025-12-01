// PART 1/4
// =============================
// 🕒 Timezone & Imports
// =============================
process.env.TZ = "Asia/Makassar";

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

// test db connection
(async () => {
  try {
    await pool.query("SELECT 1");
    console.log("✅ Database connected");
  } catch (err) {
    console.error("❌ DB connection failed:", err.message);
    process.exit(1);
  }
})();

// =============================
// 🚀 Express App + Static
// =============================
const app = express();
app.use(express.json());
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// =============================
// ☎️ Normalisasi Nomor HP
// =============================
function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/\D/g, "");
  if (p.startsWith("0")) p = "62" + p.slice(1);
  else if (!p.startsWith("62")) p = "62" + p;
  // minimal length 10 (62x...)
  return p.length < 10 ? null : p;
}

// =============================
// 📁 Upload Config (multer)
// =============================
const upload = multer({ dest: "uploads/" , limits: { fileSize: 10 * 1024 * 1024 }});

// =============================
// 📥 Upload Excel → Simpan ke DB
// Routes supported: /api/upload and /upload
// =============================
async function handleUploadFile(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "File tidak ditemukan" });

    const workbook = XLSX.readFile(req.file.path);
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });

    let inserted = 0;
    for (const row of sheet) {
      const nik = String(row.nik || row.NIK || row.NIK?.toString?.() || "").trim();
      const name = String(row.name || row.Name || row.nama || "").trim();
      const phoneRaw = row.phone || row.Phone || row.no || row.telepon || "";
      const phone = normalizePhone(phoneRaw);

      if (!nik || !name || !phone) continue;

      await pool.query(
        `INSERT INTO contacts (nik, name, phone, status, reminder_count, created_at)
         VALUES ($1,$2,$3,'pending',0,NOW())
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

    // remove upload
    try { fs.unlinkSync(req.file.path); } catch(e){}

    res.json({ success: true, message: `✅ ${inserted} kontak berhasil diupload.`, total: inserted });
  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(500).json({ success: false, message: "Upload gagal", error: err.toString() });
  }
}

app.post("/api/upload", upload.single("file"), handleUploadFile);
app.post("/upload", upload.single("file"), handleUploadFile);

// PART 2/4
// =============================
// 📨 Kirim SMS via SMS API (Zuwinda / generic)
// =============================
async function sendSMS(to, message) {
  try {
    // default payload — sesuaikan jika doc Zuwinda beda
    const payload = {
      api_key: process.env.SMS_API_KEY,
      sender_id: process.env.SMS_SENDER_ID || "",
      to,
      message,
    };

    const resp = await axios.post(process.env.SMS_API_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });

    // coba beberapa format respons umum
    const data = resp.data || {};
    // jika provider mengembalikan { success: true } atau { status: 'success' }
    if (data.success === true || data.status === "success" || data.status === true) return { ok: true, raw: data };
    // jika ada field result.status
    if (data.result && (data.result.status === "success" || data.result.success === true)) return { ok: true, raw: data };
    // fallback: treat HTTP 2xx as ok
    if (resp.status >= 200 && resp.status < 300) return { ok: true, raw: data };
    return { ok: false, raw: data };
  } catch (err) {
    console.error("❌ sendSMS error:", err.message || err.toString());
    return { ok: false, error: err.toString() };
  }
}

// =============================
// 🛡️ Manual Batch Send endpoint (max 20)
// =============================
app.post("/api/send", async (req, res) => {
  try {
    const { message_template = "", reminder_template = "" } = req.body || {};

    const { rows: contacts } = await pool.query(
      "SELECT * FROM contacts WHERE status IN ('pending','failed') ORDER BY created_at ASC LIMIT 20"
    );

    if (contacts.length === 0) return res.json({ success: false, message: "Tidak ada kontak untuk dikirim." });

    let totalSuccess = 0, totalFailed = 0;

    for (const c of contacts) {
      const phone = normalizePhone(c.phone);
      if (!phone) {
        // mark invalid
        await pool.query("UPDATE contacts SET status='failed' WHERE id=$1", [c.id]);
        totalFailed++;
        continue;
      }

      const msg = (message_template || "").replace(/{name}/g, c.name || "");

      const r = await sendSMS(phone, msg);

      if (r.ok) {
        totalSuccess++;
        await pool.query(
          `UPDATE contacts SET status='sent', last_sent=NOW(), reminder_message=$1 WHERE id=$2`,
          [reminder_template || c.reminder_message || null, c.id]
        );
      } else {
        totalFailed++;
        await pool.query("UPDATE contacts SET status='failed' WHERE id=$1", [c.id]);
        console.warn(`Failed to send to ${phone}:`, r.error || r.raw || "unknown");
      }

      // small random delay to avoid burst
      const delay = Math.floor(Math.random() * 5000) + 3000;
      await new Promise(r => setTimeout(r, delay));
    }

    res.json({ success: true, message: `Batch selesai. Sukses: ${totalSuccess}, Gagal: ${totalFailed}` });
  } catch (err) {
    console.error("❌ /api/send error:", err);
    res.status(500).json({ success: false, message: "Gagal pengiriman batch", error: err.toString() });
  }
});

// PART 3/4
// =============================
// 🔁 Cron job: reminder otomatis
// (Contoh: cek tiap jam, kirim jika 24 jam sejak last_sent dan reminder_count < 2)
// =============================

// schedule: every hour at minute 0
cron.schedule("0 * * * *", async () => {
  try {
    console.log("⏰ Cron reminder: cek kontak untuk reminder...");
    const { rows } = await pool.query(`
      SELECT * FROM contacts
      WHERE status='sent'
        AND (last_reply IS NULL OR status != 'replied')
        AND reminder_count < 2
        AND NOW() - last_sent >= INTERVAL '24 hours'
      ORDER BY last_sent ASC
      LIMIT 50
    `);

    for (const c of rows) {
      const phone = normalizePhone(c.phone);
      if (!phone) continue;

      const msg = c.reminder_message || `Halo ${c.name}, ini reminder dari Klinik Karya Prima. Mohon konfirmasi...`;

      const r = await sendSMS(phone, msg);
      if (r.ok) {
        await pool.query(
          `UPDATE contacts SET reminder_count = reminder_count + 1, last_sent = NOW(), status='reminded' WHERE id=$1`,
          [c.id]
        );
        console.log(`🔁 Reminder terkirim ke ${phone}`);
      } else {
        console.warn(`⚠️ Reminder gagal ke ${phone}:`, r.error || r.raw);
      }

      // small pacing
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    console.error("❌ Cron reminder error:", err);
  }
});


// =============================
// 📩 Webhook inbound SMS (Zuwinda)
// Sesuaikan field body sesuai dokumentasi Zuwinda.
// Contoh payload assumed: { from: '628xx', to: 'SENDER', message: 'isi' }
// =============================
app.post("/webhook/zuwinda", async (req, res) => {
  try {
    const data = req.body || {};
    // try common field names
    const from = data.from || data.sender || data.msisdn || data.number || data.phone;
    const message = data.message || data.text || data.body || data.msg || data.content;

    // optional signature/secret check
    if (process.env.SMS_WEBHOOK_SECRET) {
      // if Zuwinda supports header X-SMS-Sign or similar, validate here
      // e.g. if (req.headers['x-webhook-token'] !== process.env.SMS_WEBHOOK_SECRET) return res.sendStatus(401);
    }

    if (!from || !message) {
      // write to log for debugging
      fs.appendFileSync(path.join(__dirname, "webhook.log"), `[${new Date().toISOString()}] Ignored webhook: ${JSON.stringify(data)}\n`);
      return res.sendStatus(200);
    }

    const phone = normalizePhone(from);
    if (!phone) return res.sendStatus(200);

    const { rows } = await pool.query("SELECT id FROM contacts WHERE phone=$1 LIMIT 1", [phone]);
    if (rows.length === 0) {
      // optionally insert unknown inbound contacts
      await pool.query(
        `INSERT INTO contacts (nik, name, phone, status, created_at)
         VALUES ('', '', $1, 'inbound', NOW()) ON CONFLICT DO NOTHING`,
        [phone]
      );
      // continue to insert reply below using new contact row
    }

    // re-query to ensure contact exists
    const { rows: rows2 } = await pool.query("SELECT id FROM contacts WHERE phone=$1 LIMIT 1", [phone]);
    if (rows2.length === 0) return res.sendStatus(200);

    const contactId = rows2[0].id;

    await pool.query("DELETE FROM reply WHERE contact_id=$1", [contactId]).catch(()=>{});
    await pool.query(
      `INSERT INTO reply (contact_id, phone, message, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [contactId, phone, message]
    );

    await pool.query(`UPDATE contacts SET status='replied', last_reply=NOW() WHERE id=$1`, [contactId]);

    fs.appendFileSync(path.join(__dirname, "webhook.log"), `[${new Date().toISOString()}] Reply from ${phone}: ${message}\n`);

    console.log(`💬 Balasan masuk dari ${phone}: "${message}"`);
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.status(500).send("error");
  }
});

// PART 4/4
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
      LIMIT 1000
    `);
    res.json(rows);
  } catch (err) {
    console.error("❌ /api/contacts error:", err);
    res.status(500).json({ success: false, message: "Gagal ambil data kontak." });
  }
});

// Static index (UI)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT} (WITA)`);
});
