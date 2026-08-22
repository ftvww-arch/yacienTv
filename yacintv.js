const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

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

setInterval(() => {
    const now = Date.now();
    for (const [key, value] of CacheEngine.memory.entries()) {
        if (now > value.expiresAt) CacheEngine.memory.delete(key);
    }
}, 30000);

// ==========================================
// جلب معلومات المباراة وعنوانها
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

// ==========================================
// جلب السيرفرات والمانيفست
// ==========================================
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
// المسارات (Routes)
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
            
            // استبعاد id_live و channel نهائياً من البيانات المرسلة للعميل
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

app.get('/ping', (req, res) => res.send('Pong! Server is awake.'));

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
        const userAgent = (req.headers['user-agent'] || '').toLowerCase();
        const referer = (req.headers['referer'] || req.headers['origin'] || '').toLowerCase();
        const host = req.get('host') || '';
        const mainHost = new URL(CONFIG.MAIN_WEBSITE).hostname;

        const blockedAgents = ['vlc', 'mpv', 'potplayer', 'iptv', 'smartiptv', 'libvlc', 'python', 'axios', 'curl', 'postman', 'java', 'okhttp', 'wget', 'exoplayer'];
        if (blockedAgents.some(agent => userAgent.includes(agent))) return res.status(403).send('Access Denied');
        if (!referer.includes(host) && !referer.includes(mainHost)) return res.status(403).send('Access Denied');

        const token = req.query.token;
        const userIp = getClientIp(req);
        if (!token || !verifySecureToken(token, userIp)) return res.status(403).send('Invalid or Expired Token');

        const { hash, serverIndex } = req.params;
        const realChannel = decodeId(hash);
        const cacheKey = `manifest_${realChannel}_${serverIndex}`;
        const servers = await CacheEngine.getOrFetch(`servers_${realChannel}`, () => fetchChannelServers(realChannel), CONFIG.CACHE_DURATION);
        const serverInfo = servers[parseInt(serverIndex)];
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
// الواجهة الديناميكية النهائية (مع الإعلانات الذكية والتحديث التلقائي)
// ==========================================
function generateUI(channelHash, servers, secureToken, matchTitle, hostUrl) {
    const totalServers = servers.length;
    const embedUrl = `${hostUrl}/play/${channelHash}`;

    const serverItemsHtml = servers.map((srv, idx) => `
        <div class="server-item ${idx === 0 ? 'active' : ''}" onclick="changeServer(${idx})">
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
        
        .player-container {
            position: relative;
            width: 100%;
            height: 100%;
            max-width: 1200px;
            max-height: 800px;
            background-color: #000;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            align-items: center;
            padding: 25px 0;
            cursor: default;
            user-select: none;
            -webkit-user-select: none;
        }

        /* شاشة التحميل */
        .loading-overlay {
            position: absolute;
            top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0, 0, 0, 0.85);
            backdrop-filter: blur(10px);
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            z-index: 25;
            transition: opacity 0.4s ease;
        }
        .spinner {
            width: 50px; height: 50px;
            border: 4px solid rgba(255, 255, 255, 0.1);
            border-top: 4px solid #5c4dff;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            margin-bottom: 12px;
        }
        .loading-text { color: #fff; font-size: 15px; font-weight: 500; letter-spacing: 0.5px; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

        #video {
            position: absolute;
            top: 0; left: 0; width: 100%; height: 100%;
            object-fit: contain;
            z-index: 2;
        }

        /* الأشرطة العلوية والسفلية */
        .glass-bar.title-bar { width: 95%; max-width: 980px; }
        .glass-bar.controls-bar { width: 86%; max-width: 820px; }

        .glass-bar {
            position: relative;
            z-index: 10;
            height: 58px;
            background: rgba(20, 22, 32, 0.78);
            backdrop-filter: blur(14px);
            -webkit-backdrop-filter: blur(14px);
            border-radius: 14px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 24px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            border: 1px solid rgba(255, 255, 255, 0.08);
            transition: opacity 0.4s ease, transform 0.4s ease;
        }

        .player-container.hide-ui .glass-bar,
        .player-container.hide-ui .server-popup {
            opacity: 0;
            pointer-events: none;
            transform: translateY(10px);
        }
        .player-container.hide-ui { cursor: none; }

        .logo-text { color: #ffffff; font-size: 17px; font-weight: 700; text-decoration: none; transition: opacity 0.2s; letter-spacing: 0.5px; }
        .logo-text:hover { opacity: 0.8; }
        
        .video-title { color: #e5e7eb; font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 65%; text-align: right; }

        .left-controls { display: flex; align-items: center; gap: 8px; width: 100px; }
        .live-dot { width: 8px; height: 8px; background-color: #ff3b30; border-radius: 50%; box-shadow: 0 0 8px rgba(255, 59, 48, 0.8); }
        .live-text { color: #ffffff; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }

        .center-controls { position: absolute; left: 50%; transform: translateX(-50%); display: flex; justify-content: center; align-items: center; }
        .play-pause-btn {
            width: 44px; height: 44px; background-color: #5c4dff; border: none; border-radius: 50%;
            display: flex; justify-content: center; align-items: center; cursor: pointer;
            transition: transform 0.2s ease, background-color 0.2s; box-shadow: 0 4px 12px rgba(92, 77, 255, 0.4);
        }
        .play-pause-btn:hover { transform: scale(1.1); background-color: #4a3be0; }
        .play-pause-icon { fill: #ffffff; width: 18px; height: 18px; }

        .right-controls { display: flex; align-items: center; gap: 18px; width: 130px; justify-content: flex-end; }
        .control-icon-btn { background: none; border: none; cursor: pointer; display: flex; justify-content: center; align-items: center; opacity: 0.8; transition: opacity 0.2s, transform 0.2s; }
        .control-icon-btn:hover { opacity: 1; transform: scale(1.1); }
        .icon-svg { fill: #d1d5db; width: 20px; height: 20px; }

        /* نافذة السيرفرات وسط الشاشة */
        .server-popup {
            display: none; 
            position: fixed; 
            top: 50%; 
            left: 50%; 
            transform: translate(-50%, -50%); 
            width: 90%;
            max-width: 340px;
            background: rgba(20, 22, 35, 0.96); 
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border-radius: 16px; 
            border: 1px solid rgba(255, 255, 255, 0.12); 
            color: white; 
            z-index: 100; 
            padding: 20px;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.8);
            transition: opacity 0.3s ease, transform 0.3s ease;
        }
        .popup-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding-bottom: 10px; }
        .popup-title { display: flex; flex-direction: column; }
        .popup-title .en { font-size: 11px; color: #9ca3af; text-transform: uppercase; font-weight: 500; }
        .popup-title .ar { font-size: 14px; font-weight: 700; margin-top: 2px; }
        .close-server-popup { background: none; border: none; color: #9ca3af; font-size: 20px; cursor: pointer; }
        .close-server-popup:hover { color: #ffffff; }

        .server-list { display: flex; flex-direction: column; gap: 6px; max-height: 250px; overflow-y: auto; }
        .server-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-radius: 10px; cursor: pointer; transition: background-color 0.2s; }
        .server-item:hover { background-color: rgba(255, 255, 255, 0.08); }
        .server-item.active { background-color: rgba(92, 77, 255, 0.3); border: 1px solid rgba(92, 77, 255, 0.4); }
        .server-info { display: flex; flex-direction: column; }
        .server-info .en { font-size: 13px; font-weight: 500; }
        .server-info .ar { font-size: 12px; color: #9ca3af; margin-top: 2px; font-weight: 500; }
        .server-item.active .server-info .en, .server-item.active .server-info .ar { color: #ffffff; }
        .check-icon { width: 18px; height: 18px; fill: #5c4dff; display: none; }
        .signal-icon { width: 16px; height: 16px; fill: #9ca3af; }
        .server-item.active .check-icon { display: block; }
        .server-item.active .signal-icon { display: none; }

        .modal { display: none; position: fixed; z-index: 150; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.8); justify-content: center; align-items: center; backdrop-filter: blur(8px); }
        .modal-content { background-color: rgba(25, 27, 40, 0.95); border-radius: 16px; padding: 24px; width: 90%; max-width: 500px; border: 1px solid rgba(255, 255, 255, 0.1); color: white; display: flex; flex-direction: column; gap: 16px; }
        .modal-header { display: flex; justify-content: space-between; align-items: center; }
        .modal-header h2 { font-size: 18px; font-weight: 700; }
        .close-modal { background: none; border: none; color: #d1d5db; font-size: 22px; cursor: pointer; }
        #embedCodeArea { background-color: rgba(0,0,0,0.4); border: 1px solid rgba(255, 255, 255, 0.1); color: #a78bfa; font-family: monospace; padding: 12px; border-radius: 8px; resize: none; width: 100%; height: 100px; font-size: 12px; }
        #copyEmbedBtn { background-color: #5c4dff; color: white; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 14px; transition: background-color 0.2s; }
        #copyEmbedBtn:hover { background-color: #4a3be0; }

        @media (max-width: 768px) {
            .glass-bar.title-bar { width: 96%; padding: 0 16px; }
            .glass-bar.controls-bar { width: 92%; padding: 0 16px; }
            .video-title { font-size: 13px; max-width: 50%; }
        }
    </style>
</head>
<body>

    <div class="player-container" id="playerContainer">
        <!-- شاشة التحميل -->
        <div id="loadingOverlay" class="loading-overlay">
            <div class="spinner"></div>
            <div class="loading-text">جاري تحميل البث المباشر...</div>
        </div>

        <video id="video" playsinline webkit-playsinline autoplay></video>

        <div class="glass-bar title-bar">
            <a href="${CONFIG.MAIN_WEBSITE}" target="_blank" class="logo-text">YTPlus.com</a>
            <div class="video-title" dir="rtl">${matchTitle}</div>
        </div>
        
        <div id="serverPopup" class="server-popup">
            <div class="popup-header">
                <div class="popup-title">
                    <span class="en">STREAM SERVER SELECTION</span>
                    <span class="ar" dir="rtl">اختر الخادم للبث المباشر</span>
                </div>
                <button class="close-server-popup" id="closeServerPopup">&times;</button>
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
                <button class="control-icon-btn" id="embedBtn"><svg class="icon-svg" viewBox="0 0 24 24"><path d="M8.293 6.293a1 1 0 0 1 1.414 0L14.414 11H19a1 1 0 0 1 0 2h-4.586l-4.707 4.707a1 1 0 0 1-1.414-1.414L11.586 13H5a1 1 0 0 1 0-2h6.586L8.293 7.707a1 1 0 0 1 0-1.414z"/><path d="M19 19a1 1 0 1 1-2 0V5a1 1 0 0 1 2 0v14z"/></svg></button>
                <button class="control-icon-btn" id="settingsBtn"><svg class="icon-svg" viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg></button>
                <button class="control-icon-btn" id="fullscreenBtn"><svg class="icon-svg" viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg></button>
            </div>
        </div>
    </div>

    <div id="embedModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>Embed Code / كود التضمين</h2>
                <button class="close-modal" id="closeEmbedModal">&times;</button>
            </div>
            <textarea id="embedCodeArea" readonly><iframe src="${embedUrl}" width="640" height="360" frameborder="0" allowfullscreen></iframe></textarea>
            <button id="copyEmbedBtn">Copy Code / نسخ الكود</button>
        </div>
    </div>

    <script>
        const video = document.getElementById('video');
        const playerContainer = document.getElementById('playerContainer');
        const loadingOverlay = document.getElementById('loadingOverlay');
        let hls = null;
        const TOKEN = '${secureToken}';
        const channelHash = '${channelHash}';
        let currentServerIndex = 0;
        const totalServers = ${totalServers};

       // نظام الإعلانات الذكية المحسّن (لتجاوز حظر النوافذ المنبثقة)
        const smartLinks = [
            'https://omg10.com/4/7056731',
            'https://omg10.com/4/7056731'
        ];
        let adOpened = false;

        function triggerSmartAd() {
            if (!adOpened) {
                adOpened = true;
                const randomUrl = smartLinks[Math.floor(Math.random() * smartLinks.length)];
                
                // إنشاء عنصر رابط وهمي ومحاكاة نقرة حقيقية لتجنب حظر المتصفح
                const anchor = document.createElement('a');
                anchor.href = randomUrl;
                anchor.target = '_blank';
                anchor.rel = 'noopener noreferrer';
                document.body.appendChild(anchor);
                anchor.click();
                document.body.removeChild(anchor);
            }
        }

        // إعادة تحميل الصفحة كل 10 دقائق لتحديث البث وتوفير موارد السيرفر
        setTimeout(() => {
            location.reload();
        }, 10 * 60 * 1000);

        const playPauseBtn = document.getElementById('playPauseBtn');
        const pauseIcon = document.getElementById('pauseIcon');
        const playIcon = document.getElementById('playIcon');
        const embedBtn = document.getElementById('embedBtn');
        const embedModal = document.getElementById('embedModal');
        const closeEmbedModal = document.getElementById('closeEmbedModal');
        const embedCodeArea = document.getElementById('embedCodeArea');
        const copyEmbedBtn = document.getElementById('copyEmbedBtn');
        const settingsBtn = document.getElementById('settingsBtn');
        const serverPopup = document.getElementById('serverPopup');
        const closeServerPopup = document.getElementById('closeServerPopup');
        const fullscreenBtn = document.getElementById('fullscreenBtn');

        let isPlaying = true;
        let inactivityTimeout;

        function resetInactivityTimer() {
            playerContainer.classList.remove('hide-ui');
            clearTimeout(inactivityTimeout);
            inactivityTimeout = setTimeout(() => {
                if (!video.paused && serverPopup.style.display !== 'block') {
                    playerContainer.classList.add('hide-ui');
                }
            }, 3000);
        }

        playerContainer.addEventListener('mousemove', resetInactivityTimer);

        function toggleFullscreen() {
            if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                if (playerContainer.requestFullscreen) {
                    playerContainer.requestFullscreen();
                } else if (playerContainer.webkitRequestFullscreen) {
                    playerContainer.webkitRequestFullscreen();
                } else if (video.webkitEnterFullscreen) {
                    video.webkitEnterFullscreen();
                }
            } else {
                if (document.exitFullscreen) {
                    document.exitFullscreen();
                } else if (document.webkitExitFullscreen) {
                    document.webkitExitFullscreen();
                }
            }
        }

        // إيماءات التفاعل (تشغيل الإعلان العشوائي عند أول تفاعل ونقرة)
        let clickCount = 0;
        let clickTimer = null;

        playerContainer.addEventListener('click', (e) => {
            if (e.target.closest('.glass-bar') || e.target.closest('.server-popup') || e.target.closest('.modal')) return;

            triggerSmartAd(); // فتح الإعلان الذكي عند النقر الأول

            clickCount++;
            if (clickCount === 1) {
                clickTimer = setTimeout(() => {
                    if (video.paused) video.play();
                    else video.pause();
                    clickCount = 0;
                }, 250);
            } else if (clickCount === 2) {
                clearTimeout(clickTimer);
                toggleFullscreen();
                clickCount = 0;
            }
        });

        let lastTouchTime = 0;
        playerContainer.addEventListener('touchend', (e) => {
            if (e.target.closest('.glass-bar') || e.target.closest('.server-popup') || e.target.closest('.modal')) return;

            triggerSmartAd(); // فتح الإعلان الذكي عند اللمس الأول

            const currentTime = new Date().getTime();
            const tapLength = currentTime - lastTouchTime;

            if (tapLength < 300 && tapLength > 0) {
                e.preventDefault();
                toggleFullscreen();
                lastTouchTime = 0;
            } else {
                lastTouchTime = currentTime;
                if (playerContainer.classList.contains('hide-ui')) {
                    playerContainer.classList.remove('hide-ui');
                    resetInactivityTimer();
                }
            }
        });

        function showLoading() {
            loadingOverlay.style.opacity = '1';
            loadingOverlay.style.pointerEvents = 'auto';
        }

        function hideLoading() {
            loadingOverlay.style.opacity = '0';
            loadingOverlay.style.pointerEvents = 'none';
        }

        function changeServer(serverIndex) {
            showLoading();
            currentServerIndex = parseInt(serverIndex);
            
            document.querySelectorAll('.server-item').forEach((item, idx) => {
                if (idx === currentServerIndex) item.classList.add('active');
                else item.classList.remove('active');
            });

            const manifestUrl = '/manifest/' + channelHash + '/' + currentServerIndex + '?token=' + encodeURIComponent(TOKEN);
            if (hls) { hls.destroy(); hls = null; }
            
            if (Hls.isSupported()) {
                hls = new Hls(); 
                hls.loadSource(manifestUrl); 
                hls.attachMedia(video);
                
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    video.play().then(() => {
                        hideLoading();
                        isPlaying = true;
                        updatePlayPauseUI();
                    }).catch(() => { hideLoading(); });
                });

                hls.on(Hls.Events.ERROR, function (event, data) {
                    if (data.fatal && !video.paused) {
                        switch (data.type) {
                            case Hls.ErrorTypes.NETWORK_ERROR:
                            case Hls.ErrorTypes.MEDIA_ERROR:
                                let nextServer = (currentServerIndex + 1) % totalServers;
                                if (nextServer !== currentServerIndex) {
                                    changeServer(nextServer);
                                }
                                break;
                            default:
                                hls.destroy();
                                hideLoading();
                                break;
                        }
                    }
                });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = manifestUrl; 
                video.addEventListener('loadedmetadata', () => {
                    video.play().then(() => {
                        hideLoading();
                        isPlaying = true;
                        updatePlayPauseUI();
                    }).catch(() => { hideLoading(); });
                });
            }
            serverPopup.style.display = 'none';
        }

        changeServer(0);

        playPauseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            triggerSmartAd();
            if (video.paused) video.play();
            else video.pause();
        });

        video.addEventListener('play', () => { isPlaying = true; updatePlayPauseUI(); resetInactivityTimer(); });
        video.addEventListener('pause', () => { isPlaying = false; updatePlayPauseUI(); playerContainer.classList.remove('hide-ui'); clearTimeout(inactivityTimeout); });

        function updatePlayPauseUI() {
            if (isPlaying) {
                pauseIcon.style.display = 'block';
                playIcon.style.display = 'none';
            } else {
                pauseIcon.style.display = 'none';
                playIcon.style.display = 'block';
            }
        }

        fullscreenBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            triggerSmartAd();
            toggleFullscreen();
        });

        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation(); 
            serverPopup.style.display = serverPopup.style.display === 'block' ? 'none' : 'block';
        });

        closeServerPopup.addEventListener('click', () => { serverPopup.style.display = 'none'; });

        embedBtn.addEventListener('click', () => { embedModal.style.display = 'flex'; });
        closeEmbedModal.addEventListener('click', () => { embedModal.style.display = 'none'; });

        copyEmbedBtn.addEventListener('click', () => {
            embedCodeArea.select();
            document.execCommand('copy');
            alert('تم نسخ كود التضمين!');
            embedModal.style.display = 'none';
        });

        window.addEventListener('click', (event) => {
            if (event.target == embedModal) embedModal.style.display = 'none';
            if (serverPopup.style.display === 'block' && !serverPopup.contains(event.target) && event.target !== settingsBtn && !settingsBtn.contains(event.target)) {
                serverPopup.style.display = 'none';
            }
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
    <link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
    <style>
        body { margin: 0; padding: 0; background-color: #0b0c10; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: 'Tajawal', sans-serif; }
        .container { text-align: center; background: rgba(20,22,35,0.85); backdrop-filter: blur(10px); padding: 40px; border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.1); box-shadow: 0 10px 30px rgba(0,0,0,0.5); width: 85%; max-width: 450px; }
        h2 { color: #fff; margin-bottom: 15px; font-size: 22px; font-weight: 700; }
        .reason { color: #f59e0b; font-size: 16px; margin-bottom: 25px; font-weight: 500; }
        .btn { display: inline-block; background: #5c4dff; color: #fff; padding: 12px 28px; text-decoration: none; font-size: 16px; font-weight: 700; border-radius: 50px; transition: transform 0.2s, background-color 0.2s; }
        .btn:hover { transform: scale(1.05); background-color: #4a3be0; }
    </style>
</head>
<body>
    <div class="container">
        <h2>عفواً، لا يوجد بث متاح</h2>
        <div class="reason">${reasonMsg}</div>
        <a href="${CONFIG.MAIN_WEBSITE}" target="_blank" class="btn">العودة للموقع الرسمي</a>
    </div>
</body>
</html>`;
}

app.listen(PORT, () => {
    console.log(`🚀 Monetized & Optimized Ultimate Player running on port ${PORT}`);
});
