const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

// 🌟 تحسين الاستقرار على استضافات مثل Render
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// ==========================================
// الإعدادات العامة 
// ==========================================
const CONFIG = {
    API_BASE_URL: 'https://s3-1nft.onrender.com/yacintv',
    CACHE_DURATION: 300000, 
    MANIFEST_CACHE: 2000,    
    SECRET_KEY: crypto.randomBytes(32).toString('hex'), 
    TOKEN_EXPIRY: 10 * 60 * 1000, // 10 دقائق
    LOGO_URL: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/React-icon.svg/120px-React-icon.svg.png',
    MAIN_WEBSITE: 'https://www.kirozozo.xyz/' 
};

// حماية الكود من التوقف المفاجئ
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
// فحص حالة القناة
// ==========================================
async function validateMatchStatus(realChannelName) {
    try {
        const matches = await CacheEngine.getOrFetch('matches_list', async () => {
            const res = await axios.get(`${CONFIG.API_BASE_URL}/mach`, { timeout: 5000 });
            return res.data;
        }, 60000);

        const channelId = `live_tv_${realChannelName}`;
        const targetMatch = matches.find(m => m.id_live === channelId || m.channel === channelId);

        if (!targetMatch) return { isAvailable: false, reason: 'المباراة غير مدرجة في جدول البث' };
        
        const channelField = targetMatch.channel || targetMatch.id_live;
        if (!channelField || channelField.trim() === '') {
            return { isAvailable: false, reason: 'لا توجد قناة بث متاحة لهذه المباراة حالياً' };
        }

        return { isAvailable: true };
    } catch (e) {
        return { isAvailable: true }; 
    }
}

