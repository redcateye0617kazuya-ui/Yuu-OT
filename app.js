import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
    getFirestore, doc, setDoc, getDoc, onSnapshot, updateDoc, deleteDoc,
    collection, addDoc, getDocs, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// ==========================================
// Firebase 設定配置
// ==========================================
const firebaseConfig = {
    apiKey: "AIzaSyCO1i0d_c7EO4jonhTx7ylib2-xAEbLa5M",
    authDomain: "overtime-dashboard.firebaseapp.com",
    projectId: "overtime-dashboard",
    storageBucket: "overtime-dashboard.firebasestorage.app",
    messagingSenderId: "442932326873",
    appId: "1:442932326873:web:18a57cdfc48d31b62369c8"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const campaignRef = doc(db, "campaign", "main");
const rulesColRef = collection(db, "rules");
const sessionsColRef = collection(db, "sessions");
const wheelsColRef = collection(db, "wheels");
const presenceColRef = collection(db, "presence");

const TAB_LABELS = { dashboard: "主控台", record: "Record / Report", rule: "Rule Setting", wheel: "輪盤" };
const PRESENCE_STALE_MS = 45000;
const PRESENCE_HEARTBEAT_MS = 15000;

let timerInterval = null;
let statTickInterval = null;
let scPollInterval = null;
let currentPolledChatId = null;
let rulesCache = [];
let wheelsCache = [];
const wheelRotationState = {};
let lastCampaignUpdateTime = null;
let lastLiveHoursUpdateTime = null;
let lastPendingSpinsUpdateTime = null;
let presenceHeartbeatInterval = null;
let myCurrentTab = "dashboard";

// ==========================================
// 工具函數
// ==========================================
function escapeHtml(str) {
    if (str == null) return "";
    return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function genId() {
    return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function getMyClientId() {
    let clientId = localStorage.getItem("clientId");
    if (!clientId) {
        clientId = genId();
        localStorage.setItem("clientId", clientId);
    }
    return clientId;
}

function getMyDisplayName() {
    let name = localStorage.getItem("displayName");
    if (!name) {
        name = (prompt("請輸入你嘅名，等其他共用緊嘅人知道你喺度：", "") || "").trim();
        if (!name) name = "訪客";
        localStorage.setItem("displayName", name);
    }
    return name;
}

const notifiedErrorContexts = new Set();
function notifyFirestoreError(context, error) {
    console.error(`Firestore 同步失敗 [${context}]:`, error);
    if (notifiedErrorContexts.has(context)) return;
    notifiedErrorContexts.add(context);
    alert(`${context} 同步失敗：${error.message}\n（請檢查 Firestore Rules 權限）`);
}

function formatMs(ms) {
    if (ms < 0) ms = 0;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function hkTimeString(ts) {
    return new Date(ts).toLocaleString("en-US", { timeZone: "Asia/Hong_Kong" });
}

function mergeLeaderboards(scList, paymeList) {
    const merged = new Map();
    (scList || []).forEach((e) => merged.set(e.name, (merged.get(e.name) || 0) + e.amount));
    (paymeList || []).forEach((e) => merged.set(e.name, (merged.get(e.name) || 0) + e.amount));
    return Array.from(merged, ([name, amount]) => ({ name, amount }));
}

function relativeTimeLabel(ts) {
    if (!ts) return "--";
    const diffSec = Math.floor((Date.now() - ts) / 1000);
    if (diffSec < 5) return "剛剛更新";
    if (diffSec < 60) return `${diffSec}秒前更新`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}分鐘前更新`;
    const diffHour = Math.floor(diffMin / 60);
    return `${diffHour}小時前更新`;
}

function updateStatCards(data) {
    const scTotal = (data.leaderboardSc || []).reduce((s, e) => s + (e.amount || 0), 0);
    const paymeTotal = (data.leaderboardPayme || []).reduce((s, e) => s + (e.amount || 0), 0);

    const scEl = document.getElementById("statScTotal");
    const paymeEl = document.getElementById("statPaymeTotal");
    if (scEl) scEl.textContent = `$${scTotal.toLocaleString()}`;
    if (paymeEl) paymeEl.textContent = `$${paymeTotal.toLocaleString()}`;

    lastCampaignUpdateTime = Date.now();
}

function updatePendingSpinsStat() {
    const pending = wheelsCache.reduce((sum, w) => sum + Math.max(0, (w.spinCreditsTotal || 0) - (w.spinCreditsUsed || 0)), 0);
    const el = document.getElementById("statPendingSpins");
    if (el) el.textContent = pending;
    lastPendingSpinsUpdateTime = Date.now();
}

function tickStatTimestamps() {
    const campaignLabel = relativeTimeLabel(lastCampaignUpdateTime);
    ["statScUpdated", "statPaymeUpdated"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = campaignLabel;
    });
    const pendingSpinsUpdatedEl = document.getElementById("statPendingSpinsUpdated");
    if (pendingSpinsUpdatedEl) pendingSpinsUpdatedEl.textContent = relativeTimeLabel(lastPendingSpinsUpdateTime);
    const liveHoursUpdatedEl = document.getElementById("statLiveHoursUpdated");
    if (liveHoursUpdatedEl) liveHoursUpdatedEl.textContent = relativeTimeLabel(lastLiveHoursUpdateTime);
}

async function refreshLiveStats() {
    try {
        const qs = await getDocs(sessionsColRef);
        let totalMs = 0;
        qs.forEach((d) => {
            const s = d.data();
            if (s.sessionStartTime && s.sessionEndTime) totalMs += (s.sessionEndTime - s.sessionStartTime);
        });
        const el = document.getElementById("statLiveHours");
        if (el) el.textContent = `${(totalMs / 3600000).toFixed(1)}H`;
        lastLiveHoursUpdateTime = Date.now();
    } catch (e) {
        console.error("讀取累積直播時數失敗:", e);
    }
}

function extractVideoId(url) {
    const patterns = [
        /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
        /(?:watch\?v=)([a-zA-Z0-9_-]{11})/,
        /(?:\/live\/)([a-zA-Z0-9_-]{11})/,
        /(?:\/shorts\/)([a-zA-Z0-9_-]{11})/,
        /(?:embed\/)([a-zA-Z0-9_-]{11})/
    ];
    for (const p of patterns) {
        const m = url.match(p);
        if (m) return m[1];
    }
    if (/^[a-zA-Z0-9_-]{11}$/.test(url.trim())) return url.trim();
    return "";
}

// ==========================================
// Rule Engine：連續累計分級加鐘
// ==========================================
function computeBonusMs(totalAmount, rules) {
    if (!rules || rules.length === 0 || totalAmount <= 0) return 0;
    const sorted = [...rules].sort((a, b) => a.minAmount - b.minAmount);
    let carry = 0;
    let bonusHours = 0;
    for (const tier of sorted) {
        if (totalAmount <= tier.minAmount) break;
        const tierMax = (tier.maxAmount == null) ? Infinity : tier.maxAmount;
        const bandAmount = Math.min(totalAmount, tierMax) - tier.minAmount;
        const interval = tier.interval > 0 ? tier.interval : Infinity;
        const available = bandAmount + carry;
        const intervalsHit = Math.floor(available / interval);
        bonusHours += intervalsHit * (tier.hours || 1);
        carry = available - intervalsHit * interval;
        if (totalAmount <= tierMax) break;
    }
    return bonusHours * 3600000;
}

function computeIsTimeUp(data) {
    if (data.status !== "running" && data.status !== "paused") return false;
    const remaining = data.isPaused ? (data.pausedRemainingMs || 0) : ((data.targetEndTime || 0) - Date.now());
    return remaining <= 0;
}

// ==========================================
// Campaign（馬拉松總狀態）同步
// ==========================================
let campaignCache = null;

function setupCampaignSync() {
    onSnapshot(campaignRef, (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        campaignCache = data;

        const apiKeyInput = document.getElementById("yt_api_key");
        apiKeyInput.value = data.ytApiKey || "";
        apiKeyInput.readOnly = !!data.ytApiKey;
        apiKeyInput.classList.toggle("locked-input", !!data.ytApiKey);
        apiKeyInput.title = data.ytApiKey ? "API Key 已鎖定，重設馬拉松先可以修改" : "";

        const isIdle = !data.status || data.status === "idle";
        const durationInput = document.getElementById("duration");
        if (durationInput) durationInput.style.display = isIdle ? "" : "none";

        const finishBtn = document.getElementById("finishBtn");
        if (finishBtn) finishBtn.disabled = !(data.status === "running" || data.status === "paused");

        const session = data.currentSession || {};
        if (session.active) {
            document.getElementById("video_url").value = session.videoUrl || "";
            document.getElementById("statusBox").innerText = `狀態：直播中 (${session.videoTitle || "Live"})`;
            document.getElementById("cutoffBtn").style.display = "inline-block";
            if (session.liveChatId && data.ytApiKey) {
                startScPolling(session.liveChatId, data.ytApiKey);
            } else {
                stopScPolling();
            }
        } else {
            document.getElementById("video_url").value = "";
            let statusText = "狀態：等待新 Link（馬拉松進行中）";
            if (isIdle) statusText = "狀態：未開始";
            else if (data.status === "ended") statusText = "狀態：直播馬拉松已完成";
            document.getElementById("statusBox").innerText = statusText;
            document.getElementById("cutoffBtn").style.display = "none";
            stopScPolling();
        }

        window.campaignStatus = data.status;
        window.campaignIsPaused = data.isPaused;
        window.campaignStartTime = data.startTime;
        window.campaignTargetEndTime = data.targetEndTime;
        window.campaignPausedRemainingMs = data.pausedRemainingMs;

        if (data.status === "running" || data.status === "paused") {
            if (!timerInterval) timerInterval = setInterval(updateCountdown, 1000);
            document.getElementById("pauseBtn").disabled = false;
            document.getElementById("pauseBtn").innerText = data.isPaused ? "繼續" : "暫停";
            updateCountdown();
        } else if (data.status === "ended") {
            if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
            document.getElementById("pauseBtn").disabled = true;
            document.getElementById("pauseBtn").innerText = "暫停";
            document.getElementById("countdown").innerText = "已完成";
            document.getElementById("startTimeBox").innerText =
                `開始時間：${data.startTime ? hkTimeString(data.startTime) : "--"}`;
            document.getElementById("endTimeBox").innerText = "收工時間：已完成直播";
        } else {
            if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
            document.getElementById("pauseBtn").disabled = true;
            document.getElementById("pauseBtn").innerText = "暫停";
            document.getElementById("countdown").innerText = "--:--:--";
            document.getElementById("startTimeBox").innerText = "開始時間：--";
            document.getElementById("endTimeBox").innerText = "收工時間：--";
        }

        const totalText = `Total：$HKD ${(data.totalAmount || 0).toLocaleString()}`;
        document.getElementById("totalAmountBox").innerText = totalText;
        const recordTotalBox = document.getElementById("recordTotalAmount");
        if (recordTotalBox) recordTotalBox.innerText = totalText;

        renderLeaderboard("scLeaderboard", mergeLeaderboards(data.leaderboardSc, data.leaderboardPayme));
        renderSessionFeed("sessionPaymeFeed", data.currentSessionPaymeEvents);
        renderSessionFeed("sessionScFeed", data.currentSessionScEvents);
        updateStatCards(data);
    }, (error) => notifyFirestoreError("Campaign", error));
}

function updateCountdown() {
    if (!window.campaignTargetEndTime) return;
    const now = Date.now();
    const distance = window.campaignIsPaused ? (window.campaignPausedRemainingMs || 0) : (window.campaignTargetEndTime - now);
    document.getElementById("countdown").innerText = formatMs(distance);
    document.getElementById("startTimeBox").innerText =
        `開始時間：${window.campaignStartTime ? hkTimeString(window.campaignStartTime) : "--"}`;
    const endTimeShown = window.campaignIsPaused ? (now + (window.campaignPausedRemainingMs || 0)) : window.campaignTargetEndTime;
    document.getElementById("endTimeBox").innerText = `收工時間：${hkTimeString(endTimeShown)}`;
}

function renderLeaderboard(containerId, list) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!list || list.length === 0) {
        container.innerHTML = '<div class="empty-hint">暫時未有紀錄</div>';
        return;
    }
    const sorted = [...list].sort((a, b) => b.amount - a.amount);
    const rankColors = ["teal", "gold", "slate", "navy", "taupe"];
    container.innerHTML = sorted.map((entry, i) => `
        <div class="leaderboard-row">
            <span class="rank-dot rank-${rankColors[i % rankColors.length]}"></span>
            <span class="rank">#${i + 1}</span>
            <span class="lb-name">${escapeHtml(entry.name)}</span>
            <span class="lb-amount">$HKD ${entry.amount.toLocaleString()}</span>
        </div>
    `).join("");
}

function renderSessionFeed(containerId, events) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!events || events.length === 0) {
        container.innerHTML = '<div class="empty-hint">暫時未有紀錄</div>';
        return;
    }
    const newestFirst = [...events].reverse();
    container.innerHTML = newestFirst.map((e) => `
        <div class="session-feed-row">
            <span class="feed-name">${escapeHtml(e.name)}</span>
            <span class="feed-amount">$HKD ${(e.amount || 0).toLocaleString()}</span>
            <span class="feed-time">${escapeHtml(e.time || "")}</span>
        </div>
    `).join("");
}

// ==========================================
// 直播 Session 開始 / Cut Off
// ==========================================
async function fetchYouTubeInfo(videoUrl, videoId) {
    let title = "YouTube 直播節目";
    let thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    try {
        const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`);
        if (res.ok) {
            const info = await res.json();
            if (info.title) title = info.title;
            if (info.thumbnail_url) thumbnail = info.thumbnail_url;
        }
    } catch (e) {
        console.log("使用預設封面與標題");
    }
    return { title, thumbnail };
}

async function fetchLiveChatId(videoId, apiKey) {
    try {
        const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${apiKey}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) {
            alert("YouTube API 錯誤: " + data.error.message);
            return null;
        }
        if (data.items && data.items.length > 0) {
            return data.items[0].liveStreamingDetails?.activeLiveChatId || null;
        }
    } catch (e) {
        console.error("獲取 liveChatId 網絡異常:", e);
    }
    return null;
}

