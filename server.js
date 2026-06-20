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
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DOCS_FILE)) fs.writeFileSync(DOCS_FILE, JSON.stringify([], null, 2));
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// MEMORI LOKAL CHATBOT (Ditambahkan kembali agar AI tidak amnesia)
let conversationMemory = [];

function normalizePdfDocument(doc) {
    if (doc.type !== 'pdf') return doc;
    const normalized = { ...doc };
    const originalTitle = normalized.originalName || (typeof normalized.source === 'string' && normalized.source.startsWith('PDF: ') ? normalized.source.slice(5).trim() : '');
    if (!normalized.originalName && originalTitle) normalized.originalName = originalTitle;
    if (!normalized.fileName && originalTitle) normalized.fileName = sanitizeFileName(originalTitle);
    if (!normalized.fileUrl && normalized.fileName) normalized.fileUrl = `/uploads/${normalized.fileName}`;
    return normalized;
}

function readDocuments() {
    const docs = JSON.parse(fs.readFileSync(DOCS_FILE, 'utf8'));
    return docs.map(normalizePdfDocument);
}
function writeDocuments(docs) { fs.writeFileSync(DOCS_FILE, JSON.stringify(docs, null, 2)); }
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substring(2, 8); }

function sanitizeFileName(name) {
    return name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

function normalizeSearchText(text) {
    return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getSearchTerms(message) {
    const normalized = normalizeSearchText(message);
    const stopWords = new Set(['apa', 'itu', 'yang', 'dan', 'atau', 'pada', 'dari', 'untuk', 'dengan', 'dalam', 'adalah', 'berapa', 'bagaimana', 'jelaskan', 'sebutkan', 'tidak', 'boleh']);
    const terms = normalized.split(/\s+/).filter(term => term.length > 2 && !stopWords.has(term));
    const aliases = [
        { triggers: ['skpi'], terms: ['skpi', 'surat', 'keterangan', 'pendamping', 'ijazah'], replace: true },
        { triggers: ['eprt'], terms: ['eprt', 'english', 'proficiency', 'test'], replace: true },
        { triggers: ['berhenti kuliah sementara', 'rehat kuliah', 'nonaktif sementara'], terms: ['cuti', 'akademik', 'mengambil'], replace: true },
        { triggers: ['dokumen setelah lulus', 'dokumen kelulusan'], terms: ['ijazah', 'transkrip', 'skpi', 'pendamping'], replace: true },
        { triggers: ['pujian'], terms: ['cumlaude', 'cum', 'laude', 'predikat', 'lulusan'], replace: true },
        { triggers: ['siap kerja'], terms: ['work', 'ready', 'programs', 'wrap'], replace: true }
    ];

    for (const alias of aliases) {
        if (alias.triggers.some(trigger => normalized.includes(trigger))) {
            if (alias.replace) return [...new Set(alias.terms)];
            terms.push(...alias.terms);
        }
    }

    return [...new Set(terms)];
}

function getQueryHint(message) {
    const normalized = normalizeSearchText(message);
    if (normalized.includes('berhenti kuliah sementara') || normalized.includes('rehat kuliah') || normalized.includes('nonaktif sementara')) {
        return 'Catatan: pertanyaan tentang berhenti kuliah sementara merujuk pada istilah "cuti akademik" di dokumen.';
    }
    if (normalized.includes('dokumen setelah lulus') || normalized.includes('dokumen kelulusan')) {
        return 'Catatan: pertanyaan tentang dokumen setelah lulus merujuk pada ijazah, transkrip akademik, dan SKPI.';
    }
    if (normalized.includes('siap kerja')) {
        return 'Catatan: pertanyaan tentang program siap kerja merujuk pada WRAP atau Work Ready Programs.';
    }
    return '';
}

function isUnavailableReply(reply) {
    const normalized = normalizeSearchText(reply);
    return normalized.includes('maaf informasi tidak tersedia')
        || normalized.includes('informasi tidak tersedia')
        || normalized.includes('tidak bisa menjawab');
}

function splitIntoChunks(text, chunkSize = 2500, overlap = 400) {
    const chunks = [];
    for (let start = 0; start < text.length; start += chunkSize - overlap) {
        chunks.push(text.substring(start, start + chunkSize));
    }
    return chunks;
}

function findRelevantPdfChunks(message, pdfDocs) {
    const terms = getSearchTerms(message);
    if (!pdfDocs.length || !terms.length) return [];

    const scoredChunks = [];
    for (const doc of pdfDocs) {
        const title = normalizeSearchText(doc.title || doc.originalName || doc.source || '');
        for (const chunk of splitIntoChunks(doc.text || '')) {
            const normalizedChunk = normalizeSearchText(chunk);
            let score = 0;

            for (const term of terms) {
                if (normalizedChunk.includes(term)) score += term.length > 4 ? 3 : 2;
                if (title.includes(term)) score += 2;
            }

            if (terms.length > 1 && terms.every(term => normalizedChunk.includes(term))) score += 12;
            if (normalizedChunk.includes(terms.join(' '))) score += 8;
            if (score > 0 && normalizedChunk.includes('adalah')) score += 5;
            if (score > 0) scoredChunks.push({ doc, text: chunk, score });
        }
    }

    return scoredChunks.sort((a, b) => b.score - a.score).slice(0, 5);
}

// 2. Ekstraksi PDF dengan Algoritma Penyelamat Format Tabel (Y-X Coordinate Mapping)
async function extractTextFromPDF(pdfBuffer) {
    return new Promise((resolve, reject) => {
        const pdfParser = new PDFParser();
        let fullText = '';
        pdfParser.on('pdfParser_dataError', reject);
        pdfParser.on('pdfParser_dataReady', (pdfData) => {
            try {
                if (pdfData && pdfData.Pages) {
                    for (const page of pdfData.Pages) {
                        // Mengelompokkan teks berdasarkan posisi Y (baris tabel)
                        const rows = {};
                        if (page.Texts) {
                            for (const t of page.Texts) {
                                // Gunakan pembulatan posisi Y agar teks yang sejajar dianggap satu baris
                                const yPos = Math.round(t.y * 2) / 2;
                                if (!rows[yPos]) rows[yPos] = [];
                                
                                if (t.R) {
                                    for (const r of t.R) {
                                        if (r.T) {
                                            let decoded = r.T;
                                            try { decoded = decodeURIComponent(r.T); } catch(e) {}
                                            // Simpan teks beserta posisi X (kolom tabel)
                                            rows[yPos].push({ x: t.x, text: decoded.trim() });
                                        }
                                    }
                                }
                            }
                        }
                        
                        // Susun ulang teks dari atas ke bawah (Y), lalu kiri ke kanan (X)
                        const sortedY = Object.keys(rows).sort((a, b) => parseFloat(a) - parseFloat(b));
                        for (const y of sortedY) {
                            // Urutkan data dalam satu baris berdasarkan kolom (X)
                            const rowItems = rows[y].sort((a, b) => a.x - b.x);
                            // Gabungkan teks dalam satu baris menggunakan pembatas " | " agar AI paham itu tabel
                            const rowText = rowItems.map(item => item.text).join(' | ');
                            fullText += rowText + '\n';
                        }
                        fullText += '\n\n';
                    }
                }
                console.log(`📄 PDF berhasil direkonstruksi dengan format tabel. Total: ${fullText.length} karakter`);
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

        const originalName = path.basename(req.file.originalname);
        const safeName = sanitizeFileName(originalName);
        let fileName = safeName || `document-${generateId()}.pdf`;
        let filePath = path.join(UPLOAD_DIR, fileName);
        let counter = 1;
        while (fs.existsSync(filePath)) {
            const ext = path.extname(safeName);
            const base = path.basename(safeName, ext);
            fileName = `${base}-${counter}${ext}`;
            filePath = path.join(UPLOAD_DIR, fileName);
            counter += 1;
        }

        fs.writeFileSync(filePath, req.file.buffer);
        const text = await extractTextFromPDF(req.file.buffer);
        if (!text) {
            fs.unlinkSync(filePath);
            return res.status(400).json({ error: 'PDF tidak mengandung teks' });
        }

        const fileUrl = `/uploads/${fileName}`;
        const docs = readDocuments();
        const newDoc = {
            id: generateId(),
            title: originalName,
            originalName,
            fileName,
            fileUrl,
            source: `PDF: ${originalName}`,
            text,
            type: 'pdf',
            createdAt: new Date().toISOString()
        };
        docs.push(newDoc);
        writeDocuments(docs);
        console.log(`📄 PDF diproses: "${originalName}" (${text.length} karakter)`);
        res.json({ message: 'PDF berhasil diproses', doc: newDoc });
    } catch(err) {
        console.error(err);
        res.status(500).json({ error: 'Gagal proses PDF: ' + err.message });
    }
});

// ==========================================
// ENDPOINT CHATBOT AI (Fix Sapaan & Memori Konteks)
// ==========================================
app.post('/api/chat', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ reply: 'Pesan tidak boleh kosong.', sources: [] });
        console.log(`\n📩 [USER]: ${message}`);

        // 1. CEK SAPAAN (Menghindari RAG & Sumber PDF muncul di awal percakapan)
        const isPureGreeting = /^(halo|p|min|test|pagi|siang|sore|malam|boleh tanya|permisi|hai|aku|saya|perkenalkan|nama)\b/i.test(message.trim().toLowerCase());
        
        if (isPureGreeting) {
            // Reset memori jika sapaan sangat pendek
            if (/^(halo|p|min|test|pagi|siang|sore|malam)$/i.test(message.trim().toLowerCase())) {
                conversationMemory = []; 
            }
            const jam = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta", hour: '2-digit', hour12: false });
            let sapaanWaktu = "malam";
            if (jam >= 5 && jam < 11) sapaanWaktu = "pagi";
            else if (jam >= 11 && jam < 15) sapaanWaktu = "siang";
            else if (jam >= 15 && jam < 18) sapaanWaktu = "sore";

            const reply = `Selamat ${sapaanWaktu}! Halo, saya asisten AI SSC Telkom University Surabaya. Ada yang bisa saya bantu terkait layanan akademik hari ini?`;
            
            conversationMemory.push({ role: 'user', content: message });
            conversationMemory.push({ role: 'assistant', content: reply });
            
            // Langsung kembalikan balasan tanpa sumber dokumen
            return res.json({ reply, sources: [] }); 
        }

        // 2. CONTEXTUAL QUERY EXPANSION (Menggabungkan pesan agar nyambung, misal: "biaya semester nya")
        let searchQuery = message;
        if (conversationMemory.length > 0) {
            const lastUserMsg = [...conversationMemory].reverse().find(msg => msg.role === 'user');
            if (lastUserMsg) {
                searchQuery = `${lastUserMsg.content} ${message}`;
            }
        }

        const allDocs = readDocuments();
        if (allDocs.length === 0) return res.json({ reply: "Belum ada data. Silakan upload PDF atau admin tambah data manual.", sources: [] });

        const manualDocs = allDocs.filter(d => d.type === 'manual');
        const pdfDocs = allDocs.filter(d => d.type === 'pdf');

        // Cari jawaban di data manual menggunakan searchQuery (bukan message biasa)
        const manualAnswer = findManualAnswer(searchQuery, manualDocs);
        if (manualAnswer) {
            console.log(`✅ Menjawab langsung dari data manual: ${manualAnswer}`);
            conversationMemory.push({ role: 'user', content: message });
            conversationMemory.push({ role: 'assistant', content: manualAnswer });
            return res.json({ reply: manualAnswer, sources: [] });
        }

        // Cari di chunk PDF menggunakan searchQuery
        const relevantPdfChunks = findRelevantPdfChunks(searchQuery, pdfDocs);
        const contextDocs = [...manualDocs];

        let allText = '';
        const queryHint = getQueryHint(searchQuery);
        if (queryHint) allText += `${queryHint}\n\n`;
        for (const item of relevantPdfChunks) {
            const label = `PDF: ${item.doc.title || item.doc.originalName || item.doc.source}`;
            allText += `[${label}]\n${item.text}\n\n`;
        }
        for (const doc of contextDocs) {
            const label = doc.type === 'pdf' ? `PDF: ${doc.title || doc.originalName}` : doc.source;
            allText += `[${label}]\n${doc.text}\n\n`;
        }
        
        // (KODE LAMA MILIK KEVIN YANG MENYEBABKAN HALUSINASI PDF DIHAPUS DARI SINI)

        const MAX_LEN = 6000;
        if (allText.length > MAX_LEN) allText = allText.substring(0, MAX_LEN);
        console.log(`📚 Teks ke AI: ${allText.length} karakter`);

        const systemPrompt = `Anda adalah asisten SSC Telkom University Surabaya. Jawab pertanyaan berdasarkan teks yang diberikan secara ramah dan natural. Jika informasi tidak tersedia di teks, JANGAN MENGARANG, cukup jawab "Maaf, informasi tidak tersedia." Gunakan data dokumen yang relevan saja.

TEKS:\n${allText}`;

        // Menggabungkan Memori ke dalam Prompt Groq
        const groqMessages = [{ role: 'system', content: systemPrompt }];
        conversationMemory.forEach(msg => groqMessages.push(msg));
        groqMessages.push({ role: 'user', content: message });

        const completion = await groq.chat.completions.create({
            messages: groqMessages,
            model: 'llama-3.1-8b-instant',
            temperature: 0.1, // Suhu diturunkan drastis agar tidak mengarang jawaban
            max_tokens: 350,
        });
        
        const reply = completion.choices?.[0]?.message?.content || 'Maaf, saya tidak bisa menjawab.';
        
        // Update Memori
        conversationMemory.push({ role: 'user', content: message });
        conversationMemory.push({ role: 'assistant', content: reply });
        if (conversationMemory.length > 12) {
            conversationMemory.shift();
            conversationMemory.shift();
        }

        const selectedSourceDocs = [...new Map(relevantPdfChunks.map(item => [item.doc.id || item.doc.fileUrl || item.doc.source, item.doc])).values()];
        const sources = isUnavailableReply(reply) ? [] : selectedSourceDocs.map(doc => ({
            title: doc.title || doc.originalName || doc.fileName,
            url: doc.fileUrl || (doc.fileName ? `/uploads/${doc.fileName}` : null),
            type: 'pdf'
        })).filter(src => src.url);
        
        console.log(`✅ [AI]: ${reply}`);
        res.json({ reply, sources });
    } catch(err) {
        console.error(err);
        res.status(500).json({ reply: 'Maaf, server error.', sources: [] });
    }
});

app.listen(PORT, () => console.log(`✅ Server siap di http://localhost:${PORT}`));