// ==========================================
// دوال جلب البثوث والمانيفست
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
            
            let embedUrl = '';
            if (cleanChannel) {
                const hash = encodeId(cleanChannel);
                embedUrl = `${hostUrl}/play/${hash}`;
            }

            return { ...match, URl: embedUrl };
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

        const matchStatus = await validateMatchStatus(realChannel);
        if (!matchStatus.isAvailable) {
            return res.send(generateOfflineUI(matchStatus.reason));
        }

        const servers = await CacheEngine.getOrFetch(`servers_${realChannel}`, () => fetchChannelServers(realChannel), CONFIG.CACHE_DURATION);
        
        const userIp = getClientIp(req);
        const secureToken = generateSecureToken(userIp);
        const hostUrl = `${req.protocol}://${req.get('host')}`;
        
        res.send(generateUI(hash, servers, secureToken, realChannel, hostUrl)); 
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
        if (blockedAgents.some(agent => userAgent.includes(agent))) {
            return res.status(403).send('Access Denied');
        }

        const isFromMyHost = referer.includes(host);
        const isFromMainSite = referer.includes(mainHost);
        if (!isFromMyHost && !isFromMainSite) {
            return res.status(403).send('Access Denied');
        }

        const token = req.query.token;
        const userIp = getClientIp(req);
        if (!token || !verifySecureToken(token, userIp)) {
            return res.status(403).send('Invalid or Expired Token');
        }

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
// واجهات المستخدم (UI بتصميمك الفخم + التبديل التلقائي)
// ==========================================
function generateUI(channelHash, servers, secureToken, realChannel, hostUrl) {
    const totalServers = servers.length;
    const embedUrl = `${hostUrl}/play/${channelHash}`;

    // توليد عناصر السيرفرات ديناميكياً بناءً على الجلب الحقيقي
    const serverItemsHtml = servers.map((srv, idx) => `
        <div class="server-item ${idx === 0 ? 'active' : ''}" onclick="changeServer(${idx})">
            <div class="server-info">
                <span class="en">${srv.name}</span>
                <span class="ar" dir="rtl">السيرفر ${idx + 1}</span>
            </div>
            <svg class="check-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
            <svg class="signal-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 11c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 2c0-3.31-2.69-6-6-6s-6 2.69-6 6c0 2.22 1.21 4.15 3 5.19l1-1.74c-1.19-.7-2-1.97-2-3.45 0-2.21 1.79-4 4-4s4 1.79 4 4c0 1.48-.81 2.75-2 3.45l1 1.74c1.79-1.04 3-2.97 3-5.19zM12 3C6.48 3 2 7.48 2 13c0 3.7 2.01 6.92 4.99 8.65l1-1.73C5.61 18.53 4 15.96 4 13c0-4.42 3.58-8 8-8s8 3.58 8 8c0 2.96-1.61 5.53-3.99 6.92l1 1.73c2.98-1.73 4.99-4.95 4.99-8.65 0-5.52-4.48-10-10-10z"/></svg>
        </div>
    `).join('');

    return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Live Video Player Custom</title>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body, html { height: 100%; width: 100%; background-color: #000; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; overflow: hidden; display: flex; justify-content: center; align-items: center; }
        
        .player-container {
            position: relative;
            width: 100%;
            height: 100%;
            max-width: 1200px;
            max-height: 800px;
            background-image: url('https://i.ibb.co/Y8d0v7N/image-9.png');
            background-size: cover;
            background-position: center;
            background-repeat: no-repeat;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            align-items: center;
            padding: 40px 0;
        }

        #video {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            object-fit: contain;
            z-index: 2;
        }

        .player-container::after {
            content: ''; position: absolute; bottom: 0; left: 0; width: 100%; height: 30%;
            background: linear-gradient(to top, rgba(0,0,0,0.6), transparent); pointer-events: none; z-index: 3;
        }
        .player-container::before {
            content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 30%;
            background: linear-gradient(to bottom, rgba(0,0,0,0.6), transparent); pointer-events: none; z-index: 3;
        }

        .glass-bar {
            position: relative;
            z-index: 10;
            width: 85%;
            max-width: 800px;
            height: 60px;
            background: rgba(30, 32, 48, 0.75);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 24px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(255, 255, 255, 0.08);
        }

        .logo-text { color: #ffffff; font-size: 20px; font-weight: 700; letter-spacing: 0.5px; text-shadow: 0 2px 4px rgba(0,0,0,0.5); }
        .video-title { color: #e5e7eb; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60%; text-align: right; }

        .left-controls { display: flex; align-items: center; gap: 8px; width: 120px; }
        .live-dot { width: 8px; height: 8px; background-color: #ff3b30; border-radius: 50%; box-shadow: 0 0 8px rgba(255, 59, 48, 0.8); }
        .live-text { color: #ffffff; font-size: 13px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; }

        .center-controls { position: absolute; left: 50%; transform: translateX(-50%); display: flex; justify-content: center; align-items: center; }
        .play-pause-btn {
            width: 44px; height: 44px; background-color: #5c4dff; border: none; border-radius: 50%;
            display: flex; justify-content: center; align-items: center; cursor: pointer;
            transition: transform 0.1s ease, background-color 0.2s; box-shadow: 0 4px 12px rgba(92, 77, 255, 0.4);
        }
        .play-pause-btn:hover { transform: scale(1.05); background-color: #4a3be0; }
        .play-pause-icon { fill: #ffffff; width: 18px; height: 18px; }

        .right-controls { display: flex; align-items: center; gap: 20px; width: 150px; justify-content: flex-end; }
        .control-icon-btn { background: none; border: none; cursor: pointer; display: flex; justify-content: center; align-items: center; opacity: 0.8; transition: opacity 0.2s, transform 0.1s; }
        .control-icon-btn:hover { opacity: 1; transform: scale(1.1); }
        .icon-svg { fill: #d1d5db; width: 20px; height: 20px; }

        .server-popup {
            display: none; position: absolute; bottom: 110px; right: 12%; width: 280px;
            background: rgba(30, 32, 48, 0.95); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
            border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.1); color: white; z-index: 20; padding: 16px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
        }
        .server-popup::after {
            content: ''; position: absolute; bottom: -8px; right: 50px; border-width: 8px 8px 0; border-style: solid;
            border-color: rgba(30, 32, 48, 0.95) transparent transparent transparent;
        }
        .popup-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding-bottom: 10px; }
        .popup-title { display: flex; flex-direction: column; }
        .popup-title .en { font-size: 11px; color: #9ca3af; letter-spacing: 0.5px; text-transform: uppercase; }
        .popup-title .ar { font-size: 14px; font-weight: 600; margin-top: 2px; }
        .close-server-popup { background: none; border: none; color: #9ca3af; font-size: 20px; cursor: pointer; line-height: 1; }
        .close-server-popup:hover { color: #ffffff; }

        .server-list { display: flex; flex-direction: column; gap: 4px; }
        .server-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; border-radius: 8px; cursor: pointer; transition: background-color 0.2s; }
        .server-item:hover { background-color: rgba(255, 255, 255, 0.05); }
        .server-item.active { background-color: rgba(255, 255, 255, 0.15); }
        .server-info { display: flex; flex-direction: column; }
        .server-info .en { font-size: 13px; font-weight: 500; }
        .server-info .ar { font-size: 11px; color: #9ca3af; margin-top: 2px; }
        .server-item.active .server-info .en, .server-item.active .server-info .ar { color: #ffffff; }
        .check-icon { width: 18px; height: 18px; fill: #ffffff; display: none; }
        .signal-icon { width: 16px; height: 16px; fill: #9ca3af; }
        .server-item.active .check-icon { display: block; }
        .server-item.active .signal-icon { display: none; }

        .modal { display: none; position: fixed; z-index: 100; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.7); justify-content: center; align-items: center; backdrop-filter: blur(5px); }
        .modal-content { background-color: rgba(30, 32, 48, 0.9); border-radius: 12px; padding: 24px; width: 90%; max-width: 500px; border: 1px solid rgba(255, 255, 255, 0.1); color: white; display: flex; flex-direction: column; gap: 16px; }
        .modal-header { display: flex; justify-content: space-between; align-items: center; }
        .modal-header h2 { font-size: 18px; font-weight: 600; }
        .close-modal { background: none; border: none; color: #d1d5db; font-size: 20px; cursor: pointer; }
        #embedCodeArea { background-color: rgba(0,0,0,0.3); border: 1px solid rgba(255, 255, 255, 0.1); color: #a78bfa; font-family: monospace; padding: 12px; border-radius: 8px; resize: none; width: 100%; height: 100px; font-size: 12px; }
        #copyEmbedBtn { background-color: #5c4dff; color: white; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 14px; }
        #copyEmbedBtn:hover { background-color: #4a3be0; }
    </style>
</head>
<body>

    <div class="player-container">
        <!-- عنصر الفيديو الحقيقي -->
        <video id="video" playsinline webkit-playsinline autoplay></video>

        <!-- الشريط العلوي -->
        <div class="glass-bar title-bar">
            <div class="logo-text">YTPlus.com</div>
            <div class="video-title" dir="rtl">قناة: ${realChannel}</div>
        </div>
        
        <!-- قائمة السيرفرات المنبثقة -->
        <div id="serverPopup" class="server-popup">
            <div class="popup-header">
                <div class="popup-title">
                    <span class="en">STREAM SERVER SELECTION</span>
                    <span class="ar" dir="rtl">اختر الخادم للبث المباشر</span>
                </div>
                <button class="close-server-popup" id="closeServerPopup">&times;</button>
            </div>
            
            <div class="server-list">
                ${serverItemsHtml}
            </div>
        </div>
        
        <!-- الشريط السفلي للتحكم -->
        <div class="glass-bar controls-bar">
            <div class="left-controls">
                <div class="live-dot"></div>
                <span class="live-text">LIVE</span>
            </div>

            <div class="center-controls">
                <button class="play-pause-btn" id="playPauseBtn">
                    <svg class="play-pause-icon" id="pauseIcon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <rect x="6" y="4" width="4" height="16" rx="1"></rect>
                        <rect x="14" y="4" width="4" height="16" rx="1"></rect>
                    </svg>
                    <svg class="play-pause-icon" id="playIcon" style="display: none;" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path d="M8 5v14l11-7z" stroke-linejoin="round"></path>
                    </svg>
                </button>
            </div>

            <div class="right-controls">
                <button class="control-icon-btn" id="embedBtn" aria-label="Embed Code">
                    <svg class="icon-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                       <path d="M8.293 6.293a1 1 0 0 1 1.414 0L14.414 11H19a1 1 0 0 1 0 2h-4.586l-4.707 4.707a1 1 0 0 1-1.414-1.414L11.586 13H5a1 1 0 0 1 0-2h6.586L8.293 7.707a1 1 0 0 1 0-1.414z" />
                       <path d="M19 19a1 1 0 1 1-2 0V5a1 1 0 0 1 2 0v14z" />
                    </svg>
                </button>

                <button class="control-icon-btn" id="settingsBtn" aria-label="Server Settings">
                    <svg class="icon-svg settings-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
                    </svg>
                </button>

                <button class="control-icon-btn" id="fullscreenBtn" aria-label="Fullscreen">
                    <svg class="icon-svg fullscreen-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
                    </svg>
                </button>
            </div>
        </div>
    </div>

    <!-- Embed Code Modal -->
    <div id="embedModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>Embed Code / كود التضمين</h2>
                <button class="close-modal" id="closeEmbedModal">&times;</button>
            </div>
            <p>Copy the code below to embed this stream:</p>
            <textarea id="embedCodeArea" readonly><iframe src="${embedUrl}" width="640" height="360" frameborder="0" allowfullscreen></iframe></textarea>
            <button id="copyEmbedBtn">Copy Code / نسخ الكود</button>
        </div>
    </div>

    <script>
        const video = document.getElementById('video');
        let hls = null;
        const TOKEN = '${secureToken}';
        const channelHash = '${channelHash}';
        let currentServerIndex = 0;
        const totalServers = ${totalServers};

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

        // دالة تشغيل السيرفرات مع نظام التبديل التلقائي (Auto-Failover)
        function changeServer(serverIndex) {
            currentServerIndex = parseInt(serverIndex);
            
            // تحديث الشكل البصري للقائمة
            const items = document.querySelectorAll('.server-item');
            items.forEach((item, idx) => {
                if (idx === currentServerIndex) {
                    item.classList.add('active');
                } else {
                    item.classList.remove('active');
                }
            });

            const manifestUrl = '/manifest/' + channelHash + '/' + currentServerIndex + '?token=' + encodeURIComponent(TOKEN);
            if (hls) { hls.destroy(); hls = null; }
            
            if (Hls.isSupported()) {
                hls = new Hls(); 
                hls.loadSource(manifestUrl); 
                hls.attachMedia(video);
                
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    video.play().then(() => {
                        isPlaying = true;
                        updatePlayPauseUI();
                    }).catch(() => {});
                });

                // 🌟 نظام التقاط الأخطاء والتبديل التلقائي للسيرفر الموالي
                hls.on(Hls.Events.ERROR, function (event, data) {
                    if (data.fatal) {
                        switch (data.type) {
                            case Hls.ErrorTypes.NETWORK_ERROR:
                            case Hls.ErrorTypes.MEDIA_ERROR:
                                console.log('Server failed, switching to next server automatically...');
                                let nextServer = (currentServerIndex + 1) % totalServers;
                                changeServer(nextServer);
                                break;
                            default:
                                hls.destroy();
                                break;
                        }
                    }
                });

            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = manifestUrl; 
                video.addEventListener('loadedmetadata', () => {
                    video.play().then(() => {
                        isPlaying = true;
                        updatePlayPauseUI();
                    }).catch(() => {});
                });
            }

            serverPopup.style.display = 'none';
        }

        // تشغيل البث الأول افتراضياً
        changeServer(0);

        // Play / Pause Logic
        playPauseBtn.addEventListener('click', () => {
            if (video.paused) {
                video.play();
            } else {
                video.pause();
            }
        });

        video.addEventListener('play', () => {
            isPlaying = true;
            updatePlayPauseUI();
        });

        video.addEventListener('pause', () => {
            isPlaying = false;
            updatePlayPauseUI();
        });

        function updatePlayPauseUI() {
            if (isPlaying) {
                pauseIcon.style.display = 'block';
                playIcon.style.display = 'none';
            } else {
                pauseIcon.style.display = 'none';
                playIcon.style.display = 'block';
            }
        }

        // Fullscreen Logic
        fullscreenBtn.addEventListener('click', () => {
            const container = document.querySelector('.player-container');
            if (!document.fullscreenElement) {
                if (container.requestFullscreen) { container.requestFullscreen(); }
                else if (container.webkitRequestFullscreen) { container.webkitRequestFullscreen(); }
            } else {
                if (document.exitFullscreen) { document.exitFullscreen(); }
            }
        });

        // Settings Icon Logic (Toggle Server Popup)
        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation(); 
            serverPopup.style.display = serverPopup.style.display === 'block' ? 'none' : 'block';
        });

        closeServerPopup.addEventListener('click', () => {
            serverPopup.style.display = 'none';
        });

        // Embed Modal Logic
        embedBtn.addEventListener('click', () => { embedModal.style.display = 'flex'; });
        closeEmbedModal.addEventListener('click', () => { embedModal.style.display = 'none'; });

        copyEmbedBtn.addEventListener('click', () => {
            embedCodeArea.select();
            document.execCommand('copy');
            alert('تم نسخ كود التضمين!');
            embedModal.style.display = 'none';
        });

        // إغلاق النوافذ عند النقر خارجها
        window.addEventListener('click', (event) => {
            if (event.target == embedModal) { embedModal.style.display = 'none'; }
            if (serverPopup.style.display === 'block' && 
                !serverPopup.contains(event.target) && 
                event.target !== settingsBtn && 
                !settingsBtn.contains(event.target)) {
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
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>البث غير متوفر</title>
    <style>
        body { margin: 0; padding: 0; background-color: #0d2741; display: flex; justify-content: center; align-items: center; height: 100vh; font-family: Arial, sans-serif; }
        .container { text-align: center; background: rgba(0,0,0,0.5); padding: 40px; border-radius: 15px; border: 2px solid #FFD700; box-shadow: 0 0 20px rgba(255, 215, 0, 0.2); width: 80%; max-width: 500px; }
        h2 { color: #fff; margin-bottom: 20px; font-size: 24px; }
        .reason { color: #FFD700; font-size: 18px; margin-bottom: 30px; font-weight: bold; }
        .btn { display: inline-block; background: #FFD700; color: #0d2741; padding: 12px 30px; text-decoration: none; font-size: 18px; font-weight: bold; border-radius: 50px; transition: transform 0.2s; }
        .btn:hover { transform: scale(1.05); }
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
    console.log(`🚀 Pro Bulletproof Server with Custom Glass UI running on port ${PORT}`);
});
