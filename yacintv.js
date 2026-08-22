const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. الإعدادات العامة (Configuration)
// ==========================================
const CONFIG = {
    API_BASE_URL: 'https://sunny-appreciation-production-3d25.up.railway.app/yacintv',
    CACHE_DURATION: 300000, 
    MANIFEST_CACHE: 2000,    
    SECRET_KEY: crypto.randomBytes(32).toString('hex'), 
    TOKEN_EXPIRY: 10 * 60 * 1000, 
    MAIN_WEBSITE: 'https://www.kirozozo.xyz/' 
};

process.on('uncaughtException', (err) => console.error('Caught exception: ', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

// ==========================================
// 2. الأمان والتشفير (Security & Crypto)
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
    } catch (e) { return false; }
}

function getClientIp(req) { 
    return req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.ip; 
}

const encodeId = (text) => Buffer.from(text).toString('hex');
const decodeId = (hash) => { try { return Buffer.from(hash, 'hex').toString('utf8'); } catch (e) { return null; } };

// ==========================================
// 3. التخزين المؤقت (Cache Engine)
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
            if (this.memory.size > 300) this.memory.delete(this.memory.keys().next().value);
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
}, 60000);

// ==========================================
// 4. معالجة البيانات (Data Fetchers)
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
        
        const channelField = targetMatch.channel || targetMatch.id_live;
        if (!channelField || channelField.trim() === '') return { isAvailable: false, reason: 'لا توجد قناة بث متاحة', title: realChannelName };

        let matchTitle = targetMatch.title || targetMatch.name || targetMatch.match_name || realChannelName;
        if (!targetMatch.title && targetMatch.team1 && targetMatch.team2) matchTitle = `${targetMatch.team1} vs ${targetMatch.team2}`;

        return { isAvailable: true, title: matchTitle };
    } catch (e) { return { isAvailable: true, title: realChannelName }; }
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
            servers.push({ name: srv.name || `جودة ${i + 1}`, url: innerData.url, headers: innerData.headers || {}, swap: innerData.swap || null });
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

    return m3u8.replace(/^(?!#)(.*)$/gm, (line) => {
        let url = line.trim();
        if (!url || url.startsWith('#')) return line;
        if (!url.startsWith('http')) url = baseUrl + url;
        if (swapKey && url.includes(swapKey)) url = url.replace(swapKey, swapVal);
        return url;
    });
}

// ==========================================
// 5. المسارات (Routes)
// ==========================================
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
    } catch (error) { res.status(500).json({ error: 'Failed' }); }
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
        res.send(generateOfflineUI('البث غير متوفر حالياً، يرجى المحاولة لاحقاً.'));
    }
});

app.get('/manifest/:hash/:serverIndex', async (req, res) => {
    try {
        const userAgent = (req.headers['user-agent'] || '').toLowerCase();
        const referer = (req.headers['referer'] || req.headers['origin'] || '').toLowerCase();
        const host = req.get('host') || '';
        const mainHost = new URL(CONFIG.MAIN_WEBSITE).hostname;
        const blockedAgents = ['vlc', 'mpv', 'potplayer', 'iptv', 'smartiptv', 'python', 'axios', 'curl', 'java', 'okhttp', 'wget', 'exoplayer'];
        if (blockedAgents.some(agent => userAgent.includes(agent))) return res.status(403).send('Denied');
        if (!referer.includes(host) && !referer.includes(mainHost)) return res.status(403).send('Denied');

        const token = req.query.token;
        const userIp = getClientIp(req);
        if (!token || !verifySecureToken(token, userIp)) return res.status(403).send('Denied');

        const { hash, serverIndex } = req.params;
        const realChannel = decodeId(hash);
        const cacheKey = `manifest_${realChannel}_${serverIndex}`;
        const servers = await CacheEngine.getOrFetch(`servers_${realChannel}`, () => fetchChannelServers(realChannel), CONFIG.CACHE_DURATION);
        const serverInfo = servers[parseInt(serverIndex)];
        if(!serverInfo) return res.status(404).send('Not found');

        const manifestData = await CacheEngine.getOrFetch(cacheKey, () => fetchManifest(serverInfo), CONFIG.MANIFEST_CACHE);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(manifestData);
    } catch (error) { res.status(500).send('Error'); }
});

