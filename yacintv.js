const express = require("express");
const cors = require("cors");
const axios = require("axios");
const https = require("https");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// السماح بتقديم ملفات الواجهة الأمامية
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// مسار البروكسي (السر الحقيقي لتشغيل البثوث المعقدة)
// هذا المسار يحاكي عمل DefaultHttpDataSource في الأندرويد
// ==========================================
app.get("/proxy", async (req, res) => {
    try {
        const targetUrl = req.query.url;
        const headersStr = req.query.headers || "{}";
        const acceptSSL = req.query.acceptSSL || "0";
        
        if (!targetUrl) {
            return res.status(400).send("URL is required");
        }

        const customHeaders = JSON.parse(decodeURIComponent(headersStr));

        // إعدادات Axios لتخطي SSL وحقن الترويسات
        const axiosConfig = {
            method: "GET",
            url: targetUrl,
            headers: {
                "User-Agent": customHeaders["User-Agent"] || "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                "Referer": customHeaders["Referer"] || "",
                ...customHeaders
            },
            responseType: "stream",
            // تخطي SSL إذا كان السيرفر يطلب ذلك (acceptSSL = 1)
            httpsAgent: new https.Agent({ 
                rejectUnauthorized: acceptSSL === "1" ? false : true 
            })
        };

        const response = await axios(axiosConfig);

        // تمرير نوع المحتوى للمتصفح (m3u8 أو ts)
        res.set("Content-Type", response.headers["content-type"]);
        res.set("Access-Control-Allow-Origin", "*");
        
        // تمرير البث مباشرة للمشغل
        response.data.pipe(res);

    } catch (error) {
        console.error("Proxy Error:", error.message);
        res.status(500).send("Error fetching the stream");
    }
});

// ==========================================
// مساراتك الثابتة (للتوافق مع نظامك الحالي)
// ==========================================
const allTopics = [
    {"id_topic":"hot_now","name_topic":"الأكثر مشاهدة","img_url_topic":"http://logo.twoapistack.work/img/topics/hot_now.png","code":""},
    // ... (باقي الأقسام الخاصة بك كما هي)
];

app.get("/get-all-topics", (req, res) => { res.json(allTopics); });

// مسار المشغل
app.get("/play", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => { 
    console.log("🚀 Server running on port " + PORT); 
});
