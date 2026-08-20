const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

let streamDataCache = {};

// 1. مسار عرض المشغل
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
                console.log(`سيرفر ${i + 1}:`, server.name, '-', server.url);
                console.log('الهيدرز:', JSON.stringify(server.headers));
                console.log('الـ swap:', JSON.stringify(server.swap));
            } catch (e) {
                console.error(`خطأ في معالجة السيرفر ${i + 1}:`, e.message);
            }
        }
        
        if (servers.length === 0) {
            return res.status(400).send('لا توجد سيرفرات صالحة');
        }
        
        streamDataCache[channelName] = {
            servers: servers,
            channelName: channelName
        };
        
        // صفحة المشغل
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
                    let servers = [];
                    
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
                    
                    async function loadServers() {
                        try {
                            const response = await fetch('/get-servers/${channelName}');
                            const data = await response.json();
                            servers = data.servers || [];
                            
                            if (servers.length === 0) {
                                showError('لا توجد سيرفرات متاحة');
                                return;
                            }
                            
                            updateServerList();
                            playServer(0);
                        } catch (error) {
                            showError('فشل في تحميل السيرفرات');
                        }
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
                        
                        const proxyUrl = '/proxy-stream/${channelName}?server=' + index;
                        
                        if (Hls.isSupported()) {
                            hls = new Hls({
                                enableWorker: true,
                                lowLatencyMode: true,
                                backBufferLength: 90,
                                maxBufferLength: 30,
                                manifestLoadingTimeOut: 20000,
                                levelLoadingTimeOut: 20000,
                                fragLoadingTimeOut: 20000
                            });
                            
                            hls.loadSource(proxyUrl);
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
                        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                            video.src = proxyUrl;
                            video.addEventListener('loadedmetadata', function() {
                                hideStatus();
                                video.play();
                            });
                        }
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
                    
                    loadServers();
                </script>
            </body>
            </html>
        `);
        
    } catch (error) {
        console.error('خطأ:', error);
        res.status(500).send('حدث خطأ: ' + error.message);
    }
});

// 2. مسار جلب السيرفرات
app.get('/get-servers/:channel', (req, res) => {
    const channelName = req.params.channel;
    const streamInfo = streamDataCache[channelName];
    
    if (!streamInfo) {
        return res.json({ servers: [] });
    }
    
    res.json({ servers: streamInfo.servers });
});

// 3. مسار البروكسي - مع معالجة خاصة للهيدرز
app.get('/proxy-stream/:channel', async (req, res) => {
    const channelName = req.params.channel;
    const serverIndex = parseInt(req.query.server) || 0;
    const streamInfo = streamDataCache[channelName];
    
    if (!streamInfo || !streamInfo.servers[serverIndex]) {
        return res.status(404).send('السيرفر غير متوفر');
    }
    
    const server = streamInfo.servers[serverIndex];
    
    try {
        console.log('=== بدء البروكسي ===');
        console.log('السيرفر:', server.name);
        console.log('الرابط:', server.url);
        
        // بناء الهيدرز بدقة
        const headers = {
            'User-Agent': server.headers['User-Agent'] || server.agent || 'Mozilla/5.0',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
            'Accept-Encoding': 'gzip, deflate, br'
        };
        
        // إضافة Referer و Origin إذا وجدوا
        if (server.headers['Referer']) {
            headers['Referer'] = server.headers['Referer'];
        }
        
        if (server.headers['Origin']) {
            headers['Origin'] = server.headers['Origin'];
        }
        
        // إضافة باقي الهيدرز المخصصة
        if (server.headers) {
            Object.keys(server.headers).forEach(key => {
                if (!headers[key]) {
                    headers[key] = server.headers[key];
                }
            });
        }
        
        // تطبيق swap إذا وجد
        let finalUrl = server.url;
        if (server.swap) {
            const swapKey = Object.keys(server.swap)[0];
            const swapValue = server.swap[swapKey];
            if (swapKey && finalUrl.includes(swapKey)) {
                finalUrl = finalUrl.replace(swapKey, swapValue);
                console.log('تم تطبيق swap:', swapKey, '->', swapValue);
            }
        }
        
        console.log('الرابط النهائي:', finalUrl);
        console.log('الهيدرز النهائية:', JSON.stringify(headers, null, 2));
        
        // جلب البث
        const response = await axios({
            method: 'get',
            url: finalUrl,
            headers: headers,
            responseType: 'stream',
            timeout: 30000,
            maxRedirects: 10,
            validateStatus: function (status) {
                return status >= 200 && status < 500;
            },
            beforeRedirect: (options, responseDetails) => {
                console.log('إعادة توجيه إلى:', responseDetails.headers.location);
            }
        });
        
        console.log('استجابة المصدر:', response.status);
        console.log('نوع المحتوى:', response.headers['content-type']);
        console.log('جميع هيدرز الاستجابة:', JSON.stringify(response.headers, null, 2));
        
        // تحديد نوع المحتوى
        let contentType = response.headers['content-type'] || '';
        const isHlsUrl = finalUrl.includes('.m3u8') || 
                        finalUrl.includes('.html') || 
                        finalUrl.includes('playlist') ||
                        server.mediatype === 'hls' ||
                        contentType.includes('mpegurl') ||
                        contentType.includes('x-mpegurl') ||
                        contentType.includes('text/html');
        
        if (isHlsUrl) {
            contentType = 'application/vnd.apple.mpegurl';
        }
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Access-Control-Allow-Headers', '*');
        
        // جمع البيانات
        let data = '';
        
        response.data.on('data', chunk => {
            data += chunk.toString();
        });
        
        response.data.on('end', () => {
            console.log('=== محتوى الملف ===');
            console.log('الحجم:', data.length);
            console.log('المحتوى:', data.substring(0, 1000));
            console.log('=== نهاية المحتوى ===');
            
            // تحديد الرابط الأساسي
            const baseUrl = finalUrl.substring(0, finalUrl.lastIndexOf('/') + 1);
            
            // معالجة الروابط
            let modifiedData = data;
            
            // تعديل جميع الروابط
            modifiedData = modifiedData.replace(/^(?!#)(.*)$/gm, (match) => {
                const trimmedMatch = match.trim();
                
                if (!trimmedMatch || trimmedMatch.startsWith('#') || trimmedMatch.startsWith('/media-proxy') || trimmedMatch.startsWith('data:')) {
                    return match;
                }
                
                let fullUrl;
                if (trimmedMatch.startsWith('http://') || trimmedMatch.startsWith('https://')) {
                    fullUrl = trimmedMatch;
                } else {
                    fullUrl = baseUrl + trimmedMatch;
                }
                
                const encodedHeaders = encodeURIComponent(JSON.stringify(headers));
                const encodedUrl = encodeURIComponent(fullUrl);
                return '/media-proxy/${channelName}?url=' + encodedUrl + '&headers=' + encodedHeaders;
            });
            
            // تعديل روابط EXT-X-KEY
            modifiedData = modifiedData.replace(/URI="([^"]+)"/g, (match, uri) => {
                if (!uri.startsWith('http') && !uri.startsWith('data:') && !uri.startsWith('/media-proxy')) {
                    const fullUri = baseUrl + uri;
                    const encodedHeaders = encodeURIComponent(JSON.stringify(headers));
                    return 'URI="/media-proxy/${channelName}?url=' + encodeURIComponent(fullUri) + '&headers=' + encodedHeaders + '"';
                }
                return match;
            });
            
            console.log('تم إرسال البيانات المعدلة');
            res.send(modifiedData);
        });
        
        response.data.on('error', (err) => {
            console.error('خطأ في البث:', err);
            if (!res.headersSent) {
                res.status(500).send('خطأ في البث');
            }
        });
        
    } catch (error) {
        console.error('=== خطأ في البروكسي ===');
        console.error('رسالة الخطأ:', error.message);
        if (error.response) {
            console.error('حالة الخطأ:', error.response.status);
            console.error('هيدرز الخطأ:', JSON.stringify(error.response.headers, null, 2));
        }
        res.status(500).send('خطأ: ' + error.message);
    }
});

// 4. مسار وسيط للملفات الفردية
app.get('/media-proxy/:channel', async (req, res) => {
    const targetUrl = req.query.url;
    let headersData = {};
    
    if (req.query.headers) {
        try {
            headersData = JSON.parse(decodeURIComponent(req.query.headers));
        } catch (e) {
            console.error('خطأ في فك الهيدرز:', e);
        }
    }
    
    if (!targetUrl) {
        return res.status(400).send('الرابط غير محدد');
    }
    
    try {
        console.log('جلب ملف:', targetUrl);
        
        const response = await axios({
            method: 'get',
            url: targetUrl,
            headers: headersData,
            responseType: 'stream',
            timeout: 30000,
            maxRedirects: 10
        });
        
        let contentType = response.headers['content-type'] || 'application/octet-stream';
        
        if (targetUrl.includes('.m3u8') || targetUrl.includes('.html') || targetUrl.includes('playlist')) {
            contentType = 'application/vnd.apple.mpegurl';
            
            let data = '';
            
            response.data.on('data', chunk => {
                data += chunk.toString();
            });
            
            response.data.on('end', () => {
                const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
                
                const modifiedData = data.replace(/^(?!#)(.*)$/gm, (match) => {
                    const trimmedMatch = match.trim();
                    
                    if (!trimmedMatch || trimmedMatch.startsWith('#') || trimmedMatch.startsWith('/media-proxy') || trimmedMatch.startsWith('data:')) {
                        return match;
                    }
                    
                    let fullUrl;
                    if (trimmedMatch.startsWith('http://') || trimmedMatch.startsWith('https://')) {
                        fullUrl = trimmedMatch;
                    } else {
                        fullUrl = baseUrl + trimmedMatch;
                    }
                    
                    const encodedHeaders = encodeURIComponent(JSON.stringify(headersData));
                    return '/media-proxy/${channelName}?url=' + encodeURIComponent(fullUrl) + '&headers=' + encodedHeaders;
                });
                
                res.setHeader('Content-Type', contentType);
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.send(modifiedData);
            });
        } else {
            res.setHeader('Content-Type', contentType);
            res.setHeader('Access-Control-Allow-Origin', '*');
            response.data.pipe(res);
        }
        
        response.data.on('error', (err) => {
            console.error('خطأ في الملف:', err);
            if (!res.headersSent) {
                res.status(500).send('خطأ في جلب الملف');
            }
        });
        
    } catch (error) {
        console.error('خطأ في جلب الملف:', error.message);
        res.status(500).send('خطأ في جلب الملف');
    }
});

// مسار اختبار مباشر
app.get('/test-proxy/:channel/:serverIndex', async (req, res) => {
    const channelName = req.params.channel;
    const serverIndex = parseInt(req.params.serverIndex) || 0;
    const streamInfo = streamDataCache[channelName];
    
    if (!streamInfo || !streamInfo.servers[serverIndex]) {
        return res.status(404).send('السيرفر غير متوفر');
    }
    
    const server = streamInfo.servers[serverIndex];
    
    try {
        const headers = {
            'User-Agent': server.headers['User-Agent'] || server.agent || 'Mozilla/5.0',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive'
        };
        
        if (server.headers['Referer']) {
            headers['Referer'] = server.headers['Referer'];
        }
        
        if (server.headers['Origin']) {
            headers['Origin'] = server.headers['Origin'];
        }
        
        let finalUrl = server.url;
        if (server.swap) {
            const swapKey = Object.keys(server.swap)[0];
            const swapValue = server.swap[swapKey];
            if (swapKey && finalUrl.includes(swapKey)) {
                finalUrl = finalUrl.replace(swapKey, swapValue);
            }
        }
        
        const response = await axios.get(finalUrl, {
            headers: headers,
            timeout: 15000,
            maxRedirects: 10
        });
        
        res.json({
            success: true,
            url: finalUrl,
            status: response.status,
            contentType: response.headers['content-type'],
            data: response.data.substring(0, 1000)
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message,
            url: server.url
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
