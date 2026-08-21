const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

const PORT = process.env.PORT || 3000;

// ============ الإعدادات ============
const CONFIG = {
    MANIFEST_CACHE_DURATION: 10000, 
    STREAM_CACHE_DURATION: 60000, 
    PAGE_CACHE_DURATION: 300000, 
    MAX_REQUESTS_PER_MIN: 200, 
    TOKEN_EXPIRY: 300000, 
    REQUEST_TIMEOUT: 15000, 
    CLEANUP_INTERVAL: 10000 
};

// ============ التخزين ============
let streamDataCache = {};
let manifestCache = {};
let pendingRequests = {};
let pageCache = {};
let validTokens = new Set();
let requestCounts = {};

let stats = {
    totalRequests: 0,
    activeUsers: 0,
    errors: 0,
    manifestCacheHits: 0,
    manifestCacheMisses: 0,
    startTime: Date.now()
};

// ============ مراقبة الطلبات ============
app.use((req, res, next) => {
    stats.totalRequests++;
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    if (!requestCounts[ip] || now - requestCounts[ip].timestamp > 60000) {
        requestCounts[ip] = { count: 0, timestamp: now };
    }
    
    requestCounts[ip].count++;
    
    if (requestCounts[ip].count > CONFIG.MAX_REQUESTS_PER_MIN) {
        return res.status(429).send('⚠️ طلبات كثيرة جداً، حاول لاحقاً');
    }
    next();
});

// ============ تنظيف دوري ============
setInterval(() => {
    const now = Date.now();
    
    Object.keys(pendingRequests).forEach(key => {
        if (now - pendingRequests[key].timestamp > 15000) completeRequest(key, null, 'مهلة');
    });
    
    Object.keys(manifestCache).forEach(key => {
        if (now - manifestCache[key].timestamp > CONFIG.MANIFEST_CACHE_DURATION) delete manifestCache[key];
    });
    
    Object.keys(streamDataCache).forEach(key => {
        if (now - streamDataCache[key].timestamp > CONFIG.STREAM_CACHE_DURATION) delete streamDataCache[key];
    });
    
    Object.keys(pageCache).forEach(key => {
        if (now - pageCache[key].timestamp > CONFIG.PAGE_CACHE_DURATION) delete pageCache[key];
    });
    
    Object.keys(requestCounts).forEach(ip => {
        if (now - requestCounts[ip].timestamp > 60000) delete requestCounts[ip];
    });
}, CONFIG.CLEANUP_INTERVAL);

function completeRequest(cacheKey, data, error) {
    const request = pendingRequests[cacheKey];
    if (!request) return;
    
    request.waiters.forEach(res => {
        if (error) {
            res.status(500).send(error);
        } else {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', `public, max-age=${CONFIG.MANIFEST_CACHE_DURATION / 1000}`);
            res.send(data);
        }
    });
    
    delete pendingRequests[cacheKey];
}

// ============ 1. مسار عرض المشغل ============
app.get('/play/:channel', async (req, res) => {
    try {
        const channelName = req.params.channel;
        const token = crypto.randomBytes(32).toString('hex');
        validTokens.add(token);
        
        setTimeout(() => validTokens.delete(token), CONFIG.TOKEN_EXPIRY);
        
        if (pageCache[channelName]) {
            stats.activeUsers++;
            return res.send(pageCache[channelName].html.replace('__TOKEN__', token));
        }
        
        const channelId = `live_tv_${channelName}`;
        const apiResponse = await axios.get(`https://s3-1nft.onrender.com/yacintv/stream`, {
            params: { id_live: channelId },
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
            timeout: CONFIG.REQUEST_TIMEOUT
        });
        
        const responseData = apiResponse.data;
        if (!responseData || (Array.isArray(responseData) && responseData.length === 0)) {
            return res.status(400).send('لا توجد بيانات للقناة');
        }
        
        const servers = [];
        const dataArray = Array.isArray(responseData) ? responseData : [responseData];
        
        for (let i = 0; i < dataArray.length; i++) {
            const serverData = dataArray[i];
            if (serverData.result !== 0 || !serverData.data) continue;
            
            try {
                let rawUrl = serverData.data.url;
                let innerData = (typeof rawUrl === 'string') 
                    ? (rawUrl.trim().startsWith('{') ? JSON.parse(rawUrl.trim()) : { url: rawUrl.trim() }) 
                    : rawUrl;
                
                servers.push({
                    name: serverData.name || `سيرفر ${i + 1}`,
                    url: innerData.url,
                    headers: innerData.headers || {},
                    agent: innerData.agent || innerData.headers?.['User-Agent'] || 'Mozilla/5.0',
                    swap: innerData.swap || null
                });
            } catch (e) {
                console.error(`خطأ في معالجة السيرفر ${i + 1}:`, e.message);
            }
        }
        
        if (servers.length === 0) return res.status(400).send('لا توجد سيرفرات صالحة');
        
        streamDataCache[channelName] = { servers: servers, timestamp: Date.now() };
        
        const html = generatePlayerPage(channelName, servers);
        pageCache[channelName] = { html: html, timestamp: Date.now() };
        
        stats.activeUsers++;
        res.send(html.replace('__TOKEN__', token));
        
    } catch (error) {
        stats.errors++;
        res.status(500).send('حدث خطأ في تحميل القناة');
    }
});

