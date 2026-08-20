const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let streamDataCache = {};
let manifestCache = {}; // تخزين المانيفست فقط

// 1. مسار عرض المشغل
app.get('/play/:channel', async (req, res) => {
    try {
        const channelName = req.params.channel;
        const channelId = `live_tv_${channelName}`;
        
        // التحقق من الكاش أولاً
        if (streamDataCache[channelName] && (Date.now() - streamDataCache[channelName].timestamp < 60000)) {
            return sendPlayerPage(res, channelName, streamDataCache[channelName].servers);
        }
        
        console.log('جاري تحميل القناة:', channelId);
        
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
        
        // حفظ في الكاش
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

// دالة إرسال صفحة المشغل
function sendPlayerPage(res, channelName, servers) {
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
            </style>
        </head>
        <body>
            <div id="videoContainer">
                <video id="video" controls autoplay playsinline></video>
                <div id="status">جاري التحميل...</div>
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
                const serverListEl = document.getElementById('serverList');
                let hls = null;
                let currentServerIndex = 0;
                
                const servers = ${JSON.stringify(servers)};
                
                function showStatus(msg) {
                    status.textContent = msg;
                    status.style.display = 'block';
                }
                
                function hideStatus() {
                    status.style.display = 'none';
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
                    if (index >= servers.length) return;
                    
                    currentServerIndex = index;
                    updateServerList();
                    showStatus('جاري تشغيل ' + servers[index].name + '...');
                    
                    if (hls) {
                        hls.destroy();
                        hls = null;
                    }
                    
                    const server = servers[index];
                    
                    // استخدام proxy فقط للمانيفست الأول
                    const manifestUrl = '/get-manifest/${channelName}/' + index;
                    
                    if (Hls.isSupported()) {
                        hls = new Hls({
                            enableWorker: true,
                            lowLatencyMode: true,
                            xhrSetup: function(xhr, url) {
                                // للطلبات المباشرة
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
                        });
                        
                        hls.on(Hls.Events.ERROR, function(event, data) {
                            if (data.fatal) {
                                setTimeout(() => playServer(index + 1), 2000);
                            }
                        });
                    }
                }
                
                function togglePlay() {
                    if (video.paused) video.play();
                    else video.pause();
                }
                
                function reloadVideo() {
                    playServer(currentServerIndex);
                }
                
                updateServerList();
                playServer(0);
            </script>
        </body>
        </html>
    `);
}

// 2. جلب المانيفست فقط (مرة واحدة لكل مستخدم)
app.get('/get-manifest/:channel/:serverIndex', async (req, res) => {
    const channelName = req.params.channel;
    const serverIndex = parseInt(req.params.serverIndex) || 0;
    
    // التحقق من الكاش
    const cacheKey = channelName + '_' + serverIndex;
    if (manifestCache[cacheKey] && (Date.now() - manifestCache[cacheKey].timestamp < 5000)) {
        return res.send(manifestCache[cacheKey].data);
    }
    
    const streamInfo = streamDataCache[channelName];
    if (!streamInfo || !streamInfo.servers[serverIndex]) {
        return res.status(404).send('غير متوفر');
    }
    
    const server = streamInfo.servers[serverIndex];
    
    try {
        const headers = {
            'User-Agent': server.headers['User-Agent'] || server.agent || 'Mozilla/5.0',
            'Accept': '*/*'
        };
        
        if (server.headers['Referer']) headers['Referer'] = server.headers['Referer'];
        if (server.headers['Origin']) headers['Origin'] = server.headers['Origin'];
        
        const response = await axios.get(server.url, {
            headers: headers,
            timeout: 15000
        });
        
        let data = response.data;
        
        // تطبيق swap
        let swapKey = '';
        let swapValue = '';
        if (server.swap) {
            swapKey = Object.keys(server.swap)[0];
            swapValue = server.swap[swapKey];
        }
        
        // تعديل الروابط لتكون مباشرة
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
            
            // تطبيق swap
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
        
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(data);
        
    } catch (error) {
        res.status(500).send('خطأ');
    }
});

// تنظيف الكاش كل دقيقة
setInterval(() => {
    const now = Date.now();
    
    Object.keys(manifestCache).forEach(key => {
        if (now - manifestCache[key].timestamp > 10000) {
            delete manifestCache[key];
        }
    });
    
    Object.keys(streamDataCache).forEach(key => {
        if (now - streamDataCache[key].timestamp > 300000) {
            delete streamDataCache[key];
        }
    });
}, 60000);

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
