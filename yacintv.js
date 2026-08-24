const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const CONFIG = {
    MAIN_WEBSITE: 'https://ytplus.com',
    SECRET_KEY: 'yacine_tv_secret_key_pro_2026',
    CACHE_DURATION: 10 * 60 * 1000, // 10 دقائق
    MANIFEST_CACHE: 4 * 1000        // 4 ثوانٍ للبث المباشر
};

// ==========================================
// محرك التخزين المؤقت (Cache Engine)
// ==========================================
const CacheEngine = {
    store: new Map(),
    async getOrFetch(key, fetchFn, ttl) {
        const now = Date.now();
        if (this.store.has(key)) {
            const cached = this.store.get(key);
            if (now < cached.expiry) return cached.data;
        }
        const freshData = await fetchFn();
        if (freshData) {
            this.store.set(key, { data: freshData, expiry: now + ttl });
        }
        return freshData;
    }
};

// ==========================================
// أدوات الأمان والتشفير (Security Helpers)
// ==========================================
function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '';
}

function generateSecureToken(ip) {
    const timeWindow = Math.floor(Date.now() / (1000 * 60 * 10));
    return crypto.createHmac('sha256', CONFIG.SECRET_KEY).update(`${ip}_${timeWindow}`).digest('hex');
}

function verifySecureToken(token, ip) {
    const currentToken = generateSecureToken(ip);
    const prevTimeWindow = Math.floor((Date.now() - 1000 * 60 * 10) / (1000 * 60 * 10));
    const prevToken = crypto.createHmac('sha256', CONFIG.SECRET_KEY).update(`${ip}_${prevTimeWindow}`).digest('hex');
    return token === currentToken || token === prevToken;
}

function encodeId(id) {
    return Buffer.from(id.toString()).toString('base64').replace(/=/g, '');
}

function decodeId(encoded) {
    return Buffer.from(encoded, 'base64').toString('ascii');
}

// ==========================================
// تحويل المسارات النسبية داخل m3u8 لروابط كاملة
// ==========================================
function convertManifestToAbsolute(manifestText, baseUrl) {
    if (!manifestText || typeof manifestText !== 'string') return manifestText;
    return manifestText.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            try {
                return new URL(trimmed, baseUrl).href;
            } catch (e) {
                return trimmed;
            }
        }
        return line;
    }).join('\n');
}

// ==========================================
// جلب خوادم البث المباشر والمانيفست
// ==========================================
async function fetchChannelServers(realChannel) {
    try {
        // يمكنك ربط هذه الدالة بمصدر جلب السيرفرات الخاص بك
        return [
            { name: 'Server 1 (FHD)', url: `https://xameleon.phantemlis.top/four/secure/be694e665d6767814a06d933abb82aaf/1787574267/premium91/index.m3u8` },
            { name: 'Server 2 (HD)', url: `https://xameleon.phantemlis.top/four/secure/be694e665d6767814a06d933abb82aaf/1787574267/premium91/tracks-v1a1/mono.m3u8` }
        ];
    } catch (e) {
        return [];
    }
}

async function fetchManifest(serverInfo) {
    const targetUrl = typeof serverInfo === 'string' ? serverInfo : (serverInfo.url || serverInfo);
    const response = await axios.get(targetUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Referer': 'https://xameleon.phantemlis.top/'
        },
        timeout: 8000
    });
    return response.data;
}

// ==========================================
// المسارات (Routes)
// ==========================================

// 1. مسار المشغل الرئيسي
app.get('/play/:channelHash', async (req, res) => {
    try {
        const { channelHash } = req.params;
        const realChannel = decodeId(channelHash);
        const userIp = getClientIp(req);
        const secureToken = generateSecureToken(userIp);
        const hostUrl = `${req.protocol}://${req.get('host')}`;

        const servers = await CacheEngine.getOrFetch(
            `servers_${realChannel}`,
            () => fetchChannelServers(realChannel),
            CONFIG.CACHE_DURATION
        );

        if (!servers || servers.length === 0) {
            return res.status(404).send('Channel or Stream Not Found');
        }

        const matchTitle = `بث مباشر - قناة ${realChannel}`;
        const html = generateUI(channelHash, servers, secureToken, matchTitle, hostUrl);
        
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        res.status(500).send('Server Error');
    }
});

