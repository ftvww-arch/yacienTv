const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

// إعدادات السيرفر
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(cors());

const PORT = process.env.PORT || 3000;

// ==========================================
// الإعدادات العامة والتشفير
// ==========================================
const CONFIG = {
    API_BASE_URL: 'https://ideal-spirit-production-4eeb.up.railway.app/yacintv',
    TV_CHANNELS_BASE_URL: 'https://raw.githubusercontent.com/sspc11122020-hub/getChanelFraom_dlstreams/refs/heads/main/Bein%20sport%20Ar/',
    SECRET_KEY: process.env.SECRET_KEY || 'my-super-secret-yacintv-key-2026', 
    DEFAULT_USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
};

const XTREAM_USER = "fadi";
const XTREAM_PASS = "2026";

// مفتاح ثابت لتشفير عناوين قطع الفيديو بـ AES-256 (من كودك الأصلي)
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
    async getOrFetch(key, fetcher, ttlMs) {
        const cached = this.memory.get(key);
        if (cached && cached.expiresAt > Date.now()) return cached.data;
        
        try {
            const data = await fetcher();
            this.memory.set(key, { data, expiresAt: Date.now() + ttlMs });
            return data;
        } catch (error) {
            if (cached) return cached.data;
            throw error;
        }
    }
};

setInterval(() => {
    const now = Date.now();
    for (const [key, value] of CacheEngine.memory.entries()) {
        if (now > value.expiresAt) CacheEngine.memory.delete(key);
    }
}, 60000);

// ==========================================
// 1. مسار Xtream Codes API الأساسي (player_api.php)
// ==========================================
app.get('/player_api.php', async (req, res) => {
    const { username, password, action, category_id } = req.query;

    if (username !== XTREAM_USER || password !== XTREAM_PASS) {
        return res.json({ user_info: { auth: 0 } });
    }

    if (!action) {
        return res.json({
            user_info: {
                username: XTREAM_USER,
                password: XTREAM_PASS,
                message: "LOGGED IN",
                auth: 1,
                status: "Active",
                exp_date: "1999999999",
                is_trial: "0",
                active_cons: "0",
                created_at: "1350424535",
                max_connections: "99",
                allowed_output_formats: ["m3u8","ts","rtmp"]
            },
            server_info: {
                url: req.hostname,
                port: process.env.PORT || "80",
                https_port: "443",
                server_protocol: "http",
                rtmp_port: "1935",
                timestamp_now: Math.floor(Date.now() / 1000),
                time_now: new Date().toISOString().replace('T', ' ').substring(0, 19),
                timezone: "Europe/Istanbul"
            }
        });
    }

    if (action === 'get_live_categories') {
        return res.json([
            { category_id: "1", category_name: "⚽ المباريات المباشرة اليوم", parent_id: 0 },
            { category_id: "2", category_name: "📺 قنوات البث المباشر", parent_id: 0 }
        ]);
    }

    if (action === 'get_vod_categories') {
        return res.json([{ category_id: "1", category_name: "قريباً - لا يوجد أفلام", parent_id: 0 }]);
    }
    if (action === 'get_series_categories') {
        return res.json([{ category_id: "1", category_name: "قريباً - لا يوجد مسلسلات", parent_id: 0 }]);
    }

    if (action === 'get_vod_streams' || action === 'get_series') {
        return res.json([]); 
    }

    if (action === 'get_live_streams') {
        let streams = [];

        try {
            if (!category_id || category_id === "1") {
                const matches = await CacheEngine.getOrFetch('matches_list', async () => {
                    const res = await axios.get(`${CONFIG.API_BASE_URL}/mach`, { timeout: 5000 });
                    return res.data;
                }, 60000);

                matches.forEach((match, index) => {
                    let channelStr = match.channel || match.id_live || '';
                    let cleanChannelId = channelStr.startsWith('live_tv_') ? channelStr.replace('live_tv_', '') : channelStr;
                    
                    if (cleanChannelId) {
                        streams.push({
                            num: index + 1,
                            name: match.title || match.name || `${match.team1} vs ${match.team2}`,
                            stream_type: "live",
                            stream_id: cleanChannelId,
                            stream_icon: match.logo || "https://i.imgur.com/rXjJ09Y.png",
                            category_id: "1"
                        });
                    }
                });
            }

            if (!category_id || category_id === "2") {
                const tvChannels = await CacheEngine.getOrFetch('tv_channels_index', async () => {
                    const response = await axios.get(`${CONFIG.TV_CHANNELS_BASE_URL}channels_index.json`, { timeout: 8000 });
                    return response.data;
                }, 300000);

                tvChannels.forEach((ch, index) => {
                    streams.push({
                        num: (streams.length || 0) + index + 1,
                        name: ch.name,
                        stream_type: "live",
                        stream_id: `sat_${ch.id}`,
                        stream_icon: ch.logo || "https://i.imgur.com/8Qx2y2q.png",
                        category_id: "2"
                    });
                });
            }
        } catch (e) {
            console.error("Error fetching streams:", e.message);
        }

        return res.json(streams);
    }

    return res.json([]);
});