async function startSession() {
    const videoUrl = document.getElementById("video_url").value.trim();
    const apiKey = document.getElementById("yt_api_key").value.trim();
    if (!videoUrl) { alert("請輸入 YouTube 連結！"); return; }
    if (!apiKey) { alert("請先輸入你的 YouTube Data API Key！"); return; }

    const videoId = extractVideoId(videoUrl);
    if (!videoId) { alert("請輸入有效的 YouTube 連結！"); return; }

    const snap = await getDoc(campaignRef);
    const data = snap.exists() ? snap.data() : null;
    if (data && data.currentSession && data.currentSession.active) {
        alert("而家已經有直播 Session 進行緊，請先 Cut Off 先可以入新 Link！");
        return;
    }
    if (data && data.status === "ended") {
        alert("馬拉松已經完成直播，如要開新一輪請先撳「重設馬拉松」。");
        return;
    }

    const ytInfo = await fetchYouTubeInfo(videoUrl, videoId);
    const liveChatId = await fetchLiveChatId(videoId, apiKey);
    if (!liveChatId) {
        alert("警告：無法獲取該直播的 LiveChatId，SC 將無法自動同步，請確保輸入的是正在進行中的直播連結。");
    }

    const isFirstEverStart = !data || !data.status || data.status === "idle";

    const now = Date.now();
    const updatePayload = {
        ytApiKey: apiKey,
        currentSession: {
            active: true,
            videoUrl, videoId,
            videoTitle: ytInfo.title,
            thumbnailUrl: ytInfo.thumbnail,
            liveChatId: liveChatId || "",
            sessionStartTime: now
        },
        currentSessionScEvents: [],
        currentSessionPaymeEvents: [],
        currentSessionMembershipEvents: []
    };

    if (isFirstEverStart) {
        // 馬拉松第一次開始：用呢次嘅基本開台鐘數起錶，之後換 Link 唔會再加呢筆
        const hoursToAdd = parseFloat(document.getElementById("duration").value);
        if (isNaN(hoursToAdd) || hoursToAdd <= 0) { alert("請輸入正確嘅基本開台鐘數！"); return; }
        updatePayload.status = "running";
        updatePayload.isPaused = false;
        updatePayload.startTime = now;
        updatePayload.targetEndTime = now + hoursToAdd * 3600000;
        updatePayload.pausedRemainingMs = 0;
        updatePayload.totalAmount = 0;
        updatePayload.bonusMsGranted = 0;
        updatePayload.leaderboardSc = [];
        updatePayload.leaderboardPayme = [];
    }

    await setDoc(campaignRef, updatePayload, { merge: true });
    alert(isFirstEverStart ? "成功開始馬拉松！" : "成功開始新直播 Session！");
}

