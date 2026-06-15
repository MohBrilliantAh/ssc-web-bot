require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const Groq = require('groq-sdk');

const RAGEngine = require('./lib/rag');
const DatasetManager = require('./lib/dataset');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const ragEngine = new RAGEngine();
const datasetManager = new DatasetManager();

const CRUD_FILE_PATH = path.join(__dirname, 'data', 'crud_documents.json');

// MEMORI LOKAL CHATBOT
let conversationMemory = [];

function readCrudDatabase() {
    if (!fs.existsSync(CRUD_FILE_PATH)) {
        fs.writeFileSync(CRUD_FILE_PATH, JSON.stringify({ documents: [] }, null, 2));
    }
    return JSON.parse(fs.readFileSync(CRUD_FILE_PATH, 'utf8'));
}

function writeCrudDatabase(data) {
    fs.writeFileSync(CRUD_FILE_PATH, JSON.stringify(data, null, 2));
}

function loadBehavior() {
    try {
        const behaviorFile = path.join(__dirname, 'config', 'behavior.json');
        if (!fs.existsSync(behaviorFile)) return null;
        return JSON.parse(fs.readFileSync(behaviorFile, 'utf8'));
    } catch (error) { return null; }
}

// ==========================================
// GERBANG REST API UNTUK DASHBOARD ADMIN (CRUD) - AMAN
// ==========================================
app.get('/api/documents', (req, res) => {
    try { res.json(readCrudDatabase().documents); } catch (error) { res.status(500).json({ error: "Gagal." }); }
});

app.post('/api/documents', (req, res) => {
    try {
        const { source, text } = req.body;
        if (!source || !text) return res.status(400).json({ error: "Data tidak lengkap." });
        const db = readCrudDatabase();
        const newDoc = { id: Date.now().toString(), source, text };
        db.documents.push(newDoc);
        writeCrudDatabase(db);
        res.json({ message: "Sukses!", data: newDoc });
    } catch (error) { res.status(500).json({ error: "Gagal." }); }
});

app.put('/api/documents/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { source, text } = req.body;
        const db = readCrudDatabase();
        const idx = db.documents.findIndex(d => d.id === id);
        if (idx === -1) return res.status(404).json({ error: "Tidak ditemukan." });
        db.documents[idx].source = source;
        db.documents[idx].text = text;
        writeCrudDatabase(db);
        res.json({ message: "Diperbarui!" });
    } catch (error) { res.status(500).json({ error: "Gagal." }); }
});

app.delete('/api/documents/:id', (req, res) => {
    try {
        const { id } = req.params;
        const db = readCrudDatabase();
        db.documents = db.documents.filter(d => d.id !== id);
        writeCrudDatabase(db);
        res.json({ message: "Dihapus!" });
    } catch (error) { res.status(500).json({ error: "Gagal." }); }
});


