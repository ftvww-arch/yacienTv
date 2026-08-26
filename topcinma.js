const express = require('express');
const cheerio = require('cheerio');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ---------------------------------------------------------
// نظام التخزين المؤقت المتقدم (Cache Coalescing)
// ---------------------------------------------------------
const cache = new Map();
const pendingRequests = new Map();

/**
 * دالة جلب البيانات مع الكاش وتجميع الطلبات المتزامنة
 * @param {string} url - الرابط المراد جلبه
 * @param {object} options - خيارات الطلب (Headers, Method, Body)
 * @param {number} ttl - مدة بقاء الكاش بالميلي ثانية (الافتراضي: 10 دقائق)
 */
async function fetchWithCache(url, options = {}, ttl = 600000) {
    const cacheKey = crypto.createHash('md5').update(url + (options.body || "")).digest('hex');

    // 1. التحقق من وجود كاش صالح
    if (cache.has(cacheKey)) {
        const cached = cache.get(cacheKey);
        if (Date.now() < cached.expires) {
            return cached.data;
        }
        cache.delete(cacheKey); // حذف الكاش المنتهي
    }

    // 2. التحقق من وجود طلب قيد التنفيذ لنفس الرابط (Request Coalescing)
    if (pendingRequests.has(cacheKey)) {
        return pendingRequests.get(cacheKey);
    }

    // 3. تنفيذ الطلب الفعلي إذا لم يكن هناك كاش أو طلب قيد التنفيذ
    const requestPromise = (async () => {
        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    // 💡 الأهم لتقليل الباندويث: طلب بيانات مضغوطة
                    "Accept-Encoding": "gzip, deflate, br",
                    ...(options.headers || {})
                }
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            
            const data = await response.text();
            
            // حفظ النتيجة في الكاش
            cache.set(cacheKey, {
                data,
                expires: Date.now() + ttl
            });
            
            pendingRequests.delete(cacheKey);
            return data;
        } catch (error) {
            pendingRequests.delete(cacheKey);
            throw error;
        }
    })();

    pendingRequests.set(cacheKey, requestPromise);
    return requestPromise;
}

// الهيكل الثابت الموحد لجميع المسارات
const emptyResponse = {
    id: "", title: "", url: "", image: "", genres: "", quality: "", imdb: "", eclip_Num: ""
};

// ---------------------------------------------------------
// المسار الأول: استخراج الأفلام والمسلسلات
// ---------------------------------------------------------
app.get('/api/page', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([emptyResponse]);

    try {
        const html = await fetchWithCache(targetUrl); // استخدام الدالة المحسنة
        const $ = cheerio.load(html);
        const moviesList = [];

        $('div.Small--Box:not(.Season)').each((index, element) => {
            const box = $(element);
            const movieUrl = box.find('a.recent--block').attr('href') || box.find('a').first().attr('href') || "";
            const title = box.find('h3.title').text().trim() || "";
            const imgTag = box.find('div.Poster img');
            const imageUrl = imgTag.attr('data-src') || imgTag.attr('data-lazy-src') || imgTag.attr('src') || "";

            let eclip_Num = box.find('div.number').text().trim();
            eclip_Num = eclip_Num.replace(/([^\d\s])(\d)/g, '$1 $2').replace(/(\d)([^\d\s])/g, '$1 $2').trim();

            let genre = "", quality = "", imdbRating = "";
            box.find('ul.liList li').each((i, li) => {
                const text = $(li).text().trim();
                if ($(li).hasClass('imdbRating')) {
                    imdbRating = text.replace(/[^\d.]/g, ''); 
                } else {
                    if (/p|web|bluray|hd|cam/i.test(text)) quality = text;
                    else if (!genre) genre = text;
                }
            });

            const id = movieUrl ? crypto.createHash('md5').update(movieUrl).digest('hex') : "";

            moviesList.push({ id, title, url: movieUrl, image: imageUrl, genres: genre, quality, imdb: imdbRating, eclip_Num });
        });

        if (moviesList.length === 0) return res.json([emptyResponse]);
        
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(moviesList);
    } catch (error) {
        res.json([emptyResponse]);
    }
});

// ---------------------------------------------------------
// المسار الثاني: استخراج المواسم
// ---------------------------------------------------------
app.get('/api/seasons', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([emptyResponse]);

    try {
        const html = await fetchWithCache(targetUrl);
        const $ = cheerio.load(html);
        const seasonsList = [];

        $('section.allseasonss div.Small--Box.Season').each((index, element) => {
            const box = $(element);
            const seasonUrl = box.find('a').attr('href') || "";
            const title = box.find('h3.title').text().trim() || "";
            const imgTag = box.find('div.Poster img');
            const imageUrl = imgTag.attr('data-src') || imgTag.attr('data-lazy-src') || imgTag.attr('src') || "";
            const id = seasonUrl ? crypto.createHash('md5').update(seasonUrl).digest('hex') : "";

            seasonsList.push({ id, title, url: seasonUrl, image: imageUrl, genres: "", quality: "", imdb: "", eclip_Num: "" });
        });

        if (seasonsList.length === 0) return res.json([emptyResponse]);

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(seasonsList);
    } catch (error) {
        res.json([emptyResponse]);
    }
});