async function cutOffSession() {
    if (!confirm("確定要幫呢場直播埋數？（馬拉松總 Timer 會繼續行，唔會停）")) return;
    stopScPolling();

    const snap = await getDoc(campaignRef);
    if (!snap.exists()) return;
    const data = snap.data();
    const session = data.currentSession;
    if (!session || !session.active) { alert("而家冇進行緊嘅直播 Session"); return; }

    const now = Date.now();
    const scEvents = data.currentSessionScEvents || [];
    const paymeEvents = data.currentSessionPaymeEvents || [];
    const scTotal = scEvents.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const paymeTotal = paymeEvents.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
    const elapsedMs = now - (session.sessionStartTime || now);

    try {
        await addDoc(sessionsColRef, {
            videoUrl: session.videoUrl || "",
            videoId: session.videoId || "",
            videoTitle: session.videoTitle || "YouTube 直播節目",
            thumbnailUrl: session.thumbnailUrl || "",
            sessionStartTime: session.sessionStartTime || now,
            sessionEndTime: now,
            elapsedStr: formatMs(elapsedMs),
            scEvents, paymeEvents, scTotal, paymeTotal,
            sessionTotal: scTotal + paymeTotal
        });
    } catch (e) {
        console.error("寫入單場直播記錄失敗: ", e);
        alert("寫入單場直播記錄失敗：" + e.message + "\n（請檢查 Firestore Rules 是否有開放 sessions collection 的寫入權限）");
        return;
    }

    await updateDoc(campaignRef, {
        currentSession: { active: false },
        currentSessionScEvents: [],
        currentSessionPaymeEvents: [],
        currentSessionMembershipEvents: []
    });
    refreshLiveStats();
    alert("埋數成功！馬拉松總 Timer 繼續行緊，可以隨時入新 Link 開新場。");
}

async function togglePause() {
    const snap = await getDoc(campaignRef);
    if (!snap.exists()) return;
    const data = snap.data();
    if (data.status !== "running" && data.status !== "paused") return;

    if (!data.isPaused) {
        const remaining = Math.max(0, (data.targetEndTime || 0) - Date.now());
        await updateDoc(campaignRef, { status: "paused", isPaused: true, pausedRemainingMs: remaining });
    } else {
        await updateDoc(campaignRef, {
            status: "running", isPaused: false,
            targetEndTime: Date.now() + (data.pausedRemainingMs || 0),
            pausedRemainingMs: 0
        });
    }
}

async function adjustTime(deltaMs, silent) {
    const snap = await getDoc(campaignRef);
    if (!snap.exists() || (snap.data().status !== "running" && snap.data().status !== "paused")) {
        if (!silent) alert("馬拉松未開始，無法調整時間");
        return false;
    }
    const data = snap.data();
    if (computeIsTimeUp(data)) {
        if (!silent) alert("倒數已經去到 0:00:00，時間已經鎖定，無法再加/減鐘。");
        return false;
    }
    if (data.isPaused) {
        await updateDoc(campaignRef, { pausedRemainingMs: Math.max(0, (data.pausedRemainingMs || 0) + deltaMs) });
    } else {
        await updateDoc(campaignRef, { targetEndTime: (data.targetEndTime || Date.now()) + deltaMs });
    }
    return true;
}

