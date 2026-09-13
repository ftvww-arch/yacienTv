const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const compression = require('compression');

const app = express();

// إعدادات أمان واستجابة السيرفر
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// ==========================================
// الإعدادات العامة (Xtream Configs)
// ==========================================
const CONFIG = {
    // بيانات حساب Xtream الخاصة بك
    XTREAM_USER: 'fadi',
    XTREAM_PASS: '2026',
    
    // مصادر البيانات
    API_BASE_URL: 'https://ideal-spirit-production-4eeb.up.railway.app/yacintv',
    TV_CHANNELS_BASE_URL: 'https://raw.githubusercontent.com/sspc11122020-hub/getChanelFraom_dlstreams/refs/heads/main/Bein%20sport%20Ar/',
    
    // الكاش والتشفير
    CACHE_DURATION: 300000, 
    SECRET_KEY: process.env.SECRET_KEY || 'my-super-secret-yacintv-key-2026',
    DEFAULT_USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
};

// مفتاح ثابت لتشفير عناوين قطع الفيديو بـ AES-256 لمنع استخراج IP المصدر الأصلي
const AES_KEY = crypto.scryptSync(CONFIG.SECRET_KEY, 'stream_salt', 32);
const AES_IV = Buffer.alloc(16, 0);

function encryptUrl(text) {
    try {
        const cipher = crypto.createCipheriv('aes-256-cbc', AES_KEY, AES_IV);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return encrypted;
    } catch (e) { return null; }
}

function decryptUrl(encryptedHex) {
    try {
        const decipher = crypto.createDecipheriv('aes-256-cbc', AES_KEY, AES_IV);
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) { return null; }
}

process.on('uncaughtException', (err) => { console.error('Uncaught Exception: ', err); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); });

// استثناء مسار قطع الفيديو من ضغط gZip لمنع تلف الـ Buffer
app.use(compression({
    filter: (req, res) => {
        if (req.path.startsWith('/s/')) return false;
        return compression.filter(req, res);
    }
}));

// ==========================================
// نظام توافق المعرفات (String to Integer Mapping)
// لأن Xtream يتطلب معرفات قنوات بصيغة أرقام (Numbers)
// ==========================================
const idMapping = {
    stringToNum: new Map(),
    numToString: new Map(),
    counter: 1000,
    
    getId(str) {
        if (this.stringToNum.has(str)) return this.stringToNum.get(str);
        const newId = this.counter++;
        this.stringToNum.set(str, newId);
        this.numToString.set(newId, str);
        return newId;
    },
    
    getStr(num) {
        return this.numToString.get(Number(num));
    }
};

// ==========================================
// محرك الكاش الذكي
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
// دوال جلب البيانات الأساسية
// ==========================================
async function fetchChannelServers(realChannelName) {
    if (realChannelName.startsWith('sat_')) {
        const channelId = realChannelName.replace('sat_', '');
        const res = await axios.get(`${CONFIG.TV_CHANNELS_BASE_URL}channel_${channelId}.json`, { timeout: 8000 });
        if (!res.data || !res.data.servers || res.data.servers.length === 0) throw new Error('No data');
        return res.data.servers.map((srv, i) => ({
            name: srv.serverName || `Server ${i + 1}`,
            url: srv.url,
            headers: srv.headers || {},
            swap: null
        }));
    }

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

    if (!dataArray || dataArray.length === 0) throw new Error('No servers');

    const servers = [];
    dataArray.forEach((srv, i) => {
        if (srv.result !== 0 || !srv.data) return;
        try {
            let rawUrl = srv.data.url;
            let innerData = typeof rawUrl === 'string' && rawUrl.trim().startsWith('{') ? JSON.parse(rawUrl.trim()) : { url: rawUrl.trim() };
            servers.push({ name: srv.name || `Server ${i + 1}`, url: innerData.url, headers: innerData.headers || {}, swap: innerData.swap || null });
        } catch (e) {}
    });
    
    if (servers.length === 0) throw new Error('No servers');
    return servers;
}

