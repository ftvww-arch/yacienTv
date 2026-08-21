const express = require('express');
const axios = require('axios');
const crypto = require('crypto'); // أضفنا مكتبة التشفير
const app = express();

const PORT = process.env.PORT || 3000;

// ==========================================
// الإعدادات العامة 
// ==========================================
const CONFIG = {
    API_BASE_URL: 'https://s3-1nft.onrender.com/yacintv',
    CACHE_DURATION: 300000, 
    MANIFEST_CACHE: 2000,    
    SECRET_KEY: crypto.randomBytes(32).toString('hex'), // مفتاح سري عشوائي يتغير كل مرة يشتغل فيها السيرفر
    TOKEN_EXPIRY: 6 * 60 * 60 * 1000, // صلاحية الرابط 6 ساعات
    // ضع رابط اللوجو الخاص بك هنا
    LOGO_URL: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/React-icon.svg/120px-React-icon.svg.png' 
};

// ==========================================
// نظام التوكن (حماية الروابط من السرقة)
// ==========================================
function generateSecureToken(ip) {
    const expires = Date.now() + CONFIG.TOKEN_EXPIRY;
    const data = `${ip}:${expires}`;
    const signature = crypto.createHmac('sha256', CONFIG.SECRET_KEY).update(data).digest('hex');
    // إرجاع التوكن بصيغة Base64
    return Buffer.from(`${data}:${signature}`).toString('base64');
}

function verifySecureToken(token, userIp) {
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        const [tokenIp, expires, signature] = decoded.split(':');
        
        // 1. التحقق من الوقت
        if (Date.now() > parseInt(expires)) return false; 
        
        // 2. التحقق من صحة التوقيع
        const expectedSignature = crypto.createHmac('sha256', CONFIG.SECRET_KEY).update(`${tokenIp}:${expires}`).digest('hex');
        if (signature !== expectedSignature) return false;

        // 3. (اختياري) التحقق من الـ IP - إذا أردت ربط البث بشخص واحد فقط
        // ملاحظة: قمنا بتعطيلها مؤقتاً لأن بعض شبكات 4G تغير الـ IP باستمرار، لكن التوقيع والوقت يكفيان للحماية
        // if (tokenIp !== userIp) return false; 

        return true;
    } catch (e) {
        return false;
    }
}

// دالة لمعرفة IP المستخدم الحقيقي (حتى لو كان خلف Cloudflare)
function getClientIp(req) {
    return req.headers['x-forwarded-for'] || req.socket.remoteAddress;
}

// ==========================================
// دوال التشفير وفك التشفير لأسماء القنوات
// ==========================================
function encodeId(text) { return Buffer.from(text).toString('hex'); }
function decodeId(hash) { try { return Buffer.from(hash, 'hex').toString('utf8'); } catch (e) { return null; } }

