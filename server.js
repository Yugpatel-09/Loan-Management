const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static HTML/CSS/JS files locally. Vercel serves public/ via its CDN.
app.use(express.static(path.join(__dirname, 'public')));

// API: Signup
app.post('/api/signup', async (req, res) => {
    const { full_name, phone_number, email, password } = req.body;
    try {
        const hash = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (full_name, phone_number, email, password_hash) VALUES (?, ?, ?, ?)`,
            [full_name, phone_number, email, hash],
            function (err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ error: 'Email already exists' });
                    }
                    return res.status(500).json({ error: 'Database error' });
                }
                res.status(201).json({ message: 'User created successfully', id: this.lastID });
            }
        );
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// API: Login
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (!user) return res.status(401).json({ error: 'Invalid email or password' });
        
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) return res.status(401).json({ error: 'Invalid email or password' });
        
        res.json({ message: 'Login successful', user: { email: user.email, name: user.full_name } });
    });
});

// API: Submit Inquiry
app.post('/api/inquiries', (req, res) => {
    const { first_name, last_name, mobile_number, email, facility_type, amount } = req.body;
    db.run(`INSERT INTO inquiries (first_name, last_name, mobile_number, email, facility_type, amount) VALUES (?, ?, ?, ?, ?, ?)`,
        [first_name, last_name, mobile_number, email, facility_type, amount],
        function (err) {
            if (err) {
                return res.status(500).json({ error: 'Database error' });
            }
            
            const inquiryId = this.lastID;
            
            // Auto-generate default document checkpoints based on facility type
            let defaultDocs = [];
            
            if (facility_type.includes("Health Insurance")) {
                defaultDocs = ["KYC Documents (Aadhaar/PAN)", "Medical History Reports", "Age Proof"];
            } else if (facility_type.includes("Mortgage Insurance")) {
                defaultDocs = ["KYC Documents (Aadhaar/PAN)", "Loan Sanction Letter", "Property Documents"];
            } else {
                // Default loan documents
                defaultDocs = ["ID Proof (Aadhaar/PAN)", "Bank Statements (Last 6 Months)", "ITR Returns (Last 2 Years)"];
                if (facility_type.includes("Housing")) {
                    defaultDocs.push("Property Documents (Sale Deed/Agreement)", "Title Clearance Report");
                } else if (facility_type.includes("Project")) {
                    defaultDocs.push("Detailed Project Report (DPR)", "Financial Projections (3 Years)");
                } else if (facility_type.includes("Machinery")) {
                    defaultDocs.push("Machinery Quotations", "Proforma Invoices");
                }
            }

            // Insert defaults
            const stmt = db.prepare(`INSERT INTO checkpoints (inquiry_id, title) VALUES (?, ?)`);
            defaultDocs.forEach(doc => {
                stmt.run(inquiryId, doc);
            });
            stmt.finalize();

            res.status(201).json({ message: 'Inquiry submitted', id: inquiryId });
        }
    );
});

// API: Get User Specific Inquiries
app.get('/api/user/inquiries', (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });

    db.all(`SELECT * FROM inquiries WHERE email = ? ORDER BY created_at DESC`, [email], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// API: Admin Dashboard Stats
app.get('/api/admin/dashboard', (req, res) => {
    const stats = {};
    
    // Get total inquiries today
    db.get(`SELECT COUNT(*) as count FROM inquiries WHERE date(created_at) = date('now')`, (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        stats.inquiriesToday = row.count;

        // Get total inquiries yesterday
        db.get(`SELECT COUNT(*) as count FROM inquiries WHERE date(created_at) = date('now', '-1 day')`, (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            stats.inquiriesYesterday = row.count;

            // Get total active approvals (just a count for now)
            db.get(`SELECT COUNT(*) as count FROM inquiries`, (err, row) => {
                if (err) return res.status(500).json({ error: err.message });
                stats.totalInquiries = row.count;

                // Get all inquiries for table
                db.all(`SELECT * FROM inquiries ORDER BY created_at DESC`, (err, rows) => {
                    if (err) return res.status(500).json({ error: err.message });
                    stats.recentInquiries = rows;
                    
                    res.json(stats);
                });
            });
        });
    });
});

// API: Update Inquiry Status
app.post('/api/admin/inquiries/:id/status', (req, res) => {
    const { status } = req.body;
    db.run(`UPDATE inquiries SET status = ? WHERE id = ?`, [status, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Status updated successfully' });
    });
});

// API: Delete Inquiry
app.delete('/api/admin/inquiries/:id', (req, res) => {
    const id = req.params.id;
    db.run(`DELETE FROM checkpoints WHERE inquiry_id = ?`, [id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        db.run(`DELETE FROM inquiries WHERE id = ?`, [id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Inquiry deleted successfully' });
        });
    });
});
// --- PLAYGROUND CHECKPOINTS API ---

// Get all checkpoints for a specific inquiry
app.get('/api/admin/inquiries/:id/checkpoints', (req, res) => {
    db.all(`SELECT * FROM checkpoints WHERE inquiry_id = ? ORDER BY created_at ASC`, [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Add a new checkpoint for a specific inquiry
app.post('/api/admin/inquiries/:id/checkpoints', (req, res) => {
    const { title } = req.body;
    db.run(`INSERT INTO checkpoints (inquiry_id, title) VALUES (?, ?)`, [req.params.id, title || 'New Document'], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.status(201).json({ id: this.lastID, inquiry_id: req.params.id, title: title || 'New Document', is_completed: 0 });
    });
});

// Update a checkpoint (title or status)
app.put('/api/admin/checkpoints/:id', (req, res) => {
    const { title, is_completed } = req.body;
    db.run(
        `UPDATE checkpoints SET title = COALESCE(?, title), is_completed = COALESCE(?, is_completed) WHERE id = ?`,
        [title, is_completed, req.params.id],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Checkpoint updated' });
        }
    );
});

// Delete a checkpoint
app.delete('/api/admin/checkpoints/:id', (req, res) => {
    db.run(`DELETE FROM checkpoints WHERE id = ?`, [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Checkpoint deleted' });
    });
});

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is running on http://localhost:${PORT}`);
    });
}

module.exports = app;
