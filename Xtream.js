const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const compression = require('compression');

const app = express();

// إعدادات البارسار لدعم طلبات Xtream عبر GET و POST
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// إعدادات أمان واستجابة السيرفر
app.disable('x-powered-by');
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// ==========================================
// الإعدادات العامة والتشفير وسيرفر Xtream
// ==========================================
const CONFIG = {
    API_BASE_URL: 'https://ideal-spirit-production-4eeb.up.railway.app/yacintv',
    TV_CHANNELS_BASE_URL: 'https://raw.githubusercontent.com/sspc11122020-hub/getChanelFraom_dlstreams/refs/heads/main/Bein%20sport%20Ar/',
    CACHE_DURATION: 300000, 
    MANIFEST_CACHE: 2000,    
    SECRET_KEY: process.env.SECRET_KEY || 'my-super-secret-yacintv-key-2026', 
    TOKEN_EXPIRY: 10 * 60 * 1000,
    MAIN_WEBSITE: 'https://www.ytvplus.buzz/',
    DEFAULT_USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    
    // بيانات تسجيل الدخول الخاصة بـ Xtream Codes API
    XTREAM_USER: 'fadi',
    XTREAM_PASS: '2026'
};

// مفتاح تشفير AES-256 لروابط قطع الفيديو
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

process.on('uncaughtException', (err) => { console.error('Uncaught Exception: ', err); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); });

// ==========================================
// الميدل وير (الحماية والضغط)
// ==========================================
app.use(compression({
    filter: (req, res) => {
        if (req.path.startsWith('/s/')) return false;
        return compression.filter(req, res);
    }
}));

const requestCounts = new Map();
app.use((req, res, next) => {
    const ip = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.ip;
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxRequests = 300; // زيادة الحد ليتناسب مع طلبات تطبيقات الـ IPTV

    if (!requestCounts.has(ip)) {
        requestCounts.set(ip, { count: 1, startTime: now });
    } else {
        let data = requestCounts.get(ip);
        if (now - data.startTime > windowMs) {
            data.count = 1;
            data.startTime = now;
        } else {
            data.count++;
            if (data.count > maxRequests) {
                return res.status(429).send('Too Many Requests');
            }
        }
    }
    next();
});

setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of requestCounts.entries()) {
        if (now - data.startTime > 120000) requestCounts.delete(ip);
    }
}, 60000);

// ==========================================
// دوال التشفير والتوكن
// ==========================================
function generateSecureToken(ip) {
    const expires = Date.now() + CONFIG.TOKEN_EXPIRY;
    const data = `${ip}:${expires}`;
    const signature = crypto.createHmac('sha256', CONFIG.SECRET_KEY).update(data).digest('hex');
    return Buffer.from(`${data}:${signature}`).toString('base64');
}

function verifySecureToken(token, ip) {
    try {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        const [tokenIp, expires, signature] = decoded.split(':');
        if (Date.now() > parseInt(expires)) return false; 
        const expectedSignature = crypto.createHmac('sha256', CONFIG.SECRET_KEY).update(`${tokenIp}:${expires}`).digest('hex');
        return signature === expectedSignature && tokenIp === ip;
    } catch (e) {
        return false;
    }
}

function getClientIp(req) { 
    return req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.ip; 
}

function encodeId(text) { return Buffer.from(text).toString('hex'); }
function decodeId(hash) { try { return Buffer.from(hash, 'hex').toString('utf8'); } catch (e) { return null; } }