async function finishMarathon() {
    const snap = await getDoc(campaignRef);
    if (!snap.exists()) return;
    const data = snap.data();
    if (data.status !== "running" && data.status !== "paused") {
        alert("馬拉松未開始或者已經完成，冇嘢好完成。");
        return;
    }
    if (data.currentSession && data.currentSession.active) {
        alert("而家仲有直播 Session 進行緊，請先 Cut Off 埋數先可以完成直播。");
        return;
    }
    if (!confirm("確定要完成成個直播馬拉松？完成之後就唔可以再開新 Session 或者加鐘，直到你「重設馬拉松」開新一輪為止。")) return;
    stopScPolling();
    await updateDoc(campaignRef, { status: "ended", isPaused: false });
    alert("直播馬拉松已經完成！");
}

async function resetCampaign() {
    if (!confirm("確定要完全重設成個馬拉松？呢個動作會清空 Total 金額、排行榜同 Timer，但唔會刪走已經 Cut Off 嘅單場 Record。")) return;
    if (!confirm("再次確認：真係要重設？此動作無法復原。")) return;
    stopScPolling();
    await setDoc(campaignRef, {
        status: "idle", isPaused: false, startTime: null, targetEndTime: null, pausedRemainingMs: 0,
        totalAmount: 0, bonusMsGranted: 0, leaderboardSc: [], leaderboardPayme: [],
        currentSession: { active: false }, currentSessionScEvents: [], currentSessionPaymeEvents: [],
        currentSessionMembershipEvents: []
    });
}

// ==========================================
// 課金（SuperChat / PayMe）寫入 + 規則引擎重算
// ==========================================
async function addContributionAndRecalc({ isSuperChat, id, name, amount, time, message }) {
    const snap = await getDoc(campaignRef);
    if (!snap.exists()) return false;
    const data = snap.data();

    const sessionKey = isSuperChat ? "currentSessionScEvents" : "currentSessionPaymeEvents";
    const sessionEvents = data[sessionKey] || [];
    if (sessionEvents.some((e) => e.id === id)) return false;

    sessionEvents.push({ id, name, amount, time, message: message || "" });

    const lbKey = isSuperChat ? "leaderboardSc" : "leaderboardPayme";
    const leaderboard = data[lbKey] || [];
    const existing = leaderboard.find((e) => e.name === name);
    if (existing) existing.amount += amount;
    else leaderboard.push({ name, amount });

    const newTotal = (data.totalAmount || 0) + amount;
    const newBonusMs = computeBonusMs(newTotal, rulesCache);
    const oldBonusMs = data.bonusMsGranted || 0;
    const deltaMs = newBonusMs - oldBonusMs;

    const updatePayload = {
        totalAmount: newTotal,
        bonusMsGranted: newBonusMs,
        [sessionKey]: sessionEvents,
        [lbKey]: leaderboard
    };
    if (deltaMs !== 0 && (data.status === "running" || data.status === "paused") && !computeIsTimeUp(data)) {
        updatePayload.targetEndTime = (data.targetEndTime || Date.now()) + deltaMs;
    }

    await updateDoc(campaignRef, updatePayload);
    await applyAmountSpinCreditRules(amount);
    return true;
}

// ==========================================
// 送會員（Membership Gifting）監聽
// ==========================================
async function addMembershipGiftEvent({ id, name, count, time }) {
    const snap = await getDoc(campaignRef);
    if (!snap.exists()) return;
    const data = snap.data();
    const events = data.currentSessionMembershipEvents || [];
    if (events.some((e) => e.id === id)) return;
    events.push({ id, name, count, time });

    await updateDoc(campaignRef, { currentSessionMembershipEvents: events });
    await applyMembershipSpinCreditRules(count);
}

// ==========================================
// 抽獎機會：逐個輪盤自訂規則
// ==========================================
async function applyAmountSpinCreditRules(amount) {
    for (const wheel of wheelsCache) {
        if (!wheel.spinRuleAmountEnabled || !(wheel.spinRuleAmount > 0)) continue;
        const creditsToAdd = Math.floor(amount / wheel.spinRuleAmount);
        if (creditsToAdd > 0) {
            await updateDoc(doc(db, "wheels", wheel.id), {
                spinCreditsTotal: (wheel.spinCreditsTotal || 0) + creditsToAdd
            });
        }
    }
}

async function applyMembershipSpinCreditRules(giftCount) {
    for (const wheel of wheelsCache) {
        if (!wheel.spinRuleMembershipEnabled || !(wheel.spinRuleMembershipCount > 0)) continue;
        const creditsToAdd = Math.floor(giftCount / wheel.spinRuleMembershipCount);
        if (creditsToAdd > 0) {
            await updateDoc(doc(db, "wheels", wheel.id), {
                spinCreditsTotal: (wheel.spinCreditsTotal || 0) + creditsToAdd
            });
        }
    }
}

function getHKDateString(ts) {
    return new Date(ts).toLocaleDateString("en-CA", { timeZone: "Asia/Hong_Kong" });
}

function getHKTimeHHMM(ts) {
    return new Date(ts).toLocaleTimeString("en-GB", { timeZone: "Asia/Hong_Kong", hour: "2-digit", minute: "2-digit", hour12: false });
}

async function checkDailySpinCredits() {
    const now = Date.now();
    const todayStr = getHKDateString(now);
    const nowHHMM = getHKTimeHHMM(now);
    for (const wheel of wheelsCache) {
        if (!wheel.spinRuleDailyEnabled || !wheel.spinRuleDailyTime) continue;
        if (wheel.spinRuleDailyLastGrantDate === todayStr) continue;
        if (nowHHMM < wheel.spinRuleDailyTime) continue;
        await updateDoc(doc(db, "wheels", wheel.id), {
            spinCreditsTotal: (wheel.spinCreditsTotal || 0) + 1,
            spinRuleDailyLastGrantDate: todayStr
        });
    }
}

async function addPayme() {
    const nameInput = document.getElementById("payme_name");
    const amountInput = document.getElementById("payme_amount");
    const name = nameInput.value.trim();
    const amount = parseFloat(amountInput.value);
    if (!name || isNaN(amount) || amount <= 0) { alert("請輸入姓名同有效金額"); return; }

    const snap = await getDoc(campaignRef);
    if (!snap.exists() || !(snap.data().currentSession && snap.data().currentSession.active)) {
        alert("而家冇進行緊嘅直播 Session，請先入 Link 開始！");
        return;
    }

    await addContributionAndRecalc({
        isSuperChat: false,
        id: genId(),
        name, amount,
        time: new Date().toLocaleTimeString("en-US", { timeZone: "Asia/Hong_Kong", hour12: false }),
        message: ""
    });
    nameInput.value = "";
    amountInput.value = "";
}

