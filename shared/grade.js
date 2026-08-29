function norm(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[‘’']/g, "'")
    .replace(/[^a-z0-9' ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordsOf(s) {
  return norm(s).split(" ").filter(Boolean);
}

function variantMatch(student, variant) {
  const sn = " " + norm(student) + " ";
  const alts = String(variant).split("//").flatMap((p) => p.split("/"));
  for (const alt of alts) {
    const ws = wordsOf(alt.replace(/\([^)]*\)/g, " "));
    if (!ws.length) continue;
    if (ws.every((w) => sn.includes(" " + w + " "))) return true;
  }
  return false;
}

function markFill(student, answers) {
  const v = student || "";
  if (!String(v).trim()) return { ok: false, empty: true };
  return { ok: answers.some((x) => variantMatch(v, x)), empty: false };
}

function setEq(a, b) {
  if (a.size !== b.length) return false;
  return b.every((x) => a.has(x));
}

function inferKind() {
  return "fill";
}

function collectQuestions(DATA) {
  const out = [];
  for (const task of DATA.tasks) {
    const walk = (b) => {
      if (b && typeof b === "object") {
        if ("no" in b && b.ts) {
          out.push({
            ...b,
            task: task.id,
            kind: b.kind || inferKind(b),
            labelText: b.label || (b.prefix || "") + " (#" + b.no + ")" || "#" + b.no,
          });
        }
        for (const k in b) if (k !== "task") walk(b[k]);
      } else if (Array.isArray(b)) {
        for (const x of b) walk(x);
      }
    };
    for (const blk of task.blocks) {
      if (blk.type === "mc" || blk.type === "map" || blk.type === "tick" || blk.type === "fill") {
        out.push({ ...blk, task: task.id, kind: blk.type, labelText: blk.label });
      } else if (blk.type === "steporder") {
        for (const it of blk.items) out.push({ ...it, task: task.id, kind: "num", labelText: "步骤图 (#" + it.no + ")" });
      } else if (blk.type === "maplabel") {
        for (const it of blk.items) out.push({ ...it, task: task.id, kind: "letter", labelText: it.place + " (#" + it.no + ")" });
      } else if (blk.type === "table") {
        for (const row of blk.rows) {
          for (const cell of row) {
            if (cell.fill) out.push({ ...cell.fill, task: task.id, kind: "fill", labelText: (cell.fill.prefix || "") + " (#" + cell.fill.no + ")" });
            if (cell.fillgroup) {
              for (const f of cell.fillgroup) {
                out.push({ ...f, task: task.id, kind: "fill", labelText: (f.prefix || "") + " (#" + f.no + ")" });
              }
            }
          }
        }
      }
    }
  }
  out.sort((a, b) => a.no - b.no);
  return out;
}

function asTickSet(val) {
  if (val instanceof Set) return val;
  if (Array.isArray(val)) return new Set(val);
  if (val == null || val === "") return new Set();
  return new Set([val]);
}

function gradeQuestion(q, A, T) {
  if (q.kind === "fill") {
    const r = markFill(A[q.no], q.answer);
    return { ok: r.ok, empty: r.empty, student: A[q.no] || "", key: (q.answer || []).join("  /  ") };
  }
  if (q.kind === "num") {
    const v = String(A[q.no] || "").trim();
    return { ok: v === String(q.answer), empty: !v, student: v || "(空)", key: "顺序 " + q.answer };
  }
  if (q.kind === "letter" || q.kind === "mc" || q.kind === "map") {
    const sel = T[q.no];
    return { ok: sel === q.answer, empty: !sel, student: sel || "(未选)", key: q.answer };
  }
  if (q.kind === "tick") {
    const s = asTickSet(T[q.no]);
    return {
      ok: setEq(s, q.answer || []),
      empty: s.size === 0,
      student: [...s].join(", ") || "(未选)",
      key: (q.answer || []).join(", "),
    };
  }
  return { ok: false, empty: true, student: "", key: "" };
}

function studentAnswerPayload(q, A, T) {
  if (q.kind === "tick") return JSON.stringify([...asTickSet(T[q.no])]);
  if (q.kind === "letter" || q.kind === "mc" || q.kind === "map") return T[q.no] == null ? "" : String(T[q.no]);
  return A[q.no] == null ? "" : String(A[q.no]);
}

module.exports = {
  collectQuestions,
  gradeQuestion,
  studentAnswerPayload,
};
