class RAGEngine {
    constructor() {}

    // Fungsi untuk mencari dokumen yang paling relevan dengan pertanyaan
    retrieveContext(query, documents) {
        if (!query || !documents || documents.length === 0) return [];

        // Pecah pertanyaan menjadi kata kunci
        const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        
        let scoredDocs = documents.map(doc => {
            let score = 0;
            const text = (doc.text || "").toLowerCase();
            
            // Beri skor jika dokumen mengandung kata kunci dari pertanyaan
            keywords.forEach(kw => {
                if (text.includes(kw)) score++;
            });
            
            return { ...doc, score };
        });

        // Ambil dokumen yang memiliki skor > 0, urutkan dari yang paling relevan
        scoredDocs = scoredDocs.filter(d => d.score > 0).sort((a, b) => b.score - a.score);
        
        // Kembalikan maksimal 3 dokumen teratas agar AI tidak bingung
        return scoredDocs.slice(0, 3);
    }

    // Fungsi untuk merakit dokumen menjadi teks konteks untuk AI
    buildContextBlock(contextItems) {
        if (!contextItems || contextItems.length === 0) return "";
        return contextItems.map(item => `[Sumber: ${item.source}]\n${item.text}`).join('\n\n');
    }
}

// Mengekspor class agar bisa dibaca oleh server.js
module.exports = RAGEngine;