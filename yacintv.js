const express = require('express');
const axios = require('axios');
const app = express();

const PORT = process.env.PORT || 3000;

// ==========================================
// 1. محرك الكاش الذكي ونظام دمج الطلبات (Single Flight)
// ==========================================
const CacheEngine = {
    memory: new Map(),
    inFlight: new Map(),

    /**
     * الدالة السحرية: تدمج آلاف الطلبات في طلب واحد
     * @param {string} key - مفتاح الكاش (مثل اسم القناة)
     * @param {function} fetcher - الدالة التي تجلب البيانات من المصدر
     * @param {number} ttl - مدة بقاء الكاش بالملي ثانية
     */
    async getOrFetch(key, fetcher, ttl) {
        // 1. التحقق من الكاش المتوفر والصالح
        const cached = this.memory.get(key);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.data;
        }

        // 2. إذا كان هناك طلب يجري حالياً لنفس المفتاح، ضع المستخدم في الطابور (هنا يحدث السحر)
        if (this.inFlight.has(key)) {
            return new Promise((resolve, reject) => {
                this.inFlight.get(key).push({ resolve, reject });
            });
        }

        // 3. أنت المستخدم الأول! أنشئ طابوراً وقم بالطلب الفعلي
        this.inFlight.set(key, []);
        try {
            const data = await fetcher();
            
            // حفظ النتيجة في الكاش
            this.memory.set(key, { data, expiresAt: Date.now() + ttl });
            
            // توزيع النتيجة على جميع المنتظرين في الطابور في نفس اللحظة
            const waiters = this.inFlight.get(key);
            this.inFlight.delete(key);
            waiters.forEach(waiter => waiter.resolve(data));
            
            return data;
        } catch (error) {
            // في حال الفشل، إبلاغ جميع المنتظرين بالخطأ
            const waiters = this.inFlight.get(key);
            this.inFlight.delete(key);
            waiters.forEach(waiter => waiter.reject(error));
            throw error;
        }
    }
};

// تنظيف دوري للكاش منتهي الصلاحية لتخفيف الذاكرة
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of CacheEngine.memory.entries()) {
        if (now > value.expiresAt) CacheEngine.memory.delete(key);
    }
}, 60000);

// ==========================================
// 2. دوال جلب البيانات من المصدر
// ==========================================

// جلب سيرفرات القناة
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
        } catch (e) { /* تجاهل السيرفرات التالفة */ }
    });

    if (servers.length === 0) throw new Error('لا توجد سيرفرات');
    return servers;
}

// جلب وتعديل ملف m3u8
async function fetchManifest(serverInfo) {
    const headers = { 'User-Agent': serverInfo.headers['User-Agent'] || 'Mozilla/5.0' };
    if (serverInfo.headers['Referer']) headers['Referer'] = serverInfo.headers['Referer'];

    const response = await axios.get(serverInfo.url, { headers, timeout: 10000 });
    let m3u8 = response.data;
    
    // تعديل الروابط الداخلية لتصبح روابط كاملة (Absolute URLs)
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
// 3. مسارات التطبيق (Routes)
// ==========================================

app.get('/play/:channel', async (req, res) => {
    try {
        const channel = req.params.channel;
        
        // جلب السيرفرات مع نظام الدمج (كاش لمدة دقيقة)
        const servers = await CacheEngine.getOrFetch(
            `servers_${channel}`, 
            () => fetchChannelServers(channel), 
            60000
        );

        // إرسال صفحة المشغل
        res.send(generateUI(channel, servers));
    } catch (error) {
        res.status(500).send('<h2 style="color:white;text-align:center;font-family:sans-serif;margin-top:20vh;">عذراً، القناة غير متوفرة حالياً</h2>');
    }
});

app.get('/manifest/:channel/:serverIndex', async (req, res) => {
    try {
        const { channel, serverIndex } = req.params;
        const cacheKey = `manifest_${channel}_${serverIndex}`;
        
        // يجب أن نجلب بيانات السيرفر أولاً من الكاش لمعرفة الرابط
        const servers = await CacheEngine.getOrFetch(`servers_${channel}`, () => fetchChannelServers(channel), 60000);
        const serverInfo = servers[parseInt(serverIndex)];
        
        if (!serverInfo) throw new Error('السيرفر غير موجود');

        // جلب المانيفست بنظام الدمج لآلاف المستخدمين (كاش لمدة 10 ثواني فقط لتحديث البث المباشر)
        const manifestData = await CacheEngine.getOrFetch(
            cacheKey,
            () => fetchManifest(serverInfo),
            10000
        );

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'public, max-age=5');
        res.send(manifestData);
    } catch (error) {
        res.status(500).send('Manifest Error');
    }
});