// ==========================================
// ENDPOINT CHATBOT AI - PERBAIKAN LOGIKA PEMISAH KONTEKS MABA VS MHS AKTIF
// ==========================================
app.post('/api/chat', async (req, res) => {
    try {
        const userMessage = req.body.message;
        if (!userMessage) return res.status(400).json({ reply: "Pesan kosong." });

        console.log(`[USER]: ${userMessage}`);

        // Reset memori jika mendeteksi sapaan murni di awal
        const isPureGreeting = /^(halo|p|min|test|pagi|siang|sore|malam|boleh tanya ga|permisi)$/i.test(userMessage.trim().toLowerCase());
        if (isPureGreeting) {
            conversationMemory = [];
        }

        const behavior = loadBehavior();
        const fallbackText = behavior ? behavior.fallback_response : "Maaf, data belum tersedia.";
        const systemInstructions = behavior ? behavior.system_instructions : "Anda adalah asisten AI.";
        const maxSentences = behavior ? behavior.max_sentences : 4;

        const allDocs = datasetManager.getAllDocuments();
        const contextItems = ragEngine.retrieveContext(userMessage, allDocs);
        const contextBlock = ragEngine.buildContextBlock(contextItems);

        const jam = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", hour: '2-digit', hour12: false });
        let sapaanWaktu = "malam";
        if (jam >= 5 && jam < 11) sapaanWaktu = "pagi";
        else if (jam >= 11 && jam < 15) sapaanWaktu = "siang";
        else if (jam >= 15 && jam < 18) sapaanWaktu = "sore";

        // PENGETATAN ATURAN LOGIKA AGAR TIDAK BLINDLY BALAS SESUAI TEKS RAG YANG SALAH SASARAN
        const systemMessage = `${systemInstructions}
        
        ATURAN UTAMA PENULISAN BALASAN:
        1. Jika pesan user HANYA berisi sapaan pendek pembuka, CUKUP balas dengan: "Selamat ${sapaanWaktu}! Ada yang bisa aku bantu terkait layanan akademik TUS?"
        2. Perhatikan histori obrolan sebelumnya untuk memahami alur konteks (seperti kata 'bukan', 'maksudnya', 'konteks ku maba'). Jawablah secara nyambung dan logis.
        3. DILARANG KERAS mengulang sapaan "Selamat ${sapaanWaktu}" jika obrolan sudah berjalan dalam bentuk sesi diskusi lanjutan.
        4. EVALUASI KONTEKS SECARA KRITIS (Mencegah Halusinasi): Anda harus membedakan dengan jelas status 'Mahasiswa Baru / Calon Mahasiswa (Maba)' dengan 'Mahasiswa Aktif / Mahasiswa Tingkat Akhir (Sidang/Kelulusan)'. 
           - JANGAN PERNAH menerapkan aturan Sidang Tugas Akhir atau Kelulusan kepada Mahasiswa Baru.
           - Jika user menegaskan bahwa statusnya adalah Mahasiswa Baru (Maba) sedangkan 'Konteks Dokumen' yang Anda terima hanya berisi aturan EPrT/TOEFL untuk syarat kelulusan sidang, gunakan logika berpikir manusia: sampaikan dengan ramah bahwa untuk Mahasiswa Baru (proses pendaftaran/registrasi awal) TIDAK ADA persyaratan tes EPrT tersebut.
        5. Jika informasi benar-benar tidak ada di dokumen dan tidak bisa disimpulkan secara nalar, gunakan kalimat ini: "${fallbackText}"
        6. Jawab secara singkat, padat, ramah, dan langsung ke inti masalah maksimal ${maxSentences} kalimat.`;

        const promptMessage = `Konteks Dokumen Kampus dari PDF:\n${contextBlock ? contextBlock : "KOSONG"}\n\nPesan User Saat Ini: "${userMessage}"`;

        const groqMessages = [{ role: 'system', content: systemMessage }];
        
        conversationMemory.forEach(msg => groqMessages.push(msg));
        groqMessages.push({ role: 'user', content: promptMessage });

        const completion = await groq.chat.completions.create({
            messages: groqMessages,
            model: 'llama-3.1-8b-instant',
            temperature: 0.1 // Diturunkan ke 0.1 agar AI bekerja sangat kaku berdasarkan instruksi logika logika penolak kontaminasi
        });

        const aiReply = completion.choices[0].message.content;
        console.log(`[AI]: ${aiReply}`);

        conversationMemory.push({ role: 'user', content: userMessage });
        conversationMemory.push({ role: 'assistant', content: aiReply });
        if (conversationMemory.length > 12) {
            conversationMemory.shift();
            conversationMemory.shift();
        }

        res.json({ reply: aiReply });

    } catch (error) {
        console.error("Error API Chat:", error.message);
        res.status(500).json({ reply: "Maaf, server sedang mengalami gangguan." });
    }
});

app.use((req, res) => {
    res.status(404).send("Halaman tidak ditemukan.");
});

app.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`Server Berjalan Sukses! http://localhost:${PORT}`);
    console.log(`=================================`);
});