const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;

// متغير لحفظ بيانات البث والهيدرز مؤقتاً لكل قناة
let streamDataCache = {};

// 1. مسار عرض المشغل
app.get('/play/:channel', async (req, res) => {
    try {
        const channelName = req.params.channel;
        
        // جلب البيانات من الـ API
        const apiResponse = await axios.get(`https://s3-1nft.onrender.com/yacintv/last/live_tv_${channelName}`);
        const responseData = apiResponse.data;
        
        if (responseData.result !== 0) {
            return res.status(400).send('فشل في جلب بيانات القناة');
        }

        // فك تشفير البيانات - البيانات موجودة في responseData.data.url كـ string مشفر
        let innerData;
        try {
            // البيانات في responseData.data.url هي string تحتوي على JSON
            innerData = typeof responseData.data.url === 'string' 
                ? JSON.parse(responseData.data.url) 
                : responseData.data.url;
        } catch (e) {
            console.error('فشل في فك تشفير البيانات:', e);
            return res.status(400).send('فشل في فك تشفير بيانات القناة');
        }
        
        // حفظ البيانات في الذاكرة
        streamDataCache[channelName] = {
            url: innerData.url,
            headers: innerData.headers || {},
            agent: innerData.agent || innerData.headers?.['User-Agent'] || 'Mozilla/5.0',
            acceptSSL: innerData.acceptSSL || '1'
        };

        // عرض صفحة المشغل
        res.send(`
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>مشغل البث - ${channelName}</title>
                <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { 
                        background: #000; 
                        font-family: 'Segoe UI', Tahoma, Arial, sans-serif;
                        overflow: hidden;
                        height: 100vh;
                    }
                    #videoContainer {
                        position: relative;
                        width: 100%;
                        height: 100vh;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                    }
                    video { 
                        width: 100%; 
                        height: 100%;
                        object-fit: contain;
                    }
                    
                    /* شريط التحكم العلوي */
                    #topBar {
                        position: absolute;
                        top: 0;
                        left: 0;
                        right: 0;
                        background: linear-gradient(to bottom, rgba(0,0,0,0.8), transparent);
                        padding: 20px;
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        transition: all 0.3s ease;
                        z-index: 10;
                    }
                    
                    /* لوحة التحكم السفلية */
                    #controlBar {
                        position: absolute;
                        bottom: 0;
                        left: 0;
                        right: 0;
                        background: linear-gradient(to top, rgba(0,0,0,0.8), transparent);
                        padding: 20px;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        gap: 20px;
                        transition: all 0.3s ease;
                        z-index: 10;
                    }
                    
                    .btn {
                        width: 50px;
                        height: 50px;
                        border-radius: 50%;
                        background: rgba(255,255,255,0.2);
                        border: 2px solid rgba(255,255,255,0.4);
                        color: white;
                        cursor: pointer;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        font-size: 20px;
                        transition: all 0.3s ease;
                        outline: none;
                    }
                    
                    .btn:hover {
                        background: rgba(255,255,255,0.4);
                        transform: scale(1.1);
                    }
                    
                    .btn:active {
                        transform: scale(0.9);
                    }
                    
                    #playPauseBtn {
                        width: 70px;
                        height: 70px;
                        font-size: 30px;
                    }
                    
                    #liveBadge {
                        background: #E50914;
                        color: white;
                        padding: 5px 15px;
                        border-radius: 20px;
                        font-weight: bold;
                        font-size: 14px;
                    }
                    
                    #title {
                        color: white;
                        font-size: 18px;
                        font-weight: bold;
                    }
                    
                    #serverBtn {
                        padding: 10px 20px;
                        border-radius: 25px;
                        background: rgba(255,255,255,0.2);
                        border: 1px solid rgba(255,255,255,0.4);
                        color: white;
                        cursor: pointer;
                        font-size: 14px;
                        transition: all 0.3s ease;
                    }
                    
                    #serverBtn:hover {
                        background: rgba(255,255,255,0.4);
                    }
                    
                    /* مؤشر التحميل */
                    #loadingIndicator {
                        position: absolute;
                        top: 50%;
                        left: 50%;
                        transform: translate(-50%, -50%);
                        color: white;
                        font-size: 20px;
                        display: none;
                        z-index: 5;
                    }
                    
                    .spinner {
                        border: 4px solid rgba(255,255,255,0.3);
                        border-top: 4px solid white;
                        border-radius: 50%;
                        width: 50px;
                        height: 50px;
                        animation: spin 1s linear infinite;
                        margin: 0 auto 10px;
                    }
                    
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                    
                    /* قائمة السيرفرات */
                    #serverList {
                        position: absolute;
                        bottom: 100px;
                        left: 50%;
                        transform: translateX(-50%);
                        background: rgba(0,0,0,0.9);
                        border-radius: 10px;
                        padding: 10px;
                        display: none;
                        z-index: 20;
                        min-width: 200px;
                    }
                    
                    .server-item {
                        padding: 10px 20px;
                        color: white;
                        cursor: pointer;
                        border-radius: 5px;
                        transition: all 0.3s ease;
                    }
                    
                    .server-item:hover {
                        background: rgba(255,255,255,0.2);
                    }
                    
                    .server-item.active {
                        background: #4CAF50;
                    }
                </style>
            </head>
            <body>
                <div id="videoContainer">
                    <video id="videoPlayer" controls autoplay playsinline></video>
                    
                    <div id="topBar">
                        <div id="liveBadge">مباشر</div>
                        <div id="title">${channelName}</div>
                        <button id="serverBtn" onclick="toggleServerList()">السيرفرات</button>
                    </div>
                    
                    <div id="loadingIndicator">
                        <div class="spinner"></div>
                        <div>جاري التحميل...</div>
                    </div>
                    
                    <div id="controlBar">
                        <button class="btn" id="playPauseBtn" onclick="togglePlay()">⏸</button>
                    </div>
                    
                    <div id="serverList"></div>
                </div>
                
                <script>
                    var video = document.getElementById('videoPlayer');
                    var hls = null;
                    var currentServer = 0;
                    var servers = [];
                    
                    // استخراج جميع السيرفرات من البيانات
                    function extractServers(data) {
                        var serverList = [];
                        
                        function processData(dataObj) {
                            try {
                                if (dataObj.url) {
                                    var urlData = dataObj.url;
                                    // فك التشفير إذا كان JSON
                                    if (typeof urlData === 'string' && urlData.startsWith('{')) {
                                        urlData = JSON.parse(urlData);
                                    }
                                    
                                    var server = {
                                        url: urlData.url || urlData,
                                        headers: urlData.headers || dataObj.headers || {},
                                        agent: urlData.agent || urlData.headers?.['User-Agent'] || dataObj.agent || 'Mozilla/5.0'
                                    };
                                    serverList.push(server);
                                }
                            } catch(e) {
                                console.error('Error extracting server:', e);
                            }
                        }
                        
                        if (Array.isArray(data)) {
                            data.forEach(processData);
                        } else if (typeof data === 'object') {
                            processData(data);
                        }
                        
                        return serverList;
                    }
                    
                    // تحميل السيرفرات من الخادم
                    function loadServers() {
                        fetch('/get-servers/${channelName}')
                            .then(response => response.json())
                            .then(data => {
                                servers = data.servers || [];
                                updateServerList();
                                if (servers.length > 0) {
                                    playServer(0);
                                }
                            })
                            .catch(error => {
                                console.error('Error loading servers:', error);
                                // محاولة التشغيل المباشر من البروكسي
                                playServer(0);
                            });
                    }
                    
                    // تشغيل سيرفر محدد
                    function playServer(index) {
                        if (index >= servers.length) {
                            showError('لا توجد سيرفرات متاحة');
                            return;
                        }
                        
                        currentServer = index;
                        updateServerList();
                        showLoading(true);
                        
                        var videoSrc = '/proxy-stream/${channelName}?server=' + index;
                        
                        if (hls) {
                            hls.destroy();
                            hls = null;
                        }
                        
                        if (Hls.isSupported()) {
                            hls = new Hls({
                                enableWorker: true,
                                lowLatencyMode: true,
                                backBufferLength: 90,
                                maxBufferLength: 30,
                                maxMaxBufferLength: 600,
                                manifestLoadingTimeOut: 10000,
                                levelLoadingTimeOut: 10000,
                                fragLoadingTimeOut: 20000
                            });
                            
                            hls.loadSource(videoSrc);
                            hls.attachMedia(video);
                            
                            hls.on(Hls.Events.MANIFEST_PARSED, function() {
                                showLoading(false);
                                video.play().catch(e => console.log('Auto-play failed:', e));
                                updatePlayButton(true);
                            });
                            
                            hls.on(Hls.Events.ERROR, function(event, data) {
                                if (data.fatal) {
                                    console.error('Fatal HLS error:', data);
                                    showLoading(false);
                                    // الانتقال للسيرفر التالي
                                    if (currentServer < servers.length - 1) {
                                        playServer(currentServer + 1);
                                    } else {
                                        showError('فشل تشغيل البث');
                                    }
                                }
                            });
                        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                            video.src = videoSrc;
                            video.addEventListener('loadedmetadata', function() {
                                showLoading(false);
                                video.play();
                                updatePlayButton(true);
                            });
                        } else {
                            showError('متصفحك لا يدعم تشغيل HLS');
                        }
                    }
                    
                    // تبديل التشغيل/الإيقاف
                    function togglePlay() {
                        if (video.paused) {
                            video.play();
                            updatePlayButton(true);
                        } else {
                            video.pause();
                            updatePlayButton(false);
                        }
                    }
                    
                    function updatePlayButton(isPlaying) {
                        document.getElementById('playPauseBtn').textContent = isPlaying ? '⏸' : '▶';
                    }
                    
                    // عرض/إخفاء مؤشر التحميل
                    function showLoading(show) {
                        document.getElementById('loadingIndicator').style.display = show ? 'block' : 'none';
                    }
                    
                    function showError(message) {
                        document.getElementById('loadingIndicator').innerHTML = 
                            '<div style="color: red; font-size: 24px;">❌</div>' +
                            '<div>' + message + '</div>';
                        document.getElementById('loadingIndicator').style.display = 'block';
                    }
                    
                    // تحديث قائمة السيرفرات
                    function updateServerList() {
                        var serverListEl = document.getElementById('serverList');
                        serverListEl.innerHTML = '';
                        
                        servers.forEach(function(server, index) {
                            var serverName = server.name || ('سيرفر ' + (index + 1));
                            var div = document.createElement('div');
                            div.className = 'server-item' + (index === currentServer ? ' active' : '');
                            div.textContent = serverName;
                            div.onclick = function() {
                                playServer(index);
                                serverListEl.style.display = 'none';
                            };
                            serverListEl.appendChild(div);
                        });
                    }
                    
                    function toggleServerList() {
                        var serverListEl = document.getElementById('serverList');
                        serverListEl.style.display = serverListEl.style.display === 'block' ? 'none' : 'block';
                    }
                    
                    // إخفاء/إظهار أشرطة التحكم
                    var hideTimeout;
                    
                    function showControls() {
                        document.getElementById('topBar').style.opacity = '1';
                        document.getElementById('controlBar').style.opacity = '1';
                        
                        clearTimeout(hideTimeout);
                        hideTimeout = setTimeout(hideControls, 3000);
                    }
                    
                    function hideControls() {
                        if (!video.paused) {
                            document.getElementById('topBar').style.opacity = '0';
                            document.getElementById('controlBar').style.opacity = '0';
                        }
                    }
                    
                    // إظهار عناصر التحكم عند تحريك الماوس
                    document.getElementById('videoContainer').addEventListener('mousemove', showControls);
                    document.getElementById('videoContainer').addEventListener('click', showControls);
                    
                    // بدء التشغيل
                    loadServers();
                    showControls();
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
app.get('/get-servers/:channel', async (req, res) => {
    const channelName = req.params.channel;
    const streamInfo = streamDataCache[channelName];
    
    if (!streamInfo) {
        return res.json({ servers: [] });
    }
    
    // إنشاء قائمة بالسيرفرات المتاحة
    const servers = [{
        name: 'السيرفر الرئيسي',
        url: streamInfo.url,
        headers: streamInfo.headers,
        agent: streamInfo.agent
    }];
    
    res.json({ servers: servers });
});

// 3. مسار البروكسي للبث
app.get('/proxy-stream/:channel', async (req, res) => {
    const channelName = req.params.channel;
    const serverIndex = parseInt(req.query.server) || 0;
    const streamInfo = streamDataCache[channelName];
    
    if (!streamInfo) {
        return res.status(404).send('بيانات البث غير متوفرة');
    }
    
    try {
        // بناء الهيدرز
        const headers = {
            'User-Agent': streamInfo.headers['User-Agent'] || streamInfo.agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
        };
        
        // إضافة باقي الهيدرز
        if (streamInfo.headers) {
            Object.keys(streamInfo.headers).forEach(key => {
                headers[key] = streamInfo.headers[key];
            });
        }
        
        // إرسال الطلب للمصدر
        const response = await axios({
            method: 'get',
            url: streamInfo.url,
            headers: headers,
            responseType: 'stream',
            timeout: 30000,
            maxRedirects: 10,
            validateStatus: function (status) {
                return status >= 200 && status < 400;
            }
        });
        
        // تمرير الهيدرز
        const contentType = response.headers['content-type'] || 'application/vnd.apple.mpegurl';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
        
        // إذا كان الملف m3u8، نعدل الروابط الداخلية
        if (contentType.includes('mpegurl') || contentType.includes('x-mpegurl')) {
            let data = '';
            response.data.on('data', chunk => {
                data += chunk.toString();
            });
            
            response.data.on('end', () => {
                // تعديل الروابط في ملف m3u8
                const baseUrl = streamInfo.url.substring(0, streamInfo.url.lastIndexOf('/') + 1);
                const modifiedData = data.replace(/^(?!#)(.*\.(?:ts|m3u8|m4s|mp4).*)$/gm, (match) => {
                    if (match.startsWith('http')) {
                        return '/proxy-media/${channelName}?url=' + encodeURIComponent(match) + '&headers=' + encodeURIComponent(JSON.stringify(headers));
                    } else {
                        const fullUrl = baseUrl + match;
                        return '/proxy-media/${channelName}?url=' + encodeURIComponent(fullUrl) + '&headers=' + encodeURIComponent(JSON.stringify(headers));
                    }
                });
                res.send(modifiedData);
            });
        } else {
            // للبث المباشر
            response.data.pipe(res);
        }
        
        response.data.on('error', (err) => {
            console.error('خطأ في البث:', err);
            if (!res.headersSent) {
                res.status(500).send('خطأ في البث');
            }
        });
        
    } catch (error) {
        console.error('Proxy Error:', error.message);
        res.status(500).send('خطأ أثناء جلب البث: ' + error.message);
    }
});

// 4. مسار وسيط للملفات الفردية (ts files)
app.get('/proxy-media/:channel', async (req, res) => {
    const channelName = req.params.channel;
    const targetUrl = req.query.url;
    const headersData = req.query.headers ? JSON.parse(decodeURIComponent(req.query.headers)) : {};
    
    if (!targetUrl) {
        return res.status(400).send('الرابط غير محدد');
    }
    
    try {
        const response = await axios({
            method: 'get',
            url: targetUrl,
            headers: headersData,
            responseType: 'stream',
            timeout: 30000,
            maxRedirects: 10
        });
        
        res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp2t');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        response.data.pipe(res);
        
        response.data.on('error', (err) => {
            console.error('خطأ في الملف:', err);
            if (!res.headersSent) {
                res.status(500).send('خطأ في جلب الملف');
            }
        });
        
    } catch (error) {
        console.error('Media Proxy Error:', error.message);
        res.status(500).send('خطأ في جلب الملف');
    }
});

// معالجة الأخطاء العامة
app.use((err, req, res, next) => {
    console.error('خطأ عام:', err);
    res.status(500).send('خطأ في الخادم');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
