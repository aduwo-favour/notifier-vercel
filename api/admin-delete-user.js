// api/admin-delete-user.js — Vercel serverless function
//
// Hard-deletes a user: their Firebase AUTH account AND their Firestore user doc.
// The browser cannot delete other users' Auth accounts, so this runs server-side
// with the Admin SDK. Locked to admins only (verified against Firestore).
//
// Uses the same FIREBASE_SERVICE_ACCOUNT env var as the notify endpoint.

const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = admin.firestore();

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { idToken, targetUid } = req.body || {};
    if (!idToken || !targetUid) {
      return res.status(400).json({ error: "Missing idToken or targetUid" });
    }

    // 1) Verify the caller and confirm they are an admin.
    const decoded = await admin.auth().verifyIdToken(idToken);
    const callerSnap = await db.collection("users").doc(decoded.uid).get();
    if (!callerSnap.exists || callerSnap.data().isAdmin !== true) {
      return res.status(403).json({ error: "Admin only" });
    }

    // 2) Don't let an admin delete their own account this way.
    if (targetUid === decoded.uid) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }

    // 3) Delete the Firebase Auth account (ignore if already gone).
    try {
      await admin.auth().deleteUser(targetUid);
    } catch (e) {
      if (e.code !== "auth/user-not-found") throw e;
    }

    // 4) Hard-delete the Firestore user doc (Admin SDK bypasses rules).
    await db.collection("users").doc(targetUid).delete().catch(() => {});

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("admin-delete-user error:", err);
    return res.status(500).json({ error: "Delete failed" });
  }
};
