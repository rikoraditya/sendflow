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

// =========================================
// 🟦 TEMPLATE PESAN
// =========================================

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

// =========================================
// 🟦 BODY PARSER
// =========================================
app.use(bodyParser.json({ limit: "5mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// =========================================
// 🟦 LOGGER
// =========================================
function logInfo(...args) {
  console.log(...args);
}
function logError(...args) {
  console.error(...args);
}

// =========================================
// 🟦 DATABASE (SUPABASE / POSTGRES)
// =========================================
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
    logInfo("✅ Supabase Database connected");
  } catch (err) {
    logError("❌ Database connection failed:", err.message);
    process.exit(1);
  }
})();

// =========================================
// 🟦 NORMALISASI NOMOR HP
// =========================================
function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/\D/g, "");
  if (p.startsWith("0")) p = "62" + p.slice(1);
  else if (!p.startsWith("62")) p = "62" + p;
  return p.length < 10 ? null : p;
}

// =========================================
// 🟦 UPLOAD EXCEL
// =========================================
const upload = multer({ dest: "uploads/" });

app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, message: "No file uploaded" });

    const workbook = XLSX.readFile(req.file.path);
    const sheet = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
      defval: "",
    });

    let inserted = 0;
    for (const row of sheet) {
      const nik = String(row.nik || row.NIK || "").trim();
      const name = String(row.name || row.Name || row.Nama || "").trim();
      const phone = normalizePhone(
        row.phone || row.Phone || row.hp || row.HP || row["No WA"]
      );

      if (!nik || !name || !phone) continue;

      await pool.query(
        `
        INSERT INTO contacts (nik, name, phone, status, reminder_count, created_at)
        VALUES ($1, $2, $3, 'pending', 0, NOW() AT TIME ZONE 'Asia/Makassar')
        ON CONFLICT (nik) DO UPDATE
        SET name = EXCLUDED.name,
            phone = EXCLUDED.phone,
            status = 'pending',
            reminder_count = 0,
            last_sent = NULL
      `,
        [nik, name, phone]
      );

      inserted++;
    }

    fs.unlinkSync(req.file.path);
    res.json({ success: true, message: `${inserted} kontak berhasil diupload.` });
  } catch (err) {
    logError("❌ Upload gagal:", err.message);
    res.status(500).json({ success: false, message: "Upload gagal." });
  }
});

// =========================================
// 🟦 FONNTE SENDER
// =========================================
async function sendFonnte(phone, message) {
  try {
    const form = new FormData();
    form.append("target", phone);
    form.append("message", message);

    const result = await axios.post("https://api.fonnte.com/send", form, {
      headers: {
        Authorization: process.env.FONNTE_TOKEN,
        ...form.getHeaders(),
      },
    });

    logInfo("📩 Fonnte response:", result.data);
    return { success: true };
  } catch (err) {
    logError("❌ Fonnte send error:", err.response?.data || err.message);
    return { success: false };
  }
}

// =========================================
// 🟦 GET KONTAK PENDING (LIMIT 20)
// =========================================
async function getPendingContacts(limit = 20) {
  const q = `
    SELECT * FROM contacts
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT $1
  `;
  const { rows } = await pool.query(q, [limit]);
  return rows;
}

// =========================================
// 🟦 UPDATE STATUS KIRIM
// =========================================
async function markSent(id) {
  await pool.query(
    `
    UPDATE contacts
    SET status = 'sent',
        last_sent = NOW() AT TIME ZONE 'Asia/Makassar'
    WHERE id = $1
  `,
    [id]
  );
}

// =========================================
// 🟦 CRON: KIRIM PER 5 MENIT (MAX 20 KONTAK)
// =========================================
cron.schedule("*/5 * * * *", async () => {
  logInfo("⏳ Cron 5 menit berjalan...");

  const contacts = await getPendingContacts(20);
  if (contacts.length === 0) return logInfo("✨ Tidak ada kontak pending.");

  logInfo(`📤 Mengirim ${contacts.length} kontak...`);

  for (const c of contacts) {
    const message = TEMPLATE_UTAMA.replace("{name}", c.name);

    const sent = await sendFonnte(c.phone, message);
    if (sent.success) {
      await markSent(c.id);
      logInfo(`✅ Terkirim ke ${c.name}`);
    } else {
      logError(`❌ Gagal mengirim ke ${c.name}`);
    }

    await new Promise((r) => setTimeout(r, 8000)); // 8 detik delay
  }
});

// =========================================
// 🟦 CRON REMINDER SETIAP JAM 8 PAGI
// =========================================
cron.schedule("0 8 * * *", async () => {
  logInfo("🔔 Cron reminder berjalan...");

  const q = `
    SELECT * FROM contacts
    WHERE status = 'sent'
      AND reminder_count < 1
      AND (NOW() AT TIME ZONE 'Asia/Makassar') - last_sent > INTERVAL '3 days'
  `;

  const { rows } = await pool.query(q);
  if (rows.length === 0) return logInfo("✨ Tidak ada yang perlu reminder.");

  for (const c of rows) {
    const sent = await sendFonnte(c.phone, TEMPLATE_REMINDER);

    if (sent.success) {
      await pool.query(
        `UPDATE contacts SET reminder_count = reminder_count + 1 WHERE id = $1`,
        [c.id]
      );
      logInfo(`🔔 Reminder terkirim ke ${c.name}`);
    } else {
      logError(`❌ Reminder gagal ke ${c.name}`);
    }

    await new Promise((r) => setTimeout(r, 8000));
  }
});

// =========================================
// 🟦 START SERVER
// =========================================
app.listen(3000, () => logInfo("🚀 Server running on port 3000"));
