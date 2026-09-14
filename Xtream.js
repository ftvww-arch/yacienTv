const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const compression = require('compression');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// ==========================================
// الإعدادات العامة والتشفير (مستخرجة من نظامك)
// ==========================================
const CONFIG = {
    API_BASE_URL: 'https://ideal-spirit-production-4eeb.up.railway.app/yacintv',
    TV_CHANNELS_BASE_URL: 'https://raw.githubusercontent.com/sspc11122020-hub/getChanelFraom_dlstreams/refs/heads/main/Bein%20sport%20Ar/',
    CACHE_DURATION: 300000, 
    MANIFEST_CACHE: 2000,    
    SECRET_KEY: process.env.SECRET_KEY || 'my-super-secret-yacintv-key-2026', 
    DEFAULT_USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

const AES_KEY = crypto.scryptSync(CONFIG.SECRET_KEY, 'stream_salt', 32);
const AES_IV = Buffer.alloc(16, 0);

function encryptUrl(text) {
    try {
        const cipher = crypto.createCipheriv('aes-256-cbc', AES_KEY, AES_IV);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return encrypted;
    } catch (e) {
        return null;
    }
}

function decryptUrl(encryptedHex) {
    try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', AES_KEY, AES_IV);
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return null;
    }
}

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
// جلب معلومات البث
// ==========================================
async function fetchChannelServers(realChannelName) {
    const channelId = `live_tv_${realChannelName}`;
    let dataArray = null;

    try {
        const response1 = await axios.get(`${CONFIG.API_BASE_URL}/stream`, { params: { id_live: channelId }, headers: { 'User-Agent': CONFIG.DEFAULT_USER_AGENT }, timeout: 8000 });
        if (response1.data && (!Array.isArray(response1.data) || response1.data.length > 0)) dataArray = Array.isArray(response1.data) ? response1.data : [response1.data];
    } catch (e) {}

    if (!dataArray || dataArray.length === 0) {
        try {
            const response2 = await axios.get(`${CONFIG.API_BASE_URL}/live_id/${channelId}`, { headers: { 'User-Agent': CONFIG.DEFAULT_USER_AGENT }, timeout: 8000 });
            if (response2.data) dataArray = Array.isArray(response2.data) ? response2.data : [response2.data];
        } catch (e) {}
    }

    if (!dataArray || dataArray.length === 0) throw new Error('No stream data found');

    const servers = [];
    dataArray.forEach((srv, i) => {
        if (srv.result !== 0 || !srv.data) return;
        try {
            let rawUrl = typeof srv.data.url === 'string' ? srv.data.url.trim() : '';
            let innerData = rawUrl.startsWith('{') ? JSON.parse(rawUrl) : { url: rawUrl };
            servers.push({ 
                url: innerData.url, 
                headers: innerData.headers || {} 
            });
        } catch (e) {}
    });
    if (servers.length === 0) throw new Error('No working servers found');
    return servers;
}

async function fetchManifest(serverInfo, hostUrl) {
    const parsedTarget = new URL(serverInfo.url);
    const headers = { 
        'User-Agent': serverInfo.headers['User-Agent'] || CONFIG.DEFAULT_USER_AGENT,
        'Accept': '*/*',
        'Referer': `${parsedTarget.origin}/`,
        'Origin': parsedTarget.origin
    };
    
    const response = await axios.get(serverInfo.url, { headers, timeout: 10000 });
    let m3u8 = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    
    const finalUrl = response.request.res.responseUrl || serverInfo.url;
    const parsedFinalUrl = new URL(finalUrl);
    const baseUrl = parsedFinalUrl.origin;
    const finalSearchParams = parsedFinalUrl.search;

    let lines = m3u8.split('\n');
    let rewrittenLines = lines.map(line => {
        let trimmed = line.trim().replace(/\r/g, '').replace(/\\$/g, '');
        if (!trimmed || trimmed.startsWith('#')) return trimmed;

        let absoluteLink = trimmed.startsWith('http') ? trimmed 
                         : trimmed.startsWith('/') ? baseUrl + trimmed 
                         : new URL(trimmed, finalUrl).href;

        if (finalSearchParams && !absoluteLink.includes('?')) absoluteLink += finalSearchParams;

        const payload = JSON.stringify({ url: absoluteLink, headers });
        const encryptedSegment = encryptUrl(payload);
        return `${hostUrl}/s/${encryptedSegment}/segment.ts`;
    });

    return rewrittenLines.join('\n');
}


// ==========================================
// مسارات Xtream Codes API
// ==========================================

