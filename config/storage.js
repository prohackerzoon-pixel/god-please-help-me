const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
  { auth: { persistSession: false } }
);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|webp/;
    if (allowed.test(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only images and PDFs allowed'));
  },
});

const uploadToSupabase = async (file, folder = 'uploads') => {
  try {
    if (!file) return null;
    const ext = path.extname(file.originalname) || '.jpg';
    const filename = `${folder}/${Date.now()}-${Math.random().toString(36).substring(2)}${ext}`;
    const { data, error } = await supabase.storage
      .from('bluepeak-files')
      .upload(filename, file.buffer, { contentType: file.mimetype, upsert: false });
    if (error) { console.error('Storage upload error:', error.message); return null; }
    const { data: urlData } = supabase.storage.from('bluepeak-files').getPublicUrl(filename);
    return urlData.publicUrl;
  } catch (e) { console.error('Upload error:', e.message); return null; }
};

module.exports = { supabase, upload, uploadToSupabase };