// ==========================================
// محرك الكاش (Cache Engine)
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
            if (this.memory.size > 500) {
                const firstKey = this.memory.keys().next().value;
                this.memory.delete(firstKey);
            }
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
// جلب المانيفست والسيرفرات
// ==========================================
async function getMatchInfo(realChannelName) {
    if (realChannelName.startsWith('sat_')) {
        const channelId = realChannelName.replace('sat_', '');
        try {
            const channelData = await CacheEngine.getOrFetch(`sat_channel_info_${channelId}`, async () => {
                const res = await axios.get(`${CONFIG.TV_CHANNELS_BASE_URL}channel_${channelId}.json`, { timeout: 5000 });
                return res.data;
            }, CONFIG.CACHE_DURATION);
            return { isAvailable: true, title: channelData.name || `Channel ${channelId}` };
        } catch (e) {
            return { isAvailable: true, title: `beIN Sports ${channelId}` };
        }
    }

    try {
        const matches = await CacheEngine.getOrFetch('matches_list', async () => {
            const res = await axios.get(`${CONFIG.API_BASE_URL}/mach`, { timeout: 5000 });
            return res.data;
        }, 60000);

        const channelId = `live_tv_${realChannelName}`;
        const targetMatch = matches.find(m => m.id_live === channelId || m.channel === channelId);

        if (!targetMatch) return { isAvailable: false, reason: 'المباراة غير مدرجة في جدول البث', title: realChannelName };
        
        const channelField = targetMatch.channel || targetMatch.id_live;
        if (!channelField || channelField.trim() === '') {
            return { isAvailable: false, reason: 'لا توجد قناة بث متاحة لهذه المباراة حالياً', title: realChannelName };
        }

        let matchTitle = targetMatch.title || targetMatch.name || targetMatch.match_name || realChannelName;
        if (!targetMatch.title && targetMatch.team1 && targetMatch.team2) {
            matchTitle = `${targetMatch.team1} vs ${targetMatch.team2}`;
        }

        return { isAvailable: true, title: matchTitle };
    } catch (e) {
        return { isAvailable: true, title: realChannelName }; 
    }
}

