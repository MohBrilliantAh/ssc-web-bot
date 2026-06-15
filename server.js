require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { Groq } = require('groq-sdk');
const PDFParser = require('pdf2json');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage() });

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
    console.error('❌ GROQ_API_KEY tidak ditemukan di file .env');
    process.exit(1);
}
console.log('✅ API Key terdeteksi');
const groq = new Groq({ apiKey: GROQ_API_KEY });

const DATA_DIR = path.join(__dirname, 'data');
const DOCS_FILE = path.join(DATA_DIR, 'documents.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DOCS_FILE)) fs.writeFileSync(DOCS_FILE, JSON.stringify([], null, 2));

function readDocuments() { return JSON.parse(fs.readFileSync(DOCS_FILE, 'utf8')); }
function writeDocuments(docs) { fs.writeFileSync(DOCS_FILE, JSON.stringify(docs, null, 2)); }
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substring(2, 8); }

// Ekstraksi PDF
async function extractTextFromPDF(pdfBuffer) {
    return new Promise((resolve, reject) => {
        const pdfParser = new PDFParser();
        let fullText = '';
        pdfParser.on('pdfParser_dataError', reject);
        pdfParser.on('pdfParser_dataReady', (pdfData) => {
            try {
                if (pdfData && pdfData.Pages) {
                    for (const page of pdfData.Pages) {
                        if (page.Texts) {
                            for (const t of page.Texts) {
                                if (t.R) {
                                    for (const r of t.R) {
                                        if (r.T) {
                                            let decoded = r.T;
                                            try { decoded = decodeURIComponent(r.T); } catch(e) {}
                                            fullText += decoded + ' ';
                                        }
                                    }
                                }
                            }
                        }
                        fullText += '\n\n';
                    }
                }
                console.log(`📄 Halaman: ${pdfData.Pages?.length || 0}, teks: ${fullText.length} karakter`);
                resolve(fullText.trim());
            } catch (err) { reject(err); }
        });
        pdfParser.parseBuffer(pdfBuffer);
    });
}

// Helper untuk mencari jawaban dari data manual berdasarkan kata kunci
function findManualAnswer(message, manualDocs) {
    const q = message.toLowerCase();
    for (const doc of manualDocs) {
        const text = doc.text.toLowerCase();
        // Cek apakah pertanyaan mengandung kata kunci biaya
        if ((q.includes('biaya') || q.includes('harga') || q.includes('uang') || q.includes('berapakah') || q.includes('berapa')) && 
            (text.includes('biaya') || text.includes('pembayaran') || text.includes('jt') || text.includes('30') || text.includes('35'))) {
            return doc.text;
        }
        // Cek apakah pertanyaan mengandung kata kunci sks
        if ((q.includes('sks') || q.includes('lulus') || q.includes('minimal')) && 
            (text.includes('sks') || text.includes('beban') || text.includes('144') || text.includes('160'))) {
            return doc.text;
        }
        // Cek program studi
        if ((q.includes('program studi') || q.includes('prodi')) && 
            (text.includes('program studi') || text.includes('prodi'))) {
            return doc.text;
        }
        // Fallback: jika pertanyaan mirip dengan source
        if (q.includes(doc.source.toLowerCase())) {
            return doc.text;
        }
    }
    return null;
}

