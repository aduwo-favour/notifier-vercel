// api/notify.js  —  Vercel serverless function (free tier, no Blaze needed)
//
// Sends an FCM push when called by the message sender's browser.
// Delivery is identical to a Cloud Function; only the trigger moved here.
//
// SETUP (see README): set one env var FIREBASE_SERVICE_ACCOUNT to the full
// JSON contents of a Firebase service-account key. It stays on the server.

const admin = require("firebase-admin");

// Initialize once per warm instance. Capture any failure (bad/missing
// FIREBASE_SERVICE_ACCOUNT) so the GET health check can report it clearly
// instead of the whole module throwing on load.
let initError = null;
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    });
  } catch (e) {
    initError = e.message || String(e);
    console.error("Admin init failed:", initError);
  }
}
const db = admin.apps.length ? admin.firestore() : null;

function truncate(str, n = 120) {
  const s = String(str || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

const DEAD_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

// Core sender. `field` names the Firestore array the tokens came from, so dead
// ones get pruned from the right place.
async function dispatch({ tokens, message, field, userRef }) {
  const valid = [...new Set((tokens || []).filter(Boolean))];
  if (valid.length === 0) return 0;

  let sent = 0;
  const dead = [];
  for (let i = 0; i < valid.length; i += 500) {
    const batch = valid.slice(i, i + 500);
    const res = await admin.messaging().sendEachForMulticast({ tokens: batch, ...message });
    sent += res.successCount;
    res.responses.forEach((r, idx) => {
      if (!r.success && DEAD_CODES.has((r.error && r.error.code) || "")) {
        dead.push(batch[idx]);
      }
    });
  }
  if (dead.length && userRef) {
    await userRef
      .update({ [field]: admin.firestore.FieldValue.arrayRemove(...dead) })
      .catch(() => {});
  }
  return sent;
}

// Web and native need genuinely different payloads, so they are sent as two
// separate messages rather than one multicast:
//
//   • WEB  → data-only. firebase-messaging-sw.js draws the notification. A
//            `notification` block here would make the browser auto-display a
//            SECOND one, which is the duplicate-notification bug.
//   • NATIVE → must include a `notification` block. A data-only message to a
//            killed Android app is delivered at low priority and draws nothing
//            at all, so the user would simply never be told.
// Notifications on native Android are drawn by the OS from the `notification`
// block below, BEFORE any of the app's JavaScript runs. That means no
// client-side check can suppress one. Anything that should stop a notification
// has to be decided here, on the server.
//
//   • muted   — chat id present in the recipient's `mutedChats`
//   • reading — recipient currently has this very chat open
function shouldSkip(user, data) {
  const key = data.communityId || data.chatId;
  if (!key) return null;

  const muted = Array.isArray(user.mutedChats) ? user.mutedChats : [];
  if (muted.includes(key)) return "muted";

  // `activeChat` is written by the client while a conversation is on screen and
  // refreshed periodically. The freshness window means a force-closed app stops
  // suppressing notifications within a minute rather than forever.
  const active = user.activeChat;
  if (active && active.id === key && active.at) {
    const age = Date.now() - Number(active.at);
    if (age >= 0 && age < 60000) return "reading";
  }

  return null;
}

async function sendToUser({ user, data, userRef }) {
  const skip = shouldSkip(user, data);
  if (skip) return 0;

  const stringData = {};
  for (const [k, v] of Object.entries(data)) stringData[k] = v == null ? "" : String(v);

  // Groups a conversation's notifications into one stack instead of spamming
  // the shade with one row per message.
  const tag = data.chatId || data.communityId || data.type || "chat";

  const [web, native] = await Promise.all([
    dispatch({
      tokens: user.fcmTokens || [],
      field: "fcmTokens",
      userRef,
      message: {
        data: stringData,
        webpush: { headers: { Urgency: "high" } },
      },
    }),
    dispatch({
      tokens: user.fcmTokensNative || [],
      field: "fcmTokensNative",
      userRef,
      message: {
        data: stringData,
        // Lock screens are public. Show WHO messaged, never WHAT they said —
        // the full text is one tap away inside the app. `data` still carries
        // everything, so in-app handling is unaffected.
        notification: {
          title: data.title,
          body:
            data.type === "community"
              ? "New message in " + (data.communityName || "a community")
              : data.type === "private"
                ? "sent you a message"
                : data.body, // friend requests / signups are not message content
        },
        android: {
          priority: "high",
          notification: {
            channelId: "chat_messages",
            tag,
            sound: "default",
            defaultVibrateTimings: true,
            icon: "ic_stat_notify",
            color: "#6c5ce7",
          },
        },
      },
    }),
  ]);

  return web + native;
}

module.exports = async (req, res) => {
  // CORS (tighten the origin to your app's domain if you prefer)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  // Health check: open the endpoint URL in a browser to confirm the function
  // booted, firebase-admin loaded, and the service-account env var parsed.
  // Never returns any secret value.
  if (req.method === "GET") {
    return res.status(200).json({
      ok: !initError,
      adminInitialized: admin.apps.length > 0,
      serviceAccountPresent: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT),
      initError: initError || null,
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // If admin never initialized, every send would fail — say so plainly.
  if (!db) {
    return res.status(500).json({ error: "Server not initialized", detail: initError });
  }

  try {
    const { idToken, type, chatId, communityId, body } = req.body || {};
    if (!idToken) return res.status(400).json({ error: "Missing idToken" });

    // 1) Verify the caller is a real signed-in user.
    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerUid = decoded.uid;

    const callerSnap = await db.collection("users").doc(callerUid).get();
    if (!callerSnap.exists) return res.status(403).json({ error: "Unknown user" });
    const callerUsername = callerSnap.data().username;

    // ---------------- PRIVATE CHAT ----------------
    if (type === "private") {
      if (!chatId) return res.status(400).json({ error: "Missing chatId" });

      const chatSnap = await db.collection("chats").doc(chatId).get();
      if (!chatSnap.exists) return res.status(404).json({ error: "Chat not found" });
      const chat = chatSnap.data();
      if (chat.isBlocked) return res.status(200).json({ sent: 0, reason: "blocked" });

      const participants = chat.participants || [];
      if (!participants.includes(callerUsername)) {
        return res.status(403).json({ error: "Not a participant" });
      }
      const recipientUsername = participants.find((p) => p !== callerUsername);
      if (!recipientUsername) return res.status(200).json({ sent: 0 });

      const rSnap = await db
        .collection("users")
        .where("username", "==", recipientUsername)
        .limit(1)
        .get();
      if (rSnap.empty) return res.status(404).json({ error: "Recipient not found" });
      const recipient = rSnap.docs[0];
      if ((recipient.data().blockedUsers || []).includes(callerUsername)) {
        return res.status(200).json({ sent: 0, reason: "sender blocked" });
      }

      const sent = await sendToUser({
        user: recipient.data(),
        data: {
          type: "private",
          title: callerUsername,
          body: truncate(body),
          chatId,
          sender: callerUsername,
          icon: "/icon-192.png",
        },
        userRef: recipient.ref,
      });
      return res.status(200).json({ sent });
    }

    // ---------------- COMMUNITY CHAT ----------------
    if (type === "community") {
      if (!communityId) return res.status(400).json({ error: "Missing communityId" });

      const commSnap = await db.collection("communities").doc(communityId).get();
      if (!commSnap.exists) return res.status(404).json({ error: "Community not found" });
      const communityName = commSnap.data().name || "Community";

      // Caller must be a member (prevents non-members triggering spam).
      const callerMember = await db
        .collection("communities").doc(communityId)
        .collection("members").doc(callerUid).get();
      if (!callerMember.exists) return res.status(403).json({ error: "Not a member" });

      const membersSnap = await db
        .collection("communities").doc(communityId).collection("members").get();

      const recipientUids = [];
      membersSnap.forEach((m) => {
        if (m.id === callerUid) return;
        if (m.data().banned) return;
        recipientUids.push(m.id);
      });
      if (recipientUids.length === 0) return res.status(200).json({ sent: 0 });

      const userDocs = await db.getAll(
        ...recipientUids.map((uid) => db.collection("users").doc(uid))
      );

      const data = {
        type: "community",
        title: communityName,
        body: `${callerUsername}: ${truncate(body, 100)}`,
        communityId,
        communityName,
        sender: callerUsername,
        icon: "/icon-192.png",
      };

      let sent = 0;
      await Promise.all(
        userDocs.map(async (u) => {
          if (!u.exists) return;
          sent += await sendToUser({ user: u.data(), data, userRef: u.ref });
        })
      );
      return res.status(200).json({ sent });
    }

    // ---------------- FRIEND REQUESTS / ACCEPTS ----------------
    // These were already being sent by the client (private-chats.js, requests.js,
    // profile.js) but the server had no branch for them, so every one was
    // silently answered with "Unknown type" and no notification was ever sent.
    if (type === "friend_request" || type === "friend_accept") {
      const target = (req.body.to || "").trim();
      if (!target) return res.status(400).json({ error: "Missing recipient" });
      if (target === callerUsername) return res.status(200).json({ sent: 0 });

      const tSnap = await db
        .collection("users")
        .where("username", "==", target)
        .limit(1)
        .get();
      if (tSnap.empty) return res.status(200).json({ sent: 0 });

      const targetDoc = tSnap.docs[0];

      // Respect blocks in both directions.
      if ((targetDoc.data().blockedUsers || []).includes(callerUsername)) {
        return res.status(200).json({ sent: 0, reason: "blocked" });
      }

      const isRequest = type === "friend_request";
      const sent = await sendToUser({
        user: targetDoc.data(),
        data: {
          type,
          title: callerUsername,
          body: isRequest ? "sent you a friend request" : "accepted your friend request",
          sender: callerUsername,
          icon: "/icon-192.png",
        },
        userRef: targetDoc.ref,
      });
      return res.status(200).json({ sent });
    }

    // ---------------- NEW SIGNUP (admins only) ----------------
    if (type === "signup") {
      const admins = await db
        .collection("users")
        .where("isAdmin", "==", true)
        .get();

      let sent = 0;
      await Promise.all(
        admins.docs.map(async (a) => {
          if (a.id === callerUid) return;
          sent += await sendToUser({
            user: a.data(),
            data: {
              type: "signup",
              title: "New signup",
              body: `${callerUsername} just registered`,
              sender: callerUsername,
              icon: "/icon-192.png",
            },
            userRef: a.ref,
          });
        })
      );
      return res.status(200).json({ sent });
    }

    return res.status(400).json({ error: "Unknown type" });
  } catch (err) {
    console.error("notify error:", err);
    return res.status(500).json({ error: "Send failed" });
  }
};
