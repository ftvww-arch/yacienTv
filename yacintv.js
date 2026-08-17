const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// قائمة المصادر
const sourceUrls = [
    "https://daddylive.mov/cache/channels.json?v=1785871295137&r=0.817095409251016",
    "https://daddylive.mov/player/player5.json?v=1785871295137",
    "https://daddylive.mov/player/player10.json?v=1785871295137",
    "https://daddylive.mov/player/player14.json?v=1785871295138",
    "https://daddylive.mov/player/player6.json?v=1785871295138",
    "https://daddylive.mov/player/player2.json?v=1785871295139",
    "https://daddylive.mov/player/player9.json?v=1785871295139",
    "https://daddylive.mov/player/player11.json?v=1785871295139"
];

// دالة جلب البيانات المباشرة بالتوازي
async function fetchLiveChannels() {
    let allProcessedChannels = [];

    const requests = sourceUrls.map(url => 
        axios.get(url, { timeout: 8000 }).catch(err => {
            console.error(`خطأ في جلب: ${url}`, err.message);
            return null;
        })
    );

    const responses = await Promise.all(requests);

    responses.forEach(response => {
        if (response && Array.isArray(response.data)) {
            response.data.forEach(item => {
                const channelName = item.title || item.name;
                if (!channelName || channelName.includes("Channel not listed")) return;

                let servers = [];

                if (item.url) {
                    servers.push({ name: "Main Server", link: item.url });
                }

                Object.keys(item).forEach(key => {
                    if (key.startsWith('url') && item[key]) {
                        servers.push({ name: key.toUpperCase(), link: item[key] });
                    }
                });

                allProcessedChannels.push({
                    id: String(item.id || ""),
                    name: channelName.trim(),
                    servers: servers
                });
            });
        }
    });

    const uniqueChannels = Array.from(new Map(allProcessedChannels.map(c => [c.name, c])).values());
    return uniqueChannels.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------- API Endpoints ---------------------- //

// 1. طلب القنوات حسب الحرف (مخرج مباشر كـ Array)
app.get('/api/channels/:letter', async (req, res) => {
    try {
        const letter = req.params.letter.toUpperCase();
        const allChannels = await fetchLiveChannels();

        const filteredChannels = allChannels.filter(channel => {
            const firstLetter = channel.name.trim().charAt(0).toUpperCase();
            if (letter === '0-9') {
                return !/^[A-Z]$/.test(firstLetter);
            }
            return firstLetter === letter;
        });

        // إرجاع مصفوفة مباشرة جاهزة لـ Sketchware
        res.json(filteredChannels);
    } catch (error) {
        res.status(500).json([]);
    }
});

// 2. البحث باسم القناة (مخرج مباشر كـ Array)
app.get('/api/search/:name', async (req, res) => {
    try {
        const query = req.params.name.trim().toLowerCase();
        const allChannels = await fetchLiveChannels();

        const results = allChannels.filter(channel => 
            channel.name.toLowerCase().includes(query)
        );

        // إرجاع مصفوفة مباشرة جاهزة لـ Sketchware
        res.json(results);
    } catch (error) {
        res.status(500).json([]);
    }
});

app.listen(PORT, () => {
    console.log(`🚀 API Running on port ${PORT}`);
});