// CRUD
app.get('/api/documents', (req, res) => { try { res.json(readDocuments()); } catch(e) { res.status(500).json({ error: 'Gagal baca data' }); } });
app.post('/api/documents', (req, res) => {
    try {
        const { source, text } = req.body;
        if (!source || !text) return res.status(400).json({ error: 'Source dan text wajib diisi' });
        const docs = readDocuments();
        // Perkaya teks dengan kata kunci umum
        let enhancedText = text;
        if (text.toLowerCase().includes('biaya') || text.toLowerCase().includes('pembayaran') || text.toLowerCase().includes('jt')) {
            enhancedText = `[INFO BIAYA] ${text} Ini informasi biaya kuliah, uang semester, pembayaran. ` + text;
        }
        const newDoc = { id: generateId(), source: source.trim(), text: enhancedText, type: 'manual', createdAt: new Date().toISOString() };
        docs.push(newDoc);
        writeDocuments(docs);
        console.log(`📝 Dokumen manual ditambahkan: "${source}"`);
        res.status(201).json(newDoc);
    } catch(e) { res.status(500).json({ error: 'Gagal simpan' }); }
});
app.put('/api/documents/:id', (req, res) => {
    try {
        const { id } = req.params;
        const { source, text } = req.body;
        const docs = readDocuments();
        const idx = docs.findIndex(d => d.id === id);
        if (idx === -1) return res.status(404).json({ error: 'Dokumen tidak ditemukan' });
        docs[idx].source = source.trim();
        docs[idx].text = text.trim();
        docs[idx].updatedAt = new Date().toISOString();
        writeDocuments(docs);
        res.json({ message: 'Dokumen diperbarui' });
    } catch(e) { res.status(500).json({ error: 'Gagal update' }); }
});
app.delete('/api/documents/:id', (req, res) => {
    try {
        const { id } = req.params;
        const docs = readDocuments();
        const filtered = docs.filter(d => d.id !== id);
        if (filtered.length === docs.length) return res.status(404).json({ error: 'Dokumen tidak ditemukan' });
        writeDocuments(filtered);
        res.json({ message: 'Dokumen dihapus' });
    } catch(e) { res.status(500).json({ error: 'Gagal hapus' }); }
});

// Upload PDF
app.post('/api/upload-pdf', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Tidak ada file' });
        if (req.file.mimetype !== 'application/pdf') return res.status(400).json({ error: 'Hanya file PDF' });
        const text = await extractTextFromPDF(req.file.buffer);
        if (!text) return res.status(400).json({ error: 'PDF tidak mengandung teks' });
        const docs = readDocuments();
        const newDoc = { id: generateId(), source: `PDF: ${req.file.originalname}`, text: text, type: 'pdf', originalName: req.file.originalname, createdAt: new Date().toISOString() };
        docs.push(newDoc);
        writeDocuments(docs);
        console.log(`📄 PDF diproses: "${req.file.originalname}" (${text.length} karakter)`);
        res.json({ message: 'PDF berhasil diproses', doc: newDoc });
    } catch(err) { res.status(500).json({ error: 'Gagal proses PDF: ' + err.message }); }
});

// Chatbot dengan prioritas manual langsung
app.post('/api/chat', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ reply: 'Pesan tidak boleh kosong.' });
        console.log(`\n📩 [USER]: ${message}`);

        const allDocs = readDocuments();
        if (allDocs.length === 0) return res.json({ reply: "Belum ada data. Silakan upload PDF atau admin tambah data manual." });

        const manualDocs = allDocs.filter(d => d.type === 'manual');
        const pdfDocs = allDocs.filter(d => d.type === 'pdf');

        // Cari jawaban dari data manual secara langsung
        const manualAnswer = findManualAnswer(message, manualDocs);
        if (manualAnswer) {
            console.log(`✅ Menjawab langsung dari data manual: ${manualAnswer}`);
            return res.json({ reply: manualAnswer });
        }

        // Jika tidak ada manual, gunakan AI dengan menggabungkan manual + PDF (manual di awal)
        let allText = '';
        for (const doc of manualDocs) allText += `[${doc.source}]\n${doc.text}\n\n`;
        for (const doc of pdfDocs) allText += `[${doc.source}]\n${doc.text}\n\n`;
        const MAX_LEN = 6000;
        if (allText.length > MAX_LEN) allText = allText.substring(0, MAX_LEN);
        console.log(`📚 Teks ke AI: ${allText.length} karakter`);

        const systemPrompt = `Anda asisten SSC Telkom University Surabaya. Jawab berdasarkan teks. Jika tidak ada informasi, katakan "Maaf, informasi tidak tersedia." Maksimal 3 kalimat.

TEKS:\n${allText}`;

        const completion = await groq.chat.completions.create({
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: message }],
            model: 'llama-3.1-8b-instant',
            temperature: 0.2,
            max_tokens: 350,
        });
        const reply = completion.choices[0].message.content;
        console.log(`✅ [AI]: ${reply}`);
        res.json({ reply });
    } catch(err) {
        console.error(err);
        res.status(500).json({ reply: 'Maaf, server error.' });
    }
});

app.listen(PORT, () => console.log(`✅ Server siap di http://localhost:${PORT}`));