const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;

// ==========================================
// الإعدادات العامة (يمكنك تغيير الـ API من هنا بسهولة)
// ==========================================
const CONFIG = {
    API_BASE_URL: 'https://s3-1nft.onrender.com/yacintv',
    CACHE_DURATION: 300000, // 5 دقائق للسيرفرات
    MANIFEST_CACHE: 2000    // ثانيتين للمانيفست (لضمان عمل الآيفون)
};

// ==========================================
// دوال التشفير وفك التشفير لأسماء القنوات
// ==========================================
function encodeId(text) {
    return Buffer.from(text).toString('hex');
}

function decodeId(hash) {
    try {
        return Buffer.from(hash, 'hex').toString('utf8');
    } catch (e) {
        return null;
    }
}

// ==========================================
// 1. محرك الكاش المتقدم (Single Flight)
// ==========================================
const CacheEngine = {
    memory: new Map(),
    inFlight: new Map(),

    async getOrFetch(key, fetcher, ttl) {
        const cached = this.memory.get(key);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.data;
        }

        if (this.inFlight.has(key)) {
            return new Promise((resolve, reject) => {
                this.inFlight.get(key).push({ resolve, reject });
            });
        }

        this.inFlight.set(key, []);
        try {
            const data = await fetcher();
            this.memory.set(key, { data, expiresAt: Date.now() + ttl });
            
            const waiters = this.inFlight.get(key);
            this.inFlight.delete(key);
            waiters.forEach(waiter => waiter.resolve(data));
            
            return data;
        } catch (error) {
            const waiters = this.inFlight.get(key);
            this.inFlight.delete(key);
            waiters.forEach(waiter => waiter.reject(error));
            throw error;
        }
    }
};

setInterval(() => {
    const now = Date.now();
    for (const [key, value] of CacheEngine.memory.entries()) {
        if (now > value.expiresAt) CacheEngine.memory.delete(key);
    }
}, 30000);

