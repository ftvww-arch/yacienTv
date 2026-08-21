const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;

// ==========================================
// 1. محرك الكاش المتقدم (لحماية السيرفر من الضغط)
// ==========================================
const CacheEngine = {
    memory: new Map(),
    inFlight: new Map(),

    async getOrFetch(key, fetcher, ttl) {
        const cached = this.memory.get(key);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.data;
        }

        if (this.inFlight.has(key)) {
            return new Promise((resolve, reject) => {
                this.inFlight.get(key).push({ resolve, reject });
            });
        }

        this.inFlight.set(key, []);
        try {
            const data = await fetcher();
            this.memory.set(key, { data, expiresAt: Date.now() + ttl });
            
            const waiters = this.inFlight.get(key);
            this.inFlight.delete(key);
            waiters.forEach(waiter => waiter.resolve(data));
            
            return data;
        } catch (error) {
            const waiters = this.inFlight.get(key);
            this.inFlight.delete(key);
            waiters.forEach(waiter => waiter.reject(error));
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
// 2. دوال جلب البيانات
// ==========================================
async function fetchChannelServers(channelName) {
    const response = await axios.get(`https://s3-1nft.onrender.com/yacintv/stream`, {
        params: { id_live: `live_tv_${channelName}` },
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000
    });

    const dataArray = Array.isArray(response.data) ? response.data : [response.data];
    const servers = [];

    dataArray.forEach((srv, i) => {
        if (srv.result !== 0 || !srv.data) return;
        try {
            let rawUrl = srv.data.url;
            let innerData = typeof rawUrl === 'string' && rawUrl.trim().startsWith('{') 
                ? JSON.parse(rawUrl.trim()) 
                : { url: rawUrl.trim() };
                
            servers.push({
                name: srv.name || `سيرفر ${i + 1}`,
                url: innerData.url,
                headers: innerData.headers || {},
                swap: innerData.swap || null
            });
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
// 3. المسارات (Routes)
// ==========================================
app.get('/play/:channel', async (req, res) => {
    try {
        const channel = req.params.channel;
        const servers = await CacheEngine.getOrFetch(`servers_${channel}`, () => fetchChannelServers(channel), 300000);
        res.send(generateUI(channel, servers));
    } catch (error) {
        res.status(500).send('<h3 style="text-align:center;margin-top:50px;">القناة غير متوفرة</h3>');
    }
});

app.get('/manifest/:channel/:serverIndex', async (req, res) => {
    try {
        const { channel, serverIndex } = req.params;
        const cacheKey = `manifest_${channel}_${serverIndex}`;
        
        const servers = await CacheEngine.getOrFetch(`servers_${channel}`, () => fetchChannelServers(channel), 300000);
        const serverInfo = servers[parseInt(serverIndex)];
        if (!serverInfo) throw new Error('السيرفر غير موجود');

        // كاش المانيفست لمدة ثانيتين فقط لضمان استمرار البث المباشر (تحديث مستمر للآيفون)
        const manifestData = await CacheEngine.getOrFetch(cacheKey, () => fetchManifest(serverInfo), 2000);

        // إجبار الآيفون والمتصفحات على جلب التحديثات الجديدة وعدم تجميد البث
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        
        res.send(manifestData);
    } catch (error) {
        res.status(500).send('Manifest Error');
    }
});

// ==========================================
// 4. واجهة المستخدم (التصميم البسيط والخفيف)
// ==========================================
function generateUI(channelName, servers) {
    // إنشاء خيارات السيرفرات للقائمة المنسدلة
    const serverOptions = servers.map((srv, idx) => `<option value="${idx}">${srv.name}</option>`).join('');

    return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>${channelName}</title>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <style>
        body { 
            margin: 0; 
            padding: 0; 
            background-color: #000; 
            overflow: hidden; 
            font-family: Arial, sans-serif;
            color: #fff;
        }
        
        /* الشريط العلوي البسيط */
        #top-bar {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 60px;
            background-color: #0d2741; /* أزرق سماوي داكن */
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0 15px;
            box-sizing: border-box;
            z-index: 10;
            border-bottom: 2px solid #FFD700; /* خط أصفر */
        }

        .site-title {
            font-size: 18px;
            font-weight: bold;
            color: #FFD700; /* لون أصفر */
        }

        .server-selector {
            background-color: #000;
            color: #FFD700;
            border: 1px solid #FFD700;
            padding: 8px;
            border-radius: 4px;
            font-size: 14px;
            outline: none;
            cursor: pointer;
        }

        /* حاوية الفيديو */
        #video-container {
            position: absolute;
            top: 60px; /* تحت الشريط العلوي مباشر */
            bottom: 0;
            width: 100%;
            background: #000;
        }

        video {
            width: 100%;
            height: 100%;
            object-fit: contain;
        }
    </style>
</head>
<body>

    <div id="top-bar">
        <div class="site-title">YTPlus | ${channelName}</div>
        <select class="server-selector" id="server-select" onchange="changeServer(this.value)">
            ${serverOptions}
        </select>
    </div>

    <div id="video-container">
        <!-- الخصائص هنا ضرورية جداً لعمل الآيفون بدون مشاكل -->
        <video id="video" controls playsinline webkit-playsinline autoplay></video>
    </div>

    <script>
        const video = document.getElementById('video');
        let hls = null;

        function changeServer(serverIndex) {
            const manifestUrl = '/manifest/${channelName}/' + serverIndex;

            if (hls) {
                hls.destroy();
                hls = null;
            }

            // لأجهزة الأندرويد والكمبيوتر
            if (Hls.isSupported()) {
                hls = new Hls();
                hls.loadSource(manifestUrl);
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, function() {
                    video.play().catch(e => console.log('Autoplay prevented'));
                });
                // ملاحظة: تم حذف أمر إعادة التحميل التلقائي عند الخطأ لمنع التبديل العشوائي
            } 
            // لأجهزة الآيفون (iOS Safari)
            else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = manifestUrl;
                video.addEventListener('loadedmetadata', function() {
                    video.play().catch(e => console.log('Autoplay prevented'));
                });
            }
        }

        // تشغيل السيرفر الأول تلقائياً عند فتح الصفحة
        changeServer(0);
    </script>
</body>
</html>
    `;
}

app.listen(PORT, () => {
    console.log(\`✅ Server running on port \${PORT}\`);
});
