import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CLIENTS ──────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── MIDDLEWARE ───────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', app: 'Humphrey' }));

// ─── ANTHROPIC PROXY ──────────────────────────────────────────────
app.post('/api/claude', requireAuth, async (req, res) => {
  const { system, messages, max_tokens = 3000, tools } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages format' });
  }
  try {
    const params = { model: 'claude-sonnet-4-6', max_tokens, system, messages };
    if (tools) params.tools = tools;
    const response = await anthropic.messages.create(params);
    res.json(response);
  } catch (err) {
    console.error('Anthropic error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── WINE LOG ─────────────────────────────────────────────────────
app.get('/api/wines', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('wine_log')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/wines', requireAuth, async (req, res) => {
  const wine = { ...req.body, user_id: req.user.id };
  delete wine.id;
  const { data, error } = await supabase.from('wine_log').insert(wine).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/wines/bulk', requireAuth, async (req, res) => {
  const wines = req.body.map(w => ({ ...w, user_id: req.user.id }));
  wines.forEach(w => delete w.id);
  const { data, error } = await supabase.from('wine_log').insert(wines).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/wines/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('wine_log')
    .update(req.body)
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/wines/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('wine_log')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── TASTE PROFILE ────────────────────────────────────────────────
app.get('/api/profile', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('taste_profiles')
    .select('*')
    .eq('user_id', req.user.id)
    .single();
  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
  res.json(data || null);
});

app.put('/api/profile', requireAuth, async (req, res) => {
  const profile = { ...req.body, user_id: req.user.id, updated_at: new Date().toISOString() };
  const { data, error } = await supabase
    .from('taste_profiles')
    .upsert(profile, { onConflict: 'user_id' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── INVITE CODES ─────────────────────────────────────────────────
app.post('/api/validate-invite', async (req, res) => {
  const { code } = req.body;
  const { data, error } = await supabase
    .from('invite_codes')
    .select('*')
    .eq('code', code.toUpperCase())
    .eq('used', false)
    .single();
  if (error || !data) return res.json({ valid: false });
  res.json({ valid: true });
});

app.post('/api/use-invite', async (req, res) => {
  const { code, user_id } = req.body;
  const { error } = await supabase
    .from('invite_codes')
    .update({ used: true, used_by: user_id, used_at: new Date().toISOString() })
    .eq('code', code.toUpperCase());
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── START ────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Humphrey backend running on port ${PORT}`));
