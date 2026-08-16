const express = require("express");
const axios = require("axios");
const CryptoJS = require("crypto-js");
const NodeCache = require("node-cache");
const http = require("http");
const https = require("https");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// 🆕 إعدادات الأداء والكاش
// ==========================================
// 1. إعداد اتصالات سريعة (Keep-Alive) لتخفيف الضغط وتقليل وقت الاستجابة
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100 });
const apiClient = axios.create({ httpAgent, httpsAgent });

// 2. الكاش: 5 دقائق (300 ثانية)
const CACHE_TTL = 300;
const appCache = new NodeCache({ stdTTL: CACHE_TTL, checkperiod: 60 });

// 3. نظام منع التدافع (Request Coalescing) لمنع السيرفر من إرسال طلبات مكررة في نفس اللحظة
const pendingRequests = new Map();

/**
 * دالة ذكية لإدارة الكاش ومنع تدافع الطلبات
 * @param {string} key - مفتاح الكاش الفريد
 * @param {function} fetchFunction - الدالة التي تجلب البيانات من السيرفر المصدر
 */
async function fetchWithCacheAndLock(key, fetchFunction) {
    // 1. إذا كانت البيانات موجودة في الكاش، أرسلها فوراً
    if (appCache.has(key)) {
        return appCache.get(key);
    }

    // 2. إذا كان هناك طلب جاري لنفس المفتاح، اجعل المستخدم ينتظر هذا الطلب ولا ترسل طلباً جديداً
    if (pendingRequests.has(key)) {
        return await pendingRequests.get(key);
    }

    // 3. إنشاء طلب جديد وحفظه في الـ Map حتى يكتمل
    const requestPromise = (async () => {
        try {
            const data = await fetchFunction();
            appCache.set(key, data); // حفظ في الكاش بعد نجاح الطلب
            return data;
        } finally {
            pendingRequests.delete(key); // تنظيف الـ Map بمجرد انتهاء الطلب
        }
    })();

    pendingRequests.set(key, requestPromise);
    return await requestPromise;
}

// ==========================================
// التشفير وفك التشفير
// ==========================================
const KEY = CryptoJS.enc.Utf8.parse("0123456789abcdef");
const IV = CryptoJS.enc.Utf8.parse("fedcba9876543210");

function encryptAES(data) {
    const encrypted = CryptoJS.AES.encrypt(data, KEY, {
        iv: IV, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7
    });
    return encrypted.toString() + ":" + CryptoJS.enc.Base64.stringify(IV);
}

function decryptAES(encryptedText) {
    encryptedText = encryptedText.trim();
    const lastColon = encryptedText.lastIndexOf(":");
    const encryptedData = encryptedText.substring(0, lastColon);
    const ivBase64 = encryptedText.substring(lastColon + 1);
    const decrypted = CryptoJS.AES.decrypt(encryptedData, KEY, {
        iv: CryptoJS.enc.Base64.parse(ivBase64), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7
    });
    return decrypted.toString(CryptoJS.enc.Utf8);
}

function convertFakeUrlToRealUrl(fakeUrl, channelId) {
    const match = fakeUrl.match(/\.LS\.V2(.+?)\/s$/);
    if (!match) return fakeUrl;
    const extractedPart = match[1];
    let realUrl = "";
    if (extractedPart.includes("LOAD_BALANCER")) {
        const cleanId = extractedPart.replace("LOAD_BALANCER", "");
        realUrl = `{"url":"http://.LS.V2LOAD_BALANCER${cleanId}/s","data":"","acceptSSL":"1","iframe":"","headers":{}}`;
    } else if (extractedPart.includes("custom_handler")) {
        realUrl = `{"url":"${fakeUrl}","data":"","acceptSSL":"1","iframe":"","headers":{}}`;
    } else if (extractedPart.includes("daddy_")) {
        const daddyId = extractedPart.replace("daddy_", "");
        realUrl = `{"url":"https://hamis.romponalis.st/premiumtv/daddy4.php?id=${daddyId}","data":"","acceptSSL":"1","iframe":"https://daddylive.mov/embed/embed.php?id=${daddyId}&player=1&source=tv.json","headers":{"Referer":"https://dlhd.pk/","Origin":"https://dlhd.pk","Accept":"*/*","Sec-Fetch-Dest":"empty","Sec-Fetch-Mode":"cors","Sec-Fetch-Site":"cross-site"}}`;
    } else {
        realUrl = `{"url":"${fakeUrl}","data":"","acceptSSL":"1","iframe":"","headers":{}}`;
    }
    return realUrl;
}

// ==========================================
// القيم الافتراضية والدوال المساعدة
// ==========================================
const DEFAULT_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const DEFAULT_HEADERS = { "User-Agent": DEFAULT_AGENT };

function parseDataUrl(dataUrl, fallbackAgent) {
    try {
        const obj = JSON.parse(dataUrl);
        const streamUrl = obj.url || "";
        const agent = obj.agent || fallbackAgent || DEFAULT_AGENT;
        const mediatype = obj.mediatype || (streamUrl.includes(".mpd") ? "dash" : streamUrl.includes(".m3u8") ? "hls" : null);
        
        const headers = obj.headers || {};
        if (!headers["User-Agent"] && !headers["user-agent"]) headers["User-Agent"] = agent;
        
        return { url: streamUrl, agent: agent, headers: headers, drm: obj.drm || null, mediatype: mediatype, iframe: obj.iframe || null, acceptSSL: obj.acceptSSL || null };
    } catch (e) {
        return { url: dataUrl, agent: fallbackAgent || DEFAULT_AGENT, headers: { ...DEFAULT_HEADERS }, drm: null, mediatype: null, iframe: null, acceptSSL: null };
    }
}

