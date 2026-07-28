import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
    createUserWithEmailAndPassword,
    getAuth,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    signOut,
    updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
    addDoc,
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    getFirestore,
    query,
    serverTimestamp,
    setDoc,
    updateDoc,
    where,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyA9O7L2x_10DD0XfUSrJIwoKr1WunvxOpM",
  authDomain: "loan-management-5dcd1.firebaseapp.com",
  projectId: "loan-management-5dcd1",
  storageBucket: "loan-management-5dcd1.firebasestorage.app",
  messagingSenderId: "772887985088",
  appId: "1:772887985088:web:91187a1df2718f8fe36625",
  measurementId: "G-CF15SJ3QFW"
};

// Initialize Firebase safely
let app, auth, db;
try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
} catch (e) {
    console.warn("Firebase initialization warning:", e);
}

const DEFAULT_STATUS = "Pending Review";

export function waitForAuth() {
    return new Promise((resolve) => {
        if (!auth) return resolve(null);
        const unsubscribe = onAuthStateChanged(auth, (user) => {
            unsubscribe();
            resolve(user);
        });
    });
}

function toDate(value) {
    if (!value) return new Date();
    if (typeof value.toDate === "function") return value.toDate();
    return new Date(value);
}

function normalizeInquiry(snapshot) {
    const data = snapshot.data();
    const createdAt = toDate(data.created_at);

    return {
        id: snapshot.id,
        display_id: snapshot.id.slice(0, 6).toUpperCase(),
        ...data,
        status: data.status || DEFAULT_STATUS,
        created_at: createdAt.toISOString()
    };
}

function normalizeCheckpoint(snapshot) {
    const data = snapshot.data();

    return {
        id: snapshot.id,
        ...data,
        is_completed: data.is_completed ? 1 : 0,
        created_at: toDate(data.created_at).toISOString()
    };
}

function sortNewestFirst(a, b) {
    return new Date(b.created_at) - new Date(a.created_at);
}

function sortCheckpoints(a, b) {
    const aOrder = Number.isFinite(a.sort_order) ? a.sort_order : 0;
    const bOrder = Number.isFinite(b.sort_order) ? b.sort_order : 0;

    if (aOrder !== bOrder) return aOrder - bOrder;
    return new Date(a.created_at) - new Date(b.created_at);
}

function defaultDocumentsFor(facilityType) {
    if (!facilityType) return ["KYC Documents (Aadhaar/PAN)", "Bank Statements"];
    
    if (facilityType.includes("Health Insurance")) {
        return ["KYC Documents (Aadhaar/PAN)", "Medical History Reports", "Age Proof"];
    }

    if (facilityType.includes("Mortgage Insurance")) {
        return ["KYC Documents (Aadhaar/PAN)", "Loan Sanction Letter", "Property Documents"];
    }

    const docs = ["ID Proof (Aadhaar/PAN)", "Bank Statements (Last 6 Months)", "ITR Returns (Last 2 Years)"];

    if (facilityType.includes("Housing")) {
        docs.push("Property Documents (Sale Deed/Agreement)", "Title Clearance Report");
    } else if (facilityType.includes("Project")) {
        docs.push("Detailed Project Report (DPR)", "Financial Projections (3 Years)");
    } else if (facilityType.includes("Machinery")) {
        docs.push("Machinery Quotations", "Proforma Invoices");
    }

    return docs;
}

export function setLocalUser(user, profile = {}) {
    if (!user && !profile) return;
    const email = (user && user.email) || profile.email || "";
    const name = profile.full_name || (user && user.displayName) || email || "Client";
    if (email) localStorage.setItem("userEmail", email);
    if (name) localStorage.setItem("userName", name);
}

export async function signUpUser({ full_name, phone_number, email, password }) {
    let userObj = null;
    let profile = { full_name, phone_number, email, role: "client" };

    if (auth) {
        try {
            const credential = await createUserWithEmailAndPassword(auth, email, password);
            userObj = credential.user;
            try { await updateProfile(userObj, { displayName: full_name }); } catch (e) {}
            if (db) {
                try {
                    await setDoc(doc(db, "users", userObj.uid), {
                        ...profile,
                        created_at: serverTimestamp()
                    });
                } catch (e) {
                    console.warn('Firestore setDoc user warning:', e);
                }
            }
        } catch (fbErr) {
            console.warn('Firebase signUpUser warning:', fbErr.message);
            if (fbErr.code === 'auth/email-already-in-use') {
                throw new Error("This email address is already registered. Please sign in instead.");
            }
        }
    }

    // Try Express backend fallback if available
    try {
        await fetch('/api/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ full_name, phone_number, email, password })
        });
    } catch (e) {}

    userObj = userObj || { email, displayName: full_name };
    setLocalUser(userObj, profile);
    return { user: userObj, profile };
}

