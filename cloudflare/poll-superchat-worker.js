// Cloudflare Worker：用 Cron Trigger 密密（建議每 1 分鐘）poll SuperChat/送會員/會員里程碑/新會員，
// 寫返入 Firestore。邏輯複製自 scripts/poll-superchat.mjs（GitHub Actions 版），
// 因為 Cloudflare Workers 嘅 runtime 唔支援 firebase-admin，所以改用 Firestore REST API +
// 自己簽發 Google service account 嘅 OAuth2 token（用 Workers 內建嘅 Web Crypto）。
//
// 如果之後 app.js 或者 scripts/poll-superchat.mjs 嘅加鐘規則/貨幣轉換邏輯有改動，記得同步更新呢度。
//
// 部署方法：Cloudflare Dashboard -> Workers & Pages -> Create -> 建立一個 Worker ->
// 用 Quick Edit 貼晒呢個檔案嘅內容 -> Deploy -> Settings -> Variables ->
// 加一個 Secret，名叫 FIREBASE_SERVICE_ACCOUNT，值係成個 Firebase service account JSON ->
// Settings -> Triggers -> Cron Triggers -> Add Cron Trigger（例如 * * * * * 即係每分鐘一次）。

const FIREBASE_PROJECT_ID = "overtime-dashboard";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

// ==========================================
// Google service account OAuth2（用 Web Crypto 簽 JWT）
// ==========================================
function base64UrlFromBytes(bytes) {
    let binary = "";
    for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlFromString(str) {
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem) {
    const pemContents = pem
        .replace(/-----BEGIN PRIVATE KEY-----/, "")
        .replace(/-----END PRIVATE KEY-----/, "")
        .replace(/\s/g, "");
    const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey(
        "pkcs8",
        binaryDer.buffer,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
    );
}

async function getAccessToken(serviceAccount) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claim = {
        iss: serviceAccount.client_email,
        scope: "https://www.googleapis.com/auth/datastore",
        aud: "https://oauth2.googleapis.com/token",
        exp: now + 3600,
        iat: now
    };
    const signingInput = `${base64UrlFromString(JSON.stringify(header))}.${base64UrlFromString(JSON.stringify(claim))}`;
    const key = await importPrivateKey(serviceAccount.private_key);
    const signature = await crypto.subtle.sign(
        { name: "RSASSA-PKCS1-v1_5" },
        key,
        new TextEncoder().encode(signingInput)
    );
    const jwt = `${signingInput}.${base64UrlFromBytes(signature)}`;

    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });
    const data = await res.json();
    if (!data.access_token) throw new Error("OAuth token 攞唔到：" + JSON.stringify(data));
    return data.access_token;
}

// ==========================================
// Firestore REST API：encode/decode + 讀寫
// ==========================================
function toFirestoreValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === "string") return { stringValue: v };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
    if (typeof v === "object") return { mapValue: { fields: toFirestoreFields(v) } };
    throw new Error("Unsupported Firestore value type: " + typeof v);
}

function toFirestoreFields(obj) {
    const fields = {};
    for (const [k, val] of Object.entries(obj)) {
        if (val === undefined) continue;
        fields[k] = toFirestoreValue(val);
    }
    return fields;
}

function fromFirestoreValue(v) {
    if (!v) return null;
    if (v.nullValue !== undefined) return null;
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.booleanValue !== undefined) return v.booleanValue;
    if (v.integerValue !== undefined) return parseInt(v.integerValue, 10);
    if (v.doubleValue !== undefined) return v.doubleValue;
    if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(fromFirestoreValue);
    if (v.mapValue !== undefined) return fromFirestoreFields(v.mapValue.fields || {});
    if (v.timestampValue !== undefined) return new Date(v.timestampValue).getTime();
    return null;
}

function fromFirestoreFields(fields) {
    const obj = {};
    for (const [k, v] of Object.entries(fields || {})) obj[k] = fromFirestoreValue(v);
    return obj;
}

async function fsGetDoc(token, path) {
    const res = await fetch(`${FIRESTORE_BASE}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore get ${path} 失敗：${res.status} ${await res.text()}`);
    const json = await res.json();
    return fromFirestoreFields(json.fields);
}

