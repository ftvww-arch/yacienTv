const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(cors());

// ==========================================
// 1. الإعدادات العامة (Configuration)
// ==========================================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    MAIN_WEBSITE: 'ytvplus.buzz', // نطاق موقعك
    SECRET_KEY: process.env.SECRET_KEY || 'your-256-bit-secret-key-here-123', // مفتاح التشفير (يجب أن يكون 32 حرف)
    CACHE_DURATION: 1000 * 60 * 5, // 5 دقائق
    MANIFEST_CACHE: 1000 * 30, // 30 ثانية
    XTREAM_USERS: { 'test': 'test', 'admin': '12345' } // مستخدمي IPTV (يمكن ربطها بقاعدة بيانات لاحقاً)
};

// ==========================================
// 2. محرك الكاش ودمج الطلبات (Request Coalescing)
// ==========================================
const CacheEngine = {
    cache: new Map(),
    pendingRequests: new Map(), // لمنع تنفيذ نفس الطلب الخارجي عدة مرات في نفس اللحظة

    async getOrFetch(key, fetchFunction, ttl = CONFIG.CACHE_DURATION) {
        const now = Date.now();
        if (this.cache.has(key)) {
            const entry = this.cache.get(key);
            if (now < entry.expires) return entry.data;
            this.cache.delete(key);
        }

        // Request Coalescing: إذا كان هناك طلب قيد التنفيذ لنفس المفتاح، انتظر نتيجته
        if (this.pendingRequests.has(key)) {
            return this.pendingRequests.get(key);
        }

        const requestPromise = fetchFunction().then(data => {
            this.cache.set(key, { data, expires: Date.now() + ttl });
            this.pendingRequests.delete(key);
            return data;
        }).catch(err => {
            this.pendingRequests.delete(key);
            throw err;
        });

        this.pendingRequests.set(key, requestPromise);
        return requestPromise;
    }
};

