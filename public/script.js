const chatHeader = document.getElementById('chat-header');
const chatBody = document.getElementById('chat-body');
const chatToggleIcon = document.getElementById('chat-toggle-icon');
const sendBtn = document.getElementById('send-btn');
const userInput = document.getElementById('user-input');
const chatMessages = document.getElementById('chat-messages');

// Fungsi Buka/Tutup Chat (Collapse)
chatHeader.addEventListener('click', () => {
    if (chatBody.style.display === 'flex') {
        chatBody.style.display = 'none';
        chatToggleIcon.textContent = '▲';
    } else {
        chatBody.style.display = 'flex';
        chatToggleIcon.textContent = '▼';
        userInput.focus();
    }
});

// Fungsi Menambahkan Bubble Chat ke UI
function appendMessage(sender, text) {
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('msg');
    msgDiv.classList.add(sender === 'user' ? 'user-msg' : 'bot-msg');
    msgDiv.textContent = text;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight; // Scroll ke bawah
}

// Fungsi Kirim Pesan ke API
async function sendMessage() {
    const message = userInput.value.trim();
    if (!message) return;

    // Tampilkan pesan user
    appendMessage('user', message);
    userInput.value = '';

    // Tampilkan tulisan "Mengetik..." sementara
    const typingDiv = document.createElement('div');
    typingDiv.classList.add('msg', 'bot-msg');
    typingDiv.textContent = 'Mengetik...';
    typingDiv.id = 'typing-indicator';
    chatMessages.appendChild(typingDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    try {
        // Tembak API lokal kita
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: message })
        });
        
        const data = await response.json();
        
        // Hapus tulisan "Mengetik..."
        document.getElementById('typing-indicator').remove();
        
        // Tampilkan balasan AI
        appendMessage('bot', data.reply);
    } catch (error) {
        document.getElementById('typing-indicator').remove();
        appendMessage('bot', 'Maaf, sistem sedang offline atau terjadi kesalahan jaringan.');
    }
}

sendBtn.addEventListener('click', sendMessage);

userInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendMessage();
    }
});