// ==========================================
// 2. مسار تشغيل البث المباشر المدمج بنظامك الأصلي
// ==========================================
app.get('/live/:username/:password/:file', async (req, res) => {
    const { username, password, file } = req.params;

    if (username !== XTREAM_USER || password !== XTREAM_PASS) {
        return res.status(403).send('#EXTM3U\n#EXT-X-ERROR: Unauthorized User');
    }

    const stream_id = file.split('.')[0];
    const isSatChannel = stream_id.startsWith('sat_');
    
    try {
        let serverUrl = null;
        let headers = {
            'User-Agent': CONFIG.DEFAULT_USER_AGENT,
            'Accept': '*/*'
        };

        if (isSatChannel) {
            const id = stream_id.replace('sat_', '');
            const channelData = await axios.get(`${CONFIG.TV_CHANNELS_BASE_URL}channel_${id}.json`, { timeout: 5000 });
            if (channelData.data && channelData.data.servers && channelData.data.servers.length > 0) {
                serverUrl = channelData.data.servers[0].url;
                if (channelData.data.servers[0].headers) headers = { ...headers, ...channelData.data.servers[0].headers };
            }
        } else {
            const apiTarget = `live_tv_${stream_id}`;
            let apiRes = await axios.get(`${CONFIG.API_BASE_URL}/stream`, { params: { id_live: apiTarget }, headers, timeout: 5000 }).catch(() => null);
            
            if (!apiRes || !apiRes.data || (Array.isArray(apiRes.data) && apiRes.data.length === 0)) {
                apiRes = await axios.get(`${CONFIG.API_BASE_URL}/live_id/${apiTarget}`, { headers, timeout: 5000 }).catch(() => null);
            }

            const dataArray = Array.isArray(apiRes?.data) ? apiRes.data : [apiRes?.data];
            for (const srv of dataArray) {
                if (srv && srv.data && srv.data.url) {
                    let rawUrl = srv.data.url;
                    try {
                        let innerData = typeof rawUrl === 'string' && rawUrl.trim().startsWith('{') ? JSON.parse(rawUrl.trim()) : { url: rawUrl.trim() };
                        serverUrl = innerData.url;
                        if (innerData.headers) headers = { ...headers, ...innerData.headers };
                        break;
                    } catch (e) { serverUrl = rawUrl; break; }
                }
            }
        }

        if (!serverUrl) return res.status(404).send('#EXTM3U\n#EXT-X-ERROR: Stream not found or offline');

        headers['Referer'] = new URL(serverUrl).origin + '/';
        headers['Origin'] = new URL(serverUrl).origin;

        const m3u8Response = await axios.get(serverUrl, { headers, timeout: 8000 });
        const finalUrl = m3u8Response.request.res.responseUrl || serverUrl;
        const hostUrl = `https://${req.get('host')}`;
        const finalSearchParams = new URL(finalUrl).search;
        
        let lines = m3u8Response.data.split('\n');
        
        // هنا قمت بإرجاع نظام التشفير الخاص بك حرفياً
        let rewrittenLines = lines.map(line => {
            let trimmed = line.trim().replace(/\r/g, '').replace(/\\$/g, '');
            if (!trimmed || trimmed.startsWith('#')) return trimmed;

            let absoluteLink = trimmed.startsWith('http') ? trimmed 
                             : trimmed.startsWith('/') ? new URL(finalUrl).origin + trimmed 
                             : new URL(trimmed, finalUrl).href;

            if (finalSearchParams && !absoluteLink.includes('?')) {
                absoluteLink += finalSearchParams;
            }

            const encryptedSegment = encryptUrl(absoluteLink);
            return `${hostUrl}/s/${encryptedSegment}/segment.ts`;
        });

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(rewrittenLines.join('\n'));

    } catch (error) {
        console.error(`[Stream Error] ${stream_id}:`, error.message);
        res.status(500).send('#EXTM3U\n#EXT-X-ERROR: Source Stream Unavailable');
    }
});

// ==========================================
// 3. مسار التدفق الأصلي والمشفر (Stream Pipe) 
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
        
        // تمكين التخزين المؤقت كما في كودك الأصلي
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

app.get('/', (req, res) => {
    res.json({ name: "Yacine Xtream Emulator - Pro", status: "Online" });
});

app.listen(PORT, () => {
    console.log(`🚀 Xtream API Server is running on port ${PORT}`);
});