// ==========================================
// 3. دوال التشفير والحماية
// ==========================================
// تشفير الروابط لقطع الفيديو
function encryptSegmentUrl(url) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(CONFIG.SECRET_KEY), iv);
    let encrypted = cipher.update(url, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

// فك تشفير روابط قطع الفيديو
function decryptSegmentUrl(encryptedData) {
    try {
        const parts = encryptedData.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const encryptedText = Buffer.from(parts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(CONFIG.SECRET_KEY), iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return null;
    }
}

// التحقق من التوكن (خاص بمتصفحات الويب فقط)
function verifySecureToken(token, userIp) {
    if (!token) return false;
    // هنا تضع خوارزمية فك تشفير التوكن والتحقق من صلاحيته والـ IP الخاص به
    // (لتبسيط الكود نفترض أنه صحيح حالياً، قم بدمج دالتك الخاصة هنا)
    return true; 
}

// ==========================================
// 4. دوال معالجة البث (M3U8 Parsing)
// ==========================================
// جلب خوادم القناة (محاكاة)
async function fetchChannelServers(channelId) {
    // استبدل هذا الكود بطلب API الفعلي لجلب السيرفر الأصلي للقناة
    return [
        { id: 1, url: `http://origin-server.com/live/${channelId}/playlist.m3u8` }
    ];
}

// جلب الـ Manifest وتعديل الروابط
async function fetchManifest(serverUrl, hostUrl) {
    const response = await axios.get(serverUrl, { timeout: 5000 });
    const lines = response.data.split('\n');
    const modifiedLines = lines.map(line => {
        if (line.trim() && !line.startsWith('#')) {
            // تشفير رابط الـ TS وتوجيهه إلى السيرفر الخاص بنا
            const encryptedUrl = encryptSegmentUrl(line.trim());
            return `${hostUrl}/s/${encryptedUrl}`;
        }
        return line;
    });
    return modifiedLines.join('\n');
}

// ==========================================
// 5. مسارات السيرفر (Routes)
// ==========================================

// قائمة الحظر (تُطبق فقط على مسار الويب لمنع سحب الروابط)
const blockedAgents = ['vlc', 'mpv', 'potplayer', 'iptv', 'smartiptv', 'libvlc', 'python', 'axios', 'curl', 'postman', 'java', 'okhttp', 'wget', 'exoplayer', 'bot', 'crawler', 'spider'];

// مسار 1: مخصص للموقع الرسمي (Web Player) - حماية صارمة
app.get('/manifest/:hash/:serverIndex', async (req, res) => {
    const userAgent = (req.headers['user-agent'] || '').toLowerCase();
    const referer = req.headers.referer || '';
    const host = req.get('host');

    // 1. فحص User-Agent
    if (blockedAgents.some(agent => userAgent.includes(agent))) {
        return res.status(403).send('Access Denied: Invalid Agent');
    }

    // 2. فحص Referer
    if (!referer.includes(host) && !referer.includes(CONFIG.MAIN_WEBSITE)) {
        return res.status(403).send('Access Denied: Invalid Referer');
    }

    // 3. فحص التوكن
    const token = req.query.token;
    const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!verifySecureToken(token, userIp)) {
        return res.status(403).send('Access Denied: Invalid Token');
    }

    try {
        const { hash, serverIndex } = req.params;
        const channelId = hash; // أو قم بفك تشفير الهاش إذا كان مشفراً
        
        const servers = await CacheEngine.getOrFetch(`servers_${channelId}`, () => fetchChannelServers(channelId));
        const serverInfo = servers[serverIndex] || servers[0];
        
        const hostUrl = `https://${host}`;
        const cacheKey = `web_manifest_${channelId}_${serverIndex}`;
        
        const manifestData = await CacheEngine.getOrFetch(cacheKey, () => fetchManifest(serverInfo.url, hostUrl), CONFIG.MANIFEST_CACHE);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(manifestData);

    } catch (error) {
        console.error('Web Route Error:', error.message);
        res.status(500).send('Stream Unavailable');
    }
});


// مسار 2: مخصص لتطبيقات الـ IPTV ومشغلات الأندرويد (Xtream Provider) - بدون حظر
app.get('/live/:username/:password/:channelId.m3u8', async (req, res) => {
    try {
        const { username, password, channelId } = req.params;
        
        // مصادقة اسم المستخدم وكلمة المرور
        if (!CONFIG.XTREAM_USERS[username] || CONFIG.XTREAM_USERS[username] !== password) {
            return res.status(401).send('Unauthorized');
        }

        const servers = await CacheEngine.getOrFetch(`servers_${channelId}`, () => fetchChannelServers(channelId));
        const serverInfo = servers[0]; // نستخدم السيرفر الأول افتراضياً لتطبيقات IPTV
        
        const hostUrl = `https://${req.get('host')}`;
        const cacheKey = `xtream_manifest_${channelId}`;

        // نقوم بجلب ومعالجة البث (تحويل قطع TS إلى /s/ المشفّر)
        const manifestData = await CacheEngine.getOrFetch(cacheKey, () => fetchManifest(serverInfo.url, hostUrl), CONFIG.MANIFEST_CACHE);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*'); // هام جداً للمشغلات الخارجية
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(manifestData);

    } catch (error) {
        console.error('Xtream Route Error:', error.message);
        res.status(500).send('Stream Unavailable');
    }
});


// مسار 3: بروكسي قطع الفيديو المشفرة (Segments Route)
app.get('/s/:data', async (req, res) => {
    const encryptedData = req.params.data;
    const targetUrl = decryptSegmentUrl(encryptedData);

    if (!targetUrl) {
        return res.status(400).send('Invalid Segment Segment Data');
    }

    try {
        // نستخدم responseType: 'stream' لتمرير الفيديو كتدفق (Buffer) بدلاً من تحميله بالكامل في الذاكرة
        const response = await axios({
            method: 'get',
            url: targetUrl,
            responseType: 'stream',
            timeout: 8000,
            headers: {
                // ترويسات مزيفة لتخطي حماية السيرفر الأصلي إن وجدت
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Accept': '*/*'
            }
        });

        // تمرير ترويسات المشغل (ExoPlayer يتطلب CORS أحياناً)
        res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp2t');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        // تدفق البيانات مباشرة للعميل
        response.data.pipe(res);

    } catch (error) {
        // صمت الأخطاء حتى لا يتوقف السيرفر عند فشل تحميل قطعة واحدة
        res.status(404).end();
    }
});

// ==========================================
// تشغيل السيرفر
// ==========================================
app.listen(CONFIG.PORT, () => {
    console.log(`🚀 Streaming Proxy is running on port ${CONFIG.PORT}`);
});