async function fetchManifest(serverInfo, hostUrl) {
    const parsedTarget = new URL(serverInfo.url);
    const headers = { 
        'User-Agent': serverInfo.headers['user-agent'] || serverInfo.headers['User-Agent'] || CONFIG.DEFAULT_USER_AGENT,
        'Accept': '*/*',
        'Referer': `${parsedTarget.origin}/`,
        'Origin': parsedTarget.origin
    };
    
    if (serverInfo.headers) {
        Object.keys(serverInfo.headers).forEach(key => {
            if (key.toLowerCase() !== 'host') headers[key] = serverInfo.headers[key];
        });
    }

    const response = await axios.get(serverInfo.url, { headers, timeout: 10000 });
    let m3u8 = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    
    const finalUrl = response.request.res.responseUrl || serverInfo.url;
    const parsedFinalUrl = new URL(finalUrl);
    const baseUrl = parsedFinalUrl.origin;
    const finalSearchParams = parsedFinalUrl.search;

    const swapKey = serverInfo.swap ? Object.keys(serverInfo.swap)[0] : null;
    const swapVal = swapKey ? serverInfo.swap[swapKey] : null;

    let lines = m3u8.split('\n');
    let rewrittenLines = lines.map(line => {
        let trimmed = line.trim().replace(/\r/g, '').replace(/\\$/g, '');
        if (!trimmed || trimmed.startsWith('#')) return trimmed;

        let absoluteLink = trimmed.startsWith('http') ? trimmed 
                         : trimmed.startsWith('/') ? baseUrl + trimmed 
                         : new URL(trimmed, finalUrl).href;

        if (swapKey && absoluteLink.includes(swapKey)) absoluteLink = absoluteLink.replace(swapKey, swapVal);
        if (finalSearchParams && !absoluteLink.includes('?')) absoluteLink += finalSearchParams;

        // تشفير الرابط كاملاً بـ AES-256
        const encryptedSegment = encryptUrl(absoluteLink);
        return `${hostUrl}/s/${encryptedSegment}/segment.ts`;
    });

    return rewrittenLines.join('\n');
}

// ==========================================
// مسارات Xtream Codes API
// ==========================================

// ميدل وير التحقق من مستخدم Xtream
function xtreamAuth(req, res, next) {
    const username = req.query.username || req.body.username;
    const password = req.query.password || req.body.password;
    
    if (username === CONFIG.XTREAM_USER && password === CONFIG.XTREAM_PASS) {
        return next();
    }
    return res.status(401).json({ error: "Unauthorized" });
}

// مسار الـ API الرئيسي للمشغلات
app.all('/player_api.php', xtreamAuth, async (req, res) => {
    const action = req.query.action || req.body.action;
    const hostUrl = `http://${req.get('host')}`;

    try {
        // 1. معلومات السيرفر والمستخدم (بدون اكشن)
        if (!action) {
            return res.json({
                user_info: {
                    username: CONFIG.XTREAM_USER,
                    password: CONFIG.XTREAM_PASS,
                    message: "Welcome Fadi",
                    auth: 1,
                    status: "Active",
                    exp_date: null,
                    is_trial: "0",
                    active_cons: 1,
                    created_at: "1600000000",
                    max_connections: 999
                },
                server_info: {
                    url: hostUrl,
                    port: PORT,
                    https_port: "443",
                    server_protocol: "http",
                    rtmp_port: "2546",
                    timezone: "Europe/Istanbul",
                    timestamp_now: Math.floor(Date.now() / 1000),
                    time_now: new Date().toISOString()
                }
            });
        }

        // 2. فئات البث المباشر
        if (action === 'get_live_categories') {
            return res.json([
                { category_id: "1", category_name: "قنوات التلفزيون (Live TV)", parent_id: 0 },
                { category_id: "2", category_name: "المباريات المباشرة (Matches)", parent_id: 0 }
            ]);
        }

        // 3. قنوات البث المباشر والمباريات
        if (action === 'get_live_streams') {
            const streams = [];

            // جلب قنوات التلفزيون
            try {
                const channels = await CacheEngine.getOrFetch('tv_channels_index', async () => {
                    const response = await axios.get(`${CONFIG.TV_CHANNELS_BASE_URL}channels_index.json`, { timeout: 8000 });
                    return response.data;
                }, CONFIG.CACHE_DURATION);

                channels.forEach(ch => {
                    const strId = `sat_${ch.id}`;
                    streams.push({
                        num: streams.length + 1,
                        name: ch.name,
                        stream_type: "live",
                        stream_id: idMapping.getId(strId), // تحويل الاسم لرقم
                        stream_icon: "",
                        epg_channel_id: null,
                        added: "1",
                        category_id: "1",
                        custom_sid: "",
                        tv_archive: 0,
                        direct_source: "",
                        tv_archive_duration: 0
                    });
                });
            } catch (e) { console.error("Error fetching channels for xtream"); }

            // جلب المباريات
            try {
                const matches = await CacheEngine.getOrFetch('matches_list', async () => {
                    const res = await axios.get(`${CONFIG.API_BASE_URL}/mach`, { timeout: 5000 });
                    return res.data;
                }, 60000);

                matches.forEach(match => {
                    let channelStr = match.channel || match.id_live;
                    if (!channelStr) return;
                    
                    let cleanChannel = channelStr.startsWith('live_tv_') ? channelStr.replace('live_tv_', '') : channelStr;
                    let matchTitle = match.title || match.name || match.match_name || cleanChannel;
                    if (!match.title && match.team1 && match.team2) matchTitle = `${match.team1} vs ${match.team2}`;

                    streams.push({
                        num: streams.length + 1,
                        name: matchTitle,
                        stream_type: "live",
                        stream_id: idMapping.getId(cleanChannel), // تحويل الاسم لرقم
                        stream_icon: "",
                        epg_channel_id: null,
                        added: "1",
                        category_id: "2",
                        custom_sid: "",
                        tv_archive: 0,
                        direct_source: "",
                        tv_archive_duration: 0
                    });
                });
            } catch (e) { console.error("Error fetching matches for xtream"); }

            return res.json(streams);
        }

        // 4. الأفلام والمسلسلات (فارغة لمنع المشاكل)
        if (action === 'get_vod_categories' || action === 'get_series_categories' || action === 'get_vod_streams' || action === 'get_series') {
            return res.json([]); 
        }

        // افتراضي
        res.json([]);

    } catch (error) {
        res.status(500).json({ error: "Server Error" });
    }
});