function startScPolling(liveChatId, apiKey) {
    if (scPollInterval && currentPolledChatId === liveChatId) return;
    stopScPolling();
    currentPolledChatId = liveChatId;
    let nextPageToken = null;

    async function poll() {
        try {
            let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&key=${apiKey}`;
            if (nextPageToken) url += `&pageToken=${nextPageToken}`;

            const res = await fetch(url);
            if (!res.ok) { console.error("SC 輪詢 API 回應錯誤", res.status); return; }
            const data = await res.json();
            if (data.nextPageToken) nextPageToken = data.nextPageToken;
            if (!data.items) return;

            for (const item of data.items) {
                if (item.snippet.type === "superChatEvent") {
                    const scDetails = item.snippet.superChatDetails;
                    if (!scDetails) continue;
                    const amount = scDetails.amountMicros ? scDetails.amountMicros / 1000000 : 0;
                    await addContributionAndRecalc({
                        isSuperChat: true,
                        id: item.id,
                        name: item.authorDetails.displayName,
                        amount,
                        time: new Date(item.snippet.publishedAt).toLocaleTimeString("en-US", { timeZone: "Asia/Hong_Kong", hour12: false }),
                        message: scDetails.userComment || ""
                    });
                } else if (item.snippet.type === "membershipGiftingEvent") {
                    const giftDetails = item.snippet.membershipGiftingDetails;
                    if (!giftDetails) continue;
                    await addMembershipGiftEvent({
                        id: item.id,
                        name: item.authorDetails.displayName,
                        count: giftDetails.giftMembershipsCount || 0,
                        time: new Date(item.snippet.publishedAt).toLocaleTimeString("en-US", { timeZone: "Asia/Hong_Kong", hour12: false })
                    });
                }
            }
        } catch (e) {
            console.error("輪詢 SC 出錯:", e);
        }
    }

    poll();
    scPollInterval = setInterval(poll, 10000);
}

function stopScPolling() {
    if (scPollInterval) { clearInterval(scPollInterval); scPollInterval = null; }
    currentPolledChatId = null;
}

// ==========================================
// Rule Setting
// ==========================================
function setupRulesSync() {
    onSnapshot(query(rulesColRef, orderBy("minAmount")), (qs) => {
        rulesCache = [];
        qs.forEach((d) => rulesCache.push({ id: d.id, ...d.data() }));
        renderRuleList();
    }, (error) => notifyFirestoreError("Rule Setting", error));
}

function renderRuleList() {
    const container = document.getElementById("ruleListContainer");
    if (!container) return;
    if (rulesCache.length === 0) {
        container.innerHTML = '<div class="empty-hint">未設定任何規則</div>';
        return;
    }
    container.innerHTML = "";
    rulesCache.forEach((rule) => {
        const row = document.createElement("div");
        row.className = "rule-row";
        const maxText = (rule.maxAmount == null) ? "無上限" : `$${rule.maxAmount.toLocaleString()}`;
        row.innerHTML = `
            <span class="rule-text">$${rule.minAmount.toLocaleString()} - ${maxText}：每 $${rule.interval.toLocaleString()} 加 ${rule.hours} 小時</span>
            <button type="button" class="del-btn">✕</button>
        `;
        row.querySelector(".del-btn").addEventListener("click", () => deleteRule(rule.id));
        container.appendChild(row);
    });
}

async function reapplyRulesToCampaign() {
    const snap = await getDoc(campaignRef);
    if (!snap.exists()) return;
    const data = snap.data();
    if (!data.status || data.status === "idle") return;
    const newBonusMs = computeBonusMs(data.totalAmount || 0, rulesCache);
    const deltaMs = newBonusMs - (data.bonusMsGranted || 0);
    if (deltaMs === 0) return;
    const updatePayload = { bonusMsGranted: newBonusMs };
    if (!computeIsTimeUp(data)) {
        updatePayload.targetEndTime = (data.targetEndTime || Date.now()) + deltaMs;
    }
    await updateDoc(campaignRef, updatePayload);
}

async function addRule() {
    const min = parseFloat(document.getElementById("ruleMin").value);
    const maxRaw = document.getElementById("ruleMax").value.trim();
    const interval = parseFloat(document.getElementById("ruleInterval").value);
    const hours = parseFloat(document.getElementById("ruleHours").value) || 1;
    if (isNaN(min) || isNaN(interval) || interval <= 0) { alert("請輸入正確嘅金額同間距"); return; }
    const max = maxRaw === "" ? null : parseFloat(maxRaw);
    if (max !== null && max <= min) { alert("上限金額要大過下限金額"); return; }

    await addDoc(rulesColRef, { minAmount: min, maxAmount: max, interval, hours });
    document.getElementById("ruleMin").value = "";
    document.getElementById("ruleMax").value = "";
    document.getElementById("ruleInterval").value = "";
    document.getElementById("ruleHours").value = "1";
    await reapplyRulesToCampaign();
}

async function deleteRule(ruleId) {
    if (!confirm("確定要刪除呢條規則？")) return;
    await deleteDoc(doc(db, "rules", ruleId));
    await reapplyRulesToCampaign();
}

// ==========================================
// 輪盤
// ==========================================
function setupWheelsSync() {
    onSnapshot(wheelsColRef, (qs) => {
        wheelsCache = [];
        qs.forEach((d) => wheelsCache.push({ id: d.id, ...d.data() }));
        renderWheels();
        updatePendingSpinsStat();
    }, (error) => notifyFirestoreError("輪盤", error));
}

function drawWheel(canvas, items) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 4;
    ctx.clearRect(0, 0, w, h);

    if (!items || items.length === 0) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = "#FBF5EE";
        ctx.fill();
        ctx.strokeStyle = "#EEE1D0";
        ctx.stroke();
        ctx.fillStyle = "#96897A";
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("未有項目", cx, cy);
        return;
    }

    const palette = ["#E8734A", "#F0A93E", "#6B9E78", "#8D5B7C", "#C1552F", "#4F8C82", "#C99A3E", "#8C6E5A"];
    const sliceAngle = (Math.PI * 2) / items.length;

    ctx.save();
    ctx.translate(cx, cy);
    items.forEach((item, i) => {
        const start = i * sliceAngle;
        const end = start + sliceAngle;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r, start, end);
        ctx.closePath();
        ctx.fillStyle = palette[i % palette.length];
        ctx.fill();
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.save();
        const midAngle = start + sliceAngle / 2;
        const flipped = Math.cos(midAngle) < 0;
        ctx.rotate(flipped ? midAngle + Math.PI : midAngle);
        ctx.textAlign = flipped ? "left" : "right";
        ctx.fillStyle = "#FFFFFF";
        ctx.font = "bold 17px sans-serif";
        const label = item.label.length > 14 ? item.label.slice(0, 14) + "…" : item.label;
        ctx.fillText(label, flipped ? -(r - 20) : (r - 20), 6);
        ctx.restore();
    });
    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(cx - 14, 10);
    ctx.lineTo(cx + 14, 10);
    ctx.lineTo(cx, 36);
    ctx.closePath();
    ctx.fillStyle = "#1A1A1A";
    ctx.fill();
}

function renderWheels() {
    const container = document.getElementById("wheelListContainer");
    if (!container) return;
    if (wheelsCache.length === 0) {
        container.innerHTML = '<div class="empty-hint">未有任何輪盤，按上面「新增輪盤」開始</div>';
        return;
    }
    container.innerHTML = "";
    wheelsCache.forEach((wheel) => container.appendChild(buildWheelBlock(wheel)));
}

function buildWheelBlock(wheel) {
    const block = document.createElement("div");
    block.className = "wheel-block";
    const items = wheel.items || [];
    const spins = wheel.spins || [];

    block.innerHTML = `
        <div class="wheel-block-header">
            <input type="text" class="wheel-name-input" value="${escapeHtml(wheel.name || "")}">
            <button type="button" class="del-wheel-btn">刪除輪盤</button>
        </div>
        <div class="wheel-credit-rules">
            <label class="spin-rule-label">
                <input type="checkbox" class="wr-amount-enabled" ${wheel.spinRuleAmountEnabled ? "checked" : ""}>
                課金滿 <input type="number" class="wr-amount-value" value="${wheel.spinRuleAmount || ""}" placeholder="$" style="display:${wheel.spinRuleAmountEnabled ? "" : "none"};">
                送一次機會
            </label>
            <label class="spin-rule-label">
                <input type="checkbox" class="wr-membership-enabled" ${wheel.spinRuleMembershipEnabled ? "checked" : ""}>
                單次送會員達 <input type="number" class="wr-membership-value" value="${wheel.spinRuleMembershipCount || ""}" placeholder="個數" style="display:${wheel.spinRuleMembershipEnabled ? "" : "none"};">
                個送一次機會
            </label>
            <label class="spin-rule-label">
                <input type="checkbox" class="wr-daily-enabled" ${wheel.spinRuleDailyEnabled ? "checked" : ""}>
                每日 <input type="time" class="wr-daily-value" value="${wheel.spinRuleDailyTime || ""}" style="display:${wheel.spinRuleDailyEnabled ? "" : "none"};">
                送一次機會
            </label>
            <button type="button" class="save-wheel-rules-btn">儲存規則</button>
        </div>
        <div class="wheel-block-body">
            <div class="wheel-items-col">
                <div class="wheel-item-add-row">
                    <input type="text" placeholder="項目名稱" class="wheel-item-label">
                    <label class="wheel-item-toggle"><input type="checkbox" class="wheel-item-affects-timer"> 加鐘</label>
                    <input type="number" placeholder="±小時" class="wheel-item-hours" style="display:none;">
                    <button type="button" class="add-wheel-item-btn">加</button>
                </div>
                <div class="wheel-item-list">
                    ${items.map((it) => `
                        <div class="wheel-item-row" data-item-id="${it.id}">
                            <span>${escapeHtml(it.label)}${it.effectHours != null ? `（${it.effectHours >= 0 ? "+" : ""}${it.effectHours}小時）` : ' <span class="no-effect-tag">（不影響時間）</span>'}</span>
                            <button type="button" class="del-btn del-item-btn">✕</button>
                        </div>
                    `).join("")}
                </div>
            </div>
            <div class="wheel-canvas-col">
                <canvas id="wheelCanvas_${wheel.id}" width="400" height="400"></canvas>
                <button type="button" class="spin-btn">轉！</button>
            </div>
        </div>
        <div class="wheel-spin-history">
            <div class="wheel-spin-history-title">輪盤記錄</div>
            <div class="wheel-spin-list">
                ${spins.length === 0 ? '<div class="empty-hint">未有轉過</div>' : spins.slice().reverse().map((s) => `
                    <div class="wheel-spin-row" data-spin-id="${s.id}">
                        <span>${hkTimeString(s.timestamp)} - ${escapeHtml(s.resultLabel)}${s.effectHours != null ? `（${s.effectHours >= 0 ? "+" : ""}${s.effectHours}小時）` : ''}</span>
                        <button type="button" class="del-btn del-spin-btn">✕</button>
                    </div>
                `).join("")}
            </div>
        </div>
    `;

    block.querySelector(".wheel-name-input").addEventListener("change", (e) => renameWheel(wheel.id, e.target.value));
    block.querySelector(".del-wheel-btn").addEventListener("click", () => deleteWheel(wheel.id));
    block.querySelector(".add-wheel-item-btn").addEventListener("click", () => addWheelItem(wheel.id, block));

    const amountEnabledCb = block.querySelector(".wr-amount-enabled");
    const amountValueInput = block.querySelector(".wr-amount-value");
    amountEnabledCb.addEventListener("change", () => { amountValueInput.style.display = amountEnabledCb.checked ? "" : "none"; });

    const membershipEnabledCb = block.querySelector(".wr-membership-enabled");
    const membershipValueInput = block.querySelector(".wr-membership-value");
    membershipEnabledCb.addEventListener("change", () => { membershipValueInput.style.display = membershipEnabledCb.checked ? "" : "none"; });

    const dailyEnabledCb = block.querySelector(".wr-daily-enabled");
    const dailyValueInput = block.querySelector(".wr-daily-value");
    dailyEnabledCb.addEventListener("change", () => { dailyValueInput.style.display = dailyEnabledCb.checked ? "" : "none"; });

    block.querySelector(".save-wheel-rules-btn").addEventListener("click", () => saveWheelSpinRules(wheel.id, block));
    const affectsCheckbox = block.querySelector(".wheel-item-affects-timer");
    const hoursInputEl = block.querySelector(".wheel-item-hours");
    affectsCheckbox.addEventListener("change", () => {
        hoursInputEl.style.display = affectsCheckbox.checked ? "" : "none";
    });
    block.querySelectorAll(".del-item-btn").forEach((btn) => {
        btn.addEventListener("click", () => deleteWheelItem(wheel.id, btn.closest(".wheel-item-row").dataset.itemId));
    });
    block.querySelectorAll(".del-spin-btn").forEach((btn) => {
        btn.addEventListener("click", () => deleteSpinRecord(wheel.id, btn.closest(".wheel-spin-row").dataset.spinId));
    });
    block.querySelector(".spin-btn").addEventListener("click", (e) => spinWheel(wheel.id, e.target));

    setTimeout(() => {
        const canvasEl = document.getElementById(`wheelCanvas_${wheel.id}`);
        if (canvasEl) {
            drawWheel(canvasEl, items);
            const rot = wheelRotationState[wheel.id] || 0;
            canvasEl.style.transform = `rotate(${rot}deg)`;
        }
    }, 0);

    return block;
}

async function addWheel() {
    const name = prompt("請輸入新輪盤名稱：", "時間輪");
    if (name === null) return;
    await addDoc(wheelsColRef, {
        name: name.trim() || "未命名輪盤", items: [], spins: [],
        spinRuleAmountEnabled: false, spinRuleAmount: 0,
        spinRuleMembershipEnabled: false, spinRuleMembershipCount: 0,
        spinRuleDailyEnabled: false, spinRuleDailyTime: "", spinRuleDailyLastGrantDate: null,
        spinCreditsTotal: 0, spinCreditsUsed: 0
    });
}

async function renameWheel(wheelId, newName) {
    await updateDoc(doc(db, "wheels", wheelId), { name: newName.trim() || "未命名輪盤" });
}

async function saveWheelSpinRules(wheelId, blockEl) {
    const amountEnabled = blockEl.querySelector(".wr-amount-enabled").checked;
    const amountValue = parseFloat(blockEl.querySelector(".wr-amount-value").value) || 0;
    const membershipEnabled = blockEl.querySelector(".wr-membership-enabled").checked;
    const membershipValue = parseInt(blockEl.querySelector(".wr-membership-value").value, 10) || 0;
    const dailyEnabled = blockEl.querySelector(".wr-daily-enabled").checked;
    const dailyValue = blockEl.querySelector(".wr-daily-value").value || "";

    await updateDoc(doc(db, "wheels", wheelId), {
        spinRuleAmountEnabled: amountEnabled,
        spinRuleAmount: amountValue,
        spinRuleMembershipEnabled: membershipEnabled,
        spinRuleMembershipCount: membershipValue,
        spinRuleDailyEnabled: dailyEnabled,
        spinRuleDailyTime: dailyValue
    });
    alert("已儲存呢個輪盤嘅抽獎機會規則");
}

async function deleteWheel(wheelId) {
    if (!confirm("確定要刪除成個輪盤？（連同項目同記錄）")) return;
    await deleteDoc(doc(db, "wheels", wheelId));
}

async function addWheelItem(wheelId, blockEl) {
    const labelInput = blockEl.querySelector(".wheel-item-label");
    const affectsCheckbox = blockEl.querySelector(".wheel-item-affects-timer");
    const hoursInput = blockEl.querySelector(".wheel-item-hours");
    const label = labelInput.value.trim();
    if (!label) { alert("請輸入項目名稱"); return; }

    let effectHours = null;
    if (affectsCheckbox.checked) {
        const hrs = parseFloat(hoursInput.value);
        if (isNaN(hrs)) { alert("請輸入小時數，或者取消勾選「加鐘」"); return; }
        effectHours = hrs;
    }

    const wheel = wheelsCache.find((w) => w.id === wheelId);
    if (!wheel) return;
    const items = [...(wheel.items || []), { id: genId(), label, effectHours }];
    await updateDoc(doc(db, "wheels", wheelId), { items });
}

async function deleteWheelItem(wheelId, itemId) {
    const wheel = wheelsCache.find((w) => w.id === wheelId);
    if (!wheel) return;
    const items = (wheel.items || []).filter((it) => it.id !== itemId);
    await updateDoc(doc(db, "wheels", wheelId), { items });
}

async function deleteSpinRecord(wheelId, spinId) {
    const wheel = wheelsCache.find((w) => w.id === wheelId);
    if (!wheel) return;
    const spins = (wheel.spins || []).filter((s) => s.id !== spinId);
    await updateDoc(doc(db, "wheels", wheelId), { spins });
}

function spinWheel(wheelId, btnEl) {
    const wheel = wheelsCache.find((w) => w.id === wheelId);
    if (!wheel || !wheel.items || wheel.items.length === 0) { alert("請先新增輪盤項目"); return; }

    const requiresCredit = wheel.spinRuleAmountEnabled || wheel.spinRuleMembershipEnabled || wheel.spinRuleDailyEnabled;
    if (requiresCredit) {
        const pending = Math.max(0, (wheel.spinCreditsTotal || 0) - (wheel.spinCreditsUsed || 0));
        if (pending <= 0) {
            alert("呢個輪盤未有足夠嘅抽獎機會，達成設定嘅條件先可以轉。");
            return;
        }
    }

    const items = wheel.items;
    const chosenIndex = Math.floor(Math.random() * items.length);
    const chosen = items[chosenIndex];
    const sliceDeg = 360 / items.length;
    const sliceCenterDeg = chosenIndex * sliceDeg + sliceDeg / 2;
    const targetMod = ((-90 - sliceCenterDeg) % 360 + 360) % 360;

    const canvasEl = document.getElementById(`wheelCanvas_${wheelId}`);
    const state = wheelRotationState[wheelId] || 0;
    const currentMod = ((state % 360) + 360) % 360;
    let deltaToTarget = targetMod - currentMod;
    if (deltaToTarget < 0) deltaToTarget += 360;
    const finalRotation = state + 360 * 5 + deltaToTarget;
    wheelRotationState[wheelId] = finalRotation;

    if (canvasEl) canvasEl.style.transform = `rotate(${finalRotation}deg)`;
    if (btnEl) btnEl.disabled = true;

    setTimeout(async () => {
        if (btnEl) btnEl.disabled = false;
        await applyWheelResult(wheel, chosen);
    }, 4100);
}

async function applyWheelResult(wheel, chosenItem) {
    let timeApplied = true;
    if (chosenItem.effectHours != null) {
        timeApplied = await adjustTime(chosenItem.effectHours * 3600000, true);
    }
    const spins = [...(wheel.spins || []), {
        id: genId(),
        resultLabel: chosenItem.label,
        effectHours: chosenItem.effectHours,
        timestamp: Date.now()
    }];
    const requiresCredit = wheel.spinRuleAmountEnabled || wheel.spinRuleMembershipEnabled || wheel.spinRuleDailyEnabled;
    const updatePayload = { spins };
    if (requiresCredit) {
        updatePayload.spinCreditsUsed = (wheel.spinCreditsUsed || 0) + 1;
    }
    await updateDoc(doc(db, "wheels", wheel.id), updatePayload);
    let effectText = "";
    if (chosenItem.effectHours != null) {
        effectText = timeApplied
            ? `（${chosenItem.effectHours >= 0 ? "+" : ""}${chosenItem.effectHours} 小時）`
            : "（時間已鎖定，未能加/減鐘）";
    }
    alert(`輪盤結果：${chosenItem.label}${effectText}`);
}

// ==========================================
// Record / Report
// ==========================================
async function loadSessions() {
    const container = document.getElementById("sessionListContainer");
    if (!container) return;
    container.innerHTML = '<div class="empty-hint">載入緊歷史記錄中...</div>';

    try {
        const qs = await getDocs(query(sessionsColRef, orderBy("sessionStartTime", "desc")));
        if (qs.empty) {
            container.innerHTML = '<div class="empty-hint">暫時未有任何直播記錄（Cut Off 之後會自動存入）</div>';
            return;
        }
        container.innerHTML = "";
        qs.forEach((d) => container.appendChild(buildSessionCard(d.data())));
    } catch (e) {
        console.error("載入 Record 失敗", e);
        container.innerHTML = `<div class="empty-hint error">載入記錄出錯：${escapeHtml(e.message)}</div>`;
    }
}

function buildSessionCard(data) {
    const card = document.createElement("div");
    card.className = "session-card";

    const scRows = (data.scEvents || []).map((sc) => `
        <tr>
            <td>${escapeHtml(sc.name)}</td>
            <td>${escapeHtml(sc.time)}</td>
            <td>$HKD ${(parseFloat(sc.amount) || 0).toLocaleString()}</td>
            <td>${escapeHtml(sc.message || "")}</td>
        </tr>
    `).join("");

    const paymeRows = (data.paymeEvents || []).map((p) => `
        <tr>
            <td>${escapeHtml(p.name)}</td>
            <td>${escapeHtml(p.time)}</td>
            <td>$HKD ${(parseFloat(p.amount) || 0).toLocaleString()}</td>
        </tr>
    `).join("");

    card.innerHTML = `
        <div class="session-card-top">
            <img class="session-thumb" src="${escapeHtml(data.thumbnailUrl || "")}" alt="封面">
            <div class="session-info">
                <div class="session-title">${escapeHtml(data.videoTitle || "YouTube 直播節目")}</div>
                <a class="session-link" href="${escapeHtml(data.videoUrl || "#")}" target="_blank" rel="noopener">觀看連結</a>
                <div class="session-meta">直播時長：${escapeHtml(data.elapsedStr || "00:00:00")}</div>
                <div class="session-meta">單場 SuperChat：$HKD ${(data.scTotal || 0).toLocaleString()}　單場 PayMe：$HKD ${(data.paymeTotal || 0).toLocaleString()}</div>
            </div>
        </div>
        <div class="session-table-block">
            <div class="session-table-title">Super Chat 詳細</div>
            <table class="session-table">
                <thead><tr><th>用戶名</th><th>時間</th><th>金額</th><th>留言</th></tr></thead>
                <tbody>${scRows || '<tr><td colspan="4" class="empty-hint">此場無 SC 紀錄</td></tr>'}</tbody>
            </table>
        </div>
        <div class="session-table-block">
            <div class="session-table-title">PayMe 詳細</div>
            <table class="session-table">
                <thead><tr><th>用戶名</th><th>時間</th><th>金額</th></tr></thead>
                <tbody>${paymeRows || '<tr><td colspan="3" class="empty-hint">此場無 PayMe 紀錄</td></tr>'}</tbody>
            </table>
        </div>
    `;
    return card;
}

// ==========================================
// 在線名單（Presence）
// ==========================================
async function updatePresence(tab) {
    myCurrentTab = tab;
    try {
        await setDoc(doc(db, "presence", getMyClientId()), {
            name: getMyDisplayName(),
            currentTab: tab,
            lastSeen: Date.now()
        });
    } catch (e) {
        console.error("更新在線狀態失敗:", e);
    }
}

function setupPresenceSync() {
    onSnapshot(presenceColRef, (qs) => {
        const now = Date.now();
        const active = [];
        qs.forEach((d) => {
            const p = d.data();
            if (p.lastSeen && (now - p.lastSeen) < PRESENCE_STALE_MS) active.push(p);
        });
        renderPresenceBar(active);
    }, (error) => console.error("在線名單同步失敗:", error));
}

function renderPresenceBar(active) {
    const bar = document.getElementById("presenceBar");
    if (!bar) return;
    if (active.length === 0) {
        bar.innerHTML = "";
        return;
    }
    active.sort((a, b) => a.name.localeCompare(b.name));
    bar.innerHTML = `<span class="presence-label">而家在線：</span>` + active.map((p) => `
        <span class="presence-chip"><span class="presence-dot"></span>${escapeHtml(p.name)} · ${escapeHtml(TAB_LABELS[p.currentTab] || p.currentTab)}</span>
    `).join("");
}

// ==========================================
// Tab 切換 + 初始化
// ==========================================
const ACTIVE_TAB_STORAGE_KEY = "activeTab";

function switchTab(tabName) {
    const views = { dashboard: "dashboardView", record: "recordView", rule: "ruleView", wheel: "wheelView" };
    if (!views[tabName]) tabName = "dashboard";

    Object.entries(views).forEach(([key, id]) => {
        const el = document.getElementById(id);
        if (el) el.style.display = (key === tabName) ? (key === "dashboard" ? "grid" : "block") : "none";
    });

    document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === tabName);
    });

    localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tabName);
    if (tabName === "record") loadSessions();
    updatePresence(tabName);
}

window.addEventListener("DOMContentLoaded", () => {
    setupCampaignSync();
    setupRulesSync();
    setupWheelsSync();
    refreshLiveStats();
    if (!statTickInterval) statTickInterval = setInterval(tickStatTimestamps, 1000);
    checkDailySpinCredits();
    setInterval(checkDailySpinCredits, 30000);
    setupPresenceSync();
    if (!presenceHeartbeatInterval) presenceHeartbeatInterval = setInterval(() => updatePresence(myCurrentTab), PRESENCE_HEARTBEAT_MS);

    document.getElementById("startBtn").addEventListener("click", startSession);
    document.getElementById("pauseBtn").addEventListener("click", togglePause);
    document.getElementById("cutoffBtn").addEventListener("click", cutOffSession);
    document.getElementById("finishBtn").addEventListener("click", finishMarathon);
    document.getElementById("resetBtn").addEventListener("click", resetCampaign);
    document.getElementById("addPaymeBtn").addEventListener("click", addPayme);
    document.getElementById("addRuleBtn").addEventListener("click", addRule);
    document.getElementById("addWheelBtn").addEventListener("click", addWheel);

    document.querySelectorAll(".time-adjust-btn").forEach((btn) => {
        btn.addEventListener("click", () => adjustTime(parseInt(btn.dataset.deltaMs, 10)));
    });
    document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    switchTab(localStorage.getItem(ACTIVE_TAB_STORAGE_KEY) || "dashboard");
});
