// 🕒 Set timezone Bali (WITA)
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

// =======================
// INIT APP + MIDDLEWARE
// =======================
const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// =======================
// POOL POSTGRES (SUPABASE / RAILWAY)
// - Supports DATABASE_URL or individual vars
// =======================
const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : {
      host: process.env.PGHOST,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
      ssl: { rejectUnauthorized: false },
    };

const pool = new Pool(poolConfig);

// quick test at startup (non-blocking)
pool
  .query("SELECT 1")
  .then(() => logInfo("✅ Database connected"))
  .catch((e) => {
    logError("❌ Database connect failed:", e.message || e);
    // don't exit here; let app start but many features will fail if DB unreachable
  });

// =======================
// MULTER (upload excel)
// =======================
const upload = multer({
  dest: path.join(__dirname, "uploads"),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// =======================
// TEMPLATE PESAN
// =======================

const TEMPLATE_UTAMA = `
Selamat Pagi atau Siang
Yth. Bapak/Ibu {name}, Kami dari team Prolanis Klinik Karya Prima, mohon izin mendata serta menanyakan apakah bapak/ibu bulan Oktober ini sudah melakukan cek tekanan darah disertai kontrol gula darah di klinik, rumah sakit, atau tempat kesehatan lainnya? 
Apabila sudah melakukan pengecekan, mohon dapat mengirimkan foto hasil cek tensi serta gula darah bulan ini ATAU menginfokan hasil cek tensi serta gula darah terakhir, dan dikirimkan ke nomor whatsapp ini.
Bapak/Ibu juga dapat menginput hasil cek tensi dan gula darah di link di bawah ini.
Link pengisian DM dan HT: https://forms.gle/iKQmWeHBpxRbzooU8
Terima kasih atas perhatiannya🙏
`.trim();

const TEMPLATE_REMINDER = `
Selamat Pagi atau Siang
Yth. Bapak/Ibu 
Kami dari team Prolanis Klinik Karya Prima, mohon izin menindaklanjuti whatsapp kami sebelumnya. 
Kami mohon izin mendata serta menanyakan apakah bapak/ibu bulan November ini sudah melakukan cek tekanan darah disertai kontrol gula darah di klinik, rumah sakit, atau tempat kesehatan lainnya? 
Apabila sudah melakukan pengecekan, mohon dapat mengirimkan foto hasil cek tensi serta gula darah bulan ini atau menginfokan hasil cek tensi serta gula darah terakhir, dan dikirimkan ke nomor whatsapp ini.
Bapak/Ibu juga dapat menginput hasil cek tensi dan gula darah di link di bawah ini.
Link pengisian DM dan HT: https://forms.gle/iKQmWeHBpxRbzooU8

Jangan lupa jaga pola makan, minum rendah gula serta garam, dan olahraga minimal 30 menit pada saat pagi hari, nggih.
Terimakasih atas perhatiannya. Salam Sehat Selalu 😇🙏
`.trim();

// =======================
// HELPERS: logging, phone normalizer, webhook log
// =======================
function logInfo(...args) {
  console.log("[INFO]", new Date().toLocaleString("id-ID"), ...args);
}
function logError(...args) {
  console.error("[ERROR]", new Date().toLocaleString("id-ID"), ...args);
}
function appendWebhookLog(data) {
  try {
    const file = path.join(__dirname, "webhook.log");
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${JSON.stringify(data)}\n`);
  } catch (e) {
    console.error("❌ appendWebhookLog failed:", e.message);
  }
}

function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).trim().replace(/\D/g, "");
  if (p.startsWith("0")) p = "62" + p.slice(1);
  else if (!p.startsWith("62")) p = "62" + p;
  return p.length >= 9 ? p : null;
}

// =======================
// DB helpers
// =======================
async function getPendingContacts(limit = 5) {
  try {
    const q = `
      SELECT * FROM contacts
      WHERE status = 'pending'
      ORDER BY created_at ASC, id ASC
      LIMIT $1
    `;
    const { rows } = await pool.query(q, [limit]);
    return rows || [];
  } catch (err) {
    logError("getPendingContacts error:", err.message || err);
    return [];
  }
}

async function markSent(id) {
  try {
    await pool.query(
      `UPDATE contacts
       SET status = 'sent',
           last_sent = NOW() AT TIME ZONE 'Asia/Makassar'
       WHERE id = $1`,
      [id]
    );
  } catch (err) {
    logError("markSent error:", err.message || err);
  }
}

// =======================
// Sender: Fonnte API
// =======================
async function sendFonnte(phone, message) {
  try {
    const form = new FormData();
    form.append("target", phone);
    form.append("message", message);

    const resp = await axios.post("https://api.fonnte.com/send", form, {
      headers: { Authorization: process.env.FONNTE_TOKEN || "", ...form.getHeaders() },
      timeout: 30000,
    });

    logInfo("Fonnte response:", resp.data);
    // adapt to fonnte response shape — treat truthy status/success as success
    const ok =
      resp.data &&
      (resp.data.status === true || resp.data.status === "success" || resp.data.success === true);
    return { success: Boolean(ok), raw: resp.data };
  } catch (err) {
    logError("sendFonnte error:", err.response?.data || err.message);
    return { success: false, raw: err.response?.data || err.message };
  }
}

// =======================
// ROUTES
// =======================

// Upload Excel -> insert contacts (name, phone, message optional, delay optional)
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "File Excel tidak ditemukan" });

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Insert or upsert: use nik if exists else name+phone uniqueness
      for (const r of rows) {
        const name = (r.name || r.nama || r.nama_lengkap || "").toString().trim();
        const phoneRaw = r.phone || r.hp || r["No WA"] || r.no_wa || "";
        const phone = normalizePhone(phoneRaw);
        if (!name || !phone) {
          logInfo("Skip invalid row:", { name, phoneRaw });
          continue;
        }
        // Upsert by phone (or you can change to nik unique)
        await client.query(
          `INSERT INTO contacts (name, phone, message, status, reminder_count, created_at)
           VALUES ($1,$2,$3,'pending',0, NOW() AT TIME ZONE 'Asia/Makassar')
           ON CONFLICT (phone) DO UPDATE
           SET name = EXCLUDED.name,
               message = COALESCE(EXCLUDED.message, contacts.message),
               status = 'pending',
               reminder_count = 0,
               last_sent = NULL,
               last_reply = NULL`,
          [name, phone, (r.message || "").toString().trim()]
        );
      }
      await client.query("COMMIT");
      res.json({ success: true, message: "Upload & simpan kontak berhasil" });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
      // cleanup uploaded file
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
    }
  } catch (err) {
    logError("Upload handler error:", err.message || err);
    res.status(500).json({ success: false, message: "Gagal memproses file" });
  }
});

// Webhook Fonnte - receive incoming messages
app.post("/webhook", async (req, res) => {
  appendWebhookLog(req.body);
  try {
    const body = req.body || {};
    // Accept flexible shapes; many providers send different keys
    const type = body.type || body.event || null;
    if (type && type !== "incoming" && type !== "message" && body.type !== undefined) {
      // if provider uses explicit type and not incoming -> ignore
      return res.json({ success: true, note: "ignored (not incoming)" });
    }

    // try common fields
    const phoneRaw = body.phone || body.sender || body.from || body.phone_number || body.whatsapp;
    const phone = normalizePhone(phoneRaw);
    const message = body.message || body.text || (body.body && body.body.text) || "";

    if (!phone || !message) {
      logInfo("Webhook ignored: missing phone or message", { phoneRaw, message });
      return res.json({ success: false, message: "missing phone/message" });
    }

    // save incoming
    await pool.query(
      `INSERT INTO incoming_messages (phone, message, received_at)
       VALUES ($1, $2, NOW() AT TIME ZONE 'Asia/Makassar')`,
      [phone, message]
    );

    // update contact if exists
    await pool.query(
      `UPDATE contacts
       SET last_reply = NOW() AT TIME ZONE 'Asia/Makassar',
           status = 'replied'
       WHERE phone = $1`,
      [phone]
    );

    logInfo(`Received reply from ${phone}: ${message}`);
    res.json({ success: true });
  } catch (err) {
    logError("Webhook handler error:", err.message || err);
    res.status(500).json({ success: false });
  }
});

// Simple health check
app.get("/health", (req, res) => res.json({ ok: true }));

// =======================
// CRON: Send batch every 10 minutes (batch size 5, delay 5 sec)
// =======================
cron.schedule("*/10 * * * *", async () => {
  logInfo("Cron batch started: fetching pending contacts...");
  try {
    const contacts = await getPendingContacts(5);
    if (!contacts || contacts.length === 0) {
      logInfo("No pending contacts.");
      return;
    }
    logInfo(`Will send ${contacts.length} contacts in this batch.`);

    for (const c of contacts) {
      const msg = TEMPLATE_UTAMA.replace("{name}", c.name || "");
      const result = await sendFonnte(c.phone, msg);

      if (result.success) {
        await markSent(c.id);
        logInfo(`Sent to ${c.name} (${c.phone})`);
      } else {
        logError(`Failed send to ${c.name} (${c.phone})`, result.raw);
        // keep status 'pending' or mark 'failed' based on policy (we leave as pending to retry)
        await pool.query(`UPDATE contacts SET status='failed' WHERE id=$1`, [c.id]).catch(() => {});
      }

      // delay between messages
      await new Promise((r) => setTimeout(r, 5000));
    }

    logInfo("Batch finished.");
  } catch (err) {
    logError("Cron batch error:", err.message || err);
  }
});

// =======================
// CRON: Reminder check every 30 minutes -> send if >24h since last_sent and no reply
// - limit reminders per contact to 1 (reminder_count < 1)
// =======================
cron.schedule("*/30 * * * *", async () => {
  logInfo("Cron reminder: checking candidates...");
  try {
    const q = `
      SELECT * FROM contacts
      WHERE status = 'sent'
        AND reminder_count < 1
        AND last_reply IS NULL
        AND (NOW() AT TIME ZONE 'Asia/Makassar') - last_sent > INTERVAL '24 hours'
      ORDER BY last_sent ASC
      LIMIT 50
    `;
    const { rows } = await pool.query(q);
    if (!rows || rows.length === 0) {
      logInfo("No reminder candidates.");
      return;
    }

    for (const c of rows) {
      const resSend = await sendFonnte(c.phone, TEMPLATE_REMINDER);
      if (resSend.success) {
        await pool.query(`UPDATE contacts SET reminder_count = reminder_count + 1, status='reminded' WHERE id=$1`, [
          c.id,
        ]);
        logInfo(`Reminder sent to ${c.name} (${c.phone})`);
      } else {
        logError("Reminder failed:", c.id, c.phone, resSend.raw);
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  } catch (err) {
    logError("Cron reminder error:", err.message || err);
  }
});

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logInfo(`Server running on port ${PORT}`);
  logInfo(`Timezone: ${process.env.TZ}`);
  logInfo("Webhook endpoint: POST /webhook");
  logInfo("Upload endpoint: POST /upload (multipart/form-data file field 'file')");
  logInfo("Batch sending: every 10 minutes, 5 contacts / batch, 5s between contacts");
  logInfo("Reminder: checked every 30 minutes (send if >24h since last_sent)");
});