// مسار الـ Xtream الرئيسي لطلبات التطبيقات
app.get('/player_api.php', async (req, res) => {
    const { username, password, action } = req.query;

    // التحقق من اسم المستخدم وكلمة المرور (2026/2026)
    if (username !== '2026' || password !== '2026') {
        return res.json({ user_info: { auth: 0, status: "Incorrect details" } });
    }

    // 1. تسجيل الدخول (عرض معلومات الحساب)
    if (!action) {
        return res.json({
            user_info: {
                username: "2026",
                password: "2026",
                message: "Welcome to Matches Server",
                auth: 1,
                status: "Active",
                exp_date: "1999999999", // تاريخ انتهاء بعيد جداً
                is_trial: "0",
                active_cons: "0",
                created_at: "1600000000",
                max_connections: "100",
                allowed_output_formats: ["m3u8", "ts"]
            },
            server_info: {
                url: req.hostname,
                port: PORT,
                https: req.secure ? "443" : "80",
                server_protocol: req.secure ? "https" : "http",
                timestamp_now: Math.floor(Date.now() / 1000)
            }
        });
    }

    // 2. تصنيفات البث المباشر
    if (action === 'get_live_categories') {
        return res.json([
            { category_id: "1", category_name: "مباريات اليوم (Live Matches)", parent_id: 0 }
        ]);
    }

    // 3. قنوات البث المباشر (توليد المباريات كقنوات)
    if (action === 'get_live_streams') {
        try {
            const matches = await CacheEngine.getOrFetch('matches_list', async () => {
                const response = await axios.get(`${CONFIG.API_BASE_URL}/mach`, { timeout: 5000 });
                return response.data;
            }, 60000);

            const streams = matches.map((match, index) => {
                let channelStr = match.channel || match.id_live || '';
                let cleanChannel = channelStr.startsWith('live_tv_') ? channelStr.replace('live_tv_', '') : channelStr;

                let matchTitle = match.title || match.name || match.match_name;
                if (!matchTitle && match.team1 && match.team2) matchTitle = `${match.team1} vs ${match.team2}`;

                return {
                    num: index + 1,
                    name: matchTitle || `Match ${index + 1}`,
                    stream_type: "live",
                    stream_id: cleanChannel, // هذا الـ ID الذي سيتم استدعاؤه لاحقاً للتشغيل
                    stream_icon: match.logo || match.image || "",
                    category_id: "1",
                    added: Math.floor(Date.now() / 1000).toString(),
                    custom_sid: "",
                    tv_archive: 0,
                    direct_source: ""
                };
            });
            return res.json(streams);
        } catch (error) {
            return res.json([]);
        }
    }

    // 4. جعل الأفلام والمسلسلات فارغة (كما طلبت 0/0)
    if (action === 'get_vod_categories' || action === 'get_series_categories' || action === 'get_vod_streams' || action === 'get_series') {
        return res.json([]); 
    }

    return res.json([]);
});

// مسار تشغيل قنوات الـ Xtream
app.get('/live/:username/:password/:streamId.:ext', async (req, res) => {
    const { username, password, streamId } = req.params;

    if (username !== '2026' || password !== '2026') {
        return res.status(401).send('Unauthorized');
    }

    try {
        const servers = await CacheEngine.getOrFetch(`servers_${streamId}`, () => fetchChannelServers(streamId), CONFIG.CACHE_DURATION);
        const serverInfo = servers[0]; // اختيار السيرفر الأول
        
        const hostUrl = `${req.secure ? 'https' : 'http'}://${req.get('host')}`;
        
        const manifestData = await CacheEngine.getOrFetch(`manifest_${streamId}`, () => fetchManifest(serverInfo, hostUrl), CONFIG.MANIFEST_CACHE);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(manifestData);
    } catch (error) {
        res.status(404).send('#EXTM3U\n#EXTINF:-1,Stream Offline or Not Started\n');
    }
});


// ==========================================
// البروكسي الخاص بنقل حزم الفيديو (.ts)
// ==========================================
app.get('/s/:encodedUrl/segment.ts', async (req, res) => {
    const decrypted = decryptUrl(req.params.encodedUrl);
    if (!decrypted) return res.status(403).send('Access Denied');

    let targetUrl = '';
    let customHeaders = {};

    try {
        const parsed = JSON.parse(decrypted);
        targetUrl = parsed.url;
        customHeaders = parsed.headers || {};
    } catch (e) {
        targetUrl = decrypted;
    }

    try {
        const parsedUrl = new URL(targetUrl);
        const headers = {
            'User-Agent': customHeaders['User-Agent'] || CONFIG.DEFAULT_USER_AGENT,
            'Accept': '*/*',
            'Referer': customHeaders['Referer'] || `${parsedUrl.origin}/`,
            'Origin': customHeaders['Origin'] || parsedUrl.origin,
            ...customHeaders
        };

        const response = await axios.get(targetUrl, {
            headers,
            responseType: 'stream',
            timeout: 10000,
            validateStatus: status => status >= 200 && status < 500
        });

        res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp2t');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.status(response.status);
        response.data.pipe(res);
    } catch (e) {
        res.status(500).send('Proxy Segment Error');
    }
});

app.get('/ping', (req, res) => res.send('Xtream Server is Running.'));

app.listen(PORT, () => {
    console.log(`🚀 Xtream IPTV Server running on port ${PORT}`);
});
