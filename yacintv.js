const express = require('express');
const axios = require('axios');
const compression = require('compression');
const cors = require('cors');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(compression());
app.use(express.json());

let streamDataCache = {};
let manifestCache = {};
let pendingRequests = {};

// ============ تنظيف الكاش ============
setInterval(() => {
    const now = Date.now();
    
    Object.keys(pendingRequests).forEach(key => {
        if (now - pendingRequests[key].timestamp > 15000) {
            completeRequest(key, null, 'مهلة');
        }
    });
    
    Object.keys(manifestCache).forEach(key => {
        if (now - manifestCache[key].timestamp > 60000) {
            delete manifestCache[key];
        }
    });
    
    Object.keys(streamDataCache).forEach(key => {
        if (now - streamDataCache[key].timestamp > 300000) {
            delete streamDataCache[key];
        }
    });
}, 10000);

// ============ دالة إكمال الطلب ============
function completeRequest(cacheKey, data, error) {
    const request = pendingRequests[cacheKey];
    if (!request) return;
    
    request.waiters.forEach(res => {
        if (error) {
            res.status(500).send(error);
        } else {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'public, max-age=60');
            res.send(data);
        }
    });
    
    delete pendingRequests[cacheKey];
}

// ============ 1. مسار عرض المشغل ============
app.get('/play/:channel', async (req, res) => {
    try {
        const channelName = req.params.channel;
        const channelId = `live_tv_${channelName}`;
        
        // التحقق من الكاش
        if (streamDataCache[channelName] && (Date.now() - streamDataCache[channelName].timestamp < 60000)) {
            return sendPlayerPage(res, channelName, streamDataCache[channelName].servers);
        }
        
        console.log('📡 جاري تحميل القناة:', channelId);
        
        const apiResponse = await axios.get(`https://s3-1nft.onrender.com/yacintv/stream`, {
            params: { id_live: channelId },
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json'
            },
            timeout: 15000
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
                let innerData;
                
                if (typeof rawUrl === 'string') {
                    rawUrl = rawUrl.trim().replace(/^\t+/, '');
                    if (rawUrl.startsWith('{')) {
                        innerData = JSON.parse(rawUrl);
                    } else {
                        innerData = { url: rawUrl };
                    }
                } else {
                    innerData = rawUrl;
                }
                
                servers.push({
                    name: serverData.name || `سيرفر ${i + 1}`,
                    url: innerData.url,
                    headers: innerData.headers || {},
                    agent: innerData.agent || innerData.headers?.['User-Agent'] || 'Mozilla/5.0',
                    mediatype: innerData.mediatype || 'auto',
                    drm: innerData.drm || null,
                    swap: innerData.swap || null
                });
            } catch (e) {
                console.error('خطأ:', e.message);
            }
        }
        
        if (servers.length === 0) {
            return res.status(400).send('لا توجد سيرفرات صالحة');
        }
        
        streamDataCache[channelName] = {
            servers: servers,
            timestamp: Date.now()
        };
        
        sendPlayerPage(res, channelName, servers);
        
    } catch (error) {
        console.error('خطأ:', error);
        res.status(500).send('حدث خطأ');
    }
});