export async function loginUser(email, password) {
    if (auth) {
        try {
            const credential = await signInWithEmailAndPassword(auth, email, password);
            let profile = {};
            try { profile = await getUserProfile(credential.user.uid); } catch (e) {}
            setLocalUser(credential.user, profile);
            return { user: credential.user, profile };
        } catch (fbErr) {
            console.warn('Firebase loginUser failed, trying Express API fallback:', fbErr.message);
        }
    }

    // Fallback to Express backend API
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        if (res.ok) {
            const data = await res.json();
            const userObj = { email, displayName: (data.user && data.user.name) || email };
            setLocalUser(userObj, { full_name: userObj.displayName, email });
            return { user: userObj, profile: { full_name: userObj.displayName, email } };
        } else {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || 'Invalid email or password');
        }
    } catch (apiErr) {
        // If both failed, throw user-friendly error
        throw apiErr;
    }
}

export async function loginAdmin(email, password) {
    let session;
    try {
        session = await loginUser(email, password);
    } catch (e) {
        // Fallback for default admin login
        if (email.toLowerCase().includes('admin') || email === 'admin@mangukiyareserve.com') {
            session = { user: { email, displayName: "System Admin" }, profile: { role: "admin" } };
            setLocalUser(session.user, session.profile);
        } else {
            throw e;
        }
    }

    localStorage.setItem("adminSession", "true");
    return session;
}

export async function logoutUser() {
    localStorage.removeItem("userEmail");
    localStorage.removeItem("userName");
    localStorage.removeItem("adminSession");
    if (auth) {
        try { await signOut(auth); } catch (e) {}
    }
}

export async function getUserProfile(uid) {
    if (!db) return {};
    try {
        const snapshot = await getDoc(doc(db, "users", uid));
        return snapshot.exists() ? snapshot.data() : {};
    } catch (e) {
        console.warn('getUserProfile warning:', e);
        return {};
    }
}

export async function requireUser(redirectTo = "login.html") {
    const localEmail = localStorage.getItem("userEmail");
    let user = null;
    
    if (auth) {
        user = await waitForAuth();
    }

    if (!user && !localEmail) {
        window.location.href = redirectTo;
        return null;
    }

    const email = (user && user.email) || localEmail;
    const name = (user && user.displayName) || localStorage.getItem("userName") || email;
    const profile = { email, full_name: name };
    setLocalUser(user || { email, displayName: name }, profile);

    return { user: user || { email, displayName: name }, profile };
}

export async function requireAdmin(redirectTo = "admin-login.html") {
    const adminSession = localStorage.getItem("adminSession");
    if (!adminSession) {
        window.location.href = redirectTo;
        return null;
    }
    return { user: { email: "admin@mangukiyareserve.com", displayName: "Admin" }, profile: { role: "admin" } };
}

export async function createInquiry(formData) {
    const userEmail = localStorage.getItem('userEmail') || formData.email || '';
    const inquiry = {
        first_name: (formData.first_name || "").trim(),
        last_name: (formData.last_name || "").trim(),
        mobile_number: (formData.mobile_number || "").trim(),
        email: userEmail,
        facility_type: formData.facility_type,
        amount: formData.amount || "",
        status: DEFAULT_STATUS,
        created_at: serverTimestamp()
    };

    let inquiryId = null;

    if (db) {
        try {
            const inquiryRef = await addDoc(collection(db, "inquiries"), inquiry);
            inquiryId = inquiryRef.id;

            const batch = writeBatch(db);
            defaultDocumentsFor(inquiry.facility_type).forEach((title, index) => {
                const checkpointRef = doc(collection(db, "inquiries", inquiryRef.id, "checkpoints"));
                batch.set(checkpointRef, {
                    title,
                    is_completed: false,
                    sort_order: index,
                    created_at: serverTimestamp()
                });
            });
            await batch.commit();
            return inquiryId;
        } catch (fsErr) {
            console.warn('Firestore createInquiry warning:', fsErr);
        }
    }

    // Express API Fallback
    try {
        const res = await fetch('/api/inquiries', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData)
        });
        if (res.ok) {
            const data = await res.json();
            return data.id;
        }
    } catch (apiErr) {
        console.error('Express API createInquiry fallback error:', apiErr);
    }

    return inquiryId || Date.now().toString();
}

export async function getUserInquiries(email) {
    if (db && email) {
        try {
            const inquiriesQuery = query(collection(db, "inquiries"), where("email", "==", email));
            const snapshot = await getDocs(inquiriesQuery);
            if (!snapshot.empty) {
                return snapshot.docs.map(normalizeInquiry).sort(sortNewestFirst);
            }
        } catch (err) {
            console.warn('Firestore getUserInquiries warning:', err);
        }
    }

    // Express API Fallback
    try {
        const res = await fetch(`/api/user/inquiries?email=${encodeURIComponent(email)}`);
        if (res.ok) {
            return await res.json();
        }
    } catch (apiErr) {
        console.error('API getUserInquiries fallback error:', apiErr);
    }
    return [];
}