// ==========================================
// 4. واجهة المستخدم (الجديدة كلياً)
// ==========================================
function generateUI(channelName, servers) {
    return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>البث المباشر | ${channelName}</title>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <style>
        :root {
            /* الألوان الاحترافية المطلوبة */
            --bg-color: #071527; /* أزرق سماوي داكن */
            --primary: #FFD700; /* أصفر */
            --primary-hover: #E6C200;
            --text-main: #FFFFFF;
            --overlay-bg: rgba(7, 21, 39, 0.7);
        }

        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        
        body { background-color: #000; width: 100vw; height: 100vh; overflow: hidden; display: flex; justify-content: center; align-items: center; }
        
        #player-wrapper { position: relative; width: 100%; height: 100%; background: #000; }
        
        video { width: 100%; height: 100%; object-fit: contain; }
        
        /* شريط التحكم المخصص */
        .controls-container {
            position: absolute; bottom: 0; left: 0; right: 0;
            background: linear-gradient(0deg, var(--bg-color) 0%, transparent 100%);
            padding: 40px 20px 20px;
            display: flex; flex-direction: column; gap: 15px;
            transition: opacity 0.4s ease, transform 0.4s ease;
            z-index: 100;
        }

        .controls-container.hidden { opacity: 0; transform: translateY(20px); pointer-events: none; }

        .top-info {
            position: absolute; top: 0; left: 0; right: 0;
            padding: 20px;
            background: linear-gradient(180deg, var(--bg-color) 0%, transparent 100%);
            display: flex; justify-content: space-between; align-items: center;
            z-index: 100; transition: opacity 0.4s ease;
        }
        .top-info.hidden { opacity: 0; pointer-events: none; }

        .channel-title { color: var(--text-main); font-size: 20px; font-weight: 700; text-shadow: 0 2px 4px rgba(0,0,0,0.5); }
        
        .live-indicator {
            background: rgba(255, 0, 0, 0.15); border: 1px solid red; color: red;
            padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: bold;
            display: flex; align-items: center; gap: 6px;
        }
        .live-indicator::before {
            content: ''; width: 8px; height: 8px; background: red; border-radius: 50%;
            animation: blink 1.5s infinite;
        }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

        .buttons-row { display: flex; align-items: center; justify-content: space-between; }
        .left-controls, .right-controls { display: flex; align-items: center; gap: 15px; }

        .icon-btn {
            background: transparent; border: none; cursor: pointer; color: var(--text-main);
            display: flex; justify-content: center; align-items: center;
            width: 45px; height: 45px; border-radius: 50%;
            transition: all 0.2s ease;
        }
        .icon-btn:hover { background: rgba(255,255,255,0.1); color: var(--primary); }
        .icon-btn svg { width: 28px; height: 28px; fill: currentColor; }
        
        /* زر التشغيل الكبير */
        .play-btn { background: var(--primary); color: var(--bg-color); }
        .play-btn:hover { background: var(--primary-hover); color: var(--bg-color); transform: scale(1.05); }

        /* نافذة السيرفرات */
        .servers-modal {
            position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.95);
            background: var(--bg-color); border: 1px solid rgba(255,255,255,0.1);
            border-radius: 16px; width: 90%; max-width: 400px;
            padding: 20px; opacity: 0; pointer-events: none; z-index: 200;
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            box-shadow: 0 20px 40px rgba(0,0,0,0.6);
        }
        .servers-modal.active { opacity: 1; pointer-events: auto; transform: translate(-50%, -50%) scale(1); }
        
        .modal-title { color: var(--primary); font-size: 18px; font-weight: bold; margin-bottom: 15px; text-align: center; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 10px; }
        
        .server-item {
            background: var(--overlay-bg); color: var(--text-main);
            padding: 14px; border-radius: 10px; margin-bottom: 8px;
            cursor: pointer; display: flex; align-items: center; gap: 10px;
            transition: all 0.2s ease; border: 1px solid transparent;
        }
        .server-item:hover { background: rgba(255,255,255,0.05); }
        .server-item.active { border-color: var(--primary); color: var(--primary); font-weight: bold; }

        /* اللودر السلس */
        .loader {
            position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
            display: none; z-index: 150;
        }
        .loader svg { width: 50px; height: 50px; animation: rotate 2s linear infinite; }
        .loader circle { stroke: var(--primary); stroke-width: 4; stroke-dasharray: 1, 200; stroke-dashoffset: 0; animation: dash 1.5s ease-in-out infinite, color 6s ease-in-out infinite; stroke-linecap: round; fill: none;}
        @keyframes rotate { 100% { transform: rotate(360deg); } }
        @keyframes dash { 0% { stroke-dasharray: 1, 200; stroke-dashoffset: 0; } 50% { stroke-dasharray: 89, 200; stroke-dashoffset: -35px; } 100% { stroke-dasharray: 89, 200; stroke-dashoffset: -124px; } }

    </style>
</head>
<body>

<div id="player-wrapper">
    <video id="video-element" playsinline></video>
    
    <div class="loader" id="loader">
        <svg viewBox="25 25 50 50"><circle cx="50" cy="50" r="20"></circle></svg>
    </div>

    <div class="top-info" id="top-bar">
        <div class="channel-title">${channelName}</div>
        <div class="live-indicator">مباشر</div>
    </div>

    <div class="servers-modal" id="servers-modal">
        <div class="modal-title">اختر جودة / سيرفر البث</div>
        <div id="servers-list"></div>
    </div>

    <div class="controls-container" id="controls">
        <div class="buttons-row">
            <div class="right-controls">
                <button class="icon-btn play-btn" id="play-pause-btn">
                    <!-- أيقونة التشغيل -->
                    <svg id="icon-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                    <!-- أيقونة التوقف -->
                    <svg id="icon-pause" viewBox="0 0 24 24" style="display:none;"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                </button>
            </div>
            <div class="left-controls">
                <button class="icon-btn" onclick="toggleServersModal()" title="السيرفرات">
                    <svg viewBox="0 0 24 24"><path d="M3 4h18v4H3zM3 10h18v4H3zM3 16h18v4H3z"/></svg>
                </button>
                <button class="icon-btn" id="fullscreen-btn" title="ملء الشاشة">
                    <svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
                </button>
            </div>
        </div>
    </div>
</div>

<script>
    const video = document.getElementById('video-element');
    const controls = document.getElementById('controls');
    const topBar = document.getElementById('top-bar');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const iconPlay = document.getElementById('icon-play');
    const iconPause = document.getElementById('icon-pause');
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const loader = document.getElementById('loader');
    const serversModal = document.getElementById('servers-modal');
    const serversList = document.getElementById('servers-list');
    
    let hls = null;
    let currentServer = 0;
    let uiTimeout;
    const servers = ${JSON.stringify(servers)};

    // -- إدارة الواجهة --
    function resetUITimer() {
        controls.classList.remove('hidden');
        topBar.classList.remove('hidden');
        clearTimeout(uiTimeout);
        if (!video.paused) {
            uiTimeout = setTimeout(() => {
                controls.classList.add('hidden');
                topBar.classList.add('hidden');
                serversModal.classList.remove('active');
            }, 3000);
        }
    }

    document.getElementById('player-wrapper').addEventListener('mousemove', resetUITimer);
    document.getElementById('player-wrapper').addEventListener('touchstart', resetUITimer);
    document.getElementById('player-wrapper').addEventListener('click', resetUITimer);

    // -- التشغيل والإيقاف --
    playPauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (video.paused) video.play();
        else video.pause();
    });

    video.addEventListener('play', () => { iconPlay.style.display = 'none'; iconPause.style.display = 'block'; resetUITimer(); });
    video.addEventListener('pause', () => { iconPlay.style.display = 'block'; iconPause.style.display = 'none'; clearTimeout(uiTimeout); controls.classList.remove('hidden'); topBar.classList.remove('hidden'); });
    
    video.addEventListener('waiting', () => loader.style.display = 'block');
    video.addEventListener('playing', () => loader.style.display = 'none');

    // -- ملء الشاشة --
    fullscreenBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wrapper = document.getElementById('player-wrapper');
        if (!document.fullscreenElement) {
            if (wrapper.requestFullscreen) wrapper.requestFullscreen();
            else if (wrapper.webkitRequestFullscreen) wrapper.webkitRequestFullscreen(); // للايفون
        } else {
            if (document.exitFullscreen) document.exitFullscreen();
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        }
    });

    // -- السيرفرات --
    function toggleServersModal() {
        serversModal.classList.toggle('active');
    }

    function renderServers() {
        serversList.innerHTML = '';
        servers.forEach((srv, index) => {
            const div = document.createElement('div');
            div.className = 'server-item' + (index === currentServer ? ' active' : '');
            div.innerHTML = \`<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg> \${srv.name}\`;
            div.onclick = (e) => {
                e.stopPropagation();
                currentServer = index;
                serversModal.classList.remove('active');
                renderServers();
                initPlayer();
            };
            serversList.appendChild(div);
        });
    }

    // -- المحرك الأساسي للتشغيل --
    function initPlayer() {
        loader.style.display = 'block';
        if (hls) { hls.destroy(); hls = null; }

        const manifestUrl = '/manifest/${channelName}/' + currentServer;

        // للاندرويد والكمبيوتر
        if (Hls.isSupported()) {
            hls = new Hls({ maxBufferSize: 0, maxBufferLength: 15, liveSyncDuration: 3 });
            hls.loadSource(manifestUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => { loader.style.display = 'none'; video.play().catch(e=>console.log(e)); });
            hls.on(Hls.Events.ERROR, (e, data) => {
                if (data.fatal) { setTimeout(() => initPlayer(), 3000); }
            });
        } 
        // للايفون (Native)
        else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = manifestUrl;
            video.addEventListener('loadedmetadata', () => { loader.style.display = 'none'; video.play().catch(e=>console.log(e)); });
        }
    }

    // التهيئة الأولى
    renderServers();
    initPlayer();
    resetUITimer();
</script>
</body>
</html>
    `;
}

app.listen(PORT, () => {
    console.log(\`✅ Player is running on port \${PORT} with Single-Flight Architecture\`);
});
