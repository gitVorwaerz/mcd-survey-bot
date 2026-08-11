// api/test.js — Verifikation: Kompletter Solver-Durchlauf in der Vercel-Funktion (wird nach Test entfernt)
import { solveSurvey } from '../lib/solver.js';

export default async function handler(req, res) {
  const code = req.query.code || '0vm2-293m-hov';
  const t0 = Date.now();
  try {
    const result = await solveSurvey(code);
    res.status(200).json({
      ok: result.ok,
      code: result.code,
      message: result.message,
      ms: Date.now() - t0,
      log: result.logs.slice(-12),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message.slice(0, 400), ms: Date.now() - t0 });
  }
}