// ============ 2. مسار جلب المانيفست ============
app.get('/get-manifest/:channel/:serverIndex', async (req, res) => {
    const { channel, serverIndex } = req.params;
    const index = parseInt(serverIndex) || 0;
    const cacheKey = `${channel}_${index}`;
    
    if (manifestCache[cacheKey] && (Date.now() - manifestCache[cacheKey].timestamp < CONFIG.MANIFEST_CACHE_DURATION)) {
        stats.manifestCacheHits++;
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', `public, max-age=${CONFIG.MANIFEST_CACHE_DURATION / 1000}`);
        return res.send(manifestCache[cacheKey].data);
    }
    
    stats.manifestCacheMisses++;
    
    if (pendingRequests[cacheKey]) {
        pendingRequests[cacheKey].waiters.push(res);
        setTimeout(() => {
            if (pendingRequests[cacheKey]) {
                const idx = pendingRequests[cacheKey].waiters.indexOf(res);
                if (idx > -1) {
                    pendingRequests[cacheKey].waiters.splice(idx, 1);
                    res.status(408).send('مهلة');
                }
            }
        }, 10000);
        return;
    }
    
    pendingRequests[cacheKey] = { waiters: [res], timestamp: Date.now() };
    
    const streamInfo = streamDataCache[channel];
    if (!streamInfo || !streamInfo.servers[index]) return completeRequest(cacheKey, null, 'غير متوفر');
    
    const server = streamInfo.servers[index];
    
    try {
        const headers = {
            'User-Agent': server.headers['User-Agent'] || server.agent || 'Mozilla/5.0',
            'Accept': '*/*',
            'Connection': 'keep-alive'
        };
        if (server.headers['Referer']) headers['Referer'] = server.headers['Referer'];
        if (server.headers['Origin']) headers['Origin'] = server.headers['Origin'];
        
        const response = await axios.get(server.url, { headers, timeout: CONFIG.REQUEST_TIMEOUT });
        let data = response.data;
        
        let swapKey = '', swapValue = '';
        if (server.swap) {
            swapKey = Object.keys(server.swap)[0];
            swapValue = server.swap[swapKey];
        }
        
        const baseUrl = server.url.substring(0, server.url.lastIndexOf('/') + 1);
        data = data.replace(/^(?!#)(.*)$/gm, (match) => {
            const trimmed = match.trim();
            if (!trimmed || trimmed.startsWith('#')) return match;
            let fullUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
            if (swapKey && fullUrl.includes(swapKey)) fullUrl = fullUrl.replace(swapKey, swapValue);
            return fullUrl;
        });
        
        manifestCache[cacheKey] = { data: data, timestamp: Date.now() };
        completeRequest(cacheKey, data, null);
        
    } catch (error) {
        stats.errors++;
        completeRequest(cacheKey, null, 'خطأ في جلب البيانات');
    }
});

// ============ 3. مسار الإحصائيات ============
app.get('/stats', (req, res) => {
    const uptime = (Date.now() - stats.startTime) / 1000;
    res.json({ success: true, uptime: `${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s`, activeUsers: stats.activeUsers });
});