// ============ دالة إرسال صفحة المشغل ============
function sendPlayerPage(res, channelName, servers) {
    res.send(`
        <!DOCTYPE html>
        <html lang="ar" dir="rtl">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>YTPlus.com - ${channelName}</title>
            <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>▶️</text></svg>">
            <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
            <style>
                :root {
                    --primary: #ff0000;
                    --secondary: #00e676;
                    --dark: #0a0a0a;
                    --glass: rgba(255, 255, 255, 0.1);
                    --glass-hover: rgba(255, 255, 255, 0.2);
                }
                
                * { 
                    margin: 0; 
                    padding: 0; 
                    box-sizing: border-box; 
                }
                
                body { 
                    background: var(--dark);
                    font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
                    height: 100vh;
                    overflow: hidden;
                    user-select: none;
                    -webkit-user-select: none;
                }
                
                #videoContainer {
                    position: relative;
                    width: 100%;
                    height: 100%;
                    cursor: pointer;
                }
                
                video { 
                    width: 100%; 
                    height: 100%;
                    object-fit: contain;
                }
                
                /* شريط علوي */
                #topBar {
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    padding: 20px;
                    background: linear-gradient(to bottom, rgba(0,0,0,0.9), transparent);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    z-index: 100;
                    transition: all 0.3s ease;
                }
                
                .logo {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    text-decoration: none;
                }
                
                .logo-icon {
                    width: 40px;
                    height: 40px;
                    background: var(--primary);
                    border-radius: 50%;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    font-size: 20px;
                    color: white;
                    box-shadow: 0 0 20px rgba(255, 0, 0, 0.5);
                }
                
                .logo-text {
                    font-size: 24px;
                    font-weight: bold;
                    color: white;
                    letter-spacing: 1px;
                }
                
                .logo-text span {
                    color: var(--primary);
                }
                
                .live-badge {
                    background: var(--primary);
                    color: white;
                    padding: 5px 15px;
                    border-radius: 20px;
                    font-weight: bold;
                    font-size: 14px;
                    animation: pulse 2s infinite;
                }
                
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.6; }
                }
                
                /* شريط تحكم سفلي */
                #controlBar {
                    position: absolute;
                    bottom: 0;
                    left: 0;
                    right: 0;
                    padding: 20px;
                    background: linear-gradient(to top, rgba(0,0,0,0.9), transparent);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    gap: 15px;
                    z-index: 100;
                    transition: all 0.3s ease;
                }
                
                .btn {
                    width: 60px;
                    height: 60px;
                    border-radius: 50%;
                    background: var(--glass);
                    border: 2px solid rgba(255, 255, 255, 0.3);
                    color: white;
                    cursor: pointer;
                    font-size: 24px;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    transition: all 0.3s ease;
                    backdrop-filter: blur(10px);
                    -webkit-backdrop-filter: blur(10px);
                }
                
                .btn:hover {
                    background: var(--glass-hover);
                    transform: scale(1.1);
                    border-color: white;
                }
                
                .btn:active {
                    transform: scale(0.9);
                }
                
                .btn-play {
                    width: 80px;
                    height: 80px;
                    font-size: 32px;
                    background: var(--primary);
                    border-color: var(--primary);
                    box-shadow: 0 0 30px rgba(255, 0, 0, 0.5);
                }
                
                .btn-play:hover {
                    background: #ff3333;
                    border-color: #ff3333;
                }
                
                /* حالة التحميل */
                #status {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    display: none;
                    z-index: 100;
                    text-align: center;
                }
                
                .spinner {
                    width: 60px;
                    height: 60px;
                    border: 4px solid rgba(255, 255, 255, 0.3);
                    border-top: 4px solid var(--primary);
                    border-radius: 50%;
                    animation: spin 1s linear infinite;
                    margin: 0 auto 20px;
                }
                
                @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                }
                
                .status-text {
                    color: white;
                    font-size: 18px;
                }
                
                /* قائمة السيرفرات */
                #serverList {
                    position: absolute;
                    bottom: 100px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: rgba(0, 0, 0, 0.95);
                    border-radius: 15px;
                    padding: 15px;
                    display: none;
                    z-index: 100;
                    max-height: 400px;
                    overflow-y: auto;
                    min-width: 300px;
                    backdrop-filter: blur(20px);
                    -webkit-backdrop-filter: blur(20px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }
                
                .server-list-header {
                    color: white;
                    font-size: 18px;
                    font-weight: bold;
                    margin-bottom: 15px;
                    text-align: center;
                }
                
                .server-item {
                    padding: 15px;
                    color: white;
                    cursor: pointer;
                    border-radius: 10px;
                    transition: all 0.3s;
                    margin-bottom: 5px;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }
                
                .server-item:hover {
                    background: rgba(255, 255, 255, 0.1);
                }
                
                .server-item.active {
                    background: var(--primary);
                    box-shadow: 0 0 20px rgba(255, 0, 0, 0.3);
                }
                
                .server-icon {
                    width: 30px;
                    height: 30px;
                    border-radius: 50%;
                    background: rgba(255, 255, 255, 0.2);
                    display: flex;
                    justify-content: center;
                    align-items: center;
                }
                
                /* رسالة الخطأ */
                #errorMsg {
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    color: white;
                    text-align: center;
                    display: none;
                    z-index: 100;
                    background: rgba(0, 0, 0, 0.9);
                    padding: 30px;
                    border-radius: 15px;
                    border: 1px solid rgba(255, 0, 0, 0.5);
                }
                
                .error-icon {
                    font-size: 50px;
                    margin-bottom: 20px;
                }
                
                /* تذييل */
                #footer {
                    position: absolute;
                    bottom: 5px;
                    left: 50%;
                    transform: translateX(-50%);
                    color: rgba(255, 255, 255, 0.5);
                    font-size: 12px;
                    z-index: 99;
                }
                
                /* إخفاء العناصر */
                .hidden {
                    opacity: 0;
                    pointer-events: none;
                }
            </style>
        </head>
        <body>
            <div id="videoContainer">
                <video id="video" controls autoplay playsinline></video>
                
                <!-- الشريط العلوي -->
                <div id="topBar">
                    <a href="https://ytplus.com" class="logo">
                        <div class="logo-icon">▶</div>
                        <div class="logo-text">YT<span>Plus</span>.com</div>
                    </a>
                    <div class="live-badge">● مباشر</div>
                </div>
                
                <!-- حالة التحميل -->
                <div id="status">
                    <div class="spinner"></div>
                    <div class="status-text">جاري التحميل...</div>
                </div>
                
                <!-- رسالة الخطأ -->
                <div id="errorMsg">
                    <div class="error-icon">⚠️</div>
                    <div id="errorText"></div>
                </div>
                
                <!-- قائمة السيرفرات -->
                <div id="serverList">
                    <div class="server-list-header">اختر السيرفر</div>
                </div>
                
                <!-- شريط التحكم -->
                <div id="controlBar">
                    <button class="btn" onclick="toggleServers()" title="السيرفرات">
                        📡
                    </button>
                    <button class="btn btn-play" id="playBtn" onclick="togglePlay()" title="تشغيل/إيقاف">
                        ⏸
                    </button>
                    <button class="btn" onclick="reloadVideo()" title="إعادة تشغيل">
                        🔄
                    </button>
                </div>
                
                <div id="footer">YTPlus.com © 2024</div>
            </div>
            
            <script>
                const video = document.getElementById('video');
                const status = document.getElementById('status');
                const errorMsg = document.getElementById('errorMsg');
                const errorText = document.getElementById('errorText');
                const serverListEl = document.getElementById('serverList');
                const playBtn = document.getElementById('playBtn');
                const topBar = document.getElementById('topBar');
                const controlBar = document.getElementById('controlBar');
                
                let hls = null;
                let currentServerIndex = 0;
                let hideTimeout;
                
                const servers = ${JSON.stringify(servers)};
                
                // إظهار/إخفاء عناصر التحكم
                function showControls() {
                    topBar.classList.remove('hidden');
                    controlBar.classList.remove('hidden');
                    
                    clearTimeout(hideTimeout);
                    hideTimeout = setTimeout(hideControls, 3000);
                }
                
                function hideControls() {
                    if (!video.paused) {
                        topBar.classList.add('hidden');
                        controlBar.classList.add('hidden');
                    }
                }
                
                function showStatus(msg) {
                    document.querySelector('.status-text').textContent = msg;
                    status.style.display = 'block';
                }
                
                function hideStatus() {
                    status.style.display = 'none';
                }
                
                function showError(msg) {
                    errorText.textContent = msg;
                    errorMsg.style.display = 'block';
                }
                
                function hideError() {
                    errorMsg.style.display = 'none';
                }
                
                function updateServerList() {
                    serverListEl.innerHTML = '<div class="server-list-header">اختر السيرفر</div>';
                    
                    servers.forEach((server, index) => {
                        const div = document.createElement('div');
                        div.className = 'server-item' + (index === currentServerIndex ? ' active' : '');
                        div.innerHTML = 
                            '<div class="server-icon">📡</div>' +
                            '<span>' + server.name + '</span>';
                        div.onclick = () => {
                            playServer(index);
                            serverListEl.style.display = 'none';
                        };
                        serverListEl.appendChild(div);
                    });
                }
                
                function toggleServers() {
                    serverListEl.style.display = serverListEl.style.display === 'block' ? 'none' : 'block';
                }
                
                function playServer(index) {
                    if (index >= servers.length) {
                        showError('لا توجد سيرفرات متاحة');
                        return;
                    }
                    
                    currentServerIndex = index;
                    updateServerList();
                    showStatus('جاري تشغيل ' + servers[index].name + '...');
                    hideError();
                    
                    if (hls) {
                        hls.destroy();
                        hls = null;
                    }
                    
                    const server = servers[index];
                    const manifestUrl = '/get-manifest/${channelName}/' + index;
                    
                    if (Hls.isSupported()) {
                        hls = new Hls({
                            enableWorker: true,
                            lowLatencyMode: true,
                            backBufferLength: 90,
                            maxBufferLength: 30,
                            manifestLoadingTimeOut: 20000,
                            levelLoadingTimeOut: 20000,
                            fragLoadingTimeOut: 20000,
                            xhrSetup: function(xhr, url) {
                                if (url.includes('http')) {
                                    if (server.headers) {
                                        Object.keys(server.headers).forEach(key => {
                                            xhr.setRequestHeader(key, server.headers[key]);
                                        });
                                    }
                                }
                            }
                        });
                        
                        hls.loadSource(manifestUrl);
                        hls.attachMedia(video);
                        
                        hls.on(Hls.Events.MANIFEST_PARSED, function() {
                            hideStatus();
                            video.play().catch(e => {});
                            playBtn.textContent = '⏸';
                        });
                        
                        hls.on(Hls.Events.ERROR, function(event, data) {
                            console.error('خطأ HLS:', data);
                            if (data.fatal) {
                                showError('فشل تشغيل السيرفر، جاري تجربة سيرفر آخر...');
                                setTimeout(() => playServer(index + 1), 2000);
                            }
                        });
                    }
                }
                
                function togglePlay() {
                    if (video.paused) {
                        video.play();
                        playBtn.textContent = '⏸';
                    } else {
                        video.pause();
                        playBtn.textContent = '▶';
                    }
                    showControls();
                }
                
                function reloadVideo() {
                    playServer(currentServerIndex);
                    showControls();
                }
                
                // أحداث
                video.addEventListener('click', () => {
                    if (topBar.classList.contains('hidden')) {
                        showControls();
                    } else {
                        hideControls();
                    }
                });
                
                video.addEventListener('play', () => {
                    playBtn.textContent = '⏸';
                });
                
                video.addEventListener('pause', () => {
                    playBtn.textContent = '▶';
                });
                
                // بدء التشغيل
                updateServerList();
                playServer(0);
                showControls();
            </script>
        </body>
        </html>
    `);
}

