const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const compression = require('compression');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// ==========================================
// الإعدادات العامة والتشفير
// ==========================================
const CONFIG = {
    API_BASE_URL: 'https://ideal-spirit-production-4eeb.up.railway.app/yacintv',
    TV_CHANNELS_BASE_URL: 'https://raw.githubusercontent.com/sspc11122020-hub/getChanelFraom_dlstreams/refs/heads/main/Bein%20sport%20Ar/',
    CACHE_DURATION: 300000, 
    MANIFEST_CACHE: 2000,    
    SECRET_KEY: process.env.SECRET_KEY || 'my-super-secret-yacintv-key-2026', 
    MAIN_WEBSITE: 'https://www.ytvplus.buzz/',
    DEFAULT_USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
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
// جلب معلومات البث والمصادر
// ==========================================
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
            let rawUrl = typeof srv.data.url === 'string' ? srv.data.url.trim() : '';
            let innerData = rawUrl.startsWith('{') ? JSON.parse(rawUrl) : { url: rawUrl };
            servers.push({ 
                name: srv.name || `سيرفر ${i + 1}`, 
                url: innerData.url, 
                headers: innerData.headers || {}, 
                swap: innerData.swap || null 
            });
        } catch (e) {}
    });
    if (servers.length === 0) throw new Error('لا توجد سيرفرات');
    return servers;
}

async function fetchManifest(serverInfo, hostUrl) {
    const parsedTarget = new URL(serverInfo.url);
    const headers = { 
        'User-Agent': serverInfo.headers['User-Agent'] || serverInfo.headers['user-agent'] || CONFIG.DEFAULT_USER_AGENT,
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

        const payload = JSON.stringify({ url: absoluteLink, headers });
        const encryptedSegment = encryptUrl(payload);
        return `${hostUrl}/s/${encryptedSegment}/segment.ts`;
    });

    return rewrittenLines.join('\n');
}

// ==========================================
// البروكسي (لنقل الحزم وتخطي الحماية)
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

    const referer = (req.headers['referer'] || req.headers['origin'] || '').toLowerCase();
    const host = req.get('host') || '';
    const mainHost = new URL(CONFIG.MAIN_WEBSITE).hostname;

    if (referer && !referer.includes(host) && !referer.includes(mainHost)) {
        return res.status(403).send('Access Denied');
    }

    try {
        const parsedUrl = new URL(targetUrl);
        const headers = {
            'User-Agent': customHeaders['User-Agent'] || customHeaders['user-agent'] || CONFIG.DEFAULT_USER_AGENT,
            'Accept': '*/*',
            'Referer': customHeaders['Referer'] || `${parsedUrl.origin}/`,
            'Origin': customHeaders['Origin'] || parsedUrl.origin,
            ...customHeaders
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

// ==========================================
// مسار Xtream API (المسؤول عن توفير قنوات الـ IPTV)
// ==========================================
app.get('/player_api.php', async (req, res) => {
    const { username, password, action } = req.query;

    if (username !== '2026' || password !== '2026') {
        return res.json({ user_info: { auth: 0, status: "Incorrect details" } });
    }

    if (!action) {
        return res.json({
            user_info: {
                username: "2026", password: "2026", message: "Welcome",
                auth: 1, status: "Active", exp_date: "1999999999", is_trial: "0",
                active_cons: "0", created_at: "1600000000", max_connections: "100",
                allowed_output_formats: ["m3u8", "ts"]
            },
            server_info: {
                url: req.hostname, port: PORT, https: req.secure ? "443" : "80",
                server_protocol: req.secure ? "https" : "http", timestamp_now: Math.floor(Date.now() / 1000)
            }
        });
    }

    if (action === 'get_live_categories') {
        return res.json([{ category_id: "1", category_name: "مباريات اليوم", parent_id: 0 }]);
    }

    if (action === 'get_live_streams') {
        try {
            const matches = await CacheEngine.getOrFetch('matches_list', async () => {
                const response = await axios.get(`${CONFIG.API_BASE_URL}/mach`, { timeout: 5000 });
                return response.data;
            }, 60000);

            const streams = matches.map((match, index) => {
                let channelStr = match.channel || match.id_live || '';
                let cleanChannel = channelStr.startsWith('live_tv_') ? channelStr.replace('live_tv_', '') : channelStr;
                let matchTitle = match.title || match.name || match.match_name || `${match.team1} vs ${match.team2}`;
                return {
                    num: index + 1, name: matchTitle || `Match ${index + 1}`,
                    stream_type: "live", stream_id: cleanChannel, stream_icon: match.logo || match.image || "",
                    category_id: "1", added: Math.floor(Date.now() / 1000).toString(), custom_sid: "", tv_archive: 0, direct_source: ""
                };
            });
            return res.json(streams);
        } catch (error) { return res.json([]); }
    }

    if (['get_vod_categories', 'get_series_categories', 'get_vod_streams', 'get_series'].includes(action)) {
        return res.json([]); 
    }

    return res.json([]);
});

// ==========================================
// مسار البث المباشر (الرابط المباشر للمشغلات مع نظام الفحص التلقائي Failover)
// ==========================================
app.get('/:username/:password/:filename', async (req, res, next) => {
    const { username, password, filename } = req.params;

    // استثناء المسارات الأساسية حتى لا تتداخل
    const restrictedPaths = ['s', 'api', 'player_api.php', 'ping'];
    if (restrictedPaths.includes(username)) {
        return next();
    }

    // التحقق من اليوزر والباسورد
    if (username !== '2026' || password !== '2026') {
        return res.status(401).send('Unauthorized');
    }

    // استخراج اسم القناة بحذف .m3u8 أو .ts إن وجدت
    const streamId = filename.replace(/\.(m3u8|ts)$/, '');

    try {
        const servers = await CacheEngine.getOrFetch(`servers_${streamId}`, () => fetchChannelServers(streamId), CONFIG.CACHE_DURATION);
        
        const protocol = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
        const hostUrl = `${protocol}://${req.get('host')}`;
        
        let manifestData = null;
        let isWorking = false;

        // 🔄 نظام الفحص الذكي (تجربة السيرفرات بالترتيب)
        for (let i = 0; i < servers.length; i++) {
            try {
                const serverInfo = servers[i];
                manifestData = await CacheEngine.getOrFetch(`manifest_${streamId}_${i}`, () => fetchManifest(serverInfo, hostUrl), CONFIG.MANIFEST_CACHE);
                isWorking = true;
                
                console.log(`✅ القناة [${streamId}] تعمل الآن على السيرفر رقم ${i + 1}`);
                break; // بمجرد نجاح التشغيل، يتم إيقاف الفحص
            } catch (err) {
                console.log(`⚠️ السيرفر ${i + 1} فشل في تشغيل [${streamId}]، جاري تجربة السيرفر التالي...`);
            }
        }

        if (!isWorking) {
            throw new Error('جميع السيرفرات متوقفة حالياً');
        }

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(manifestData);
    } catch (error) {
        console.error(`❌ القناة [${streamId}] غير متوفرة:`, error.message);
        res.status(404).send('#EXTM3U\n#EXTINF:-1,Stream Offline\n');
    }
});

app.get('/ping', (req, res) => res.send('Server is awake.'));

app.listen(PORT, () => {
    console.log(`🚀 Xtream Player API running on port ${PORT}`);
});