// ============ دالة إنشاء صفحة المشغل (تم التحديث بالكامل) ============
function generatePlayerPage(channelName, servers) {
    return `
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <title>YTPlus - ${channelName}</title>
            <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
            <style>
                :root {
                    --primary: #FFD700; /* أصفر احترافي */
                    --bg-dark: #0B192C; /* أزرق سماوي داكن جداً */
                    --bg-panel: rgba(11, 25, 44, 0.85);
                    --text-light: #F8FAFC;
                    --glass: rgba(255, 255, 255, 0.08);
                    --glass-hover: rgba(255, 255, 255, 0.15);
                }
                
                * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
                
                body { 
                    background: var(--bg-dark);
                    font-family: system-ui, -apple-system, sans-serif;
                    height: 100vh;
                    width: 100vw;
                    overflow: hidden;
                    color: var(--text-light);
                }
                
                #videoContainer {
                    position: relative;
                    width: 100%;
                    height: 100%;
                    background: #000;
                }
                
                video { 
                    width: 100%; 
                    height: 100%;
                    object-fit: contain;
                }
                
                .overlay-ui {
                    position: absolute;
                    left: 0; right: 0;
                    padding: 20px;
                    z-index: 10;
                    transition: opacity 0.4s ease;
                }

                #topBar {
                    top: 0;
                    background: linear-gradient(to bottom, rgba(0,0,0,0.8) 0%, transparent 100%);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                
                .logo-text { font-size: 20px; font-weight: 800; }
                .logo-text span { color: var(--primary); }
                
                .live-badge {
                    background: rgba(239, 68, 68, 0.2);
                    color: #EF4444;
                    border: 1px solid #EF4444;
                    padding: 4px 12px;
                    border-radius: 20px;
                    font-size: 12px;
                    font-weight: bold;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                .live-badge::before {
                    content: '';
                    width: 8px; height: 8px;
                    background: #EF4444;
                    border-radius: 50%;
                    animation: pulse 1.5s infinite;
                }
                @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
                
                #controlBar {
                    bottom: 0;
                    background: linear-gradient(to top, rgba(0,0,0,0.9) 0%, transparent 100%);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    gap: 20px;
                    padding-bottom: 30px;
                }
                
                .btn {
                    background: var(--glass);
                    border: 1px solid rgba(255,255,255,0.1);
                    color: white;
                    border-radius: 50%;
                    width: 50px; height: 50px;
                    display: flex; justify-content: center; align-items: center;
                    cursor: pointer;
                    backdrop-filter: blur(10px);
                    -webkit-backdrop-filter: blur(10px);
                    transition: all 0.2s;
                }
                .btn:hover { background: var(--glass-hover); transform: scale(1.05); }
                .btn-play { 
                    width: 65px; height: 65px; 
                    background: var(--primary); 
                    color: var(--bg-dark);
                    border: none;
                }
                .btn-play:hover { background: #E6C200; }
                
                .btn svg { width: 24px; height: 24px; fill: currentColor; }
                .btn-play svg { width: 32px; height: 32px; }

                /* Loader */
                #status {
                    position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
                    display: none; text-align: center; z-index: 20;
                }
                .spinner {
                    width: 40px; height: 40px;
                    border: 3px solid rgba(255,255,255,0.1);
                    border-top-color: var(--primary);
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                    margin: 0 auto 10px;
                }
                @keyframes spin { to { transform: rotate(360deg); } }

                /* Server List */
                #serverList {
                    position: absolute; bottom: 90px; left: 50%; transform: translateX(-50%);
                    background: var(--bg-panel);
                    backdrop-filter: blur(15px); -webkit-backdrop-filter: blur(15px);
                    border: 1px solid rgba(255,255,255,0.05);
                    border-radius: 16px; padding: 12px;
                    display: none; z-index: 30;
                    width: 90%; max-width: 320px;
                }
                .server-item {
                    padding: 12px 16px; margin-bottom: 6px;
                    background: rgba(0,0,0,0.2); border-radius: 10px;
                    cursor: pointer; transition: 0.2s;
                    display: flex; align-items: center; gap: 12px;
                    font-size: 14px;
                }
                .server-item:last-child { margin-bottom: 0; }
                .server-item.active { background: var(--primary); color: var(--bg-dark); font-weight: bold; }
                
                .ui-hidden { opacity: 0; pointer-events: none; }
            </style>
        </head>
        <body>
            <div id="videoContainer">
                <video id="video" playsinline></video>
                
                <div id="topBar" class="overlay-ui">
                    <div class="logo-text">YT<span>Plus</span></div>
                    <div class="live-badge">مباشر</div>
                </div>
                
                <div id="status"><div class="spinner"></div><div id="statusText">جاري التحميل...</div></div>
                
                <div id="serverList"></div>
                
                <div id="controlBar" class="overlay-ui">
                    <button class="btn" onclick="toggleServers()">
                        <svg viewBox="0 0 24 24"><path d="M3 3h18v18H3z" fill="none"/><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>
                    </button>
                    <button class="btn btn-play" id="playBtn" onclick="togglePlay()">
                        <svg id="playIcon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                        <svg id="pauseIcon" viewBox="0 0 24 24" style="display:none;"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                    </button>
                    <button class="btn" onclick="reloadVideo()">
                        <svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
                    </button>
                </div>
            </div>
            
            <script>
                const video = document.getElementById('video');
                const status = document.getElementById('status');
                const statusText = document.getElementById('statusText');
                const serverListEl = document.getElementById('serverList');
                const uis = document.querySelectorAll('.overlay-ui');
                const playIcon = document.getElementById('playIcon');
                const pauseIcon = document.getElementById('pauseIcon');
                
                let hls = null;
                let currentServerIndex = 0;
                let hideTimeout;
                const servers = ${JSON.stringify(servers)};
                
                function toggleUI() {
                    const isHidden = uis[0].classList.contains('ui-hidden');
                    if (isHidden) showUI(); else hideUI();
                }

                function showUI() {
                    uis.forEach(ui => ui.classList.remove('ui-hidden'));
                    clearTimeout(hideTimeout);
                    if (!video.paused) hideTimeout = setTimeout(hideUI, 3500);
                }
                
                function hideUI() {
                    if (!video.paused) {
                        uis.forEach(ui => ui.classList.add('ui-hidden'));
                        serverListEl.style.display = 'none';
                    }
                }
                
                function showStatus(msg) { statusText.textContent = msg; status.style.display = 'block'; }
                function hideStatus() { status.style.display = 'none'; }
                
                function updateServerList() {
                    serverListEl.innerHTML = '';
                    servers.forEach((server, i) => {
                        const div = document.createElement('div');
                        div.className = 'server-item' + (i === currentServerIndex ? ' active' : '');
                        div.innerHTML = '<span>' + server.name + '</span>';
                        div.onclick = (e) => { e.stopPropagation(); playServer(i); serverListEl.style.display = 'none'; };
                        serverListEl.appendChild(div);
                    });
                }
                
                function toggleServers() {
                    serverListEl.style.display = serverListEl.style.display === 'block' ? 'none' : 'block';
                    showUI();
                }
                
                function playServer(index) {
                    if (index >= servers.length) { showStatus('لا توجد سيرفرات متاحة'); return; }
                    currentServerIndex = index;
                    updateServerList();
                    showStatus('جاري الاتصال...');
                    
                    if (hls) { hls.destroy(); hls = null; }
                    
                    const manifestUrl = '/get-manifest/${channelName}/' + index;
                    
                    // دعم HLS.js للأندرويد والكمبيوتر
                    if (Hls.isSupported()) {
                        hls = new Hls({ lowLatencyMode: true });
                        hls.loadSource(manifestUrl);
                        hls.attachMedia(video);
                        hls.on(Hls.Events.MANIFEST_PARSED, () => { hideStatus(); video.play(); });
                        hls.on(Hls.Events.ERROR, (event, data) => {
                            if (data.fatal) setTimeout(() => playServer((index + 1) % servers.length), 2000);
                        });
                    } 
                    // الدعم المباشر لأجهزة الآيفون (iOS Safari)
                    else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                        video.src = manifestUrl;
                        video.addEventListener('loadedmetadata', () => { hideStatus(); video.play(); });
                        video.addEventListener('error', () => {
                            setTimeout(() => playServer((index + 1) % servers.length), 2000);
                        });
                    } else {
                        showStatus('المتصفح لا يدعم التشغيل');
                    }
                }
                
                function togglePlay() {
                    video.paused ? video.play() : video.pause();
                    showUI();
                }
                
                function reloadVideo() { playServer(currentServerIndex); }
                
                video.addEventListener('click', toggleUI);
                video.addEventListener('play', () => { playIcon.style.display = 'none'; pauseIcon.style.display = 'block'; });
                video.addEventListener('pause', () => { playIcon.style.display = 'block'; pauseIcon.style.display = 'none'; showUI(); });
                
                // بدء التشغيل
                updateServerList();
                playServer(0);
                showUI();
            </script>
        </body>
        </html>
    `;
}

app.use((err, req, res, next) => { res.status(500).send('خطأ في الخادم'); });
process.on('uncaughtException', (err) => { console.error('خطأ غير متوقع:', err); });

app.listen(PORT, () => { console.log(\`🚀 YTPlus Player works on port: \${PORT}\`); });
