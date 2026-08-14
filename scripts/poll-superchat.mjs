import crypto from "node:crypto";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountJson) {
    console.error("缺少 FIREBASE_SERVICE_ACCOUNT 環境變數（GitHub Secret）");
    process.exit(1);
}
initializeApp({ credential: cert(JSON.parse(serviceAccountJson)) });
const db = getFirestore();

// 以下幾個 function 係複製自 app.js 嘅同名邏輯，保持行為一致。
// 如果之後 app.js 嘅加鐘規則/貨幣轉換邏輯有改動，記得同步更新呢度。
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

async function main() {
    const campaignRef = db.collection("campaign").doc("main");
    const campaignSnap = await campaignRef.get();
    if (!campaignSnap.exists) { console.log("campaign/main 唔存在，跳過。"); return; }
    const data = campaignSnap.data();

    if (data.status !== "running" && data.status !== "paused") {
        console.log("馬拉松未開始或者已完成，跳過。");
        return;
    }
    const session = data.currentSession;
    if (!session || !session.active || !session.liveChatId || !data.ytApiKey) {
        console.log("而家冇進行緊嘅直播 Session，或者未有 liveChatId／API Key，跳過。");
        return;
    }

    // 呢個 nextPageToken 游標同瀏覽器分頁入面嗰個係完全獨立嘅兩條軌——
    // 就算兩邊同時攞緊料都唔會撞：入去 Firestore 之前都會用 event id 去重。
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
        await campaignRef.update({ scPollState: newPollState });
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
        await campaignRef.update({ scPollState: newPollState });
        console.log("冇新嘅 SuperChat／送會員／會員里程碑／新會員記錄。");
        return;
    }

    const rulesSnap = await db.collection("rules").get();
    const rules = rulesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
    if (deltaMs !== 0 && !computeIsTimeUp(data)) {
        updatePayload.targetEndTime = (data.targetEndTime || Date.now()) + deltaMs;
    }
    await campaignRef.update(updatePayload);
    console.log(`已經寫入 ${amountCreditQueueAdds.length} 個 SuperChat、${membershipCreditQueueAdds.length} 個送會員、${milestoneCreditQueueAdds.length} 個會員里程碑、${newSponsorCreditQueueAdds.length} 個新／升級會員記錄。`);

    const wheelsSnap = await db.collection("wheels").get();
    for (const wheelDoc of wheelsSnap.docs) {
        const wheel = wheelDoc.data();
        const newEntries = [];
        if (wheel.spinRuleAmountEnabled && wheel.spinRuleAmount > 0) {
            for (const { name, amount } of amountCreditQueueAdds) {
                const n = Math.floor(amount / wheel.spinRuleAmount);
                for (let i = 0; i < n; i++) {
                    newEntries.push({ id: crypto.randomUUID(), name, source: "課金", time: formatMs(Date.now() - sessionStart) });
                }
            }
        }
        if (wheel.spinRuleMembershipEnabled && wheel.spinRuleMembershipCount > 0) {
            for (const { name, count } of membershipCreditQueueAdds) {
                const n = Math.floor(count / wheel.spinRuleMembershipCount);
                for (let i = 0; i < n; i++) {
                    newEntries.push({ id: crypto.randomUUID(), name, source: "送會員", time: formatMs(Date.now() - sessionStart) });
                }
            }
        }
        if (wheel.spinRuleMilestoneEnabled) {
            for (const { name, memberMonth, memberLevelName } of milestoneCreditQueueAdds) {
                if ((memberMonth || 0) < (wheel.spinRuleMilestoneMonths || 0)) continue;
                if (!levelMatchesFilter(memberLevelName, wheel.spinRuleMilestoneLevel)) continue;
                newEntries.push({ id: crypto.randomUUID(), name, source: "會員里程碑", time: formatMs(Date.now() - sessionStart) });
            }
        }
        if (wheel.spinRuleNewSponsorEnabled) {
            for (const { name, memberLevelName } of newSponsorCreditQueueAdds) {
                if (!levelMatchesFilter(memberLevelName, wheel.spinRuleNewSponsorLevel)) continue;
                newEntries.push({ id: crypto.randomUUID(), name, source: "新／升級會員", time: formatMs(Date.now() - sessionStart) });
            }
        }
        if (newEntries.length === 0) continue;

        const wheelRef = db.collection("wheels").doc(wheelDoc.id);
        await db.runTransaction(async (tx) => {
            const freshSnap = await tx.get(wheelRef);
            if (!freshSnap.exists) return;
            const freshQueue = freshSnap.data().spinQueue || [];
            tx.update(wheelRef, { spinQueue: [...freshQueue, ...newEntries] });
        });
    }
}

main().catch((e) => {
    console.error("Poll script 出錯：", e);
    process.exit(1);
});