// ============ 2. جلب المانيفست مع Single Flight ============
app.get('/get-manifest/:channel/:serverIndex', async (req, res) => {
    const channelName = req.params.channel;
    const serverIndex = parseInt(req.params.serverIndex) || 0;
    const cacheKey = channelName + '_' + serverIndex;
    
    // التحقق من الكاش
    if (manifestCache[cacheKey] && (Date.now() - manifestCache[cacheKey].timestamp < 60000)) {
        console.log('✅ إرسال من الكاش:', cacheKey);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'public, max-age=60');
        return res.send(manifestCache[cacheKey].data);
    }
    
    // التحقق من وجود طلب جاري
    if (pendingRequests[cacheKey]) {
        console.log('⏳ انتظار الطلب الجاري:', cacheKey);
        pendingRequests[cacheKey].waiters.push(res);
        
        setTimeout(() => {
            const index = pendingRequests[cacheKey].waiters.indexOf(res);
            if (index > -1) {
                pendingRequests[cacheKey].waiters.splice(index, 1);
                res.status(408).send('مهلة');
            }
        }, 10000);
        
        return;
    }
    
    // إنشاء طلب جديد
    pendingRequests[cacheKey] = {
        waiters: [res],
        timestamp: Date.now()
    };
    
    const streamInfo = streamDataCache[channelName];
    if (!streamInfo || !streamInfo.servers[serverIndex]) {
        completeRequest(cacheKey, null, 'غير متوفر');
        return;
    }
    
    const server = streamInfo.servers[serverIndex];
    
    try {
        console.log('🔄 جلب جديد من المصدر:', cacheKey);
        
        const headers = {
            'User-Agent': server.headers['User-Agent'] || server.agent || 'Mozilla/5.0',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9'
        };
        
        if (server.headers['Referer']) headers['Referer'] = server.headers['Referer'];
        if (server.headers['Origin']) headers['Origin'] = server.headers['Origin'];
        
        const response = await axios.get(server.url, {
            headers: headers,
            timeout: 15000,
            maxRedirects: 10
        });
        
        let data = response.data;
        
        // تطبيق swap
        let swapKey = '';
        let swapValue = '';
        if (server.swap) {
            swapKey = Object.keys(server.swap)[0];
            swapValue = server.swap[swapKey];
        }
        
        // تعديل الروابط
        const baseUrl = server.url.substring(0, server.url.lastIndexOf('/') + 1);
        
        data = data.replace(/^(?!#)(.*)$/gm, (match) => {
            const trimmedMatch = match.trim();
            if (!trimmedMatch || trimmedMatch.startsWith('#')) return match;
            
            let fullUrl;
            if (trimmedMatch.startsWith('http')) {
                fullUrl = trimmedMatch;
            } else {
                fullUrl = baseUrl + trimmedMatch;
            }
            
            if (swapKey && fullUrl.includes(swapKey)) {
                fullUrl = fullUrl.replace(swapKey, swapValue);
            }
            
            return fullUrl;
        });
        
        // حفظ في الكاش
        manifestCache[cacheKey] = {
            data: data,
            timestamp: Date.now()
        };
        
        completeRequest(cacheKey, data, null);
        
    } catch (error) {
        console.error('❌ خطأ في جلب المانيفست:', error.message);
        completeRequest(cacheKey, null, 'خطأ');
    }
});

app.listen(PORT, () => {
    console.log(`🚀 YTPlus.com Server running on port ${PORT}`);
});
