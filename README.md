# BluePeak Finance Backend

## ✅ Stack
- Node.js + Express
- Supabase PostgreSQL (database + file storage)
- Nodemailer (Gmail SMTP)
- Telegram Bot API
- JWT Authentication

## 🚀 Quick Start

### Step 1 — Install dependencies
```bash
npm install
```

### Step 2 — Setup Supabase Storage
1. Go to your Supabase dashboard
2. Click **Storage** in the left menu
3. Click **New bucket**
4. Name it: `bluepeak-files`
5. Set it to **Public**
6. Click **Create bucket**

### Step 3 — Get Supabase Keys
1. Go to Supabase dashboard → **Settings** → **API**
2. Copy **anon public key** → paste in .env as SUPABASE_ANON_KEY
3. Copy **service_role key** → paste in .env as SUPABASE_SERVICE_KEY

### Step 4 — Run database SQL
1. Go to Supabase dashboard → **SQL Editor**
2. Copy everything from `database-setup.sql`
3. Paste and click **Run**

### Step 5 — Start server
```bash
npm start
```

## 🔑 Default Admin Login
- Username: `bluepeakadmin`
- Password: `BluePeak@Admin2026!`

## 📡 API Base URL
- Local: `http://localhost:5000`
- Production: your Render URL

## 🔧 Environment Variables (.env)
All credentials are pre-filled in the .env file.
Only add your Supabase anon/service keys.