// ==========================================
// 6. واجهة المستخدم (تصميم الزجاج العائم المطور)
// ==========================================
function generateUI(channelHash, servers, secureToken, matchTitle, hostUrl) {
    const embedUrl = `${hostUrl}/play/${channelHash}`;

    const serverItemsHtml = servers.map((srv, idx) => `
        <div class="quality-item ${idx === 0 ? 'active' : ''}" data-index="${idx}">
            <svg class="check-icon" viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>
            <span class="quality-name">${srv.name}</span>
        </div>
    `).join('');

    return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${matchTitle}</title>
    <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@500;700;800&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <style>
        :root {
            --primary: #e50914; 
            --bg-dark: #000;
            --glass-bg: rgba(20, 20, 20, 0.65);
            --glass-border: rgba(255, 255, 255, 0.1);
            --glass-hover: rgba(255, 255, 255, 0.2);
            --text-light: #fff;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
        body, html { height: 100%; width: 100%; background-color: var(--bg-dark); font-family: 'Tajawal', sans-serif; overflow: hidden; }
        
        .player-container {
            position: relative; width: 100%; height: 100%; display: flex; justify-content: center; align-items: center;
            background: #000; overflow: hidden;
        }

        #video { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain; z-index: 1; }

        /* طبقة الواجهة */
        .ui-layer {
            position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 10;
            pointer-events: none; /* للسماح بالنقر على الفيديو في المنتصف */
        }

        /* التصميم الزجاجي المشترك للأشرطة */
        .glass-bar {
            position: absolute; left: 2%; right: 2%;
            background: var(--glass-bg); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
            border: 1px solid var(--glass-border); border-radius: 16px;
            display: flex; align-items: center; justify-content: space-between;
            padding: 12px 20px; transition: opacity 0.4s ease, transform 0.4s ease;
            pointer-events: auto; /* تفعيل النقر داخل الأشرطة */
            box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
        }

        /* الشريط العلوي */
        .top-bar { top: 20px; }
        .player-container.idle .top-bar { opacity: 0; transform: translateY(-30px); }
        
        .video-title { color: var(--text-light); font-size: 16px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 75%; }
        .logo { color: var(--primary); font-weight: 800; font-size: 18px; text-decoration: none; font-family: sans-serif; letter-spacing: 1px; }

        /* الشريط السفلي */
        .bottom-bar { bottom: 20px; }
        .player-container.idle .bottom-bar { opacity: 0; transform: translateY(30px); }

        .controls-group { display: flex; align-items: center; gap: 12px; }

        /* الأزرار الزجاجية */
        .glass-btn {
            background: rgba(255, 255, 255, 0.08); border: 1px solid transparent; color: var(--text-light);
            width: 44px; height: 44px; border-radius: 50%; display: flex; justify-content: center; align-items: center;
            cursor: pointer; transition: all 0.2s ease;
        }
        .glass-btn:hover { background: var(--glass-hover); border-color: rgba(255,255,255,0.2); transform: scale(1.05); }
        .glass-btn svg { fill: currentColor; width: 24px; height: 24px; }
        
        /* زر التشغيل الأساسي */
        .play-btn { background: var(--primary); color: white; box-shadow: 0 4px 15px rgba(229, 9, 20, 0.4); }
        .play-btn:hover { background: #ff0f1a; border-color: transparent; }

        /* مؤشر البث المباشر */
        .live-badge {
            display: flex; align-items: center; gap: 6px; background: rgba(0,0,0,0.5); padding: 6px 12px;
            border-radius: 20px; color: #fff; font-size: 14px; font-weight: 700; border: 1px solid rgba(255,255,255,0.05);
        }
        .live-dot { width: 8px; height: 8px; background-color: var(--primary); border-radius: 50%; animation: pulse 1.5s infinite; }

        /* نافذة الجودة المنبثقة (زجاجية أيضاً) */
        .settings-menu {
            position: absolute; bottom: 85px; left: 2%; 
            background: var(--glass-bg); backdrop-filter: blur(15px); -webkit-backdrop-filter: blur(15px);
            border: 1px solid var(--glass-border); border-radius: 16px;
            min-width: 220px; max-height: 250px; overflow-y: auto; color: #fff; z-index: 50; display: none;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5); animation: scaleUp 0.2s ease-out forwards;
            pointer-events: auto; transform-origin: bottom left;
        }
        .settings-header { padding: 14px 16px; font-size: 15px; font-weight: 700; border-bottom: 1px solid rgba(255,255,255,0.08); color: #ccc; display: flex; align-items: center; gap: 8px; }
        .quality-item { padding: 12px 16px; display: flex; align-items: center; gap: 10px; cursor: pointer; transition: background 0.2s; font-size: 14px; font-weight: 500; }
        .quality-item:hover { background: rgba(255,255,255,0.1); }
        .quality-item .check-icon { width: 18px; height: 18px; fill: var(--primary); opacity: 0; }
        .quality-item.active .check-icon { opacity: 1; }

        /* شاشة التحميل وأيقونة النقر بالمنتصف */
        .loading-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; justify-content: center; align-items: center; z-index: 20; transition: opacity 0.4s; pointer-events: none; }
        .spinner { width: 48px; height: 48px; border: 4px solid rgba(255,255,255,0.1); border-left-color: var(--primary); border-radius: 50%; animation: spin 1s linear infinite; }

        .center-action-icon {
            position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(1.5);
            width: 70px; height: 70px; background: rgba(0,0,0,0.6); backdrop-filter: blur(5px); border-radius: 50%;
            display: flex; justify-content: center; align-items: center; color: white;
            opacity: 0; pointer-events: none; transition: opacity 0.2s, transform 0.2s; z-index: 15;
        }
        .center-action-icon svg { width: 36px; height: 36px; fill: #fff; }
        .center-action-icon.animate-action { opacity: 1; transform: translate(-50%, -50%) scale(1); animation: fadeOutAction 0.6s forwards; }

        /* نافذة التضمين (Modal) */
        .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.8); backdrop-filter: blur(5px); justify-content: center; align-items: center; }
        .modal-content { background: #1a1a1a; border-radius: 16px; padding: 24px; width: 90%; max-width: 450px; color: white; border: 1px solid #333; }
        .modal-header { display: flex; justify-content: space-between; margin-bottom: 15px; }
        .close-modal { background: none; border: none; color: #fff; font-size: 24px; cursor: pointer; }
        textarea.embed-code { width: 100%; height: 100px; background: #000; color: #fff; padding: 12px; border: 1px solid #444; border-radius: 10px; resize: none; margin-bottom: 15px; font-family: monospace; direction: ltr;}
        .copy-btn { width: 100%; padding: 12px; background: var(--primary); color: #fff; border: none; border-radius: 10px; font-weight: 700; font-family: 'Tajawal'; cursor: pointer; font-size: 16px; }

        /* Scrollbar */
        .settings-menu::-webkit-scrollbar { width: 5px; }
        .settings-menu::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 10px; }

        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 50% { opacity: 0.4; } }
        @keyframes scaleUp { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
        @keyframes fadeOutAction { 0% { opacity: 1; transform: translate(-50%, -50%) scale(1); } 100% { opacity: 0; transform: translate(-50%, -50%) scale(1.4); } }

        @media (max-width: 600px) {
            .glass-bar { left: 3%; right: 3%; padding: 10px 15px; border-radius: 12px; }
            .top-bar { top: 15px; }
            .bottom-bar { bottom: 15px; }
            .glass-btn { width: 38px; height: 38px; }
            .glass-btn svg { width: 20px; height: 20px; }
            .logo { font-size: 16px; }
            .video-title { font-size: 14px; }
        }
    </style>
</head>
<body>

    <div class="player-container" id="playerContainer">
        
        <div id="loadingOverlay" class="loading-overlay"><div class="spinner"></div></div>
        <video id="video" playsinline webkit-playsinline autoplay></video>
        <div class="center-action-icon" id="centerAction"></div>

        <div class="ui-layer" id="uiLayer">
            
            <!-- الشريط الزجاجي العلوي -->
            <div class="glass-bar top-bar">
                <div class="video-title" dir="rtl">${matchTitle}</div>
                <a href="${CONFIG.MAIN_WEBSITE}" target="_blank" class="logo">YTPlus</a>
            </div>
            
            <!-- الشريط الزجاجي السفلي -->
            <div class="glass-bar bottom-bar">
                
                <!-- الأزرار اليسرى (إعدادات، تضمين، شاشة كاملة) -->
                <div class="controls-group">
                    <button class="glass-btn" id="settingsBtn" title="الجودة">
                        <svg viewBox="0 0 24 24"><path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.73,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/></svg>
                    </button>
                    <button class="glass-btn" id="embedBtn" title="تضمين">
                        <svg viewBox="0 0 24 24"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>
                    </button>
                    <button class="glass-btn" id="fullscreenBtn" title="شاشة كاملة">
                        <svg id="icon-fs-enter" viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
                    </button>
                </div>

                <!-- الأزرار اليمنى (مباشر، تشغيل) -->
                <div class="controls-group">
                    <div class="live-badge"><div class="live-dot"></div> مباشر</div>
                    <button class="glass-btn play-btn" id="playPauseBtn" title="تشغيل / إيقاف">
                        <svg id="icon-pause" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                        <svg id="icon-play" viewBox="0 0 24 24" style="display:none;"><path d="M8 5v14l11-7z"/></svg>
                    </button>
                </div>

            </div>

            <!-- قائمة الجودة الزجاجية -->
            <div class="settings-menu" id="settingsMenu">
                <div class="settings-header">اختر الجودة</div>
                ${serverItemsHtml}
            </div>

        </div>
    </div>

    <!-- نافذة التضمين -->
    <div id="embedModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h3>كود التضمين</h3>
                <button class="close-modal" id="closeEmbedModal">&times;</button>
            </div>
            <textarea class="embed-code" id="embedCodeArea" readonly><iframe src="${embedUrl}" width="100%" height="100%" frameborder="0" allowfullscreen></iframe></textarea>
            <button class="copy-btn" id="copyEmbedBtn">نسخ الكود</button>
        </div>
    </div>

    <script>
        const video = document.getElementById('video');
        const container = document.getElementById('playerContainer');
        const loadingOverlay = document.getElementById('loadingOverlay');
        const playPauseBtn = document.getElementById('playPauseBtn');
        const settingsBtn = document.getElementById('settingsBtn');
        const settingsMenu = document.getElementById('settingsMenu');
        const fullscreenBtn = document.getElementById('fullscreenBtn');
        const centerAction = document.getElementById('centerAction');
        
        let hls = null;
        const TOKEN = '${secureToken}';
        const channelHash = '${channelHash}';
        
        // نظام الإعلانات المخفية الآمن
        const smartLinks = ['https://omg10.com/4/7056731', 'https://omg10.com/4/7436731'];
        let adOpened = false;

        function triggerSmartAd() {
            if (!adOpened) {
                adOpened = true;
                const randomUrl = smartLinks[Math.floor(Math.random() * smartLinks.length)];
                const a = document.createElement('a');
                a.href = randomUrl; a.target = '_blank';
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
            }
        }

        // --- التحكم في إخفاء الأشرطة الزجاجية التلقائي ---
        let idleTimer;
        function resetIdleTimer() {
            container.classList.remove('idle');
            clearTimeout(idleTimer);
            if (!video.paused && settingsMenu.style.display !== 'block') {
                idleTimer = setTimeout(() => container.classList.add('idle'), 3000);
            }
        }
        container.addEventListener('mousemove', resetIdleTimer);
        container.addEventListener('touchmove', resetIdleTimer);
        container.addEventListener('touchstart', resetIdleTimer);

        // --- إيماءات التحكم (Gestures) عبر الفيديو ---
        let clickCount = 0;
        let singleClickTimer;
        
        function showCenterAction(type) {
            centerAction.innerHTML = type === 'play' 
                ? '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>' 
                : '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
            
            centerAction.classList.remove('animate-action');
            void centerAction.offsetWidth; 
            centerAction.classList.add('animate-action');
        }

        video.addEventListener('click', (e) => {
            triggerSmartAd();
            clickCount++;
            if (clickCount === 1) {
                singleClickTimer = setTimeout(() => { togglePlay(); clickCount = 0; }, 250); 
            } else if (clickCount === 2) {
                clearTimeout(singleClickTimer); toggleFullscreen(); clickCount = 0;
            }
        });

        // --- وظائف الأزرار ---
        function togglePlay() {
            if (video.paused) { video.play(); showCenterAction('play'); } 
            else { video.pause(); showCenterAction('pause'); }
        }

        playPauseBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
        
        video.addEventListener('play', () => { 
            document.getElementById('icon-play').style.display = 'none'; 
            document.getElementById('icon-pause').style.display = 'block';
            resetIdleTimer();
        });
        video.addEventListener('pause', () => { 
            document.getElementById('icon-pause').style.display = 'none'; 
            document.getElementById('icon-play').style.display = 'block';
            container.classList.remove('idle');
            clearTimeout(idleTimer);
        });

        function toggleFullscreen() {
            if (!document.fullscreenElement) { container.requestFullscreen?.() || container.webkitRequestFullscreen?.(); } 
            else { document.exitFullscreen?.() || document.webkitExitFullscreen?.(); }
        }
        fullscreenBtn.addEventListener('click', (e) => { e.stopPropagation(); triggerSmartAd(); toggleFullscreen(); });

        // --- قائمة الجودة ---
        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            settingsMenu.style.display = settingsMenu.style.display === 'block' ? 'none' : 'block';
            resetIdleTimer();
        });

        document.querySelectorAll('.quality-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const index = item.getAttribute('data-index');
                document.querySelectorAll('.quality-item').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                changeServer(index);
            });
        });

        window.addEventListener('click', (e) => {
            if (!settingsMenu.contains(e.target) && !settingsBtn.contains(e.target)) { settingsMenu.style.display = 'none'; }
        });

        // --- التضمين ---
        const embedModal = document.getElementById('embedModal');
        document.getElementById('embedBtn').addEventListener('click', (e) => { e.stopPropagation(); embedModal.style.display = 'flex'; });
        document.getElementById('closeEmbedModal').addEventListener('click', () => embedModal.style.display = 'none');
        document.getElementById('copyEmbedBtn').addEventListener('click', function() {
            document.getElementById('embedCodeArea').select(); document.execCommand('copy');
            this.innerText = 'تم النسخ بنجاح!'; setTimeout(() => this.innerText = 'نسخ الكود', 2000);
        });

        // --- HLS Logic ---
        function changeServer(index) {
            loadingOverlay.style.display = 'flex'; loadingOverlay.style.opacity = '1';
            settingsMenu.style.display = 'none';
            
            const manifestUrl = '/manifest/' + channelHash + '/' + index + '?token=' + encodeURIComponent(TOKEN);
            if (hls) { hls.destroy(); hls = null; }
            
            if (Hls.isSupported()) {
                hls = new Hls({ maxBufferLength: 30 }); 
                hls.loadSource(manifestUrl); hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    video.play().then(() => { loadingOverlay.style.opacity = '0'; setTimeout(()=>loadingOverlay.style.display='none',400); }).catch(e=>{});
                });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = manifestUrl; 
                video.addEventListener('loadedmetadata', () => {
                    video.play().then(() => { loadingOverlay.style.opacity = '0'; setTimeout(()=>loadingOverlay.style.display='none',400); }).catch(e=>{});
                });
            }
        }

        changeServer(0);
        setTimeout(() => location.reload(), 10 * 60 * 1000);
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
    <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@500;700;800&display=swap" rel="stylesheet">
    <style>
        body { margin: 0; background-color: #000; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: 'Tajawal', sans-serif; }
        .container { text-align: center; background: rgba(20, 20, 20, 0.65); backdrop-filter: blur(12px); padding: 40px; border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.1); width: 90%; max-width: 400px; box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3); }
        h2 { color: #fff; margin-bottom: 10px; font-size: 20px; }
        .reason { color: #ccc; font-size: 14px; margin-bottom: 25px; }
        .btn { display: inline-block; background: #e50914; color: #fff; padding: 12px 24px; text-decoration: none; font-weight: 700; border-radius: 10px; transition: 0.2s; }
        .btn:hover { background: #ff0f1a; transform: scale(1.05); }
    </style>
</head>
<body>
    <div class="container">
        <h2>البث غير متاح</h2>
        <div class="reason">${reasonMsg}</div>
        <a href="${CONFIG.MAIN_WEBSITE}" target="_blank" class="btn">العودة للموقع</a>
    </div>
</body>
</html>`;
}

app.listen(PORT, () => {
    console.log(`🚀 Pro Player is running on port ${PORT}`);
});