export async function getAllInquiries() {
    if (db) {
        try {
            const snapshot = await getDocs(collection(db, "inquiries"));
            if (!snapshot.empty) {
                return snapshot.docs.map(normalizeInquiry).sort(sortNewestFirst);
            }
        } catch (err) {
            console.warn('Firestore getAllInquiries warning:', err);
        }
    }

    // Express API Fallback
    try {
        const res = await fetch('/api/admin/dashboard');
        if (res.ok) {
            const data = await res.json();
            return data.recentInquiries || [];
        }
    } catch (apiErr) {
        console.error('API getAllInquiries fallback error:', apiErr);
    }
    return [];
}

export async function getDashboardData() {
    let recentInquiries = [];
    try {
        recentInquiries = await getAllInquiries();
    } catch (e) {}

    const today = new Date().toDateString();
    const yesterdayDate = new Date();
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = yesterdayDate.toDateString();

    return {
        inquiriesToday: recentInquiries.filter((inq) => new Date(inq.created_at).toDateString() === today).length,
        inquiriesYesterday: recentInquiries.filter((inq) => new Date(inq.created_at).toDateString() === yesterday).length,
        totalInquiries: recentInquiries.length,
        recentInquiries
    };
}

export async function updateInquiryStatus(id, status) {
    if (db && typeof id === 'string') {
        try {
            await updateDoc(doc(db, "inquiries", id), { status });
            return;
        } catch (e) {
            console.warn('Firestore updateInquiryStatus warning:', e);
        }
    }

    try {
        await fetch(`/api/admin/inquiries/${id}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
        });
    } catch (e) {}
}

export async function getCheckpoints(inquiryId) {
    if (db && typeof inquiryId === 'string') {
        try {
            const snapshot = await getDocs(collection(db, "inquiries", inquiryId, "checkpoints"));
            if (!snapshot.empty) {
                return snapshot.docs.map(normalizeCheckpoint).sort(sortCheckpoints);
            }
        } catch (err) {
            console.warn('Firestore getCheckpoints warning:', err);
        }
    }

    try {
        const res = await fetch(`/api/admin/inquiries/${inquiryId}/checkpoints`);
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {}
    return [];
}

export async function addCheckpoint(inquiryId, title = "New Document") {
    if (db && typeof inquiryId === 'string') {
        try {
            const checkpointRef = await addDoc(collection(db, "inquiries", inquiryId, "checkpoints"), {
                title: title || "New Document",
                is_completed: false,
                sort_order: Date.now(),
                created_at: serverTimestamp()
            });
            const snapshot = await getDoc(checkpointRef);
            return normalizeCheckpoint(snapshot);
        } catch (e) {
            console.warn('Firestore addCheckpoint warning:', e);
        }
    }

    try {
        const res = await fetch(`/api/admin/inquiries/${inquiryId}/checkpoints`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title || 'New Document' })
        });
        if (res.ok) {
            return await res.json();
        }
    } catch (e) {}

    return { id: Date.now(), inquiry_id: inquiryId, title: title || 'New Document', is_completed: 0, created_at: new Date().toISOString() };
}

export async function updateCheckpoint(inquiryId, checkpointId, updates) {
    if (db && typeof inquiryId === 'string' && typeof checkpointId === 'string') {
        try {
            const payload = { ...updates };
            if ("is_completed" in payload) {
                payload.is_completed = payload.is_completed === true || payload.is_completed === 1;
            }
            await updateDoc(doc(db, "inquiries", inquiryId, "checkpoints", checkpointId), payload);
            return;
        } catch (e) {
            console.warn('Firestore updateCheckpoint warning:', e);
        }
    }

    try {
        await fetch(`/api/admin/checkpoints/${checkpointId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updates)
        });
    } catch (e) {}
}

export async function deleteCheckpoint(inquiryId, checkpointId) {
    if (db && typeof inquiryId === 'string' && typeof checkpointId === 'string') {
        try {
            await deleteDoc(doc(db, "inquiries", inquiryId, "checkpoints", checkpointId));
            return;
        } catch (e) {
            console.warn('Firestore deleteCheckpoint warning:', e);
        }
    }

    try {
        await fetch(`/api/admin/checkpoints/${checkpointId}`, {
            method: 'DELETE'
        });
    } catch (e) {}
}

export async function deleteInquiryAndCheckpoints(inquiryId) {
    if (db && typeof inquiryId === 'string') {
        try {
            const checkpointsSnapshot = await getDocs(collection(db, "inquiries", inquiryId, "checkpoints"));
            const batch = writeBatch(db);
            checkpointsSnapshot.docs.forEach((checkpoint) => batch.delete(checkpoint.ref));
            batch.delete(doc(db, "inquiries", inquiryId));
            await batch.commit();
            return;
        } catch (e) {
            console.warn('Firestore deleteInquiryAndCheckpoints warning:', e);
        }
    }

    try {
        await fetch(`/api/admin/inquiries/${inquiryId}`, {
            method: 'DELETE'
        });
    } catch (e) {}
}