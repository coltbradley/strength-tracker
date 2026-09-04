// Programmatic checks: tool calls the turn made, and the database AFTER it.
// Each returns { pass, detail }. The vocabulary is documented in cases.mjs.

import { OWNER } from "./fixture.mjs";

async function newestProgram(db) {
  const r = await db.query(
    `select id, name, confirmed_at from programs where user_id = $1 and discarded_at is null order by created_at desc limit 1`,
    [OWNER],
  );
  return r.rows[0] ?? null;
}

export async function runChecks(db, c, turn) {
  const out = {};
  const ch = c.checks ?? {};
  const called = turn.toolCalls.map((t) => t.name);
  const has = (n) => called.includes(n);

  if (ch.tools_required) {
    const missing = ch.tools_required.filter((n) => !has(n));
    out.tools_required = { pass: missing.length === 0, detail: missing.length ? `missing ${missing.join(",")}` : called.join(",") };
  }
  if (ch.tools_forbidden) {
    const hit = ch.tools_forbidden.filter((n) => has(n));
    out.tools_forbidden = { pass: hit.length === 0, detail: hit.length ? `called ${hit.join(",")}` : "ok" };
  }
  if (ch.no_tools) out.no_tools = { pass: called.length === 0, detail: called.join(",") || "none" };
  if (ch.max_words) {
    const w = turn.answer.trim().split(/\s+/).filter(Boolean).length;
    out.max_words = { pass: w <= ch.max_words, detail: `${w} words` };
  }
  if (ch.answer_any) {
    const ok = ch.answer_any.some((re) => new RegExp(re, "i").test(turn.answer));
    out.answer_any = { pass: ok, detail: ok ? "matched" : `none of ${ch.answer_any.join(" | ")}` };
  }
  if (ch.answer_none) {
    const hit = ch.answer_none.filter((re) => new RegExp(re, "i").test(turn.answer));
    out.answer_none = { pass: hit.length === 0, detail: hit.length ? `matched ${hit.join(" | ")}` : "ok" };
  }
  if (ch.memory_matches) {
    const r = await db.query(`select fact from coach_memory where user_id = $1`, [OWNER]);
    const facts = r.rows.map((x) => x.fact);
    const missing = ch.memory_matches.filter((re) => !facts.some((f) => new RegExp(re, "i").test(f)));
    out.memory_matches = { pass: missing.length === 0, detail: `facts: ${JSON.stringify(facts)}${missing.length ? `; unmatched ${missing.join(",")}` : ""}` };
  }
  if (ch.programs_live_max !== undefined) {
    const r = await db.query(`select count(*)::int as n from programs where user_id = $1 and discarded_at is null`, [OWNER]);
    out.programs_live_max = { pass: r.rows[0].n <= ch.programs_live_max, detail: `${r.rows[0].n} live` };
  }
  const needsNewest = ch.program_has_days || ch.day_superset_groups || ch.newest_confirmed !== undefined || ch.rx_load || ch.rx_absent || ch.rx_present;
  if (needsNewest) {
    const p = await newestProgram(db);
    if (!p) {
      for (const k of ["program_has_days", "day_superset_groups", "newest_confirmed", "rx_load", "rx_absent", "rx_present"])
        if (ch[k] !== undefined) out[k] = { pass: false, detail: "no live program" };
    } else {
      if (ch.program_has_days) {
        const r = await db.query(`select label from planned_workouts where program_id = $1 and discarded_at is null and coalesce(is_template,false) = false`, [p.id]);
        const labels = r.rows.map((x) => (x.label ?? "").toUpperCase());
        const missing = ch.program_has_days.filter((l) => !labels.includes(l));
        out.program_has_days = { pass: missing.length === 0, detail: `days ${labels.join(",")}${missing.length ? `; missing ${missing.join(",")}` : ""}` };
      }
      if (ch.day_superset_groups) {
        const r = await db.query(
          `select count(distinct r.superset_group)::int as n from prescriptions r join planned_workouts w on w.id = r.planned_workout_id
            where w.program_id = $1 and upper(w.label) = $2 and r.superset_group is not null`,
          [p.id, ch.day_superset_groups.label],
        );
        out.day_superset_groups = { pass: r.rows[0].n >= ch.day_superset_groups.min, detail: `${r.rows[0].n} groups on ${ch.day_superset_groups.label}` };
      }
      if (ch.newest_confirmed !== undefined) {
        const confirmed = p.confirmed_at !== null;
        out.newest_confirmed = { pass: confirmed === ch.newest_confirmed, detail: `confirmed_at=${p.confirmed_at}` };
      }
      if (ch.rx_load) {
        const r = await db.query(
          `select r.load_kg::float as load_kg, r.load_entry from prescriptions r join planned_workouts w on w.id = r.planned_workout_id
            where w.program_id = $1 and r.exercise_id = $2 order by w.day_index, r.position limit 1`,
          [p.id, ch.rx_load.exercise],
        );
        const row = r.rows[0];
        const tol = ch.rx_load.tolerance ?? 0.05;
        const ok = row && Math.abs(row.load_kg - ch.rx_load.load_kg) <= tol && (ch.rx_load.load_entry === undefined || row.load_entry === ch.rx_load.load_entry);
        out.rx_load = { pass: Boolean(ok), detail: row ? `stored ${row.load_kg} kg ${row.load_entry ?? "(no entry)"}; want ${ch.rx_load.load_kg} ${ch.rx_load.load_entry ?? ""}` : "exercise not on program" };
      }
      if (ch.rx_absent) {
        const r = await db.query(
          `select count(*)::int as n from prescriptions r join planned_workouts w on w.id = r.planned_workout_id where w.program_id = $1 and r.exercise_id = $2`,
          [p.id, ch.rx_absent.exercise],
        );
        out.rx_absent = { pass: r.rows[0].n === 0, detail: `${r.rows[0].n} rows of ${ch.rx_absent.exercise}` };
      }
      if (ch.rx_present) {
        const pats = ch.rx_present.exercise_like.split("|");
        const r = await db.query(
          `select r.exercise_id from prescriptions r join planned_workouts w on w.id = r.planned_workout_id where w.program_id = $1`,
          [p.id],
        );
        const ids = r.rows.map((x) => x.exercise_id);
        const ok = ids.some((id) => pats.some((pat) => new RegExp("^" + pat.replace(/%/g, ".*").replace(/_/g, "[_ ]") + "$", "i").test(id)));
        out.rx_present = { pass: ok, detail: ids.join(",") };
      }
    }
  }
  return out;
}
