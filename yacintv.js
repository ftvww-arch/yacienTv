const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

const PORT = process.env.PORT || 3000;

// ==========================================
// الإعدادات العامة 
// ==========================================
const CONFIG = {
    API_BASE_URL: 'https://s3-1nft.onrender.com/yacintv',
    CACHE_DURATION: 300000, 
    MANIFEST_CACHE: 2000,    
    SECRET_KEY: crypto.randomBytes(32).toString('hex'), 
    TOKEN_EXPIRY: 6 * 60 * 60 * 1000, 
    LOGO_URL: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/React-icon.svg/120px-React-icon.svg.png',
    MAIN_WEBSITE: 'https://www.kirozozo.xyz/' 
};

// ==========================================
// دوال التشفير والحماية
// ==========================================
function generateSecureToken(ip) {
    const expires = Date.now() + CONFIG.TOKEN_EXPIRY;
    const data = `${ip}:${expires}`;
    const signature = crypto.createHmac('sha256', CONFIG.SECRET_KEY).update(data).digest('hex');
    return Buffer.from(`${data}:${signature}`).toString('base64');
}

function verifySecureToken(token) {
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        const [tokenIp, expires, signature] = decoded.split(':');
        if (Date.now() > parseInt(expires)) return false; 
        const expectedSignature = crypto.createHmac('sha256', CONFIG.SECRET_KEY).update(`${tokenIp}:${expires}`).digest('hex');
        return signature === expectedSignature;
    } catch (e) {
        return false;
    }
}

function getClientIp(req) { return req.headers['x-forwarded-for'] || req.socket.remoteAddress; }
function encodeId(text) { return Buffer.from(text).toString('hex'); }
function decodeId(hash) { try { return Buffer.from(hash, 'hex').toString('utf8'); } catch (e) { return null; } }