async function fsListDocs(token, collectionPath) {
    const res = await fetch(`${FIRESTORE_BASE}/${collectionPath}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Firestore list ${collectionPath} 失敗：${res.status} ${await res.text()}`);
    const json = await res.json();
    return (json.documents || []).map((d) => ({ id: d.name.split("/").pop(), ...fromFirestoreFields(d.fields) }));
}

async function fsPatchDoc(token, path, data) {
    const fieldPaths = Object.keys(data).map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join("&");
    const res = await fetch(`${FIRESTORE_BASE}/${path}?${fieldPaths}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: toFirestoreFields(data) })
    });
    if (!res.ok) throw new Error(`Firestore patch ${path} 失敗：${res.status} ${await res.text()}`);
}

// ==========================================
// 以下幾個 function 係複製自 app.js 嘅同名邏輯，保持行為一致。
// ==========================================
function formatMs(ms) {
    if (ms < 0) ms = 0;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

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

function applyBonusTimeDelta(data, deltaMs, updatePayload) {
    if (deltaMs === 0) return;
    if (data.status !== "running" && data.status !== "paused") return;
    if (computeIsTimeUp(data)) return;
    if (data.isPaused) {
        updatePayload.pausedRemainingMs = Math.max(0, (data.pausedRemainingMs || 0) + deltaMs);
    } else {
        updatePayload.targetEndTime = (data.targetEndTime || Date.now()) + deltaMs;
    }
}

let fxRatesCache = null;
async function ensureFxRates() {
    if (fxRatesCache) return fxRatesCache;
    try {
        const res = await fetch("https://open.er-api.com/v6/latest/HKD");
        if (!res.ok) throw new Error(`FX API 回應錯誤 ${res.status}`);
        const data = await res.json();
        if (data && data.rates) fxRatesCache = data.rates;
    } catch (e) {
        console.error("攞唔到即時匯率，SuperChat 金額會當係港紙處理：", e.message);
    }
    return fxRatesCache;
}

async function convertToHKD(amount, currencyCode) {
    const code = (currencyCode || "HKD").toUpperCase();
    if (code === "HKD") return amount;
    const rates = await ensureFxRates();
    const rate = rates && rates[code];
    if (!rate) return amount;
    return amount / rate;
}

function levelMatchesFilter(levelName, filterStr) {
    if (!filterStr || !filterStr.trim()) return true;
    const allowed = filterStr.split(",").map((s) => s.trim()).filter(Boolean);
    return allowed.includes((levelName || "").trim());
}

function genId() {
    return crypto.randomUUID();
}

// ==========================================
// 主流程
// ==========================================
async function pollSuperChat(env) {
    if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error("缺少 FIREBASE_SERVICE_ACCOUNT 環境變數（Worker Secret）");
    const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
    const token = await getAccessToken(serviceAccount);

    const data = await fsGetDoc(token, "campaign/main");
    if (!data) { console.log("campaign/main 唔存在，跳過。"); return; }

    if (data.status !== "running" && data.status !== "paused") {
        console.log("馬拉松未開始或者已完成，跳過。");
        return;
    }
    const session = data.currentSession;
    if (!session || !session.active || !session.liveChatId || !data.ytApiKey) {
        console.log("而家冇進行緊嘅直播 Session，或者未有 liveChatId／API Key，跳過。");
        return;
    }

    let pollState = data.scPollState;
    if (!pollState || pollState.liveChatId !== session.liveChatId) {
        pollState = { liveChatId: session.liveChatId, nextPageToken: null };
    }

    let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${session.liveChatId}&part=snippet,authorDetails&key=${data.ytApiKey}`;
    if (pollState.nextPageToken) url += `&pageToken=${pollState.nextPageToken}`;

    const res = await fetch(url);
    if (!res.ok) {
        console.error("YouTube API 回應錯誤", res.status, await res.text());
        return;
    }
    const ytData = await res.json();
    const newNextPageToken = ytData.nextPageToken || pollState.nextPageToken || null;
    const items = ytData.items || [];
    const newPollState = { liveChatId: session.liveChatId, nextPageToken: newNextPageToken };

    if (items.length === 0) {
        await fsPatchDoc(token, "campaign/main", { scPollState: newPollState });
        console.log("冇新訊息。");
        return;
    }

    const scEvents = [...(data.currentSessionScEvents || [])];
    const membershipEvents = [...(data.currentSessionMembershipEvents || [])];
    const milestoneEvents = [...(data.currentSessionMilestoneEvents || [])];
    const newSponsorEvents = [...(data.currentSessionNewSponsorEvents || [])];
    const leaderboardSc = [...(data.leaderboardSc || [])];
    let totalAmount = data.totalAmount || 0;
    const sessionStart = session.sessionStartTime || Date.now();

    const amountCreditQueueAdds = [];
    const membershipCreditQueueAdds = [];
    const milestoneCreditQueueAdds = [];
    const newSponsorCreditQueueAdds = [];
    let anyNew = false;

    for (const item of items) {
        if (item.snippet.type === "superChatEvent") {
            const scDetails = item.snippet.superChatDetails;
            if (!scDetails) continue;
            const id = item.id;
            if (scEvents.some((e) => e.id === id)) continue;

            const rawAmount = scDetails.amountMicros ? scDetails.amountMicros / 1000000 : 0;
            const currencyCode = (scDetails.currency || "HKD").toUpperCase();
            const amount = await convertToHKD(rawAmount, currencyCode);
            const name = item.authorDetails.displayName;
            const eventTimeMs = new Date(item.snippet.publishedAt).getTime();
            const time = formatMs(eventTimeMs - sessionStart);

            const event = { id, name, amount, time, message: scDetails.userComment || "" };
            if (currencyCode !== "HKD") { event.originalAmount = rawAmount; event.originalCurrency = currencyCode; }
            scEvents.push(event);

            const existing = leaderboardSc.find((e) => e.name === name);
            if (existing) existing.amount += amount; else leaderboardSc.push({ name, amount });

            totalAmount += amount;
            amountCreditQueueAdds.push({ name, amount });
            anyNew = true;
        } else if (item.snippet.type === "membershipGiftingEvent") {
            const giftDetails = item.snippet.membershipGiftingDetails;
            if (!giftDetails) continue;
            const id = item.id;
            if (membershipEvents.some((e) => e.id === id)) continue;

            const name = item.authorDetails.displayName;
            const count = giftDetails.giftMembershipsCount || 0;
            const eventTimeMs = new Date(item.snippet.publishedAt).getTime();
            const time = formatMs(eventTimeMs - sessionStart);
            membershipEvents.push({ id, name, count, time });
            membershipCreditQueueAdds.push({ name, count });
            anyNew = true;
        } else if (item.snippet.type === "memberMilestoneChatEvent") {
            const milestoneDetails = item.snippet.memberMilestoneChatDetails;
            if (!milestoneDetails) continue;
            const id = item.id;
            if (milestoneEvents.some((e) => e.id === id)) continue;

            const name = item.authorDetails.displayName;
            const memberMonth = milestoneDetails.memberMonth || 0;
            const memberLevelName = milestoneDetails.memberLevelName || "";
            const eventTimeMs = new Date(item.snippet.publishedAt).getTime();
            const time = formatMs(eventTimeMs - sessionStart);
            milestoneEvents.push({ id, name, memberMonth, memberLevelName, message: milestoneDetails.userComment || "", time });
            milestoneCreditQueueAdds.push({ name, memberMonth, memberLevelName });
            anyNew = true;
        } else if (item.snippet.type === "newSponsorEvent") {
            const newSponsorDetails = item.snippet.newSponsorDetails;
            if (!newSponsorDetails) continue;
            const id = item.id;
            if (newSponsorEvents.some((e) => e.id === id)) continue;

            const name = item.authorDetails.displayName;
            const memberLevelName = newSponsorDetails.memberLevelName || "";
            const isUpgrade = !!newSponsorDetails.isUpgrade;
            const eventTimeMs = new Date(item.snippet.publishedAt).getTime();
            const time = formatMs(eventTimeMs - sessionStart);
            newSponsorEvents.push({ id, name, memberLevelName, isUpgrade, time });
            newSponsorCreditQueueAdds.push({ name, memberLevelName });
            anyNew = true;
        }
    }

    if (!anyNew) {
        await fsPatchDoc(token, "campaign/main", { scPollState: newPollState });
        console.log("冇新嘅 SuperChat／送會員／會員里程碑／新會員記錄。");
        return;
    }

    const rules = await fsListDocs(token, "rules");
    const newBonusMs = computeBonusMs(totalAmount, rules);
    const oldBonusMs = data.bonusMsGranted || 0;
    const deltaMs = newBonusMs - oldBonusMs;

    const updatePayload = {
        totalAmount,
        bonusMsGranted: newBonusMs,
        currentSessionScEvents: scEvents,
        currentSessionMembershipEvents: membershipEvents,
        currentSessionMilestoneEvents: milestoneEvents,
        currentSessionNewSponsorEvents: newSponsorEvents,
        leaderboardSc,
        scPollState: newPollState
    };
    applyBonusTimeDelta(data, deltaMs, updatePayload);
    await fsPatchDoc(token, "campaign/main", updatePayload);
    console.log(`已經寫入 ${amountCreditQueueAdds.length} 個 SuperChat、${membershipCreditQueueAdds.length} 個送會員、${milestoneCreditQueueAdds.length} 個會員里程碑、${newSponsorCreditQueueAdds.length} 個新／升級會員記錄。`);

    const wheels = await fsListDocs(token, "wheels");
    for (const wheel of wheels) {
        const newEntries = [];
        if (wheel.spinRuleAmountEnabled && wheel.spinRuleAmount > 0) {
            for (const { name, amount } of amountCreditQueueAdds) {
                const n = Math.floor(amount / wheel.spinRuleAmount);
                for (let i = 0; i < n; i++) newEntries.push({ id: genId(), name, source: "課金", time: formatMs(Date.now() - sessionStart) });
            }
        }
        if (wheel.spinRuleMembershipEnabled && wheel.spinRuleMembershipCount > 0) {
            for (const { name, count } of membershipCreditQueueAdds) {
                const n = Math.floor(count / wheel.spinRuleMembershipCount);
                for (let i = 0; i < n; i++) newEntries.push({ id: genId(), name, source: "送會員", time: formatMs(Date.now() - sessionStart) });
            }
        }
        if (wheel.spinRuleMilestoneEnabled) {
            for (const { name, memberMonth, memberLevelName } of milestoneCreditQueueAdds) {
                if ((memberMonth || 0) < (wheel.spinRuleMilestoneMonths || 0)) continue;
                if (!levelMatchesFilter(memberLevelName, wheel.spinRuleMilestoneLevel)) continue;
                newEntries.push({ id: genId(), name, source: "會員里程碑", time: formatMs(Date.now() - sessionStart) });
            }
        }
        if (wheel.spinRuleNewSponsorEnabled) {
            for (const { name, memberLevelName } of newSponsorCreditQueueAdds) {
                if (!levelMatchesFilter(memberLevelName, wheel.spinRuleNewSponsorLevel)) continue;
                newEntries.push({ id: genId(), name, source: "新／升級會員", time: formatMs(Date.now() - sessionStart) });
            }
        }
        if (newEntries.length === 0) continue;

        // 冇用 Firestore transaction（REST API 做 transaction 比較繁複），
        // 但每分鐘先執行一次、寫入前都會重新讀一次最新資料，撞車機會好細。
        const freshWheel = await fsGetDoc(token, `wheels/${wheel.id}`);
        const freshQueue = (freshWheel && freshWheel.spinQueue) || [];
        await fsPatchDoc(token, `wheels/${wheel.id}`, { spinQueue: [...freshQueue, ...newEntries] });
    }
}

export default {
    async scheduled(event, env, ctx) {
        ctx.waitUntil(pollSuperChat(env).catch((e) => console.error("Poll 出錯：", e)));
    },
    async fetch(request, env, ctx) {
        try {
            await pollSuperChat(env);
            return new Response("OK - 已經執行完一次 poll，睇 Cloudflare Dashboard 嘅 Logs 睇詳細結果。");
        } catch (e) {
            return new Response("出錯：" + e.message, { status: 500 });
        }
    }
};
