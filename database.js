const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = process.env.VERCEL
    ? path.join('/tmp', 'reserve.db')
    : path.resolve(__dirname, 'reserve.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        
        // Create users table
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            full_name TEXT NOT NULL,
            phone_number TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Create inquiries table
        db.run(`CREATE TABLE IF NOT EXISTS inquiries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            first_name TEXT NOT NULL,
            last_name TEXT NOT NULL,
            mobile_number TEXT NOT NULL,
            email TEXT NOT NULL,
            facility_type TEXT NOT NULL,
            amount TEXT,
            status TEXT DEFAULT 'Pending Review',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        // Create checkpoints table for Client-Specific Playground
        db.run(`CREATE TABLE IF NOT EXISTS checkpoints (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inquiry_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            is_completed BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (inquiry_id) REFERENCES inquiries(id) ON DELETE CASCADE
        )`);
    }
});

module.exports = db;
