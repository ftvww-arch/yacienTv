const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ==========================================
// حماية خفيفة وسريعة ضد السبام
// ==========================================
const requestCounts = new Map();
app.use((req, res, next) => {
    const ip = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.ip;
    const now = Date.now();
    const windowMs = 60 * 1000; 
    const maxRequests = 120; 

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

// ==========================================
// الإعدادات العامة 
// ==========================================
const CONFIG = {
    API_BASE_URL: 'https://sunny-appreciation-production-3d25.up.railway.app/yacintv',
    CACHE_DURATION: 300000, 
    MANIFEST_CACHE: 2000,    
    SECRET_KEY: crypto.randomBytes(32).toString('hex'), 
    TOKEN_EXPIRY: 10 * 60 * 1000, 
    MAIN_WEBSITE: 'https://www.kirozozo.xyz/' 
};

process.on('uncaughtException', (err) => { console.error('Caught exception: ', err); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); });

// ==========================================
// دوال التشفير والأمان
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
// محرك الكاش والتخزين المؤقت بالذاكرة
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
            if (this.memory.size > 300) {
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

// ==========================================
// فحص وصلاحية السيرفر (Validate Stream)
// ==========================================
async function validateStream(url, headers) {
    try {
        const cleanHeaders = { ...headers };
        delete cleanHeaders['host'];
        delete cleanHeaders['accept-encoding'];
        const response = await axios.get(url, { headers: cleanHeaders, timeout: 5000 });
        return response.status === 200;
    } catch (error) {
        return false;
    }
}

// ==========================================
// محاكاة جلب قنوات BeIN (بديل الـ Workflow القديم)
// ==========================================
async function scrapeBeinChannel(channelId) {
    const BASE_URL = 'https://dlstreams.st';
    const servers = [];
    
    try {
        const { data: html } = await axios.get(`${BASE_URL}/watch.php?id=${channelId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': BASE_URL
            },
            timeout: 10000
        });

        const m3u8Regex = /(https?:\/\/[^\s"'`]+\.m3u8[^\s"'`]*)/g;
        const matches = html.match(m3u8Regex);

        if (matches && matches.length > 0) {
            const uniqueUrls = [...new Set(matches)];
            for (let i = 0; i < uniqueUrls.length; i++) {
                const srvUrl = uniqueUrls[i];
                const srvHeaders = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': BASE_URL
                };
                
                // فحص ما إذا كان السيرفر حقيقياً ويعمل
                const isValid = await validateStream(srvUrl, srvHeaders);
                if (isValid) {
                    servers.push({
                        name: `سيرفر ${servers.length + 1} (Live)`,
                        url: srvUrl,
                        headers: srvHeaders,
                        swap: null
                    });
                }
            }
        }
    } catch (err) {
        console.error(`خطأ في جلب قناة Bein ${channelId}:`, err.message);
    }

    if (servers.length === 0) {
        // سيرفر احتياطي افتراضي في حال لم يعثر على روابط مباشرة
        servers.push({
            name: `سيرفر احتياطي`,
            url: `${BASE_URL}/watch.php?id=${channelId}`,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': BASE_URL },
            swap: null
        });
    }
    return servers;
}

// ==========================================
// التحديث التلقائي في الخلفية لكل القنوات (من 91 إلى 99)
// ==========================================
async function backgroundRefreshBeinChannels() {
    console.log('🔄 بدء التحديث التلقائي لقنوات beIN في الخلفية...');
    for (let id = 91; id <= 99; id++) {
        try {
            const servers = await scrapeBeinChannel(id);
            CacheEngine.memory.set(`bein_servers_${id}`, { data: servers, expiresAt: Date.now() + (20 * 60 * 1000) });
            console.log(`✅ تم تحديث قناة beIN ${id} بنجاح.`);
        } catch (e) {
            console.log(`⚠️ فشل تحديث قناة beIN ${id}`);
        }
        await new Promise(r => setTimeout(r, 2000)); // مهلة قصيرة بين كل قناة وأخرى
    }
}

// تشغيل التحديث فوراً عند الإقلاع ثم جدولته كل 15 دقيقة
setTimeout(backgroundRefreshBeinChannels, 5000);
setInterval(backgroundRefreshBeinChannels, 15 * 60 * 1000);

// ==========================================
// جلب المباريات والسيرفرات العادية
// ==========================================
async function getMatchInfo(realChannelName) {
    try {
        const matches = await CacheEngine.getOrFetch('matches_list', async () => {
            const res = await axios.get(`${CONFIG.API_BASE_URL}/mach`, { timeout: 5000 });
            return res.data;
        }, 60000);

        const channelId = `live_tv_${realChannelName}`;
        const targetMatch = matches.find(m => m.id_live === channelId || m.channel === channelId);

        if (!targetMatch) return { isAvailable: false, reason: 'المباراة غير مدرجة في جدول البث', title: realChannelName };
        
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
// مسار معاينة البيانات المستخرجة (Debug)
// ==========================================
app.get('/debug/streams', (req, res) => {
    const debugData = {};
    
    // المرور على القنوات من 91 إلى 99 وفحص ما يوجد في الذاكرة
    for (let id = 91; id <= 99; id++) {
        const cached = CacheEngine.memory.get(`bein_servers_${id}`);
        debugData[`beIN Sports ${id - 90} Arabic (ID: ${id})`] = cached ? {
            status: "Available",
            serversCount: cached.data.length,
            servers: cached.data
        } : {
            status: "Not fetched yet or expired"
        };
    }
    
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(debugData, null, 2));
});



// ==========================================
// مسارات التطبيق (Routes)
// ==========================================
app.get('/ping', (req, res) => res.send('Pong! Server is awake.'));

app.get('/api/refresh-token', (req, res) => {
    const userIp = getClientIp(req);
    const newToken = generateSecureToken(userIp);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.json({ token: newToken });
});

app.get('/bein/:id', async (req, res) => {
    try {
        const channelId = parseInt(req.params.id);
        if (isNaN(channelId) || channelId < 91 || channelId > 99) {
            return res.send(generateOfflineUI('رقم القناة غير صالح'));
        }

        const matchTitle = `beIN Sports ${channelId - 90} Arabic`;
        
        // جلب السيرفرات المحدثة مسبقاً من الذاكرة أو فحصها فوراً إن لم تتوفر
        let cached = CacheEngine.memory.get(`bein_servers_${channelId}`);
        let servers = cached ? cached.data : await scrapeBeinChannel(channelId);

        const userIp = getClientIp(req);
        const secureToken = generateSecureToken(userIp);
        const hostUrl = `${req.protocol}://${req.get('host')}`;
        
        res.send(generateUI(`bein_${channelId}`, servers, secureToken, matchTitle, hostUrl)); 
    } catch (error) {
        res.send(generateOfflineUI('جاري تجهيز البث، يرجى التحديث بعد قليل...'));
    }
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
        if (!token || !verifySecureToken(token, userIp)) return res.status(403).send('Invalid Token');

        const { hash, serverIndex } = req.params;
        let servers, serverInfo, cacheKey;

        if (hash.startsWith('bein_')) {
            const channelId = parseInt(hash.replace('bein_', ''));
            const cachedData = CacheEngine.memory.get(`bein_servers_${channelId}`);
            servers = cachedData ? cachedData.data : null;
            if (!servers) return res.status(404).send('Expired');
            serverInfo = servers[parseInt(serverIndex)];
            cacheKey = `manifest_bein_${channelId}_${serverIndex}`;
        } else {
            const realChannel = decodeId(hash);
            servers = await CacheEngine.getOrFetch(`servers_${realChannel}`, () => fetchChannelServers(realChannel), CONFIG.CACHE_DURATION);
            serverInfo = servers[parseInt(serverIndex)];
            cacheKey = `manifest_${realChannel}_${serverIndex}`;
        }

        if (!serverInfo) return res.status(404).send('Server not found');

        const manifestData = await CacheEngine.getOrFetch(cacheKey, () => fetchManifest(serverInfo), CONFIG.MANIFEST_CACHE);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(manifestData);
    } catch (error) {
        res.status(500).send('Manifest Error');
    }
});

// ==========================================
// الواجهة البسيطة للمشغل
// ==========================================
function generateUI(channelHash, servers, secureToken, matchTitle, hostUrl) {
    const totalServers = servers.length;
    let embedUrl = channelHash.startsWith('bein_') ? `${hostUrl}/bein/${channelHash.replace('bein_', '')}` : `${hostUrl}/play/${channelHash}`;

    const serverItemsHtml = servers.map((srv, idx) => `
        <div class="server-item ${idx === 0 ? 'active' : ''}" onclick="changeServer(${idx})">
            <span>${srv.name}</span>
        </div>
    `).join('');

    return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${matchTitle}</title>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <style>
        body, html { height: 100%; margin: 0; background: #000; font-family: sans-serif; display: flex; flex-direction: column; justify-content: center; align-items: center; }
        #video { width: 100%; height: 100%; max-height: 85vh; background: #000; }
        .bar { width: 100%; max-width: 900px; display: flex; justify-content: space-between; padding: 10px; color: #fff; background: #111; align-items: center; }
        .servers { display: flex; gap: 8px; }
        .server-item { background: #333; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 14px; }
        .server-item.active { background: #5c4dff; }
    </style>
</head>
<body>
    <div class="bar">
        <div><b>${matchTitle}</b></div>
        <div class="servers">${serverItemsHtml}</div>
    </div>
    <video id="video" controls autoplay playsinline></video>
    <script>
        const video = document.getElementById('video');
        let hls = null;
        const channelHash = '${channelHash}';
        let currentToken = '${secureToken}';

        function changeServer(idx) {
            const manifestUrl = '/manifest/' + channelHash + '/' + idx + '?token=' + encodeURIComponent(currentToken);
            if (hls) { hls.destroy(); hls = null; }
            
            if (Hls.isSupported()) {
                hls = new Hls();
                hls.loadSource(manifestUrl);
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play(); });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = manifestUrl;
                video.load();
                video.play();
            }
            
            document.querySelectorAll('.server-item').forEach((el, i) => {
                if (i === idx) el.classList.add('active');
                else el.classList.remove('active');
            });
        }
        changeServer(0);
    </script>
</body>
</html>`;
}

function generateOfflineUI(reasonMsg) {
    return `<body style="background:#000;color:#fff;text-align:center;padding-top:20vh;font-family:sans-serif;">
        <h2>عفواً، البث غير متاح</h2>
        <p style="color:#f59e0b;font-size:18px;">${reasonMsg}</p>
        <script>setTimeout(() => location.reload(), 15000);</script>
    </body>`;
}

app.listen(PORT, () => console.log(`Integrated server running on port ${PORT}`));