// ==========================================
// مسارات تشغيل الفيديو (Live & Proxy)
// ==========================================

// مسار تشغيل Xtream المباشر (تستخدمه تطبيقات الـ IPTV)
// الصيغة: /live/fadi/2026/1234.m3u8 أو .ts
app.get('/live/:username/:password/:streamId.:ext', async (req, res) => {
    const { username, password, streamId, ext } = req.params;

    // التحقق من اسم المستخدم والباسورد الخاص بـ Xtream
    if (username !== CONFIG.XTREAM_USER || password !== CONFIG.XTREAM_PASS) {
        return res.status(401).send('Unauthorized');
    }

    // استعادة اسم القناة النصي من الرقم
    const realChannel = idMapping.getStr(streamId);
    if (!realChannel) {
        return res.status(404).send('Channel not found');
    }

    try {
        const hostUrl = `http://${req.get('host')}`;
        
        // جلب السيرفرات المتوفرة لهذه القناة
        const servers = await CacheEngine.getOrFetch(`servers_${realChannel}`, () => fetchChannelServers(realChannel), CONFIG.CACHE_DURATION);
        if (!servers || servers.length === 0) return res.status(404).send('No active servers');

        // نختار السيرفر الأول كافتراضي (في Xtream لا يوجد اختيار سيرفرات)
        const serverInfo = servers[0];
        
        // جلب وتجهيز ملف m3u8 مشفر بمساراتنا
        const manifestData = await CacheEngine.getOrFetch(`manifest_${realChannel}_0`, () => fetchManifest(serverInfo, hostUrl), 2000);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(manifestData);

    } catch (error) {
        res.status(500).send('Stream Offline');
    }
});


// مسار التدفّق المباشر الموفر للذاكرة والمشفر (لا تلمسه، هو قلب البروكسي!)
app.get('/s/:encodedUrl/segment.ts', async (req, res) => {
    const targetUrl = decryptUrl(req.params.encodedUrl);
    if (!targetUrl) return res.status(403).send('Access Denied');

    try {
        const parsedUrl = new URL(targetUrl);
        const headers = {
            'User-Agent': CONFIG.DEFAULT_USER_AGENT,
            'Accept': '*/*',
            'Referer': `${parsedUrl.origin}/`,
            'Origin': parsedUrl.origin
        };

        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const response = await axios.get(targetUrl, {
            headers,
            responseType: 'stream',
            timeout: 10000,
            validateStatus: status => status >= 200 && status < 500
        });

        res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp2t');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
        res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=60');

        if (response.headers['content-range']) {
            res.setHeader('Content-Range', response.headers['content-range']);
        }

        res.status(response.status);
        response.data.pipe(res);
    } catch (e) {
        res.status(500).send('Proxy Segment Error');
    }
});

// رسالة بسيطة للتأكد أن السيرفر يعمل
app.get('/', (req, res) => res.send('Fadi Xtream IPTV Server is Running!'));

app.listen(PORT, () => {
    console.log(`🚀 Fadi Xtream IPTV Server running on port ${PORT}`);
});