function createServerObject(serverName, url, agent, headers, drm, mediatype) {
    return { server_name: serverName, url: url || "", agent: agent || DEFAULT_AGENT, drm: drm || null, headers: (headers && Object.keys(headers).length > 0) ? headers : { ...DEFAULT_HEADERS }, mediatype: mediatype || null };
}

async function fetchIntermediateUrl(url, headers = {}, agent = null) {
    try {
        const requestHeaders = { "User-Agent": agent || DEFAULT_AGENT, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9", "Connection": "keep-alive", ...headers };
        const response = await apiClient.get(url, { headers: requestHeaders, timeout: 15000, maxRedirects: 5, validateStatus: s => s < 500 });
        const html = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
        
        let streamUrl = null;
        const m3u8Match = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
        if (m3u8Match) streamUrl = m3u8Match[1];
        if (!streamUrl) {
            const mpdMatch = html.match(/(https?:\/\/[^\s"'<>]+\.mpd[^\s"'<>]*)/i);
            if (mpdMatch) streamUrl = mpdMatch[1];
        }
        if (!streamUrl) {
            const srcMatch = html.match(/source\s+src=["']([^"']+)["']/i) || html.match(/iframe\s+src=["']([^"']+)["']/i);
            if (srcMatch) streamUrl = srcMatch[1];
        }
        if (!streamUrl) {
            const b64 = html.match(/atob\s*\(\s*['"]([A-Za-z0-9+/=]+)['"]\s*\)/);
            if (b64) { try { const d = Buffer.from(b64[1], 'base64').toString('utf-8'); if (d.startsWith("http")) streamUrl = d; } catch(e) {} }
        }

        return streamUrl ? { success: true, url: streamUrl, agent: agent || DEFAULT_AGENT, headers: headers || {}, mediatype: streamUrl.includes(".mpd") ? "dash" : "hls" } : { success: false };
    } catch (e) { return { success: false, error: e.message }; }
}

async function sendRequest(channelId, urlData, agent, encryptedRawData = "", endpoint = "getLiveByRedirect") {
    const postData = {
        "user_id": "_82668_1785761367217_notloggedin.com_dramalive3", "device_id": "e603540e-ed93-47a3-bec6-a15f7f056604",
        "device_api": "28", "version_name": "187", "language": "ar", "timezone": "Europe/Istanbul", "device_type": "phone",
        "KEY_ACTIVATED_TYPE": "232425", "store": "direct", "isStoreVersion": false, "isPremium": false, "isCoupon_active": false,
        "hideAds": false, "appCount": "{\"adsFailed\":73,\"adsLoaded\":56,\"adsShowed\":17,\"runCount\":8}",
        "mainServer": "http://main.eastgoessouth.online/api/live/livedrama/v13.0.0/",
        "id": channelId, "url": urlData, "agent": agent, "raw_data": encryptedRawData
    };

    const encryptedBody = encryptAES(JSON.stringify(postData));
    const response = await apiClient.post(`http://redirect.1spbgmu.com/redirect/${endpoint}`, encryptedBody, {
        headers: { "Content-Type": "text/plain", "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 9; SM-S908E Build/TP1A.220624.014)", "Host": "redirect.1spbgmu.com", "Connection": "Keep-Alive", "Accept-Encoding": "gzip" },
        timeout: 15000, responseType: "arraybuffer"
    });

    const encryptedResponse = Buffer.from(response.data).toString("utf-8");
    const decryptedResponse = JSON.parse(decryptAES(encryptedResponse));
    return { encrypted_response: encryptedResponse, decrypted_response: decryptedResponse };
}

async function resolveRedirectUrl(channelId, fakeUrl) {
    let currentUrl = fakeUrl, currentAgent = "redirect", encryptedRawData = "", maxSteps = 5, lastParsedData = null;

    while (maxSteps > 0) {
        maxSteps--;
        let urlToSend = (currentUrl.includes(".LS.V2") && currentUrl.endsWith("/s")) ? convertFakeUrlToRealUrl(currentUrl, channelId) : currentUrl;
        let endpoint = (currentAgent === "double_redirect") ? "getLiveByDoubleRedirect" : "getLiveByRedirect";

        const result = await sendRequest(channelId, urlToSend, currentAgent, encryptedRawData, endpoint);
        const data = result.decrypted_response.data;
        if (!data || !data.url) return null;

        const newAgent = data.agent || "stop";
        const parsed = parseDataUrl(data.url, null);
        lastParsedData = parsed;
        
        if (newAgent === "advanced" || newAgent === "stop") {
            if (parsed.url && parsed.url.includes(".LS.V2")) {
                if (result.encrypted_response && !encryptedRawData) { encryptedRawData = result.encrypted_response.trim(); currentUrl = data.url; currentAgent = "double_redirect"; continue; }
                break;
            }
            if (parsed.url && (parsed.url.includes(".m3u8") || parsed.url.includes(".mpd"))) return { url: parsed.url, agent: parsed.agent, headers: parsed.headers, drm: parsed.drm, mediatype: parsed.mediatype };
            if (parsed.url && parsed.url.startsWith("http")) {
                const fetchResult = await fetchIntermediateUrl(parsed.url, parsed.headers, parsed.agent);
                if (fetchResult.success) return { url: fetchResult.url, agent: parsed.agent, headers: parsed.headers, drm: parsed.drm, mediatype: fetchResult.mediatype };
                if (parsed.iframe && parsed.iframe.startsWith("http")) {
                    const iframeResult = await fetchIntermediateUrl(parsed.iframe, parsed.headers, parsed.agent);
                    if (iframeResult.success) return { url: iframeResult.url, agent: parsed.agent, headers: parsed.headers, drm: parsed.drm, mediatype: iframeResult.mediatype };
                }
                if (result.encrypted_response && !encryptedRawData) { encryptedRawData = result.encrypted_response.trim(); currentUrl = data.url; currentAgent = "double_redirect"; continue; }
                break;
            }
            if (result.encrypted_response && !encryptedRawData) { encryptedRawData = result.encrypted_response.trim(); currentUrl = data.url; currentAgent = "double_redirect"; continue; }
            break;
        }
        
        if (newAgent === "redirect" || newAgent === "double_redirect") { currentUrl = data.url; currentAgent = newAgent; encryptedRawData = ""; continue; }
        break;
    }

    if (lastParsedData && lastParsedData.url && lastParsedData.url.startsWith("http")) return { url: lastParsedData.url, agent: lastParsedData.agent, headers: lastParsedData.headers, drm: lastParsedData.drm, mediatype: lastParsedData.mediatype };
    return null;
}

async function processServer(id_live, serverName, urlData, agentData) {
    let parsed = { url: urlData, agent: agentData, headers: {}, drm: null, mediatype: null };
    if (urlData && urlData.startsWith("{")) {
        try {
            const obj = JSON.parse(urlData);
            parsed = { url: obj.url || "", agent: obj.agent || agentData, headers: obj.headers || {}, drm: obj.drm || null, mediatype: obj.mediatype || null };
        } catch(e) {}
    }
    
    const isRedirect = (parsed.agent === "redirect" || agentData === "redirect");
    if (isRedirect && parsed.url) {
        const resolved = await resolveRedirectUrl(id_live, parsed.url);
        if (resolved && resolved.url && (resolved.url.includes(".m3u8") || resolved.url.includes(".mpd"))) return createServerObject(serverName + " ", resolved.url, resolved.agent, resolved.headers, resolved.drm || parsed.drm, resolved.mediatype);
        else if (resolved && resolved.url) return createServerObject(serverName + " ⚠️", resolved.url, resolved.agent, resolved.headers, resolved.drm || parsed.drm, resolved.mediatype);
        else return createServerObject(serverName + "", parsed.url, parsed.agent, parsed.headers, parsed.drm, parsed.mediatype);
    }
    return createServerObject(serverName, parsed.url, parsed.agent, parsed.headers, parsed.drm, parsed.mediatype);
}

// ==========================================
// المسارات مع نظام القفل والكاش الذكي
// ==========================================

app.get("/channels", async (req, res) => {
    try {
        const topic = req.query.topic || "arabic_sport";
        const cacheKey = `channels_${topic}`;
        
        const data = await fetchWithCacheAndLock(cacheKey, async () => {
            const postData = {
                "user_id": "_82668_1785761367217_notloggedin.com_dramalive3", "device_id": "e603540e-ed93-47a3-bec6-a15f7f056604",
                "device_api": "28", "version_name": "187", "language": "ar", "timezone": "Europe/Istanbul", "device_type": "phone",
                "KEY_ACTIVATED_TYPE": "232425", "store": "direct", "isStoreVersion": false, "isPremium": false, "isCoupon_active": false, "hideAds": false,
                "appCount": "{\"adsFailed\":73,\"adsLoaded\":56,\"adsShowed\":17,\"runCount\":8}",
                "mainServer": "http://main.eastgoessouth.online/api/live/livedrama/v13.0.0/", "type": "tv", "topic": topic
            };
            const encryptedBody = encryptAES(JSON.stringify(postData));
            const response = await apiClient.post("http://live.1spbgmu.com/api/live/livedrama/v13.0.0/getLiveByTopic", encryptedBody, {
                headers: { "Content-Type": "text/plain", "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 9; SM-S908E Build/TP1A.220624.014)", "Host": "live.1spbgmu.com", "Connection": "Keep-Alive" },
                timeout: 30000
            });
            const jsonResponse = JSON.parse(decryptAES(response.data));
            let rawChannels = Array.isArray(jsonResponse) ? jsonResponse : (jsonResponse.channels || jsonResponse.live || []);
            return rawChannels.map(ch => ({
                type: ch.type || "tv", id_live: ch.id_live || "", name: ch.name || "", url: ch.url || "", agent: ch.agent || "", backup: ch.backup || "", img_url: ch.img_url || "", id_topic: ch.id_topic || topic
            }));
        });
        res.json(data);
    } catch (error) { res.status(500).json({ error: true, message: error.message }); }
});

app.get("/stream", async (req, res) => {
    try {
        const id_live = req.query.id_live;
        if (!id_live) return res.status(400).json({ error: true, message: "يرجى إرسال id_live" });

        const cacheKey = `stream_full_array_${id_live}`;

        const data = await fetchWithCacheAndLock(cacheKey, async () => {
            const postData = {
                "user_id": "_82668_1785761367217_notloggedin.com_dramalive3", "device_id": "e603540e-ed93-47a3-bec6-a15f7f056604",
                "device_api": "28", "version_name": "187", "language": "ar", "timezone": "Europe/Istanbul", "device_type": "phone",
                "KEY_ACTIVATED_TYPE": "232425", "store": "direct", "isStoreVersion": false, "isPremium": false, "isCoupon_active": false, "hideAds": false,
                "appCount": "{\"adsFailed\":468,\"adsLoaded\":240,\"adsShowed\":116,\"runCount\":54}",
                "mainServer": "http://main.eastgoessouth.online/api/live/livedrama/v13.0.0/", "type": "tv", "id_live": id_live, "id": id_live, "live_id": id_live, "channel_id": id_live
            };

            const encryptedBody = encryptAES(JSON.stringify(postData));
            const response = await apiClient.post("http://live.1spbgmu.com/api/live/livedrama/v13.0.0/getLiveAllStreamsById", encryptedBody, {
                headers: { "Content-Type": "text/plain", "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 9; SM-S908E Build/TP1A.220624.014)", "Host": "live.1spbgmu.com", "Connection": "Keep-Alive" },
                timeout: 15000, responseType: "arraybuffer" 
            });

            const rawJson = JSON.parse(decryptAES(Buffer.from(response.data).toString("utf-8")));
            const liveData = rawJson.live || {};
            let rawStreams = [];

            if (liveData.url && liveData.url !== "empty") rawStreams.push({ url: liveData.url, agent: liveData.agent || "" });
            if (liveData.backup) {
                const backupParts = liveData.backup.split("-;-");
                for (const part of backupParts) {
                    if (!part.trim()) continue;
                    const subParts = part.trim().split("--");
                    if (subParts[0] && subParts[0].trim() !== "empty") rawStreams.push({ url: subParts[0].trim(), agent: subParts[1] ? subParts[1].trim() : "" });
                }
            }

            let finalStreamsArray = [];
            let serverCounter = 1; 

            for (const item of rawStreams) {
                let serverPayload = null;
                if (item.agent === "redirect" || item.agent === "double_redirect") {
                    try {
                        let currentAgent = item.agent, currentUrl = item.url, rawData = "";
                        if (currentAgent === "redirect") {
                            const resRedir = await sendRequest(id_live, currentUrl, "redirect", "", "getLiveByRedirect");
                            serverPayload = resRedir.decrypted_response;
                            if (serverPayload?.data?.agent === "double_redirect") { currentAgent = "double_redirect"; currentUrl = serverPayload.data.url; }
                        }
                        if (currentAgent === "double_redirect") {
                            try {
                                let parsedObj = JSON.parse(currentUrl);
                                let resHtml = await apiClient.get(parsedObj.url, { headers: parsedObj.headers || {}, timeout: 10000 });
                                rawData = typeof resHtml.data === 'string' ? resHtml.data : JSON.stringify(resHtml.data);
                            } catch (e) {
                                try { let resHtml = await apiClient.get(currentUrl, { timeout: 10000 }); rawData = typeof resHtml.data === 'string' ? resHtml.data : JSON.stringify(resHtml.data); } catch (err) {}
                            }
                            const resDouble = await sendRequest(id_live, currentUrl, "double_redirect", rawData, "getLiveByDoubleRedirect");
                            serverPayload = resDouble.decrypted_response;
                        }
                    } catch (err) { continue; }
                } else {
                    let innerUrlString = item.url;
                    if (!innerUrlString.startsWith("{")) innerUrlString = JSON.stringify({ "url": item.url, "agent": item.agent || DEFAULT_AGENT, "acceptSSL": "1", "headers": { "User-Agent": item.agent || DEFAULT_AGENT } });
                    serverPayload = { "result": 0, "message": { "en": "operation succeeded", "ar": "تمت العملية بنجاح" }, "data": { "url": innerUrlString, "agent": "advanced" } };
                }

                if (serverPayload) {
                    serverPayload.name = `سيرفر ${serverCounter}`; 
                    if(serverPayload.data) serverPayload.data.name = `سيرفر ${serverCounter}`;
                    finalStreamsArray.push(serverPayload);
                    serverCounter++;
                }
            }
            return finalStreamsArray;
        });

        res.json(data);
    } catch (error) { res.status(500).json({ error: true, message: error.message }); }
});

app.post("/get-redirect-data", async (req, res) => {
    try {
        const { id_live, agent = "redirect" } = req.body;
        let url = req.body.url;
        if (!id_live) return res.status(400).json({ error: true, message: "يرجى إرسال id_live" });

        const cacheKey = `redirect_post_${id_live}_${url || 'nourl'}`;

        const data = await fetchWithCacheAndLock(cacheKey, async () => {
            if (!url) {
                const streamsPostData = {
                    "user_id": "_82668_1785761367217_notloggedin.com_dramalive3", "device_id": "e603540e-ed93-47a3-bec6-a15f7f056604", "device_api": "28", "version_name": "187", "language": "ar", "timezone": "Europe/Istanbul", "device_type": "phone", "KEY_ACTIVATED_TYPE": "232425", "store": "direct", "mainServer": "http://main.eastgoessouth.online/api/live/livedrama/v13.0.0/", "type": "tv", "id_live": id_live, "id": id_live, "live_id": id_live, "channel_id": id_live
                };
                const encryptedBody = encryptAES(JSON.stringify(streamsPostData));
                const streamRes = await apiClient.post("http://live.1spbgmu.com/api/live/livedrama/v13.0.0/getLiveAllStreamsById", encryptedBody, { headers: { "Content-Type": "text/plain", "User-Agent": "Dalvik/2.1.0", "Host": "live.1spbgmu.com" }, responseType: "arraybuffer", timeout: 15000 });
                url = JSON.parse(decryptAES(Buffer.from(streamRes.data).toString("utf-8"))).live?.url;
                if (!url || url === "empty") throw new Error("لم يتم العثور على رابط أساسي");
            }

            let result = await sendRequest(id_live, url, agent, "", "getLiveByRedirect");
            let returnedUrl = result.decrypted_response?.data?.url || "";
            let actualUrl = returnedUrl, actualHeaders = {};
            try { let obj = JSON.parse(returnedUrl); actualUrl = obj.url || returnedUrl; actualHeaders = obj.headers || {}; } catch(e) {}

            const isDirectStream = (actualUrl.includes(".m3u8") || actualUrl.includes(".mpd")) && !actualUrl.includes("token.") && !actualUrl.includes(".LS.V2");

            if (!isDirectStream && returnedUrl !== "1") {
                let rawData = "";
                if (actualUrl.includes("token.easybroadcast.io")) {
                    try { const tokenRes = await apiClient.get(actualUrl, { headers: actualHeaders }); rawData = typeof tokenRes.data === 'object' ? Object.keys(tokenRes.data).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(tokenRes.data[k])}`).join('&') : tokenRes.data; } catch (err) {}
                } else if (result.encrypted_response) rawData = result.encrypted_response.trim();
                result = await sendRequest(id_live, returnedUrl, "double_redirect", rawData, "getLiveByDoubleRedirect");
            }
            return result.decrypted_response;
        });

        res.json(data);
    } catch (error) { res.status(500).json({ error: true, message: error.message }); }
});

app.get("/get-redirect-data", async (req, res) => {
    try {
        const id_live = req.query.id_live;
        if (!id_live) return res.status(400).json({ error: true, message: "يرجى إرسال id_live" });

        const cacheKey = `redirect_get_${id_live}`;

        const data = await fetchWithCacheAndLock(cacheKey, async () => {
            const streamsPostData = {
                "user_id": "_82668_1785761367217_notloggedin.com_dramalive3", "device_id": "e603540e-ed93-47a3-bec6-a15f7f056604", "device_api": "28", "version_name": "187", "language": "ar", "timezone": "Europe/Istanbul", "device_type": "phone", "KEY_ACTIVATED_TYPE": "232425", "store": "direct", "mainServer": "http://main.eastgoessouth.online/api/live/livedrama/v13.0.0/", "type": "tv", "id_live": id_live, "id": id_live, "live_id": id_live, "channel_id": id_live
            };
            const encryptedStreamBody = encryptAES(JSON.stringify(streamsPostData));
            const streamRes = await apiClient.post("http://live.1spbgmu.com/api/live/livedrama/v13.0.0/getLiveAllStreamsById", encryptedStreamBody, { headers: { "Content-Type": "text/plain", "User-Agent": "Dalvik/2.1.0", "Host": "live.1spbgmu.com" }, responseType: "arraybuffer", timeout: 15000 });
            const url = JSON.parse(decryptAES(Buffer.from(streamRes.data).toString("utf-8"))).live?.url;
            if (!url || url === "empty") throw new Error("لم يتم العثور على رابط أساسي");

            let result = await sendRequest(id_live, url, "redirect", "", "getLiveByRedirect");
            let returnedUrl = result.decrypted_response?.data?.url || "";
            let actualUrl = returnedUrl, actualHeaders = {};
            try { let obj = JSON.parse(returnedUrl); actualUrl = obj.url || returnedUrl; actualHeaders = obj.headers || {}; } catch(e) {}

            const isDirectStream = (actualUrl.includes(".m3u8") || actualUrl.includes(".mpd")) && !actualUrl.includes("token.") && !actualUrl.includes(".LS.V2");

            if (!isDirectStream && returnedUrl !== "1") {
                let rawData = "";
                if (actualUrl.includes("token.easybroadcast.io")) {
                    try { const tokenRes = await apiClient.get(actualUrl, { headers: actualHeaders }); rawData = typeof tokenRes.data === 'object' ? Object.keys(tokenRes.data).map(k => `${encodeURIComponent(k)}=${encodeURIComponent(tokenRes.data[k])}`).join('&') : tokenRes.data; } catch (err) {}
                } else if (result.encrypted_response) rawData = result.encrypted_response.trim();
                result = await sendRequest(id_live, returnedUrl, "double_redirect", rawData, "getLiveByDoubleRedirect");
            }
            return result.decrypted_response;
        });

        res.json(data);
    } catch (error) { res.status(500).json({ error: true, message: error.message }); }
});

app.get("/live_id/:id", async (req, res) => {
    try {
        const id_live = req.params.id;
        if (!id_live) return res.status(400).json({ error: true, message: "يرجى إرسال id" });

        const cacheKey = `smart_live_${id_live}`;
        
        const data = await fetchWithCacheAndLock(cacheKey, async () => {
            const localBaseUrl = `http://localhost:${PORT}`;
            try {
                const redirectResponse = await apiClient.get(`${localBaseUrl}/get-redirect-data?id_live=${id_live}`);
                if (redirectResponse.data?.data?.url && redirectResponse.data.data.url !== "1" && redirectResponse.data.data.url !== "empty") {
                    return redirectResponse.data;
                }
            } catch (err) {}

            const streamResponse = await apiClient.get(`${localBaseUrl}/stream?id_live=${id_live}`);
            if (streamResponse.data && Array.isArray(streamResponse.data) && streamResponse.data.some(s => s.data && s.data.url)) {
                return streamResponse.data;
            }

            try {
                const lastResponse = await apiClient.get(`${localBaseUrl}/last/${id_live}`);
                return lastResponse.data;
            } catch (lastErr) { return streamResponse.data; }
        });

        res.json(data);
    } catch (error) { res.status(500).json({ error: true, message: error.message }); }
});

app.get("/last/:id_live", async (req, res) => {
    try {
        const id_live = req.params.id_live;
        if (!id_live) return res.status(400).json({ error: true, message: "يرجى إرسال id_live" });

        const cacheKey = `last_${id_live}`;

        const data = await fetchWithCacheAndLock(cacheKey, async () => {
            const streamsPostData = { "user_id": "_82668_1785761367217_notloggedin.com_dramalive3", "device_id": "e603540e-ed93-47a3-bec6-a15f7f056604", "device_api": "28", "version_name": "187", "language": "ar", "timezone": "Europe/Istanbul", "device_type": "phone", "KEY_ACTIVATED_TYPE": "232425", "store": "direct", "mainServer": "http://main.eastgoessouth.online/api/live/livedrama/v13.0.0/", "type": "tv", "id_live": id_live, "id": id_live, "live_id": id_live, "channel_id": id_live };
            const encryptedBody = encryptAES(JSON.stringify(streamsPostData));
            const streamRes = await apiClient.post("http://live.1spbgmu.com/api/live/livedrama/v13.0.0/getLiveAllStreamsById", encryptedBody, { headers: { "Content-Type": "text/plain", "User-Agent": "Dalvik/2.1.0", "Host": "live.1spbgmu.com" }, responseType: "arraybuffer", timeout: 15000 });
            
            const liveData = JSON.parse(decryptAES(Buffer.from(streamRes.data).toString("utf-8"))).live || {};
            if (!liveData.url || liveData.url === "empty") throw new Error("لم يتم العثور على رابط أساسي");

            let redirectResult = await sendRequest(id_live, liveData.url, "redirect", "", "getLiveByRedirect");
            let redirectData = redirectResult.decrypted_response;

            if (redirectData?.data?.agent === "double_redirect") {
                const currentUrl = redirectData.data.url;
                let rawData = "";
                try { let parsedObj = JSON.parse(currentUrl); let resHtml = await apiClient.get(parsedObj.url, { headers: parsedObj.headers || {}, timeout: 10000 }); rawData = typeof resHtml.data === 'string' ? resHtml.data : JSON.stringify(resHtml.data); } 
                catch (e) { try { let resHtml = await apiClient.get(currentUrl, { timeout: 10000 }); rawData = typeof resHtml.data === 'string' ? resHtml.data : JSON.stringify(resHtml.data); } catch (err) {} }
                const doubleResult = await sendRequest(id_live, currentUrl, "double_redirect", rawData, "getLiveByDoubleRedirect");
                redirectData = doubleResult.decrypted_response;
            }

            let urlVal = redirectData?.data?.url?.trim() || "";
            if (urlVal !== "1" && urlVal !== "" && urlVal !== "empty") return redirectData;

            let parsedStreams = [];
            if (liveData.url && liveData.url !== "empty") parsedStreams.push(await processServer(id_live, "السيرفر الأساسي", liveData.url, liveData.agent || ""));
            if (liveData.backup) {
                const backupParts = liveData.backup.split("-;-");
                for (let i = 0; i < backupParts.length; i++) {
                    const subParts = backupParts[i].trim().split("--");
                    if (subParts[0] && subParts[0].trim() !== "empty") parsedStreams.push(await processServer(id_live, `سيرفر ${parsedStreams.length + 1}`, subParts[0].trim(), subParts[1] ? subParts[1].trim() : ""));
                }
            }
            return { id_live: liveData.id_live || id_live, name: liveData.name || "", img_url: liveData.img_url || "", streams: parsedStreams };
        });

        res.json(data);
    } catch (error) { res.status(500).json({ error: true, message: error.message }); }
});

app.get("/mach", async (req, res) => {
    try {
        const cacheKey = `matches_data`;
        
        const data = await fetchWithCacheAndLock(cacheKey, async () => {
            const postData = { "user_id": "_82668_1785761367217_notloggedin.com_dramalive3", "device_id": "e603540e-ed93-47a3-bec6-a15f7f056604", "device_api": "28", "version_name": "187", "language": "ar", "timezone": "Europe/Istanbul", "device_type": "phone", "KEY_ACTIVATED_TYPE": "232425", "store": "direct", "mainServer": "http://main.eastgoessouth.online/api/live/livedrama/v13.0.0/", "type": "tv" };
            const encryptedBody = encryptAES(JSON.stringify(postData));
            const response = await apiClient.post("http://sport.1spbgmu.com/sport/getMatches", encryptedBody, { headers: { "Content-Type": "text/plain", "User-Agent": "Dalvik/2.1.0", "Host": "sport.1spbgmu.com" }, timeout: 30000, responseType: "arraybuffer" });
            const jsonResponse = JSON.parse(decryptAES(Buffer.from(response.data).toString("utf-8")));
            let rawMatches = Array.isArray(jsonResponse) ? jsonResponse : (jsonResponse.matches || jsonResponse.data || []);

            return rawMatches.map(match => {
                let matchTime = "", matchStatus = "لم تبدأ", dateVal = match.date || "";
                if (dateVal.includes("انتهت")) { matchStatus = "انتهت"; matchTime = "انتهت"; } 
                else { const timeMatch = dateVal.match(/\d{2}:\d{2}/); matchTime = timeMatch ? timeMatch[0] : dateVal; }
                return { title: match.title || "", league: match.topic || "", team1: match.firstTeam || "", team2: match.secondtTeam || "", team1_logo: match.firstTeamImage || "", team2_logo: match.secondtTeamImage || "", time: matchTime, date: dateVal, status: matchStatus, score: match.firstTeamScore && match.firstTeamScore !== "-" ? match.firstTeamScore : "", channel: match.channel || "", id_live: match.channel || "" };
            });
        });

        res.json(data);
    } catch (error) { res.status(500).json({ error: true, message: error.message }); }
});










// ==========================================
// 🆕 مسار تشغيل البث الديناميكي عبر المعرف (Proxy & Swap)
// ==========================================
app.post('/play/:id', async (req, res) => {
    const channelId = req.params.id; // مثل: live_tv_marrocow1
    let { Data, Url } = req.body; 
    let streamsArray = [];

    try {
        // إذا لم يتم إرسال بيانات أو رابط مباشرة في الـ Body، نقوم بجلبها تلقائياً باستخدام معرف القناة
        if ((!Data || Data.trim() === "") && (!Url || Url.trim() === "")) {
            const localBaseUrl = `http://localhost:${PORT}`;
            try {
                // محاولة جلب بيانات السيرفرات عبر دالة الـ last الموجودة في ملفك
                const streamResponse = await apiClient.get(`${localBaseUrl}/last/${channelId}`);
                if (streamResponse.data && streamResponse.data.streams) {
                    streamsArray = streamResponse.data.streams.map(s => ({
                        quality: s.server_name || "سيرفر",
                        url: s.url || "",
                        agent: s.agent || DEFAULT_AGENT,
                        headers: s.headers || {},
                        acceptSSL: "1"
                    }));
                }
            } catch (err) {
                console.error("خطأ في جلب بيانات القناة تلقائياً:", err.message);
            }
        }

        // المعالجة العادية في حال تم ارسال Data أو Url في الـ Body
        if (Data && Data.trim() !== "") {
            let trimmedData = Data.trim();
            if (trimmedData.startsWith("{")) {
                let root = JSON.parse(trimmedData);
                if (root.streams && root.streams.length > 0) {
                    streamsArray = root.streams;
                } else if (root.data && root.data.url) {
                    streamsArray.push({
                        quality: "سيرفر رئيسي",
                        url: root.data.url.trim(),
                        agent: root.data.agent || ""
                    });
                }
            } else if (trimmedData.startsWith("[")) {
                let rootArray = JSON.parse(trimmedData);
                rootArray.forEach((item, index) => {
                    if (item.data && item.data.url) {
                        streamsArray.push({
                            quality: item.name || `سيرفر ${index + 1}`,
                            url: item.data.url.trim(),
                            agent: item.data.agent || ""
                        });
                    }
                });
            } else if (trimmedData.startsWith("http")) {
                streamsArray.push({ quality: "سيرفر رئيسي", url: trimmedData });
            }
        } else if (Url && Url.trim() !== "") {
            streamsArray.push({ quality: "سيرفر رئيسي", url: Url.trim() });
        }

        if (streamsArray.length === 0) {
            return res.status(404).json({ error: "لا توجد سيرفرات متاحة لهذه القناة" });
        }

        let selectedStream = streamsArray[0];
        let rawUrl = selectedStream.url;
        let videoUrl = rawUrl;
        let headers = {
            "User-Agent": selectedStream.agent || DEFAULT_AGENT 
        };
        let swapKey = "";
        let swapValue = "";
        let acceptSSL = selectedStream.acceptSSL === "1" || true;

        if (rawUrl.startsWith("{") && rawUrl.endsWith("}")) {
            let nested = JSON.parse(rawUrl);
            videoUrl = nested.url;
            if (nested.agent) headers["User-Agent"] = nested.agent;
            if (nested.swap) {
                swapKey = Object.keys(nested.swap)[0];
                swapValue = nested.swap[swapKey];
            }
            if (nested.headers) {
                Object.assign(headers, nested.headers);
            }
        } else {
            if (selectedStream.swap) {
                swapKey = Object.keys(selectedStream.swap)[0];
                swapValue = selectedStream.swap[swapKey];
            }
            if (selectedStream.headers) {
                Object.assign(headers, selectedStream.headers);
            }
        }

        const axiosConfig = {
            method: 'GET',
            url: videoUrl,
            headers: headers,
            responseType: 'stream',
            timeout: 15000
        };

        if (acceptSSL) {
            axiosConfig.httpsAgent = new https.Agent({ rejectUnauthorized: false });
        }

        const response = await axios(axiosConfig);
        const contentType = response.headers['content-type'] || 'application/x-mpegURL';
        
        res.set({
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*'
        });

        if (swapKey && (contentType.includes('mpegurl') || contentType.includes('dash+xml'))) {
            let chunks = [];
            response.data.on('data', chunk => chunks.push(chunk));
            response.data.on('end', () => {
                let body = Buffer.concat(chunks).toString('utf8');
                body = body.split(swapKey).join(swapValue);
                res.send(body);
            });
        } else {
            response.data.pipe(res);
        }

    } catch (error) {
        console.error("Stream Proxy Error:", error.message);
        res.status(500).json({ error: "فشل في تشغيل البث", details: error.message });
    }
});



















// ==========================================
// مسارات المساعدة والأقسام الثابتة
// ==========================================
app.all("/resolve", async (req, res) => {
    try {
        const targetUrl = req.query.url || req.body.url;
        const channelId = req.query.id_live || req.body.id_live || "test";
        if (!targetUrl) return res.status(400).json({ error: true, message: "يرجى إرسال الرابط (url)" });
        const result = await resolveRedirectUrl(channelId, targetUrl);
        res.json(result ? { success: true, ...result } : { error: true, message: "فشل" });
    } catch (error) { res.status(500).json({ error: true, message: error.message }); }
});

app.get("/extract", async (req, res) => {
    try {
        const targetUrl = req.query.url;
        const channelId = req.query.id_live || "test";
        if (!targetUrl) return res.status(400).json({ error: true, message: "يرجى إرسال الرابط (url)" });
        const result = await resolveRedirectUrl(channelId, targetUrl);
        res.json({ success: !!result, result: result });
    } catch (error) { res.status(500).json({ error: true, message: error.message }); }
});

const allTopics = [
    {"id_topic":"hot_now","name_topic":"الأكثر مشاهدة","img_url_topic":"http://logo.twoapistack.work/img/topics/hot_now.png","code":""},
    {"id_topic":"alwan","name_topic":"الوان","img_url_topic":"http://logo.twoapistack.work/img/topics/alwan.jpg","code":""},
    {"id_topic":"shahid","name_topic":"شاهد","img_url_topic":"http://logo.twoapistack.work/img/topics/shahid.jpg","code":""},
    {"id_topic":"arabic_sport","name_topic":"رياضة","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_basketball_red.png","code":""},
    {"id_topic":"ar_1","name_topic":"ترفيه عربي","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_featured_ar.png","code":""},
    {"id_topic":"ar_2","name_topic":"أخبار","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_newspaper.png","code":""},
    {"id_topic":"ar_3","name_topic":"أطفال","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_kids.jpg","code":""},
    {"id_topic":"ar_5","name_topic":"وثائقي","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_documantry.png","code":""},
    {"id_topic":"ar_6","name_topic":"ديني","img_url_topic":"http://logo.twoapistack.work/img/topics/ic__mosque.png","code":""},
    {"id_topic":"ar_7","name_topic":"أفلام","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_film.png","code":""},
    {"id_topic":"ar_8","name_topic":"موسيقى","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_music.jpg","code":""},
    {"id_topic":"art","name_topic":"ART","img_url_topic":"http://logo.twoapistack.work/img/topics/art.png","code":""},
    {"id_topic":"osn","name_topic":"OSN","img_url_topic":"http://logo.twoapistack.work/img/topics/osn_logo.png","code":""},
    {"id_topic":"netflix","name_topic":"NETFLIX","img_url_topic":"http://logo.twoapistack.work/img/topics/netflix.jpg","code":""},
    {"id_topic":"mbc","name_topic":"MBC","img_url_topic":"http://logo.twoapistack.work/img/topics/mpc.jpg","code":""},
    {"id_topic":"rotana","name_topic":"روتانا","img_url_topic":"http://logo.twoapistack.work/img/topics/rotana.jpg","code":""},
    {"id_topic":"cook","name_topic":"الطبخ","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_chef.png","code":""},
    {"id_topic":"weyyak","name_topic":"وياك","img_url_topic":"http://logo.twoapistack.work/img/topics/weyyak.jpg","code":""},
    {"id_topic":"bein_entir","name_topic":"بي ان ترفيه","img_url_topic":"http://logo.twoapistack.work/img/topics/bein_enter.jpg","code":""},
    {"id_topic":"bein_sport","name_topic":"بي ان سبورت","img_url_topic":"http://logo.twoapistack.work/img/topics/bein_sport.png","code":""},
    {"id_topic":"science","name_topic":"علوم","img_url_topic":"http://logo.twoapistack.work/img/topics/science.png","code":""},
    {"id_topic":"anime","name_topic":"انيمي","img_url_topic":"http://logo.twoapistack.work/img/topics/anime.jpg","code":""},
    {"id_topic":"roya","name_topic":"رؤيا","img_url_topic":"https://backend.roya-tv.com/imagechanger/Size01Q40R11/images/channels/iMoPuU3u5qnqMsL.png","code":""},
    {"id_topic":"963","name_topic":"سوريا","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_sy.png","code":"sy"},
    {"id_topic":"961","name_topic":"لبنان","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_lb.png","code":"lb"},
    {"id_topic":"966","name_topic":"السعودية","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_sa.png","code":"sa"},
    {"id_topic":"20","name_topic":"مصر","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_eg.png","code":"eg"},
    {"id_topic":"971","name_topic":"الإمارات العربية المتحدة","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_ae.png","code":"ae"},
    {"id_topic":"962","name_topic":"الأردن","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_jo.png","code":"jo"},
    {"id_topic":"974","name_topic":"قطر","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_qa.png","code":"qa"},
    {"id_topic":"964","name_topic":"العراق","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_iq.png","code":"iq"},
    {"id_topic":"965","name_topic":"الكويت","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_kw.png","code":"kw"},
    {"id_topic":"968","name_topic":"عُمان","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_om.png","code":"om"},
    {"id_topic":"967","name_topic":"اليمن","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_ye.png","code":"ye"},
    {"id_topic":"973","name_topic":"البحرين","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_bh.png","code":"bh"},
    {"id_topic":"970","name_topic":"فلسطين","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_ps.png","code":"ps"},
    {"id_topic":"249","name_topic":"السودان","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_sd.png","code":""},
    {"id_topic":"216","name_topic":"تونس","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_tn.png","code":""},
    {"id_topic":"212","name_topic":"المغرب","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_ma.png","code":""},
    {"id_topic":"213","name_topic":"الجزائر","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_dz.png","code":""},
    {"id_topic":"218","name_topic":"ليبيا","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_ly.png","code":""},
    {"id_topic":"252","name_topic":"الصومال","img_url_topic":"http://logo.twoapistack.work/img/topics/ic_flag_so.png","code":""}
];
app.get("/get-all-topics", (req, res) => { res.json(allTopics); });

app.listen(PORT, () => { console.log("🚀 Server running on port " + PORT); });