async function fetchChannelServers(realChannelName) {
    if (realChannelName.startsWith('sat_')) {
        const channelId = realChannelName.replace('sat_', '');
        const res = await axios.get(`${CONFIG.TV_CHANNELS_BASE_URL}channel_${channelId}.json`, { timeout: 8000 });
        if (!res.data || !res.data.servers || res.data.servers.length === 0) throw new Error('لا توجد بيانات بالقناة');
        
        return res.data.servers.map((srv, i) => ({
            name: srv.serverName || `سيرفر ${i + 1}`,
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
            if (key.toLowerCase() !== 'host') {
                headers[key] = serverInfo.headers[key];
            }
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

        if (swapKey && absoluteLink.includes(swapKey)) {
            absoluteLink = absoluteLink.replace(swapKey, swapVal);
        }

        if (finalSearchParams && !absoluteLink.includes('?')) {
            absoluteLink += finalSearchParams;
        }

        const encryptedSegment = encryptUrl(absoluteLink);
        return `${hostUrl}/s/${encryptedSegment}/segment.ts`;
    });

    return rewrittenLines.join('\n');
}

// ==========================================
// 🚀 Xtream Codes API (واجهة مشغلات الـ IPTV)
// ==========================================

// 1. مسار تسجيل الدخول وجلب قوائم القنوات والمباريات
app.all('/player_api.php', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    const username = req.query.username || req.body.username;
    const password = req.query.password || req.body.password;
    const action = req.query.action || req.body.action;

    // التحقق من بيانات الدخول
    if (username !== CONFIG.XTREAM_USER || password !== CONFIG.XTREAM_PASS) {
        return res.status(200).json({
            user_info: { auth: 0, status: "Disabled", message: "بيانات الدخول غير صحيحة" }
        });
    }

    const host = req.get('host');
    const protocol = req.protocol;
    const nowUnix = Math.floor(Date.now() / 1000);

    // إذا لم يتوفر Action: إرجاع معلومات الحساب والسيرفر
    if (!action) {
        return res.json({
            user_info: {
                username: CONFIG.XTREAM_USER,
                password: CONFIG.XTREAM_PASS,
                message: "مرحباً بك في سيرفر البث المباشر",
                auth: 1,
                status: "Active",
                exp_date: "1798761600", // تاريخ انتهاء غير محدود (2027+)
                is_trial: "0",
                active_cons: "0",
                created_at: "1600000000",
                max_connections: "100",
                allowed_output_formats: ["m3u8", "ts"]
            },
            server_info: {
                url: host.split(':')[0],
                port: host.split(':')[1] || (protocol === 'https' ? "443" : "80"),
                https_port: "443",
                server_protocol: protocol,
                rtmp_server_port: "8888",
                timezone: "Asia/Riyadh",
                timestamp_now: nowUnix,
                time_now: new Date().toISOString().replace('T', ' ').substring(0, 19)
            }
        });
    }

    // جلب تصنيفات القنوات (Categories)
    if (action === 'get_live_categories') {
        return res.json([
            { category_id: "1", category_name: "⚽ المباريات المباشرة", parent_id: 0 },
            { category_id: "2", category_name: "📺 قنوات beIN Sports", parent_id: 0 }
        ]);
    }

    // جلب قائمة البث المباشر (Matches & Channels)
    if (action === 'get_live_streams') {
        const categoryId = req.query.category_id || req.body.category_id;
        let streams = [];
        let streamIndex = 1;

        try {
            // 1. تصنيف المباريات المباشرة
            if (!categoryId || categoryId === "1") {
                const matches = await CacheEngine.getOrFetch('matches_list', async () => {
                    const r = await axios.get(`${CONFIG.API_BASE_URL}/mach`, { timeout: 5000 });
                    return r.data;
                }, 60000);

                matches.forEach((m) => {
                    let channelStr = m.channel || m.id_live || '';
                    let cleanChannel = channelStr.startsWith('live_tv_') ? channelStr.replace('live_tv_', '') : channelStr;
                    if (!cleanChannel) return;

                    let title = m.title || m.name || (m.team1 && m.team2 ? `${m.team1} vs ${m.team2}` : 'مباراة مباشرة');
                    let streamIdHash = encodeId(cleanChannel);

                    streams.push({
                        num: streamIndex++,
                        name: `[مباراة] ${title}`,
                        stream_type: "live",
                        stream_id: streamIdHash,
                        stream_icon: m.img || m.logo || "",
                        epg_channel_id: "",
                        added: `${nowUnix}`,
                        category_id: "1",
                        custom_sid: "",
                        tv_archive: 0,
                        direct_source: "",
                        tv_archive_duration: 0
                    });
                });
            }

            // 2. تصنيف قنوات beIN Sports
            if (!categoryId || categoryId === "2") {
                const channels = await CacheEngine.getOrFetch('tv_channels_index', async () => {
                    const r = await axios.get(`${CONFIG.TV_CHANNELS_BASE_URL}channels_index.json`, { timeout: 8000 });
                    return r.data;
                }, 60000);

                channels.forEach((ch) => {
                    let streamIdHash = encodeId(`sat_${ch.id}`);
                    streams.push({
                        num: streamIndex++,
                        name: ch.name || `beIN Sports ${ch.id}`,
                        stream_type: "live",
                        stream_id: streamIdHash,
                        stream_icon: ch.logo || "",
                        epg_channel_id: "",
                        added: `${nowUnix}`,
                        category_id: "2",
                        custom_sid: "",
                        tv_archive: 0,
                        direct_source: "",
                        tv_archive_duration: 0
                    });
                });
            }

            return res.json(streams);
        } catch (e) {
            return res.status(500).json({ error: "فشل في جلب القنوات" });
        }
    }

    if (action === 'get_vod_categories' || action === 'get_series_categories') {
        return res.json([]);
    }

    return res.json([]);
});

// 2. مسار تشغيل البث المباشر المباشر لتطبيقات Xtream Codes
// يدعم صيغ: /live/fadi/2026/STREAM_ID أو /live/fadi/2026/STREAM_ID.m3u8 أو .ts
app.get(['/live/:username/:password/:streamId', '/live/:username/:password/:streamId.:ext'], async (req, res) => {
    const { username, password, streamId } = req.params;

    // التحقق من الحساب
    if (username !== CONFIG.XTREAM_USER || password !== CONFIG.XTREAM_PASS) {
        return res.status(403).send('Access Denied: Invalid Credentials');
    }

    // تنظيف معرف الـ Stream من امتدادات (.m3u8 أو .ts)
    const cleanHash = streamId.replace(/\.(m3u8|ts|mp4)$/i, '');
    const realChannel = decodeId(cleanHash);

    if (!realChannel) return res.status(404).send('Channel Not Found');

    try {
        const servers = await CacheEngine.getOrFetch(`servers_${realChannel}`, () => fetchChannelServers(realChannel), CONFIG.CACHE_DURATION);
        const serverInfo = servers[0]; // اختيار السيرفر الأساسي للبث
        const hostUrl = `${req.protocol}://${req.get('host')}`;

        const cacheKey = `xtream_manifest_${realChannel}_0`;
        const manifestData = await CacheEngine.getOrFetch(cacheKey, () => fetchManifest(serverInfo, hostUrl), CONFIG.MANIFEST_CACHE);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(manifestData);
    } catch (error) {
        console.error("Xtream Stream Error:", error.message);
        res.status(500).send('Stream Error');
    }
});

// ==========================================
// المسارات العامة والبروكاسي (Proxy Engine)
// ==========================================

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

// رابط مباشر M3U8 لأي مشغل خارجي عادي (مثل VLC)
app.get('/direct/:hash', async (req, res) => {
    try {
        res.setHeader('Access-Control-Allow-Origin', '*');
        const { hash } = req.params;
        const realChannel = decodeId(hash);
        if (!realChannel) return res.status(400).send('معرف القناة غير صالح');

        const servers = await CacheEngine.getOrFetch(`servers_${realChannel}`, () => fetchChannelServers(realChannel), CONFIG.CACHE_DURATION);
        let serverIndex = parseInt(req.query.server) || 0;
        if (serverIndex >= servers.length || serverIndex < 0) serverIndex = 0;

        const serverInfo = servers[serverIndex];
        const hostUrl = `${req.protocol}://${req.get('host')}`;
        const cacheKey = `direct_manifest_${realChannel}_${serverIndex}`;

        const manifestData = await CacheEngine.getOrFetch(cacheKey, () => fetchManifest(serverInfo, hostUrl), CONFIG.MANIFEST_CACHE);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Content-Disposition', `inline; filename="${realChannel}.m3u8"`);
        res.send(manifestData);
    } catch (error) {
        res.status(500).send('خطأ في استخراج رابط البث');
    }
});

app.get('/api/matches', async (req, res) => {
    try {
        const response = await axios.get(`${CONFIG.API_BASE_URL}/mach`, { timeout: 5000 });
        const matches = response.data;
        const hostUrl = `${req.protocol}://${req.get('host')}`;

        const formattedMatches = matches.map(match => {
            let channelStr = match.channel || match.id_live || '';
            let cleanChannel = channelStr.startsWith('live_tv_') ? channelStr.replace('live_tv_', '') : channelStr;
            let embedUrl = cleanChannel ? `${hostUrl}/play/${encodeId(cleanChannel)}` : '';
            
            const { id_live, channel, ...safeMatch } = match;
            return { ...safeMatch, URl: embedUrl };
        });

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(formattedMatches);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch matches' });
    }
});

app.get('/api/channels', async (req, res) => {
    try {
        const channels = await CacheEngine.getOrFetch('tv_channels_index', async () => {
            const response = await axios.get(`${CONFIG.TV_CHANNELS_BASE_URL}channels_index.json`, { timeout: 8000 });
            return response.data;
        }, 60000);

        const hostUrl = `${req.protocol}://${req.get('host')}`;
        const formattedChannels = channels.map(ch => ({
            id: ch.id,
            name: ch.name,
            URl: `${hostUrl}/play/${encodeId(`sat_${ch.id}`)}`
        }));

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(formattedChannels);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch TV channels' });
    }
});

app.get('/ping', (req, res) => res.send('Pong! Server is awake.'));

app.get('/api/refresh-token', (req, res) => {
    const userIp = getClientIp(req);
    const newToken = generateSecureToken(userIp);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({ token: newToken });
});

app.get('/play/:hash', async (req, res) => {
    try {
        const hash = req.params.hash;
        const realChannel = decodeId(hash);
        if (!realChannel) return res.send(generateOfflineUI('معرف القناة غير صالح'));

        const matchInfo = await getMatchInfo(realChannel);
        if (!matchInfo.isAvailable) return res.send(generateOfflineUI(matchInfo.reason));

        const servers = await CacheEngine.getOrFetch(`servers_${realChannel}`, () => fetchChannelServers(realChannel), CONFIG.CACHE_DURATION);
        const userIp = getClientIp(req);
        const secureToken = generateSecureToken(userIp);
        const hostUrl = `${req.protocol}://${req.get('host')}`;
        
        res.send(generateUI(hash, servers, secureToken, matchInfo.title, hostUrl)); 
    } catch (error) {
        res.send(generateOfflineUI('البث غير متوفر حالياً'));
    }
});

app.get('/manifest/:hash/:serverIndex', async (req, res) => {
    try {
        const token = req.query.token;
        const userIp = getClientIp(req);
        if (!token || !verifySecureToken(token, userIp)) return res.status(403).send('Invalid or Expired Token');

        const { hash, serverIndex } = req.params;
        const realChannel = decodeId(hash);
        const cacheKey = `manifest_${realChannel}_${serverIndex}`;
        const servers = await CacheEngine.getOrFetch(`servers_${realChannel}`, () => fetchChannelServers(realChannel), CONFIG.CACHE_DURATION);
        const serverInfo = servers[parseInt(serverIndex)];
        
        const hostUrl = `${req.protocol}://${req.get('host')}`;
        const manifestData = await CacheEngine.getOrFetch(cacheKey, () => fetchManifest(serverInfo, hostUrl), CONFIG.MANIFEST_CACHE);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(manifestData);
    } catch (error) {
        res.status(500).send('Manifest Error');
    }
});

// ==========================================
// الواجهة الديناميكية للمشغل المدمج
// ==========================================
function generateUI(channelHash, servers, secureToken, matchTitle, hostUrl) {
    const totalServers = servers.length;
    const embedUrl = `${hostUrl}/play/${channelHash}`;

    const serverItemsHtml = servers.map((srv, idx) => `
        <div class="server-item ${idx === 0 ? 'active' : ''}" onclick="changeServer(${idx}, true)">
            <div class="server-info">
                <span class="en">${srv.name}</span>
                <span class="ar" dir="rtl">السيرفر ${idx + 1}</span>
            </div>
            <svg class="check-icon" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
            <svg class="signal-icon" viewBox="0 0 24 24"><path d="M12 11c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 2c0-3.31-2.69-6-6-6s-6 2.69-6 6c0 2.22 1.21 4.15 3 5.19l1-1.74c-1.19-.7-2-1.97-2-3.45 0-2.21 1.79-4 4-4s4 1.79 4 4c0 1.48-.81 2.75-2 3.45l1 1.74c1.79-1.04 3-2.97 3-5.19Z"/></svg>
        </div>
    `).join('');

    return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${matchTitle}</title>
    <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body, html { height: 100%; width: 100%; background-color: #000; font-family: 'Tajawal', sans-serif; overflow: hidden; display: flex; justify-content: center; align-items: center; }
        .player-container { position: relative; width: 100%; height: 100%; max-width: 1200px; max-height: 800px; background-color: #000; overflow: hidden; }
        .loading-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.85); backdrop-filter: blur(10px); display: flex; flex-direction: column; justify-content: center; align-items: center; z-index: 25; transition: opacity 0.4s ease; }
        .spinner { width: 50px; height: 50px; border: 4px solid rgba(255, 255, 255, 0.1); border-top: 4px solid #5c4dff; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 12px; }
        .loading-text { color: #fff; font-size: 15px; font-weight: 500; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        #video { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain; z-index: 2; }
        .glass-bar { position: absolute; left: 50%; transform: translateX(-50%); z-index: 10; height: 58px; background: rgba(20, 22, 32, 0.78); backdrop-filter: blur(14px); border-radius: 14px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5); border: 1px solid rgba(255, 255, 255, 0.08); }
        .glass-bar.title-bar { width: 95%; max-width: 980px; height: 68px; top: 25px; }
        .glass-bar.controls-bar { width: 86%; max-width: 820px; bottom: 25px; }
        .logo-text { color: #ffffff; font-size: 17px; font-weight: 700; text-decoration: none; }
        .video-title { color: #e5e7eb; font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 65%; }
        .left-controls { display: flex; align-items: center; gap: 8px; width: 100px; }
        .live-dot { width: 8px; height: 8px; background-color: #ff3b30; border-radius: 50%; box-shadow: 0 0 8px rgba(255, 59, 48, 0.8); }
        .live-text { color: #ffffff; font-size: 13px; font-weight: 700; }
        .center-controls { position: absolute; left: 50%; transform: translateX(-50%); display: flex; justify-content: center; align-items: center; }
        .play-pause-btn { width: 44px; height: 44px; background-color: #5c4dff; border: none; border-radius: 50%; display: flex; justify-content: center; align-items: center; cursor: pointer; }
        .play-pause-icon { fill: #ffffff; width: 18px; height: 18px; }
        .right-controls { display: flex; align-items: center; gap: 18px; width: 130px; justify-content: flex-end; }
        .control-icon-btn { background: none; border: none; cursor: pointer; opacity: 0.8; }
        .icon-svg { fill: #d1d5db; width: 20px; height: 20px; }
        .server-popup { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 90%; max-width: 340px; background: rgba(20, 22, 35, 0.96); backdrop-filter: blur(16px); border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.12); color: white; z-index: 100; padding: 20px; }
        .popup-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding-bottom: 10px; }
        .server-list { display: flex; flex-direction: column; gap: 6px; max-height: 250px; overflow-y: auto; }
        .server-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-radius: 10px; cursor: pointer; }
        .server-item.active { background-color: rgba(92, 77, 255, 0.3); border: 1px solid rgba(92, 77, 255, 0.4); }
        .check-icon { width: 18px; height: 18px; fill: #5c4dff; display: none; }
        .signal-icon { width: 16px; height: 16px; fill: #9ca3af; }
        .server-item.active .check-icon { display: block; }
        .server-item.active .signal-icon { display: none; }
    </style>
</head>
<body>
    <div class="player-container" id="playerContainer">
        <div id="loadingOverlay" class="loading-overlay">
            <div class="spinner"></div>
            <div class="loading-text">جاري التحقق من البث المباشر...</div>
        </div>
        <video id="video" playsinline webkit-playsinline autoplay></video>
        <div class="glass-bar title-bar">
            <a href="${CONFIG.MAIN_WEBSITE}" target="_blank" class="logo-text">ياسين Tv بلس</a>
            <div class="video-title" dir="rtl">${matchTitle}</div>
        </div>
        <div id="serverPopup" class="server-popup">
            <div class="popup-header">
                <div>اختر الخادم للبث المباشر</div>
                <button id="closeServerPopup" style="background:none;border:none;color:#fff;">&times;</button>
            </div>
            <div class="server-list">${serverItemsHtml}</div>
        </div>
        <div class="glass-bar controls-bar">
            <div class="left-controls">
                <div class="live-dot"></div>
                <span class="live-text">LIVE</span>
            </div>
            <div class="center-controls">
                <button class="play-pause-btn" id="playPauseBtn">
                    <svg class="play-pause-icon" id="pauseIcon" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>
                    <svg class="play-pause-icon" id="playIcon" style="display: none;" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"></path></svg>
                </button>
            </div>
            <div class="right-controls">
                <button class="control-icon-btn" id="settingsBtn"><svg class="icon-svg" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg></button>
            </div>
        </div>
    </div>
    <script>
        const video = document.getElementById('video');
        const loadingOverlay = document.getElementById('loadingOverlay');
        let hls = null;
        let currentToken = '${secureToken}';
        const channelHash = '${channelHash}';
        let currentServerIndex = 0;

        function changeServer(index) {
            currentServerIndex = index;
            loadingOverlay.style.opacity = '1';
            const manifestUrl = '/manifest/' + channelHash + '/' + currentServerIndex + '?token=' + encodeURIComponent(currentToken);
            if (hls) { hls.destroy(); }
            if (Hls.isSupported()) {
                hls = new Hls({ enableWorker: true, lowLatencyMode: true });
                hls.loadSource(manifestUrl);
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    video.play();
                    loadingOverlay.style.opacity = '0';
                });
            }
            document.getElementById('serverPopup').style.display = 'none';
        }

        changeServer(0);

        document.getElementById('playPauseBtn').addEventListener('click', () => {
            if (video.paused) video.play(); else video.pause();
        });
        document.getElementById('settingsBtn').addEventListener('click', () => {
            const popup = document.getElementById('serverPopup');
            popup.style.display = popup.style.display === 'block' ? 'none' : 'block';
        });
        document.getElementById('closeServerPopup').addEventListener('click', () => {
            document.getElementById('serverPopup').style.display = 'none';
        });
    </script>
</body>
</html>`;
}

function generateOfflineUI(reasonMsg) {
    return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>البث غير متوفر</title>
    <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@500;700&display=swap" rel="stylesheet">
    <style>
        body { margin: 0; background: #0b0c10; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: 'Tajawal', sans-serif; color: white; }
        .box { background: rgba(20,22,35,0.9); padding: 40px; border-radius: 16px; text-align: center; border: 1px solid rgba(255,255,255,0.1); }
        .reason { color: #f59e0b; font-size: 18px; margin: 15px 0; font-weight: bold; }
    </style>
</head>
<body>
    <div class="box">
        <h2>عفواً، البث غير متاح حالياً</h2>
        <div class="reason">${reasonMsg}</div>
        <p>يرجى الانتظار، أو التحديث لاحقاً.</p>
    </div>
</body>
</html>`;
}

app.listen(PORT, () => {
    console.log(`🚀 Xtream & Ultra Secure Player Server running on port ${PORT}`);
});