// ==========================================
// محرك الكاش
// ==========================================
const CacheEngine = {
    memory: new Map(),
    inFlight: new Map(),
    async getOrFetch(key, fetcher, ttl) {
        const cached = this.memory.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.data;
        if (this.inFlight.has(key)) return new Promise((resolve, reject) => { this.inFlight.get(key).push({ resolve, reject }); });
        
        this.inFlight.set(key, []);
        try {
            const data = await fetcher();
            this.memory.set(key, { data, expiresAt: Date.now() + ttl });
            const waiters = this.inFlight.get(key);
            this.inFlight.delete(key);
            waiters.forEach(w => w.resolve(data));
            return data;
        } catch (error) {
            const waiters = this.inFlight.get(key);
            this.inFlight.delete(key);
            waiters.forEach(w => w.reject(error));
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
// فحص حالة القناة (التحقق فقط إذا كان الحقل فارغاً)
// ==========================================
async function validateMatchStatus(realChannelName) {
    try {
        const matches = await CacheEngine.getOrFetch('matches_list', async () => {
            const res = await axios.get(`${CONFIG.API_BASE_URL}/mach`, { timeout: 5000 });
            return res.data;
        }, 60000);

        const channelId = `live_tv_${realChannelName}`;
        const targetMatch = matches.find(m => m.id_live === channelId || m.channel === channelId);

        // إذا لم توجد المباراة أصلاً أو كان حقل القناة فارغاً نوقف التشغيل
        if (!targetMatch) return { isAvailable: false, reason: 'المباراة غير مدرجة في جدول البث' };
        
        const channelField = targetMatch.channel || targetMatch.id_live;
        if (!channelField || channelField.trim() === '') {
            return { isAvailable: false, reason: 'لا توجد قناة بث متاحة لهذه المباراة حالياً' };
        }

        return { isAvailable: true };
    } catch (e) {
        return { isAvailable: true }; // في حال تعطل مصدر المباريات، نسمح بالتشغيل اعتيادياً
    }
}

// ==========================================
// دوال جلب البيانات
// ==========================================
async function fetchChannelServers(realChannelName) {
    const channelId = `live_tv_${realChannelName}`;
    let dataArray = null;

    try {
        const response1 = await axios.get(`${CONFIG.API_BASE_URL}/stream`, { params: { id_live: channelId }, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
        if (response1.data && (!Array.isArray(response1.data) || response1.data.length > 0)) dataArray = Array.isArray(response1.data) ? response1.data : [response1.data];
    } catch (e) {}

    if (!dataArray || dataArray.length === 0) {
        try {
            const response2 = await axios.get(`${CONFIG.API_BASE_URL}/live_id/${channelId}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
            if (response2.data) dataArray = Array.isArray(response2.data) ? response2.data : [response2.data];
        } catch (e) {}
    }

    if (!dataArray || dataArray.length === 0) throw new Error('لا توجد بيانات');

    const servers = [];
    dataArray.forEach((srv, i) => {
        if (srv.result !== 0 || !srv.data) return;
        try {
            let rawUrl = srv.data.url;
            let innerData = typeof rawUrl === 'string' && rawUrl.trim().startsWith('{') ? JSON.parse(rawUrl.trim()) : { url: rawUrl.trim() };
            servers.push({ name: srv.name || `سيرفر ${i + 1}`, url: innerData.url, headers: innerData.headers || {}, swap: innerData.swap || null });
        } catch (e) {}
    });
    if (servers.length === 0) throw new Error('لا توجد سيرفرات');
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
// المسارات (Routes)
// ==========================================

// 🌟 مسار المباريات المخصص لموقعك مع إضافة حقل URl للمشغل
app.get('/api/matches', async (req, res) => {
    try {
        const response = await axios.get(`${CONFIG.API_BASE_URL}/mach`, { timeout: 5000 });
        const matches = response.data;
        const hostUrl = `${req.protocol}://${req.get('host')}`;

        const formattedMatches = matches.map(match => {
            let channelStr = match.channel || match.id_live || '';
            let cleanChannel = channelStr.startsWith('live_tv_') ? channelStr.replace('live_tv_', '') : channelStr;
            
            let embedUrl = '';
            if (cleanChannel) {
                const hash = encodeId(cleanChannel);
                embedUrl = `${hostUrl}/play/${hash}`;
            }

            return {
                ...match,
                URl: embedUrl // رابط المشغل الجاهز للاستخدام في موقعك
            };
        });

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(formattedMatches);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch matches' });
    }
});

app.get('/ping', (req, res) => res.send('Pong! Server is awake.'));
app.get('/encrypt/:channelName', (req, res) => res.send(`<h1 style="text-align:center;">${encodeId(req.params.channelName)}</h1>`));

app.get('/play/:hash', async (req, res) => {
    try {
        const hash = req.params.hash;
        const realChannel = decodeId(hash);
        if (!realChannel) return res.send(generateOfflineUI('معرف القناة غير صالح'));

        const matchStatus = await validateMatchStatus(realChannel);
        if (!matchStatus.isAvailable) {
            return res.send(generateOfflineUI(matchStatus.reason));
        }

        const servers = await CacheEngine.getOrFetch(`servers_${realChannel}`, () => fetchChannelServers(realChannel), CONFIG.CACHE_DURATION);
        const userIp = getClientIp(req);
        const secureToken = generateSecureToken(userIp);
        
        res.send(generateUI(hash, servers, secureToken)); 
    } catch (error) {
        res.send(generateOfflineUI('البث غير متوفر حالياً'));
    }
});

app.get('/manifest/:hash/:serverIndex', async (req, res) => {
    try {
        const referer = req.headers.referer || '';
        if (referer && !referer.includes(req.get('host'))) {
            return res.status(403).send('Access Denied');
        }

        const providedToken = req.query.token;
        if (!providedToken || !verifySecureToken(providedToken)) return res.status(403).send('Invalid Token');

        const { hash, serverIndex } = req.params;
        const realChannel = decodeId(hash);
        const cacheKey = `manifest_${realChannel}_${serverIndex}`;
        const servers = await CacheEngine.getOrFetch(`servers_${realChannel}`, () => fetchChannelServers(realChannel), CONFIG.CACHE_DURATION);
        const serverInfo = servers[parseInt(serverIndex)];
        
        const manifestData = await CacheEngine.getOrFetch(cacheKey, () => fetchManifest(serverInfo), CONFIG.MANIFEST_CACHE);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(manifestData);
    } catch (error) {
        res.status(500).send('Manifest Error');
    }
});

// ==========================================
// واجهات المستخدم (UI)
// ==========================================
function generateUI(channelHash, servers, secureToken) {
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
        body { margin: 0; background: #000; overflow: hidden; font-family: Arial, sans-serif; color: #fff; }
        #top-bar { position: absolute; top: 0; left: 0; width: 100%; height: 60px; background-color: #0d2741; display: flex; justify-content: space-between; align-items: center; padding: 0 15px; box-sizing: border-box; z-index: 10; border-bottom: 2px solid #FFD700; }
        .site-title { font-size: 18px; font-weight: bold; color: #FFD700; }
        .server-selector { background-color: #000; color: #FFD700; border: 1px solid #FFD700; padding: 8px; border-radius: 4px; font-size: 14px; outline: none; cursor: pointer; }
        #video-container { position: absolute; top: 60px; bottom: 0; width: 100%; background: #000; }
        video { width: 100%; height: 100%; object-fit: contain; }
        .player-watermark { position: absolute; top: 20px; right: 20px; width: 80px; opacity: 0.8; z-index: 5; pointer-events: none; }
    </style>
</head>
<body>
    <div id="top-bar">
        <div class="site-title">المشغل الرئيسي</div>
        <select class="server-selector" id="server-select" onchange="changeServer(this.value)">
            ${serverOptions}
        </select>
    </div>
    <div id="video-container">
        <img src="${CONFIG.LOGO_URL}" class="player-watermark" alt="Logo">
        <video id="video" controls playsinline webkit-playsinline autoplay></video>
    </div>
    <script>
        const video = document.getElementById('video');
        let hls = null;
        const SECURITY_TOKEN = '${secureToken}'; 
        function changeServer(serverIndex) {
            const manifestUrl = '/manifest/${channelHash}/' + serverIndex + '?token=' + encodeURIComponent(SECURITY_TOKEN);
            if (hls) { hls.destroy(); hls = null; }
            if (Hls.isSupported()) {
                hls = new Hls(); hls.loadSource(manifestUrl); hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = manifestUrl; video.addEventListener('loadedmetadata', () => video.play().catch(() => {}));
            }
        }
        changeServer(0);
    </script>
</body>
</html>`;
}

function generateOfflineUI(reasonMsg) {
    return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>البث غير متوفر</title>
    <style>
        body { margin: 0; padding: 0; background-color: #0d2741; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: Arial, sans-serif; }
        .container { text-align: center; background: rgba(0,0,0,0.5); padding: 40px; border-radius: 15px; border: 2px solid #FFD700; box-shadow: 0 0 20px rgba(255, 215, 0, 0.2); width: 80%; max-width: 500px; }
        h2 { color: #fff; margin-bottom: 20px; font-size: 24px; }
        .reason { color: #FFD700; font-size: 18px; margin-bottom: 30px; font-weight: bold; }
        .btn { display: inline-block; background: #FFD700; color: #0d2741; padding: 12px 30px; text-decoration: none; font-size: 18px; font-weight: bold; border-radius: 50px; transition: transform 0.2s; }
        .btn:hover { transform: scale(1.05); }
    </style>
</head>
<body>
    <div class="container">
        <h2>عفواً، لا يوجد بث متاح</h2>
        <div class="reason">${reasonMsg}</div>
        <a href="${CONFIG.MAIN_WEBSITE}" target="_blank" class="btn">العودة للموقع الرسمي</a>
    </div>
</body>
</html>`;
}

app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
