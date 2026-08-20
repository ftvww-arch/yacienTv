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

        // فك تشفير البيانات لاستخراج الرابط والهيدرز
        const innerData = JSON.parse(responseData.data.url);
        
        // حفظ الرابط والهيدرز في الذاكرة لكي يستخدمها البروكسي
        streamDataCache[channelName] = {
            url: innerData.url,
            headers: innerData.headers
        };

        // عرض صفحة المشغل
        res.send(`
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <title>مشغل البث - تجربة البروكسي</title>
                <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
                <style>
                    body { background: #000; margin: 0; display: flex; justify-content: center; align-items: center; height: 100vh; }
                    video { width: 100%; max-height: 100vh; }
                </style>
            </head>
            <body>
                <video id="videoPlayer" controls autoplay></video>
                <script>
                    var video = document.getElementById('videoPlayer');
                    
                    // التغيير الجوهري هنا: المشغل سيطلب البث من سيرفرنا (البروكسي) وليس من الرابط الأصلي
                    var videoSrc = "/proxy/${channelName}"; 
                    
                    if (Hls.isSupported()) {
                        var hls = new Hls();
                        hls.loadSource(videoSrc);
                        hls.attachMedia(video);
                        hls.on(Hls.Events.MANIFEST_PARSED, function() {
                            video.play();
                        });
                    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                        video.src = videoSrc;
                        video.addEventListener('loadedmetadata', function() {
                            video.play();
                        });
                    }
                </script>
            </body>
            </html>
        `);

    } catch (error) {
        res.status(500).send('حدث خطأ: ' + error.message);
    }
});

// 2. مسار البروكسي (الوسيط) الذي يقوم بالحقن الفعلي
app.get('/proxy/:channel', async (req, res) => {
    const channelName = req.params.channel;
    const streamInfo = streamDataCache[channelName];

    // التأكد من أن الرابط والهيدرز موجودة
    if (!streamInfo) {
        return res.status(404).send('بيانات البث غير متوفرة، يرجى تحديث الصفحة.');
    }

    try {
        // إرسال الطلب للمصدر مع حقن الهيدرز (السيرفر لا تفرض عليه قيود المتصفح)
        const response = await axios({
            method: 'get',
            url: streamInfo.url,
            headers: streamInfo.headers,
            responseType: 'stream' // مهم جداً لمعاملة البيانات كتدفق (Stream) وليس كملف عادي
        });

        // تمرير هيدرز نوع المحتوى للمتصفح ليتمكن من تشغيل الفيديو
        res.setHeader('Content-Type', response.headers['content-type'] || 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');

        // تمرير البث: المصدر -> سيرفر رندر -> المتصفح
        response.data.pipe(res);

    } catch (error) {
        console.error('Proxy Error:', error.message);
        res.status(500).send('خطأ أثناء جلب البث المباشر من المصدر.');
    }
});

app.listen(PORT, () => {
    console.log(\`Server running on port \${PORT}\`);
});
