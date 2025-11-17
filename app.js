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



// =======================
//  TEMPLATE PESAN
// =======================

// Template utama
const TEMPLATE_UTAMA = `
Selamat Pagi atau Siang
Yth. Bapak/Ibu {name}, Kami dari team Prolanis Klinik Karya Prima, mohon izin mendata serta menanyakan apakah bapak/ibu bulan Oktober ini sudah melakukan cek tekanan darah disertai kontrol gula darah di klinik, rumah sakit, atau tempat kesehatan lainnya? 
Apabila sudah melakukan pengecekan, mohon dapat mengirimkan foto hasil cek tensi serta gula darah bulan ini ATAU menginfokan hasil cek tensi serta gula darah terakhir, dan dikirimkan ke nomor whatsapp ini.
Bapak/Ibu juga dapat menginput hasil cek tensi dan gula darah di link di bawah ini.
Link pengisian DM dan HT: https://forms.gle/iKQmWeHBpxRbzooU8
Terima kasih atas perhatiannya🙏
`.trim();

// Template reminder
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

// ===============================
// ROUTE: UPLOAD FILE EXCEL
// ===============================
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "File Excel tidak ditemukan" });
  }

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    const client = await pool.connect();

    await client.query("BEGIN");

    // Kosongkan tabel sebelum import
    await client.query("DELETE FROM contacts");

    for (const row of data) {
      await client.query(
        `INSERT INTO contacts (name, phone, message, delay)
         VALUES ($1, $2, $3, $4)`,
        [row.name, row.phone, row.message, row.delay || 5]
      );
    }

    await client.query("COMMIT");
    client.release();

    res.json({ status: "success", message: "Data kontak berhasil diupload" });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Gagal memproses file" });
  }
});

// ===============================
// CRON JOB — PER BATCH 5 KONTAK
// ===============================
cron.schedule("*/1 * * * *", async () => {
  console.log("⏳ Cron berjalan:", new Date().toLocaleString("id-ID"));

  // Ambil maksimal 5 kontak per batch
  const contacts = await getPendingContacts(5);

  if (contacts.length === 0) {
    console.log("✨ Tidak ada kontak pending.");
    return;
  }

  console.log(`📤 Batch baru: ${contacts.length} kontak akan dikirim...`);

  for (const c of contacts) {
    const message = TEMPLATE_UTAMA.replace("{name}", c.name);

    const sent = await sendFonnte(c.phone, message);

    if (sent.success) {
      await markSent(c.id);
      console.log(`✅ Terkirim ke ${c.name} (${c.phone})`);
    } else {
      console.log(`❌ Gagal kirim ke ${c.name}`);
    }

    // Jeda antar kontak 5 detik
    console.log("⏳ Delay 5 detik sebelum kontak berikutnya...");
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Jeda batch 10 menit
  console.log("⏳ Menunggu 10 menit sebelum batch selanjutnya...");
  await new Promise((r) => setTimeout(r, 10 * 60 * 1000));
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

  if (rows.length === 0) {
    logInfo("✨ Tidak ada kontak untuk reminder.");
    return;
  }

  logInfo(`🔔 Mengirim reminder ke ${rows.length} kontak...`);

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

    // Jeda aman antar kontak reminder
    await new Promise((r) => setTimeout(r, 5000));
  }
});


// =========================================
// 🟦 CRON: KIRIM KONTAK PER BATCH
//    - Setiap 10 menit jalan
//    - 1 batch = 5 kontak
//    - Delay antar kontak = 5 detik
// =========================================
cron.schedule("*/10 * * * *", async () => {
  logInfo("⏳ Cron pengiriman berjalan (batch 5 setiap 10 menit)...");

  const contacts = await getPendingContacts(5); // ambil 5 saja
  if (contacts.length === 0) {
    logInfo("✨ Tidak ada kontak pending.");
    return;
  }

  logInfo(`📤 Mengirim batch: ${contacts.length} kontak...`);

  for (const c of contacts) {
    const message = TEMPLATE_UTAMA.replace("{name}", c.name);
    const sent = await sendFonnte(c.phone, message);

    if (sent.success) {
      await markSent(c.id);
      logInfo(`✅ Terkirim ke ${c.name} (${c.phone})`);
    } else {
      logError(`❌ Gagal kirim ke ${c.name}`);
    }

    // Delay antar kontak 5 detik
    await new Promise((r) => setTimeout(r, 5000));
  }

  logInfo("⏳ Batch selesai. Menunggu cron berikutnya 10 menit...");
});

// =========================================
// 🟦 CRON REMINDER: KIRIM SETELAH 24 JAM
//    - Cek setiap 30 menit
//    - Kirim reminder ke kontak yang:
//        ✔ status = 'sent'
//        ✔ belum pernah reply (last_reply IS NULL)
//        ✔ lebih dari 24 jam sejak last_sent
// =========================================
cron.schedule("*/30 * * * *", async () => {
  logInfo("🔔 Cron reminder 24 jam berjalan...");

  const q = `
    SELECT *
    FROM contacts
    WHERE status = 'sent'
      AND reminder_count < 1
      AND last_reply IS NULL
      AND (NOW() AT TIME ZONE 'Asia/Makassar') - last_sent > INTERVAL '24 hours'
    ORDER BY last_sent ASC
  `;

  const { rows } = await pool.query(q);

  if (rows.length === 0) {
    logInfo("✨ Tidak ada yang perlu dikirim reminder.");
    return;
  }

  logInfo(`🔔 Mengirim reminder untuk ${rows.length} kontak...`);

  for (const c of rows) {
    const sent = await sendFonnte(c.phone, TEMPLATE_REMINDER);

    if (sent.success) {
      await pool.query(`
        UPDATE contacts
        SET reminder_count = reminder_count + 1
        WHERE id = $1
      `, [c.id]);

      logInfo(`🔔 Reminder terkirim ke ${c.name} (${c.phone})`);
    } else {
      logError(`❌ Reminder gagal ke ${c.name}`);
    }

    // delay 5 detik antar kontak kiriman reminder
    await new Promise((r) => setTimeout(r, 5000));
  }
});

