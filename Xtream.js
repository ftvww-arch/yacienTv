const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const compression = require('compression');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    DEFAULT_USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    
    // بيانات تسجيل الدخول الخاصة بـ Xtream Codes API
    XTREAM_USER: 'fadi',
    XTREAM_PASS: '2026'
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

process.on('uncaughtException', (err) => { console.error('Uncaught Exception: ', err); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); });

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
    const maxRequests = 500; 

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

function encodeId(text) { return Buffer.from(text).toString('hex'); }
function decodeId(hash) { try { return Buffer.from(hash, 'hex').toString('utf8'); } catch (e) { return null; } }

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
// 🚀 Xtream Codes API (Core)
// ==========================================

app.all('/player_api.php', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    const username = req.query.username || req.body.username;
    const password = req.query.password || req.body.password;
    const action = req.query.action || req.body.action;

    if (username !== CONFIG.XTREAM_USER || password !== CONFIG.XTREAM_PASS) {
        return res.status(200).json({
            user_info: { auth: 0, status: "Disabled", message: "بيانات الدخول غير صحيحة" }
        });
    }

    const host = req.get('host');
    const protocol = req.protocol;
    const nowUnix = Math.floor(Date.now() / 1000);

    if (!action) {
        return res.json({
            user_info: {
                username: CONFIG.XTREAM_USER,
                password: CONFIG.XTREAM_PASS,
                message: "مرحباً بك في السيرفر",
                auth: 1,
                status: "Active",
                exp_date: "1798761600",
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

    if (action === 'get_live_categories') {
        return res.json([
            { category_id: "1", category_name: "⚽ المباريات المباشرة", parent_id: 0 },
            { category_id: "2", category_name: "📺 قنوات beIN Sports", parent_id: 0 }
        ]);
    }

    if (action === 'get_live_streams') {
        const categoryId = req.query.category_id || req.body.category_id;
        let streams = [];
        let streamIndex = 1;

        try {
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

    return res.json([]);
});

// دعم جميع صيغ الروابط التي تطلبها المشغلات (مع /live/ أو بدونها)
app.get(['/live/:username/:password/:streamId', '/live/:username/:password/:streamId.:ext', '/:username/:password/:streamId', '/:username/:password/:streamId.:ext'], async (req, res) => {
    const { username, password, streamId } = req.params;

    if (['api', 'ping'].includes(username)) {
        return res.status(404).send('Not Found');
    }

    if (username !== CONFIG.XTREAM_USER || password !== CONFIG.XTREAM_PASS) {
        return res.status(403).send('Access Denied');
    }

    const cleanHash = streamId.replace(/\.(m3u8|ts|mp4)$/i, '');
    const realChannel = decodeId(cleanHash);

    if (!realChannel) return res.status(404).send('Channel Not Found');

    try {
        const servers = await CacheEngine.getOrFetch(`servers_${realChannel}`, () => fetchChannelServers(realChannel), CONFIG.CACHE_DURATION);
        const serverInfo = servers[0]; 
        const hostUrl = `${req.protocol}://${req.get('host')}`;

        const cacheKey = `xtream_manifest_${realChannel}_0`;
        const manifestData = await CacheEngine.getOrFetch(cacheKey, () => fetchManifest(serverInfo, hostUrl), CONFIG.MANIFEST_CACHE);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(manifestData);
    } catch (error) {
        res.status(500).send('Stream Error');
    }
});

// ==========================================
// البروكسي المفتوح للقطع (Segment Proxy)
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
            timeout: 15000,
            validateStatus: status => status >= 200 && status < 500
        });

        res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp2t');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
        res.setHeader('Cache-Control', 'no-cache');

        if (response.headers['content-range']) {
            res.setHeader('Content-Range', response.headers['content-range']);
        }

        res.status(response.status);
        response.data.pipe(res);
    } catch (e) {
        res.status(500).send('Proxy Segment Error');
    }
});

app.get('/ping', (req, res) => res.send('Pong! Server is awake.'));

app.listen(PORT, () => {
    console.log(`🚀 Pure Xtream Server running on port ${PORT}`);
});