// 2. مسار جلب ملف المانيفست المباشر
app.get('/manifest/:hash/:serverIndex', async (req, res) => {
    try {
        const userAgent = (req.headers['user-agent'] || '').toLowerCase();
        const referer = (req.headers['referer'] || req.headers['origin'] || '').toLowerCase();
        const host = req.get('host') || '';
        const mainHost = new URL(CONFIG.MAIN_WEBSITE).hostname;

        // حظر السكربتات والبوتات
        const blockedAgents = ['vlc', 'mpv', 'potplayer', 'iptv', 'smartiptv', 'libvlc', 'python', 'axios', 'curl', 'postman', 'java', 'okhttp', 'wget', 'exoplayer', 'bot', 'crawler', 'spider', 'googlebot', 'bingbot'];
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

        const manifestData = await CacheEngine.getOrFetch(cacheKey, async () => {
            const rawManifest = await fetchManifest(serverInfo);
            const targetUrl = typeof serverInfo === 'string' ? serverInfo : (serverInfo.url || serverInfo);
            return convertManifestToAbsolute(rawManifest, targetUrl);
        }, CONFIG.MANIFEST_CACHE);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.send(manifestData);
    } catch (error) {
        res.status(500).send('Manifest Error');
    }
});

// 3. مسار تجديد التوكن
app.get('/api/refresh-token', (req, res) => {
    const userIp = getClientIp(req);
    const token = generateSecureToken(userIp);
    res.json({ token });
});

