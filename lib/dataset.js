const fs = require('fs');
const path = require('path');

class DatasetManager {
    constructor() {
        // Mengarahkan pembacaan ke folder 'data'
        this.dataDir = path.join(__dirname, '../data');
    }

    // Fungsi untuk mengambil seluruh dokumen dari file JSON
    getAllDocuments() {
        let allDocs = [];
        try {
            if (!fs.existsSync(this.dataDir)) {
                fs.mkdirSync(this.dataDir); // Buat folder jika belum ada
                return allDocs;
            }

            const files = fs.readdirSync(this.dataDir);
            files.forEach(file => {
                if (file.endsWith('.json')) {
                    const filePath = path.join(this.dataDir, file);
                    const fileContent = fs.readFileSync(filePath, 'utf8');
                    const data = JSON.parse(fileContent);
                    
                    if (data.documents && Array.isArray(data.documents)) {
                        allDocs = allDocs.concat(data.documents);
                    }
                }
            });
        } catch (error) {
            console.error("Error saat membaca folder data:", error.message);
        }
        return allDocs;
    }
}

// Mengekspor class
module.exports = DatasetManager;