// =========================================
// 🟦 WEBHOOK FONNTE (BALASAN MASUK)
// =========================================
app.post("/webhook", async (req, res) => {
  appendWebhookLog(req.body);

  try {
    const body = req.body;

    // Fonnte MUST send type = 'incoming'
    if (!body || body.type !== "incoming") {
      logInfo("Webhook diterima, tetapi bukan incoming WA.");
      return res.json({ success: false });
    }

    const phone = normalizePhone(body.sender);
    const message = body.message || body.text || "";
    const timestamp = new Date().toISOString();

    if (!phone || !message) {
      logError("Webhook error: nomor atau pesan kosong.");
      return res.json({ success: false });
    }

    // Simpan ke tabel incoming_messages
    await pool.query(
      `
      INSERT INTO incoming_messages (phone, message, received_at)
      VALUES ($1, $2, NOW() AT TIME ZONE 'Asia/Makassar')
    `,
      [phone, message]
    );

    // Update kontak: berarti dia sudah balas
    await pool.query(
      `
      UPDATE contacts
      SET last_reply = NOW() AT TIME ZONE 'Asia/Makassar',
          status = 'replied'
      WHERE phone = $1
    `,
      [phone]
    );

    logInfo(`📥 Pesan masuk dari ${phone}: ${message}`);

    res.json({ success: true });
  } catch (err) {
    logError("❌ Webhook error:", err.message);
    res.status(500).json({ success: false });
  }
});

// ======================================================
// 🟦 SETUP POSTGRESQL CONNECTION
// ======================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ======================================================
// 🟦 MULTER (UPLOAD EXCEL)
// ======================================================
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 5 * 1024 * 1024 }, // max 5 MB
});

// ======================================================
// 🟦 NORMALISASI NOMOR HP
// ======================================================
function normalizePhone(phone) {
  if (!phone) return null;
  phone = phone.toString().trim();

  // contoh: 62812345678 → tetap
  if (phone.startsWith("62")) return phone;
  // contoh: 08123 → jadi 628123
  if (phone.startsWith("0")) return "62" + phone.substring(1);
  return phone;
}

// ======================================================
// 🟦 FUNGSI: AMBIL 5 KONTAK PENDING
// ======================================================
async function getPendingContacts(limit = 5) {
  const q = `
    SELECT *
    FROM contacts
    WHERE status = 'pending'
    ORDER BY id ASC
    LIMIT $1
  `;
  const { rows } = await pool.query(q, [limit]);
  return rows;
}

// ======================================================
// 🟦 FUNGSI: TANDAI KONTAK SUDAH TERKIRIM
// ======================================================
async function markSent(id) {
  await pool.query(`
    UPDATE contacts
    SET status = 'sent',
        last_sent = NOW() AT TIME ZONE 'Asia/Makassar'
    WHERE id = $1
  `, [id]);
}

// ======================================================
// 🟦 FUNGSI: KIRIM PESAN FONNTE
// ======================================================
async function sendFonnte(phone, message) {
  try {
    const form = new FormData();
    form.append("target", phone);
    form.append("message", message);

    const response = await axios.post(
      "https://api.fonnte.com/send",
      form,
      { headers: { Authorization: process.env.FONNTE_TOKEN, ...form.getHeaders() } }
    );

    return { success: response.data.status === "success" };
  } catch (err) {
    console.error("Fonnte error:", err.response?.data || err.message);
    return { success: false };
  }
}

// ======================================================
// 🟦 LOGGING
// ======================================================
function logInfo(msg) {
  console.log(`[INFO] ${new Date().toLocaleString("id-ID")} — ${msg}`);
}

function logError(msg) {
  console.error(`[ERROR] ${new Date().toLocaleString("id-ID")} — ${msg}`);
}

// ======================================================
// 🟦 SIMPAN LOG WEBHOOK KE FILE
// ======================================================
function appendWebhookLog(data) {
  try {
    const logPath = path.join(process.cwd(), "webhook.log");
    fs.appendFileSync(
      logPath,
      `[${new Date().toISOString()}] ${JSON.stringify(data)}\n`
    );
  } catch (err) {
    console.error("Gagal menulis webhook log:", err.message);
  }
}


// =========================================
// 🟦 SERVER LISTEN
// =========================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logInfo(`🚀 Server berjalan di port ${PORT}`);
  logInfo(`🕒 Timezone server: ${process.env.TZ}`);
  logInfo(`📡 Webhook aktif di: /webhook`);
  logInfo(`📤 Cron pengiriman aktif setiap 10 menit`);
  logInfo(`🔔 Cron reminder aktif jam 08:00 WITA`);
});