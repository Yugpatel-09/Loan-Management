import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-analytics.js";
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

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);
const db = getFirestore(app);

const DEFAULT_STATUS = "Pending Review";

function waitForAuth() {
    return new Promise((resolve) => {
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

function setLocalUser(user, profile = {}) {
    localStorage.setItem("userEmail", user.email || profile.email || "");
    localStorage.setItem("userName", profile.full_name || user.displayName || user.email || "Client");
}

export async function signUpUser({ full_name, phone_number, email, password }) {
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(credential.user, { displayName: full_name });

    const profile = {
        full_name,
        phone_number,
        email,
        password,
        role: "client",
        created_at: serverTimestamp()
    };

    await setDoc(doc(db, "users", credential.user.uid), profile);
    setLocalUser(credential.user, profile);

    return { user: credential.user, profile };
}

export async function loginUser(email, password) {
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const profile = await getUserProfile(credential.user.uid);

    setLocalUser(credential.user, profile);

    return { user: credential.user, profile };
}

export async function loginAdmin(email, password) {
    const session = await loginUser(email, password);

    if (session.profile.role !== "admin") {
        await logoutUser();
        throw new Error("This account is not marked as an admin.");
    }

    localStorage.setItem("adminSession", "true");
    return session;
}

export async function logoutUser() {
    localStorage.removeItem("userEmail");
    localStorage.removeItem("userName");
    localStorage.removeItem("adminSession");
    await signOut(auth);
}

export async function getUserProfile(uid) {
    const snapshot = await getDoc(doc(db, "users", uid));
    return snapshot.exists() ? snapshot.data() : {};
}

export async function requireUser(redirectTo = "login.html") {
    const user = await waitForAuth();

    if (!user) {
        window.location.href = redirectTo;
        return null;
    }

    const profile = await getUserProfile(user.uid);
    setLocalUser(user, profile);

    return { user, profile };
}

export async function requireAdmin(redirectTo = "admin-login.html") {
    const session = await requireUser(redirectTo);
    if (!session) return null;

    if (session.profile.role !== "admin") {
        alert("Admin access required.");
        await logoutUser();
        window.location.href = redirectTo;
        return null;
    }

    localStorage.setItem("adminSession", "true");
    return session;
}

export async function createInquiry(formData) {
    const session = await requireUser();
    if (!session) throw new Error("Please sign in before submitting an inquiry.");

    const inquiry = {
        first_name: formData.first_name.trim(),
        last_name: formData.last_name.trim(),
        mobile_number: formData.mobile_number.trim(),
        email: session.user.email,
        facility_type: formData.facility_type,
        amount: formData.amount || "",
        status: DEFAULT_STATUS,
        user_id: session.user.uid,
        created_at: serverTimestamp()
    };

    const inquiryRef = await addDoc(collection(db, "inquiries"), inquiry);
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
    return inquiryRef.id;
}

export async function getUserInquiries(email) {
    const inquiriesQuery = query(collection(db, "inquiries"), where("email", "==", email));
    const snapshot = await getDocs(inquiriesQuery);

    return snapshot.docs.map(normalizeInquiry).sort(sortNewestFirst);
}

export async function getAllInquiries() {
    const snapshot = await getDocs(collection(db, "inquiries"));
    return snapshot.docs.map(normalizeInquiry).sort(sortNewestFirst);
}

export async function getDashboardData() {
    const recentInquiries = await getAllInquiries();
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
    await updateDoc(doc(db, "inquiries", id), { status });
}

export async function getCheckpoints(inquiryId) {
    const snapshot = await getDocs(collection(db, "inquiries", inquiryId, "checkpoints"));
    return snapshot.docs.map(normalizeCheckpoint).sort(sortCheckpoints);
}

export async function addCheckpoint(inquiryId, title = "New Document") {
    const checkpointRef = await addDoc(collection(db, "inquiries", inquiryId, "checkpoints"), {
        title: title || "New Document",
        is_completed: false,
        sort_order: Date.now(),
        created_at: serverTimestamp()
    });

    const snapshot = await getDoc(checkpointRef);
    return normalizeCheckpoint(snapshot);
}

export async function updateCheckpoint(inquiryId, checkpointId, updates) {
    const payload = { ...updates };

    if ("is_completed" in payload) {
        payload.is_completed = payload.is_completed === true || payload.is_completed === 1;
    }

    await updateDoc(doc(db, "inquiries", inquiryId, "checkpoints", checkpointId), payload);
}

export async function deleteCheckpoint(inquiryId, checkpointId) {
    await deleteDoc(doc(db, "inquiries", inquiryId, "checkpoints", checkpointId));
}

export async function deleteInquiryAndCheckpoints(inquiryId) {
    const checkpointsSnapshot = await getDocs(collection(db, "inquiries", inquiryId, "checkpoints"));
    const batch = writeBatch(db);

    checkpointsSnapshot.docs.forEach((checkpoint) => batch.delete(checkpoint.ref));
    batch.delete(doc(db, "inquiries", inquiryId));

    await batch.commit();
}