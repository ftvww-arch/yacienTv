const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let streamDataCache = {};

// 1. مسار عرض المشغل - يعرض البيانات مباشرة
app.get('/play/:channel', async (req, res) => {
    try {
        const channelName = req.params.channel;
        const channelId = `live_tv_${channelName}`;
        
        console.log('جاري تحميل القناة:', channelId);
        
        const apiResponse = await axios.get(`https://s3-1nft.onrender.com/yacintv/stream`, {
            params: { id_live: channelId },
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
            
            if (serverData.result !== 0 || !serverData.data) {
                continue;
            }
            
            try {
                let innerData;
                let rawUrl = serverData.data.url;
                
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
                
                const server = {
                    name: serverData.name || serverData.data.name || `سيرفر ${i + 1}`,
                    url: innerData.url,
                    headers: innerData.headers || {},
                    agent: innerData.agent || innerData.headers?.['User-Agent'] || 'Mozilla/5.0',
                    mediatype: innerData.mediatype || 'auto',
                    drm: innerData.drm || null,
                    swap: innerData.swap || null,
                    acceptSSL: innerData.acceptSSL || '1'
                };
                
                servers.push(server);
            } catch (e) {
                console.error(`خطأ في معالجة السيرفر ${i + 1}:`, e.message);
            }
        }
        
        if (servers.length === 0) {
            return res.status(400).send('لا توجد سيرفرات صالحة');
        }
        
        // حفظ البيانات
        streamDataCache[channelName] = { servers };
        
        // إرسال صفحة مع بيانات السيرفرات مباشرة
        res.send(`
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>مشغل ${channelName}</title>
                <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { 
                        background: #000; 
                        font-family: Arial, sans-serif;
                        height: 100vh;
                        overflow: hidden;
                    }
                    #videoContainer {
                        position: relative;
                        width: 100%;
                        height: 100%;
                    }
                    video { 
                        width: 100%; 
                        height: 100%;
                        object-fit: contain;
                    }
                    #status {
                        position: absolute;
                        top: 20px;
                        left: 50%;
                        transform: translateX(-50%);
                        background: rgba(0,0,0,0.8);
                        color: white;
                        padding: 10px 20px;
                        border-radius: 20px;
                        display: none;
                        z-index: 100;
                    }
                    #serverList {
                        position: absolute;
                        bottom: 80px;
                        left: 50%;
                        transform: translateX(-50%);
                        background: rgba(0,0,0,0.9);
                        border-radius: 10px;
                        padding: 10px;
                        display: none;
                        z-index: 100;
                        max-height: 300px;
                        overflow-y: auto;
                        min-width: 250px;
                    }
                    .server-item {
                        padding: 12px 20px;
                        color: white;
                        cursor: pointer;
                        border-radius: 5px;
                        transition: all 0.3s;
                    }
                    .server-item:hover {
                        background: rgba(255,255,255,0.2);
                    }
                    .server-item.active {
                        background: #4CAF50;
                    }
                    #controls {
                        position: absolute;
                        bottom: 20px;
                        left: 50%;
                        transform: translateX(-50%);
                        display: flex;
                        gap: 20px;
                        z-index: 100;
                    }
                    .btn {
                        width: 60px;
                        height: 60px;
                        border-radius: 50%;
                        background: rgba(255,255,255,0.2);
                        border: 2px solid rgba(255,255,255,0.4);
                        color: white;
                        cursor: pointer;
                        font-size: 24px;
                    }
                    .btn:hover {
                        background: rgba(255,255,255,0.4);
                    }
                    #errorMsg {
                        position: absolute;
                        top: 50%;
                        left: 50%;
                        transform: translate(-50%, -50%);
                        color: white;
                        text-align: center;
                        display: none;
                        z-index: 100;
                        background: rgba(0,0,0,0.8);
                        padding: 20px;
                        border-radius: 10px;
                    }
                </style>
            </head>
            <body>
                <div id="videoContainer">
                    <video id="video" controls autoplay playsinline></video>
                    <div id="status">جاري التحميل...</div>
                    <div id="errorMsg"></div>
                    <div id="serverList"></div>
                    <div id="controls">
                        <button class="btn" onclick="toggleServers()">📡</button>
                        <button class="btn" onclick="togglePlay()">⏯</button>
                        <button class="btn" onclick="reloadVideo()">🔄</button>
                    </div>
                </div>
                
                <script>
                    const video = document.getElementById('video');
                    const status = document.getElementById('status');
                    const errorMsg = document.getElementById('errorMsg');
                    const serverListEl = document.getElementById('serverList');
                    let hls = null;
                    let currentServerIndex = 0;
                    
                    // بيانات السيرفرات مباشرة
                    const servers = ${JSON.stringify(servers)};
                    
                    function showStatus(msg) {
                        status.textContent = msg;
                        status.style.display = 'block';
                    }
                    
                    function hideStatus() {
                        status.style.display = 'none';
                    }
                    
                    function showError(msg) {
                        errorMsg.innerHTML = msg;
                        errorMsg.style.display = 'block';
                    }
                    
                    function updateServerList() {
                        serverListEl.innerHTML = '';
                        servers.forEach((server, index) => {
                            const div = document.createElement('div');
                            div.className = 'server-item' + (index === currentServerIndex ? ' active' : '');
                            div.textContent = server.name;
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
                        
                        if (hls) {
                            hls.destroy();
                            hls = null;
                        }
                        
                        const server = servers[index];
                        
                        // تطبيق swap
                        let finalUrl = server.url;
                        let swapKey = '';
                        let swapValue = '';
                        
                        if (server.swap) {
                            swapKey = Object.keys(server.swap)[0];
                            swapValue = server.swap[swapKey];
                        }
                        
                        // إنشاء blob URL للـ m3u8 المعدل
                        fetch(server.url, {
                            headers: server.headers || {}
                        })
                        .then(response => response.text())
                        .then(data => {
                            // تحديد الرابط الأساسي
                            const baseUrl = server.url.substring(0, server.url.lastIndexOf('/') + 1);
                            
                            // تعديل الروابط مع تطبيق swap
                            const modifiedData = data.replace(/^(?!#)(.*)$/gm, (match) => {
                                const trimmedMatch = match.trim();
                                
                                if (!trimmedMatch || trimmedMatch.startsWith('#')) {
                                    return match;
                                }
                                
                                let fullUrl;
                                if (trimmedMatch.startsWith('http://') || trimmedMatch.startsWith('https://')) {
                                    fullUrl = trimmedMatch;
                                } else {
                                    fullUrl = baseUrl + trimmedMatch;
                                }
                                
                                // تطبيق swap
                                if (swapKey && fullUrl.includes(swapKey)) {
                                    fullUrl = fullUrl.replace(swapKey, swapValue);
                                }
                                
                                return fullUrl;
                            });
                            
                            // إنشاء Blob URL
                            const blob = new Blob([modifiedData], { type: 'application/vnd.apple.mpegurl' });
                            const blobUrl = URL.createObjectURL(blob);
                            
                            // تشغيل HLS مع XHR مخصص للهيدرز
                            if (Hls.isSupported()) {
                                hls = new Hls({
                                    enableWorker: true,
                                    lowLatencyMode: true,
                                    xhrSetup: function(xhr, url) {
                                        // إضافة الهيدرز للطلبات
                                        if (server.headers) {
                                            Object.keys(server.headers).forEach(key => {
                                                xhr.setRequestHeader(key, server.headers[key]);
                                            });
                                        }
                                    }
                                });
                                
                                hls.loadSource(blobUrl);
                                hls.attachMedia(video);
                                
                                hls.on(Hls.Events.MANIFEST_PARSED, function() {
                                    hideStatus();
                                    video.play().catch(e => console.log('خطأ في التشغيل:', e));
                                });
                                
                                hls.on(Hls.Events.ERROR, function(event, data) {
                                    console.error('خطأ HLS:', data);
                                    if (data.fatal) {
                                        showError('فشل تشغيل السيرفر، جاري تجربة سيرفر آخر...');
                                        setTimeout(() => playServer(index + 1), 2000);
                                    }
                                });
                            }
                        })
                        .catch(error => {
                            console.error('خطأ في جلب المانيفست:', error);
                            showError('فشل في جلب البيانات');
                        });
                    }
                    
                    function togglePlay() {
                        if (video.paused) {
                            video.play();
                        } else {
                            video.pause();
                        }
                    }
                    
                    function reloadVideo() {
                        playServer(currentServerIndex);
                    }
                    
                    // بدء التشغيل
                    updateServerList();
                    playServer(0);
                </script>
            </body>
            </html>
        `);
        
    } catch (error) {
        console.error('خطأ:', error);
        res.status(500).send('حدث خطأ: ' + error.message);
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