// ==========================================
// الواجهة الديناميكية للمشغل (UI Generator)
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
    <script src="https://cdn.jsdelivr.net/npm/fzstd/umd/index.js"></script>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body, html { height: 100%; width: 100%; background-color: #000; font-family: 'Tajawal', sans-serif; overflow: hidden; display: flex; justify-content: center; align-items: center; }
        .player-container { position: relative; width: 100%; height: 100%; max-width: 1200px; max-height: 800px; background-color: #000; overflow: hidden; cursor: default; user-select: none; }
        .loading-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.85); backdrop-filter: blur(10px); display: flex; flex-direction: column; justify-content: center; align-items: center; z-index: 25; transition: opacity 0.4s ease; }
        .spinner { width: 50px; height: 50px; border: 4px solid rgba(255, 255, 255, 0.1); border-top: 4px solid #5c4dff; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 12px; }
        .loading-text { color: #fff; font-size: 15px; font-weight: 500; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        #video { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain; z-index: 2; }
        .glass-bar { position: absolute; left: 50%; transform: translateX(-50%); z-index: 10; height: 58px; background: rgba(20, 22, 32, 0.78); backdrop-filter: blur(14px); border-radius: 14px; display: flex; align-items: center; justify-content: space-between; padding: 0 24px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5); border: 1px solid rgba(255, 255, 255, 0.08); transition: opacity 0.4s ease, transform 0.4s ease; }
        .glass-bar.title-bar { width: 95%; max-width: 980px; height: 68px; top: 25px; }
        .glass-bar.controls-bar { width: 86%; max-width: 820px; bottom: 25px; }
        .player-container.hide-ui { cursor: none; }
        .player-container.hide-ui .glass-bar { opacity: 0; pointer-events: none; }
        .player-container.hide-ui .glass-bar.title-bar { transform: translate(-50%, -15px); }
        .player-container.hide-ui .glass-bar.controls-bar { transform: translate(-50%, 15px); }
        .logo-text { color: #ffffff; font-size: 17px; font-weight: 700; text-decoration: none; }
        .video-title { color: #e5e7eb; font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 65%; }
        .left-controls { display: flex; align-items: center; gap: 8px; width: 100px; }
        .live-dot { width: 8px; height: 8px; background-color: #ff3b30; border-radius: 50%; box-shadow: 0 0 8px rgba(255, 59, 48, 0.8); }
        .live-text { color: #ffffff; font-size: 13px; font-weight: 700; }
        .center-controls { position: absolute; left: 50%; transform: translateX(-50%); display: flex; justify-content: center; align-items: center; }
        .play-pause-btn { width: 44px; height: 44px; background-color: #5c4dff; border: none; border-radius: 50%; display: flex; justify-content: center; align-items: center; cursor: pointer; transition: transform 0.2s; box-shadow: 0 4px 12px rgba(92, 77, 255, 0.4); }
        .play-pause-btn:hover { transform: scale(1.1); background-color: #4a3be0; }
        .play-pause-icon { fill: #ffffff; width: 18px; height: 18px; }
        .right-controls { display: flex; align-items: center; gap: 18px; width: 130px; justify-content: flex-end; }
        .control-icon-btn { background: none; border: none; cursor: pointer; opacity: 0.8; transition: opacity 0.2s, transform 0.2s; }
        .control-icon-btn:hover { opacity: 1; transform: scale(1.1); }
        .icon-svg { fill: #d1d5db; width: 20px; height: 20px; }
        .server-popup { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 90%; max-width: 340px; background: rgba(20, 22, 35, 0.96); backdrop-filter: blur(16px); border-radius: 16px; border: 1px solid rgba(255, 255, 255, 0.12); color: white; z-index: 100; padding: 20px; box-shadow: 0 20px 50px rgba(0,0,0,0.8); }
        .popup-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px; }
        .popup-title .en { font-size: 11px; color: #9ca3af; font-weight: 500; }
        .popup-title .ar { font-size: 14px; font-weight: 700; margin-top: 2px; }
        .close-server-popup { background: none; border: none; color: #9ca3af; font-size: 20px; cursor: pointer; }
        .server-list { display: flex; flex-direction: column; gap: 6px; max-height: 250px; overflow-y: auto; }
        .server-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-radius: 10px; cursor: pointer; transition: background-color 0.2s; }
        .server-item:hover { background-color: rgba(255, 255, 255, 0.08); }
        .server-item.active { background-color: rgba(92, 77, 255, 0.3); border: 1px solid rgba(92, 77, 255, 0.4); }
        .server-info .en { font-size: 13px; font-weight: 500; }
        .server-info .ar { font-size: 12px; color: #9ca3af; margin-top: 2px; font-weight: 500; }
        .check-icon { width: 18px; height: 18px; fill: #5c4dff; display: none; }
        .signal-icon { width: 16px; height: 16px; fill: #9ca3af; }
        .server-item.active .check-icon { display: block; }
        .server-item.active .signal-icon { display: none; }
        .modal { display: none; position: fixed; z-index: 150; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.8); justify-content: center; align-items: center; backdrop-filter: blur(8px); }
        .modal-content { background-color: rgba(25, 27, 40, 0.95); border-radius: 16px; padding: 24px; width: 90%; max-width: 500px; border: 1px solid rgba(255,255,255,0.1); color: white; display: flex; flex-direction: column; gap: 16px; }
        .modal-header { display: flex; justify-content: space-between; align-items: center; }
        .close-modal { background: none; border: none; color: #d1d5db; font-size: 22px; cursor: pointer; }
        #embedCodeArea { background-color: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.1); color: #a78bfa; padding: 12px; border-radius: 8px; resize: none; width: 100%; height: 100px; font-size: 12px; }
        #copyEmbedBtn { background-color: #5c4dff; color: white; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer; font-weight: 700; transition: background-color 0.2s; }
        #copyEmbedBtn:hover { background-color: #4a3be0; }
    </style>
</head>
<body>

    <div class="player-container" id="playerContainer">
        <div id="loadingOverlay" class="loading-overlay"><div class="spinner"></div><div class="loading-text">جاري التحقق من البث المباشر...</div></div>
        <video id="video" playsinline webkit-playsinline autoplay></video>
        <div class="glass-bar title-bar" id="titleBar">
            <a href="${CONFIG.MAIN_WEBSITE}" target="_blank" class="logo-text">YTPlus.com</a>
            <div class="video-title" dir="rtl">${matchTitle}</div>
        </div>
        <div id="serverPopup" class="server-popup">
            <div class="popup-header">
                <div class="popup-title"><span class="en">STREAM SERVER SELECTION</span><span class="ar" dir="rtl">اختر الخادم للبث</span></div>
                <button class="close-server-popup" id="closeServerPopup">&times;</button>
            </div>
            <div class="server-list">${serverItemsHtml}</div>
        </div>
        <div class="glass-bar controls-bar" id="controlsBar">
            <div class="left-controls"><div class="live-dot"></div><span class="live-text">LIVE</span></div>
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
            <div class="modal-header"><h2>Embed Code / كود التضمين</h2><button class="close-modal" id="closeEmbedModal">&times;</button></div>
            <textarea id="embedCodeArea" readonly><iframe src="${embedUrl}" width="640" height="360" frameborder="0" allowfullscreen></iframe></textarea>
            <button id="copyEmbedBtn">Copy Code / نسخ الكود</button>
        </div>
    </div>

    <script>
        const video = document.getElementById('video');
        const playerContainer = document.getElementById('playerContainer');
        const loadingOverlay = document.getElementById('loadingOverlay');
        let hls = null;
        
        let currentToken = '${secureToken}';
        const channelHash = '${channelHash}';
        const totalServers = ${totalServers};
        let currentServerIndex = 0;
        let isPlaying = true;
        let autoSwitchEnabled = true; 
        let serversTested = 0; 

        setInterval(async () => {
            try {
                const response = await fetch('/api/refresh-token');
                const data = await response.json();
                if (data && data.token) {
                    currentToken = data.token;
                    if (hls) {
                        const newManifestUrl = '/manifest/' + channelHash + '/' + currentServerIndex + '?token=' + encodeURIComponent(currentToken);
                        hls.loadSource(newManifestUrl);
                    }
                }
            } catch (e) {}
        }, 8 * 60 * 1000);

        // محمل مخصص لفك ضغط قطعة الفيديو (.zst) في المتصفح تلقائياً
        class ZstdFragmentLoader extends Hls.DefaultConfig.loader {
            constructor(config) {
                super(config);
                const originalLoad = this.load.bind(this);
                this.load = function (context, config, callbacks) {
                    const originalOnSuccess = callbacks.onSuccess;
                    callbacks.onSuccess = function (response, stats, context, networkDetails) {
                        if (context.url.includes('.zst')) {
                            try {
                                const compressed = new Uint8Array(response.data);
                                const decompressed = fzstd.decompress(compressed);
                                response.data = decompressed.buffer;
                            } catch (e) {
                                console.error("ZSTD Decompression error:", e);
                            }
                        }
                        originalOnSuccess(response, stats, context, networkDetails);
                    };
                    originalLoad(context, config, callbacks);
                };
            }
        }

        const playPauseBtn = document.getElementById('playPauseBtn');
        const pauseIcon = document.getElementById('pauseIcon');
        const playIcon = document.getElementById('playIcon');
        const serverPopup = document.getElementById('serverPopup');
        
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

        function showLoading() { loadingOverlay.style.opacity = '1'; loadingOverlay.style.pointerEvents = 'auto'; }
        function hideLoading() { loadingOverlay.style.opacity = '0'; loadingOverlay.style.pointerEvents = 'none'; }

        function changeServer(serverIndex, isManual = false) {
            showLoading();
            currentServerIndex = parseInt(serverIndex);
            if (isManual) autoSwitchEnabled = false; 
            if (autoSwitchEnabled) serversTested++;
            
            document.querySelectorAll('.server-item').forEach((item, idx) => {
                if (idx === currentServerIndex) item.classList.add('active');
                else item.classList.remove('active');
            });

            const manifestUrl = '/manifest/' + channelHash + '/' + currentServerIndex + '?token=' + encodeURIComponent(currentToken);
            if (hls) { hls.destroy(); hls = null; }
            
            if (Hls.isSupported()) {
                hls = new Hls({
                    fLoader: ZstdFragmentLoader
                }); 
                
                hls.loadSource(manifestUrl); 
                hls.attachMedia(video);
                
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    video.play().then(() => {
                        hideLoading(); isPlaying = true; updatePlayPauseUI(); autoSwitchEnabled = false; 
                    }).catch(() => { hideLoading(); });
                });

                hls.on(Hls.Events.ERROR, function (event, data) {
                    if (data.fatal) {
                        switch (data.type) {
                            case Hls.ErrorTypes.NETWORK_ERROR:
                                hls.startLoad(); break;
                            case Hls.ErrorTypes.MEDIA_ERROR:
                                hls.recoverMediaError(); break;
                            default:
                                if (autoSwitchEnabled && serversTested < totalServers) {
                                    let nextServer = (currentServerIndex + 1) % totalServers;
                                    changeServer(nextServer, false); 
                                } else {
                                    autoSwitchEnabled = false; hls.destroy(); hideLoading();
                                }
                                break;
                        }
                    }
                });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = manifestUrl; 
                video.addEventListener('loadedmetadata', () => {
                    video.play().then(() => { hideLoading(); isPlaying = true; updatePlayPauseUI(); autoSwitchEnabled = false; }).catch(() => { hideLoading(); });
                });
            }
            serverPopup.style.display = 'none';
        }

        changeServer(0, false);

        playPauseBtn.addEventListener('click', (e) => { e.stopPropagation(); if (video.paused) video.play(); else video.pause(); });
        video.addEventListener('play', () => { isPlaying = true; updatePlayPauseUI(); resetInactivityTimer(); });
        video.addEventListener('pause', () => { isPlaying = false; updatePlayPauseUI(); playerContainer.classList.remove('hide-ui'); clearTimeout(inactivityTimeout); });
        
        function updatePlayPauseUI() {
            if (isPlaying) { pauseIcon.style.display = 'block'; playIcon.style.display = 'none'; } 
            else { pauseIcon.style.display = 'none'; playIcon.style.display = 'block'; }
        }

        document.getElementById('fullscreenBtn').addEventListener('click', (e) => { 
            e.stopPropagation(); 
            if (!document.fullscreenElement) {
                if (playerContainer.requestFullscreen) playerContainer.requestFullscreen();
            } else {
                if (document.exitFullscreen) document.exitFullscreen();
            }
        });
        
        document.getElementById('settingsBtn').addEventListener('click', (e) => { e.stopPropagation(); serverPopup.style.display = serverPopup.style.display === 'block' ? 'none' : 'block'; });
        document.getElementById('closeServerPopup').addEventListener('click', () => { serverPopup.style.display = 'none'; });
        const embedModal = document.getElementById('embedModal');
        document.getElementById('embedBtn').addEventListener('click', () => { embedModal.style.display = 'flex'; });
        document.getElementById('closeEmbedModal').addEventListener('click', () => { embedModal.style.display = 'none'; });
        document.getElementById('copyEmbedBtn').addEventListener('click', () => {
            document.getElementById('embedCodeArea').select(); document.execCommand('copy'); alert('تم نسخ كود التضمين!'); embedModal.style.display = 'none';
        });

    </script>
</body>
</html>`;
}

app.listen(PORT, () => {
    console.log(`🚀 Secure Monetized Player running on port ${PORT}`);
});
