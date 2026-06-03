// api/notify.js  —  Vercel serverless function (free tier, no Blaze needed)
//
// Sends an FCM push when called by the message sender's browser.
// Delivery is identical to a Cloud Function; only the trigger moved here.
//
// SETUP (see README): set one env var FIREBASE_SERVICE_ACCOUNT to the full
// JSON contents of a Firebase service-account key. It stays on the server.

const admin = require("firebase-admin");

// Initialize once per warm instance.
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

function truncate(str, n = 120) {
  const s = String(str || "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Send data-only messages (your service worker builds the notification from data),
// then prune any permanently-dead tokens from the given user doc.
async function sendToTokens(tokens, data, userRef) {
  const valid = [...new Set((tokens || []).filter(Boolean))];
  if (valid.length === 0) return 0;

  const stringData = {};
  for (const [k, v] of Object.entries(data)) stringData[k] = v == null ? "" : String(v);

  let sent = 0;
  const dead = [];
  for (let i = 0; i < valid.length; i += 500) {
    const batch = valid.slice(i, i + 500);
    const res = await admin.messaging().sendEachForMulticast({
      tokens: batch,
      data: stringData,
      webpush: { headers: { Urgency: "high" } },
    });
    sent += res.successCount;
    res.responses.forEach((r, idx) => {
      if (!r.success) {
        const code = (r.error && r.error.code) || "";
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token" ||
          code === "messaging/invalid-argument"
        ) {
          dead.push(batch[idx]);
        }
      }
    });
  }
  if (dead.length && userRef) {
    await userRef
      .update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead) })
      .catch(() => {});
  }
  return sent;
}

module.exports = async (req, res) => {
  // CORS (tighten the origin to your app's domain if you prefer)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

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

      const sent = await sendToTokens(
        recipient.data().fcmTokens || [],
        {
          type: "private",
          title: callerUsername,
          body: truncate(body),
          chatId,
          sender: callerUsername,
          icon: "/icon-192.png",
        },
        recipient.ref
      );
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
          sent += await sendToTokens(u.data().fcmTokens || [], data, u.ref);
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
