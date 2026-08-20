const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

const PORT = process.env.PORT || 3000;

// تفعيل CORS
app.use(cors());
app.use(express.json());

// متغير لحفظ بيانات البث
let streamDataCache = {};

// 1. مسار عرض المشغل
app.get('/play/:channel', async (req, res) => {
    try {
        const channelName = req.params.channel;
        
        // جلب البيانات من الـ API
        const apiResponse = await axios.get(`https://s3-1nft.onrender.com/yacintv/last/live_tv_${channelName}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json'
            }
        });
        
        const responseData = apiResponse.data;
        
        if (responseData.result !== 0) {
            return res.status(400).send('فشل في جلب بيانات القناة');
        }

        // فك تشفير البيانات
        let innerData;
        try {
            innerData = typeof responseData.data.url === 'string' 
                ? JSON.parse(responseData.data.url) 
                : responseData.data.url;
        } catch (e) {
            console.error('فشل في فك التشفير:', e);
            return res.status(400).send('فشل في فك تشفير بيانات القناة');
        }
        
        // حفظ البيانات
        streamDataCache[channelName] = {
            url: innerData.url,
            headers: innerData.headers || {},
            agent: innerData.agent || innerData.headers?.['User-Agent'] || 'Mozilla/5.0',
            acceptSSL: innerData.acceptSSL || '1'
        };

        console.log('تم تحميل بيانات القناة:', channelName);
        console.log('الرابط:', innerData.url);
        console.log('الهيدرز:', JSON.stringify(innerData.headers));

        // عرض صفحة مشغل بسيطة
        res.send(`
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>مشغل ${channelName}</title>
                <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
                <style>
                    body { 
                        background: #000; 
                        margin: 0; 
                        font-family: Arial, sans-serif;
                        height: 100vh;
                        display: flex;
                        flex-direction: column;
                    }
                    #videoContainer {
                        position: relative;
                        flex: 1;
                        display: flex;
                        justify-content: center;
                        align-items: center;
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
                        background: rgba(0,0,0,0.7);
                        color: white;
                        padding: 10px 20px;
                        border-radius: 20px;
                        display: none;
                        z-index: 100;
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
                    }
                    .btn {
                        background: #4CAF50;
                        color: white;
                        border: none;
                        padding: 10px 20px;
                        margin: 10px;
                        border-radius: 5px;
                        cursor: pointer;
                        font-size: 16px;
                    }
                    .btn:hover {
                        background: #45a049;
                    }
                </style>
            </head>
            <body>
                <div id="videoContainer">
                    <video id="video" controls autoplay playsinline></video>
                    <div id="status">جاري التحميل...</div>
                    <div id="errorMsg"></div>
                </div>
                
                <script>
                    const video = document.getElementById('video');
                    const status = document.getElementById('status');
                    const errorMsg = document.getElementById('errorMsg');
                    let hls = null;
                    
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
                    
                    async function startPlayback() {
                        showStatus('جاري تحميل البث...');
                        
                        try {
                            // استخدام البروكسي المباشر
                            const proxyUrl = '/direct-proxy/${channelName}';
                            console.log('محاولة التشغيل من:', proxyUrl);
                            
                            if (Hls.isSupported()) {
                                if (hls) {
                                    hls.destroy();
                                }
                                
                                hls = new Hls({
                                    enableWorker: true,
                                    lowLatencyMode: true,
                                    backBufferLength: 90,
                                    maxBufferLength: 30,
                                    manifestLoadingTimeOut: 20000,
                                    levelLoadingTimeOut: 20000,
                                    fragLoadingTimeOut: 20000,
                                    xhrSetup: function(xhr, url) {
                                        // لا نحتاج لإضافة هيدرز هنا لأن السيرفر يضيفها
                                    }
                                });
                                
                                hls.loadSource(proxyUrl);
                                hls.attachMedia(video);
                                
                                hls.on(Hls.Events.MANIFEST_PARSED, function() {
                                    console.log('تم تحميل المانيفست');
                                    hideStatus();
                                    video.play().catch(e => console.log('خطأ في التشغيل:', e));
                                });
                                
                                hls.on(Hls.Events.ERROR, function(event, data) {
                                    console.error('خطأ HLS:', data);
                                    if (data.fatal) {
                                        switch(data.type) {
                                            case Hls.ErrorTypes.NETWORK_ERROR:
                                                showError('خطأ في الشبكة. جاري إعادة المحاولة...');
                                                hls.startLoad();
                                                break;
                                            case Hls.ErrorTypes.MEDIA_ERROR:
                                                showError('خطأ في الوسائط. جاري إعادة المحاولة...');
                                                hls.recoverMediaError();
                                                break;
                                            default:
                                                showError('فشل تشغيل البث: ' + data.details);
                                                hls.destroy();
                                                break;
                                        }
                                    }
                                });
                            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                                video.src = proxyUrl;
                                video.addEventListener('loadedmetadata', function() {
                                    hideStatus();
                                    video.play();
                                });
                            } else {
                                showError('متصفحك لا يدعم تشغيل HLS');
                            }
                        } catch (error) {
                            console.error('خطأ:', error);
                            showError('فشل في بدء التشغيل: ' + error.message);
                        }
                    }
                    
                    // بدء التشغيل
                    startPlayback();
                </script>
            </body>
            </html>
        `);

    } catch (error) {
        console.error('خطأ:', error);
        res.status(500).send('حدث خطأ: ' + error.message);
    }
});

// 2. مسار البروكسي المباشر
app.get('/direct-proxy/:channel', async (req, res) => {
    const channelName = req.params.channel;
    const streamInfo = streamDataCache[channelName];
    
    if (!streamInfo) {
        return res.status(404).send('بيانات البث غير متوفرة');
    }
    
    try {
        console.log('بدء البروكسي للقناة:', channelName);
        console.log('الرابط الأصلي:', streamInfo.url);
        
        // بناء الهيدرز
        const headers = {
            'User-Agent': streamInfo.headers['User-Agent'] || streamInfo.agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
            'Referer': streamInfo.headers['Referer'] || '',
            'Origin': streamInfo.headers['Origin'] || ''
        };
        
        // إضافة باقي الهيدرز
        if (streamInfo.headers) {
            Object.keys(streamInfo.headers).forEach(key => {
                if (!headers[key]) {
                    headers[key] = streamInfo.headers[key];
                }
            });
        }
        
        console.log('الهيدرز المستخدمة:', JSON.stringify(headers));
        
        // جلب البث
        const response = await axios({
            method: 'get',
            url: streamInfo.url,
            headers: headers,
            responseType: 'stream',
            timeout: 30000,
            maxRedirects: 10,
            validateStatus: function (status) {
                return status >= 200 && status < 500;
            }
        });
        
        console.log('استجابة المصدر:', response.status);
        console.log('نوع المحتوى:', response.headers['content-type']);
        
        // تمرير الهيدرز
        const contentType = response.headers['content-type'] || 'application/vnd.apple.mpegurl';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Access-Control-Allow-Headers', '*');
        
        // إذا كان الملف m3u8
        if (contentType.includes('mpegurl') || contentType.includes('x-mpegurl') || streamInfo.url.includes('.m3u8')) {
            let data = '';
            
            response.data.on('data', chunk => {
                data += chunk.toString();
            });
            
            response.data.on('end', () => {
                console.log('تم استلام ملف m3u8');
                console.log('محتوى الملف:', data.substring(0, 500));
                
                // تعديل الروابط
                const baseUrl = streamInfo.url.substring(0, streamInfo.url.lastIndexOf('/') + 1);
                
                let modifiedData = data;
                
                // تعديل الروابط النسبية والمطلقة
                modifiedData = modifiedData.replace(/^(?!#)(.*\.(?:ts|m3u8|m4s|mp4|aac|vtt).*)$/gm, (match) => {
                    let fullUrl;
                    if (match.startsWith('http')) {
                        fullUrl = match;
                    } else {
                        fullUrl = baseUrl + match;
                    }
                    
                    // ترميز الهيدرز
                    const encodedHeaders = encodeURIComponent(JSON.stringify(headers));
                    return '/media-proxy/${channelName}?url=' + encodeURIComponent(fullUrl) + '&headers=' + encodedHeaders;
                });
                
                // تعديل روابط EXT-X-KEY
                modifiedData = modifiedData.replace(/URI="([^"]+)"/g, (match, uri) => {
                    if (!uri.startsWith('http')) {
                        const fullUri = baseUrl + uri;
                        const encodedHeaders = encodeURIComponent(JSON.stringify(headers));
                        return 'URI="/media-proxy/${channelName}?url=' + encodeURIComponent(fullUri) + '&headers=' + encodedHeaders + '"';
                    }
                    return match;
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
        console.error('خطأ في البروكسي:', error.message);
        if (error.response) {
            console.error('استجابة الخطأ:', error.response.status);
        }
        res.status(500).send('خطأ: ' + error.message);
    }
});

// 3. مسار وسيط للملفات الفردية
app.get('/media-proxy/:channel', async (req, res) => {
    const channelName = req.params.channel;
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
        console.error('خطأ في جلب الملف:', error.message);
        res.status(500).send('خطأ في جلب الملف');
    }
});

// اختبار الاتصال
app.get('/test/:channel', async (req, res) => {
    const channelName = req.params.channel;
    const streamInfo = streamDataCache[channelName];
    
    if (!streamInfo) {
        return res.json({ error: 'لا توجد بيانات للقناة' });
    }
    
    try {
        const headers = {
            'User-Agent': streamInfo.headers['User-Agent'] || streamInfo.agent,
            'Referer': streamInfo.headers['Referer'] || '',
            'Origin': streamInfo.headers['Origin'] || ''
        };
        
        const testResponse = await axios.head(streamInfo.url, {
            headers: headers,
            timeout: 10000,
            maxRedirects: 5
        });
        
        res.json({
            success: true,
            status: testResponse.status,
            headers: testResponse.headers,
            url: streamInfo.url,
            streamHeaders: headers
        });
    } catch (error) {
        res.json({
            success: false,
            error: error.message,
            url: streamInfo.url
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