// ==========================================
// 2. دوال جلب البيانات (الذكية مع التبديل التلقائي)
// ==========================================
async function fetchChannelServers(realChannelName) {
    const channelId = `live_tv_${realChannelName}`;
    let dataArray = null;

    // 1. المحاولة الأولى (المسار الأول)
    try {
        const response1 = await axios.get(`${CONFIG.API_BASE_URL}/stream`, {
            params: { id_live: channelId },
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 8000
        });
        
        if (response1.data && (!Array.isArray(response1.data) || response1.data.length > 0)) {
            dataArray = Array.isArray(response1.data) ? response1.data : [response1.data];
        }
    } catch (e) {
        console.log(`[API 1 Failed] Switching to fallback for: ${channelId}`);
    }

    // 2. المحاولة الثانية (المسار البديل) في حال فشل الأول أو عاد بفراغ
    if (!dataArray || dataArray.length === 0) {
        try {
            const response2 = await axios.get(`${CONFIG.API_BASE_URL}/live_id/${channelId}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                timeout: 8000
            });
            
            if (response2.data) {
                dataArray = Array.isArray(response2.data) ? response2.data : [response2.data];
            }
        } catch (e) {
            console.log(`[API 2 Failed] Could not fetch: ${channelId}`);
        }
    }

    if (!dataArray || dataArray.length === 0) throw new Error('لا توجد بيانات للقناة من المصدرين');

    const servers = [];
    dataArray.forEach((srv, i) => {
        if (srv.result !== 0 || !srv.data) return;
        try {
            let rawUrl = srv.data.url;
            let innerData = typeof rawUrl === 'string' && rawUrl.trim().startsWith('{') 
                ? JSON.parse(rawUrl.trim()) 
                : { url: rawUrl.trim() };
                
            servers.push({
                name: srv.name || `سيرفر ${i + 1}`,
                url: innerData.url,
                headers: innerData.headers || {},
                swap: innerData.swap || null
            });
        } catch (e) {}
    });

    if (servers.length === 0) throw new Error('لا توجد سيرفرات صالحة');
    return servers;
}

async function fetchManifest(serverInfo) {
    const headers = { 'User-Agent': serverInfo.headers['User-Agent'] || 'Mozilla/5.0' };
    if (serverInfo.headers['Referer']) headers['Referer'] = serverInfo.headers['Referer'];

    const response = await axios.get(serverInfo.url, { headers, timeout: 10000 });
    let m3u8 = response.data;
    
    const baseUrl = serverInfo.url.substring(0, serverInfo.url.lastIndexOf('/') + 1);
    const swapKey = serverInfo.swap ? Object.keys(serverInfo.swap)[0] : null;
    const swapVal = swapKey ? serverInfo.swap[swapKey] : null;

    m3u8 = m3u8.replace(/^(?!#)(.*)$/gm, (line) => {
        let url = line.trim();
        if (!url || url.startsWith('#')) return line;
        if (!url.startsWith('http')) url = baseUrl + url;
        if (swapKey && url.includes(swapKey)) url = url.replace(swapKey, swapVal);
        return url;
    });

    return m3u8;
}

// ==========================================
// 3. المسارات (Routes)
// ==========================================

// مسار مساعد لك لتشفير أسماء القنوات (افتحه في المتصفح للحصول على الكود المشفر)
app.get('/encrypt/:channelName', (req, res) => {
    const encrypted = encodeId(req.params.channelName);
    res.send(`
        <div style="font-family:sans-serif; text-align:center; margin-top:50px;">
            <h2>الاسم الأصلي: ${req.params.channelName}</h2>
            <h1 style="color:green;">الكود المشفر: ${encrypted}</h1>
            <p>الرابط الخاص بك سيكون: <b>/play/${encrypted}</b></p>
        </div>
    `);
});

app.get('/play/:hash', async (req, res) => {
    try {
        const hash = req.params.hash;
        const realChannel = decodeId(hash); // فك التشفير داخلياً
        
        if (!realChannel) return res.status(400).send('Invalid Channel ID');

        const servers = await CacheEngine.getOrFetch(`servers_${realChannel}`, () => fetchChannelServers(realChannel), CONFIG.CACHE_DURATION);
        
        // نرسل الكود المشفر للواجهة لتبقى القناة الحقيقية مخفية
        res.send(generateUI(hash, servers)); 
    } catch (error) {
        res.status(500).send('<h3 style="text-align:center;margin-top:50px;">القناة غير متوفرة حالياً</h3>');
    }
});

app.get('/manifest/:hash/:serverIndex', async (req, res) => {
    try {
        const { hash, serverIndex } = req.params;
        const realChannel = decodeId(hash);
        if (!realChannel) throw new Error('Invalid ID');

        const cacheKey = `manifest_${realChannel}_${serverIndex}`;
        
        const servers = await CacheEngine.getOrFetch(`servers_${realChannel}`, () => fetchChannelServers(realChannel), CONFIG.CACHE_DURATION);
        const serverInfo = servers[parseInt(serverIndex)];
        if (!serverInfo) throw new Error('السيرفر غير موجود');

        const manifestData = await CacheEngine.getOrFetch(cacheKey, () => fetchManifest(serverInfo), CONFIG.MANIFEST_CACHE);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        
        res.send(manifestData);
    } catch (error) {
        res.status(500).send('Manifest Error');
    }
});

// ==========================================
// 4. واجهة المستخدم 
// ==========================================
function generateUI(channelHash, servers) {
    const serverOptions = servers.map((srv, idx) => `<option value="${idx}">${srv.name}</option>`).join('');

    return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Live Stream</title>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <style>
        body { 
            margin: 0; padding: 0; background-color: #000; overflow: hidden; font-family: Arial, sans-serif; color: #fff;
        }
        #top-bar {
            position: absolute; top: 0; left: 0; width: 100%; height: 60px;
            background-color: #0d2741; display: flex; justify-content: space-between; align-items: center;
            padding: 0 15px; box-sizing: border-box; z-index: 10; border-bottom: 2px solid #FFD700;
        }
        .site-title { font-size: 18px; font-weight: bold; color: #FFD700; }
        .server-selector {
            background-color: #000; color: #FFD700; border: 1px solid #FFD700;
            padding: 8px; border-radius: 4px; font-size: 14px; outline: none; cursor: pointer;
        }
        #video-container { position: absolute; top: 60px; bottom: 0; width: 100%; background: #000; }
        video { width: 100%; height: 100%; object-fit: contain; }
    </style>
</head>
<body>
    <div id="top-bar">
        <div class="site-title">YTPlus Player</div>
        <select class="server-selector" id="server-select" onchange="changeServer(this.value)">
            ${serverOptions}
        </select>
    </div>
    <div id="video-container">
        <video id="video" controls playsinline webkit-playsinline autoplay></video>
    </div>

    <script>
        const video = document.getElementById('video');
        let hls = null;

        function changeServer(serverIndex) {
            // نستخدم الكود المشفر لجلب البث
            const manifestUrl = '/manifest/${channelHash}/' + serverIndex;

            if (hls) {
                hls.destroy();
                hls = null;
            }

            if (Hls.isSupported()) {
                hls = new Hls();
                hls.loadSource(manifestUrl);
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, function() {
                    video.play().catch(e => console.log('Autoplay prevented'));
                });
            } 
            else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = manifestUrl;
                video.addEventListener('loadedmetadata', function() {
                    video.play().catch(e => console.log('Autoplay prevented'));
                });
            }
        }
        changeServer(0);
    </script>
</body>
</html>
    `;
}

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