// ---------------------------------------------------------
// المسار الثالث: استخراج الحلقات
// ---------------------------------------------------------
app.get('/api/episodes', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([emptyResponse]);

    try {
        const html = await fetchWithCache(targetUrl);
        const $ = cheerio.load(html);
        const episodesList = [];

        $('section.allepcont.getMoreByScroll a').each((index, element) => {
            const el = $(element);
            const url = el.attr('href') || "";
            const title = el.find('.ep-info h2').text().trim() || "";
            const imgTag = el.find('.image img');
            const image = imgTag.attr('data-src') || imgTag.attr('data-lazy-src') || imgTag.attr('src') || "";
            const eclip_Num = el.find('.epnum').text().trim().replace(/\D/g, '') || ""; 
            const id = url ? crypto.createHash('md5').update(url).digest('hex') : "";

            episodesList.push({ id, title, url, image, genres: "", quality: "", imdb: "", eclip_Num });
        });

        if (episodesList.length === 0) return res.json([emptyResponse]);

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(episodesList);
    } catch (error) {
        res.json([emptyResponse]);
    }
});

// ---------------------------------------------------------
// المسار السريع لاستخراج السيرفرات (مُصحح لدعم إعادة التوجيه)
// ---------------------------------------------------------
app.get('/api/watch', async (req, res) => {
    let targetUrl = req.query.url;
    
    if (!targetUrl) return res.json([]);
    if (!targetUrl.endsWith('/watch/')) {
        targetUrl = targetUrl.replace(/\/$/, '') + '/watch/';
    }

    try {
        // 1. استخدام fetch المباشر لضمان التقاط الرابط النهائي (finalUrl) في حال وجود Redirect
        const pageResponse = await fetch(encodeURI(targetUrl), {
            headers: { 
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                "Accept-Encoding": "gzip, deflate, br" // ضغط البيانات لتقليل الباندويث
            }
        });

        if (!pageResponse.ok) return res.json([]);

        const pageHtml = await pageResponse.text();
        const $ = cheerio.load(pageHtml);

        const firstServerBtn = $('.server--item').first();
        const postId = firstServerBtn.attr('data-id') || "";
        if (!postId) return res.json([]);

        const serverIndexes = [];
        $('.server--item').each((i, el) => {
            const serverNum = $(el).attr('data-server');
            if (i > 0 && serverNum !== "0") { 
                serverIndexes.push(serverNum);
            }
        });

        // 2. استخراج الدومين الفعّال والرابط النهائي بشكل صحيح لتجنب الحظر
        const finalUrlObj = new URL(pageResponse.url);
        const currentDomain = finalUrlObj.origin; 
        const serverUrl = `${currentDomain}/wp-content/themes/movies2023/Ajaxat/Single/Server.php`;

        const validServers = []; 
        const maxServersNeeded = 4; // يمكنك زيادته إذا أردت استخراج سيرفرات أكثر

        for (let i of serverIndexes) {
            if (validServers.length >= maxServersNeeded) break; // توفير موارد السيرفر

            try {
                // 3. استخدام الكاش لطلبات السيرفرات فقط لمدة دقيقة واحدة لتفادي تكرار طلبات Ajax
                const serverHtml = await fetchWithCache(serverUrl, {
                    method: 'POST',
                    body: `id=${postId}&i=${i}`,
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                        "X-Requested-With": "XMLHttpRequest",
                        "Referer": pageResponse.url // الرابط النهائي كـ Referer إلزامي هنا
                    }
                }, 60000); 

                const $$ = cheerio.load(serverHtml);
                const iframeSrc = $$('iframe').attr('src') || "";

                const blockedDomains = ['llvpn', 'ads', 'pop', 'blank','d0o0d','d0o0d.com', 'updown.icu', 'updown'];
                const isBlocked = blockedDomains.some(d => iframeSrc.includes(d));

                if (iframeSrc && iframeSrc.startsWith('http') && !isBlocked) {
                    validServers.push({ url: iframeSrc });
                }
            } catch (err) {
                console.error(`⚠️ خطأ أثناء فحص السيرفر رقم ${i}:`, err.message);
            }
        }

        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.json(validServers);

    } catch (error) {
        console.error("خطأ عام في مسار Watch:", error.message);
        return res.json([]);
    }
});
// ---------------------------------------------------------
// المسار الرابع: استخراج الحلقة التالية
// ---------------------------------------------------------
app.get('/api/next-episode', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.json([]);

    try {
        const html = await fetchWithCache(targetUrl);
        const $ = cheerio.load(html);
        const nextElement = $('a.next');

        if (nextElement.length > 0) {
            const nextUrl = nextElement.attr('href') || "";
            const nextNumber = nextElement.find('strong').text().trim() || "";
            const nextTitle = nextElement.find('.txtDiv span').text().trim() || "";

            if (nextUrl) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                return res.json([{ title: nextTitle, number: nextNumber, url: nextUrl }]);
            }
        }
        return res.json([]);
    } catch (error) {
        return res.json([]);
    }
});

module.exports = app;
