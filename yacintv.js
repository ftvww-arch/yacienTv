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
            // أول محاولة: تحويل النص إلى JSON مباشرة
            innerData = typeof responseData.data.url === 'string' 
                ? JSON.parse(responseData.data.url) 
                : responseData.data.url;
        } catch (e) {
            // إذا فشل، حاول استخدام decodeURIComponent أولاً
            try {
                innerData = JSON.parse(decodeURIComponent(responseData.data.url));
            } catch (e2) {
                console.error('فشل في فك تشفير البيانات:', e2);
                return res.status(400).send('فشل في فك تشفير بيانات القناة');
            }
        }
        
        // حفظ الرابط والهيدرز في الذاكرة لكي يستخدمها البروكسي
        streamDataCache[channelName] = {
            url: innerData.url,
            headers: innerData.headers || {}
        };

        // عرض صفحة المشغل
        res.send(`
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <title>مشغل البث - ${channelName}</title>
                <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
                <style>
                    body { 
                        background: #000; 
                        margin: 0; 
                        display: flex; 
                        justify-content: center; 
                        align-items: center; 
                        height: 100vh; 
                    }
                    video { 
                        width: 100%; 
                        max-height: 100vh; 
                    }
                </style>
            </head>
            <body>
                <video id="videoPlayer" controls autoplay></video>
                <script>
                    var video = document.getElementById('videoPlayer');
                    var videoSrc = "/proxy/${channelName}";
                    
                    if (Hls.isSupported()) {
                        var hls = new Hls({
                            enableWorker: true,
                            lowLatencyMode: true,
                            backBufferLength: 90
                        });
                        hls.loadSource(videoSrc);
                        hls.attachMedia(video);
                        hls.on(Hls.Events.MANIFEST_PARSED, function() {
                            video.play().catch(e => console.log('خطأ في التشغيل:', e));
                        });
                        hls.on(Hls.Events.ERROR, function(event, data) {
                            if (data.fatal) {
                                console.error('خطأ HLS:', data);
                            }
                        });
                    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                        video.src = videoSrc;
                        video.addEventListener('loadedmetadata', function() {
                            video.play().catch(e => console.log('خطأ في التشغيل:', e));
                        });
                    }
                </script>
            </body>
            </html>
        `);

    } catch (error) {
        console.error('خطأ:', error);
        res.status(500).send('حدث خطأ: ' + error.message);
    }
});

// 2. مسار البروكسي (الوسيط) الذي يقوم بالحقن الفعلي
app.get('/proxy/:channel', async (req, res) => {
    const channelName = req.params.channel;
    const streamInfo = streamDataCache[channelName];

    if (!streamInfo) {
        return res.status(404).send('بيانات البث غير متوفرة، يرجى تحديث الصفحة.');
    }

    try {
        // إعداد الهيدرز مع القيم الافتراضية إذا لم تكن موجودة
        const headers = {
            'User-Agent': streamInfo.headers['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': streamInfo.headers['Referer'] || '',
            'Origin': streamInfo.headers['Origin'] || '',
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
        };

        // إرسال الطلب للمصدر مع حقن الهيدرز
        const response = await axios({
            method: 'get',
            url: streamInfo.url,
            headers: headers,
            responseType: 'stream',
            timeout: 30000, // 30 ثانية timeout
            maxRedirects: 5,
        });

        // تمرير هيدرز نوع المحتوى للمتصفح
        const contentType = response.headers['content-type'] || 'application/vnd.apple.mpegurl';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
        
        // إذا كان الملف m3u8، نحتاج لتعديل الروابط الداخلية
        if (contentType.includes('mpegurl') || contentType.includes('x-mpegurl')) {
            let data = '';
            response.data.on('data', chunk => {
                data += chunk.toString();
            });
            
            response.data.on('end', () => {
                // تعديل الروابط في ملف m3u8 لتشير إلى البروكسي
                const modifiedData = data.replace(/^(https?:\/\/.*)$/gm, (match) => {
                    return `/proxy-stream/${channelName}?url=${encodeURIComponent(match)}`;
                });
                res.send(modifiedData);
            });
        } else {
            // للبث المباشر (ts files)
            response.data.pipe(res);
        }

        // معالجة الأخطاء في البث
        response.data.on('error', (err) => {
            console.error('خطأ في البث:', err);
            if (!res.headersSent) {
                res.status(500).send('خطأ في البث');
            }
        });

    } catch (error) {
        console.error('Proxy Error:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
        }
        res.status(500).send('خطأ أثناء جلب البث المباشر من المصدر: ' + error.message);
    }
});

// 3. مسار إضافي للتعامل مع ملفات ts والمقاطع
app.get('/proxy-stream/:channel', async (req, res) => {
    const channelName = req.params.channel;
    const streamInfo = streamDataCache[channelName];
    const targetUrl = req.query.url;

    if (!streamInfo || !targetUrl) {
        return res.status(404).send('البيانات غير متوفرة');
    }

    try {
        const headers = {
            'User-Agent': streamInfo.headers['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': streamInfo.headers['Referer'] || '',
            'Origin': streamInfo.headers['Origin'] || '',
            'Accept': '*/*',
        };

        const response = await axios({
            method: 'get',
            url: targetUrl,
            headers: headers,
            responseType: 'stream',
            timeout: 30000,
        });

        res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp2t');
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        response.data.pipe(res);

        response.data.on('error', (err) => {
            console.error('خطأ في البث الجزئي:', err);
            if (!res.headersSent) {
                res.status(500).send('خطأ في البث');
            }
        });

    } catch (error) {
        console.error('Proxy Stream Error:', error.message);
        res.status(500).send('خطأ في جلب المقطع');
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