// ==========================================
// 1. محرك الكاش المتقدم
// ==========================================
const CacheEngine = {
    memory: new Map(),
    inFlight: new Map(),

    async getOrFetch(key, fetcher, ttl) {
        const cached = this.memory.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.data;

        if (this.inFlight.has(key)) {
            return new Promise((resolve, reject) => { this.inFlight.get(key).push({ resolve, reject }); });
        }

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
// 2. دوال جلب البيانات
// ==========================================
async function fetchChannelServers(realChannelName) {
    const channelId = `live_tv_${realChannelName}`;
    let dataArray = null;

    try {
        const response1 = await axios.get(`${CONFIG.API_BASE_URL}/stream`, { params: { id_live: channelId }, headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
        if (response1.data && (!Array.isArray(response1.data) || response1.data.length > 0)) dataArray = Array.isArray(response1.data) ? response1.data : [response1.data];
    } catch (e) { console.log(`API 1 Failed`); }

    if (!dataArray || dataArray.length === 0) {
        try {
            const response2 = await axios.get(`${CONFIG.API_BASE_URL}/live_id/${channelId}`, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
            if (response2.data) dataArray = Array.isArray(response2.data) ? response2.data : [response2.data];
        } catch (e) { console.log(`API 2 Failed`); }
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
// 3. المسارات (Routes)
// ==========================================
app.get('/encrypt/:channelName', (req, res) => {
    res.send(`<h1 style="text-align:center; margin-top:50px; color:green;">${encodeId(req.params.channelName)}</h1>`);
});

app.get('/play/:hash', async (req, res) => {
    try {
        const hash = req.params.hash;
        const realChannel = decodeId(hash);
        if (!realChannel) return res.status(400).send('Invalid Channel ID');

        const servers = await CacheEngine.getOrFetch(`servers_${realChannel}`, () => fetchChannelServers(realChannel), CONFIG.CACHE_DURATION);
        
        // 🌟 هنا نقوم بإنشاء التوكن السري للمستخدم
        const userIp = getClientIp(req);
        const secureToken = generateSecureToken(userIp);
        
        // نرسل التوكن للواجهة
        res.send(generateUI(hash, servers, secureToken)); 
    } catch (error) {
        res.status(500).send('<h3 style="text-align:center;margin-top:50px;">القناة غير متوفرة حالياً</h3>');
    }
});

// 🌟 مسار جلب البث الآن محمي بالتوكن!
app.get('/manifest/:hash/:serverIndex', async (req, res) => {
    try {
        const providedToken = req.query.token;
        const userIp = getClientIp(req);

        // إذا لم يكن هناك توكن، أو التوكن مزيف/منتهي الصلاحية، يتم الطرد!
        if (!providedToken || !verifySecureToken(providedToken, userIp)) {
            return res.status(403).send('Access Denied: Invalid or Expired Token. لا تحاول سرقة البث!');
        }

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
        res.send(manifestData);
    } catch (error) {
        res.status(500).send('Manifest Error');
    }
});

// ==========================================
// 4. واجهة المستخدم (التصميم)
// ==========================================
function generateUI(channelHash, servers, secureToken) {
    const serverOptions = servers.map((srv, idx) => `<option value="${idx}">${srv.name}</option>`).join('');

    return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>YTPlus Live Stream</title>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <style>
        body { margin: 0; padding: 0; background-color: #000; overflow: hidden; font-family: Arial, sans-serif; color: #fff; }
        #top-bar { position: absolute; top: 0; left: 0; width: 100%; height: 60px; background-color: #0d2741; display: flex; justify-content: space-between; align-items: center; padding: 0 15px; box-sizing: border-box; z-index: 10; border-bottom: 2px solid #FFD700; }
        .site-title { font-size: 18px; font-weight: bold; color: #FFD700; }
        .server-selector { background-color: #000; color: #FFD700; border: 1px solid #FFD700; padding: 8px; border-radius: 4px; font-size: 14px; outline: none; cursor: pointer; }
        #video-container { position: absolute; top: 60px; bottom: 0; width: 100%; background: #000; }
        video { width: 100%; height: 100%; object-fit: contain; }
        
        /* 🌟 كود اللوجو العائم فوق المشغل */
        .player-watermark {
            position: absolute;
            top: 20px;
            right: 20px;
            width: 80px; /* حجم اللوجو */
            opacity: 0.8; /* شفافية اللوجو */
            z-index: 5;
            pointer-events: none; /* مهم جداً: يمنع اللوجو من إعاقة النقر على الفيديو */
        }
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
        <!-- 🌟 اللوجو العائم -->
        <img src="${CONFIG.LOGO_URL}" class="player-watermark" alt="Logo">
        
        <video id="video" controls playsinline webkit-playsinline autoplay></video>
    </div>

    <script>
        const video = document.getElementById('video');
        let hls = null;
        // استلام التوكن من السيرفر
        const SECURITY_TOKEN = '${secureToken}'; 

        function changeServer(serverIndex) {
            // إضافة التوكن للرابط كـ Query Parameter
            const manifestUrl = '/manifest/${channelHash}/' + serverIndex + '?token=' + encodeURIComponent(SECURITY_TOKEN);

            if (hls) { hls.destroy(); hls = null; }

            if (Hls.isSupported()) {
                hls = new Hls();
                hls.loadSource(manifestUrl);
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, function() {
                    video.play().catch(e => console.log('Autoplay prevented'));
                });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
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
    console.log(`✅ Secure Server running on port ${PORT}`);
});
