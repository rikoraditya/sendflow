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
import bodyParser from "body-parser";

dotenv.config();
const { Pool } = pkg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Body parsers
app.use(bodyParser.json({ limit: "5mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "5mb" }));
app.use(bodyParser.text({ type: "*/json" }));
app.use(express.static(path.join(__dirname, "public")));

// Logging helper (file + console)
function logInfo(...args) {
  console.log(...args);
}
function logError(...args) {
  console.error(...args);
}
function appendWebhookLog(obj) {
  try {
    fs.appendFileSync(
      path.join(__dirname, "webhook.log"),
      `[${new Date().toLocaleString("id-ID", { timeZone: "Asia/Makassar" })}] ${JSON.stringify(
        obj,
        null,
        2
      )}\n\n`
    );
  } catch (e) {
    console.error("❌ Gagal append webhook.log:", e.message);
  }
}

// =============================
// 🗄️ PostgreSQL (Supabase) pool
// =============================
const pool = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false },
});

// Test DB connection at startup
(async () => {
  try {
    await pool.query("SELECT 1");
    logInfo("✅ Supabase Database connected");
    logInfo("🕓 Server timezone:", new Date().toLocaleString("id-ID", { timeZone: "Asia/Makassar" }));
  } catch (err) {
    logError("❌ Database connection failed:", err.message);
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
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

    const workbook = XLSX.readFile(req.file.path);
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });

    let inserted = 0;
    for (const row of sheet) {
      const nik = String(row.nik || row.NIK || row.NIK?.toString?.() || "").trim();
      const name = String(row.name || row.Name || row.Nama || "").trim();
      const phoneRaw = row.phone || row.Phone || row["No WA"] || row["no_wa"] || row.hp || row.HP || "";
      const phone = normalizePhone(phoneRaw);

      if (!nik || !name || !phone) {
        // detailed debug log per row for easier troubleshooting
        logInfo("⏭ Skip row (missing field):", { nik, name, phoneRaw, phone });
        continue;
      }

      await pool.query(
        `
        INSERT INTO contacts (nik, name, phone, status, reminder_count, created_at)
        VALUES ($1, $2, $3, 'pending', 0, NOW() AT TIME ZONE 'Asia/Makassar')
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
    logInfo(`✅ Upload complete — inserted: ${inserted}`);
    res.json({ success: true, message: `✅ ${inserted} kontak berhasil diupload.` });
  } catch (err) {
    logError("❌ Upload gagal:", err.message);
    res.status(500).json({ success: false, message: "Upload gagal." });
  }
});

// =============================
// 🔧 Helper: send using Fonnte API (with logging & timeout)
// =============================
async function sendMessageViaFonnte(targetPhone, message, contactId = null) {
  const form = new FormData();
  form.append("target", targetPhone);
  form.append("message", message);

  try {
    const resp = await axios.post("https://api.fonnte.com/send", form, {
      headers: { Authorization: process.env.FONNTE_TOKEN, ...form.getHeaders() },
      timeout: 30_000,
    });

    logInfo("📤 Fonnte response:", resp.data);
    return resp.data;
  } catch (err) {
    logError("⚠️ Fonnte send error:", err.message, contactId ? `id=${contactId}` : "");
    if (err.response) logError("➡️ response data:", err.response.data);
    throw err;
  }
}

// =============================
// 🔁 CORE: sendPendingBatchOnce (robust, idempotent-ish)
// - runs from CRON every 5 minutes
// - sends up to 20 contacts with status pending/failed
// - logs heavily
// =============================
let isSendingBatch = false;

async function sendPendingBatchOnce() {
  if (isSendingBatch) {
    logInfo("⏳ sendPendingBatchOnce: already running, skipping this tick");
    return;
  }

  isSendingBatch = true;
  logInfo("🚀 sendPendingBatchOnce: starting...");

  try {
    // pick up to 20 pending/failed contacts (oldest first)
    const { rows: contacts } = await pool.query(
      `SELECT * FROM contacts
       WHERE status IN ('pending','failed')
       ORDER BY created_at ASC
       LIMIT 20`
    );

    if (!contacts || contacts.length === 0) {
      logInfo("ℹ️ No pending/failed contacts to send.");
      return;
    }

    logInfo(`📦 Got ${contacts.length} contacts to process.`);

    for (const c of contacts) {
      const phone = normalizePhone(c.phone);
      if (!phone) {
        logError(`⚠ Invalid phone for id=${c.id} (${c.phone}) — marking failed`);
        await pool.query("UPDATE contacts SET status='failed' WHERE id=$1", [c.id]);
        continue;
      }

      // Build message: prefer a message_template or reminder_message column if exists
      const msg = (c.reminder_message && String(c.reminder_message).trim().length)
        ? c.reminder_message.replace(/{name}/g, c.name)
        : (c.name ? `Selamat Pagi atau Siang
Yth. Bapak/Ibu  ${c.name}, Kami dari team Prolanis Klinik Karya Prima, mohon izin mendata serta menanyakan apakah bapak/ibu bulan November ini sudah melakukan cek tekanan darah disertai kontrol gula darah di klinik, rumah sakit, atau tempat kesehatan lainnya? 
Apabila sudah melakukan pengecekan, mohon dapat mengirimkan foto hasil cek tensi serta gula darah bulan ini atau menginfokan hasil cek tensi serta gula darah terakhir, dan dikirimkan ke nomor whatsapp ini.
Bapak/Ibu juga dapat menginput hasil cek tensi dan gula darah di link di bawah ini.
Link pengisian DM dan HT: https://forms.gle/iKQmWeHBpxRbzooU8
Terima kasih atas perhatiannya🙏.` : `Selamat Pagi atau Siang
Yth. Bapak/Ibu, Kami dari team Prolanis Klinik Karya Prima, mohon izin mendata serta menanyakan apakah bapak/ibu bulan November ini sudah melakukan cek tekanan darah disertai kontrol gula darah di klinik, rumah sakit, atau tempat kesehatan lainnya? 
Apabila sudah melakukan pengecekan, mohon dapat mengirimkan foto hasil cek tensi serta gula darah bulan ini atau menginfokan hasil cek tensi serta gula darah terakhir, dan dikirimkan ke nomor whatsapp ini.
Bapak/Ibu juga dapat menginput hasil cek tensi dan gula darah di link di bawah ini.
Link pengisian DM dan HT: https://forms.gle/iKQmWeHBpxRbzooU8
Terima kasih atas perhatiannya🙏.`);

      try {
        const resp = await sendMessageViaFonnte(phone, msg, c.id);

        if (resp && (resp.status === true || resp.status === "success" || resp.success)) {
          // mark sent
          await pool.query(
            `UPDATE contacts
             SET status='sent',
                 last_sent = NOW() AT TIME ZONE 'Asia/Makassar'
             WHERE id=$1`,
            [c.id]
          );
          logInfo(`✅ Sent id=${c.id} (${c.name})`);
        } else {
          // fallback: mark failed, will retry on next tick
          await pool.query("UPDATE contacts SET status='failed' WHERE id=$1", [c.id]);
          logError(`❌ Fonnte responded with failure for id=${c.id}`, resp && resp.data ? resp.data : resp);
        }
      } catch (err) {
        // In case of network / API error mark as failed; will be retried later
        try {
          await pool.query("UPDATE contacts SET status='failed' WHERE id=$1", [c.id]);
        } catch (uErr) {
          logError("❌ Failed to mark contact as failed:", uErr.message);
        }
        logError(`⚠ Error sending id=${c.id}:`, err.message);
      }

      // small delay between messages (to be gentle)
      await new Promise((r) => setTimeout(r, 1500));
    }

    logInfo("✅ sendPendingBatchOnce: finished processing batch.");
  } catch (err) {
    logError("❌ sendPendingBatchOnce top-level error:", err.message);
  } finally {
    isSendingBatch = false;
  }
}

// schedule every 5 minutes
cron.schedule("*/5 * * * *", async () => {
  logInfo("⏰ CRON tick (*/5 * * * *): running sendPendingBatchOnce");
  try {
    await sendPendingBatchOnce();
  } catch (err) {
    logError("❌ CRON error:", err.message);
  }
});

// Also expose a manual trigger endpoint (kept for compatibility)
app.post("/api/send", async (req, res) => {
  try {
    // Optional: allow a message_template override
    const { message_template } = req.body || {};
    logInfo("🔔 Manual /api/send called, triggering batch send once (manual). Template override:", !!message_template);

    // If provided, temporarily update reminder_message for contacts? (keep simple: ignore here)
    if (isSendingBatch) return res.json({ success: false, message: "Send already in progress" });

    // Trigger send
    await sendPendingBatchOnce();
    res.json({ success: true, message: "Batch send executed (manual trigger)." });
  } catch (err) {
    logError("❌ /api/send error:", err.message);
    res.status(500).json({ success: false, message: "Failed to send batch." });
  }
});

// =============================
// 🔁 Reminder Otomatis tiap jam (cek kontak yang sent & no reply 24 jam)
// - reminder_count < 2 (keamanan agar tidak spam)
// =============================
cron.schedule("0 * * * *", async () => {
  logInfo("⏰ CRON hourly: checking reminders...");

  try {
    const { rows } = await pool.query(`
      SELECT * FROM contacts
      WHERE status = 'sent'
      AND reminder_count < 2
      AND (last_reply IS NULL)
      AND NOW() - last_sent >= INTERVAL '24 hours'
    `);

    if (!rows || rows.length === 0) {
      logInfo("ℹ️ No reminder candidates.");
      return;
    }

    logInfo(`🔔 Found ${rows.length} reminder candidates.`);

    for (const c of rows) {
      const phone = normalizePhone(c.phone);
      if (!phone) continue;

      const reminderMsg = c.reminder_message || `Selamat Pagi atau Siang
Yth. Bapak/Ibu  ${c.name}, Kami dari team Prolanis Klinik Karya Prima, mohon izin menindaklanjuti whatsapp kami sebelumnya. 
Kami mohon izin mendata serta menanyakan apakah bapak/ibu bulan November ini sudah melakukan cek tekanan darah disertai kontrol gula darah di klinik, rumah sakit, atau tempat kesehatan lainnya? 
Apabila sudah melakukan pengecekan, mohon dapat mengirimkan foto hasil cek tensi serta gula darah bulan ini atau menginfokan hasil cek tensi serta gula darah terakhir, dan dikirimkan ke nomor whatsapp ini.
Bapak/Ibu juga dapat menginput hasil cek tensi dan gula darah di link di bawah ini.
Link pengisian DM dan HT: https://forms.gle/iKQmWeHBpxRbzooU8

Jangan lupa jaga pola makan, minum rendah gula serta garam, dan olahraga minimal 30 menit pada saat pagi hari, nggih.
Terimakasih atas perhatiannya. Salam Sehat Selalu 😇🙏.`;

      try {
        const resp = await sendMessageViaFonnte(phone, reminderMsg, c.id);
        if (resp && (resp.status === true || resp.success)) {
          await pool.query(
            `UPDATE contacts SET status='reminded', reminder_count = reminder_count + 1, last_sent = NOW() AT TIME ZONE 'Asia/Makassar' WHERE id=$1`,
            [c.id]
          );
          logInfo(`🔁 Reminder sent to id=${c.id} (${c.name})`);
        } else {
          await pool.query("UPDATE contacts SET status='failed' WHERE id=$1", [c.id]);
          logError(`⚠ Reminder failed (fonnte responded negatively) for id=${c.id}`);
        }
      } catch (err) {
        logError(`⚠ Reminder send error id=${c.id}:`, err.message);
        try {
          await pool.query("UPDATE contacts SET status='failed' WHERE id=$1", [c.id]);
        } catch (uErr) {
          logError("❌ Failed to update contact status:", uErr.message);
        }
      }

      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (err) {
    logError("❌ Reminder CRON error:", err.message);
  }
});

// =============================
// 📩 Webhook Fonnte → Balasan Pasien
// - saves reply and updates contact status -> replied
// - logs everything to webhook.log for debugging
// =============================
app.post(["/webhook/fonnte", "//webhook/fonnte"], async (req, res) => {
  res.status(200).json({ success: true, message: "Webhook diterima" });

  const data = req.body || {};
  appendWebhookLog(data);
  logInfo("📩 Webhook received:", JSON.stringify(data));

  const phoneRaw = data.phone || data.sender || data.from || data.phone_number;
  const phone = normalizePhone(phoneRaw);
  const message = data.message || data.text || (data.body && data.body.text) || "";

  if (!phone || !message) {
    logInfo("⚠ Webhook missing phone or message:", { phoneRaw, message });
    return;
  }

  try {
    const { rows } = await pool.query("SELECT id FROM contacts WHERE phone=$1 LIMIT 1", [phone]);

    if (!rows || rows.length === 0) {
      logInfo("⚠ Incoming phone not found in contacts table, ignoring:", phone);
      return;
    }

    const contactId = rows[0].id;

    await pool.query(
      `INSERT INTO reply (contact_id, phone, message, created_at)
       VALUES ($1, $2, $3, NOW() AT TIME ZONE 'Asia/Makassar')`,
      [contactId, phone, message]
    );

    // Update contact: status replied, set last_reply
    await pool.query(
      `UPDATE contacts
       SET status='replied',
           last_reply = NOW() AT TIME ZONE 'Asia/Makassar'
       WHERE id=$1`,
      [contactId]
    );

    // Optional: bump created_at or updated_at to push replied to top (we sort by status first, then created_at DESC)
    await pool.query(`UPDATE contacts SET created_at = NOW() AT TIME ZONE 'Asia/Makassar' WHERE id=$1`, [contactId]);

    logInfo(`💬 Reply saved for id=${contactId} (${phone}):`, message);
  } catch (err) {
    logError("❌ Webhook handler error:", err.message);
  }
});

// =============================
// 📋 API Kontak (termasuk balasan terakhir) — Sorting A (replied first)
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
      ORDER BY
        (CASE
           WHEN status='replied' THEN 1
           WHEN status='reminded' THEN 2
           WHEN status='sent' THEN 3
           WHEN status='pending' THEN 4
           ELSE 5
         END),
        c.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    logError("❌ GET /api/contacts error:", err.message);
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
  logInfo(`🚀 Server running on http://localhost:${PORT} (WITA)`);
});